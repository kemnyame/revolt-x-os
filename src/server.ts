import 'dotenv/config';
import { loadConfig } from './config.js';
import { createDb, ensureOsSchema } from './db/index.js';
import { migrate } from './db/migrate.js';
import { buildApp } from './app.js';

const config = loadConfig();
const db = createDb(config);
let app: Awaited<ReturnType<typeof buildApp>> | undefined;
let shuttingDown = false;

async function shutdown(signal: string) {
  if (shuttingDown) return;
  shuttingDown = true;
  console.log(`Received ${signal}. Shutting down Revolt-X OS...`);
  try {
    if (app) await app.close();
  } finally {
    await db.end();
  }
}

process.once('SIGTERM', () => {
  void shutdown('SIGTERM').finally(() => process.exit(0));
});

process.once('SIGINT', () => {
  void shutdown('SIGINT').finally(() => process.exit(0));
});

try {
  await ensureOsSchema(db);
  await migrate(db);
  app = await buildApp({ db, config });
  await app.listen({ host: config.HOST, port: config.PORT });
  console.log(`Revolt-X OS listening on ${config.HOST}:${config.PORT}`);
} catch (error) {
  console.error(error);
  await db.end();
  process.exit(1);
}
