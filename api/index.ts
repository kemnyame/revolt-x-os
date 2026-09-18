import 'dotenv/config';
import { loadConfig } from '../src/config.js';
import { createDb } from '../src/db/index.js';
import { buildApp } from '../src/app.js';

const config = loadConfig();
const db = createDb(config);
const app = await buildApp({ db, config });
await app.ready();

export default async function handler(request: any, response: any) {
  const incoming = new URL(request.url ?? '/api', 'http://revolt-x.local');
  const originalPath = incoming.searchParams.get('__path') || '/';

  incoming.searchParams.delete('__path');
  const query = incoming.searchParams.toString();

  request.url = originalPath + (query ? `?${query}` : '');

  await new Promise<void>((resolve, reject) => {
    let settled = false;

    const cleanup = () => {
      response.off?.('finish', onFinish);
      response.off?.('close', onFinish);
      response.off?.('error', onError);
    };

    const onFinish = () => {
      if (settled) return;
      settled = true;
      cleanup();
      resolve();
    };

    const onError = (error: Error) => {
      if (settled) return;
      settled = true;
      cleanup();
      reject(error);
    };

    response.once?.('finish', onFinish);
    response.once?.('close', onFinish);
    response.once?.('error', onError);

    try {
      app.server.emit('request', request, response);
    } catch (error) {
      onError(error as Error);
    }
  });
}
