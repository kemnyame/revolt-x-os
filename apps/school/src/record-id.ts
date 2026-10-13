import { z } from 'zod';

/** PostgreSQL uuid columns store any 128-bit identifier. Earlier imports used
 * deterministic identifiers whose version/variant bits are not RFC UUID bits.
 * Those existing keys are valid database records; rejecting them breaks profiles,
 * scores, attendance and rollover. Keep the canonical hexadecimal format, retain
 * all database keys and relationships, and still reject malformed input. Access
 * to each record must continue to be checked against the authenticated school. */
export const schoolRecordId = z.string().trim()
  .regex(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i, 'Choose a valid saved record from the list.')
  .toLowerCase();
