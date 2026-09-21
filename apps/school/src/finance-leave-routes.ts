import type { FastifyInstance } from 'fastify';
import { z } from 'zod';

type Deps={
  db:any;
  config:any;
  authorize:(request:any,db:any,config:any,capability?:string)=>Promise<any>;
  maybeOne:<T=any>(db:any,sql:string,params?:any[])=>Promise<T|undefined>;
  one:<T=any>(db:any,sql:string,params?:any[])=>Promise<T>;
  tx:(db:any,fn:(client:any)=>Promise<any>)=>Promise<any>;
  fail:(status:number,message:string)=>any;
  audit:(organisationId:string,userId:string,action:string,resourceType:string,resourceId?:string|null,metadata?:any)=>Promise<void>;
  fetchCoreUsers:(organisationId:string)=>Promise<any[]>;
  coreServiceHeaders:()=>Record<string,string>;
  deliverCommunication:(input:any)=>Promise<any>;
  postFinanceJournal:(client:any,input:any)=>Promise<any>;
  postStudentPaymentLedger:(client:any,paymentId:string,actorOsUserId?:string|null)=>Promise<any>;
  postStudentFeeReceivable:(client:any,studentFeeId:string,actorOsUserId?:string|null)=>Promise<any>;
  reverseFinanceJournal:(client:any,organisationId:string,originalId:string,actorOsUserId:string,reason:string,sourceType:string,sourceId:string)=>Promise<any>;
  clearCoreUsersCache:(organisationId:string)=>void;
};

export async function registerFinanceLeaveRoutes(app:FastifyInstance,d:Deps){
  const {db,config,authorize,maybeOne,one,tx,fail,audit,fetchCoreUsers,coreServiceHeaders,deliverCommunication,postFinanceJournal,postStudentPaymentLedger,postStudentFeeReceivable,reverseFinanceJournal,clearCoreUsersCache}=d;

  app.get('/api/staff/users',async request=>{
    const a=await authorize(request,db,config,'staff.view');
    const users=await fetchCoreUsers(a.core.organisation_id);
    const memberships=(await db.query(
      'SELECT sm.*,sr.name role_name,sr.portal_mode,sr.can_teach FROM school_memberships sm '+
      'LEFT JOIN school_roles sr ON sr.organisation_id=sm.organisation_id AND sr.key=sm.role '+
      'WHERE sm.organisation_id=$1',[a.core.organisation_id])).rows;
    return users.map((u:any)=>{
      const school=memberships.find((m:any)=>m.os_user_id===u.id);
      return {...u,school_membership_id:school?.id??null,school_role:school?.role??null,school_role_name:school?.role_name??null,
        school_status:school?.status??'not_assigned',portal_mode:school?.portal_mode??null,can_teach:school?.can_teach??false};
    });
  });

  app.patch('/api/staff/users/:membershipId',async request=>{
    const a=await authorize(request,db,config,'staff.edit');
    const {membershipId}=z.object({membershipId:z.string().uuid()}).parse(request.params);
    const b=z.object({
      firstName:z.string().trim().min(1).max(100).optional(),
      lastName:z.string().trim().min(1).max(100).optional(),
      email:z.string().trim().toLowerCase().email().nullable().optional(),
      jobTitle:z.string().trim().max(160).nullable().optional(),
      schoolRole:z.string().min(1).max(40).optional()
    }).refine(v=>Object.keys(v).length>0).parse(request.body);
    const base=config.CORE_OS_URL.replace(/\/$/,'');
    const res=await fetch(base+'/v1/internal/school/users/'+membershipId,{
      method:'PATCH',headers:{...coreServiceHeaders(),'content-type':'application/json'},
      body:JSON.stringify({organisationId:a.core.organisation_id,actorUserId:a.core.id,
        ...(Object.hasOwn(b,'firstName')?{firstName:b.firstName}:{}),
        ...(Object.hasOwn(b,'lastName')?{lastName:b.lastName}:{}),
        ...(Object.hasOwn(b,'email')?{email:b.email}:{}),
        ...(Object.hasOwn(b,'jobTitle')?{jobTitle:b.jobTitle}:{})}),
      signal:AbortSignal.timeout(15000)
    }).catch(()=>null);
    if(!res)throw fail(503,'Core OS could not be reached');
    const payload=await res.json().catch(()=>null) as any;
    if(!res.ok)throw fail(res.status,payload?.error?.message||'Could not update user');
    if(b.schoolRole){
      await one(db,'SELECT 1 FROM school_roles WHERE organisation_id=$1 AND key=$2 AND is_active=true',[a.core.organisation_id,b.schoolRole]);
      await db.query('UPDATE school_memberships SET role=$1,updated_at=now() WHERE organisation_id=$2 AND os_user_id=$3',
        [b.schoolRole,a.core.organisation_id,payload.id]);
    }
    clearCoreUsersCache(a.core.organisation_id);
    await audit(a.core.organisation_id,a.core.id,'school_user.updated','core_membership',membershipId,{schoolRole:b.schoolRole??null});
    return payload;
  });

  app.post('/api/staff/users/:membershipId/status',async request=>{
    const a=await authorize(request,db,config,'staff.status');
    const {membershipId}=z.object({membershipId:z.string().uuid()}).parse(request.params);
    const b=z.object({status:z.enum(['active','suspended'])}).parse(request.body);
    const base=config.CORE_OS_URL.replace(/\/$/,'');
    const res=await fetch(base+'/v1/internal/school/users/'+membershipId+'/status',{
      method:'PATCH',headers:{...coreServiceHeaders(),'content-type':'application/json'},
      body:JSON.stringify({organisationId:a.core.organisation_id,actorUserId:a.core.id,status:b.status}),signal:AbortSignal.timeout(15000)
    }).catch(()=>null);
    if(!res)throw fail(503,'Core OS could not be reached');
    const payload=await res.json().catch(()=>null) as any;
    if(!res.ok)throw fail(res.status,payload?.error?.message||'Could not change user status');
    await db.query('UPDATE school_memberships SET status=$1,updated_at=now() WHERE organisation_id=$2 AND os_user_id=$3',
      [b.status,a.core.organisation_id,payload.user_id]);
    clearCoreUsersCache(a.core.organisation_id);
    await audit(a.core.organisation_id,a.core.id,'school_user.status_changed','core_membership',membershipId,{status:b.status});
    return payload;
  });

  app.post('/api/staff/users/:membershipId/unlock',async request=>{
    const a=await authorize(request,db,config,'staff.status');
    const {membershipId}=z.object({membershipId:z.string().uuid()}).parse(request.params);
    const base=config.CORE_OS_URL.replace(/\/$/,'');
    const res=await fetch(base+'/v1/internal/school/users/'+membershipId+'/unlock',{
      method:'POST',headers:{...coreServiceHeaders(),'content-type':'application/json'},
      body:JSON.stringify({organisationId:a.core.organisation_id,actorUserId:a.core.id}),signal:AbortSignal.timeout(15000)
    }).catch(()=>null);
    if(!res)throw fail(503,'Core OS could not be reached');
    const payload=await res.json().catch(()=>null) as any;
    if(!res.ok)throw fail(res.status,payload?.error?.message||'Could not unlock user');
    await db.query("UPDATE school_memberships SET status='active',updated_at=now() WHERE organisation_id=$1 AND os_user_id=$2",
      [a.core.organisation_id,payload.user_id]);
    clearCoreUsersCache(a.core.organisation_id);
    await audit(a.core.organisation_id,a.core.id,'school_user.unlocked','core_membership',membershipId);
    return payload;
  });

  app.post('/api/staff/users/:membershipId/password-reset',async request=>{
    const a=await authorize(request,db,config,'staff.password_reset');
    const {membershipId}=z.object({membershipId:z.string().uuid()}).parse(request.params);
    const base=config.CORE_OS_URL.replace(/\/$/,'');
    const setupRes=await fetch(base+'/v1/internal/school/users/'+membershipId+'/password-setup',{
      method:'POST',headers:{...coreServiceHeaders(),'content-type':'application/json'},
      body:JSON.stringify({organisationId:a.core.organisation_id,actorUserId:a.core.id}),signal:AbortSignal.timeout(15000)
    }).catch(()=>null);
    if(!setupRes)throw fail(503,'Core OS could not be reached');
    const setup=await setupRes.json().catch(()=>null) as any;
    if(!setupRes.ok)throw fail(setupRes.status,setup?.error?.message||'Could not create password reset link');
    const sm=await maybeOne(db,
      'SELECT sm.*,sr.portal_mode FROM school_memberships sm LEFT JOIN school_roles sr ON sr.organisation_id=sm.organisation_id AND sr.key=sm.role '+
      'WHERE sm.organisation_id=$1 AND sm.os_user_id=$2',[a.core.organisation_id,setup.userId]) as any;
    const publicBase=(config.PUBLIC_BASE_URL||'https://revolt-x-school.onrender.com').replace(/\/$/,'');
    const next=sm?.portal_mode==='teacher'?'/teacher':'/';
    const setupUrl=publicBase+'/login?next='+encodeURIComponent(next)+'&setup='+encodeURIComponent(setup.setupToken);
    const delivered=await deliverCommunication({
      organisationId:a.core.organisation_id,actorOsUserId:a.core.id,channel:'email',
      recipientName:(setup.firstName+' '+setup.lastName).trim(),recipientAddress:setup.email,
      subject:'Reset your Revolt-X School password',
      body:'Hello '+setup.firstName+',\n\nA School administrator has requested a password reset for your Revolt-X School account.\n\nUse this secure link to set a new password:\n'+setupUrl+'\n\nThis link expires in 24 hours.',
      templateKey:'staff.password_reset',relatedType:'school_membership',relatedId:sm?.id??null
    });
    await audit(a.core.organisation_id,a.core.id,'school_user.password_reset_issued','core_membership',membershipId,{deliveryStatus:delivered.status});
    return{status:delivered.status,expiresInHours:setup.expiresInHours,error:delivered.last_error??null};
  });

  app.get('/api/finance/accounts',async request=>{
    const a=await authorize(request,db,config,'finance.view');
    return (await db.query(
      'SELECT fa.*,COALESCE((SELECT sum(jl.debit-jl.credit) FROM finance_journal_lines jl JOIN finance_journal_entries je ON je.id=jl.journal_entry_id '+
      "WHERE jl.account_id=fa.id AND je.status='posted'),0) raw_balance FROM finance_accounts fa WHERE fa.organisation_id=$1 ORDER BY fa.code",
      [a.core.organisation_id])).rows;
  });

  app.post('/api/finance/accounts',async(request,reply)=>{
    const a=await authorize(request,db,config,'finance.manage');
    const b=z.object({code:z.string().trim().min(1).max(30),name:z.string().trim().min(2).max(180),
      accountType:z.enum(['asset','liability','equity','income','expense']),subtype:z.string().max(60).optional(),
      isCashAccount:z.boolean().default(false),openingBalance:z.number().default(0)}).parse(request.body);
    const row=await one(db,
      'INSERT INTO finance_accounts(organisation_id,code,name,account_type,subtype,is_cash_account,opening_balance) VALUES($1,$2,$3,$4,$5,$6,$7) RETURNING *',
      [a.core.organisation_id,b.code.toUpperCase(),b.name,b.accountType,b.subtype??null,b.isCashAccount,b.openingBalance]) as any;
    await audit(a.core.organisation_id,a.core.id,'finance.account_created','finance_account',row.id,{code:row.code});
    return reply.code(201).send(row);
  });

  app.patch('/api/finance/accounts/:id',async request=>{
    const a=await authorize(request,db,config,'finance.manage');
    const {id}=z.object({id:z.string().uuid()}).parse(request.params);
    const b=z.object({
      name:z.string().trim().min(2).max(180).optional(),
      subtype:z.string().trim().max(60).nullable().optional(),
      isActive:z.boolean().optional()
    }).refine(v=>Object.keys(v).length>0).parse(request.body);
    const current=await one<any>(db,'SELECT * FROM finance_accounts WHERE id=$1 AND organisation_id=$2',[id,a.core.organisation_id]);
    if(b.isActive===false&&current.is_system){
      const required=new Set(['1000','1010','1020','1030','1100','2200','4000']);
      if(required.has(String(current.code)))throw fail(409,'This system GL is required by School accounting and cannot be disabled');
    }
    const row=await one<any>(db,`UPDATE finance_accounts SET
      name=COALESCE($1,name),
      subtype=CASE WHEN $2 THEN $3 ELSE subtype END,
      is_active=COALESCE($4,is_active),
      updated_at=now()
      WHERE id=$5 AND organisation_id=$6 RETURNING *`,
      [b.name??null,Object.hasOwn(b,'subtype'),b.subtype??null,b.isActive??null,id,a.core.organisation_id]);
    await audit(a.core.organisation_id,a.core.id,'finance.account_updated','finance_account',id,{code:row.code});
    return row;
  });

  app.get('/api/finance/vendors',async request=>{
    const a=await authorize(request,db,config,'finance.view');
    return (await db.query('SELECT * FROM finance_vendors WHERE organisation_id=$1 ORDER BY is_active DESC,name',[a.core.organisation_id])).rows;
  });

  app.post('/api/finance/vendors',async(request,reply)=>{
    const a=await authorize(request,db,config,'finance.manage');
    const b=z.object({name:z.string().trim().min(2).max(220),taxId:z.string().max(100).optional(),phone:z.string().max(80).optional(),
      email:z.string().email().optional(),address:z.string().max(2000).optional(),contactPerson:z.string().max(180).optional()}).parse(request.body);
    const row=await one(db,
      'INSERT INTO finance_vendors(organisation_id,name,tax_id,phone,email,address,contact_person) VALUES($1,$2,$3,$4,$5,$6,$7) RETURNING *',
      [a.core.organisation_id,b.name,b.taxId??null,b.phone??null,b.email??null,b.address??null,b.contactPerson??null]) as any;
    await audit(a.core.organisation_id,a.core.id,'finance.vendor_created','finance_vendor',row.id);
    return reply.code(201).send(row);
  });

  app.get('/api/finance/dashboard',async request=>{
    const a=await authorize(request,db,config,'finance.view');
    const q=z.object({start:z.string().date().optional(),end:z.string().date().optional()}).parse(request.query);
    const start=q.start??new Date(new Date().getFullYear(),0,1).toISOString().slice(0,10);
    const end=q.end??new Date().toISOString().slice(0,10);
    const income=await one(db,
      "SELECT COALESCE(sum(jl.credit-jl.debit),0) amount FROM finance_journal_lines jl JOIN finance_journal_entries je ON je.id=jl.journal_entry_id "+
      "JOIN finance_accounts fa ON fa.id=jl.account_id WHERE je.organisation_id=$1 AND je.status='posted' AND je.entry_date BETWEEN $2 AND $3 AND fa.account_type='income'",
      [a.core.organisation_id,start,end]) as any;
    const expenses=await one(db,
      "SELECT COALESCE(sum(jl.debit-jl.credit),0) amount FROM finance_journal_lines jl JOIN finance_journal_entries je ON je.id=jl.journal_entry_id "+
      "JOIN finance_accounts fa ON fa.id=jl.account_id WHERE je.organisation_id=$1 AND je.status='posted' AND je.entry_date BETWEEN $2 AND $3 AND fa.account_type='expense'",
      [a.core.organisation_id,start,end]) as any;
    const cash=await one(db,
      "SELECT COALESCE(sum(jl.debit-jl.credit),0) amount FROM finance_journal_lines jl JOIN finance_journal_entries je ON je.id=jl.journal_entry_id "+
      "JOIN finance_accounts fa ON fa.id=jl.account_id WHERE je.organisation_id=$1 AND je.status='posted' AND fa.is_cash_account=true",
      [a.core.organisation_id]) as any;
    const outstanding=await one(db,
      "SELECT COALESCE(sum((sf.amount_due-sf.discount)-COALESCE(p.paid,0)),0) amount FROM student_fees sf "+
      "LEFT JOIN (SELECT student_fee_id,sum(amount) FILTER(WHERE voided_at IS NULL) paid FROM payments GROUP BY student_fee_id) p ON p.student_fee_id=sf.id "+
      "WHERE sf.organisation_id=$1",[a.core.organisation_id]) as any;
    const taxes=await one(db,
      "SELECT COALESCE(sum(amount_due-amount_paid),0) amount,count(*) FILTER(WHERE status IN('open','part_paid','overdue'))::int open_count "+
      "FROM finance_tax_obligations WHERE organisation_id=$1 AND status<>'cancelled'",[a.core.organisation_id]) as any;
    return{period:{start,end},income:Number(income.amount),expenses:Number(expenses.amount),surplus:Number(income.amount)-Number(expenses.amount),
      cash:Number(cash.amount),outstandingFees:Number(outstanding.amount),taxOutstanding:Number(taxes.amount),openTaxItems:Number(taxes.open_count||0)};
  });

  app.get('/api/finance/journals',async request=>{
    const a=await authorize(request,db,config,'finance.view');
    const q=z.object({start:z.string().date().optional(),end:z.string().date().optional(),q:z.string().max(100).optional(),limit:z.coerce.number().int().min(1).max(500).default(200)}).parse(request.query);
    const like=q.q?'%'+q.q+'%':null;
    return (await db.query(
      "SELECT je.*,COALESCE(sum(jl.debit),0) total_debit,COALESCE(sum(jl.credit),0) total_credit FROM finance_journal_entries je "+
      "LEFT JOIN finance_journal_lines jl ON jl.journal_entry_id=je.id WHERE je.organisation_id=$1 "+
      "AND ($2::date IS NULL OR je.entry_date>=$2) AND ($3::date IS NULL OR je.entry_date<=$3) "+
      "AND ($4::text IS NULL OR je.entry_no ILIKE $4 OR je.description ILIKE $4 OR COALESCE(je.reference,'') ILIKE $4) "+
      "GROUP BY je.id ORDER BY je.entry_date DESC,je.created_at DESC LIMIT $5",
      [a.core.organisation_id,q.start??null,q.end??null,like,q.limit])).rows;
  });

  app.get('/api/finance/journals/:id',async request=>{
    const a=await authorize(request,db,config,'finance.view');
    const {id}=z.object({id:z.string().uuid()}).parse(request.params);
    const entry=await one(db,'SELECT * FROM finance_journal_entries WHERE id=$1 AND organisation_id=$2',[id,a.core.organisation_id]);
    const lines=(await db.query(
      'SELECT jl.*,fa.code account_code,fa.name account_name,fa.account_type FROM finance_journal_lines jl JOIN finance_accounts fa ON fa.id=jl.account_id '+
      'WHERE jl.journal_entry_id=$1 ORDER BY jl.id',[id])).rows;
    return{entry,lines};
  });

  app.post('/api/finance/journals',async(request,reply)=>{
    const a=await authorize(request,db,config,'finance.post');
    const b=z.object({entryDate:z.string().date(),description:z.string().min(2).max(1000),reference:z.string().max(160).optional(),
      lines:z.array(z.object({accountId:z.string().uuid(),debit:z.number().min(0).default(0),credit:z.number().min(0).default(0),description:z.string().max(500).optional()})).min(2).max(50)}).parse(request.body);
    const entry=await tx(db,(client:any)=>postFinanceJournal(client,{organisationId:a.core.organisation_id,entryDate:b.entryDate,description:b.description,
      reference:b.reference??null,actorOsUserId:a.core.id,lines:b.lines}));
    await audit(a.core.organisation_id,a.core.id,'finance.journal_posted','finance_journal_entry',entry.id);
    return reply.code(201).send(entry);
  });

  app.get('/api/finance/expenses',async request=>{
    const a=await authorize(request,db,config,'finance.view');
    const q=z.object({start:z.string().date().optional(),end:z.string().date().optional(),q:z.string().max(100).optional()}).parse(request.query);
    const like=q.q?'%'+q.q+'%':null;
    return (await db.query(
      "SELECT e.*,v.name vendor_name,ea.code expense_code,ea.name expense_account,pa.name payment_account FROM finance_expenses e "+
      "LEFT JOIN finance_vendors v ON v.id=e.vendor_id JOIN finance_accounts ea ON ea.id=e.expense_account_id "+
      "JOIN finance_accounts pa ON pa.id=e.payment_account_id WHERE e.organisation_id=$1 "+
      "AND ($2::date IS NULL OR e.expense_date>=$2) AND ($3::date IS NULL OR e.expense_date<=$3) "+
      "AND ($4::text IS NULL OR e.expense_no ILIKE $4 OR e.description ILIKE $4 OR COALESCE(e.reference,'') ILIKE $4 OR COALESCE(v.name,'') ILIKE $4) "+
      "ORDER BY e.expense_date DESC,e.created_at DESC",[a.core.organisation_id,q.start??null,q.end??null,like])).rows;
  });

  app.post('/api/finance/expenses',async(request,reply)=>{
    const a=await authorize(request,db,config,'finance.post');
    const b=z.object({expenseDate:z.string().date(),vendorId:z.string().uuid().nullable().optional(),expenseAccountId:z.string().uuid(),
      paymentAccountId:z.string().uuid(),amount:z.number().positive(),taxAmount:z.number().min(0).default(0),description:z.string().min(2).max(1200),
      reference:z.string().max(160).optional()}).parse(request.body);
    const result=await tx(db,async(client:any)=>{
      const expenseAccount=await one(client,"SELECT * FROM finance_accounts WHERE id=$1 AND organisation_id=$2 AND account_type='expense' AND is_active=true",
        [b.expenseAccountId,a.core.organisation_id]) as any;
      const paymentAccount=await one(client,"SELECT * FROM finance_accounts WHERE id=$1 AND organisation_id=$2 AND account_type='asset' AND is_active=true",
        [b.paymentAccountId,a.core.organisation_id]) as any;
      const expenseNo='EXP-'+Date.now().toString(36).toUpperCase()+'-'+Math.random().toString(36).slice(2,8).toUpperCase();
      const row=await one(client,
        "INSERT INTO finance_expenses(organisation_id,expense_no,expense_date,vendor_id,expense_account_id,payment_account_id,amount,tax_amount,description,reference,status,created_by_os_user_id) "+
        "VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,'posted',$11) RETURNING *",
        [a.core.organisation_id,expenseNo,b.expenseDate,b.vendorId??null,expenseAccount.id,paymentAccount.id,b.amount,b.taxAmount,b.description,b.reference??null,a.core.id]) as any;
      const total=Number(b.amount)+Number(b.taxAmount);
      const entry=await postFinanceJournal(client,{organisationId:a.core.organisation_id,entryDate:b.expenseDate,description:b.description,
        sourceType:'expense',sourceId:row.id,reference:b.reference??expenseNo,actorOsUserId:a.core.id,
        lines:[{accountId:expenseAccount.id,debit:total},{accountId:paymentAccount.id,credit:total}]});
      return one(client,'UPDATE finance_expenses SET journal_entry_id=$1 WHERE id=$2 RETURNING *',[entry.id,row.id]);
    });
    await audit(a.core.organisation_id,a.core.id,'finance.expense_posted','finance_expense',(result as any).id,{amount:b.amount,taxAmount:b.taxAmount});
    return reply.code(201).send(result);
  });

  app.post('/api/finance/expenses/:id/void',async request=>{
    const a=await authorize(request,db,config,'finance.reverse');
    const {id}=z.object({id:z.string().uuid()}).parse(request.params);
    const b=z.object({originalReference:z.string().trim().min(2).max(160),reason:z.string().trim().min(2).max(1000)}).parse(request.body);
    const row=await tx(db,async(client:any)=>{
      const expense=await one(client,"SELECT * FROM finance_expenses WHERE id=$1 AND organisation_id=$2 AND status='posted' FOR UPDATE",[id,a.core.organisation_id]) as any;
      const expected=String(expense.reference||expense.expense_no||'').trim().toLowerCase();
      if(String(b.originalReference).trim().toLowerCase()!==expected)throw fail(409,'Original transaction reference does not match this expense');
      if(expense.journal_entry_id)await reverseFinanceJournal(client,a.core.organisation_id,expense.journal_entry_id,a.core.id,b.reason,'expense_void',expense.id);
      return one(client,"UPDATE finance_expenses SET status='voided',updated_at=now() WHERE id=$1 RETURNING *",[id]);
    });
    await audit(a.core.organisation_id,a.core.id,'finance.expense_voided','finance_expense',id,{reason:b.reason,originalReference:b.originalReference});
    return row;
  });

  app.get('/api/finance/taxes',async request=>{
    const a=await authorize(request,db,config,'tax.view');
    const types=(await db.query('SELECT * FROM finance_tax_types WHERE organisation_id=$1 ORDER BY is_active DESC,name',[a.core.organisation_id])).rows;
    const obligations=(await db.query(
      'SELECT o.*,t.code tax_code,t.name tax_name,t.authority FROM finance_tax_obligations o JOIN finance_tax_types t ON t.id=o.tax_type_id '+
      'WHERE o.organisation_id=$1 ORDER BY o.due_date DESC,o.created_at DESC',[a.core.organisation_id])).rows;
    const payments=(await db.query(
      'SELECT p.*,t.code tax_code,t.name tax_name,o.period_start,o.period_end FROM finance_tax_payments p '+
      'JOIN finance_tax_obligations o ON o.id=p.obligation_id JOIN finance_tax_types t ON t.id=o.tax_type_id '+
      'WHERE p.organisation_id=$1 ORDER BY p.payment_date DESC,p.created_at DESC',[a.core.organisation_id])).rows;
    return{types,obligations,payments};
  });

  app.post('/api/finance/tax-types',async(request,reply)=>{
    const a=await authorize(request,db,config,'tax.manage');
    const b=z.object({code:z.string().trim().min(1).max(40),name:z.string().trim().min(2).max(180),authority:z.string().max(220).optional(),
      rate:z.number().min(0).max(100).nullable().optional(),filingFrequency:z.enum(['monthly','quarterly','annual','other']).default('monthly')}).parse(request.body);
    const payable=await one(db,"SELECT id FROM finance_accounts WHERE organisation_id=$1 AND code='2100'",[a.core.organisation_id]) as any;
    const row=await one(db,
      'INSERT INTO finance_tax_types(organisation_id,code,name,authority,rate,payable_account_id,filing_frequency) VALUES($1,$2,$3,$4,$5,$6,$7) RETURNING *',
      [a.core.organisation_id,b.code.toUpperCase(),b.name,b.authority??null,b.rate??null,payable.id,b.filingFrequency]) as any;
    await audit(a.core.organisation_id,a.core.id,'finance.tax_type_created','finance_tax_type',row.id);
    return reply.code(201).send(row);
  });

  app.patch('/api/finance/tax-types/:id',async request=>{
    const a=await authorize(request,db,config,'tax.manage');
    const {id}=z.object({id:z.string().uuid()}).parse(request.params);
    const b=z.object({name:z.string().trim().min(2).max(180).optional(),authority:z.string().max(220).nullable().optional(),
      rate:z.number().min(0).max(100).nullable().optional(),filingFrequency:z.enum(['monthly','quarterly','annual','other']).optional(),isActive:z.boolean().optional()})
      .refine(v=>Object.keys(v).length>0).parse(request.body);
    const row=await one(db,
      'UPDATE finance_tax_types SET name=COALESCE($1,name),authority=CASE WHEN $2 THEN $3 ELSE authority END,rate=CASE WHEN $4 THEN $5 ELSE rate END,'+
      'filing_frequency=COALESCE($6,filing_frequency),is_active=COALESCE($7,is_active) WHERE id=$8 AND organisation_id=$9 RETURNING *',
      [b.name??null,Object.hasOwn(b,'authority'),b.authority??null,Object.hasOwn(b,'rate'),b.rate??null,b.filingFrequency??null,b.isActive??null,id,a.core.organisation_id]) as any;
    await audit(a.core.organisation_id,a.core.id,'finance.tax_type_updated','finance_tax_type',id);
    return row;
  });

  app.post('/api/finance/tax-obligations',async(request,reply)=>{
    const a=await authorize(request,db,config,'tax.manage');
    const b=z.object({taxTypeId:z.string().uuid(),periodStart:z.string().date(),periodEnd:z.string().date(),dueDate:z.string().date(),
      amountDue:z.number().min(0),filingReference:z.string().max(180).optional(),notes:z.string().max(3000).optional()}).parse(request.body);
    if(b.periodEnd<b.periodStart)throw fail(400,'Tax period end must be after the start date');
    const result=await tx(db,async(client:any)=>{
      const tax=await one(client,'SELECT * FROM finance_tax_types WHERE id=$1 AND organisation_id=$2 AND is_active=true',[b.taxTypeId,a.core.organisation_id]) as any;
      const row=await one(client,
        'INSERT INTO finance_tax_obligations(organisation_id,tax_type_id,period_start,period_end,due_date,amount_due,filing_reference,notes,created_by_os_user_id) '+
        'VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING *',
        [a.core.organisation_id,tax.id,b.periodStart,b.periodEnd,b.dueDate,b.amountDue,b.filingReference??null,b.notes??null,a.core.id]) as any;
      if(Number(b.amountDue)>0){
        const expense=await one(client,"SELECT * FROM finance_accounts WHERE organisation_id=$1 AND code='5600'",[a.core.organisation_id]) as any;
        const payable=tax.payable_account_id?await one(client,'SELECT * FROM finance_accounts WHERE id=$1',[tax.payable_account_id]) as any:
          await one(client,"SELECT * FROM finance_accounts WHERE organisation_id=$1 AND code='2100'",[a.core.organisation_id]) as any;
        await postFinanceJournal(client,{organisationId:a.core.organisation_id,entryDate:b.periodEnd,description:tax.name+' obligation',
          sourceType:'tax_obligation',sourceId:row.id,reference:b.filingReference??null,actorOsUserId:a.core.id,
          lines:[{accountId:expense.id,debit:b.amountDue},{accountId:payable.id,credit:b.amountDue}]});
      }
      return row;
    });
    await audit(a.core.organisation_id,a.core.id,'finance.tax_obligation_created','finance_tax_obligation',(result as any).id,{amountDue:b.amountDue});
    return reply.code(201).send(result);
  });

  app.post('/api/finance/tax-payments',async(request,reply)=>{
    const a=await authorize(request,db,config,'tax.manage');
    const b=z.object({obligationId:z.string().uuid(),paymentDate:z.string().date(),amount:z.number().positive(),paymentAccountId:z.string().uuid(),
      authorityReference:z.string().max(180).optional(),receiptReference:z.string().max(180).optional()}).parse(request.body);
    const result=await tx(db,async(client:any)=>{
      const obligation=await one(client,
        'SELECT o.*,t.name tax_name,t.payable_account_id FROM finance_tax_obligations o JOIN finance_tax_types t ON t.id=o.tax_type_id '+
        'WHERE o.id=$1 AND o.organisation_id=$2 FOR UPDATE',[b.obligationId,a.core.organisation_id]) as any;
      const outstanding=Number(obligation.amount_due)-Number(obligation.amount_paid);
      if(b.amount>outstanding+0.001)throw fail(400,'Tax payment cannot exceed the outstanding obligation');
      const paymentAccount=await one(client,"SELECT * FROM finance_accounts WHERE id=$1 AND organisation_id=$2 AND account_type='asset' AND is_active=true",
        [b.paymentAccountId,a.core.organisation_id]) as any;
      const payable=obligation.payable_account_id?await one(client,'SELECT * FROM finance_accounts WHERE id=$1',[obligation.payable_account_id]) as any:
        await one(client,"SELECT * FROM finance_accounts WHERE organisation_id=$1 AND code='2100'",[a.core.organisation_id]) as any;
      const payment=await one(client,
        'INSERT INTO finance_tax_payments(organisation_id,obligation_id,payment_date,amount,payment_account_id,authority_reference,receipt_reference,created_by_os_user_id) '+
        'VALUES($1,$2,$3,$4,$5,$6,$7,$8) RETURNING *',
        [a.core.organisation_id,b.obligationId,b.paymentDate,b.amount,paymentAccount.id,b.authorityReference??null,b.receiptReference??null,a.core.id]) as any;
      const entry=await postFinanceJournal(client,{organisationId:a.core.organisation_id,entryDate:b.paymentDate,description:obligation.tax_name+' payment',
        sourceType:'tax_payment',sourceId:payment.id,reference:b.authorityReference??b.receiptReference??null,actorOsUserId:a.core.id,
        lines:[{accountId:payable.id,debit:b.amount},{accountId:paymentAccount.id,credit:b.amount}]});
      await client.query('UPDATE finance_tax_payments SET journal_entry_id=$1 WHERE id=$2',[entry.id,payment.id]);
      const paid=Number(obligation.amount_paid)+Number(b.amount),status=paid>=Number(obligation.amount_due)?'paid':'part_paid';
      await client.query('UPDATE finance_tax_obligations SET amount_paid=$1,status=$2,updated_at=now() WHERE id=$3',[paid,status,obligation.id]);
      return payment;
    });
    await audit(a.core.organisation_id,a.core.id,'finance.tax_payment_posted','finance_tax_payment',(result as any).id,{amount:b.amount});
    return reply.code(201).send(result);
  });

  app.get('/api/finance/budgets',async request=>{
    const a=await authorize(request,db,config,'finance.view');
    return (await db.query(
      'SELECT b.*,fa.code account_code,fa.name account_name,fa.account_type,y.name academic_year FROM finance_budgets b '+
      'JOIN finance_accounts fa ON fa.id=b.account_id LEFT JOIN academic_years y ON y.id=b.academic_year_id '+
      'WHERE b.organisation_id=$1 ORDER BY b.period_start DESC,fa.code',[a.core.organisation_id])).rows;
  });

  app.post('/api/finance/budgets',async(request,reply)=>{
    const a=await authorize(request,db,config,'finance.manage');
    const b=z.object({academicYearId:z.string().uuid().nullable().optional(),accountId:z.string().uuid(),periodStart:z.string().date(),
      periodEnd:z.string().date(),amount:z.number().min(0),notes:z.string().max(2000).optional()}).parse(request.body);
    if(b.periodEnd<b.periodStart)throw fail(400,'Budget end date must be after start date');
    const row=await one(db,
      'INSERT INTO finance_budgets(organisation_id,academic_year_id,account_id,period_start,period_end,amount,notes,created_by_os_user_id) '+
      'VALUES($1,$2,$3,$4,$5,$6,$7,$8) RETURNING *',
      [a.core.organisation_id,b.academicYearId??null,b.accountId,b.periodStart,b.periodEnd,b.amount,b.notes??null,a.core.id]) as any;
    await audit(a.core.organisation_id,a.core.id,'finance.budget_created','finance_budget',row.id,{amount:b.amount});
    return reply.code(201).send(row);
  });

  app.get('/api/finance/reports/:report',async request=>{
    const a=await authorize(request,db,config,'finance.report');
    const {report}=z.object({report:z.enum(['income-statement','trial-balance','cashflow','tax-summary','expense-analysis','balance-sheet','receivables-aging','fee-collections','budget-variance','general-ledger'])}).parse(request.params);
    const q=z.object({start:z.string().date().optional(),end:z.string().date().optional()}).parse(request.query);
    const start=q.start??new Date(new Date().getFullYear(),0,1).toISOString().slice(0,10);
    const end=q.end??new Date().toISOString().slice(0,10);
    if(report==='income-statement'){
      const rows=(await db.query(
        "SELECT fa.code,fa.name,fa.account_type,CASE WHEN fa.account_type='income' THEN COALESCE(sum(CASE WHEN je.id IS NOT NULL THEN jl.credit-jl.debit ELSE 0 END),0) "+
        "ELSE COALESCE(sum(CASE WHEN je.id IS NOT NULL THEN jl.debit-jl.credit ELSE 0 END),0) END amount FROM finance_accounts fa "+
        "LEFT JOIN finance_journal_lines jl ON jl.account_id=fa.id LEFT JOIN finance_journal_entries je ON je.id=jl.journal_entry_id "+
        "AND je.status='posted' AND je.entry_date BETWEEN $2 AND $3 WHERE fa.organisation_id=$1 AND fa.account_type IN('income','expense') "+
        "GROUP BY fa.id ORDER BY fa.account_type DESC,fa.code",[a.core.organisation_id,start,end])).rows;
      const income=rows.filter((x:any)=>x.account_type==='income').reduce((s:number,x:any)=>s+Number(x.amount),0);
      const expenses=rows.filter((x:any)=>x.account_type==='expense').reduce((s:number,x:any)=>s+Number(x.amount),0);
      return{report,period:{start,end},rows,income,expenses,surplus:income-expenses};
    }
    if(report==='trial-balance'){
      const rows=(await db.query(
        "SELECT fa.code,fa.name,fa.account_type,COALESCE(sum(CASE WHEN je.id IS NOT NULL THEN jl.debit ELSE 0 END),0) debit,COALESCE(sum(CASE WHEN je.id IS NOT NULL THEN jl.credit ELSE 0 END),0) credit "+
        "FROM finance_accounts fa LEFT JOIN finance_journal_lines jl ON jl.account_id=fa.id "+
        "LEFT JOIN finance_journal_entries je ON je.id=jl.journal_entry_id AND je.status='posted' AND je.entry_date<=$2 "+
        "WHERE fa.organisation_id=$1 GROUP BY fa.id ORDER BY fa.code",[a.core.organisation_id,end])).rows;
      return{report,asOf:end,rows,totalDebit:rows.reduce((s:number,x:any)=>s+Number(x.debit),0),totalCredit:rows.reduce((s:number,x:any)=>s+Number(x.credit),0)};
    }
    if(report==='cashflow'){
      const rows=(await db.query(
        "SELECT fa.code,fa.name,COALESCE(sum(CASE WHEN je.id IS NOT NULL THEN jl.debit-jl.credit ELSE 0 END),0) net_movement FROM finance_accounts fa "+
        "LEFT JOIN finance_journal_lines jl ON jl.account_id=fa.id LEFT JOIN finance_journal_entries je ON je.id=jl.journal_entry_id "+
        "AND je.status='posted' AND je.entry_date BETWEEN $2 AND $3 WHERE fa.organisation_id=$1 AND fa.is_cash_account=true "+
        "GROUP BY fa.id ORDER BY fa.code",[a.core.organisation_id,start,end])).rows;
      return{report,period:{start,end},rows,netCashMovement:rows.reduce((s:number,x:any)=>s+Number(x.net_movement),0)};
    }
    if(report==='tax-summary'){
      const rows=(await db.query(
        "SELECT t.code,t.name,t.authority,COALESCE(sum(o.amount_due),0) amount_due,COALESCE(sum(o.amount_paid),0) amount_paid,"+
        "COALESCE(sum(o.amount_due-o.amount_paid),0) outstanding FROM finance_tax_types t LEFT JOIN finance_tax_obligations o "+
        "ON o.tax_type_id=t.id AND o.status<>'cancelled' AND o.period_end BETWEEN $2 AND $3 WHERE t.organisation_id=$1 GROUP BY t.id ORDER BY t.code",
        [a.core.organisation_id,start,end])).rows;
      return{report,period:{start,end},rows};
    }
    if(report==='balance-sheet'){
      const rows=(await db.query(
        "SELECT fa.code,fa.name,fa.account_type,fa.opening_balance,"+
        "CASE WHEN fa.account_type='asset' THEN fa.opening_balance+COALESCE(sum(CASE WHEN je.id IS NOT NULL THEN jl.debit-jl.credit ELSE 0 END),0) "+
        "ELSE fa.opening_balance+COALESCE(sum(CASE WHEN je.id IS NOT NULL THEN jl.credit-jl.debit ELSE 0 END),0) END balance "+
        "FROM finance_accounts fa LEFT JOIN finance_journal_lines jl ON jl.account_id=fa.id "+
        "LEFT JOIN finance_journal_entries je ON je.id=jl.journal_entry_id AND je.status='posted' AND je.entry_date<=$2 "+
        "WHERE fa.organisation_id=$1 AND fa.account_type IN('asset','liability','equity') GROUP BY fa.id ORDER BY fa.account_type,fa.code",
        [a.core.organisation_id,end])).rows;
      const assets=rows.filter((x:any)=>x.account_type==='asset').reduce((s:number,x:any)=>s+Number(x.balance),0);
      const liabilities=rows.filter((x:any)=>x.account_type==='liability').reduce((s:number,x:any)=>s+Number(x.balance),0);
      const equityBase=rows.filter((x:any)=>x.account_type==='equity').reduce((s:number,x:any)=>s+Number(x.balance),0);
      const retained=await one(db,
        "SELECT COALESCE(sum(CASE WHEN fa.account_type='income' THEN jl.credit-jl.debit WHEN fa.account_type='expense' THEN -(jl.debit-jl.credit) ELSE 0 END),0) retained "+
        "FROM finance_journal_lines jl JOIN finance_journal_entries je ON je.id=jl.journal_entry_id JOIN finance_accounts fa ON fa.id=jl.account_id "+
        "WHERE je.organisation_id=$1 AND je.status='posted' AND je.entry_date<=$2 AND fa.account_type IN('income','expense')",
        [a.core.organisation_id,end]) as any;
      return{report,asOf:end,rows,assets,liabilities,equity:equityBase+Number(retained.retained),retainedSurplus:Number(retained.retained)};
    }
    if(report==='receivables-aging'){
      const rows=(await db.query(
        "SELECT s.id student_id,s.admission_no,s.first_name,s.last_name,c.name classroom_name,"+
        "sum((sf.amount_due-sf.discount)-COALESCE(p.paid,0)) outstanding,"+
        "min(COALESCE(t.end_date,ay.end_date,sf.created_at::date)) earliest_due_date "+
        "FROM student_fees sf JOIN students s ON s.id=sf.student_id JOIN fee_items f ON f.id=sf.fee_item_id "+
        "LEFT JOIN academic_years ay ON ay.id=f.academic_year_id LEFT JOIN terms t ON t.id=f.term_id "+
        "LEFT JOIN enrolments en ON en.student_id=s.id AND en.status='active' LEFT JOIN classrooms c ON c.id=en.classroom_id "+
        "LEFT JOIN (SELECT student_fee_id,sum(amount) FILTER(WHERE voided_at IS NULL) paid FROM payments GROUP BY student_fee_id) p ON p.student_fee_id=sf.id "+
        "WHERE sf.organisation_id=$1 GROUP BY s.id,c.name HAVING sum((sf.amount_due-sf.discount)-COALESCE(p.paid,0))>0 ORDER BY outstanding DESC",
        [a.core.organisation_id])).rows;
      const today=new Date(end+'T00:00:00Z').getTime();
      const enriched=rows.map((x:any)=>{const due=x.earliest_due_date?new Date(String(x.earliest_due_date).slice(0,10)+'T00:00:00Z').getTime():today;
        const days=Math.floor((today-due)/86400000);return{...x,age_days:Math.max(0,days),bucket:days<=0?'current':days<=30?'1-30':days<=60?'31-60':days<=90?'61-90':'90+'}});
      return{report,asOf:end,rows:enriched,total:enriched.reduce((s:number,x:any)=>s+Number(x.outstanding),0)};
    }
    if(report==='fee-collections'){
      const rows=(await db.query(
        "SELECT p.payment_method,count(*)::int transactions,COALESCE(sum(p.amount),0) amount "+
        "FROM payments p WHERE p.organisation_id=$1 AND p.voided_at IS NULL AND p.paid_at::date BETWEEN $2 AND $3 GROUP BY p.payment_method ORDER BY amount DESC",
        [a.core.organisation_id,start,end])).rows;
      const daily=(await db.query(
        "SELECT p.paid_at::date day,COALESCE(sum(p.amount),0) amount,count(*)::int transactions FROM payments p "+
        "WHERE p.organisation_id=$1 AND p.voided_at IS NULL AND p.paid_at::date BETWEEN $2 AND $3 GROUP BY p.paid_at::date ORDER BY day",
        [a.core.organisation_id,start,end])).rows;
      return{report,period:{start,end},rows,daily,total:rows.reduce((s:number,x:any)=>s+Number(x.amount),0)};
    }
    if(report==='budget-variance'){
      const rows=(await db.query(
        "SELECT b.id,fa.code,fa.name,fa.account_type,b.period_start,b.period_end,b.amount budget_amount,"+
        "CASE WHEN fa.account_type='income' THEN COALESCE(sum(CASE WHEN je.id IS NOT NULL THEN jl.credit-jl.debit ELSE 0 END),0) ELSE COALESCE(sum(CASE WHEN je.id IS NOT NULL THEN jl.debit-jl.credit ELSE 0 END),0) END actual_amount "+
        "FROM finance_budgets b JOIN finance_accounts fa ON fa.id=b.account_id "+
        "LEFT JOIN finance_journal_lines jl ON jl.account_id=fa.id LEFT JOIN finance_journal_entries je ON je.id=jl.journal_entry_id "+
        "AND je.status='posted' AND je.entry_date BETWEEN GREATEST(b.period_start,$2::date) AND LEAST(b.period_end,$3::date) "+
        "WHERE b.organisation_id=$1 AND b.period_end>=$2::date AND b.period_start<=$3::date GROUP BY b.id,fa.id ORDER BY fa.code",
        [a.core.organisation_id,start,end])).rows;
      return{report,period:{start,end},rows:rows.map((x:any)=>({...x,variance:Number(x.actual_amount)-Number(x.budget_amount)}))};
    }
    if(report==='general-ledger'){
      const rows=(await db.query(
        "SELECT je.entry_date,je.entry_no,je.description,je.reference,fa.code account_code,fa.name account_name,jl.description line_description,jl.debit,jl.credit "+
        "FROM finance_journal_entries je JOIN finance_journal_lines jl ON jl.journal_entry_id=je.id JOIN finance_accounts fa ON fa.id=jl.account_id "+
        "WHERE je.organisation_id=$1 AND je.status='posted' AND je.entry_date BETWEEN $2 AND $3 ORDER BY je.entry_date,je.entry_no,fa.code",
        [a.core.organisation_id,start,end])).rows;
      return{report,period:{start,end},rows,totalDebit:rows.reduce((s:number,x:any)=>s+Number(x.debit),0),totalCredit:rows.reduce((s:number,x:any)=>s+Number(x.credit),0)};
    }
    const rows=(await db.query(
      "SELECT fa.code,fa.name,COALESCE(sum(e.amount+e.tax_amount),0) amount,count(e.id)::int transactions FROM finance_accounts fa "+
      "LEFT JOIN finance_expenses e ON e.expense_account_id=fa.id AND e.status='posted' AND e.expense_date BETWEEN $2 AND $3 "+
      "WHERE fa.organisation_id=$1 AND fa.account_type='expense' GROUP BY fa.id ORDER BY amount DESC",[a.core.organisation_id,start,end])).rows;
    return{report,period:{start,end},rows,total:rows.reduce((s:number,x:any)=>s+Number(x.amount),0)};
  });

  app.post('/api/finance/backfill-student-payments',async request=>{
    const a=await authorize(request,db,config,'finance.manage');
    const feeRows=(await db.query(
      "SELECT sf.id FROM student_fees sf WHERE sf.organisation_id=$1 AND NOT EXISTS("+
      "SELECT 1 FROM finance_journal_entries je WHERE je.organisation_id=sf.organisation_id AND je.source_type='student_fee' "+
      "AND je.source_id=sf.id AND je.status='posted') ORDER BY sf.created_at",[a.core.organisation_id])).rows;
    const paymentRows=(await db.query(
      "SELECT p.id FROM payments p WHERE p.organisation_id=$1 AND p.voided_at IS NULL AND NOT EXISTS("+
      "SELECT 1 FROM finance_journal_entries je WHERE je.organisation_id=p.organisation_id AND je.source_type='student_payment' "+
      "AND je.source_id=p.id AND je.status='posted') ORDER BY p.paid_at",[a.core.organisation_id])).rows;
    let receivablesPosted=0,paymentsPosted=0;
    await tx(db,async(client:any)=>{
      for(const row of feeRows){await postStudentFeeReceivable(client,row.id,a.core.id);receivablesPosted++}
      for(const row of paymentRows){await postStudentPaymentLedger(client,row.id,a.core.id);paymentsPosted++}
    });
    await audit(a.core.organisation_id,a.core.id,'finance.school_fees_backfilled','finance_journal_entry',null,{receivablesPosted,paymentsPosted});
    return{posted:receivablesPosted+paymentsPosted,receivablesPosted,paymentsPosted};
  });

  function datesBetween(start:string,end:string){
    const out:string[]=[];let d0=new Date(start+'T00:00:00Z'),d1=new Date(end+'T00:00:00Z');
    while(d0<=d1){out.push(d0.toISOString().slice(0,10));d0=new Date(d0.getTime()+86400000)}
    return out;
  }
  function schoolDay(date:string){const day=new Date(date+'T00:00:00Z').getUTCDay();return day>=1&&day<=5?day:null}

  async function buildReliefPlan(org:string,applicant:string,start:string,end:string,requested:string[]){
    const candidateIds=[...new Set(requested)].filter(id=>id!==applicant);
    if(!candidateIds.length)throw fail(400,'Select at least one relief teacher different from the applicant');
    const eligible=(await db.query(
      "SELECT sm.os_user_id FROM school_memberships sm JOIN school_roles sr ON sr.organisation_id=sm.organisation_id AND sr.key=sm.role "+
      "WHERE sm.organisation_id=$1 AND sm.os_user_id=ANY($2::uuid[]) AND sm.status='active' AND sr.is_active=true AND sr.can_teach=true",
      [org,candidateIds])).rows.map((x:any)=>x.os_user_id);
    if(eligible.length!==candidateIds.length)throw fail(409,'Every selected reliever must be an active user with a teaching role');
    const timetable=(await db.query('SELECT * FROM timetable_entries WHERE organisation_id=$1 AND teacher_os_user_id=$2 ORDER BY day_of_week,start_time',
      [org,applicant])).rows;
    const coverage:any[]=[],uncovered:any[]=[],load=new Map<string,number>();
    for(const date of datesBetween(start,end)){
      const day=schoolDay(date);if(!day)continue;
      for(const slot of timetable.filter((x:any)=>Number(x.day_of_week)===day)){
        const available:string[]=[];
        for(const reliever of eligible){
          const own=await maybeOne(db,
            'SELECT 1 FROM timetable_entries WHERE organisation_id=$1 AND teacher_os_user_id=$2 AND day_of_week=$3 AND start_time<$5::time AND end_time>$4::time LIMIT 1',
            [org,reliever,day,slot.start_time,slot.end_time]);
          if(own)continue;
          const leave=await maybeOne(db,
            "SELECT 1 FROM staff_leave_requests WHERE organisation_id=$1 AND applicant_os_user_id=$2 AND status='approved' AND start_date<=$3::date AND end_date>=$3::date LIMIT 1",
            [org,reliever,date]);
          if(leave)continue;
          const relief=await maybeOne(db,
            "SELECT 1 FROM staff_leave_relief_schedule rs JOIN staff_leave_requests lr ON lr.id=rs.leave_request_id "+
            "WHERE lr.organisation_id=$1 AND rs.reliever_os_user_id=$2 AND rs.coverage_date=$3::date "+
            "AND rs.start_time<$5::time AND rs.end_time>$4::time AND lr.status IN('submitted','approved') LIMIT 1",
            [org,reliever,date,slot.start_time,slot.end_time]);
          if(relief)continue;
          available.push(reliever);
        }
        if(!available.length){uncovered.push({date,startTime:slot.start_time,endTime:slot.end_time,classroomId:slot.classroom_id,subjectId:slot.subject_id});continue}
        available.sort((x,y)=>(load.get(x)||0)-(load.get(y)||0));
        const chosen=available[0]!;
        load.set(chosen,(load.get(chosen)||0)+1);
        coverage.push({date,timetableEntryId:slot.id,classroomId:slot.classroom_id,subjectId:slot.subject_id,
          originalTeacherOsUserId:applicant,relieverOsUserId:chosen,startTime:slot.start_time,endTime:slot.end_time});
      }
    }
    return{coverage,uncovered,relieverIds:eligible};
  }

  app.get('/api/leave/eligible-relievers',async request=>{
    const a=await authorize(request,db,config,'leave.view');
    const q=z.object({applicantOsUserId:z.preprocess(v=>typeof v==='string'&&v.trim()===''?undefined:v,z.string().uuid().optional())}).parse(request.query);
    const users=await fetchCoreUsers(a.core.organisation_id);
    const teaching=(await db.query(
      "SELECT sm.os_user_id,sm.role,sr.name role_name FROM school_memberships sm JOIN school_roles sr "+
      "ON sr.organisation_id=sm.organisation_id AND sr.key=sm.role WHERE sm.organisation_id=$1 AND sm.status='active' AND sr.is_active=true AND sr.can_teach=true",
      [a.core.organisation_id])).rows;
    return teaching.filter((x:any)=>x.os_user_id!==(q.applicantOsUserId??a.core.id)).map((x:any)=>{
      const u=users.find((z:any)=>z.id===x.os_user_id)||{};
      return{...x,first_name:u.first_name||'',last_name:u.last_name||'',email:u.email||null,job_title:u.job_title||x.role_name};
    });
  });

  app.get('/api/leave/requests',async request=>{
    const a=await authorize(request,db,config,'leave.view');
    const canReview=a.role==='school_admin'||Boolean((await maybeOne(db,
      'SELECT allowed FROM school_role_capabilities WHERE organisation_id=$1 AND role=$2 AND capability_key=$3',
      [a.core.organisation_id,a.role,'leave.review']) as any)?.allowed);
    const q=z.object({status:z.enum(['draft','submitted','approved','declined','cancelled','completed']).optional(),q:z.string().max(100).optional()}).parse(request.query);
    const like=q.q?'%'+q.q+'%':null;
    const rows=(await db.query(
      "SELECT lr.*,COALESCE((SELECT jsonb_agg(jsonb_build_object('relieverOsUserId',r.reliever_os_user_id,'priority',r.priority) ORDER BY r.priority) "+
      "FROM staff_leave_relievers r WHERE r.leave_request_id=lr.id),'[]'::jsonb) relievers,"+
      "(SELECT count(*)::int FROM staff_leave_relief_schedule s WHERE s.leave_request_id=lr.id) coverage_count "+
      "FROM staff_leave_requests lr WHERE lr.organisation_id=$1 AND ($2::boolean=true OR lr.applicant_os_user_id=$3) "+
      "AND ($4::text IS NULL OR lr.status=$4) AND ($5::text IS NULL OR lr.leave_type ILIKE $5 OR lr.reason ILIKE $5) ORDER BY lr.created_at DESC",
      [a.core.organisation_id,canReview,a.core.id,q.status??null,like])).rows;
    const users=await fetchCoreUsers(a.core.organisation_id);
    return rows.map((r:any)=>{
      const u=users.find((x:any)=>x.id===r.applicant_os_user_id)||{};
      return{...r,applicant_name:((u.first_name||'')+' '+(u.last_name||'')).trim(),applicant_email:u.email||null};
    });
  });

  app.get('/api/leave/requests/:id',async request=>{
    const a=await authorize(request,db,config,'leave.view');
    const {id}=z.object({id:z.string().uuid()}).parse(request.params);
    const leave=await one(db,'SELECT * FROM staff_leave_requests WHERE id=$1 AND organisation_id=$2',[id,a.core.organisation_id]) as any;
    const canReview=a.role==='school_admin'||Boolean((await maybeOne(db,
      'SELECT allowed FROM school_role_capabilities WHERE organisation_id=$1 AND role=$2 AND capability_key=$3',
      [a.core.organisation_id,a.role,'leave.review']) as any)?.allowed);
    if(!canReview&&leave.applicant_os_user_id!==a.core.id)throw fail(403,'You can only view your own leave requests');
    const relievers=(await db.query('SELECT * FROM staff_leave_relievers WHERE leave_request_id=$1 ORDER BY priority',[id])).rows;
    const coverage=(await db.query(
      'SELECT rs.*,c.name classroom_name,s.name subject_name FROM staff_leave_relief_schedule rs LEFT JOIN classrooms c ON c.id=rs.classroom_id '+
      'LEFT JOIN subjects s ON s.id=rs.subject_id WHERE rs.leave_request_id=$1 ORDER BY rs.coverage_date,rs.start_time',[id])).rows;
    return{leave,relievers,coverage};
  });

  app.post('/api/leave/requests',async(request,reply)=>{
    const a=await authorize(request,db,config,'leave.apply');
    const b=z.object({applicantOsUserId:z.string().uuid().optional(),
      leaveType:z.enum(['annual','sick','maternity','paternity','study','compassionate','official','other']),
      startDate:z.string().date(),endDate:z.string().date(),reason:z.string().trim().min(3).max(5000),
      relieverOsUserIds:z.array(z.string().uuid()).min(1).max(10)}).parse(request.body);
    if(b.endDate<b.startDate)throw fail(400,'Leave end date must be after the start date');
    const applicant=b.applicantOsUserId??a.core.id;
    if(applicant!==a.core.id){
      const allowed=await maybeOne(db,'SELECT allowed FROM school_role_capabilities WHERE organisation_id=$1 AND role=$2 AND capability_key=$3',
        [a.core.organisation_id,a.role,'leave.apply_on_behalf']) as any;
      if(a.role!=='school_admin'&&!allowed?.allowed)throw fail(403,'You cannot apply for leave on behalf of another user');
    }
    const member=await one(db,
      'SELECT sm.*,sr.can_teach FROM school_memberships sm JOIN school_roles sr ON sr.organisation_id=sm.organisation_id AND sr.key=sm.role '+
      "WHERE sm.organisation_id=$1 AND sm.os_user_id=$2 AND sm.status='active'",[a.core.organisation_id,applicant]) as any;
    if(!member.can_teach)throw fail(409,'Leave relief scheduling requires the applicant to have a teaching role');
    const overlap=await maybeOne(db,
      "SELECT id FROM staff_leave_requests WHERE organisation_id=$1 AND applicant_os_user_id=$2 AND status IN('submitted','approved') "+
      'AND start_date<=$4::date AND end_date>=$3::date LIMIT 1',[a.core.organisation_id,applicant,b.startDate,b.endDate]);
    if(overlap)throw fail(409,'This user already has overlapping leave');
    const plan=await buildReliefPlan(a.core.organisation_id,applicant,b.startDate,b.endDate,b.relieverOsUserIds);
    if(plan.uncovered.length)throw fail(409,'The selected reliever(s) cannot cover '+plan.uncovered.length+' timetable period(s). Select additional relievers.');
    const result=await tx(db,async(client:any)=>{
      const leave=await one(client,
        "INSERT INTO staff_leave_requests(organisation_id,applicant_os_user_id,leave_type,start_date,end_date,reason,status,submitted_on_behalf_by_os_user_id) "+
        "VALUES($1,$2,$3,$4,$5,$6,'submitted',$7) RETURNING *",
        [a.core.organisation_id,applicant,b.leaveType,b.startDate,b.endDate,b.reason,applicant===a.core.id?null:a.core.id]) as any;
      for(let i=0;i<plan.relieverIds.length;i++)await client.query(
        'INSERT INTO staff_leave_relievers(leave_request_id,reliever_os_user_id,priority) VALUES($1,$2,$3)',
        [leave.id,plan.relieverIds[i],i+1]);
      for(const x of plan.coverage)await client.query(
        "INSERT INTO staff_leave_relief_schedule(leave_request_id,coverage_date,timetable_entry_id,classroom_id,subject_id,original_teacher_os_user_id,reliever_os_user_id,start_time,end_time,status) "+
        "VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,'planned')",
        [leave.id,x.date,x.timetableEntryId,x.classroomId,x.subjectId,x.originalTeacherOsUserId,x.relieverOsUserId,x.startTime,x.endTime]);
      return leave;
    });
    await audit(a.core.organisation_id,a.core.id,'leave.submitted','staff_leave_request',(result as any).id,{applicantOsUserId:applicant,coverage:plan.coverage.length});
    return reply.code(201).send({...result,coverageCount:plan.coverage.length});
  });

  app.post('/api/leave/requests/:id/review',async request=>{
    const a=await authorize(request,db,config,'leave.review');
    const {id}=z.object({id:z.string().uuid()}).parse(request.params);
    const b=z.object({action:z.enum(['approve','decline']),note:z.string().max(3000).optional()}).parse(request.body);
    const current=await one(db,"SELECT * FROM staff_leave_requests WHERE id=$1 AND organisation_id=$2 AND status='submitted'",
      [id,a.core.organisation_id]) as any;
    const status=b.action==='approve'?'approved':'declined';
    const row=await one(db,
      'UPDATE staff_leave_requests SET status=$1,reviewed_by_os_user_id=$2,reviewed_at=now(),review_note=$3,updated_at=now() WHERE id=$4 RETURNING *',
      [status,a.core.id,b.note??null,id]) as any;
    if(status==='declined')await db.query("UPDATE staff_leave_relief_schedule SET status='cancelled' WHERE leave_request_id=$1",[id]);
    await audit(a.core.organisation_id,a.core.id,'leave.'+status,'staff_leave_request',id,{applicantOsUserId:current.applicant_os_user_id});
    return row;
  });

  app.post('/api/leave/requests/:id/cancel',async request=>{
    const a=await authorize(request,db,config,'leave.apply');
    const {id}=z.object({id:z.string().uuid()}).parse(request.params);
    const current=await one(db,'SELECT * FROM staff_leave_requests WHERE id=$1 AND organisation_id=$2',[id,a.core.organisation_id]) as any;
    if(current.applicant_os_user_id!==a.core.id&&a.role!=='school_admin')throw fail(403,'You cannot cancel this leave request');
    if(!['submitted','approved'].includes(current.status))throw fail(409,'This leave request cannot be cancelled');
    const row=await one(db,"UPDATE staff_leave_requests SET status='cancelled',updated_at=now() WHERE id=$1 RETURNING *",[id]) as any;
    await db.query("UPDATE staff_leave_relief_schedule SET status='cancelled' WHERE leave_request_id=$1",[id]);
    await audit(a.core.organisation_id,a.core.id,'leave.cancelled','staff_leave_request',id);
    return row;
  });

  app.get('/api/leave/my-relief-schedule',async request=>{
    const a=await authorize(request,db,config,'leave.view');
    const q=z.object({start:z.string().date().optional(),end:z.string().date().optional()}).parse(request.query);
    const start=q.start??new Date().toISOString().slice(0,10),end=q.end??new Date(Date.now()+30*86400000).toISOString().slice(0,10);
    return (await db.query(
      "SELECT rs.*,lr.leave_type,c.name classroom_name,s.name subject_name FROM staff_leave_relief_schedule rs "+
      "JOIN staff_leave_requests lr ON lr.id=rs.leave_request_id LEFT JOIN classrooms c ON c.id=rs.classroom_id LEFT JOIN subjects s ON s.id=rs.subject_id "+
      "WHERE lr.organisation_id=$1 AND lr.status='approved' AND rs.status='planned' AND rs.reliever_os_user_id=$2 "+
      "AND rs.coverage_date BETWEEN $3 AND $4 ORDER BY rs.coverage_date,rs.start_time",
      [a.core.organisation_id,a.core.id,start,end])).rows;
  });
}
