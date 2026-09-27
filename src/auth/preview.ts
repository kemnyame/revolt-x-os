import { createHash, randomBytes } from 'node:crypto';
import bcrypt from 'bcryptjs';
import { SignJWT } from 'jose';
import { z } from 'zod';
import type { FastifyInstance } from 'fastify';
import type { Config } from '../config.js';
import type { Db } from '../db/index.js';
import { one, transaction } from '../db/index.js';
import { AppError } from '../core/errors.js';

const hash = (value: string) => createHash('sha256').update(value).digest('hex');

export async function ensurePreviewOwner(db: Db) {
  return transaction(db, async client => {
    const organisation = await one<{ id: string }>(
      client,
      `INSERT INTO organisations(name,slug,status)
       VALUES('Kem Company','kem-company','active')
       ON CONFLICT (slug)
       DO UPDATE SET status='active',updated_at=now()
       RETURNING id`
    );

    const passwordHash = await bcrypt.hash(randomBytes(32).toString('hex'), 12);
    const user = await one<{ id: string }>(
      client,
      `INSERT INTO users(email,password_hash,first_name,last_name,status,email_verified_at)
       VALUES('preview@revolt-x.local',$1,'Revolt-X','Preview','active',now())
       ON CONFLICT (email)
       DO UPDATE SET status='active',email_verified_at=COALESCE(users.email_verified_at,now()),updated_at=now()
       RETURNING id`,
      [passwordHash]
    );

    const membership = await one<{ id: string }>(
      client,
      `INSERT INTO organisation_memberships(
         organisation_id,user_id,status,job_title,employee_number
       )
       VALUES($1,$2,'active','Preview Administrator','RX-PREVIEW-001')
       ON CONFLICT (organisation_id,user_id)
       DO UPDATE SET
         status='active',
         job_title=COALESCE(organisation_memberships.job_title,'Preview Administrator'),
         employee_number=COALESCE(organisation_memberships.employee_number,'RX-PREVIEW-001')
       RETURNING id`,
      [organisation.id, user.id]
    );

    await client.query(
      `INSERT INTO membership_roles(membership_id,role_id,scope_type,scope_id,granted_by)
       SELECT $1,id,'organisation',$2,$3
       FROM roles
       WHERE organisation_id IS NULL AND key='owner'
       ON CONFLICT DO NOTHING`,
      [membership.id, organisation.id, user.id]
    );

    return { user_id: user.id, organisation_id: organisation.id, membership_id: membership.id };
  });
}

export async function buildPreviewContext(db:Db){
  const owner=await ensurePreviewOwner(db);
  const row=await one<any>(
    db,
    `SELECT u.id,u.email,u.first_name,u.last_name,u.status,
            m.id membership_id,m.status membership_status,
            o.id organisation_id,o.name organisation_name,o.slug organisation_slug
     FROM users u
     JOIN organisation_memberships m ON m.user_id=u.id AND m.organisation_id=$2
     JOIN organisations o ON o.id=m.organisation_id
     WHERE u.id=$1
     LIMIT 1`,
    [owner.user_id,owner.organisation_id]
  );
  const permissions=(await db.query<{key:string}>(
    `SELECT DISTINCT p.key
     FROM organisation_memberships m
     JOIN membership_roles mr ON mr.membership_id=m.id
     JOIN role_permissions rp ON rp.role_id=mr.role_id
     JOIN permissions p ON p.id=rp.permission_id
     WHERE m.user_id=$1 AND m.organisation_id=$2 AND m.status='active'
     ORDER BY p.key`,
    [owner.user_id,owner.organisation_id]
  )).rows.map(x=>x.key);
  return{
    ...row,
    sessionId:'00000000-0000-0000-0000-000000000000',
    permissions,
    preview:true
  };
}

const demoPersonas={
  shop_admin:{email:'demo-owner@revolt-x.local',firstName:'Ama',lastName:'Owusu',jobTitle:'Salon Owner'},
  manager:{email:'demo-manager@revolt-x.local',firstName:'Kojo',lastName:'Mensah',jobTitle:'Salon Manager'},
  cashier:{email:'demo-cashier@revolt-x.local',firstName:'Akosua',lastName:'Boateng',jobTitle:'Cashier / Receptionist'},
  service:{email:'demo-barber@revolt-x.local',firstName:'Kwame',lastName:'Asare',jobTitle:'Senior Barber'},
  finance:{email:'demo-finance@revolt-x.local',firstName:'Efua',lastName:'Adjei',jobTitle:'Finance Officer'},
  inventory:{email:'demo-inventory@revolt-x.local',firstName:'Yaw',lastName:'Tetteh',jobTitle:'Inventory Officer'},
  auditor:{email:'demo-auditor@revolt-x.local',firstName:'Nana',lastName:'Amoako',jobTitle:'Auditor'}
} as const;

type DemoPersona=keyof typeof demoPersonas;

async function ensureShopDemoPersona(db:Db,persona:DemoPersona){
  const p=demoPersonas[persona];
  return transaction(db,async client=>{
    const organisation=await one<{id:string}>(
      client,
      `INSERT INTO organisations(name,slug,status)
       VALUES('Revolt-X Shop Demo','revolt-x-shop-demo','active')
       ON CONFLICT(slug) DO UPDATE SET status='active',updated_at=now()
       RETURNING id`
    );
    const passwordHash=await bcrypt.hash(randomBytes(32).toString('hex'),12);
    const user=await one<{id:string}>(
      client,
      `INSERT INTO users(email,password_hash,first_name,last_name,status,email_verified_at)
       VALUES($1,$2,$3,$4,'active',now())
       ON CONFLICT(email) DO UPDATE SET
         first_name=EXCLUDED.first_name,
         last_name=EXCLUDED.last_name,
         status='active',
         email_verified_at=COALESCE(users.email_verified_at,now()),
         updated_at=now()
       RETURNING id`,
      [p.email,passwordHash,p.firstName,p.lastName]
    );
    const membership=await one<{id:string}>(
      client,
      `INSERT INTO organisation_memberships(
         organisation_id,user_id,status,job_title,employee_number
       )
       VALUES($1,$2,'active',$3,$4)
       ON CONFLICT(organisation_id,user_id) DO UPDATE SET
         status='active',job_title=EXCLUDED.job_title,employee_number=EXCLUDED.employee_number
       RETURNING id`,
      [organisation.id,user.id,p.jobTitle,'RX-DEMO-'+persona.toUpperCase().replace('_','-')]
    );
    return{
      user_id:user.id,
      organisation_id:organisation.id,
      membership_id:membership.id,
      email:p.email,
      first_name:p.firstName,
      last_name:p.lastName,
      job_title:p.jobTitle
    };
  });
}

async function createSessionForUser(db:Db,config:Config,userId:string,organisationId:string,permissions:string[]=[]){
  const refreshToken=randomBytes(48).toString('base64url');
  const session=await one<{id:string}>(
    db,
    `INSERT INTO sessions(user_id,organisation_id,refresh_token_hash,expires_at)
     VALUES($1,$2,$3,now()+interval '8 hours')
     RETURNING id`,
    [userId,organisationId,hash(refreshToken)]
  );
  const accessToken=await new SignJWT({
    organisationId,
    sessionId:session.id,
    permissions,
    preview:true
  })
    .setProtectedHeader({alg:'HS256'})
    .setSubject(userId)
    .setIssuedAt()
    .setExpirationTime('8h')
    .sign(new TextEncoder().encode(config.JWT_SECRET));
  return{accessToken,refreshToken,expiresIn:28800,organisationId,preview:true};
}

export async function previewRoutes(
  app: FastifyInstance,
  { db, config }: { db: Db; config: Config }
) {
  const createPreviewSession = async () => {
    if (!config.ENABLE_PREVIEW_ACCESS) {
      throw new AppError(403, 'PREVIEW_DISABLED', 'Development preview access is disabled');
    }

    const owner = await ensurePreviewOwner(db);
    const permissions = await db.query<{ key: string }>(
      `SELECT DISTINCT p.key
       FROM organisation_memberships m
       JOIN membership_roles mr ON mr.membership_id=m.id
       JOIN role_permissions rp ON rp.role_id=mr.role_id
       JOIN permissions p ON p.id=rp.permission_id
       WHERE m.user_id=$1 AND m.organisation_id=$2 AND m.status='active'`,
      [owner.user_id, owner.organisation_id]
    );
    return createSessionForUser(db,config,owner.user_id,owner.organisation_id,permissions.rows.map(item=>item.key));
  };

  app.post('/v1/auth/preview-session',{config:{rateLimit:{max:120,timeWindow:'1 minute'}}},createPreviewSession);
  app.post('/v1/auth/preview',{config:{rateLimit:{max:120,timeWindow:'1 minute'}}},createPreviewSession);

  app.post('/v1/auth/shop-demo',{config:{rateLimit:{max:120,timeWindow:'1 minute'}}},async request=>{
    if(!config.ENABLE_PREVIEW_ACCESS){
      throw new AppError(403,'PREVIEW_DISABLED','Demo access is disabled');
    }
    const body=z.object({persona:z.enum(['shop_admin','manager','cashier','service','finance','inventory','auditor'])}).parse(request.body);
    const demo=await ensureShopDemoPersona(db,body.persona);
    const tokens=await createSessionForUser(db,config,demo.user_id,demo.organisation_id,[]);
    return{
      ...tokens,
      demo:true,
      persona:body.persona,
      userId:demo.user_id,
      email:demo.email,
      firstName:demo.first_name,
      lastName:demo.last_name,
      jobTitle:demo.job_title
    };
  });
}
