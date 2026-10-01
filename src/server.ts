import 'dotenv/config';
import bcrypt from 'bcryptjs';
import { loadConfig } from './config.js';
import { createDb, ensureOsSchema } from './db/index.js';
import { migrate } from './db/migrate.js';
import { buildApp } from './app.js';

const config = loadConfig();
const db = createDb(config);
let app: Awaited<ReturnType<typeof buildApp>> | undefined;
let shuttingDown = false;

async function bootstrapSchoolStaffPasswords() {
  const eligible = await db.query<{id:string}>(`
    SELECT DISTINCT u.id
    FROM users u
    JOIN organisation_memberships m ON m.user_id=u.id
    JOIN saas_customers c ON c.customer_organisation_id=m.organisation_id AND c.customer_type='school'
    WHERE u.school_password_bootstrapped_at IS NULL
      AND lower(u.email)<>'preview@revolt-x.local'
  `);
  if (!eligible.rowCount) return;
  const hash = await bcrypt.hash(config.SCHOOL_DEFAULT_STAFF_PASSWORD, 12);
  const ids = eligible.rows.map(row => row.id);
  await db.query(
    `UPDATE users
       SET password_hash=$1,status='active',must_change_password=true,school_password_bootstrapped_at=now(),updated_at=now()
       WHERE id=ANY($2::uuid[])`,
    [hash, ids]
  );
  await db.query(
    `UPDATE organisation_memberships m
       SET status='active'
       WHERE m.user_id=ANY($1::uuid[])
         AND EXISTS (
           SELECT 1 FROM saas_customers c
           WHERE c.customer_organisation_id=m.organisation_id AND c.customer_type='school'
         )`,
    [ids]
  );
  console.log(`Applied the temporary School password policy to ${ids.length} existing staff account(s).`);
}

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
  await bootstrapSchoolStaffPasswords();
  await applyConfiguredOwnerPasswordReset();
  app = await buildApp({ db, config });
  await app.listen({ host: config.HOST, port: config.PORT });
  console.log(`Revolt-X OS listening on ${config.HOST}:${config.PORT}`);
} catch (error) {
  console.error(error);
  await db.end();
  process.exit(1);
}
