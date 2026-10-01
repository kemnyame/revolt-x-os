import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

test('School session source constraint allows dedicated admin login', async () => {
  const sql = await readFile(new URL('../migrations/049_admin_email_session_source.sql', import.meta.url), 'utf8');
  assert.match(sql, /school_sessions_source_check/);
  assert.match(sql, /'admin_email'/);
  assert.match(sql, /'staff_id'/);
  assert.match(sql, /'quick_login'/);
  assert.match(sql, /'core_exchange'/);
  assert.match(sql, /'preview'/);
});
