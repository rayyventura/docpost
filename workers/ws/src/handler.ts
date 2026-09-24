import type { APIGatewayProxyResult, Handler } from 'aws-lambda';
import { connect, disconnect, subscribe } from './session.js';

interface WsEvent {
  requestContext?: { routeKey?: string; connectionId?: string };
  queryStringParameters?: { token?: string } | null;
  body?: string | null;
}

export const handler: Handler = async (event: WsEvent): Promise<APIGatewayProxyResult> => {
  const routeKey = event.requestContext?.routeKey;
  const connectionId = event.requestContext?.connectionId ?? '';

  if (routeKey === '$connect') {
    const ok = await connect(connectionId, event.queryStringParameters?.token);
    return { statusCode: ok ? 200 : 401, body: ok ? 'connected' : 'unauthorized' };
  }

  if (routeKey === '$disconnect') {
    await disconnect(connectionId);
    return { statusCode: 200, body: 'disconnected' };
  }

  if (routeKey === 'subscribe') {
    const body = JSON.parse(event.body ?? '{}') as { jobId?: string };
    if (!body.jobId) return { statusCode: 400, body: 'jobId is required' };
    const result = await subscribe(connectionId, body.jobId);
    if (result !== 'ok') return { statusCode: result === 'missing' ? 401 : 404, body: 'Job not found' };
    return { statusCode: 200, body: JSON.stringify({ type: 'subscribed', jobId: body.jobId }) };
  }

  return { statusCode: 400, body: 'unknown route' };
};
