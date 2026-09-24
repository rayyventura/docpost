import dotenv from 'dotenv';
import { createServer, type IncomingMessage } from 'node:http';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { WebSocketServer, type WebSocket } from 'ws';
import { eq } from 'drizzle-orm';
import { connect, disconnect, subscribe } from './session.js';
import { getDb } from './db.js';
import { wsConnections } from './schema.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: path.resolve(__dirname, '../.env') });

const PORT = Number(process.env.PORT ?? 3004);
const sockets = new Map<string, WebSocket>();

const server = createServer((req, res) => {
  if (req.method === 'POST' && req.url === '/push') {
    void readBody(req).then(async (raw) => {
      const message = JSON.parse(raw) as { jobId?: string };
      if (!message.jobId) {
        res.writeHead(400).end();
        return;
      }
      const db = getDb();
      const rows = await db
        .select({ connectionId: wsConnections.connectionId })
        .from(wsConnections)
        .where(eq(wsConnections.jobId, message.jobId));

      const payload = JSON.stringify(message);
      for (const row of rows) {
        const socket = sockets.get(row.connectionId);
        if (!socket || socket.readyState !== socket.OPEN) {
          await disconnect(row.connectionId);
          sockets.delete(row.connectionId);
          continue;
        }
        socket.send(payload);
      }
      res.writeHead(204).end();
    }).catch((err) => {
      console.error('Push failed:', err);
      res.writeHead(500).end();
    });
    return;
  }

  res.writeHead(404).end();
});

const wss = new WebSocketServer({ server, path: '/ws' });

wss.on('connection', (socket, request) => {
  const connectionId = randomUUID();
  const token = new URL(request.url ?? '/', 'http://localhost').searchParams.get('token') ?? undefined;
  sockets.set(connectionId, socket);

  void connect(connectionId, token).then((ok) => {
    if (!ok) {
      socket.close(1008, 'unauthorized');
      sockets.delete(connectionId);
    }
  });

  socket.on('message', (data) => {
    void (async () => {
      const body = JSON.parse(data.toString()) as { action?: string; jobId?: string };
      if (body.action !== 'subscribe' || !body.jobId) {
        socket.send(JSON.stringify({ type: 'error', message: 'jobId is required' }));
        return;
      }
      const result = await subscribe(connectionId, body.jobId);
      if (result !== 'ok') {
        socket.send(JSON.stringify({ type: 'error', message: 'Job not found' }));
        return;
      }
      socket.send(JSON.stringify({ type: 'subscribed', jobId: body.jobId }));
    })().catch((err) => {
      console.error('Subscribe failed:', err);
      socket.send(JSON.stringify({ type: 'error', message: 'Subscribe failed' }));
    });
  });

  socket.on('close', () => {
    sockets.delete(connectionId);
    void disconnect(connectionId);
  });
});

server.listen(PORT, () => {
  console.log(`WebSocket worker listening on port ${PORT}`);
});

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on('data', (chunk) => chunks.push(chunk as Buffer));
    req.on('end', () => resolve(Buffer.concat(chunks).toString()));
    req.on('error', reject);
  });
}
