import type { Db } from '../db/index.js';
import { AppError } from '../core/errors.js';

/**
 * Compatibility tombstone for the retired Preview/Demo authentication flow.
 *
 * No user/session is created here. The only remaining caller is an older service endpoint that is
 * permanently gated by ENABLE_PREVIEW_ACCESS=false. Keeping this explicit failure for one release
 * prevents an old School deployment from receiving a module-not-found error while removing every
 * preview credential, token and bootstrap path from the authentication implementation.
 */
export async function buildPreviewContext(_db:Db):Promise<never>{
  throw new AppError(410,'PREVIEW_RETIRED','Preview and demo authentication have been retired. Use a normal Core OS account.');
}
