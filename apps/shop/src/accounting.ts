import type { Db } from './db.js';

type Queryable=Pick<Db,'query'>;

async function ensureAccount(
  db:Queryable,
  payment:any,
  code:string,
  name:string,
  accountType:'asset'|'liability'|'equity'|'income'|'expense',
  subtype:string,
  isCash=false
){
  await db.query(
    `INSERT INTO shop_finance_accounts(
       organisation_id,shop_id,code,name,account_type,subtype,is_cash_account,is_system,is_active
     )
     VALUES($1,$2,$3,$4,$5,$6,$7,true,true)
     ON CONFLICT(organisation_id,shop_id,code) DO UPDATE SET
       name=EXCLUDED.name,account_type=EXCLUDED.account_type,subtype=EXCLUDED.subtype,
       is_cash_account=EXCLUDED.is_cash_account,is_active=true,updated_at=now()`,
    [payment.organisation_id,payment.shop_id,code,name,accountType,subtype,isCash]
  );
  const r=await db.query(
    `SELECT id,code,name FROM shop_finance_accounts
     WHERE organisation_id=$1 AND shop_id=$2 AND code=$3 LIMIT 1`,
    [payment.organisation_id,payment.shop_id,code]
  );
  return r.rows[0];
}

function settlementAccount(method:string){
  if(method==='cash')return{code:'1000',name:'Cash on Hand',subtype:'cash',cash:true};
  if(method==='mobile_money')return{code:'1020',name:'Mobile Money Clearing',subtype:'mobile_money',cash:true};
  if(method==='card')return{code:'1030',name:'Card Clearing',subtype:'card',cash:true};
  return{code:'1010',name:'Bank Account',subtype:'bank',cash:true};
}

export async function postPaymentFinanceJournal(db:Queryable,payment:any,actorId?:string|null){
  if(!payment?.id||payment.status!=='successful')return null;
  const existing=await db.query(
    `SELECT id,entry_no FROM shop_finance_journal_entries
     WHERE organisation_id=$1 AND source_type='payment' AND source_id=$2 AND status='posted'
     ORDER BY created_at LIMIT 1`,
    [payment.organisation_id,payment.id]
  );
  if(existing.rowCount)return existing.rows[0];

  const settlement=settlementAccount(String(payment.method||''));
  const settlementAcc=await ensureAccount(db,payment,settlement.code,settlement.name,'asset',settlement.subtype,settlement.cash);
  const revenueAcc=await ensureAccount(db,payment,'4000','Sales Revenue','income','sales_revenue',false);
  const feeAcc=Number(payment.fee||0)>0
    ? await ensureAccount(db,payment,'5100','Payment Processing Fees','expense','payment_fees',false)
    : null;

  const amount=Math.max(0,Number(payment.amount||0));
  const fee=Math.min(amount,Math.max(0,Number(payment.fee||0)));
  if(amount<=0)return null;
  const settlementDebit=Math.max(0,amount-fee);
  const entryNo=('AUTO-PAY-'+String(payment.id).replace(/-/g,'').slice(0,16)).toUpperCase();

  const inserted=await db.query(
    `INSERT INTO shop_finance_journal_entries(
       organisation_id,shop_id,branch_id,entry_no,entry_date,description,source_type,source_id,status,reference,created_by,posted_at
     )
     VALUES($1,$2,$3,$4,coalesce($5::date,CURRENT_DATE),$6,'payment',$7,'posted',$8,$9,now())
     ON CONFLICT(organisation_id,entry_no) DO NOTHING
     RETURNING *`,
    [
      payment.organisation_id,payment.shop_id,payment.branch_id||null,entryNo,
      payment.paid_at?String(payment.paid_at).slice(0,10):null,
      'Automatic journal for customer payment '+String(payment.reference||''),
      payment.id,payment.reference||null,actorId||null
    ]
  );
  let journal=inserted.rows[0];
  if(!journal){
    journal=(await db.query(
      'SELECT * FROM shop_finance_journal_entries WHERE organisation_id=$1 AND entry_no=$2 LIMIT 1',
      [payment.organisation_id,entryNo]
    )).rows[0];
    const hasLines=await db.query('SELECT 1 FROM shop_finance_journal_lines WHERE journal_entry_id=$1 LIMIT 1',[journal.id]);
    if(hasLines.rowCount)return journal;
  }

  if(settlementDebit>0){
    await db.query(
      `INSERT INTO shop_finance_journal_lines(journal_entry_id,account_id,description,debit,credit)
       VALUES($1,$2,$3,$4,0)`,
      [journal.id,settlementAcc.id,'Payment received via '+String(payment.method||'payment').replace(/_/g,' '),settlementDebit]
    );
  }
  if(fee>0&&feeAcc){
    await db.query(
      `INSERT INTO shop_finance_journal_lines(journal_entry_id,account_id,description,debit,credit)
       VALUES($1,$2,'Payment provider fee',$3,0)`,
      [journal.id,feeAcc.id,fee]
    );
  }
  await db.query(
    `INSERT INTO shop_finance_journal_lines(journal_entry_id,account_id,description,debit,credit)
     VALUES($1,$2,'Customer payment / sales receipt',0,$3)`,
    [journal.id,revenueAcc.id,amount]
  );
  return journal;
}

export async function postPaymentReversalFinanceJournal(db:Queryable,payment:any,reason:string,actorId?:string|null){
  if(!payment?.id)return null;
  const existing=await db.query(
    `SELECT id FROM shop_finance_journal_entries
     WHERE organisation_id=$1 AND source_type='payment_reversal' AND source_id=$2 AND status='posted'
     ORDER BY created_at LIMIT 1`,
    [payment.organisation_id,payment.id]
  );
  if(existing.rowCount)return existing.rows[0];

  const settlement=settlementAccount(String(payment.method||''));
  const settlementAcc=await ensureAccount(db,payment,settlement.code,settlement.name,'asset',settlement.subtype,settlement.cash);
  const revenueAcc=await ensureAccount(db,payment,'4000','Sales Revenue','income','sales_revenue',false);
  const amount=Math.max(0,Number(payment.amount||0));
  if(amount<=0)return null;
  const entryNo=('AUTO-REV-'+String(payment.id).replace(/-/g,'').slice(0,16)).toUpperCase();

  const journal=(await db.query(
    `INSERT INTO shop_finance_journal_entries(
       organisation_id,shop_id,branch_id,entry_no,entry_date,description,source_type,source_id,status,reference,created_by,posted_at
     )
     VALUES($1,$2,$3,$4,CURRENT_DATE,$5,'payment_reversal',$6,'posted',$7,$8,now())
     ON CONFLICT(organisation_id,entry_no) DO UPDATE SET description=EXCLUDED.description
     RETURNING *`,
    [
      payment.organisation_id,payment.shop_id,payment.branch_id||null,entryNo,
      'Automatic reversal of payment '+String(payment.reference||'')+': '+reason,
      payment.id,payment.reference||null,actorId||null
    ]
  )).rows[0];

  const hasLines=await db.query('SELECT 1 FROM shop_finance_journal_lines WHERE journal_entry_id=$1 LIMIT 1',[journal.id]);
  if(hasLines.rowCount)return journal;
  await db.query(
    `INSERT INTO shop_finance_journal_lines(journal_entry_id,account_id,description,debit,credit)
     VALUES
       ($1,$2,'Reverse customer payment',$3,0),
       ($1,$4,'Reverse settlement / cash',0,$3)`,
    [journal.id,revenueAcc.id,amount,settlementAcc.id]
  );
  return journal;
}
