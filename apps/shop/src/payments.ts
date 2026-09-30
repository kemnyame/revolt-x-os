import type { FastifyInstance } from 'fastify';
import { createHmac, timingSafeEqual } from 'node:crypto';
import type { Db } from './db.js';
import { maybeOne, tx } from './db.js';
import type { ShopConfig } from './config.js';
import { postPaymentFinanceJournal } from './accounting.js';

function secureHexEqual(a:string,b:string){
  try{
    const aa=Buffer.from(a,'hex');
    const bb=Buffer.from(b,'hex');
    return aa.length===bb.length&&timingSafeEqual(aa,bb);
  }catch{return false;}
}

async function refreshOrderPaid(db:Db,orderId:string){
  await db.query(
    `UPDATE shop_orders o
     SET amount_paid=x.paid,
         balance=greatest(0,o.total-x.paid),
         status=CASE WHEN x.paid>=o.total THEN 'paid' WHEN x.paid>0 THEN 'part_paid' ELSE 'open' END,
         updated_at=now()
     FROM (
       SELECT coalesce(sum(amount),0)::numeric paid
       FROM shop_payments
       WHERE order_id=$1 AND status='successful'
     ) x
     WHERE o.id=$1`,
    [orderId]
  );
}

async function settlePaystackCharge(db:Db,payment:any,data:any){
  const providerFee=Math.max(0,Number(data?.fees||0)/100);
  const providerRef=String(data?.id||data?.reference||payment.provider_reference||payment.reference);
  const paidAt=data?.paid_at||data?.paidAt||null;

  await db.query(
    `UPDATE shop_payments
     SET status='successful',
         provider_reference=$1,
         fee=$2,
         settlement_amount=greatest(0,amount-$2),
         paid_at=coalesce($3::timestamptz,paid_at,now()),
         raw_json=$4
     WHERE id=$5`,
    [providerRef,providerFee,paidAt,JSON.stringify(data||{}),payment.id]
  );

  const posted=await db.query(
    "SELECT 1 FROM shop_ledger_entries WHERE source_type='payment' AND source_id=$1 LIMIT 1",
    [payment.id]
  );
  if(!posted.rowCount){
    await db.query(
      `INSERT INTO shop_ledger_entries(
         organisation_id,shop_id,branch_id,account_code,account_name,debit,credit,
         source_type,source_id,reference,description
       )
       VALUES
         ($1,$2,$3,'1010','Payment Gateway Settlement',$4,0,'payment',$5,$6,'Online customer payment'),
         ($1,$2,$3,'4000','Sales Revenue',0,$4,'payment',$5,$6,'Online customer payment')`,
      [payment.organisation_id,payment.shop_id,payment.branch_id,payment.amount,payment.id,payment.reference]
    );
  }

  if(providerFee>0){
    const feePosted=await db.query(
      "SELECT 1 FROM shop_ledger_entries WHERE source_type='payment_fee' AND source_id=$1 LIMIT 1",
      [payment.id]
    );
    if(!feePosted.rowCount){
      await db.query(
        `INSERT INTO shop_ledger_entries(
           organisation_id,shop_id,branch_id,account_code,account_name,debit,credit,
           source_type,source_id,reference,description
         )
         VALUES
           ($1,$2,$3,'5100','Payment Processing Fees',$4,0,'payment_fee',$5,$6,'Payment gateway fee'),
           ($1,$2,$3,'1010','Payment Gateway Settlement',0,$4,'payment_fee',$5,$6,'Payment gateway fee')`,
        [payment.organisation_id,payment.shop_id,payment.branch_id,providerFee,payment.id,payment.reference]
      );
    }
  }

  if(payment.order_id)await refreshOrderPaid(db,payment.order_id);
  await postPaymentFinanceJournal(db,{...payment,status:'successful',fee:providerFee,paid_at:paidAt||new Date().toISOString()},null);
  await db.query(
    `INSERT INTO shop_audit_logs(organisation_id,actor_os_user_id,action,resource_type,resource_id,shop_id,branch_id,metadata)
     VALUES($1,NULL,'payment.webhook_settled','payment',$2,$3,$4,$5)`,
    [payment.organisation_id,payment.id,payment.shop_id,payment.branch_id,JSON.stringify({provider:'paystack',reference:payment.reference,fee:providerFee})]
  );
}

export async function verifyPaystackReference(db:Db,config:ShopConfig,reference:string,actorUserId:string|null=null){
  if(!config.PAYSTACK_SECRET_KEY){
    const e:any=new Error('Online payment provider is not configured');
    e.statusCode=503;e.code='PAYMENT_PROVIDER_NOT_CONFIGURED';throw e;
  }
  const payment=await maybeOne<any>(
    db,
    `SELECT p.*,s.public_slug
     FROM shop_payments p
     LEFT JOIN shops s ON s.id=p.shop_id
     WHERE p.provider='paystack' AND p.reference=$1
     ORDER BY p.created_at DESC LIMIT 1`,
    [reference]
  );
  if(!payment){
    const e:any=new Error('Payment reference was not found');
    e.statusCode=404;e.code='PAYMENT_NOT_FOUND';throw e;
  }

  const ps=await fetch('https://api.paystack.co/transaction/verify/'+encodeURIComponent(reference),{
    headers:{authorization:'Bearer '+config.PAYSTACK_SECRET_KEY},
    signal:AbortSignal.timeout(15000)
  });
  const data=await ps.json().catch(()=>null) as any;
  if(!ps.ok||!data?.status){
    const e:any=new Error(data?.message||'Payment verification failed');
    e.statusCode=502;e.code='PAYMENT_VERIFICATION_FAILED';throw e;
  }

  const providerStatus=String(data.data?.status||'pending');
  const successful=providerStatus==='success';
  const receivedAmount=Math.round(Number(data.data?.amount||0));
  const expectedAmount=Math.round(Number(payment.amount||0)*100);
  const receivedCurrency=String(data.data?.currency||payment.currency||'').toUpperCase();
  const expectedCurrency=String(payment.currency||config.PAYSTACK_CURRENCY||'GHS').toUpperCase();

  if(successful&&(receivedAmount!==expectedAmount||receivedCurrency!==expectedCurrency)){
    await db.query(
      `UPDATE shop_payments SET status='review_required',provider_reference=$1,raw_json=$2 WHERE id=$3`,
      [String(data.data?.id||payment.provider_reference||reference),JSON.stringify(data),payment.id]
    );
    await db.query(
      `INSERT INTO shop_audit_logs(organisation_id,actor_os_user_id,action,resource_type,resource_id,shop_id,branch_id,metadata)
       VALUES($1,$2,'payment.amount_mismatch','payment',$3,$4,$5,$6)`,
      [payment.organisation_id,actorUserId,payment.id,payment.shop_id,payment.branch_id,JSON.stringify({reference,expectedAmount,receivedAmount,expectedCurrency,receivedCurrency})]
    );
    return{status:'review_required',payment:{...payment,status:'review_required'},providerStatus,publicSlug:payment.public_slug};
  }

  if(successful){
    await tx(db,async client=>{
      const locked=await client.query(
        `SELECT p.*,s.public_slug
         FROM shop_payments p
         LEFT JOIN shops s ON s.id=p.shop_id
         WHERE p.id=$1 FOR UPDATE`,
        [payment.id]
      );
      if(!locked.rowCount)return;
      const current=locked.rows[0];
      if(current.status!=='successful')await settlePaystackCharge(client,current,data.data||{});
    });
    const settled=await maybeOne<any>(db,
      `SELECT p.*,s.public_slug FROM shop_payments p LEFT JOIN shops s ON s.id=p.shop_id WHERE p.id=$1`,
      [payment.id]
    );
    return{status:'successful',payment:settled,providerStatus,publicSlug:settled?.public_slug||payment.public_slug};
  }

  await db.query(
    `UPDATE shop_payments
     SET status=$1,provider_reference=$2,raw_json=$3
     WHERE id=$4 AND status<>'successful'`,
    [providerStatus,String(data.data?.id||payment.provider_reference||reference),JSON.stringify(data),payment.id]
  );
  return{status:providerStatus,payment:{...payment,status:providerStatus},providerStatus,publicSlug:payment.public_slug};
}

export async function registerPaymentWebhook(app:FastifyInstance,{db,config}:{db:Db;config:ShopConfig}){
  await app.register(async scoped=>{
    scoped.removeContentTypeParser('application/json');
    scoped.addContentTypeParser('application/json',{parseAs:'string'},(_request,body,done)=>{
      done(null,body);
    });

    scoped.post('/api/webhooks/paystack',async(req,reply)=>{
      if(!config.PAYSTACK_SECRET_KEY){
        return reply.code(503).send({received:false,error:'payment_provider_not_configured'});
      }

      const raw=typeof req.body==='string'?req.body:'';
      const signature=String(req.headers['x-paystack-signature']||'');
      const expected=createHmac('sha512',config.PAYSTACK_SECRET_KEY).update(raw).digest('hex');
      if(!signature||!secureHexEqual(signature,expected)){
        return reply.code(401).send({received:false});
      }

      let payload:any;
      try{payload=JSON.parse(raw);}
      catch{return reply.code(400).send({received:false,error:'invalid_json'});}

      const event=String(payload?.event||'unknown');
      const data=payload?.data||{};
      const reference=String(data?.reference||'');
      const eventKey=event+':'+String(data?.id||reference||createHmac('sha256',config.PAYSTACK_SECRET_KEY).update(raw).digest('hex'));

      const result=await tx(db,async client=>{
        const inserted=await client.query(
          `INSERT INTO shop_payment_events(provider,event_key,payload)
           VALUES('paystack',$1,$2::jsonb)
           ON CONFLICT(provider,event_key) DO NOTHING
           RETURNING id`,
          [eventKey,JSON.stringify(payload)]
        );
        if(!inserted.rowCount)return{duplicate:true};

        if(event!=='charge.success'||!reference)return{ignored:true,event};

        const orgId=String(data?.metadata?.organisation_id||'');
        const payment=await maybeOne<any>(
          client,
          `SELECT * FROM shop_payments
           WHERE provider='paystack' AND reference=$1
             AND ($2='' OR organisation_id::text=$2)
           ORDER BY created_at DESC LIMIT 1
           FOR UPDATE`,
          [reference,orgId]
        );
        if(!payment)return{unmatched:true,reference};

        const receivedAmount=Math.round(Number(data?.amount||0));
        const expectedAmount=Math.round(Number(payment.amount||0)*100);
        const receivedCurrency=String(data?.currency||payment.currency||'').toUpperCase();
        const expectedCurrency=String(payment.currency||'GHS').toUpperCase();

        if(receivedAmount!==expectedAmount||receivedCurrency!==expectedCurrency){
          await client.query(
            `UPDATE shop_payments SET status='review_required',raw_json=$1 WHERE id=$2`,
            [JSON.stringify(payload),payment.id]
          );
          await client.query(
            `INSERT INTO shop_audit_logs(organisation_id,action,resource_type,resource_id,shop_id,branch_id,metadata)
             VALUES($1,'payment.amount_mismatch','payment',$2,$3,$4,$5)`,
            [payment.organisation_id,payment.id,payment.shop_id,payment.branch_id,JSON.stringify({expectedAmount,receivedAmount,expectedCurrency,receivedCurrency})]
          );
          return{reviewRequired:true,reference};
        }

        await settlePaystackCharge(client,payment,data);
        return{settled:true,reference};
      });

      return reply.code(200).send({received:true,...result});
    });
  });
}
