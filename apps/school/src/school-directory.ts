import type { FastifyInstance } from 'fastify';
import type { SchoolConfig } from './config.js';
import type { SchoolDb } from './db.js';

type School = { id: string; name: string; organisationId: string | null; licenceStatus: string | null };

function schoolsFrom(value: unknown): School[] {
  if (!Array.isArray(value)) return [];
  return value.filter(row => row && typeof row.id === 'string' && row.id.trim())
    .map(row => ({
      id: row.id.trim(), name: String(row.name || row.id),
      organisationId: typeof (row.organisationId ?? row.organisation_id) === 'string' ? (row.organisationId ?? row.organisation_id).trim() : null,
      licenceStatus: typeof (row.licenceStatus ?? row.licence_status) === 'string' ? (row.licenceStatus ?? row.licence_status) : null
    }));
}

/** Listing a school does not grant access. Core verifies the account and School
 * checks its membership and licence when the user signs in. Existing schools
 * must remain selectable while the separate Core service is starting. */
export function registerSchoolDirectory(app: FastifyInstance, options: {
  db: SchoolDb; config: SchoolConfig; fetchCore?: typeof fetch; now?: () => number;
}) {
  const now = options.now ?? Date.now;
  let remote: School[] = [], refreshAfter = 0, pending: Promise<void> | null = null;

  function refresh() {
    if (!options.config.CORE_SERVICE_KEY || now() < refreshAfter) return pending ?? Promise.resolve();
    if (pending) return pending;
    pending = (async () => {
      try {
        const response = await (options.fetchCore ?? fetch)(
          options.config.CORE_OS_URL.replace(/\/$/, '') + '/v1/internal/school/directory', {
            headers: { 'x-revolt-service-key': options.config.CORE_SERVICE_KEY! },
            signal: AbortSignal.timeout(8000), cache: 'no-store'
          });
        if (!response.ok) return;
        const body: unknown = await response.json();
        if (Array.isArray(body)) remote = schoolsFrom(body);
      } catch { /* Retain the last directory; never cache credentials or sessions. */ }
      finally { refreshAfter = now() + 30_000; }
    })().finally(() => { pending = null; });
    return pending;
  }

  app.get('/api/auth/schools', async (_request, reply) => {
    reply.header('cache-control', 'no-store, max-age=0');
    const local = schoolsFrom((await options.db.query(`SELECT tenant_slug id,school_name name,organisation_id "organisationId"
      FROM school_profiles ORDER BY lower(school_name),tenant_slug`)).rows);
    // Respond immediately for established schools. One shared refresh discovers
    // new Core schools without making every visitor wait on the public gateway.
    const refreshing = refresh();
    if (!local.length && !remote.length) await refreshing;
    const merged = new Map<string, School>();
    for (const school of [...remote, ...local]) merged.set((school.organisationId || school.id).toLowerCase(), school);
    return [...merged.values()].sort((a, b) => a.name.localeCompare(b.name));
  });
}
