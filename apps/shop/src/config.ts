import { z } from 'zod';
import 'dotenv/config';

const emptyToUndefined=(v:unknown)=>typeof v==='string'&&v.trim()===''?undefined:v;
const bool=z.enum(['true','false']).default('false').transform(v=>v==='true');

const schema=z.object({
  NODE_ENV:z.enum(['development','test','production']).default('development'),
  HOST:z.string().default('0.0.0.0'),
  PORT:z.coerce.number().int().positive().default(3200),
  SHOP_DATABASE_URL:z.string().min(1),
  CORE_OS_URL:z.string().url(),
  CORS_ORIGINS:z.string().default('*'),
  DB_POOL_MAX:z.coerce.number().int().min(1).max(30).default(10),
  PUBLIC_BASE_URL:z.preprocess(emptyToUndefined,z.string().url().optional()),
  PAYSTACK_SECRET_KEY:z.preprocess(emptyToUndefined,z.string().optional()),
  PAYSTACK_CURRENCY:z.string().length(3).default('GHS'),
  ENABLE_DEMO_LOGIN:bool,
  CUSTOMER_PORTAL_SESSION_DAYS:z.coerce.number().int().min(1).max(90).default(30),
  SMS_WEBHOOK_URL:z.preprocess(emptyToUndefined,z.string().url().optional()),
  SMS_WEBHOOK_TOKEN:z.preprocess(emptyToUndefined,z.string().optional()),
  WHATSAPP_API_URL:z.preprocess(emptyToUndefined,z.string().url().optional()),
  WHATSAPP_TOKEN:z.preprocess(emptyToUndefined,z.string().optional()),
  WHATSAPP_PHONE:z.preprocess(emptyToUndefined,z.string().optional()),
  GOOGLE_CLIENT_ID:z.preprocess(emptyToUndefined,z.string().optional())
});

export type ShopConfig=z.infer<typeof schema>;
export const loadConfig=(env:NodeJS.ProcessEnv=process.env)=>schema.parse(env);
