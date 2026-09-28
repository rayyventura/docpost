import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import express, { type NextFunction, type Request, type Response } from 'express';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi, type MockInstance } from 'vitest';
import { ConflictError, ValidationError } from '../errors.js';
import { errorHandler } from './error-handler.js';

function fakeRes() {
  const res = {
    statusCode: 0,
    body: undefined as unknown,
    status(code: number) {
      res.statusCode = code;
      return res;
    },
    json(body: unknown) {
      res.body = body;
      return res;
    },
  };
  return res;
}

function handle(err: Error) {
  const res = fakeRes();
  errorHandler(err, {} as Request, res as unknown as Response, (() => {}) as NextFunction);
  return res;
}

/** Shape of the errors body-parser raises (via http-errors). */
function bodyParserError(status: number, type: string, name = 'Error'): Error {
  return Object.assign(new Error('body-parser failure with request details'), {
    name,
    status,
    statusCode: status,
    expose: true,
    type,
  });
}

describe('errorHandler', () => {
  let consoleError: MockInstance<typeof console.error>;

  beforeEach(() => {
    consoleError = vi.spyOn(console, 'error').mockImplementation(() => {});
  });

  afterEach(() => {
    consoleError.mockRestore();
  });

  it('serialises AppErrors with their own status and code', () => {
    expect(handle(new ValidationError('bad field'))).toMatchObject({
      statusCode: 422,
      body: { error: { code: 'VALIDATION_ERROR', message: 'bad field' } },
    });
    expect(handle(new ConflictError('taken'))).toMatchObject({
      statusCode: 409,
      body: { error: { code: 'CONFLICT', message: 'taken' } },
    });
    expect(consoleError).not.toHaveBeenCalled();
  });

  it('maps a too-large body to 413 PAYLOAD_TOO_LARGE', () => {
    const res = handle(bodyParserError(413, 'entity.too.large', 'PayloadTooLargeError'));
    expect(res.statusCode).toBe(413);
    expect(res.body).toMatchObject({ error: { code: 'PAYLOAD_TOO_LARGE' } });
    expect(consoleError).not.toHaveBeenCalled();
  });

  it('maps a JSON parse failure to 400 INVALID_JSON without logging it as unhandled', () => {
    const err = Object.assign(new SyntaxError('Unexpected end of JSON input'), {
      status: 400,
      statusCode: 400,
      expose: true,
      type: 'entity.parse.failed',
      body: '{"password": "secret-value',
    });
    const res = handle(err);
    expect(res.statusCode).toBe(400);
    expect(res.body).toEqual({ error: { code: 'INVALID_JSON', message: 'Request body is not valid JSON' } });
    expect(JSON.stringify(res.body)).not.toContain('secret-value');
    expect(consoleError).not.toHaveBeenCalled();
  });

  it.each([
    ['unsupported charset', 415, 'charset.unsupported'],
    ['unsupported encoding', 415, 'encoding.unsupported'],
    ['aborted request', 400, 'request.aborted'],
    ['size mismatch', 400, 'request.size.invalid'],
  ])('maps other body-parser client errors (%s) to 400 BAD_REQUEST', (_label, status, type) => {
    const res = handle(bodyParserError(status, type));
    expect(res.statusCode).toBe(400);
    expect(res.body).toEqual({ error: { code: 'BAD_REQUEST', message: 'The request could not be processed' } });
    expect(consoleError).not.toHaveBeenCalled();
  });

  it('maps an exposed 4xx http-error that sets only statusCode to 400', () => {
    const err = Object.assign(new Error('nope'), { statusCode: 400, expose: true });
    expect(handle(err).statusCode).toBe(400);
    expect(consoleError).not.toHaveBeenCalled();
  });

  it('still treats plain errors as 500 INTERNAL_ERROR and logs them', () => {
    const res = handle(new Error('boom'));
    expect(res.statusCode).toBe(500);
    expect(res.body).toEqual({ error: { code: 'INTERNAL_ERROR', message: 'An unexpected error occurred' } });
    expect(consoleError).toHaveBeenCalledTimes(1);
  });

  it('does not treat an arbitrary library error that merely carries a 4xx statusCode as a client error', () => {
    const upstream = Object.assign(new Error('upstream said 404'), { statusCode: 404 });
    expect(handle(upstream).statusCode).toBe(500);
    expect(consoleError).toHaveBeenCalledTimes(1);
  });
});

describe('errorHandler behind express.json()', () => {
  let server: Server;
  let baseUrl: string;

  beforeAll(async () => {
    const app = express();
    app.use(express.json({ limit: '1kb' }));
    app.post('/echo', (req, res) => {
      res.status(200).json(req.body);
    });
    app.use(errorHandler);
    server = app.listen(0);
    await new Promise<void>((resolve) => server.once('listening', () => resolve()));
    baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });

  afterAll(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  function post(body: string) {
    return fetch(`${baseUrl}/echo`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body });
  }

  it('answers a malformed JSON body with 400 INVALID_JSON', async () => {
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {});
    const res = await post('{"email": secret-value');
    const text = await res.text();
    expect(res.status).toBe(400);
    expect(JSON.parse(text)).toEqual({ error: { code: 'INVALID_JSON', message: 'Request body is not valid JSON' } });
    expect(text).not.toContain('secret-value');
    expect(consoleError).not.toHaveBeenCalled();
    consoleError.mockRestore();
  });

  it('keeps answering an oversized body with 413', async () => {
    const res = await post(JSON.stringify({ blob: 'x'.repeat(4096) }));
    expect(res.status).toBe(413);
    expect(await res.json()).toMatchObject({ error: { code: 'PAYLOAD_TOO_LARGE' } });
  });

  it('passes valid JSON through', async () => {
    const res = await post('{"ok":true}');
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
  });
});
