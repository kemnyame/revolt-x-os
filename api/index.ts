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

  app.server.emit('request', request, response);
}
