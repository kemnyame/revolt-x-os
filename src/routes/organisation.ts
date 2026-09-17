import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { Db } from '../db/index.js'; import { one, transaction } from '../db/index.js';
import { audit, emitEvent } from '../core/audit.js'; import { conflict, notFound } from '../core/errors.js'; import { requirePermission } from '../core/http.js';

const entitySchemas = {
  branches: z.object({ code:z.string().min(1).max(30).transform(v=>v.toUpperCase()), name:z.string().min(2).max(160), timezone:z.string().min(1).max(80).default('UTC'), address:z.record(z.string(),z.unknown()).default({}) }),
  departments: z.object({ code:z.string().min(1).max(30).transform(v=>v.toUpperCase()), name:z.string().min(2).max(160), branchId:z.string().uuid().nullable().optional(), parentId:z.string().uuid().nullable().optional() }),
  teams: z.object({ name:z.string().min(2).max(160), description:z.string().max(2000).nullable().optional(), departmentId:z.string().uuid().nullable().optional() })
};

export async function organisationRoutes(app: FastifyInstance, { db }: { db: Db }) {
  app.get('/v1/organisation', async (request) => { const a=requirePermission(request,'organisation.read'); return one(db,'SELECT id,slug,name,status,settings,created_at,updated_at FROM organisations WHERE id=$1',[a.organisationId]); });
  app.patch('/v1/organisation', async (request) => {
    const a=requirePermission(request,'organisation.manage'); const body=z.object({ name:z.string().min(2).max(200).optional(), settings:z.record(z.string(),z.unknown()).optional() }).refine(v=>Object.keys(v).length>0).parse(request.body);
    return transaction(db, async c => { const before=await one<any>(c,'SELECT name,settings FROM organisations WHERE id=$1 FOR UPDATE',[a.organisationId]); const row=await one<any>(c,'UPDATE organisations SET name=COALESCE($2,name),settings=COALESCE($3,settings),updated_at=now() WHERE id=$1 RETURNING id,slug,name,status,settings,updated_at',[a.organisationId,body.name??null,body.settings?JSON.stringify(body.settings):null]); await audit(c,{organisationId:a.organisationId,actorUserId:a.userId,sessionId:a.sessionId,action:'organisation.updated',resourceType:'organisation',resourceId:a.organisationId,beforeState:before,afterState:row}); return row; });
  });
  for (const kind of ['branches','departments','teams'] as const) {
    app.get(`/v1/${kind}`, async request => { const a=requirePermission(request,'structure.read'); return (await db.query(`SELECT * FROM ${kind} WHERE organisation_id=$1 ORDER BY name`,[a.organisationId])).rows; });
    app.post(`/v1/${kind}`, async (request,reply) => {
      const a=requirePermission(request,'structure.manage'); const b:any=entitySchemas[kind].parse(request.body);
      try { const row=await transaction(db, async c => { let result:any;
        if(kind==='branches') result=await one(c,'INSERT INTO branches(organisation_id,code,name,timezone,address) VALUES($1,$2,$3,$4,$5) RETURNING *',[a.organisationId,b.code,b.name,b.timezone,JSON.stringify(b.address)]);
        else if(kind==='departments') result=await one(c,'INSERT INTO departments(organisation_id,code,name,branch_id,parent_id) VALUES($1,$2,$3,$4,$5) RETURNING *',[a.organisationId,b.code,b.name,b.branchId??null,b.parentId??null]);
        else result=await one(c,'INSERT INTO teams(organisation_id,name,description,department_id) VALUES($1,$2,$3,$4) RETURNING *',[a.organisationId,b.name,b.description??null,b.departmentId??null]);
        await audit(c,{organisationId:a.organisationId,actorUserId:a.userId,sessionId:a.sessionId,action:`${kind}.created`,resourceType:kind.slice(0,-1),resourceId:result.id,afterState:result}); await emitEvent(c,a.organisationId,`core.${kind.slice(0,-1)}.created.v1`,kind.slice(0,-1),result.id,result); return result; }); return reply.code(201).send(row);
      } catch(e:any){ if(e.code==='23505') throw conflict(`${kind.slice(0,-1)} already exists`); if(e.code==='23503') throw notFound('Parent organisational entity'); throw e; }
    });
  }
}
