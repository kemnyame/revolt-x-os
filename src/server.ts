import 'dotenv/config'; import { buildApp } from './app.js'; import { loadConfig } from './config.js'; import { createDb } from './db/index.js';
const config=loadConfig(),db=createDb(config),app=await buildApp({db,config});
const shutdown=async(signal:string)=>{app.log.info({signal},'Shutting down');await app.close();await db.end();process.exit(0);};process.on('SIGTERM',()=>void shutdown('SIGTERM'));process.on('SIGINT',()=>void shutdown('SIGINT'));
await app.listen({port:config.PORT,host:config.HOST});
