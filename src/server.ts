import 'dotenv/config';
import bcrypt from 'bcryptjs';
import { loadConfig } from './config.js';
import { createDb, ensureOsSchema } from './db/index.js';
import { migrate } from './db/migrate.js';
import { buildApp } from './app.js';
import {bootstrapSchoolStaffPasswords} from './auth/school-password-policy.js';

const config = loadConfig();
const db = createDb(config);
let app: Awaited<ReturnType<typeof buildApp>> | undefined;
let shuttingDown = false;

async function applyConfiguredOwnerPasswordReset() {
  const password = String(config.OWNER_PASSWORD_RESET || '');
  if (!password) return;
  if (password.length < 10) {
    console.warn('OWNER_PASSWORD_RESET is configured but is too short; owner password was not changed.');
    return;
  }
  const hash = await bcrypt.hash(password, 12);
  const result = await db.query(
    `UPDATE users u
       SET password_hash=$1,must_change_password=false,updated_at=now()
       WHERE EXISTS (
         SELECT 1
         FROM organisation_memberships m
         JOIN membership_roles mr ON mr.membership_id=m.id
         JOIN roles r ON r.id=mr.role_id
         WHERE m.user_id=u.id
           AND m.organisation_id IN (SELECT DISTINCT provider_organisation_id FROM saas_customers)
           AND (
             r.key='owner'
             OR EXISTS (
               SELECT 1 FROM role_permissions rp
               JOIN permissions p ON p.id=rp.permission_id
               WHERE rp.role_id=r.id AND p.key='commercial.manage'
             )
           )
       )`,
    [hash]
  );
  if (result.rowCount) console.log(`Applied the configured Core OS owner password to ${result.rowCount} account(s).`);
}

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
  const bootstrapped=await bootstrapSchoolStaffPasswords(db,config.SCHOOL_DEFAULT_STAFF_PASSWORD);
  if(bootstrapped)console.log(`Applied the temporary School password policy to ${bootstrapped} legacy staff account(s).`);
  await applyConfiguredOwnerPasswordReset();
  app = await buildApp({ db, config });
  await app.listen({ host: config.HOST, port: config.PORT });
  console.log(`Revolt-X OS listening on ${config.HOST}:${config.PORT}`);
} catch (error) {
  console.error(error);
  await db.end();
  process.exit(1);
}
