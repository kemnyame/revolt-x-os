import {createHash} from 'node:crypto';
import {z} from 'zod';
import {schoolRecordId} from './record-id.js';

const error=(statusCode:number,message:string)=>Object.assign(Error(message),{statusCode});
const cents=(v:unknown)=>Math.round(Number(v)*100);
type Component={component_type:string;amount:number|string;posting_account_id:string|null;name:string};
export function payrollAccrualLines(run:any,components:Component[],fallbackExpense:string,payable:string){
  const grouped=new Map<string,{accountId:string;debit:number;credit:number;description:string}>();
  let earnings=0,deductions=0;
  for(const c of components){
    const value=cents(c.amount);if(!Number.isSafeInteger(value)||value<0)throw error(409,'Payroll contains an invalid component amount');
    if(!value)continue;
    const accountId=c.posting_account_id||(c.component_type==='earning'?fallbackExpense:null);
    if(!accountId)throw error(409,'Map '+c.name+' to its Finance GL before submitting payroll');
    const line=grouped.get(accountId)||{accountId,debit:0,credit:0,description:'Payroll components'};
    if(c.component_type==='earning'){line.debit+=value;earnings+=value}else{line.credit+=value;deductions+=value}
    grouped.set(accountId,line);
  }
  const net=earnings-deductions;
  if(earnings<=0||net<0||earnings!==cents(run.gross_total)||deductions!==cents(run.deductions_total)||net!==cents(run.net_total))throw error(409,'Payroll totals do not reconcile. Review staff earnings and deductions before submitting.');
  if(net){const line=grouped.get(payable)||{accountId:payable,debit:0,credit:0,description:'Net payroll payable'};line.credit+=net;grouped.set(payable,line)}
  return Array.from(grouped.values()).map(l=>{const balance=l.debit-l.credit;return{accountId:l.accountId,description:l.description,debit:balance>0?balance/100:0,credit:balance<0?-balance/100:0}}).filter(l=>l.debit||l.credit);
}

export async function ensurePayrollAccounts(db:any,org:string){
  await db.query(`INSERT INTO finance_accounts(organisation_id,code,name,account_type,subtype,is_cash_account,is_system)
    SELECT $1,v.code,v.name,v.kind,v.subtype,v.cash,true FROM (VALUES
      ('5000','Salaries & Wages','expense','staff_cost',false),('2050','Payroll Payable','liability','payroll_payable',false),
      ('1010','Bank','asset','bank',true),('2110','PAYE Payable','liability','payroll_tax',false),
      ('2120','Pension Contributions Payable','liability','payroll_pension',false),('1130','Staff Loans Receivable','asset','staff_loans',false)
    ) v(code,name,kind,subtype,cash) ON CONFLICT(organisation_id,code) DO NOTHING`,[org]);
  await db.query(`INSERT INTO payroll_account_settings(organisation_id,expense_account_id,payable_account_id,payment_account_id)
    SELECT $1,e.id,p.id,b.id FROM finance_accounts e JOIN finance_accounts p ON p.organisation_id=e.organisation_id AND p.code='2050'
    JOIN finance_accounts b ON b.organisation_id=e.organisation_id AND b.code='1010'
    WHERE e.organisation_id=$1 AND e.code='5000' ON CONFLICT(organisation_id) DO NOTHING`,[org]);
  await db.query(`INSERT INTO payroll_components(organisation_id,code,name,component_type,calculation_type,default_value,rate_percent,taxable,statutory)
    SELECT $1,v.code,v.name,v.kind,v.calculation,0,v.rate,v.taxable,v.statutory FROM (VALUES
      ('ALLOW','General Allowance','earning','fixed',0::numeric,true,false),('BONUS','Bonus','earning','fixed',0::numeric,true,false),
      ('PAYE','PAYE','deduction','fixed',0::numeric,false,true),('SSNIT','SSNIT / Pension','deduction','percent_basic',5.5::numeric,false,true),
      ('LOAN','Loan Deduction','deduction','fixed',0::numeric,false,false)
    ) v(code,name,kind,calculation,rate,taxable,statutory) ON CONFLICT(organisation_id,code) DO NOTHING`,[org]);
  return(await db.query('SELECT * FROM payroll_account_settings WHERE organisation_id=$1',[org])).rows[0];
}

export async function ensureComponentAccount(db:any,org:string,c:any){
  if(c.posting_account_id)return c.posting_account_id;
  const code=c.component_type==='earning'?'5000':({PAYE:'2110',SSNIT:'2120',LOAN:'1130'} as Record<string,string>)[c.code]||'PD-'+createHash('md5').update(c.code).digest('hex').slice(0,12);
  if(code.startsWith('PD-'))await db.query(`INSERT INTO finance_accounts(organisation_id,code,name,account_type,subtype,is_system)
    VALUES($1,$2,$3,'liability','payroll_deduction',true) ON CONFLICT(organisation_id,code) DO NOTHING`,[org,code,(c.name+' Payable').slice(0,180)]);
  const account=(await db.query('SELECT id FROM finance_accounts WHERE organisation_id=$1 AND code=$2',[org,code])).rows[0];
  if(!account)throw error(409,'Configure the payroll GL accounts first');
  await db.query('UPDATE payroll_components SET posting_account_id=$1 WHERE id=$2 AND organisation_id=$3 AND posting_account_id IS NULL',[account.id,c.id,org]);
  return account.id;
}

export async function assertPayrollAccount(db:any,org:string,id:string,kinds:string[],cash=false){
  const account=(await db.query('SELECT * FROM finance_accounts WHERE id=$1 AND organisation_id=$2 AND is_active=true',[id,org])).rows[0];
  if(!account||!kinds.includes(account.account_type)||(cash&&!account.is_cash_account))throw error(400,'Choose an active '+kinds.join(' or ')+(cash?' cash/bank':'')+' GL from this school');
  return account;
}

export async function registerPayrollWorkflow(app:any,d:any){
  const {db,config,authorize,one,tx,audit,requireRole,postFinanceJournal}=d;
  async function notify(client:any,a:any,event:string,run:any,capability:string,subject:string,body:string){
    await client.query(`INSERT INTO staff_notifications(organisation_id,recipient_os_user_id,event_key,subject,body,related_type,related_id,created_by_os_user_id)
      SELECT DISTINCT m.organisation_id,m.os_user_id,$2,$3,$4,'payroll_run',$5::uuid,$6::uuid FROM school_memberships m
      LEFT JOIN school_role_capabilities c ON c.organisation_id=m.organisation_id AND c.role=m.role AND c.capability_key=$7
      WHERE m.organisation_id=$1 AND m.status='active' AND (m.role='school_admin' OR c.allowed=true)
      ON CONFLICT DO NOTHING`,[a.core.organisation_id,event,subject,body,run.id,a.core.id,capability]);
  }
  const params=z.object({id:schoolRecordId});
  async function locked(client:any,a:any,id:string){return one(client,'SELECT * FROM payroll_runs WHERE id=$1 AND organisation_id=$2 FOR UPDATE',[id,a.core.organisation_id])}
  async function components(client:any,id:string,org:string){return(await client.query(`SELECT c.* FROM payroll_run_item_components c
    JOIN payroll_run_items i ON i.id=c.payroll_run_item_id WHERE i.payroll_run_id=$1 AND i.organisation_id=$2`,[id,org])).rows}
  async function ledgerLines(client:any,a:any,run:any){
    const settings=await ensurePayrollAccounts(client,a.core.organisation_id);
    const rows=await components(client,run.id,a.core.organisation_id);
    const lines=payrollAccrualLines(run,rows,settings.expense_account_id,run.payable_account_id||settings.payable_account_id);
    for(const line of lines)await assertPayrollAccount(client,a.core.organisation_id,line.accountId,line.debit?['expense']:['asset','liability']);
    return lines;
  }
  app.get('/api/payroll/posting-accounts',async(request:any)=>{
    const a=await authorize(request,db,config);await requireRole(a,'payroll.view');await ensurePayrollAccounts(db,a.core.organisation_id);
    return(await db.query('SELECT id,code,name,account_type,is_cash_account FROM finance_accounts WHERE organisation_id=$1 AND is_active=true ORDER BY code',[a.core.organisation_id])).rows;
  });
  app.get('/api/payroll/account-settings',async(request:any)=>{
    const a=await authorize(request,db,config);await requireRole(a,'payroll.view');
    return ensurePayrollAccounts(db,a.core.organisation_id);
  });
  app.put('/api/payroll/account-settings',async(request:any)=>{
    const a=await authorize(request,db,config);await requireRole(a,'payroll.process');
    const b=z.object({expenseAccountId:schoolRecordId,payableAccountId:schoolRecordId,paymentAccountId:schoolRecordId}).parse(request.body);
    await assertPayrollAccount(db,a.core.organisation_id,b.expenseAccountId,['expense']);await assertPayrollAccount(db,a.core.organisation_id,b.payableAccountId,['liability']);await assertPayrollAccount(db,a.core.organisation_id,b.paymentAccountId,['asset'],true);
    await ensurePayrollAccounts(db,a.core.organisation_id);
    const row=await one(db,`UPDATE payroll_account_settings SET expense_account_id=$1,payable_account_id=$2,payment_account_id=$3,updated_by_os_user_id=$4,updated_at=now() WHERE organisation_id=$5 RETURNING *`,[b.expenseAccountId,b.payableAccountId,b.paymentAccountId,a.core.id,a.core.organisation_id]);
    await audit(a.core.organisation_id,a.core.id,'payroll.gl_settings_updated','payroll_account_settings',null,b);return row;
  });
  app.post('/api/payroll/runs/:id/submit',async(request:any)=>{
    const a=await authorize(request,db,config);await requireRole(a,'payroll.manage');const {id}=params.parse(request.params);
    const row=await tx(db,async(client:any)=>{
      const run=await locked(client,a,id);if(run.status==='submitted_to_finance')return run;
      if(run.status!=='draft')throw error(409,'Only draft payroll can be submitted to Finance');
      await ledgerLines(client,a,run);
      const result=await one(client,`UPDATE payroll_runs SET status='submitted_to_finance',submitted_by_os_user_id=$1,submitted_at=now(),updated_at=now() WHERE id=$2 AND organisation_id=$3 RETURNING *`,[a.core.id,id,a.core.organisation_id]);
      await notify(client,a,'payroll.finance_review',result,'payroll.process','Payroll ready for Finance review',`HR submitted payroll for ${run.period_year}-${String(run.period_month).padStart(2,'0')}. Review the complete staff payment list, earnings, deductions and mapped GL accounts in Payroll. Net pay: ${run.currency} ${run.net_total}.`);
      return result;
    });await audit(a.core.organisation_id,a.core.id,'payroll.submitted_to_finance','payroll_run',id);return row;
  });
  app.post('/api/payroll/runs/:id/approve',async(request:any)=>{
    const a=await authorize(request,db,config);await requireRole(a,'payroll.process');const {id}=params.parse(request.params);
    const row=await tx(db,async(client:any)=>{
      const run=await locked(client,a,id);if(run.status==='approved_for_payment'||run.status==='paid')return run;
      if(run.status!=='submitted_to_finance')throw error(409,'HR must submit payroll before Finance approves it');
      const lines=await ledgerLines(client,a,run);
      const journal=await postFinanceJournal(client,{organisationId:a.core.organisation_id,actorOsUserId:a.core.id,description:`Payroll accrual ${run.period_year}-${String(run.period_month).padStart(2,'0')}`,sourceType:'payroll_accrual',sourceId:id,lines});
      return one(client,`UPDATE payroll_runs SET status='approved_for_payment',approved_by_os_user_id=$1,approved_at=now(),finance_journal_entry_id=$2,updated_at=now() WHERE id=$3 AND organisation_id=$4 RETURNING *`,[a.core.id,journal.id,id,a.core.organisation_id]);
    });await audit(a.core.organisation_id,a.core.id,'payroll.approved_for_payment','payroll_run',id,{journalEntryId:row.finance_journal_entry_id});return row;
  });
  app.post('/api/payroll/runs/:id/pay',async(request:any)=>{
    const a=await authorize(request,db,config);await requireRole(a,'payroll.process');const {id}=params.parse(request.params);
    const b=z.object({paymentAccountId:schoolRecordId.optional(),paymentDate:z.string().date().optional(),reference:z.string().trim().min(3).max(160).optional()}).parse(request.body||{});
    const row=await tx(db,async(client:any)=>{
      const run=await locked(client,a,id);if(run.status==='paid')return run;
      if(run.status!=='approved_for_payment')throw error(409,'Finance must approve this payroll before recording payment');
      const settings=await ensurePayrollAccounts(client,a.core.organisation_id),accountId=b.paymentAccountId||settings.payment_account_id,payable=run.payable_account_id||settings.payable_account_id;
      await assertPayrollAccount(client,a.core.organisation_id,accountId,['asset'],true);await assertPayrollAccount(client,a.core.organisation_id,payable,['liability']);
      const reference=b.reference||'PAYROLL-'+run.period_year+'-'+String(run.period_month).padStart(2,'0');
      const journal=Number(run.net_total)>0?await postFinanceJournal(client,{organisationId:a.core.organisation_id,actorOsUserId:a.core.id,entryDate:b.paymentDate,description:`Payroll payment ${run.period_year}-${String(run.period_month).padStart(2,'0')}`,sourceType:'payroll_payment',sourceId:id,reference,lines:[{accountId:payable,debit:Number(run.net_total),description:'Settle net salaries payable'},{accountId,credit:Number(run.net_total),description:'Staff salary payment batch'}]}):null;
      const result=await one(client,`UPDATE payroll_runs SET status='paid',paid_by_os_user_id=$1,paid_at=now(),payment_journal_entry_id=$2,payment_reference=$3,payment_date=COALESCE($4::date,current_date),updated_at=now() WHERE id=$5 AND organisation_id=$6 RETURNING *`,[a.core.id,journal?.id??null,reference,b.paymentDate??null,id,a.core.organisation_id]);
      await notify(client,a,'payroll.ready_to_publish',result,'payroll.publish','Paid payroll awaiting HR publication',`Finance recorded payment for ${run.period_year}-${String(run.period_month).padStart(2,'0')}. Reference: ${reference}. Review and publish the payslips to staff.`);return result;
    });await audit(a.core.organisation_id,a.core.id,'payroll.paid','payroll_run',id,{reference:row.payment_reference,journalEntryId:row.payment_journal_entry_id});return row;
  });
  app.post('/api/payroll/runs/:id/publish',async(request:any)=>{
    const a=await authorize(request,db,config);await requireRole(a,'payroll.publish');const {id}=params.parse(request.params);
    const row=await tx(db,async(client:any)=>{
      const run=await locked(client,a,id);if(run.status!=='paid')throw error(409,'Finance must record payment before HR can publish payslips');if(run.published_at)return run;
      const result=await one(client,'UPDATE payroll_runs SET published_at=now(),published_by_os_user_id=$1,updated_at=now() WHERE id=$2 AND organisation_id=$3 RETURNING *',[a.core.id,id,a.core.organisation_id]);
      await client.query(`INSERT INTO staff_notifications(organisation_id,recipient_os_user_id,event_key,subject,body,related_type,related_id,created_by_os_user_id)
        SELECT organisation_id,os_user_id,'payroll.payslip_published','Your payslip is available',$3,'payroll_run',$1::uuid,$4::uuid FROM payroll_run_items
        WHERE payroll_run_id=$1 AND organisation_id=$2 ON CONFLICT DO NOTHING`,[id,a.core.organisation_id,`Your payslip for ${run.period_year}-${String(run.period_month).padStart(2,'0')} is available in My Payroll.`,a.core.id]);return result;
    });await audit(a.core.organisation_id,a.core.id,'payroll.published','payroll_run',id);return row;
  });
}
