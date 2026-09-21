import { z } from 'zod';

const emptyToUndefined=(v:unknown)=>typeof v==='string'&&v.trim()===''?undefined:v;

const schema = z.object({
  NODE_ENV: z.enum(['development','test','production']).default('development'),
  HOST: z.string().default('0.0.0.0'),
  PORT: z.coerce.number().int().positive().default(3100),
  SCHOOL_DATABASE_URL: z.string().min(1),
  CORE_OS_URL: z.string().url(),
  CORE_SERVICE_KEY: z.preprocess(emptyToUndefined,z.string().min(32).optional()),
  CORS_ORIGINS: z.string().default('*'),
  DB_POOL_MAX: z.coerce.number().int().min(1).max(30).default(5),
  PARENT_LOGIN_FAILURE_LIMIT: z.coerce.number().int().min(3).max(20).default(5),
  PARENT_LOGIN_BLOCK_MINUTES: z.coerce.number().int().min(1).max(120).default(15),
  STUDENT_LOGIN_FAILURE_LIMIT: z.coerce.number().int().min(3).max(20).default(5),
  STUDENT_LOGIN_BLOCK_MINUTES: z.coerce.number().int().min(1).max(120).default(15),
  COMMUNICATION_RETRY_INTERVAL_MS: z.coerce.number().int().min(15000).max(900000).default(60000),
  COMMUNICATION_RETRY_BATCH_SIZE: z.coerce.number().int().min(1).max(100).default(20),
  PROVISION_DEMO_TEACHERS: z.enum(['true','false']).default('false').transform(v=>v==='true'),
  ENABLE_TEST_PORTAL_ACCESS: z.enum(['true','false']).default('false').transform(v=>v==='true'),
  TEST_ACCESS_PASSWORD: z.preprocess(emptyToUndefined,z.string().min(10).max(200).optional()),

  PUBLIC_BASE_URL: z.preprocess(emptyToUndefined,z.string().url().optional()),

  EMAIL_PROVIDER: z.enum(['auto','brevo','resend']).default('auto'),
  BREVO_API_KEY: z.preprocess(emptyToUndefined,z.string().optional()),
  BREVO_FROM_EMAIL: z.preprocess(emptyToUndefined,z.string().email().optional()),
  BREVO_FROM_NAME: z.preprocess(emptyToUndefined,z.string().max(160).optional()).default('Revolt-X School'),
  RESEND_API_KEY: z.preprocess(emptyToUndefined,z.string().optional()),
  RESEND_FROM_EMAIL: z.preprocess(emptyToUndefined,z.string().optional()),

  TWILIO_ACCOUNT_SID: z.preprocess(emptyToUndefined,z.string().optional()),
  TWILIO_API_KEY_SID: z.preprocess(emptyToUndefined,z.string().optional()),
  TWILIO_API_KEY_SECRET: z.preprocess(emptyToUndefined,z.string().optional()),
  TWILIO_AUTH_TOKEN: z.preprocess(emptyToUndefined,z.string().optional()),
  TWILIO_MESSAGING_SERVICE_SID: z.preprocess(emptyToUndefined,z.string().optional()),
  TWILIO_SMS_FROM: z.preprocess(emptyToUndefined,z.string().optional()),
  TWILIO_WHATSAPP_FROM: z.preprocess(emptyToUndefined,z.string().optional()),
  TWILIO_WHATSAPP_CONTENT_SID: z.preprocess(emptyToUndefined,z.string().optional()),

  PAYSTACK_SECRET_KEY: z.preprocess(emptyToUndefined,z.string().optional()),
  PAYSTACK_CURRENCY: z.string().default('GHS')
});

export type SchoolConfig = z.infer<typeof schema>;
export const loadSchoolConfig=(env:NodeJS.ProcessEnv=process.env)=>schema.parse(env);
