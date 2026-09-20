import type { FastifyInstance } from 'fastify';
import { z } from 'zod';

type Deps={
  db:any;
  config:any;
  authorize:(request:any,db:any,config:any,capability?:string)=>Promise<any>;
  one:<T=any>(db:any,sql:string,params?:any[])=>Promise<T>;
  maybeOne:<T=any>(db:any,sql:string,params?:any[])=>Promise<T|undefined>;
  tx:(db:any,fn:(client:any)=>Promise<any>)=>Promise<any>;
  fail:(status:number,message:string)=>any;
  audit:(organisationId:string,userId:string,action:string,resourceType:string,resourceId?:string|null,metadata?:any)=>Promise<void>;
  postFinanceJournal:(client:any,input:any)=>Promise<any>;
  updateStudentFeeStatus:(client:any,studentFeeId:string)=>Promise<any>;
  reverseFinanceJournal:(client:any,organisationId:string,originalId:string,actorOsUserId:string,reason:string,sourceType:string,sourceId:string)=>Promise<any>;
};

export async function registerAccountingRoutes(app:FastifyInstance,d:Deps){
  const {db,config,authorize,one,maybeOne,tx,fail,audit,postFinanceJournal,updateStudentFeeStatus,reverseFinanceJournal}=d;

  async function assertAccount(client:any,organisationId:string,id:string,type?:string){
    const params:any[]=[id,organisationId];
    let sql='SELECT * FROM finance_accounts WHERE id=$1 AND organisation_id=$2 AND is_active=true';
    if(type){params.push(type);sql+=' AND account_type=$3'}
    const row=await maybeOne<any>(client,sql,params);
    if(!row)throw fail(400,type?('Select an active '+type+' GL account'):'Select an active finance account');
    return row;
  }

  async function nextPaymentReference(client:any,organisationId:string,method:any,admissionNo:string){
    const prefix=String(method.label||method.method_key||'PY').replace(/[^A-Za-z]/g,'').slice(0,2).toUpperCase().padEnd(2,'X');
    const key='student_receipt:'+String(method.method_key||prefix);
    const counter=await one<any>(client,`
      INSERT INTO finance_reference_counters(organisation_id,reference_key,next_number)
      VALUES($1,$2,1)
      ON CONFLICT(organisation_id,reference_key)
      DO UPDATE SET next_number=finance_reference_counters.next_number+1,updated_at=now()
      RETURNING next_number
    `,[organisationId,key]);
    const studentCode=String(admissionNo||'STUDENT').replace(/[^A-Za-z0-9]/g,'').toUpperCase();
    return prefix+'-'+studentCode+'-'+String(counter.next_number).padStart(4,'0');
  }


  async function buildEodReports(client:any,organisationId:string,businessDate:string){
    const yearStart=businessDate.slice(0,4)+'-01-01';
    const [trial,income,cash,balance,aging,fees,expenses,taxes,budgets,ledger,students,integrity]=await Promise.all([
      client.query(\`
        SELECT fa.code,fa.name,fa.account_type,
          COALESCE(sum(CASE WHEN je.id IS NOT NULL THEN jl.debit ELSE 0 END),0) debit,
          COALESCE(sum(CASE WHEN je.id IS NOT NULL THEN jl.credit ELSE 0 END),0) credit
        FROM finance_accounts fa
        LEFT JOIN finance_journal_lines jl ON jl.account_id=fa.id
        LEFT JOIN finance_journal_entries je ON je.id=jl.journal_entry_id AND je.status='posted' AND je.entry_date<=$2
        WHERE fa.organisation_id=$1 GROUP BY fa.id ORDER BY fa.code
      \`,[organisationId,businessDate]),
      client.query(\`
        SELECT fa.code,fa.name,fa.account_type,
          CASE WHEN fa.account_type='income'
            THEN COALESCE(sum(CASE WHEN je.id IS NOT NULL THEN jl.credit-jl.debit ELSE 0 END),0)
            ELSE COALESCE(sum(CASE WHEN je.id IS NOT NULL THEN jl.debit-jl.credit ELSE 0 END),0) END amount
        FROM finance_accounts fa
        LEFT JOIN finance_journal_lines jl ON jl.account_id=fa.id
        LEFT JOIN finance_journal_entries je ON je.id=jl.journal_entry_id AND je.status='posted' AND je.entry_date BETWEEN $2 AND $3
        WHERE fa.organisation_id=$1 AND fa.account_type IN('income','expense')
        GROUP BY fa.id ORDER BY fa.account_type DESC,fa.code
      \`,[organisationId,yearStart,businessDate]),
      client.query(\`
        SELECT fa.code,fa.name,fa.opening_balance,
          COALESCE(sum(CASE WHEN je.id IS NOT NULL THEN jl.debit-jl.credit ELSE 0 END),0) movement,
          fa.opening_balance+COALESCE(sum(CASE WHEN je.id IS NOT NULL THEN jl.debit-jl.credit ELSE 0 END),0) closing_balance
        FROM finance_accounts fa
        LEFT JOIN finance_journal_lines jl ON jl.account_id=fa.id
        LEFT JOIN finance_journal_entries je ON je.id=jl.journal_entry_id AND je.status='posted' AND je.entry_date<=$2
        WHERE fa.organisation_id=$1 AND fa.is_cash_account=true
        GROUP BY fa.id ORDER BY fa.code
      \`,[organisationId,businessDate]),
      client.query(\`
        SELECT fa.code,fa.name,fa.account_type,fa.opening_balance,
          CASE WHEN fa.account_type='asset'
            THEN fa.opening_balance+COALESCE(sum(CASE WHEN je.id IS NOT NULL THEN jl.debit-jl.credit ELSE 0 END),0)
            ELSE fa.opening_balance+COALESCE(sum(CASE WHEN je.id IS NOT NULL THEN jl.credit-jl.debit ELSE 0 END),0) END balance
        FROM finance_accounts fa
        LEFT JOIN finance_journal_lines jl ON jl.account_id=fa.id
        LEFT JOIN finance_journal_entries je ON je.id=jl.journal_entry_id AND je.status='posted' AND je.entry_date<=$2
        WHERE fa.organisation_id=$1 AND fa.account_type IN('asset','liability','equity')
        GROUP BY fa.id ORDER BY fa.account_type,fa.code
      \`,[organisationId,businessDate]),
      client.query(\`
        SELECT s.id student_id,s.admission_no,s.first_name,s.last_name,
          COALESCE(sum((sf.amount_due-sf.discount)-COALESCE(p.paid,0)),0) outstanding
        FROM students s
        LEFT JOIN student_fees sf ON sf.student_id=s.id
        LEFT JOIN (SELECT student_fee_id,sum(amount) FILTER(WHERE voided_at IS NULL) paid FROM payments GROUP BY student_fee_id) p ON p.student_fee_id=sf.id
        WHERE s.organisation_id=$1
        GROUP BY s.id HAVING COALESCE(sum((sf.amount_due-sf.discount)-COALESCE(p.paid,0)),0)>0
        ORDER BY outstanding DESC
      \`,[organisationId]),
      client.query(\`
        SELECT p.payment_method,count(*)::int transactions,COALESCE(sum(p.amount),0) amount
        FROM payments p
        WHERE p.organisation_id=$1 AND p.voided_at IS NULL AND p.paid_at::date=$2
        GROUP BY p.payment_method ORDER BY amount DESC
      \`,[organisationId,businessDate]),
      client.query(\`
        SELECT fa.code,fa.name,COALESCE(sum(e.amount+e.tax_amount),0) amount,count(e.id)::int transactions
        FROM finance_accounts fa
        LEFT JOIN finance_expenses e ON e.expense_account_id=fa.id AND e.status='posted' AND e.expense_date=$2
        WHERE fa.organisation_id=$1 AND fa.account_type='expense'
        GROUP BY fa.id HAVING count(e.id)>0 ORDER BY amount DESC
      \`,[organisationId,businessDate]),
      client.query(\`
        SELECT t.code,t.name,t.authority,COALESCE(sum(o.amount_due),0) amount_due,COALESCE(sum(o.amount_paid),0) amount_paid,
          COALESCE(sum(o.amount_due-o.amount_paid),0) outstanding
        FROM finance_tax_types t LEFT JOIN finance_tax_obligations o ON o.tax_type_id=t.id AND o.status<>'cancelled'
        WHERE t.organisation_id=$1 GROUP BY t.id ORDER BY t.code
      \`,[organisationId]),
      client.query(\`
        SELECT b.id,fa.code,fa.name,fa.account_type,b.period_start,b.period_end,b.amount budget_amount,
          CASE WHEN fa.account_type='income'
            THEN COALESCE(sum(CASE WHEN je.id IS NOT NULL THEN jl.credit-jl.debit ELSE 0 END),0)
            ELSE COALESCE(sum(CASE WHEN je.id IS NOT NULL THEN jl.debit-jl.credit ELSE 0 END),0) END actual_amount
        FROM finance_budgets b JOIN finance_accounts fa ON fa.id=b.account_id
        LEFT JOIN finance_journal_lines jl ON jl.account_id=fa.id
        LEFT JOIN finance_journal_entries je ON je.id=jl.journal_entry_id AND je.status='posted'
          AND je.entry_date BETWEEN b.period_start AND LEAST(b.period_end,$2::date)
        WHERE b.organisation_id=$1 AND b.period_start<=$2::date AND b.period_end>=$2::date
        GROUP BY b.id,fa.id ORDER BY fa.code
      \`,[organisationId,businessDate]),
      client.query(\`
        SELECT je.entry_date,je.entry_no,je.description,je.reference,fa.code account_code,fa.name account_name,
          jl.description line_description,jl.debit,jl.credit
        FROM finance_journal_entries je
        JOIN finance_journal_lines jl ON jl.journal_entry_id=je.id
        JOIN finance_accounts fa ON fa.id=jl.account_id
        WHERE je.organisation_id=$1 AND je.status='posted' AND je.entry_date=$2
        ORDER BY je.entry_no,fa.code
      \`,[organisationId,businessDate]),
      client.query(\`
        WITH student_base AS (
          SELECT s.id,s.admission_no,s.first_name,s.last_name,
            COALESCE((SELECT sum(sf.amount_due-sf.discount) FROM student_fees sf
              WHERE sf.student_id=s.id AND sf.created_at::date<$2),0)
            -COALESCE((SELECT sum(p.amount) FROM payments p
              WHERE p.student_id=s.id AND p.voided_at IS NULL AND p.source<>'credit_applied' AND p.student_fee_id IS NOT NULL AND p.paid_at::date<$2),0)
            -COALESCE((SELECT sum(c.original_amount) FROM student_account_credits c
              WHERE c.student_id=s.id AND c.status<>'voided' AND c.created_at::date<$2),0) opening_balance,
            COALESCE((SELECT sum(sf.amount_due-sf.discount) FROM student_fees sf
              WHERE sf.student_id=s.id AND sf.created_at::date<=$2),0)
            -COALESCE((SELECT sum(p.amount) FROM payments p
              WHERE p.student_id=s.id AND p.voided_at IS NULL AND p.source<>'credit_applied' AND p.student_fee_id IS NOT NULL AND p.paid_at::date<=$2),0)
            -COALESCE((SELECT sum(c.original_amount) FROM student_account_credits c
              WHERE c.student_id=s.id AND c.status<>'voided' AND c.created_at::date<=$2),0) closing_balance
          FROM students s WHERE s.organisation_id=$1
        )
        SELECT *,closing_balance-opening_balance movement
        FROM student_base
        ORDER BY admission_no
      \`,[organisationId,businessDate]),
      client.query(\`
        SELECT
          (SELECT count(*) FROM (
            SELECT je.id FROM finance_journal_entries je
            JOIN finance_journal_lines jl ON jl.journal_entry_id=je.id
            WHERE je.organisation_id=$1 AND je.status='posted' AND je.entry_date<=$2
            GROUP BY je.id HAVING abs(sum(jl.debit)-sum(jl.credit))>0.005
          ) x)::int unbalanced_journals,
          (SELECT count(*)::int FROM fee_items f
            WHERE f.organisation_id=$1 AND f.income_account_id IS NULL) fee_items_without_income_gl,
          (SELECT count(*)::int FROM student_fees sf
            WHERE sf.organisation_id=$1 AND sf.created_at::date<=$2 AND NOT EXISTS(
              SELECT 1 FROM finance_journal_entries je
              WHERE je.organisation_id=sf.organisation_id AND je.source_type='student_fee' AND je.source_id=sf.id AND je.status='posted'
            )) fees_without_receivable_journal,
          (SELECT count(*)::int FROM payments p
            WHERE p.organisation_id=$1 AND p.voided_at IS NULL AND p.paid_at::date<=$2
              AND p.finance_receipt_id IS NULL AND p.source<>'credit_applied' AND NOT EXISTS(
                SELECT 1 FROM finance_journal_entries je
                WHERE je.organisation_id=p.organisation_id AND je.source_type='student_payment' AND je.source_id=p.id AND je.status='posted'
              )) payments_without_journal
      \`,[organisationId,businessDate])
    ]);

    const totalDebit=trial.rows.reduce((s:number,x:any)=>s+Number(x.debit||0),0);
    const totalCredit=trial.rows.reduce((s:number,x:any)=>s+Number(x.credit||0),0);
    const incomeTotal=income.rows.filter((x:any)=>x.account_type==='income').reduce((s:number,x:any)=>s+Number(x.amount||0),0);
    const expenseTotal=income.rows.filter((x:any)=>x.account_type==='expense').reduce((s:number,x:any)=>s+Number(x.amount||0),0);
    const integrityRow=integrity.rows[0]||{};
    const issues=Object.values(integrityRow).reduce((s:number,v:any)=>s+Number(v||0),0)+(Math.abs(totalDebit-totalCredit)>0.005?1:0);

    return{
      reports:{
        'trial-balance':{name:'Trial Balance',payload:{asOf:businessDate,rows:trial.rows,totalDebit,totalCredit}},
        'income-statement':{name:'Income Statement',payload:{period:{start:yearStart,end:businessDate},rows:income.rows,income:incomeTotal,expenses:expenseTotal,surplus:incomeTotal-expenseTotal}},
        'cashflow':{name:'Cash & Bank Movement',payload:{asOf:businessDate,rows:cash.rows}},
        'balance-sheet':{name:'Balance Sheet',payload:{asOf:businessDate,rows:balance.rows}},
        'receivables-aging':{name:'Receivables / Outstanding Fees',payload:{asOf:businessDate,rows:aging.rows,total:aging.rows.reduce((s:number,x:any)=>s+Number(x.outstanding||0),0)}},
        'fee-collections':{name:'Fee Collections',payload:{date:businessDate,rows:fees.rows,total:fees.rows.reduce((s:number,x:any)=>s+Number(x.amount||0),0)}},
        'expense-analysis':{name:'Expense Analysis',payload:{date:businessDate,rows:expenses.rows,total:expenses.rows.reduce((s:number,x:any)=>s+Number(x.amount||0),0)}},
        'tax-summary':{name:'Tax Summary',payload:{asOf:businessDate,rows:taxes.rows}},
        'budget-variance':{name:'Budget Variance',payload:{asOf:businessDate,rows:budgets.rows.map((x:any)=>({...x,variance:Number(x.actual_amount)-Number(x.budget_amount)}))}},
        'general-ledger':{name:'Daily General Ledger',payload:{date:businessDate,rows:ledger.rows,totalDebit:ledger.rows.reduce((s:number,x:any)=>s+Number(x.debit||0),0),totalCredit:ledger.rows.reduce((s:number,x:any)=>s+Number(x.credit||0),0)}},
        'student-opening-closing':{name:'Student Account Opening & Closing Balances',payload:{date:businessDate,rows:students.rows,totalOpening:students.rows.reduce((s:number,x:any)=>s+Number(x.opening_balance||0),0),totalClosing:students.rows.reduce((s:number,x:any)=>s+Number(x.closing_balance||0),0)}},
        'accounting-integrity':{name:'Accounting Integrity Check',payload:{date:businessDate,...integrityRow,trialBalanceDifference:totalDebit-totalCredit,issues}}
      },
      totalDebit,totalCredit,issues,integrity:integrityRow,
      summary:{income:incomeTotal,expenses:expenseTotal,surplus:incomeTotal-expenseTotal,collections:fees.rows.reduce((s:number,x:any)=>s+Number(x.amount||0),0),studentClosingBalance:students.rows.reduce((s:number,x:any)=>s+Number(x.closing_balance||0),0)}
    };
  }

  async function runEndOfDay(organisationId:string,businessDate:string,actorOsUserId:string|null){
    return tx(db,async(client:any)=>{
      let run=await maybeOne<any>(client,'SELECT * FROM finance_eod_runs WHERE organisation_id=$1 AND business_date=$2 FOR UPDATE',[organisationId,businessDate]);
      if(run?.status==='completed'||run?.status==='completed_with_warnings')return run;
      if(!run){
        run=await one<any>(client,\`
          INSERT INTO finance_eod_runs(organisation_id,business_date,status,run_by_os_user_id)
          VALUES($1,$2,'running',$3) RETURNING *
        \`,[organisationId,businessDate,actorOsUserId]);
      }else{
        run=await one<any>(client,\`
          UPDATE finance_eod_runs SET status='running',started_at=now(),completed_at=NULL,error_message=NULL,run_by_os_user_id=$1
          WHERE id=$2 RETURNING *
        \`,[actorOsUserId,run.id]);
      }
      try{
        const built=await buildEodReports(client,organisationId,businessDate);
        await client.query('DELETE FROM finance_eod_reports WHERE eod_run_id=$1',[run.id]);
        for(const [key,value] of Object.entries(built.reports) as any){
          await client.query(\`
            INSERT INTO finance_eod_reports(eod_run_id,organisation_id,business_date,report_key,report_name,payload)
            VALUES($1,$2,$3,$4,$5,$6)
          \`,[run.id,organisationId,businessDate,key,value.name,JSON.stringify(value.payload)]);
        }
        return one<any>(client,\`
          UPDATE finance_eod_runs SET status=$1,completed_at=now(),total_debit=$2,total_credit=$3,issue_count=$4,summary=$5
          WHERE id=$6 RETURNING *
        \`,[built.issues?'completed_with_warnings':'completed',built.totalDebit,built.totalCredit,built.issues,JSON.stringify(built.summary),run.id]);
      }catch(error:any){
        await client.query(\`UPDATE finance_eod_runs SET status='failed',completed_at=now(),error_message=$1 WHERE id=$2\`,[String(error?.message||error),run.id]);
        throw error;
      }
    });
  }

  app.get('/api/accounting/end-of-day',async request=>{
    const a=await authorize(request,db,config,'finance.report');
    return (await db.query(\`
      SELECT * FROM finance_eod_runs WHERE organisation_id=$1 ORDER BY business_date DESC LIMIT 90
    \`,[a.core.organisation_id])).rows;
  });

  app.post('/api/accounting/end-of-day/run',async request=>{
    const a=await authorize(request,db,config,'finance.eod.run');
    const b=z.object({businessDate:z.string().date().optional()}).parse(request.body??{});
    const businessDate=b.businessDate??new Date().toISOString().slice(0,10);
    const run=await runEndOfDay(a.core.organisation_id,businessDate,a.core.id);
    await audit(a.core.organisation_id,a.core.id,'finance.eod.completed','finance_eod_run',run.id,{businessDate,status:run.status,issueCount:run.issue_count});
    return run;
  });

  app.get('/api/accounting/end-of-day/:id',async request=>{
    const a=await authorize(request,db,config,'finance.report');
    const {id}=z.object({id:z.string().uuid()}).parse(request.params);
    const run=await one<any>(db,'SELECT * FROM finance_eod_runs WHERE id=$1 AND organisation_id=$2',[id,a.core.organisation_id]);
    const reports=(await db.query(\`
      SELECT id,report_key,report_name,payload,created_at FROM finance_eod_reports WHERE eod_run_id=$1 ORDER BY report_name
    \`,[id])).rows;
    return{run,reports};
  });

  // Automatic catch-up: if the service wakes after midnight, close the previous day once.
  const autoEod=async()=>{
    try{
      const yesterday=new Date(Date.now()-86400000).toISOString().slice(0,10);
      const orgs=(await db.query('SELECT organisation_id FROM school_profiles')).rows;
      for(const org of orgs){
        const existing=await maybeOne<any>(db,'SELECT id FROM finance_eod_runs WHERE organisation_id=$1 AND business_date=$2 AND status IN(\\'completed\\',\\'completed_with_warnings\\')',[org.organisation_id,yesterday]);
        if(!existing)await runEndOfDay(org.organisation_id,yesterday,null);
      }
    }catch(error){console.warn('Automatic School finance EOD failed',error)}
  };
  setTimeout(autoEod,8000).unref?.();
  setInterval(autoEod,60*60*1000).unref?.();

  app.get('/api/accounting/reversals',async request=>{
    const a=await authorize(request,db,config,'finance.reverse');
    const q=z.object({limit:z.coerce.number().int().min(1).max(250).default(100)}).parse(request.query);
    const receipts=(await db.query(`
      SELECT r.id,r.receipt_no,r.reference,r.amount,r.paid_at,r.status,r.reversed_at,r.reversal_reason,
             s.admission_no,s.first_name,s.last_name,pm.label payment_method_label,je.entry_no,
             CASE WHEN EXISTS(
               SELECT 1 FROM student_account_credits c
               WHERE c.source_receipt_id=r.id AND c.balance<c.original_amount
             ) THEN true ELSE false END credit_already_used
      FROM finance_student_receipts r
      JOIN students s ON s.id=r.student_id
      JOIN finance_payment_methods pm ON pm.id=r.payment_method_id
      LEFT JOIN finance_journal_entries je ON je.id=r.journal_entry_id
      WHERE r.organisation_id=$1
      ORDER BY r.paid_at DESC,r.created_at DESC
      LIMIT $2
    `,[a.core.organisation_id,q.limit])).rows;
    const expenses=(await db.query(`
      SELECT e.id,e.expense_no,e.expense_date,e.amount,e.tax_amount,e.description,e.reference,e.status,
             v.name vendor_name,je.entry_no,je.reversed_at
      FROM finance_expenses e
      LEFT JOIN finance_vendors v ON v.id=e.vendor_id
      LEFT JOIN finance_journal_entries je ON je.id=e.journal_entry_id
      WHERE e.organisation_id=$1
      ORDER BY e.expense_date DESC,e.created_at DESC
      LIMIT $2
    `,[a.core.organisation_id,q.limit])).rows;
    const payments=(await db.query(`
      SELECT p.id,p.amount,p.payment_method,p.reference,p.paid_at,p.voided_at,p.void_reason,
             s.admission_no,s.first_name,s.last_name,f.name fee_name
      FROM payments p
      JOIN students s ON s.id=p.student_id
      LEFT JOIN student_fees sf ON sf.id=p.student_fee_id
      LEFT JOIN fee_items f ON f.id=sf.fee_item_id
      WHERE p.organisation_id=$1 AND p.finance_receipt_id IS NULL
      ORDER BY p.paid_at DESC,p.id DESC
      LIMIT $2
    `,[a.core.organisation_id,q.limit])).rows;
    const history=(await db.query(`
      SELECT je.id,je.entry_no,je.entry_date,je.description,je.reference,je.source_type,je.reversed_at,
             rev.entry_no reversal_entry_no
      FROM finance_journal_entries je
      LEFT JOIN finance_journal_entries rev ON rev.id=je.reversal_entry_id
      WHERE je.organisation_id=$1 AND je.reversed_at IS NOT NULL
      ORDER BY je.reversed_at DESC
      LIMIT $2
    `,[a.core.organisation_id,q.limit])).rows;
    return{receipts,expenses,payments,history};
  });

  app.post('/api/accounting/receipts/:id/reverse',async request=>{
    const a=await authorize(request,db,config,'finance.reverse');
    const {id}=z.object({id:z.string().uuid()}).parse(request.params);
    const b=z.object({originalReference:z.string().trim().min(2).max(160),reason:z.string().trim().min(3).max(1200)}).parse(request.body);
    const result=await tx(db,async(client:any)=>{
      const receipt=await one<any>(client,`
        SELECT * FROM finance_student_receipts
        WHERE id=$1 AND organisation_id=$2 FOR UPDATE
      `,[id,a.core.organisation_id]);
      if(receipt.status==='voided')throw fail(409,'This receipt has already been reversed');
      const expected=String(receipt.reference||receipt.receipt_no||'').trim().toLowerCase();
      if(String(b.originalReference).trim().toLowerCase()!==expected)throw fail(409,'Original transaction reference does not match this receipt');

      const credits=(await client.query(`
        SELECT * FROM student_account_credits
        WHERE source_receipt_id=$1 FOR UPDATE
      `,[id])).rows;
      const usedCredit=credits.find((x:any)=>Number(x.balance)+0.005<Number(x.original_amount));
      if(usedCredit)throw fail(409,'This receipt cannot be reversed because part of its advance credit has already been applied to a later fee');

      const payments=(await client.query(`
        SELECT * FROM payments
        WHERE finance_receipt_id=$1 AND voided_at IS NULL
        FOR UPDATE
      `,[id])).rows;
      const feeIds=[...new Set(payments.map((x:any)=>x.student_fee_id).filter(Boolean))] as string[];

      await client.query(`
        UPDATE payments
        SET voided_at=now(),voided_by_os_user_id=$1,void_reason=$2
        WHERE finance_receipt_id=$3 AND voided_at IS NULL
      `,[a.core.id,b.reason,id]);

      for(const feeId of feeIds)await updateStudentFeeStatus(client,feeId);

      if(credits.length){
        await client.query(`
          UPDATE student_account_credits
          SET balance=0,status='voided',updated_at=now()
          WHERE source_receipt_id=$1
        `,[id]);
      }

      let reversal:any=null;
      if(receipt.journal_entry_id){
        reversal=await reverseFinanceJournal(
          client,a.core.organisation_id,receipt.journal_entry_id,a.core.id,b.reason,'student_receipt_reversal',receipt.id
        );
      }

      const updated=await one<any>(client,`
        UPDATE finance_student_receipts
        SET status='voided',reversed_at=now(),reversed_by_os_user_id=$1,reversal_reason=$2,reversal_entry_id=$3
        WHERE id=$4 RETURNING *
      `,[a.core.id,b.reason,reversal?.id??null,id]);

      return{receipt:updated,reversal,voidedPayments:payments.length};
    });
    await audit(a.core.organisation_id,a.core.id,'finance.student_receipt.reversed','finance_student_receipt',id,{
      reason:b.reason,originalReference:b.originalReference,voidedPayments:result.voidedPayments,reversalEntryId:result.reversal?.id??null
    });
    return result;
  });

  app.get('/api/accounting/payment-methods',async request=>{
    const a=await authorize(request,db,config,'finance.view');
    return (await db.query(`
      SELECT pm.*,fa.code settlement_account_code,fa.name settlement_account_name,fa.account_type settlement_account_type
      FROM finance_payment_methods pm
      JOIN finance_accounts fa ON fa.id=pm.settlement_account_id
      WHERE pm.organisation_id=$1
      ORDER BY CASE pm.method_key WHEN 'cash' THEN 1 WHEN 'bank' THEN 2 WHEN 'mobile_money' THEN 3 WHEN 'card' THEN 4 ELSE 5 END,pm.label
    `,[a.core.organisation_id])).rows;
  });

  app.patch('/api/accounting/payment-methods/:id',async request=>{
    const a=await authorize(request,db,config,'finance.payment_setup');
    const {id}=z.object({id:z.string().uuid()}).parse(request.params);
    const b=z.object({
      label:z.string().trim().min(2).max(120).optional(),
      settlementAccountId:z.string().uuid().optional(),
      provider:z.string().trim().max(60).nullable().optional(),
      enabled:z.boolean().optional(),
      allowManualReceipt:z.boolean().optional()
    }).refine(v=>Object.keys(v).length>0).parse(request.body);
    if(b.settlementAccountId)await assertAccount(db,a.core.organisation_id,b.settlementAccountId,'asset');
    const row=await one<any>(db,`
      UPDATE finance_payment_methods
      SET label=COALESCE($1,label),
          settlement_account_id=COALESCE($2::uuid,settlement_account_id),
          provider=CASE WHEN $3 THEN $4 ELSE provider END,
          enabled=COALESCE($5,enabled),
          allow_manual_receipt=COALESCE($6,allow_manual_receipt),
          updated_at=now()
      WHERE id=$7 AND organisation_id=$8
      RETURNING *
    `,[
      b.label??null,b.settlementAccountId??null,Object.hasOwn(b,'provider'),b.provider??null,
      b.enabled??null,b.allowManualReceipt??null,id,a.core.organisation_id
    ]);
    await audit(a.core.organisation_id,a.core.id,'finance.payment_method.updated','finance_payment_method',id,{methodKey:row.method_key});
    return row;
  });

  app.get('/api/accounting/income-gl',async request=>{
    const a=await authorize(request,db,config,'finance.view');
    return (await db.query("SELECT * FROM finance_accounts WHERE organisation_id=$1 AND account_type='income' ORDER BY code",[a.core.organisation_id])).rows;
  });

  app.get('/api/accounting/expense-gl',async request=>{
    const a=await authorize(request,db,config,'finance.view');
    return (await db.query("SELECT * FROM finance_accounts WHERE organisation_id=$1 AND account_type='expense' ORDER BY code",[a.core.organisation_id])).rows;
  });

  app.post('/api/accounting/expense-gl',async(request,reply)=>{
    const a=await authorize(request,db,config,'finance.manage');
    const b=z.object({code:z.string().trim().min(1).max(30),name:z.string().trim().min(2).max(180),subtype:z.string().trim().max(60).optional()}).parse(request.body);
    const row=await one<any>(db,`
      INSERT INTO finance_accounts(organisation_id,code,name,account_type,subtype,is_cash_account,is_system)
      VALUES($1,$2,$3,'expense',$4,false,false) RETURNING *
    `,[a.core.organisation_id,b.code.toUpperCase(),b.name,b.subtype??'operating_expense']);
    await audit(a.core.organisation_id,a.core.id,'finance.expense_gl.created','finance_account',row.id,{code:row.code});
    return reply.code(201).send(row);
  });

  app.post('/api/accounting/income-gl',async(request,reply)=>{
    const a=await authorize(request,db,config,'finance.manage');
    const b=z.object({code:z.string().trim().min(1).max(30),name:z.string().trim().min(2).max(180),subtype:z.string().trim().max(60).optional()}).parse(request.body);
    const row=await one<any>(db,`
      INSERT INTO finance_accounts(organisation_id,code,name,account_type,subtype,is_cash_account,is_system)
      VALUES($1,$2,$3,'income',$4,false,false) RETURNING *
    `,[a.core.organisation_id,b.code.toUpperCase(),b.name,b.subtype??'school_income']);
    await audit(a.core.organisation_id,a.core.id,'finance.income_gl.created','finance_account',row.id,{code:row.code});
    return reply.code(201).send(row);
  });

  app.get('/api/accounting/fee-setup',async request=>{
    const a=await authorize(request,db,config,'finance.view');
    return (await db.query(`
      SELECT f.*,y.name academic_year,t.name term_name,g.name grade_name,
             ia.code income_account_code,ia.name income_account_name
      FROM fee_items f
      JOIN academic_years y ON y.id=f.academic_year_id
      LEFT JOIN terms t ON t.id=f.term_id
      LEFT JOIN grade_levels g ON g.id=f.grade_level_id
      LEFT JOIN finance_accounts ia ON ia.id=f.income_account_id
      WHERE f.organisation_id=$1
      ORDER BY y.start_date DESC,t.start_date DESC NULLS LAST,g.level_order NULLS LAST,f.name
    `,[a.core.organisation_id])).rows;
  });

  app.patch('/api/accounting/fee-setup/:id',async request=>{
    const a=await authorize(request,db,config,'finance.payment_setup');
    const {id}=z.object({id:z.string().uuid()}).parse(request.params);
    const b=z.object({incomeAccountId:z.string().uuid()}).parse(request.body);
    await assertAccount(db,a.core.organisation_id,b.incomeAccountId,'income');
    const row=await one<any>(db,'UPDATE fee_items SET income_account_id=$1 WHERE id=$2 AND organisation_id=$3 RETURNING *',
      [b.incomeAccountId,id,a.core.organisation_id]);
    await audit(a.core.organisation_id,a.core.id,'finance.fee_income_gl.updated','fee_item',id,{incomeAccountId:b.incomeAccountId});
    return row;
  });

  app.get('/api/accounting/student-search',async request=>{
    const a=await authorize(request,db,config,'finance.receive_student_payment');
    const q=z.object({q:z.string().trim().min(1).max(120)}).parse(request.query).q;
    const like='%'+q.replace(/[%_]/g,'\\$&')+'%';
    return (await db.query(`
      SELECT s.id,s.admission_no,s.first_name,s.middle_name,s.last_name,s.status,
        (SELECT c.name FROM enrolments en JOIN classrooms c ON c.id=en.classroom_id
         WHERE en.student_id=s.id AND en.status='active' ORDER BY en.enrolled_at DESC LIMIT 1) classroom_name,
        (SELECT concat_ws(' ',g.first_name,g.last_name) FROM student_guardians sg JOIN guardians g ON g.id=sg.guardian_id
         WHERE sg.student_id=s.id ORDER BY sg.is_primary DESC,g.created_at LIMIT 1) guardian_name,
        (SELECT g.phone FROM student_guardians sg JOIN guardians g ON g.id=sg.guardian_id
         WHERE sg.student_id=s.id ORDER BY sg.is_primary DESC,g.created_at LIMIT 1) guardian_phone,
        COALESCE((SELECT sum((sf.amount_due-sf.discount)-COALESCE((SELECT sum(p.amount) FROM payments p
          WHERE p.student_fee_id=sf.id AND p.voided_at IS NULL),0)) FROM student_fees sf WHERE sf.student_id=s.id),0) outstanding
      FROM students s
      WHERE s.organisation_id=$1 AND (
        s.admission_no ILIKE $2 ESCAPE '\\'
        OR concat_ws(' ',s.first_name,s.middle_name,s.last_name) ILIKE $2 ESCAPE '\\'
        OR EXISTS(
          SELECT 1 FROM student_guardians sg JOIN guardians g ON g.id=sg.guardian_id
          WHERE sg.student_id=s.id AND (
            concat_ws(' ',g.first_name,g.last_name) ILIKE $2 ESCAPE '\\'
            OR g.phone ILIKE $2 ESCAPE '\\'
            OR COALESCE(g.email,'') ILIKE $2 ESCAPE '\\'
          )
        )
      )
      ORDER BY CASE WHEN lower(s.admission_no)=lower($3) THEN 0 ELSE 1 END,s.last_name,s.first_name
      LIMIT 30
    `,[a.core.organisation_id,like,q])).rows;
  });

  app.get('/api/accounting/students/:studentId',async request=>{
    const a=await authorize(request,db,config,'finance.view');
    const {studentId}=z.object({studentId:z.string().uuid()}).parse(request.params);
    const student=await one<any>(db,`
      SELECT s.*,
        (SELECT c.name FROM enrolments en JOIN classrooms c ON c.id=en.classroom_id
         WHERE en.student_id=s.id AND en.status='active' ORDER BY en.enrolled_at DESC LIMIT 1) classroom_name
      FROM students s WHERE s.id=$1 AND s.organisation_id=$2
    `,[studentId,a.core.organisation_id]);
    const guardians=(await db.query(`
      SELECT g.*,sg.relationship,sg.is_primary FROM student_guardians sg
      JOIN guardians g ON g.id=sg.guardian_id WHERE sg.student_id=$1
      ORDER BY sg.is_primary DESC,g.last_name,g.first_name
    `,[studentId])).rows;
    const fees=(await db.query(`
      SELECT sf.id student_fee_id,sf.amount_due,sf.discount,sf.status,sf.created_at,
        f.id fee_item_id,f.name fee_name,y.name academic_year,t.name term_name,
        ia.id income_account_id,ia.code income_account_code,ia.name income_account_name,
        COALESCE((SELECT sum(p.amount) FROM payments p WHERE p.student_fee_id=sf.id AND p.voided_at IS NULL),0) paid
      FROM student_fees sf
      JOIN fee_items f ON f.id=sf.fee_item_id
      JOIN academic_years y ON y.id=f.academic_year_id
      LEFT JOIN terms t ON t.id=f.term_id
      LEFT JOIN finance_accounts ia ON ia.id=f.income_account_id
      WHERE sf.organisation_id=$1 AND sf.student_id=$2
      ORDER BY sf.created_at DESC,f.name
    `,[a.core.organisation_id,studentId])).rows.map((x:any)=>({
      ...x,balance:Math.max(0,Number(x.amount_due)-Number(x.discount)-Number(x.paid))
    }));
    const receipts=(await db.query(`
      SELECT r.*,pm.label payment_method_label,fa.code settlement_account_code,fa.name settlement_account_name,je.entry_no
      FROM finance_student_receipts r
      JOIN finance_payment_methods pm ON pm.id=r.payment_method_id
      JOIN finance_accounts fa ON fa.id=r.settlement_account_id
      LEFT JOIN finance_journal_entries je ON je.id=r.journal_entry_id
      WHERE r.organisation_id=$1 AND r.student_id=$2
      ORDER BY r.paid_at DESC,r.created_at DESC LIMIT 100
    `,[a.core.organisation_id,studentId])).rows;
    const credit=await one<any>(db,`
      SELECT COALESCE(sum(balance),0) available FROM student_account_credits
      WHERE organisation_id=$1 AND student_id=$2 AND status='open'
    `,[a.core.organisation_id,studentId]);
    return{student,guardians,fees,receipts,
      summary:{
        charged:fees.reduce((s:number,x:any)=>s+Number(x.amount_due)-Number(x.discount),0),
        paid:fees.reduce((s:number,x:any)=>s+Number(x.paid),0),
        outstanding:fees.reduce((s:number,x:any)=>s+Number(x.balance),0),
        creditAvailable:Number(credit.available||0),
        netOutstanding:Math.max(0,fees.reduce((s:number,x:any)=>s+Number(x.balance),0)-Number(credit.available||0))
      }
    };
  });

  app.get('/api/accounting/students/:studentId/statement',async request=>{
    const a=await authorize(request,db,config,'finance.view');
    const {studentId}=z.object({studentId:z.string().uuid()}).parse(request.params);
    const student=await one<any>(db,`
      SELECT s.id,s.admission_no,s.first_name,s.middle_name,s.last_name,
        (SELECT c.name FROM enrolments en JOIN classrooms c ON c.id=en.classroom_id
         WHERE en.student_id=s.id AND en.status='active' ORDER BY en.enrolled_at DESC LIMIT 1) classroom_name
      FROM students s WHERE s.id=$1 AND s.organisation_id=$2
    `,[studentId,a.core.organisation_id]);
    const school=await one<any>(db,'SELECT school_name,short_name,motto,currency,address,phone,email,logo_url FROM school_profiles WHERE organisation_id=$1',[a.core.organisation_id]);
    const guardians=(await db.query(`
      SELECT g.first_name,g.last_name,g.phone,g.email,sg.relationship,sg.is_primary
      FROM student_guardians sg JOIN guardians g ON g.id=sg.guardian_id
      WHERE sg.student_id=$1 ORDER BY sg.is_primary DESC,g.last_name
    `,[studentId])).rows;
    const charges=(await db.query(`
      SELECT sf.id,sf.created_at occurred_at,'charge' kind,f.name description,
             (sf.amount_due-sf.discount) debit,0::numeric credit,
             y.name academic_year,t.name term_name,ia.code gl_code,ia.name gl_name,
             NULL::text reference
      FROM student_fees sf JOIN fee_items f ON f.id=sf.fee_item_id
      JOIN academic_years y ON y.id=f.academic_year_id
      LEFT JOIN terms t ON t.id=f.term_id
      LEFT JOIN finance_accounts ia ON ia.id=f.income_account_id
      WHERE sf.organisation_id=$1 AND sf.student_id=$2
    `,[a.core.organisation_id,studentId])).rows;
    const payments=(await db.query(`
      SELECT p.id,p.paid_at occurred_at,'payment' kind,
             COALESCE(f.name,'Direct school receipt') description,
             0::numeric debit,p.amount credit,
             y.name academic_year,t.name term_name,
             COALESCE(ia.code,fa.code) gl_code,COALESCE(ia.name,fa.name) gl_name,
             p.reference,p.payment_method
      FROM payments p
      LEFT JOIN student_fees sf ON sf.id=p.student_fee_id
      LEFT JOIN fee_items f ON f.id=sf.fee_item_id
      LEFT JOIN academic_years y ON y.id=f.academic_year_id
      LEFT JOIN terms t ON t.id=f.term_id
      LEFT JOIN finance_accounts ia ON ia.id=f.income_account_id
      LEFT JOIN finance_accounts fa ON fa.id=p.income_account_id
      WHERE p.organisation_id=$1 AND p.student_id=$2 AND p.voided_at IS NULL AND p.source<>'credit_applied' AND p.student_fee_id IS NOT NULL
    `,[a.core.organisation_id,studentId])).rows;
    const credits=(await db.query(`
      SELECT c.id,c.created_at occurred_at,'advance_credit' kind,'Advance / overpayment credit' description,
             0::numeric debit,c.original_amount credit,NULL::text academic_year,NULL::text term_name,
             '2200'::text gl_code,'Student Deposits / Credits'::text gl_name,
             r.reference,NULL::text payment_method
      FROM student_account_credits c
      LEFT JOIN finance_student_receipts r ON r.id=c.source_receipt_id
      WHERE c.organisation_id=$1 AND c.student_id=$2 AND c.status<>'voided'
    `,[a.core.organisation_id,studentId])).rows;
    const available=await one<any>(db,`
      SELECT COALESCE(sum(balance),0) amount FROM student_account_credits
      WHERE organisation_id=$1 AND student_id=$2 AND status='open'
    `,[a.core.organisation_id,studentId]);
    const rows=[...charges,...payments,...credits].sort((x:any,y:any)=>{
      const d0=new Date(x.occurred_at).getTime()-new Date(y.occurred_at).getTime();
      if(d0!==0)return d0;
      return x.kind==='charge'&&y.kind!=='charge'?-1:1;
    });
    let running=0;
    const ledger=rows.map((x:any)=>{running+=Number(x.debit||0)-Number(x.credit||0);return{...x,running_balance:running}});
    return{school,student,guardians,rows:ledger,summary:{
      charges:charges.reduce((s:number,x:any)=>s+Number(x.debit),0),
      payments:payments.reduce((s:number,x:any)=>s+Number(x.credit),0)+credits.reduce((s:number,x:any)=>s+Number(x.credit),0),
      creditAvailable:Number(available.amount||0),
      balance:running,
      amountDue:Math.max(0,running)
    },generatedAt:new Date().toISOString()};
  });

  app.get('/api/accounting/receipts/:id',async request=>{
    const a=await authorize(request,db,config,'finance.view');
    const {id}=z.object({id:z.string().uuid()}).parse(request.params);
    const receipt=await one<any>(db,`
      SELECT r.*,s.admission_no,s.first_name,s.middle_name,s.last_name,
        pm.label payment_method_label,pm.method_key,fa.code settlement_account_code,fa.name settlement_account_name,
        je.entry_no,sp.school_name,sp.short_name,sp.motto,sp.phone school_phone,sp.email school_email,
        sp.address school_address,sp.currency,sp.logo_url
      FROM finance_student_receipts r
      JOIN students s ON s.id=r.student_id
      JOIN finance_payment_methods pm ON pm.id=r.payment_method_id
      JOIN finance_accounts fa ON fa.id=r.settlement_account_id
      LEFT JOIN finance_journal_entries je ON je.id=r.journal_entry_id
      JOIN school_profiles sp ON sp.organisation_id=r.organisation_id
      WHERE r.id=$1 AND r.organisation_id=$2
    `,[id,a.core.organisation_id]);
    const allocations=(await db.query(`
      SELECT ra.*,f.name fee_name,ia.code income_account_code,ia.name income_account_name
      FROM finance_student_receipt_allocations ra
      LEFT JOIN student_fees sf ON sf.id=ra.student_fee_id
      LEFT JOIN fee_items f ON f.id=sf.fee_item_id
      LEFT JOIN finance_accounts ia ON ia.id=ra.income_account_id
      WHERE ra.receipt_id=$1 ORDER BY ra.created_at,ra.id
    `,[id])).rows;
    const credit=await maybeOne<any>(db,`
      SELECT id,original_amount,balance,status FROM student_account_credits
      WHERE source_receipt_id=$1 ORDER BY created_at LIMIT 1
    `,[id]);
    return{receipt,allocations,credit:credit??null};
  });

  app.post('/api/accounting/receipts',async(request,reply)=>{
    const a=await authorize(request,db,config,'finance.receive_student_payment');
    const b=z.object({
      studentId:z.string().uuid(),
      paymentMethodId:z.string().uuid(),
      note:z.string().trim().max(1200).optional(),
      paidAt:z.string().datetime().optional(),
      amountReceived:z.number().positive(),
      directIncomeAccountId:z.string().uuid().optional(),
      directIncomeAmount:z.number().min(0).default(0),
      allocations:z.array(z.object({
        studentFeeId:z.string().uuid(),
        amount:z.number().positive()
      })).max(50).default([])
    }).superRefine((v,ctx)=>{
      if(v.directIncomeAmount>0&&!v.directIncomeAccountId){
        ctx.addIssue({code:z.ZodIssueCode.custom,path:['directIncomeAccountId'],message:'Select an Income GL when a direct income amount is entered'});
      }
      if(v.directIncomeAmount===0&&v.directIncomeAccountId){
        ctx.addIssue({code:z.ZodIssueCode.custom,path:['directIncomeAmount'],message:'Enter a direct income amount or clear the Income GL'});
      }
      const allocated=v.allocations.reduce((s,x)=>s+Number(x.amount),0)+Number(v.directIncomeAmount||0);
      if(allocated>Number(v.amountReceived)+0.005){
        ctx.addIssue({code:z.ZodIssueCode.custom,path:['amountReceived'],message:'Fee allocations plus direct income cannot exceed the amount received'});
      }
    }).parse(request.body);

    const feeAllocationTotal=b.allocations.reduce((s,x)=>s+Number(x.amount),0);
    const directTotal=Number(b.directIncomeAmount||0);
    const result=await tx(db,async(client:any)=>{
      const student=await one<any>(client,'SELECT * FROM students WHERE id=$1 AND organisation_id=$2',[b.studentId,a.core.organisation_id]);
      const method=await one<any>(client,`
        SELECT pm.*,fa.code settlement_code,fa.name settlement_name FROM finance_payment_methods pm
        JOIN finance_accounts fa ON fa.id=pm.settlement_account_id
        WHERE pm.id=$1 AND pm.organisation_id=$2 AND pm.enabled=true AND pm.allow_manual_receipt=true
      `,[b.paymentMethodId,a.core.organisation_id]);
      await assertAccount(client,a.core.organisation_id,method.settlement_account_id,'asset');

      const paidAt=b.paidAt??new Date().toISOString();
      const reference=await nextPaymentReference(client,a.core.organisation_id,method,student.admission_no);
      const receiptNo='RCT-'+reference;
      const receipt=await one<any>(client,`
        INSERT INTO finance_student_receipts(
          organisation_id,receipt_no,student_id,payment_method_id,settlement_account_id,amount,reference,note,paid_at,received_by_os_user_id
        ) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) RETURNING *
      `,[a.core.organisation_id,receiptNo,b.studentId,method.id,method.settlement_account_id,b.amountReceived,reference,b.note??null,paidAt,a.core.id]);

      let arTotal=0;
      const lines:any[]=[{accountId:method.settlement_account_id,debit:b.amountReceived,description:method.label+' receipt'}];
      const allocationRows:any[]=[];

      for(const allocation of b.allocations){
        const fee=await one<any>(client,`
          SELECT sf.*,f.name fee_name,f.income_account_id,
            (sf.amount_due-sf.discount)-COALESCE((SELECT sum(p.amount) FROM payments p WHERE p.student_fee_id=sf.id AND p.voided_at IS NULL),0) balance
          FROM student_fees sf JOIN fee_items f ON f.id=sf.fee_item_id
          WHERE sf.id=$1 AND sf.student_id=$2 AND sf.organisation_id=$3 FOR UPDATE
        `,[allocation.studentFeeId,b.studentId,a.core.organisation_id]);
        if(Number(allocation.amount)>Number(fee.balance)+0.005)throw fail(400,'Payment allocation exceeds the outstanding balance for '+fee.fee_name);
        if(Number(fee.balance)<=0)throw fail(409,fee.fee_name+' is already fully paid');
        arTotal+=Number(allocation.amount);

        const payment=await one<any>(client,`
          INSERT INTO payments(
            organisation_id,student_id,student_fee_id,amount,payment_method,reference,paid_at,received_by_os_user_id,note,source,finance_receipt_id,income_account_id
          ) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,'accounting_receipt',$10,$11) RETURNING *
        `,[
          a.core.organisation_id,b.studentId,fee.id,allocation.amount,method.method_key,
          reference,paidAt,a.core.id,b.note??null,receipt.id,fee.income_account_id??null
        ]);
        await updateStudentFeeStatus(client,fee.id);
        const alloc=await one<any>(client,`
          INSERT INTO finance_student_receipt_allocations(receipt_id,student_fee_id,payment_id,income_account_id,amount)
          VALUES($1,$2,$3,$4,$5) RETURNING *
        `,[receipt.id,fee.id,payment.id,fee.income_account_id??null,allocation.amount]);
        allocationRows.push({...alloc,fee_name:fee.fee_name});
      }

      if(arTotal>0){
        const ar=await maybeOne<any>(client,"SELECT * FROM finance_accounts WHERE organisation_id=$1 AND code='1100' AND is_active=true",[a.core.organisation_id]);
        if(!ar)throw fail(409,'Accounts Receivable GL (1100) is not configured');
        lines.push({accountId:ar.id,credit:arTotal,description:'Student fee receivable settlement'});
      }

      if(directTotal>0){
        const income=await assertAccount(client,a.core.organisation_id,b.directIncomeAccountId!,'income');
        const payment=await one<any>(client,`
          INSERT INTO payments(
            organisation_id,student_id,student_fee_id,amount,payment_method,reference,paid_at,received_by_os_user_id,note,source,finance_receipt_id,income_account_id
          ) VALUES($1,$2,NULL,$3,$4,$5,$6,$7,$8,'accounting_receipt',$9,$10) RETURNING *
        `,[a.core.organisation_id,b.studentId,directTotal,method.method_key,reference,paidAt,a.core.id,b.note??null,receipt.id,income.id]);
        const alloc=await one<any>(client,`
          INSERT INTO finance_student_receipt_allocations(receipt_id,student_fee_id,payment_id,income_account_id,amount)
          VALUES($1,NULL,$2,$3,$4) RETURNING *
        `,[receipt.id,payment.id,income.id,directTotal]);
        allocationRows.push({...alloc,fee_name:null,income_account_code:income.code,income_account_name:income.name});
        lines.push({accountId:income.id,credit:directTotal,description:'Direct student income - '+income.name});
      }

      const excess=Math.max(0,Number(b.amountReceived)-arTotal-directTotal);
      let credit:any=null;
      if(excess>0.004){
        const deposit=await maybeOne<any>(client,"SELECT * FROM finance_accounts WHERE organisation_id=$1 AND code='2200' AND is_active=true",[a.core.organisation_id]);
        if(!deposit)throw fail(409,'Student Deposits / Credits GL (2200) is not configured');
        credit=await one<any>(client,`
          INSERT INTO student_account_credits(organisation_id,student_id,source_receipt_id,original_amount,balance,created_by_os_user_id)
          VALUES($1,$2,$3,$4,$4,$5) RETURNING *
        `,[a.core.organisation_id,b.studentId,receipt.id,excess,a.core.id]);
        lines.push({accountId:deposit.id,credit:excess,description:'Student advance / overpayment credit'});
      }

      const journal=await postFinanceJournal(client,{
        organisationId:a.core.organisation_id,
        entryDate:new Date(paidAt).toISOString().slice(0,10),
        description:'Student receipt - '+student.first_name+' '+student.last_name+' ('+student.admission_no+')',
        sourceType:'student_receipt',sourceId:receipt.id,reference,actorOsUserId:a.core.id,lines
      });
      await client.query('UPDATE finance_student_receipts SET journal_entry_id=$1 WHERE id=$2',[journal.id,receipt.id]);

      return{
        receipt:{...receipt,journal_entry_id:journal.id},journal,allocations:allocationRows,credit,student,reference,
        appliedToFees:arTotal,directIncome:directTotal,overpaymentCredit:excess
      };
    });

    await audit(a.core.organisation_id,a.core.id,'finance.student_receipt.posted','finance_student_receipt',result.receipt.id,{
      receiptNo:result.receipt.receipt_no,reference:result.reference,amount:b.amountReceived,studentId:b.studentId,
      allocationCount:b.allocations.length,appliedToFees:result.appliedToFees,directIncome:result.directIncome,overpaymentCredit:result.overpaymentCredit
    });
    return reply.code(201).send(result);
  });

}
