import 'dotenv/config';
import { loadConfig } from './config.js';
import { createDb, ensureOsSchema } from './db/index.js';
import { migrate } from './db/migrate.js';
import { buildApp } from './app.js';

const config=loadConfig();
const db=createDb(config);
try {
  await ensureOsSchema(db);
  await migrate(db);
  const app=await buildApp({db,config});
  await app.listen({host:config.HOST,port:config.PORT});
} catch(error) {
  console.error(error);
  await db.end();
  process.exit(1);
}
