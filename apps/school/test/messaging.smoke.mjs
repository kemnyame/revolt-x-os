import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { PGlite } from '@electric-sql/pglite';
import { loadSchoolConfig } from '../dist/config.js';
import { DeliveryError, checkMessagingConnections, normalizeMessagePhone, providerStatus, sendMessage } from '../dist/providers.js';
import { dispatchCommunicationOutbox, retryCommunicationOutbox } from '../dist/reliability.js';

const config=(extra={})=>loadSchoolConfig({NODE_ENV:'test',SCHOOL_DATABASE_URL:'postgres://test:test@localhost/test',CORE_OS_URL:'https://core.example.com',EMAIL_PROVIDER:'resend',RESEND_API_KEY:'test-key',RESEND_FROM_EMAIL:'School <notices@example.com>',RESEND_TEST_RECIPIENT:'owner@example.com',...extra});
const metaConfig=(extra={})=>config({WHATSAPP_PROVIDER:'meta',WHATSAPP_TOKEN:'test-meta-token',WHATSAPP_PHONE_NUMBER_ID:'123456789',WHATSAPP_TEMPLATE_NAME:'school_update',...extra});
const email={channel:'email',to:'parent@example.com',recipientName:'Parent',subject:'School update',body:'Test notice',messageKey:'fixed-message-id'};
const response=(data,status=200)=>new Response(JSON.stringify(data),{status,headers:{'content-type':'application/json'}});
const failsWith=kind=>error=>error instanceof DeliveryError&&error.kind===kind;

test('delivery accepts Ghana local and international forms and rejects invalid numbers',()=>{
  for(const phone of ['055 748 5233','+233557485233','233557485233','00233557485233','whatsapp:+233557485233'])assert.equal(normalizeMessagePhone(phone),'+233557485233');
  for(const phone of ['hello','+233','+0007485233','0557485233abc',''])assert.throws(()=>normalizeMessagePhone(phone),failsWith('permanent'));
});

test('Resend test mode never redirects a parent message or claims delivery',async t=>{
  const mock=t.mock.method(globalThis,'fetch',()=>assert.fail('No email should be sent'));
  await assert.rejects(sendMessage(config({RESEND_FROM_EMAIL:'School <onboarding@resend.dev>'}),email),failsWith('configuration'));
  assert.equal(mock.mock.callCount(),0);
});

test('test recipient still receives their own test email',async t=>{
  let payload;
  t.mock.method(globalThis,'fetch',async(_url,options)=>{payload=JSON.parse(options.body);return response({id:'email-id'});});
  const sent=await sendMessage(config({RESEND_FROM_EMAIL:'onboarding@resend.dev'}),{...email,to:'owner@example.com'});
  assert.deepEqual(payload.to,['owner@example.com']);
  assert.equal(sent.providerStatus,'accepted');
});

test('commercial mode rejects Resend test sender even for the owner',async t=>{
  t.mock.method(globalThis,'fetch',()=>assert.fail('Production must not use a test sender'));
  await assert.rejects(sendMessage(config({EMAIL_DELIVERY_MODE:'production',RESEND_FROM_EMAIL:'onboarding@resend.dev'}),{...email,to:'owner@example.com'}),failsWith('configuration'));
});

test('Meta sends an approved-template request using the international recipient',async t=>{
  let url,options;
  t.mock.method(globalThis,'fetch',async(u,o)=>{url=u;options=o;return response({messages:[{id:'wamid.test'}]});});
  const sent=await sendMessage(metaConfig(),{channel:'whatsapp',to:'0557485233',recipientName:'Ama',subject:'Fee receipt',body:'Payment received.\nThank you.'});
  const payload=JSON.parse(options.body);
  assert.equal(url,'https://graph.facebook.com/v25.0/123456789/messages');
  assert.equal(options.headers.authorization,'Bearer test-meta-token');
  assert.equal(payload.to,'233557485233');
  assert.equal(payload.type,'template');
  assert.equal(payload.template.name,'school_update');
  assert.deepEqual(payload.template.components[0].parameters.map(x=>x.text),['Ama','Fee receipt','Payment received. Thank you.']);
  assert.equal(sent.providerStatus,'accepted');
});

test('Meta automatic alerts wait for template setup',async t=>{
  t.mock.method(globalThis,'fetch',()=>assert.fail('Free-form automatic messages must not be sent'));
  const c=metaConfig({WHATSAPP_TEMPLATE_NAME:''});
  assert.equal(providerStatus(c).whatsapp.configured,false);
  await assert.rejects(sendMessage(c,{channel:'whatsapp',to:'0557485233',body:'Notice'}),failsWith('configuration'));
});

test('expired Meta tokens produce an actionable setup error',async t=>{
  t.mock.method(globalThis,'fetch',async()=>response({error:{code:190,message:'Token expired'}},400));
  await assert.rejects(sendMessage(metaConfig(),{channel:'whatsapp',to:'0557485233',body:'Notice'}),failsWith('configuration'));
});

test('Twilio uses a complete credential pair and correctly formats Ghana numbers',async t=>{
  let options;
  t.mock.method(globalThis,'fetch',async(_url,o)=>{options=o;return response({sid:'SM123',status:'queued'});});
  await sendMessage(config({TWILIO_ACCOUNT_SID:'AC123',TWILIO_API_KEY_SID:'SK-incomplete',TWILIO_AUTH_TOKEN:'auth-token',TWILIO_SMS_FROM:'+15551234567'}),{channel:'sms',to:'0557485233',body:'Notice'});
  assert.equal(Buffer.from(options.headers.authorization.slice(6),'base64').toString(),'AC123:auth-token');
  assert.equal(new URLSearchParams(options.body).get('To'),'+233557485233');
});

test('Resend retries preserve the same idempotency key and email content',async t=>{
  const requests=[];
  t.mock.method(globalThis,'fetch',async(_url,o)=>{requests.push(o);return response({id:'same-email-id'});});
  await sendMessage(config(),{...email,html:'<h1>Branded receipt</h1>'});
  await sendMessage(config(),{...email,html:'<h1>Branded receipt</h1>'});
  assert.equal(requests[0].headers['Idempotency-Key'],'school-message/fixed-message-id');
  assert.equal(requests[1].headers['Idempotency-Key'],requests[0].headers['Idempotency-Key']);
  assert.equal(requests[0].body,requests[1].body);
});

test('email auto fallback handles a definite Brevo credential rejection',async t=>{
  const calls=[];
  t.mock.method(globalThis,'fetch',async u=>{calls.push(u);return u.includes('brevo')?response({message:'Key not found'},401):response({id:'fallback-id'});});
  const sent=await sendMessage(config({EMAIL_PROVIDER:'auto',BREVO_API_KEY:'bad',BREVO_FROM_EMAIL:'notices@example.com'}),email);
  assert.equal(sent.provider,'resend');
  assert.equal(calls.length,2);
});

test('an uncertain Brevo timeout does not trigger a duplicate through Resend',async t=>{
  const mock=t.mock.method(globalThis,'fetch',async()=>{throw new Error('timeout');});
  await assert.rejects(sendMessage(config({EMAIL_PROVIDER:'auto',BREVO_API_KEY:'bad',BREVO_FROM_EMAIL:'notices@example.com'}),email),failsWith('review'));
  assert.equal(mock.mock.callCount(),1);
});

test('success without a provider message ID requires review',async t=>{
  t.mock.method(globalThis,'fetch',async()=>response({}));
  await assert.rejects(sendMessage(config(),email),failsWith('review'));
});

test('connection checks are read-only and verify domain and template state',async t=>{
  t.mock.method(globalThis,'fetch',async(u,o)=>{
    assert.equal(o.method,undefined);
    if(u.includes('resend'))return response({data:[{name:'example.com',status:'verified',capabilities:{sending:'enabled'}}]});
    if(u.includes('message_templates'))return response({data:[{name:'school_update',language:'en_GB',status:'APPROVED',components:[{type:'BODY',text:'Hello {{1}}, update {{2}}. Details: {{3}}.'}]}]});
    return response({display_phone_number:'+233557485233',code_verification_status:'VERIFIED'});
  });
  const checks=await checkMessagingConnections(metaConfig({WHATSAPP_BUSINESS_ACCOUNT_ID:'999999999'}));
  assert.equal(checks.email.ready,true);
  assert.equal(checks.whatsapp.ready,true);
  assert.equal(JSON.stringify(checks).includes('test-meta-token'),false);
});

test('outbox dispatch uses PostgreSQL claims, preserves errors and waits safely',async t=>{
  const pg=new PGlite();
  t.after(()=>pg.close());
  await pg.exec(`CREATE TABLE communication_outbox(
    id uuid PRIMARY KEY,organisation_id uuid NOT NULL,channel text NOT NULL,
    recipient_address text NOT NULL,recipient_name text,subject text,body text NOT NULL,
    status text NOT NULL DEFAULT 'queued',attempt_count integer NOT NULL DEFAULT 0,
    max_attempts integer NOT NULL DEFAULT 5,last_attempt_at timestamptz,next_attempt_at timestamptz,
    created_at timestamptz NOT NULL DEFAULT now(),sent_at timestamptz,
    provider text,provider_message_id text,last_error text
  )`);
  await pg.exec(await readFile(new URL('../migrations/055_commercial_messaging_delivery.sql',import.meta.url),'utf8'));
  const db={query:async(sql,params=[])=>{const r=await pg.query(sql,params);return{rows:r.rows,rowCount:r.rows.length||r.affectedRows||0};}};
  const id='11111111-1111-4111-8111-111111111111',org='22222222-2222-4222-8222-222222222222';
  const seed=async(channel='email',address='parent@example.com')=>{
    await pg.exec('TRUNCATE communication_outbox');
    await pg.query(`INSERT INTO communication_outbox(id,organisation_id,channel,recipient_address,subject,body,html_body) VALUES($1,$2,$3,$4,'School update','Notice','<h1>Branded notice</h1>')`,[id,org,channel,address]);
  };

  await t.test('concurrent dispatches and repeated clicks produce one provider request',async t=>{
    await seed();let started,release;
    const began=new Promise(resolve=>{started=resolve});const blocked=new Promise(resolve=>{release=resolve});
    const mock=t.mock.method(globalThis,'fetch',async()=>{started();await blocked;return response({id:'unique-id'});});
    const first=dispatchCommunicationOutbox(db,config(),id,org,true);
    await began;
    const second=await dispatchCommunicationOutbox(db,config(),id,org,true);
    assert.equal(second.attempted,false);release();
    const complete=await first;
    assert.equal(complete.row.status,'sent');assert.equal(complete.row.provider_status,'accepted');
    assert.equal((await dispatchCommunicationOutbox(db,config(),id,org,true)).attempted,false);
    assert.equal(mock.mock.callCount(),1);
  });

  await t.test('tenant mismatch cannot claim or send another school message',async t=>{
    await seed();t.mock.method(globalThis,'fetch',()=>assert.fail('Wrong tenant must never send'));
    const delivery=await dispatchCommunicationOutbox(db,config(),id,'33333333-3333-4333-8333-333333333333',true);
    assert.equal(delivery.row,undefined);assert.equal(delivery.attempted,false);
  });

  await t.test('unverified test sending waits without exhausting attempts',async t=>{
    await seed();t.mock.method(globalThis,'fetch',()=>assert.fail('Parent test message must never send'));
    for(let i=0;i<3;i++){
      const {row}=await dispatchCommunicationOutbox(db,config({RESEND_FROM_EMAIL:'onboarding@resend.dev'}),id,org,true);
      assert.equal(row.status,'pending_configuration');assert.equal(row.attempt_count,0);assert.equal(row.provider_status,'needs_setup');
    }
  });

  await t.test('transient retry keeps the exact saved branded content and key',async t=>{
    await seed();const requests=[];
    t.mock.method(globalThis,'fetch',async(_u,o)=>{requests.push(o);return requests.length===1?response({message:'Rate limit'},429):response({id:'retry-id'});});
    const initial=await dispatchCommunicationOutbox(db,config(),id,org,true);
    assert.equal(initial.row.status,'failed');assert.equal(initial.row.provider_status,'retry_pending');assert.ok(initial.row.next_attempt_at);
    const retry=await dispatchCommunicationOutbox(db,config(),id,org,true);
    assert.equal(retry.row.status,'sent');assert.equal(requests[0].body,requests[1].body);
    assert.equal(JSON.parse(requests[1].body).html,'<h1>Branded notice</h1>');
    assert.equal(requests[0].headers['Idempotency-Key'],requests[1].headers['Idempotency-Key']);
  });

  await t.test('permanent rejection is not retried automatically',async t=>{
    await seed();const mock=t.mock.method(globalThis,'fetch',async()=>response({message:'Invalid recipient'},422));
    const {row}=await dispatchCommunicationOutbox(db,config(),id,org,true);
    assert.equal(row.status,'failed');assert.equal(row.provider_status,'rejected');assert.equal(row.next_attempt_at,null);
    const retries=await retryCommunicationOutbox(db,config(),20,org);
    assert.equal(retries.scanned,0);assert.equal(mock.mock.callCount(),1);
  });

  await t.test('ambiguous WhatsApp outcome is retained for review instead of resending',async t=>{
    await seed('whatsapp','0557485233');const mock=t.mock.method(globalThis,'fetch',async()=>{throw new Error('Connection lost');});
    const {row}=await dispatchCommunicationOutbox(db,metaConfig(),id,org,true);
    assert.equal(row.provider_status,'unknown');assert.equal(row.next_attempt_at,null);
    assert.equal((await retryCommunicationOutbox(db,metaConfig(),20,org)).scanned,0);
    assert.equal(mock.mock.callCount(),1);
  });
});
