import { z } from 'zod';

const schema = z.object({
  NODE_ENV: z.enum(['development','test','production']).default('development'),
  HOST: z.string().default('0.0.0.0'),
  PORT: z.coerce.number().int().positive().default(3100),
  SCHOOL_DATABASE_URL: z.string().min(1),
  CORE_OS_URL: z.string().url(),
  CORS_ORIGINS: z.string().default('*'),
  DB_POOL_MAX: z.coerce.number().int().min(1).max(30).default(5)
});

export type SchoolConfig = z.infer<typeof schema>;
export const loadSchoolConfig=(env:NodeJS.ProcessEnv=process.env)=>schema.parse(env);
