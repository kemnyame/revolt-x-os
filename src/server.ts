import { repairGraceDemoTeachers } from './auth/grace-demo-teachers.js';
import 'dotenv/config';
import { loadConfig } from './config.js';
import { createDb, ensureOsSchema } from './db/index.js';
import { migrate } from './db/migrate.js';
import { buildApp } from './app.js';
import {bootstrapSchoolStaffPasswords} from './auth/school-password-policy.js';
import {applyOwnerPasswordPolicy} from './auth/owner-password-policy.js';
import {revokeLinkedSchoolSessions} from './auth/school-sessions.js';
import {applyOsPasswordRecovery} from './auth/os-password-recovery.js';

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
  const linkedDemoTeachers=await repairGraceDemoTeachers(db);
  if(linkedDemoTeachers)console.log(`Linked ${linkedDemoTeachers} existing Grace Prep demonstration teacher profiles to Core accounts.`);
  const bootstrapped=await bootstrapSchoolStaffPasswords(db,config.SCHOOL_DEFAULT_STAFF_PASSWORD);
  if(bootstrapped)console.log(`Applied the temporary School password policy to ${bootstrapped} legacy staff account(s).`);
  const resetOwners=await applyOwnerPasswordPolicy(db,String(config.OWNER_PASSWORD_RESET||''),userId=>revokeLinkedSchoolSessions(db,config,userId));
  if(resetOwners)console.log(`Applied a changed owner password configuration once to ${resetOwners} account(s).`);
  if(config.OS_PASSWORD_RECOVERY_USER_ID&&config.OS_PASSWORD_RECOVERY_REQUEST_ID&&config.OS_PASSWORD_RECOVERY_VALUE){
    const recovered=await applyOsPasswordRecovery(db,{userId:config.OS_PASSWORD_RECOVERY_USER_ID,requestId:config.OS_PASSWORD_RECOVERY_REQUEST_ID,password:config.OS_PASSWORD_RECOVERY_VALUE});
    if(recovered)console.log('Applied and verified the one-time OS account password recovery.');
  }
  app = await buildApp({ db, config });
  await app.listen({ host: config.HOST, port: config.PORT });
  console.log(`Revolt-X OS listening on ${config.HOST}:${config.PORT}`);
} catch (error) {
  console.error(error);
  await db.end();
  process.exit(1);
}
