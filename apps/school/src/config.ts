import { z } from 'zod';

const emptyToUndefined=(v:unknown)=>typeof v==='string'&&v.trim()===''?undefined:v;

const schema = z.object({
  NODE_ENV: z.enum(['development','test','production']).default('development'),
  HOST: z.string().default('0.0.0.0'),
  PORT: z.coerce.number().int().positive().default(3100),
  SCHOOL_DATABASE_URL: z.string().min(1),
  CORE_OS_URL: z.string().url(),
  CORE_SERVICE_KEY: z.preprocess(emptyToUndefined,z.string().min(32).optional()),
  // Operator-confirmed incident notice. It is used only while Core readiness fails.
  CORE_SIGN_IN_OUTAGE_MESSAGE: z.preprocess(emptyToUndefined,z.string().trim().max(400).optional()),
  CORS_ORIGINS: z.string().default('*'),
  DB_POOL_MAX: z.coerce.number().int().min(1).max(30).default(5),
  PARENT_LOGIN_FAILURE_LIMIT: z.coerce.number().int().min(3).max(20).default(5),
  PARENT_LOGIN_BLOCK_MINUTES: z.coerce.number().int().min(1).max(120).default(15),
  COMMUNICATION_RETRY_INTERVAL_MS: z.coerce.number().int().min(15000).max(900000).default(60000),
  COMMUNICATION_RETRY_BATCH_SIZE: z.coerce.number().int().min(1).max(100).default(20),
  // When Core OS cannot be reached, a recently verified active licence remains usable
  // for this many hours. After the grace window the School becomes read-only until
  // Core OS can verify the entitlement again.
  LICENSE_OUTAGE_GRACE_HOURS: z.coerce.number().int().min(1).max(336).default(72),

  PUBLIC_BASE_URL: z.preprocess(emptyToUndefined,z.string().url().optional()),

  EMAIL_PROVIDER: z.enum(['auto','brevo','resend']).default('auto'),
  EMAIL_DELIVERY_MODE: z.enum(['auto','testing','production']).default('auto'),
  EMAIL_REPLY_TO: z.preprocess(emptyToUndefined,z.string().email().optional()),
  BREVO_API_KEY: z.preprocess(emptyToUndefined,z.string().optional()),
  BREVO_FROM_EMAIL: z.preprocess(emptyToUndefined,z.string().email().optional()),
  BREVO_FROM_NAME: z.preprocess(emptyToUndefined,z.string().max(160).optional()).default('Revolt-X School'),
  RESEND_API_KEY: z.preprocess(emptyToUndefined,z.string().optional()),
  RESEND_FROM_EMAIL: z.preprocess(emptyToUndefined,z.string().optional()),
  RESEND_TEST_RECIPIENT: z.preprocess(emptyToUndefined,z.string().email().optional()),

  WHATSAPP_PROVIDER: z.enum(['auto','meta','twilio']).default('auto'),
  WHATSAPP_TOKEN: z.preprocess(emptyToUndefined,z.string().optional()),
  WHATSAPP_PHONE_NUMBER_ID: z.preprocess(emptyToUndefined,z.string().regex(/^\d+$/).optional()),
  WHATSAPP_BUSINESS_ACCOUNT_ID: z.preprocess(emptyToUndefined,z.string().regex(/^\d+$/).optional()),
  WHATSAPP_API_VERSION: z.string().regex(/^v\d+\.0$/).default('v25.0'),
  WHATSAPP_TEMPLATE_NAME: z.preprocess(emptyToUndefined,z.string().regex(/^[a-z0-9_]+$/).optional()),
  WHATSAPP_TEMPLATE_LANGUAGE: z.string().regex(/^[a-z]{2}(?:_[A-Z]{2})?$/).default('en_GB'),
  // Free-form messages are permitted only in an active customer-service window.
  WHATSAPP_ALLOW_SESSION_MESSAGES: z.enum(['true','false']).default('false').transform(v=>v==='true'),

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
