import 'dotenv/config';
import { loadConfig } from '../src/config.js';
import { createDb } from '../src/db/index.js';
import { buildApp } from '../src/app.js';

const config = loadConfig();
const db = createDb(config);
const app = await buildApp({ db, config });
await app.ready();

export default async function handler(request: any, response: any) {
  try {
    const incoming = new URL(request.url ?? '/api', 'http://revolt-x.local');
    const originalPath = incoming.searchParams.get('__path') || '/';

    incoming.searchParams.delete('__path');
    const query = incoming.searchParams.toString();
    const targetUrl = originalPath + (query ? `?${query}` : '');

    let payload: any = request.body;
    if (
      payload != null &&
      typeof payload === 'object' &&
      !Buffer.isBuffer(payload) &&
      !(payload instanceof Uint8Array)
    ) {
      payload = JSON.stringify(payload);
    }

    const result = await app.inject({
      method: request.method ?? 'GET',
      url: targetUrl,
      headers: request.headers ?? {},
      payload
    });

    response.statusCode = result.statusCode;

    for (const [key, value] of Object.entries(result.headers)) {
      if (
        value !== undefined &&
        key.toLowerCase() !== 'content-length' &&
        key.toLowerCase() !== 'transfer-encoding' &&
        key.toLowerCase() !== 'connection'
      ) {
        response.setHeader(key, value as any);
      }
    }

    response.end(result.rawPayload);
  } catch (error) {
    console.error('VERCEL_HANDLER_ERROR', error);
    if (!response.headersSent) {
      response.statusCode = 500;
      response.setHeader('content-type', 'application/json; charset=utf-8');
    }
    response.end(
      JSON.stringify({
        error: {
          code: 'VERCEL_HANDLER_ERROR',
          message: error instanceof Error ? error.message : 'Vercel handler failed'
        }
      })
    );
  }
}
