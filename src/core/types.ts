export interface AuthContext {
  userId: string;
  organisationId: string;
  sessionId: string;
  permissions: string[];
}

declare module 'fastify' {
  interface FastifyRequest { auth: AuthContext | null; }
}
