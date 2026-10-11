import test,{before,after} from 'node:test';
import assert from 'node:assert/strict';
import Fastify from 'fastify';
import {PGlite} from '@electric-sql/pglite';
import {z} from 'zod';
import {registerSchoolReportingRoutes} from '../dist/school-reporting.js';

const pg=new PGlite(),school='11111111-1111-4111-8111-111111111111',other='22222222-2222-4222-8222-222222222222',app=Fastify();
const db={query:async(sql,params)=>{const r=await pg.query(sql,params);return{rows:r.rows,rowCount:r.rows.length||r.affectedRows||0}}};
app.setErrorHandler((error,_req,reply)=>reply.code(error instanceof z.ZodError?400:error.statusCode||500).send({error:{message:error.message}}));
registerSchoolReportingRoutes(app,{db,requireCoreServiceRequest:request=>{if(request.headers['x-revolt-service-key']!=='test-key')throw Object.assign(new Error('Service credential required'),{statusCode:401})}});
before(async()=>{
  await pg.exec(`CREATE TABLE school_profiles(organisation_id uuid,school_name text,tenant_slug text);
    CREATE TABLE school_audit_logs(id serial,organisation_id uuid,actor_os_user_id uuid,action text,resource_type text,resource_id text,created_at timestamptz);
    SET TIME ZONE 'Pacific/Auckland';`);
  await db.query("INSERT INTO school_profiles VALUES($1,'Alpha','alpha'),($2,'Other','other')",[school,other]);
  await db.query(`INSERT INTO school_audit_logs(organisation_id,action,created_at) VALUES
    ($1,'before','2026-09-30T23:59:59Z'),($1,'start','2026-10-01T00:00:00Z'),($1,'end','2026-10-11T23:59:59Z'),($1,'after','2026-10-12T00:00:00Z'),($2,'other-school','2026-10-05T12:00:00Z')`,[school,other]);
});
after(async()=>{await app.close();await pg.close()});
const logs=query=>app.inject({url:'/api/internal/admin-activity?organisationId='+school+query,headers:{'x-revolt-service-key':'test-key'}});
test('administrator log access requires a trusted service, explicit school and valid dates',async()=>{
  assert.equal((await app.inject({url:'/api/internal/admin-activity?organisationId='+school})).statusCode,401);
  assert.equal((await logs('&from=2026-02-30')).statusCode,400);assert.equal((await logs('&from=2026-10-11&to=2026-10-01')).statusCode,400);
});
test('period is inclusive in UTC and never includes another school',async()=>{
  const r=await logs('&from=2026-10-01&to=2026-10-11');assert.equal(r.statusCode,200,r.body);assert.deepEqual(r.json().rows.map(x=>x.action),['end','start']);assert.equal(r.json().total,2);
});
test('limited previews report the full count so spool exports cannot silently omit rows',async()=>{
  const r=await logs('&from=2026-10-01&to=2026-10-11&limit=1');assert.equal(r.statusCode,200,r.body);assert.equal(r.json().rows.length,1);assert.equal(r.json().total,2);
  assert.equal((await logs('&limit=10000')).statusCode,200);assert.equal((await logs('&limit=10001')).statusCode,400);
});
