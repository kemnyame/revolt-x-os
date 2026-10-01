import Fastify from 'fastify';
import cors from '@fastify/cors';
import helmet from '@fastify/helmet';
import rateLimit from '@fastify/rate-limit';
import { ZodError } from 'zod';
import type { Config } from './config.js';
import type { Db } from './db/index.js';
import { AppError } from './core/errors.js';
import { verifyAccessToken } from './auth/service.js';
import { authRoutes } from './auth/routes.js';
import { previewRoutes } from './auth/preview.js';
import { organisationRoutes } from './routes/organisation.js';
import { userRoutes } from './routes/users.js';
import { operationRoutes } from './routes/operations.js';
import { workflowRoutes } from './routes/workflows.js';
import { platformRoutes } from './routes/platform.js';
import { commercialRoutes } from './routes/commercial.js';
import { internalSchoolRoutes } from './routes/internal-school.js';
import { saasRoutes } from './routes/saas.js';
import { commercialSupportRoutes } from './routes/commercial-support.js';
import { assuranceRoutes } from './routes/assurance.js';
import { osFrontend } from './ui.js';
import { commercialControlFrontend } from './commercial-control2-ui.js';
import { osLoginFrontend } from './login-ui.js';

function friendlyValidationMessage(error: ZodError) {
  const issue = error.issues[0];
  const field = issue?.path?.length ? issue.path.join('.') : 'This field';
  if (!issue) return 'Please check the form and try again.';
  if (issue.code === 'invalid_type') return `${field} is required or has the wrong format.`;
  if (issue.code === 'invalid_string' && 'validation' in issue && issue.validation === 'email') return `${field} must be a valid email address.`;
  if (issue.code === 'too_small') return `${field} is too short or below the required minimum.`;
  if (issue.code === 'too_big') return `${field} is too long or above the allowed maximum.`;
  if (issue.code === 'invalid_enum_value') return `${field} has an unsupported option. Please choose from the list provided.`;
  return `${field}: ${issue.message}`;
}

function friendlyUnexpectedMessage(error: unknown) {
  const text = String((error as any)?.message || error || '');
  if (/invalid input syntax for type date/i.test(text)) return 'Please choose a valid date using the date picker, or enter the date as YYYY-MM-DD.';
  if (/column .* does not exist/i.test(text)) return 'A reporting field is missing from the database. Please run the latest migration and try again.';
  if (/duplicate key value/i.test(text)) return 'This record already exists. Please check the name, code, email or reference and try again.';
  if (/violates foreign key constraint/i.test(text)) return 'A related record is missing. Please refresh and select a valid option.';
  if (/violates not-null constraint/i.test(text)) return 'A required field is missing. Please complete the required fields and try again.';
  return 'An unexpected error occurred.';
}

export async function buildApp({ db, config }: { db: Db; config: Config }) {
  const app = Fastify({ logger: config.NODE_ENV !== 'test', trustProxy: true, requestIdHeader: 'x-request-id' });
  await app.register(helmet, { contentSecurityPolicy: false });
  await app.register(cors, {
    origin: config.CORS_ORIGINS === '*' ? true : config.CORS_ORIGINS.split(',').map(v => v.trim()),
    credentials: true
  });
  await app.register(rateLimit, {
    max: 200,
    timeWindow: '1 minute',
    allowList: request => {
      if (request.url.startsWith('/health/')) return true;
      const trustedSchool = Boolean(config.SCHOOL_SERVICE_KEY) && request.headers['x-revolt-service-key'] === config.SCHOOL_SERVICE_KEY;
      return Boolean(trustedSchool && (request.url.startsWith('/v1/internal/school/') || request.url.startsWith('/v1/internal/commercial/')));
    }
  });

  app.decorateRequest('auth', null);
  app.addHook('onRequest', async request => {
    const h = request.headers.authorization;
    if (!h) return;
    const [s, t] = h.split(' ');
    if (s !== 'Bearer' || !t) throw new AppError(401, 'UNAUTHORIZED', 'Malformed authorization header');
    request.auth = await verifyAccessToken(config, t);
    const activeSession = await db.query(
      request.auth.preview
        ? `SELECT 1 FROM sessions s JOIN organisation_memberships m ON m.user_id=s.user_id AND m.organisation_id=s.organisation_id WHERE s.id=$1 AND s.user_id=$2 AND s.organisation_id=$3 AND s.revoked_at IS NULL AND s.expires_at>now()`
        : `SELECT 1 FROM sessions s JOIN organisation_memberships m ON m.user_id=s.user_id AND m.organisation_id=s.organisation_id WHERE s.id=$1 AND s.user_id=$2 AND s.organisation_id=$3 AND s.revoked_at IS NULL AND s.expires_at>now() AND m.status='active'`,
      [request.auth.sessionId, request.auth.userId, request.auth.organisationId]
    );
    if (!activeSession.rowCount) throw new AppError(401, 'UNAUTHORIZED', 'Session is no longer active');
  });

  app.get('/', async (_request, reply) => reply.type('text/html; charset=utf-8').send(osFrontend));
  app.get('/login', async (_request, reply) => reply.type('text/html; charset=utf-8').send(osLoginFrontend));
  app.get('/commercial-control', async (_request, reply) => reply.type('text/html; charset=utf-8').send(commercialControlFrontend));
  app.get('/health/live', async () => ({ status: 'ok' }));
  app.get('/health/ready', async (_request, reply) => {
    try {
      await db.query('SELECT 1');
      return { status: 'ready' };
    } catch {
      return reply.code(503).send({ status: 'unavailable' });
    }
  });

  await app.register(authRoutes, { db, config });
  await app.register(previewRoutes, { db, config });
  await app.register(organisationRoutes, { db });
  await app.register(userRoutes, { db });
  await app.register(operationRoutes, { db });
  await app.register(workflowRoutes, { db });
  await app.register(platformRoutes, { db, config });
  await app.register(commercialRoutes, { db });
  await app.register(saasRoutes, { db, config });
  await app.register(commercialSupportRoutes, { db, config });
  await app.register(assuranceRoutes, { db, config });
  await app.register(internalSchoolRoutes, { db, config });

  app.setNotFoundHandler((request, reply) => reply.code(404).send({
    error: { code: 'NOT_FOUND', message: `Route ${request.method} ${request.url} not found`, requestId: request.id }
  }));

  app.setErrorHandler((error, request, reply) => {
    if (error instanceof ZodError) {
      return reply.code(400).send({
        error: {
          code: 'VALIDATION_ERROR',
          message: friendlyValidationMessage(error),
          details: error.issues,
          requestId: request.id
        }
      });
    }
    if (error instanceof AppError) {
      return reply.code(error.statusCode).send({
        error: { code: error.code, message: error.message, details: error.details, requestId: request.id }
      });
    }
    request.log.error(error);
    return reply.code(500).send({
      error: {
        code: 'INTERNAL_ERROR',
        message: friendlyUnexpectedMessage(error),
        requestId: request.id
      }
    });
  });

  return app;
}
