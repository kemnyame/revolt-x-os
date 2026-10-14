import type { SchoolConfig } from './config.js';

type LoginKind = 'staff' | 'admin';
type LoginOptions = {
  fetchCore?: typeof fetch;
  wait?: (milliseconds: number) => Promise<void>;
  now?: () => number;
};

const transientStatuses = new Set([429, 502, 503, 504]);
const unavailableMessage = 'The sign-in service is starting or unavailable. Please try again in a moment.';
const busyMessage = 'The sign-in service is temporarily busy. Please wait a moment and try again.';

function loginError(statusCode: number, message: string, code?: string, retryAfterSeconds?: number) {
  return Object.assign(new Error(message), { statusCode, code, retryAfterSeconds });
}

function responseMessage(body: any): string | undefined {
  const value = body?.error?.message ?? body?.message;
  return typeof value === 'string' && value.trim() ? value : undefined;
}

function retryAfter(response: Response, now: number) {
  const value = response.headers.get('retry-after');
  if (!value) return 0;
  const seconds = Number(value);
  const milliseconds = Number.isFinite(seconds) ? seconds * 1000 : Date.parse(value) - now;
  return Number.isFinite(milliseconds) ? Math.max(0, milliseconds) : 0;
}

/** Both login portals use the same bounded startup recovery. Only service failures
 * are retried; invalid credentials and inactive accounts return immediately.
 * No tokens or passwords are logged, cached, or sent to a second service. */
export async function authenticateCoreSchoolLogin(
  config: SchoolConfig,
  kind: LoginKind,
  credentials: Record<string, string | undefined>,
  options: LoginOptions = {}
): Promise<any> {
  if (!config.CORE_SERVICE_KEY) {
    throw loginError(503, 'School sign-in is not configured. Contact your school administrator.', 'SCHOOL_SIGN_IN_UNAVAILABLE');
  }
  const fetchCore = options.fetchCore ?? fetch;
  const wait = options.wait ?? (milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds)));
  const now = options.now ?? Date.now;
  const deadline = now() + 55_000;
  const url = config.CORE_OS_URL.replace(/\/$/, '') + '/v1/internal/school/authenticate-' + kind;
  const body = JSON.stringify(credentials);
  let lastStatus = 503;
  let retryAfterSeconds = 5;

  for (let attempt = 0; now() < deadline; attempt++) {
    const remaining = deadline - now();
    const response = await fetchCore(url, {
      method: 'POST',
      headers: { 'x-revolt-service-key': config.CORE_SERVICE_KEY, 'content-type': 'application/json' },
      body,
      signal: AbortSignal.timeout(Math.max(1, Math.min(15_000, remaining)))
    }).catch(() => null);
    let pause = [750, 1500, 3000][attempt] ?? 5000;
    if (response) {
      const payload = await response.json().catch(() => null) as any;
      if (response.ok && typeof payload?.id === 'string'
        && typeof payload?.organisation_id === 'string' && typeof payload?.membership_id === 'string') return payload;
      if (response.ok) {
        // A startup HTML page or an incomplete response is not a credential failure.
        lastStatus = 503;
      } else if (transientStatuses.has(response.status)) {
        lastStatus = response.status;
        const requestedPause = retryAfter(response, now());
        retryAfterSeconds = Math.max(5, Math.ceil(requestedPause / 1000));
        // Fast gateway failures must not use up recovery before Core can start.
        // Respect upstream backoff within the same bounded request deadline.
        if (now() + requestedPause >= deadline) break;
        pause = Math.max(pause, requestedPause);
      } else {
        const message = responseMessage(payload);
        const code = payload?.error?.code;
        if (code === 'UNAUTHORIZED' || ((response.status === 401 || response.status === 403) && !message)) {
          throw loginError(503, 'School sign-in could not connect securely. Contact your school administrator.', 'SCHOOL_SIGN_IN_UNAVAILABLE');
        }
        const invalid = kind === 'staff' ? 'Invalid school, Staff ID or password' : 'Invalid School Administrator credentials';
        throw loginError(response.status, message ?? (response.status === 401 ? invalid : unavailableMessage), code);
      }
    } else lastStatus = 503;
    if (now() + pause >= deadline) break;
    await wait(pause);
  }
  if (lastStatus === 429) throw loginError(429, busyMessage, 'SCHOOL_SIGN_IN_BUSY', retryAfterSeconds);
  throw loginError(503, unavailableMessage, 'SCHOOL_SIGN_IN_UNAVAILABLE', retryAfterSeconds);
}
