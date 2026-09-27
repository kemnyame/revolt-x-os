import { z } from 'zod';
import 'dotenv/config';

const emptyToUndefined=(v:unknown)=>typeof v==='string'&&v.trim()===''?undefined:v;

const schema=z.object({
  NODE_ENV:z.enum(['development','test','production']).default('development'),
  HOST:z.string().default('0.0.0.0'),
  PORT:z.coerce.number().int().positive().default(3200),
  SHOP_DATABASE_URL:z.string().min(1),
  CORE_OS_URL:z.string().url(),
  CORS_ORIGINS:z.string().default('*'),
  DB_POOL_MAX:z.coerce.number().int().min(1).max(30).default(5),
  PUBLIC_BASE_URL:z.preprocess(emptyToUndefined,z.string().url().optional()),
  PAYSTACK_SECRET_KEY:z.preprocess(emptyToUndefined,z.string().optional()),
  PAYSTACK_CURRENCY:z.string().default('GHS'),
  SHOP_BOOTSTRAP_EMAIL:z.preprocess(emptyToUndefined,z.string().email().optional()),
  SHOP_BOOTSTRAP_PASSWORD:z.preprocess(emptyToUndefined,z.string().min(8).optional()),
  OS_BOOTSTRAP_EMAIL:z.preprocess(emptyToUndefined,z.string().email().optional()),
  OS_BOOTSTRAP_PASSWORD:z.preprocess(emptyToUndefined,z.string().min(8).optional()),
  BOOTSTRAP_CREDENTIALS_VERSION:z.string().default('v1')
});

export type ShopConfig=z.infer<typeof schema>;
export const loadConfig=(env:NodeJS.ProcessEnv=process.env)=>schema.parse(env);
