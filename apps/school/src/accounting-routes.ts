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
};

export async function registerAccountingRoutes(app:FastifyInstance,d:Deps){
  const {db,config,authorize,one,maybeOne,tx,fail,audit,postFinanceJournal,updateStudentFeeStatus}=d;

  async function assertAccount(client:any,organisationId:string,id:string,type?:string){
    const params:any[]=[id,organisationId];
    let sql='SELECT * FROM finance_accounts WHERE id=$1 AND organisation_id=$2 AND is_active=true';
    if(type){params.push(type);sql+=' AND account_type=$3'}
    const row=await maybeOne<any>(client,sql,params);
    if(!row)throw fail(400,type?('Select an active '+type+' GL account'):'Select an active finance account');
    return row;
  }

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
    return{student,guardians,fees,receipts,
      summary:{
        charged:fees.reduce((s:number,x:any)=>s+Number(x.amount_due)-Number(x.discount),0),
        paid:fees.reduce((s:number,x:any)=>s+Number(x.paid),0),
        outstanding:fees.reduce((s:number,x:any)=>s+Number(x.balance),0)
      }
    };
  });

  app.get('/api/accounting/students/:studentId/statement',async request=>{
    const a=await authorize(request,db,config,'finance.view');
    const {studentId}=z.object({studentId:z.string().uuid()}).parse(request.params);
    const student=await one<any>(db,'SELECT id,admission_no,first_name,middle_name,last_name FROM students WHERE id=$1 AND organisation_id=$2',
      [studentId,a.core.organisation_id]);
    const school=await one<any>(db,'SELECT school_name,currency,address,phone,email FROM school_profiles WHERE organisation_id=$1',[a.core.organisation_id]);
    const charges=(await db.query(`
      SELECT sf.id, sf.created_at occurred_at,'charge' kind,f.name description,
             (sf.amount_due-sf.discount) debit,0::numeric credit,
             y.name academic_year,t.name term_name,ia.code gl_code,ia.name gl_name
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
      WHERE p.organisation_id=$1 AND p.student_id=$2 AND p.voided_at IS NULL
    `,[a.core.organisation_id,studentId])).rows;
    const rows=[...charges,...payments].sort((x:any,y:any)=>{
      const d=new Date(x.occurred_at).getTime()-new Date(y.occurred_at).getTime();
      if(d!==0)return d;
      return x.kind==='charge'&&y.kind!=='charge'?-1:1;
    });
    let running=0;
    const ledger=rows.map((x:any)=>{running+=Number(x.debit||0)-Number(x.credit||0);return{...x,running_balance:running}});
    return{school,student,rows:ledger,summary:{
      charges:charges.reduce((s:number,x:any)=>s+Number(x.debit),0),
      payments:payments.reduce((s:number,x:any)=>s+Number(x.credit),0),
      balance:running
    },generatedAt:new Date().toISOString()};
  });

  app.post('/api/accounting/receipts',async(request,reply)=>{
    const a=await authorize(request,db,config,'finance.receive_student_payment');
    const b=z.object({
      studentId:z.string().uuid(),
      paymentMethodId:z.string().uuid(),
      reference:z.string().trim().max(160).optional(),
      note:z.string().trim().max(1200).optional(),
      paidAt:z.string().datetime().optional(),
      allocations:z.array(z.object({
        studentFeeId:z.string().uuid().optional(),
        incomeAccountId:z.string().uuid().optional(),
        amount:z.number().positive()
      }).refine(v=>v.studentFeeId||v.incomeAccountId,{message:'Each allocation needs a fee or income GL'})).min(1).max(50)
    }).parse(request.body);
    const total=b.allocations.reduce((s,x)=>s+Number(x.amount),0);
    const result=await tx(db,async(client:any)=>{
      const student=await one<any>(client,'SELECT * FROM students WHERE id=$1 AND organisation_id=$2',[b.studentId,a.core.organisation_id]);
      const method=await one<any>(client,`
        SELECT pm.*,fa.code settlement_code,fa.name settlement_name FROM finance_payment_methods pm
        JOIN finance_accounts fa ON fa.id=pm.settlement_account_id
        WHERE pm.id=$1 AND pm.organisation_id=$2 AND pm.enabled=true AND pm.allow_manual_receipt=true
      `,[b.paymentMethodId,a.core.organisation_id]);
      await assertAccount(client,a.core.organisation_id,method.settlement_account_id,'asset');
      const paidAt=b.paidAt??new Date().toISOString();
      const receiptNo='RCT-'+new Date(paidAt).toISOString().slice(0,10).replace(/-/g,'')+'-'+Math.random().toString(36).slice(2,8).toUpperCase();
      const receipt=await one<any>(client,`
        INSERT INTO finance_student_receipts(
          organisation_id,receipt_no,student_id,payment_method_id,settlement_account_id,amount,reference,note,paid_at,received_by_os_user_id
        ) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) RETURNING *
      `,[a.core.organisation_id,receiptNo,b.studentId,method.id,method.settlement_account_id,total,b.reference??null,b.note??null,paidAt,a.core.id]);

      let arTotal=0;
      const incomeCredits=new Map<string,{account:any;amount:number}>();
      const allocationRows:any[]=[];
      for(const allocation of b.allocations){
        let fee:any=null,income:any=null;
        if(allocation.studentFeeId){
          fee=await one<any>(client,`
            SELECT sf.*,f.name fee_name,f.income_account_id,
              (sf.amount_due-sf.discount)-COALESCE((SELECT sum(p.amount) FROM payments p WHERE p.student_fee_id=sf.id AND p.voided_at IS NULL),0) balance
            FROM student_fees sf JOIN fee_items f ON f.id=sf.fee_item_id
            WHERE sf.id=$1 AND sf.student_id=$2 AND sf.organisation_id=$3 FOR UPDATE
          `,[allocation.studentFeeId,b.studentId,a.core.organisation_id]);
          if(Number(allocation.amount)>Number(fee.balance)+0.005)throw fail(400,'Payment allocation exceeds the outstanding balance for '+fee.fee_name);
          if(Number(fee.balance)<=0)throw fail(409,fee.fee_name+' is already fully paid');
          arTotal+=Number(allocation.amount);
          if(fee.income_account_id)income=await assertAccount(client,a.core.organisation_id,fee.income_account_id,'income');
        }else{
          income=await assertAccount(client,a.core.organisation_id,allocation.incomeAccountId!,'income');
          const current=incomeCredits.get(income.id)??{account:income,amount:0};
          current.amount+=Number(allocation.amount);incomeCredits.set(income.id,current);
        }

        const payment=await one<any>(client,`
          INSERT INTO payments(
            organisation_id,student_id,student_fee_id,amount,payment_method,reference,paid_at,received_by_os_user_id,note,source,finance_receipt_id,income_account_id
          ) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,'accounting_receipt',$10,$11) RETURNING *
        `,[
          a.core.organisation_id,b.studentId,fee?.id??null,allocation.amount,method.method_key,
          b.reference??receiptNo,paidAt,a.core.id,b.note??null,receipt.id,income?.id??allocation.incomeAccountId??null
        ]);
        if(fee)await updateStudentFeeStatus(client,fee.id);
        const alloc=await one<any>(client,`
          INSERT INTO finance_student_receipt_allocations(receipt_id,student_fee_id,payment_id,income_account_id,amount)
          VALUES($1,$2,$3,$4,$5) RETURNING *
        `,[receipt.id,fee?.id??null,payment.id,income?.id??allocation.incomeAccountId??null,allocation.amount]);
        allocationRows.push({...alloc,fee_name:fee?.fee_name??null,income_account_code:income?.code??null,income_account_name:income?.name??null});
      }

      const lines:any[]=[{accountId:method.settlement_account_id,debit:total,description:method.label+' receipt'}];
      if(arTotal>0){
        const ar=await maybeOne<any>(client,"SELECT * FROM finance_accounts WHERE organisation_id=$1 AND code='1100' AND is_active=true",[a.core.organisation_id]);
        if(!ar)throw fail(409,'Accounts Receivable GL (1100) is not configured');
        lines.push({accountId:ar.id,credit:arTotal,description:'Student fee receivable settlement'});
      }
      for(const v of incomeCredits.values())lines.push({accountId:v.account.id,credit:v.amount,description:'Direct student income - '+v.account.name});
      const journal=await postFinanceJournal(client,{
        organisationId:a.core.organisation_id,
        entryDate:new Date(paidAt).toISOString().slice(0,10),
        description:'Student receipt - '+student.first_name+' '+student.last_name+' ('+student.admission_no+')',
        sourceType:'student_receipt',sourceId:receipt.id,reference:b.reference??receiptNo,actorOsUserId:a.core.id,lines
      });
      await client.query('UPDATE finance_student_receipts SET journal_entry_id=$1 WHERE id=$2',[journal.id,receipt.id]);
      return{receipt:{...receipt,journal_entry_id:journal.id},journal,allocations:allocationRows,student};
    });
    await audit(a.core.organisation_id,a.core.id,'finance.student_receipt.posted','finance_student_receipt',result.receipt.id,{
      receiptNo:result.receipt.receipt_no,amount:total,studentId:b.studentId,allocationCount:b.allocations.length
    });
    return reply.code(201).send(result);
  });
}
