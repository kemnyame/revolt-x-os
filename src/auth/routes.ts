import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import type { Config } from '../config.js'; import type { Db } from '../db/index.js';
import { login, logout, refresh, registerOrganisation } from './service.js';
import { unauthorized } from '../core/errors.js';

const password = z.string().min(12).max(128).regex(/[a-z]/).regex(/[A-Z]/).regex(/[0-9]/);
const meta = (r: FastifyRequest) => ({ ipAddress: r.ip, userAgent: r.headers['user-agent'] });
export async function authRoutes(app: FastifyInstance, options: { db: Db; config: Config }) {
  app.post('/v1/auth/register-organisation', { schema: { body: { type: 'object' } } }, async (request, reply) => {
    const body = z.object({ organisationName:z.string().min(2).max(200), slug:z.string().min(3).max(80).regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/), firstName:z.string().min(1).max(100), lastName:z.string().min(1).max(100), email:z.string().email(), password }).parse(request.body);
    return reply.code(201).send(await registerOrganisation(options.db, options.config, body, meta(request)));
  });
  app.post('/v1/auth/login', async (request) => login(options.db, options.config, z.object({ email:z.string().email(), password:z.string().min(1), organisationId:z.string().uuid().optional() }).parse(request.body), meta(request)));
  app.post('/v1/auth/refresh', async (request) => refresh(options.db, options.config, z.object({ refreshToken:z.string().min(32) }).parse(request.body).refreshToken, meta(request)));
  app.post('/v1/auth/logout', async (request, reply) => { if (!request.auth) throw unauthorized(); await logout(options.db, request.auth, meta(request)); return reply.code(204).send(); });
}
