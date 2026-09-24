import type { Handler } from 'aws-lambda';

export const handler: Handler = async (event) => {
  console.log('WebSocket worker received event:', JSON.stringify(event));

  return {
    statusCode: 200,
  };
};
