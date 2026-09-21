import { createHash } from 'node:crypto';
import type { SchoolConfig } from './config.js';
import type { SchoolDb } from './db.js';
import { maybeOne, tx } from './db.js';
import { providerStatus, sendMessage, validateBrevoConnection, type MessageChannel } from './providers.js';

export function throttleFingerprint(value:string){
  return createHash('sha256').update(String(value||'').trim().toLowerCase()).digest('hex');
}

export function communicationBackoffMinutes(attempt:number){
  if(attempt<=1)return 1;
  if(attempt===2)return 5;
  if(attempt===3)return 15;
  if(attempt===4)return 60;
  return 240;
}

export function normalizeDeliveryPhone(phone:string){
  const p=String(phone||'').trim().replace(/[\s()-]/g,'');
  if(p.startsWith('+'))return p;
  if(/^0\d{9}$/.test(p))return '+233'+p.slice(1);
  return p;
}

export async function assertPortalLoginAllowed(
  db:SchoolDb,
  portal:string,
  throttleKey:string
){
  const row=await maybeOne<{blocked_until:string|null}>(
    db,
    'SELECT blocked_until FROM portal_login_throttle WHERE portal=$1 AND throttle_key=$2',
    [portal,throttleKey]
  );
  if(row?.blocked_until&&new Date(row.blocked_until).getTime()>Date.now()){
    throw Object.assign(new Error('Too many sign-in attempts. Try again later.'),{statusCode:429});
  }
}

export async function recordPortalLoginFailure(
  db:SchoolDb,
  portal:string,
  throttleKey:string,
  maxFailures:number,
  blockMinutes:number
){
  await tx(db,async client=>{
    const current=await maybeOne<any>(
      client,
      'SELECT * FROM portal_login_throttle WHERE portal=$1 AND throttle_key=$2 FOR UPDATE',
      [portal,throttleKey]
    );
    const now=Date.now();
    const windowMs=blockMinutes*60_000;
    const started=current?.window_started_at?new Date(current.window_started_at).getTime():0;
    const inWindow=Boolean(current)&&now-started<=windowMs;
    const failures=inWindow?Number(current.failures||0)+1:1;
    const windowStarted=inWindow?new Date(started).toISOString():new Date(now).toISOString();
    const blockedUntil=failures>=maxFailures?new Date(now+windowMs).toISOString():null;
    await client.query(`
      INSERT INTO portal_login_throttle(
        portal,throttle_key,failures,window_started_at,blocked_until,last_failure_at,updated_at
      ) VALUES($1,$2,$3,$4,$5,now(),now())
      ON CONFLICT(portal,throttle_key) DO UPDATE SET
        failures=EXCLUDED.failures,
        window_started_at=EXCLUDED.window_started_at,
        blocked_until=EXCLUDED.blocked_until,
        last_failure_at=now(),
        updated_at=now()
    `,[portal,throttleKey,failures,windowStarted,blockedUntil]);
  });
}

export async function clearPortalLoginThrottle(
  db:SchoolDb,
  portal:string,
  throttleKey:string
){
  await db.query(
    'DELETE FROM portal_login_throttle WHERE portal=$1 AND throttle_key=$2',
    [portal,throttleKey]
  );
}

function channelConfigured(config:SchoolConfig,channel:MessageChannel){
  const status=providerStatus(config);
  return channel==='email'
    ?status.email.configured
    :channel==='sms'
      ?status.sms.configured
      :status.whatsapp.configured;
}

export async function retryCommunicationOutbox(
  db:SchoolDb,
  config:SchoolConfig,
  limit=20
){
  const candidates=(await db.query(`
    SELECT *
    FROM communication_outbox
    WHERE status IN('queued','failed','pending_configuration')
      AND attempt_count<max_attempts
      AND COALESCE(next_attempt_at,created_at)<=now()
    ORDER BY created_at
    LIMIT $1
  `,[Math.max(1,Math.min(100,limit))])).rows;

  const result={scanned:candidates.length,attempted:0,sent:0,failed:0,pendingConfiguration:0};
  const providers=providerStatus(config);
  let emailProviderError:string|null=null;
  if(providers.email.provider==='brevo'&&providers.email.configured){
    try{
      const verification=await validateBrevoConnection(config);
      if(!verification.authenticated||!verification.senderReady){
        emailProviderError='Brevo authentication or sender verification is not ready';
      }
    }catch(error:any){
      emailProviderError=String(error?.message||error);
    }
  }

  for(const candidate of candidates){
    const channel=candidate.channel as MessageChannel;
    if(channel==='email'&&emailProviderError){
      result.pendingConfiguration++;
      await db.query(`
        UPDATE communication_outbox
        SET status='pending_configuration',
            next_attempt_at=now()+interval '15 minutes',
            last_error=$1
        WHERE id=$2 AND status IN('queued','failed','pending_configuration')
      `,['Email provider unavailable: '+emailProviderError,candidate.id]);
      continue;
    }
    if(!channelConfigured(config,channel)){
      result.pendingConfiguration++;
      await db.query(`
        UPDATE communication_outbox
        SET status='pending_configuration',
            next_attempt_at=now()+interval '15 minutes',
            last_error='Provider is not configured'
        WHERE id=$1 AND status IN('queued','failed','pending_configuration')
      `,[candidate.id]);
      continue;
    }

    const claimed=await maybeOne<any>(db,`
      UPDATE communication_outbox
      SET status='sending',
          attempt_count=attempt_count+1,
          last_attempt_at=now(),
          next_attempt_at=NULL
      WHERE id=$1
        AND status IN('queued','failed','pending_configuration')
        AND attempt_count<max_attempts
      RETURNING *
    `,[candidate.id]);

    if(!claimed)continue;
    result.attempted++;

    try{
      const sent=await sendMessage(config,{
        channel,
        to:channel==='email'?claimed.recipient_address:normalizeDeliveryPhone(claimed.recipient_address),
        subject:claimed.subject??undefined,
        recipientName:claimed.recipient_name??undefined,
        body:claimed.body
      });
      await db.query(`
        UPDATE communication_outbox
        SET status='sent',
            provider=$1,
            provider_message_id=$2,
            sent_at=now(),
            last_error=NULL,
            next_attempt_at=NULL
        WHERE id=$3
      `,[sent.provider,sent.messageId,claimed.id]);
      result.sent++;
    }catch(error:any){
      const attempt=Number(claimed.attempt_count||1);
      const exhausted=attempt>=Number(claimed.max_attempts||5);
      const delay=communicationBackoffMinutes(attempt);
      await db.query(`
        UPDATE communication_outbox
        SET status='failed',
            last_error=$1,
            next_attempt_at=CASE WHEN $2 THEN NULL ELSE now()+make_interval(mins=>$3) END
        WHERE id=$4
      `,[String(error?.message||error).slice(0,4000),exhausted,delay,claimed.id]);
      result.failed++;
    }
  }

  return result;
}
