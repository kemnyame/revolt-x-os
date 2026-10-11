import { createHash } from 'node:crypto';
import type { SchoolConfig } from './config.js';
import type { SchoolDb } from './db.js';
import { maybeOne, tx } from './db.js';
import { DeliveryError, normalizeMessagePhone, providerStatus, sendMessage, type MessageChannel } from './providers.js';

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
  return normalizeMessagePhone(phone);
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
  limit=20,
  organisationId?:string
){
  const candidates=(await db.query(`
    SELECT *
    FROM communication_outbox
    WHERE status IN('queued','failed','pending_configuration')
      AND attempt_count<max_attempts
      AND COALESCE(next_attempt_at,created_at)<=now()
      AND ($2::uuid IS NULL OR organisation_id=$2)
    ORDER BY created_at
    LIMIT $1
  `,[Math.max(1,Math.min(100,limit)),organisationId??null])).rows;

  const result={scanned:candidates.length,attempted:0,sent:0,failed:0,pendingConfiguration:0};
  for(const candidate of candidates){
    const delivery=await dispatchCommunicationOutbox(db,config,candidate.id,organisationId);
    if(!delivery.attempted)continue;
    result.attempted++;
    if(delivery.row?.status==='sent')result.sent++;
    else if(delivery.row?.status==='pending_configuration')result.pendingConfiguration++;
    else if(delivery.row?.status==='failed')result.failed++;
  }

  return result;
}

// All immediate, automatic and manual sends share this atomic claim. A second
// worker or a double click cannot dispatch a row already being processed.
export async function dispatchCommunicationOutbox(db:SchoolDb,config:SchoolConfig,id:string,organisationId?:string,force=false){
  const claimed=await maybeOne<any>(db,`
    UPDATE communication_outbox
    SET status='sending',attempt_count=attempt_count+1,last_attempt_at=now(),next_attempt_at=NULL
    WHERE id=$1 AND ($2::uuid IS NULL OR organisation_id=$2)
      AND status IN('queued','failed','pending_configuration')
      AND ($3 OR (attempt_count<max_attempts AND COALESCE(next_attempt_at,created_at)<=now()))
    RETURNING *
  `,[id,organisationId??null,force]);
  if(!claimed)return{attempted:false,row:await maybeOne<any>(db,'SELECT * FROM communication_outbox WHERE id=$1 AND ($2::uuid IS NULL OR organisation_id=$2)',[id,organisationId??null])};
  try{
    const channel=claimed.channel as MessageChannel;
    if(!channelConfigured(config,channel))throw new DeliveryError(channel==='whatsapp'?providerStatus(config).whatsapp.setupNote:'The '+channel+' provider is not configured.','configuration');
    const sent=await sendMessage(config,{
      channel,to:claimed.recipient_address,subject:claimed.subject??undefined,
      recipientName:claimed.recipient_name??undefined,body:claimed.body,
      html:claimed.html_body??undefined,messageKey:claimed.id
    });
    const row=await maybeOne<any>(db,`
      UPDATE communication_outbox SET status='sent',provider=$1,provider_message_id=$2,
        provider_status=$3,sent_at=now(),last_error=NULL,next_attempt_at=NULL
      WHERE id=$4 AND status='sending' RETURNING *
    `,[sent.provider,sent.messageId,sent.providerStatus,claimed.id]);
    return{attempted:true,row};
  }catch(error:any){
    const kind=error instanceof DeliveryError?error.kind:'review';
    const configuration=kind==='configuration';
    const terminal=kind==='permanent'||kind==='review';
    const exhausted=Number(claimed.attempt_count)>=Number(claimed.max_attempts);
    const row=await maybeOne<any>(db,`
      UPDATE communication_outbox
      SET status=CASE WHEN $1 THEN 'pending_configuration' ELSE 'failed' END,
        provider_status=$2,last_error=$3,
        attempt_count=CASE WHEN $1 THEN GREATEST(0,attempt_count-1) WHEN $4 THEN GREATEST(attempt_count,max_attempts) ELSE attempt_count END,
        next_attempt_at=CASE WHEN $1 THEN now()+interval '15 minutes' WHEN $4 OR $5 THEN NULL ELSE now()+make_interval(mins=>$6) END
      WHERE id=$7 AND status='sending' RETURNING *
    `,[configuration,configuration?'needs_setup':kind==='review'?'unknown':terminal?'rejected':'retry_pending',String(error?.message||error).slice(0,4000),terminal,exhausted,communicationBackoffMinutes(Number(claimed.attempt_count)),claimed.id]);
    return{attempted:true,row};
  }
}
