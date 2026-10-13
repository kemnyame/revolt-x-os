import { z } from 'zod';

// Imported School users retain their existing PostgreSQL keys, including older
// deterministic GUIDs. Format validation does not replace school access checks.
export const databaseRecordId = z.string().trim()
  .regex(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i, 'Choose a valid saved record.')
  .toLowerCase();
