import { describe,expect,it } from 'vitest'; import { loadConfig } from './config.js';
const valid={DATABASE_URL:'postgresql://localhost/test',JWT_SECRET:'12345678901234567890123456789012'};
describe('configuration',()=>{it('loads secure defaults',()=>{const c=loadConfig(valid);expect(c.PORT).toBe(3000);expect(c.ACCESS_TOKEN_TTL_SECONDS).toBe(900);});it('rejects short JWT secrets',()=>expect(()=>loadConfig({...valid,JWT_SECRET:'short'})).toThrow());});
