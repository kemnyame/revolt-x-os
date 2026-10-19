export interface AuthContext {
  userId: string;
  organisationId: string;
  sessionId: string;
  permissions: string[];
  preview?: boolean;
  passwordChangeRequired?: boolean;
}

declare module 'fastify' {
  interface FastifyRequest { auth: AuthContext | null; }
}
