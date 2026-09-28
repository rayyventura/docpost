import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import type { Express, Router } from 'express';

export interface RunningServer {
  baseUrl: string;
  close: () => Promise<void>;
}

/** Start an Express app in-process on an ephemeral loopback port. */
export async function listen(app: Express): Promise<RunningServer> {
  const server: Server = await new Promise((resolve) => {
    const s = app.listen(0, '127.0.0.1', () => resolve(s));
  });
  const { port } = server.address() as AddressInfo;
  return {
    baseUrl: `http://127.0.0.1:${port}`,
    close: () =>
      new Promise<void>((resolve, reject) => {
        server.closeAllConnections();
        server.close((err) => (err ? reject(err) : resolve()));
      }),
  };
}

export interface JsonResponse<T = Record<string, unknown>> {
  status: number;
  body: T;
}

export async function postJson<T = Record<string, unknown>>(
  baseUrl: string,
  path: string,
  body: unknown,
): Promise<JsonResponse<T>> {
  const res = await fetch(`${baseUrl}${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  const text = await res.text();
  return { status: res.status, body: (text ? JSON.parse(text) : {}) as T };
}

export async function getJson<T = Record<string, unknown>>(
  baseUrl: string,
  path: string,
): Promise<JsonResponse<T>> {
  const res = await fetch(`${baseUrl}${path}`);
  return { status: res.status, body: (await res.json()) as T };
}

/** A minimal app that mounts one router behind the production middleware stack. */
export async function routerApp(router: Router): Promise<Express> {
  const express = (await import('express')).default;
  const { allowOptions, errorHandler } = await import('@docpost/shared');
  const app = express();
  app.use(allowOptions);
  app.use(express.json());
  app.use(router);
  app.use(errorHandler);
  return app;
}
