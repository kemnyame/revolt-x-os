import { schoolRecordId } from './record-id.js';
import { z } from 'zod';
import {ensurePayrollAccounts,ensureComponentAccount,assertPayrollAccount,registerPayrollWorkflow} from './payroll-workflow.js';
import {renderStaffPayslip} from './payslip.js';
import { createRequire } from 'node:module';
const require=createRequire(import.meta.url);
const PDFDocument:any=require('pdfkit');

export async function registerHrPayrollRoutes(app:any,deps:any){
  const {db,authorize,one,maybeOne,tx,fail,audit,fetchCoreUsers}=deps;

  async function requireRole(a:any,capability:string){
    if(a.role==='school_admin')return;
    const row=await maybeOne(db,'SELECT allowed FROM school_role_capabilities WHERE organisation_id=$1 AND role=$2 AND capability_key=$3',[a.core.organisation_id,a.role,capability]);
    if(!row?.allowed)throw fail(403,'Your School role does not have permission to perform this payroll action');
  }

  app.get('/api/security/settings',async(request:any)=>{
    const a=await authorize(request,db,deps.config);
    await requireRole(a,'security.manage');
    return one(db,`INSERT INTO school_security_settings(organisation_id) VALUES($1)
      ON CONFLICT(organisation_id) DO UPDATE SET organisation_id=EXCLUDED.organisation_id
      RETURNING organisation_id,idle_timeout_minutes,absolute_timeout_minutes,updated_at`,[a.core.organisation_id]);
  });

  app.put('/api/security/settings',async(request:any)=>{
    const a=await authorize(request,db,deps.config);
    await requireRole(a,'security.manage');
    const b=z.object({idleTimeoutMinutes:z.number().int().min(5).max(240),absoluteTimeoutMinutes:z.number().int().min(30).max(1440)}).parse(request.body);
    if(b.absoluteTimeoutMinutes<b.idleTimeoutMinutes)throw fail(400,'Absolute session timeout must be greater than or equal to the idle timeout');
    const row=await one(db,`INSERT INTO school_security_settings(organisation_id,idle_timeout_minutes,absolute_timeout_minutes,updated_by_os_user_id)
      VALUES($1,$2,$3,$4)
      ON CONFLICT(organisation_id) DO UPDATE SET idle_timeout_minutes=EXCLUDED.idle_timeout_minutes,
      absolute_timeout_minutes=EXCLUDED.absolute_timeout_minutes,updated_by_os_user_id=EXCLUDED.updated_by_os_user_id,updated_at=now()
      RETURNING organisation_id,idle_timeout_minutes,absolute_timeout_minutes,updated_at`,[a.core.organisation_id,b.idleTimeoutMinutes,b.absoluteTimeoutMinutes,a.core.id]);
    await audit(a.core.organisation_id,a.core.id,'security.session_settings_updated','school_security_settings',a.core.organisation_id,{idleTimeoutMinutes:b.idleTimeoutMinutes,absoluteTimeoutMinutes:b.absoluteTimeoutMinutes});
    return row;
  });

  app.post('/api/academic-periods/:type/:id/lock',async(request:any)=>{
    const a=await authorize(request,db,deps.config,'academic.edit');
    const p=z.object({type:z.enum(['year','term']),id:schoolRecordId}).parse(request.params);
    const b=z.object({locked:z.boolean(),reason:z.string().trim().min(3).max(500).optional()}).parse(request.body);
    if(!b.locked)await requireRole(a,'security.manage');
    const table=p.type==='year'?'academic_years':'terms';
    const row=await tx(db,async(client:any)=>{
      await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))',['academic:'+a.core.organisation_id]);
      if(p.type==='term'&&!b.locked){const year=await one(client,'SELECT y.is_locked FROM terms t JOIN academic_years y ON y.id=t.academic_year_id WHERE t.id=$1 AND t.organisation_id=$2',[p.id,a.core.organisation_id]);if(year.is_locked)throw fail(423,'Reopen the academic year before reopening its term')}
      const result=await one(client,`UPDATE ${table} SET status=CASE WHEN $1 THEN 'closed' WHEN status='closed' THEN $5 ELSE status END,
        is_locked=$1,locked_at=CASE WHEN $1 THEN now() ELSE NULL END,locked_by_os_user_id=CASE WHEN $1 THEN $2::uuid ELSE NULL END
        WHERE id=$3 AND organisation_id=$4 RETURNING *`,[b.locked,a.core.id,p.id,a.core.organisation_id,p.type==='year'?'draft':'planned']);
      if(p.type==='year'&&b.locked)await client.query("UPDATE terms SET status='closed',is_locked=true,locked_at=now(),locked_by_os_user_id=$1 WHERE academic_year_id=$2 AND organisation_id=$3",[a.core.id,p.id,a.core.organisation_id]);
      return result;
    });
    await audit(a.core.organisation_id,a.core.id,b.locked?'academic_period.locked':'academic_period.reopened',table,p.id,{reason:b.reason??null});
    return row;
  });

  app.get('/api/hr/staff',async(request:any)=>{
    const a=await authorize(request,db,deps.config);
    await requireRole(a,'payroll.view');
    const users=await fetchCoreUsers(a.core.organisation_id).catch(()=>[]);
    const memberships=(await db.query(`SELECT os_user_id,role,status FROM school_memberships WHERE organisation_id=$1 ORDER BY created_at`,[a.core.organisation_id])).rows;
    const profiles=(await db.query(`SELECT * FROM staff_payroll_profiles WHERE organisation_id=$1`,[a.core.organisation_id])).rows;
    const grades=(await db.query(`SELECT id,code,name,base_salary,currency,is_active FROM payroll_grades WHERE organisation_id=$1`,[a.core.organisation_id])).rows;
    const assignments=(await db.query(`SELECT a.*,c.code,c.name,c.component_type,c.calculation_type,c.default_value,c.rate_percent,c.taxable,c.statutory,c.posting_account_id
      FROM staff_payroll_component_assignments a JOIN payroll_components c ON c.id=a.component_id
      WHERE a.organisation_id=$1 AND a.is_active=true AND c.is_active=true ORDER BY c.component_type,c.name`,[a.core.organisation_id])).rows;
    return memberships.map((m:any)=>{
      const u=users.find((x:any)=>x.id===m.os_user_id)||{};
      return{...m,id:m.os_user_id,first_name:u.first_name||'',last_name:u.last_name||'',email:u.email||null,job_title:u.job_title||null,
        staff_id:u.employee_number||u.login_staff_id||null,payroll_profile:profiles.find((x:any)=>x.os_user_id===m.os_user_id)||null,
        payroll_grade:(()=>{const p=profiles.find((x:any)=>x.os_user_id===m.os_user_id);return p?.grade_id?grades.find((g:any)=>g.id===p.grade_id)||null:null})(),
        payroll_components:assignments.filter((x:any)=>x.os_user_id===m.os_user_id)};
    });
  });

  app.get('/api/payroll/components',async(request:any)=>{
    const a=await authorize(request,db,deps.config);
    await requireRole(a,'payroll.view');
    await ensurePayrollAccounts(db,a.core.organisation_id);
    const rows=(await db.query('SELECT * FROM payroll_components WHERE organisation_id=$1 ORDER BY component_type,name',[a.core.organisation_id])).rows;
    for(const row of rows)row.posting_account_id=await ensureComponentAccount(db,a.core.organisation_id,row);
    return rows;
  });

  app.post('/api/payroll/components',async(request:any,reply:any)=>{
    const a=await authorize(request,db,deps.config);await requireRole(a,'payroll.manage');
    const b=z.object({code:z.string().trim().min(2).max(40).transform((x:string)=>x.toUpperCase().replace(/[^A-Z0-9_-]/g,'_')),name:z.string().trim().min(2).max(160),componentType:z.enum(['earning','deduction']),calculationType:z.enum(['fixed','percent_basic']).default('fixed'),defaultValue:z.number().min(0).default(0),ratePercent:z.number().min(0).max(100).default(0),taxable:z.boolean().default(false),statutory:z.boolean().default(false),postingAccountId:schoolRecordId.optional()}).parse(request.body);
    const row=await tx(db,async(client:any)=>{
    await ensurePayrollAccounts(client,a.core.organisation_id);
    if(b.postingAccountId)await assertPayrollAccount(client,a.core.organisation_id,b.postingAccountId,b.componentType==='earning'?['expense']:['asset','liability']);
    const row=await one(client,`INSERT INTO payroll_components(organisation_id,code,name,component_type,calculation_type,default_value,rate_percent,taxable,statutory,created_by_os_user_id)
      VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) RETURNING *`,[a.core.organisation_id,b.code,b.name,b.componentType,b.calculationType,b.defaultValue,b.ratePercent,b.taxable,b.statutory,a.core.id]);
    await ensurePayrollAccounts(client,a.core.organisation_id);
    if(b.postingAccountId){await assertPayrollAccount(client,a.core.organisation_id,b.postingAccountId,b.componentType==='earning'?['expense']:['asset','liability']);await client.query('UPDATE payroll_components SET posting_account_id=$1 WHERE id=$2 AND organisation_id=$3',[b.postingAccountId,row.id,a.core.organisation_id]);row.posting_account_id=b.postingAccountId}
    else row.posting_account_id=await ensureComponentAccount(client,a.core.organisation_id,row);
    return row;});
    await audit(a.core.organisation_id,a.core.id,'payroll.component_created','payroll_component',row.id,{code:row.code,name:row.name});
    return reply.code(201).send(row);
  });

  app.patch('/api/payroll/components/:id',async(request:any)=>{
    const a=await authorize(request,db,deps.config);await requireRole(a,'payroll.manage');
    const {id}=z.object({id:schoolRecordId}).parse(request.params);
    const b=z.object({name:z.string().trim().min(2).max(160).optional(),calculationType:z.enum(['fixed','percent_basic']).optional(),defaultValue:z.number().min(0).optional(),ratePercent:z.number().min(0).max(100).optional(),taxable:z.boolean().optional(),statutory:z.boolean().optional(),isActive:z.boolean().optional(),postingAccountId:schoolRecordId.optional()}).parse(request.body);
    const current=await one(db,'SELECT * FROM payroll_components WHERE id=$1 AND organisation_id=$2',[id,a.core.organisation_id]);
    if(b.postingAccountId){await assertPayrollAccount(db,a.core.organisation_id,b.postingAccountId,current.component_type==='earning'?['expense']:['asset','liability']);await db.query('UPDATE payroll_components SET posting_account_id=$1 WHERE id=$2 AND organisation_id=$3',[b.postingAccountId,id,a.core.organisation_id])}
    const next={name:b.name??current.name,calculationType:b.calculationType??current.calculation_type,defaultValue:b.defaultValue??Number(current.default_value),ratePercent:b.ratePercent??Number(current.rate_percent),taxable:b.taxable??current.taxable,statutory:b.statutory??current.statutory,isActive:b.isActive??current.is_active};
    return one(db,`UPDATE payroll_components SET name=$1,calculation_type=$2,default_value=$3,rate_percent=$4,taxable=$5,statutory=$6,is_active=$7,updated_at=now() WHERE id=$8 AND organisation_id=$9 RETURNING *`,[next.name,next.calculationType,next.defaultValue,next.ratePercent,next.taxable,next.statutory,next.isActive,id,a.core.organisation_id]);
  });


  // Salary grades let HR maintain one salary/deduction definition for many staff.
  // Personal staff component assignments continue to override the grade for loans or
  // other employee-specific adjustments.
  app.get('/api/payroll/grades',async(request:any)=>{
    const a=await authorize(request,db,deps.config);await requireRole(a,'payroll.view');
    const grades=(await db.query('SELECT * FROM payroll_grades WHERE organisation_id=$1 ORDER BY code,name',[a.core.organisation_id])).rows;
    const components=(await db.query(`SELECT gc.*,c.code,c.name,c.component_type,c.calculation_type,c.default_value,c.rate_percent,c.taxable,c.statutory
      FROM payroll_grade_components gc JOIN payroll_components c ON c.id=gc.component_id
      WHERE gc.organisation_id=$1 AND gc.is_active=true AND c.is_active=true ORDER BY c.component_type,c.name`,[a.core.organisation_id])).rows;
    return grades.map((g:any)=>({...g,components:components.filter((c:any)=>c.grade_id===g.id)}));
  });

  app.post('/api/payroll/grades',async(request:any,reply:any)=>{
    const a=await authorize(request,db,deps.config);await requireRole(a,'payroll.manage');
    const b=z.object({code:z.string().trim().min(1).max(40),name:z.string().trim().min(2).max(160),baseSalary:z.number().min(0),currency:z.string().trim().min(3).max(10).default('GHS')}).parse(request.body);
    const row=await one(db,`INSERT INTO payroll_grades(organisation_id,code,name,base_salary,currency,created_by_os_user_id)
      VALUES($1,$2,$3,$4,$5,$6) RETURNING *`,[a.core.organisation_id,b.code.toUpperCase(),b.name,b.baseSalary,b.currency.toUpperCase(),a.core.id]);
    await audit(a.core.organisation_id,a.core.id,'payroll.grade_created','payroll_grade',row.id,{code:row.code,name:row.name});
    return reply.code(201).send(row);
  });

  app.patch('/api/payroll/grades/:id',async(request:any)=>{
    const a=await authorize(request,db,deps.config);await requireRole(a,'payroll.manage');
    const {id}=z.object({id:schoolRecordId}).parse(request.params);
    const b=z.object({name:z.string().trim().min(2).max(160).optional(),baseSalary:z.number().min(0).optional(),currency:z.string().trim().min(3).max(10).optional(),isActive:z.boolean().optional()}).parse(request.body);
    const current=await one(db,'SELECT * FROM payroll_grades WHERE id=$1 AND organisation_id=$2',[id,a.core.organisation_id]);
    const row=await one(db,`UPDATE payroll_grades SET name=$1,base_salary=$2,currency=$3,is_active=$4,updated_at=now()
      WHERE id=$5 AND organisation_id=$6 RETURNING *`,[b.name??current.name,b.baseSalary??Number(current.base_salary),String(b.currency??current.currency).toUpperCase(),b.isActive??current.is_active,id,a.core.organisation_id]);
    await audit(a.core.organisation_id,a.core.id,'payroll.grade_updated','payroll_grade',id,{name:row.name,baseSalary:row.base_salary});return row;
  });

  app.put('/api/payroll/grades/:id/components',async(request:any)=>{
    const a=await authorize(request,db,deps.config);await requireRole(a,'payroll.manage');
    const {id}=z.object({id:schoolRecordId}).parse(request.params);
    const b=z.object({components:z.array(z.object({componentId:schoolRecordId,valueOverride:z.number().min(0).nullable().optional(),rateOverride:z.number().min(0).max(100).nullable().optional()})).max(100)}).parse(request.body);
    await one(db,'SELECT id FROM payroll_grades WHERE id=$1 AND organisation_id=$2',[id,a.core.organisation_id]);
    const ids=[...new Set(b.components.map(c=>c.componentId))];if(ids.length!==b.components.length)throw fail(400,'Choose each component only once');
    if(ids.length){const owned=(await db.query('SELECT id FROM payroll_components WHERE organisation_id=$1 AND id=ANY($2::uuid[]) AND is_active=true',[a.core.organisation_id,ids])).rows;if(owned.length!==ids.length)throw fail(400,'Every component must belong to this school and be active')}
    await tx(db,async(client:any)=>{await client.query('DELETE FROM payroll_grade_components WHERE grade_id=$1 AND organisation_id=$2',[id,a.core.organisation_id]);for(const c of b.components)await client.query(`INSERT INTO payroll_grade_components(organisation_id,grade_id,component_id,value_override,rate_override,created_by_os_user_id)
      VALUES($1,$2,$3,$4,$5,$6)`,[a.core.organisation_id,id,c.componentId,c.valueOverride??null,c.rateOverride??null,a.core.id])});
    await audit(a.core.organisation_id,a.core.id,'payroll.grade_components_updated','payroll_grade',id,{count:b.components.length});return{saved:b.components.length};
  });

  app.put('/api/hr/staff/:userId/grade',async(request:any)=>{
    const a=await authorize(request,db,deps.config);await requireRole(a,'payroll.manage');
    const {userId}=z.object({userId:schoolRecordId}).parse(request.params);
    const b=z.object({gradeId:schoolRecordId.nullable()}).parse(request.body);
    if(b.gradeId)await one(db,'SELECT id FROM payroll_grades WHERE id=$1 AND organisation_id=$2 AND is_active=true',[b.gradeId,a.core.organisation_id]);
    await one(db,"SELECT os_user_id FROM school_memberships WHERE organisation_id=$1 AND os_user_id=$2 AND status='active'",[a.core.organisation_id,userId]);
    const row=await one(db,`INSERT INTO staff_payroll_profiles(organisation_id,os_user_id,grade_id,updated_by_os_user_id) VALUES($1,$2,$3,$4) ON CONFLICT(organisation_id,os_user_id) DO UPDATE SET grade_id=EXCLUDED.grade_id,updated_by_os_user_id=EXCLUDED.updated_by_os_user_id,updated_at=now() RETURNING *`,[a.core.organisation_id,userId,b.gradeId,a.core.id]);
    await audit(a.core.organisation_id,a.core.id,'payroll.staff_grade_assigned','staff_payroll_profile',row.id,{staff:userId,gradeId:b.gradeId});return row;
  });

  app.put('/api/hr/staff/:userId/emolument',async(request:any)=>{
    const a=await authorize(request,db,deps.config);await requireRole(a,'payroll.manage');
    const {userId}=z.object({userId:schoolRecordId}).parse(request.params);
    const b=z.object({baseSalary:z.number().min(0),currency:z.string().trim().min(3).max(10).default('GHS'),bankName:z.string().max(160).nullable().optional(),bankAccountName:z.string().max(180).nullable().optional(),bankAccountNumber:z.string().max(100).nullable().optional(),mobileMoneyNumber:z.string().max(80).nullable().optional(),mobileMoneyNetwork:z.string().max(40).nullable().optional(),isActive:z.boolean().default(true)}).parse(request.body);
    const member=await maybeOne(db,'SELECT 1 FROM school_memberships WHERE organisation_id=$1 AND os_user_id=$2',[a.core.organisation_id,userId]);
    if(!member)throw fail(404,'Staff member is not assigned to this School');
    const row=await one(db,`INSERT INTO staff_payroll_profiles(organisation_id,os_user_id,base_salary,currency,bank_name,bank_account_name,bank_account_number,mobile_money_number,mobile_money_network,is_active,updated_by_os_user_id)
      VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)
      ON CONFLICT(organisation_id,os_user_id) DO UPDATE SET base_salary=EXCLUDED.base_salary,currency=EXCLUDED.currency,bank_name=EXCLUDED.bank_name,
      bank_account_name=EXCLUDED.bank_account_name,bank_account_number=EXCLUDED.bank_account_number,mobile_money_number=EXCLUDED.mobile_money_number,mobile_money_network=EXCLUDED.mobile_money_network,
      is_active=EXCLUDED.is_active,updated_by_os_user_id=EXCLUDED.updated_by_os_user_id,updated_at=now() RETURNING *`,[a.core.organisation_id,userId,b.baseSalary,b.currency.toUpperCase(),b.bankName??null,b.bankAccountName??null,b.bankAccountNumber??null,b.mobileMoneyNumber??null,b.mobileMoneyNetwork??null,b.isActive,a.core.id]);
    await audit(a.core.organisation_id,a.core.id,'payroll.emolument_updated','staff_payroll_profile',row.id,{staff:userId,baseSalary:b.baseSalary});
    return row;
  });

  app.put('/api/hr/staff/:userId/components',async(request:any)=>{
    const a=await authorize(request,db,deps.config);await requireRole(a,'payroll.manage');
    const {userId}=z.object({userId:schoolRecordId}).parse(request.params);
    const b=z.object({components:z.array(z.object({componentId:schoolRecordId,valueOverride:z.number().min(0).nullable().optional(),rateOverride:z.number().min(0).max(100).nullable().optional(),isActive:z.boolean().default(true)})).max(100)}).parse(request.body);
    await one(db,"SELECT os_user_id FROM school_memberships WHERE organisation_id=$1 AND os_user_id=$2 AND status='active'",[a.core.organisation_id,userId]);
    const ids=[...new Set(b.components.map(c=>c.componentId))];if(ids.length!==b.components.length)throw fail(400,'Choose each component only once');
    if(ids.length){const owned=(await db.query('SELECT id FROM payroll_components WHERE organisation_id=$1 AND id=ANY($2::uuid[]) AND is_active=true',[a.core.organisation_id,ids])).rows;if(owned.length!==ids.length)throw fail(400,'Every component must belong to this school and be active')}
    await tx(db,async(client:any)=>{
      await client.query('DELETE FROM staff_payroll_component_assignments WHERE organisation_id=$1 AND os_user_id=$2',[a.core.organisation_id,userId]);
      for(const c of b.components)await client.query(`INSERT INTO staff_payroll_component_assignments(organisation_id,os_user_id,component_id,value_override,rate_override,is_active,created_by_os_user_id)
        VALUES($1,$2,$3,$4,$5,$6,$7)`,[a.core.organisation_id,userId,c.componentId,c.valueOverride??null,c.rateOverride??null,c.isActive,a.core.id]);
    });
    await audit(a.core.organisation_id,a.core.id,'payroll.components_assigned','staff_payroll_profile',userId,{count:b.components.length});
    return{saved:b.components.length};
  });

  function roundMoney(value:number){return Math.round(value*100)/100}
  function componentAmount(c:any,basic:number){
    if(c.calculation_type==='percent_basic')return roundMoney(basic*Number(c.rate_override??c.rate_percent??0)/100);
    return roundMoney(Number(c.value_override??c.default_value??0));
  }
  function ghanaMonthlyPaye2026(chargeableIncome:number){
    let remaining=Math.max(0,Number(chargeableIncome||0)),tax=0;
    const bands:Array<[number,number]>=[[588,0],[80,.05],[100,.10],[2900,.175],[16000,.25],[30332,.30]];
    for(const [band,rate] of bands){if(remaining<=0)break;const taxable=Math.min(remaining,band);tax+=taxable*rate;remaining-=taxable}
    if(remaining>0)tax+=remaining*.35;
    return roundMoney(tax);
  }
  function payeAmount(c:any,chargeableIncome:number,year:number,month:number){
    if(c.value_override!=null)return roundMoney(Number(c.value_override));
    if(year===2026&&month>=9)return ghanaMonthlyPaye2026(chargeableIncome);
    throw fail(400,'Automatic Ghana PAYE is configured for September 2026 onward. Enter a staff PAYE amount override before creating payroll for another period.');
  }

  app.get('/api/payroll/runs',async(request:any)=>{
    const a=await authorize(request,db,deps.config);await requireRole(a,'payroll.view');
    return (await db.query('SELECT * FROM payroll_runs WHERE organisation_id=$1 ORDER BY period_year DESC,period_month DESC',[a.core.organisation_id])).rows;
  });

  app.post('/api/payroll/runs',async(request:any,reply:any)=>{
    const a=await authorize(request,db,deps.config);await requireRole(a,'payroll.manage');
    const b=z.object({year:z.number().int().min(2000).max(2200),month:z.number().int().min(1).max(12)}).parse(request.body);
    const existing=await maybeOne(db,'SELECT id,status FROM payroll_runs WHERE organisation_id=$1 AND period_year=$2 AND period_month=$3',[a.core.organisation_id,b.year,b.month]);
    if(existing)throw fail(409,'Payroll for this month already exists. Open the existing payroll run instead.');
    const users=await fetchCoreUsers(a.core.organisation_id).catch(()=>[]);
    const profiles=(await db.query(`SELECT p.*,m.status membership_status FROM staff_payroll_profiles p JOIN school_memberships m ON m.organisation_id=p.organisation_id AND m.os_user_id=p.os_user_id
      WHERE p.organisation_id=$1 AND p.is_active=true AND m.status='active' ORDER BY p.created_at`,[a.core.organisation_id])).rows;
    if(!profiles.length)throw fail(400,'No active staff emoluments are configured. Configure staff salaries before creating payroll.');
    const missing=(await db.query(`SELECT m.os_user_id FROM school_memberships m LEFT JOIN staff_payroll_profiles p ON p.organisation_id=m.organisation_id AND p.os_user_id=m.os_user_id WHERE m.organisation_id=$1 AND m.status='active' AND p.id IS NULL`,[a.core.organisation_id])).rows;
    if(missing.length)throw fail(409,'Configure a salary grade or salary profile for every active staff member first: '+missing.map((m:any)=>{const u=users.find((u:any)=>u.id===m.os_user_id);return u?([u.first_name,u.last_name].filter(Boolean).join(' ')||u.employee_number||u.id):m.os_user_id}).join(', '));
    const settings=await ensurePayrollAccounts(db,a.core.organisation_id);
    const definitions=(await db.query('SELECT * FROM payroll_components WHERE organisation_id=$1 AND is_active=true',[a.core.organisation_id])).rows;
    for(const c of definitions)await ensureComponentAccount(db,a.core.organisation_id,c);

    const components=(await db.query(`SELECT a.*,c.code,c.name,c.component_type,c.calculation_type,c.default_value,c.rate_percent,c.taxable,c.statutory,c.posting_account_id
      FROM staff_payroll_component_assignments a JOIN payroll_components c ON c.id=a.component_id
      WHERE a.organisation_id=$1 AND a.is_active=true AND c.is_active=true`,[a.core.organisation_id])).rows;
    const grades=(await db.query('SELECT * FROM payroll_grades WHERE organisation_id=$1 AND is_active=true',[a.core.organisation_id])).rows;
    const gradeComponents=(await db.query(`SELECT gc.*,c.code,c.name,c.component_type,c.calculation_type,c.default_value,c.rate_percent,c.taxable,c.statutory,c.posting_account_id FROM payroll_grade_components gc JOIN payroll_components c ON c.id=gc.component_id WHERE gc.organisation_id=$1 AND gc.is_active=true AND c.is_active=true`,[a.core.organisation_id])).rows;
    const result=await tx(db,async(client:any)=>{
      const run=await one(client,`INSERT INTO payroll_runs(organisation_id,period_year,period_month,created_by_os_user_id) VALUES($1,$2,$3,$4) RETURNING *`,[a.core.organisation_id,b.year,b.month,a.core.id]);
      await client.query('UPDATE payroll_runs SET payable_account_id=$1 WHERE id=$2 AND organisation_id=$3',[settings.payable_account_id,run.id,a.core.organisation_id]);
      let grossTotal=0,deductionTotal=0,netTotal=0;
      const currencies=[...new Set(profiles.map((p:any)=>p.grade_id?grades.find((g:any)=>g.id===p.grade_id)?.currency:p.currency))];if(currencies.length!==1||!currencies[0])throw fail(409,'All staff in a payroll run must use the same configured currency');
      await client.query('UPDATE payroll_runs SET currency=$1 WHERE id=$2',[currencies[0],run.id]);
      for(const p of profiles){
        const u=users.find((x:any)=>x.id===p.os_user_id)||{};const grade=p.grade_id?grades.find((g:any)=>g.id===p.grade_id):null;const basic=Number(grade?.base_salary??p.base_salary??0);const personal=components.filter((x:any)=>x.os_user_id===p.os_user_id);const inherited=grade?gradeComponents.filter((x:any)=>x.grade_id===grade.id):[];const merged=new Map<string,any>();inherited.forEach((x:any)=>merged.set(x.component_id,x));personal.forEach((x:any)=>merged.set(x.component_id,x));const assigned=Array.from(merged.values());
        let earnings=0,deductions=0,taxableEarnings=0;
        const payeComponents=assigned.filter((c:any)=>String(c.code||'').toUpperCase()==='PAYE');
        const calculated=assigned.filter((c:any)=>String(c.code||'').toUpperCase()!=='PAYE').map((c:any)=>{
          const amount=componentAmount(c,basic);
          if(c.component_type==='earning'){earnings+=amount;if(c.taxable)taxableEarnings+=amount}else deductions+=amount;
          return{...c,amount};
        });
        const gross=roundMoney(basic+earnings);
        const employeeSsnit=calculated.filter((c:any)=>c.component_type==='deduction'&&String(c.code||'').toUpperCase()==='SSNIT').reduce((sum:number,c:any)=>sum+Number(c.amount||0),0);
        const chargeableIncome=roundMoney(Math.max(0,basic+taxableEarnings-employeeSsnit));
        for(const c of payeComponents){const amount=payeAmount(c,chargeableIncome,b.year,b.month);deductions+=amount;calculated.push({...c,amount})}
        if(deductions>gross)throw fail(409,'Deductions exceed earnings for '+([u.first_name,u.last_name].filter(Boolean).join(' ')||p.os_user_id)+'. Review the grade and personal deductions.');
        if(p.grade_id&&!grade)throw fail(409,'A staff salary grade is inactive. Assign an active grade before preparing payroll.');
        const net=roundMoney(gross-deductions);grossTotal+=gross;deductionTotal+=deductions;netTotal+=net;
        const item=await one(client,`INSERT INTO payroll_run_items(payroll_run_id,organisation_id,os_user_id,staff_name,staff_id,base_salary,gross_earnings,total_deductions,net_pay,bank_name,bank_account_name,bank_account_number,mobile_money_number,mobile_money_network)
          VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14) RETURNING *`,[run.id,a.core.organisation_id,p.os_user_id,((u.first_name||'')+' '+(u.last_name||'')).trim()||p.os_user_id,u.employee_number||u.login_staff_id||null,basic,gross,deductions,net,p.bank_name,p.bank_account_name,p.bank_account_number,p.mobile_money_number,p.mobile_money_network]);
        await client.query('UPDATE payroll_run_items SET salary_grade_code=$1,salary_grade_name=$2 WHERE id=$3',[grade?.code??null,grade?.name??null,item.id]);
        await client.query(`INSERT INTO payroll_run_item_components(payroll_run_item_id,component_id,code,name,component_type,amount,taxable,statutory,posting_account_id)
          VALUES($1,NULL,'BASIC','Basic Salary','earning',$2,true,false,$3)`,[item.id,basic,settings.expense_account_id]);
        for(const c of calculated)await client.query(`INSERT INTO payroll_run_item_components(payroll_run_item_id,component_id,code,name,component_type,amount,taxable,statutory,posting_account_id)
          VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9)`,[item.id,c.component_id,c.code,c.name,c.component_type,c.amount,c.taxable,c.statutory,c.posting_account_id]);
      }
      return one(client,'UPDATE payroll_runs SET gross_total=$1,deductions_total=$2,net_total=$3,updated_at=now() WHERE id=$4 RETURNING *',[Math.round(grossTotal*100)/100,Math.round(deductionTotal*100)/100,Math.round(netTotal*100)/100,run.id]);
    });
    await audit(a.core.organisation_id,a.core.id,'payroll.run_created','payroll_run',result.id,{year:b.year,month:b.month,gross:result.gross_total,net:result.net_total});
    return reply.code(201).send(result);
  });

  app.get('/api/payroll/runs/:id',async(request:any)=>{
    const a=await authorize(request,db,deps.config);await requireRole(a,'payroll.view');
    const {id}=z.object({id:schoolRecordId}).parse(request.params);
    const run=await one(db,'SELECT * FROM payroll_runs WHERE id=$1 AND organisation_id=$2',[id,a.core.organisation_id]);
    const items=(await db.query('SELECT * FROM payroll_run_items WHERE payroll_run_id=$1 AND organisation_id=$2 ORDER BY staff_name',[id,a.core.organisation_id])).rows;
    const ids=items.map((x:any)=>x.id);const components=ids.length?(await db.query('SELECT * FROM payroll_run_item_components WHERE payroll_run_item_id=ANY($1::uuid[]) ORDER BY component_type,name',[ids])).rows:[];
    return{run,items:items.map((x:any)=>({...x,components:components.filter((c:any)=>c.payroll_run_item_id===x.id)}))};
  });

  await registerPayrollWorkflow(app,{...deps,requireRole});

  app.get('/api/payroll/runs/:id/export',async(request:any,reply:any)=>{
    const a=await authorize(request,db,deps.config);await requireRole(a,'payroll.view');
    const {id}=z.object({id:schoolRecordId}).parse(request.params);
    const q=z.object({format:z.enum(['pdf','excel']).default('pdf')}).parse(request.query);
    const run=await one(db,'SELECT * FROM payroll_runs WHERE id=$1 AND organisation_id=$2',[id,a.core.organisation_id]);
    const items=(await db.query('SELECT * FROM payroll_run_items WHERE payroll_run_id=$1 AND organisation_id=$2 ORDER BY staff_name',[id,a.core.organisation_id])).rows;
    const period=String(run.period_year)+'-'+String(run.period_month).padStart(2,'0');
    const components=(await db.query(`SELECT c.*,a.code account_code,a.name account_name FROM payroll_run_item_components c
      JOIN payroll_run_items i ON i.id=c.payroll_run_item_id LEFT JOIN finance_accounts a ON a.id=c.posting_account_id AND a.organisation_id=i.organisation_id
      WHERE i.payroll_run_id=$1 AND i.organisation_id=$2 ORDER BY c.component_type,c.name`,[id,a.core.organisation_id])).rows;
    if(q.format==='excel'){
      const escXml=(v:any)=>{let text=String(v??'');if(/^[=+@-]/.test(text))text="'"+text;return text.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;')};
      const headings=['Staff ID','Staff','Salary Grade','Bank','Account name','Account number','MoMo network','MoMo number','Earnings / deductions and GL','Gross','Deductions','Net Pay'];
      const rows=items.map((r:any)=>'<tr>'+[r.staff_id,r.staff_name,r.salary_grade_name,r.bank_name,r.bank_account_name,r.bank_account_number,r.mobile_money_network,r.mobile_money_number,
        components.filter((c:any)=>c.payroll_run_item_id===r.id).map((c:any)=>c.name+': '+Number(c.amount).toFixed(2)+' ['+(c.account_code||'Unmapped')+']').join('; '),
        Number(r.gross_earnings).toFixed(2),Number(r.total_deductions).toFixed(2),Number(r.net_pay).toFixed(2)].map(v=>'<td>'+escXml(v)+'</td>').join('')+'</tr>').join('');
      const html='<html><head><meta charset="utf-8"></head><body><h2>School Payroll '+period+'</h2><p>'+escXml(run.currency)+' · '+escXml(run.status)+'</p><table border="1"><tr>'+headings.map(h=>'<th>'+h+'</th>').join('')+'</tr>'+rows+'<tr><th colspan="9">Totals</th><th>'+Number(run.gross_total).toFixed(2)+'</th><th>'+Number(run.deductions_total).toFixed(2)+'</th><th>'+Number(run.net_total).toFixed(2)+'</th></tr></table></body></html>';
      return reply.header('content-disposition','attachment; filename="payroll-'+period+'.xls"').type('application/vnd.ms-excel; charset=utf-8').send(html);
    }
    const chunks:Buffer[]=[];const doc=new PDFDocument({size:'A4',margin:36});doc.on('data',(c:Buffer)=>chunks.push(c));const done=new Promise<Buffer>((resolve,reject)=>{doc.on('end',()=>resolve(Buffer.concat(chunks)));doc.on('error',reject)});
    doc.fontSize(18).text('Revolt-X School Payroll',{align:'center'});doc.fontSize(11).text('Period: '+period+'   Status: '+String(run.status).replace(/_/g,' '),{align:'center'});doc.moveDown();
    for(const r of items){
      if(doc.y>640)doc.addPage();doc.moveDown().fontSize(11).text((r.staff_id||'—')+'  '+r.staff_name);
      doc.fontSize(9).text('Salary Grade: '+(r.salary_grade_name||'Individual salary profile'));
      if(r.bank_account_number)doc.text('Bank: '+[r.bank_name,r.bank_account_name,r.bank_account_number].filter(Boolean).join(' · '));
      if(r.mobile_money_number)doc.text('MoMo: '+[r.mobile_money_network,r.mobile_money_number].filter(Boolean).join(' · '));
      for(const c of components.filter((c:any)=>c.payroll_run_item_id===r.id))doc.text(c.name+': '+Number(c.amount).toFixed(2)+' · GL '+(c.account_code||'Unmapped'));
      doc.text('Gross '+Number(r.gross_earnings).toFixed(2)+' | Deductions '+Number(r.total_deductions).toFixed(2)+' | Net '+Number(r.net_pay).toFixed(2));
    }
    doc.moveDown().fontSize(11).text('Totals: Gross '+Number(run.gross_total).toFixed(2)+' | Deductions '+Number(run.deductions_total).toFixed(2)+' | Net '+Number(run.net_total).toFixed(2));doc.end();
    const pdf=await done;return reply.header('content-disposition','attachment; filename="payroll-'+period+'.pdf"').type('application/pdf').send(pdf);
  });
  app.get('/api/payroll/me/:id/export',async(request:any,reply:any)=>{
    const a=await authorize(request,db,deps.config);const {id}=z.object({id:schoolRecordId}).parse(request.params);
    const item=await maybeOne(db,`SELECT i.*,r.period_year,r.period_month,r.currency,r.paid_at,r.payment_date,r.payment_reference
      FROM payroll_run_items i JOIN payroll_runs r ON r.id=i.payroll_run_id
      WHERE i.id=$1 AND i.organisation_id=$2 AND i.os_user_id=$3 AND r.status='paid' AND r.published_at IS NOT NULL`,[id,a.core.organisation_id,a.core.id]);
    if(!item)throw fail(404,'A published paid payslip was not found for your account');
    const school=await one(db,'SELECT school_name FROM school_profiles WHERE organisation_id=$1',[a.core.organisation_id]);
    const components=(await db.query('SELECT * FROM payroll_run_item_components WHERE payroll_run_item_id=$1 ORDER BY component_type,name',[id])).rows;
    const pdf=await renderStaffPayslip(school,item,components);
    return reply.header('content-disposition','attachment; filename="payslip-'+item.period_year+'-'+String(item.period_month).padStart(2,'0')+'.pdf"').type('application/pdf').send(pdf);
  });

  app.get('/api/payroll/me',async(request:any)=>{
    const a=await authorize(request,db,deps.config);
    const q=z.object({year:z.coerce.number().int().min(2000).max(2200).optional(),month:z.coerce.number().int().min(1).max(12).optional()}).parse(request.query);
    const rows=(await db.query(`SELECT pri.*,pr.period_year,pr.period_month,pr.currency,pr.status,pr.paid_at,pr.published_at
      FROM payroll_run_items pri JOIN payroll_runs pr ON pr.id=pri.payroll_run_id
      WHERE pri.organisation_id=$1 AND pri.os_user_id=$2 AND pr.status='paid' AND pr.published_at IS NOT NULL
        AND ($3::int IS NULL OR pr.period_year=$3) AND ($4::int IS NULL OR pr.period_month=$4)
      ORDER BY pr.period_year DESC,pr.period_month DESC LIMIT 120`,[a.core.organisation_id,a.core.id,q.year??null,q.month??null])).rows;
    for(const r of rows)r.components=(await db.query('SELECT code,name,component_type,amount,taxable,statutory FROM payroll_run_item_components WHERE payroll_run_item_id=$1 ORDER BY component_type,name',[r.id])).rows;
    return rows;
  });
}
