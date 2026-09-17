import 'dotenv/config';
import { loadConfig } from '../src/config.js';
import { createDb } from '../src/db/index.js';
import { buildApp } from '../src/app.js';

const config = loadConfig();
const db = createDb(config);
const app = await buildApp({ db, config });
await app.ready();

export default async function handler(request: any, response: any) {
  app.server.emit('request', request, response);
}
