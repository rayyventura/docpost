// Test-only helpers for *.integration.test.ts: local Postgres and tiny node:http
// stub servers. Nothing here is imported by production code.
import { createServer, type IncomingHttpHeaders, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import pg from 'pg';

export const DATABASE_URL =
  process.env.DATABASE_URL ?? 'postgresql://docpost_service:docpost_local@localhost:5432/docpost_api';

export function pgPool(): pg.Pool {
  return new pg.Pool({ connectionString: DATABASE_URL, max: 2 });
}

export interface StubRequest {
  method: string;
  url: string;
  headers: IncomingHttpHeaders;
  body: string;
}

export interface StubServer {
  url: string;
  requests: StubRequest[];
  close(): Promise<void>;
}

/** Starts an HTTP server on a random local port that records every request. */
export async function stubServer(
  respond: (req: StubRequest, res: ServerResponse) => void | Promise<void>,
): Promise<StubServer> {
  const requests: StubRequest[] = [];
  const server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (chunk: Buffer) => chunks.push(chunk));
    req.on('end', () => {
      const recorded: StubRequest = {
        method: req.method ?? '',
        url: req.url ?? '',
        headers: req.headers,
        body: Buffer.concat(chunks).toString(),
      };
      requests.push(recorded);
      Promise.resolve(respond(recorded, res)).catch((err: unknown) => {
        res.writeHead(500).end(String(err));
      });
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;
  return {
    url: `http://127.0.0.1:${port}`,
    requests,
    close: () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections();
        server.close(() => resolve());
      }),
  };
}

export function json(res: ServerResponse, status: number, body: unknown, headers: Record<string, string> = {}): void {
  res.writeHead(status, { 'Content-Type': 'application/json', ...headers }).end(JSON.stringify(body));
}
