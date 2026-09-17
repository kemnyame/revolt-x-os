import type { FastifyReply, FastifyRequest } from 'fastify';
import { forbidden, unauthorized } from './errors.js';

export function requireAuth(request: FastifyRequest) {
  if (!request.auth) throw unauthorized();
  return request.auth;
}
export function requirePermission(request: FastifyRequest, permission: string) {
  const auth = requireAuth(request);
  if (!auth.permissions.includes(permission)) throw forbidden(`Permission required: ${permission}`);
  return auth;
}
export const noContent = (reply: FastifyReply) => reply.code(204).send();
