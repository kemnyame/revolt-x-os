import {afterEach,describe,it,expect,vi} from 'vitest';
import {loadConfig} from '../config.js';
import {deliverSchoolAccessEmail} from './password-reset-email.js';
const config=loadConfig({NODE_ENV:'test',DATABASE_URL:'postgres://localhost/test',JWT_SECRET:'test-only-key-'.repeat(4),SCHOOL_APP_URL:'https://school.example.test',SCHOOL_SERVICE_KEY:'test-only-service-'.repeat(4),SCHOOL_ACCESS_EMAILS:'true'});
const input={organisationId:'11111111-1111-4111-8111-111111111111',schoolSlug:'alpha',schoolName:'Alpha School',email:'administrator@example.test',kind:'password_reset' as const,resetToken:'test-only-token-'.repeat(4)};
afterEach(()=>vi.unstubAllGlobals());
describe('School account mail dispatch',()=>{
 it('sends only the verified Core workflow identity through the authenticated School endpoint',async()=>{
  const fetcher=vi.fn(async()=>Response.json({sent:true}));vi.stubGlobal('fetch',fetcher);
  expect(await deliverSchoolAccessEmail(config,input)).toEqual({status:'accepted'});
  const [url,options]=fetcher.mock.calls[0] as unknown as [string,RequestInit];expect(url).toBe('https://school.example.test/api/internal/school-access-email');expect(new Headers(options.headers).get('x-revolt-service-key')).toBe(config.SCHOOL_SERVICE_KEY);expect(JSON.parse(options.body as string)).toEqual({...input,administrator:true});
 });
 it('does not disclose credentials or reset links when Google authorization is missing or sending is uncertain',async()=>{
  vi.stubGlobal('fetch',vi.fn(async()=>{throw new Error(config.SCHOOL_SERVICE_KEY)}));const result=await deliverSchoolAccessEmail(config,input);expect(result).toEqual({status:'needs_review'});expect(JSON.stringify(result)).not.toContain(input.resetToken);expect(JSON.stringify(result)).not.toContain(config.SCHOOL_SERVICE_KEY);
 });
 it('leaves legacy integrations untouched until the operator enables account email',async()=>{
  const fetcher=vi.fn();vi.stubGlobal('fetch',fetcher);expect(await deliverSchoolAccessEmail({...config,SCHOOL_ACCESS_EMAILS:false},input)).toEqual({status:'not_configured'});expect(fetcher).not.toHaveBeenCalled();
 });
});
