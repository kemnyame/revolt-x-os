import fs from 'node:fs';
import path from 'node:path';

const root = process.cwd();
const serverPath = path.join(root, 'src', 'server.ts');
const uiPath = path.join(root, 'src', 'ui.ts');

function patchFile(filePath, patcher) {
  if (!fs.existsSync(filePath)) throw new Error(`Missing source file: ${filePath}`);
  const before = fs.readFileSync(filePath, 'utf8');
  const after = patcher(before);
  if (after !== before) fs.writeFileSync(filePath, after);
  else console.log(`No academic setup patch changes needed for ${path.basename(filePath)}`);
}

const gradeLevelApi = `app.get('/api/grade-levels',async request=>{const a=await authorize(request,db,config,'academic.view');return (await db.query('SELECT * FROM grade_levels WHERE organisation_id=$1 ORDER BY level_order',[a.core.organisation_id])).rows});
app.post('/api/grade-levels',async(request,reply)=>{
  const a=await authorize(request,db,config,'academic.create');
  const b=z.object({code:z.string().trim().min(1).max(20),name:z.string().trim().min(2).max(80),stage:z.enum(['primary','jhs']),levelOrder:z.coerce.number().int().min(1).max(99),isActive:z.boolean().default(true)}).parse(request.body);
  try{
    const row=await one<any>(db,'INSERT INTO grade_levels(organisation_id,code,name,stage,level_order,is_active) VALUES($1,$2,$3,$4,$5,$6) RETURNING *',[a.core.organisation_id,b.code.toUpperCase(),b.name,b.stage,b.levelOrder,b.isActive]);
    await audit(a.core.organisation_id,a.core.id,'grade_level.created','grade_level',row.id,{code:row.code,stage:row.stage,levelOrder:row.level_order});
    return reply.code(201).send(row);
  }catch(error:any){
    if(error?.code==='23505')throw fail(409,'A grade level with this code or order already exists. Use a unique code and display order.');
    throw error;
  }
});`;

const onboardingApi = [
"app.get('/api/student-onboarding/admission-candidates',async request=>{",
"  const a=await authorize(request,db,config,'students.create');",
"  return (await db.query(\"SELECT aa.*,g.id requested_grade_id,g.name requested_grade_name,g.level_order requested_grade_order,(SELECT count(*)::int FROM classrooms c WHERE c.organisation_id=aa.organisation_id AND c.grade_level_id=g.id AND c.is_active=true) matching_class_count FROM admission_applications aa LEFT JOIN grade_levels g ON g.organisation_id=aa.organisation_id AND lower(g.code)=lower(aa.requested_grade_code) WHERE aa.organisation_id=$1 AND aa.status='approved' AND aa.student_id IS NULL ORDER BY aa.reviewed_at DESC NULLS LAST,aa.submitted_at DESC\",[a.core.organisation_id])).rows;",
"});",
"app.post('/api/student-onboarding/admission-candidates/:id/enrol',async(request,reply)=>{",
"  const a=await authorize(request,db,config,'students.create');",
"  const {id}=z.object({id:z.string().uuid()}).parse(request.params);",
"  const b=z.object({classroomId:z.string().uuid(),admissionNo:z.string().trim().min(1).max(60).optional()}).parse(request.body);",
"  const result=await tx(db,async client=>{",
"    const application=await one<any>(client,'SELECT * FROM admission_applications WHERE id=$1 AND organisation_id=$2 FOR UPDATE',[id,a.core.organisation_id]);",
"    if(application.status!=='approved')throw fail(409,'Only approved admission applications can be enrolled');",
"    if(application.student_id)throw fail(409,'This admission application has already been converted into a student record');",
"    const classroom=await one<any>(client,'SELECT c.*,g.code grade_code,g.name grade_name FROM classrooms c JOIN grade_levels g ON g.id=c.grade_level_id WHERE c.id=$1 AND c.organisation_id=$2 AND c.is_active=true',[b.classroomId,a.core.organisation_id]);",
"    const admissionNo=(b.admissionNo||String(application.application_no||'').replace(/^ADM/i,'STU')).trim();",
"    if(!admissionNo)throw fail(400,'Enter a Student ID / admission number');",
"    const student=await one<any>(client,'INSERT INTO students(organisation_id,admission_no,first_name,middle_name,last_name,sex,date_of_birth,admission_date,notes) VALUES($1,$2,$3,$4,$5,$6,$7,current_date,$8) RETURNING *',[a.core.organisation_id,admissionNo,application.first_name,application.middle_name,application.last_name,application.sex,application.date_of_birth,[application.notes,application.previous_school?'Previous school: '+application.previous_school:null,'Created from admission application '+application.application_no].filter(Boolean).join('\\n')]);",
"    let guardian=await maybeOne<any>(client,'SELECT * FROM guardians WHERE organisation_id=$1 AND phone=$2 ORDER BY created_at LIMIT 1',[a.core.organisation_id,application.guardian_phone]);",
"    if(!guardian){guardian=await one<any>(client,'INSERT INTO guardians(organisation_id,first_name,last_name,phone,email,address) VALUES($1,$2,$3,$4,$5,$6) RETURNING *',[a.core.organisation_id,application.guardian_first_name,application.guardian_last_name,application.guardian_phone,application.guardian_email||null,application.address||null]);}",
"    else{guardian=await one<any>(client,'UPDATE guardians SET first_name=$1,last_name=$2,email=COALESCE($3,email),address=COALESCE($4,address),updated_at=now() WHERE id=$5 RETURNING *',[application.guardian_first_name,application.guardian_last_name,application.guardian_email||null,application.address||null,guardian.id]);}",
"    await client.query('UPDATE student_guardians SET is_primary=false WHERE student_id=$1',[student.id]);",
"    await client.query('INSERT INTO student_guardians(student_id,guardian_id,relationship,is_primary) VALUES($1,$2,$3,true) ON CONFLICT(student_id,guardian_id) DO UPDATE SET relationship=EXCLUDED.relationship,is_primary=true',[student.id,guardian.id,application.guardian_relationship]);",
"    const enrolment=await one<any>(client,\"INSERT INTO enrolments(organisation_id,student_id,academic_year_id,classroom_id,status) VALUES($1,$2,$3,$4,'active') RETURNING *\",[a.core.organisation_id,student.id,classroom.academic_year_id,classroom.id]);",
"    await assignMandatoryFees(client,a.core.organisation_id,student.id,classroom.academic_year_id,classroom.id);",
"    await client.query(\"INSERT INTO student_status_history(organisation_id,student_id,old_status,new_status,reason,changed_by_os_user_id,enrolment_id,classroom_id) VALUES($1,$2,NULL,'active',$3,$4,$5,$6)\",[a.core.organisation_id,student.id,'Student enrolled from approved admission application '+application.application_no,a.core.id,enrolment.id,classroom.id]);",
"    await client.query(\"UPDATE admission_applications SET status='enrolled',student_id=$1,updated_at=now(),reviewed_at=COALESCE(reviewed_at,now()),reviewed_by_os_user_id=COALESCE(reviewed_by_os_user_id,$2) WHERE id=$3 AND organisation_id=$4\",[student.id,a.core.id,id,a.core.organisation_id]);",
"    await client.query(\"INSERT INTO admission_status_history(organisation_id,application_id,old_status,new_status,note,actor_os_user_id) VALUES($1,$2,'approved','enrolled',$3,$4)\",[a.core.organisation_id,id,'Converted to student record '+student.admission_no+' and enrolled in '+classroom.name,a.core.id]);",
"    return{student,guardian,enrolment,classroom,applicationNo:application.application_no};",
"  });",
"  await audit(a.core.organisation_id,a.core.id,'admission.enrolled','admission_application',id,{studentId:result.student.id,classroomId:result.classroom.id});",
"  return reply.code(201).send(result);",
"});"
].join('\n');

const admissionDetailsApi = [
"app.patch('/api/admissions/:id/details',async request=>{",
"  const a=await authorize(request,db,config,'admissions.manage');",
"  const {id}=z.object({id:z.string().uuid()}).parse(request.params);",
"  const b=z.object({firstName:z.string().trim().min(1).max(100).optional(),middleName:z.string().trim().max(100).nullable().optional(),lastName:z.string().trim().min(1).max(100).optional(),sex:z.enum(['male','female']).nullable().optional(),dateOfBirth:z.string().date().nullable().optional(),requestedGradeCode:z.string().trim().min(1).max(20).optional(),previousSchool:z.string().trim().max(240).nullable().optional(),guardianFirstName:z.string().trim().min(1).max(100).optional(),guardianLastName:z.string().trim().min(1).max(100).optional(),guardianPhone:z.string().trim().min(5).max(60).optional(),guardianAltPhone:z.string().trim().max(60).nullable().optional(),guardianEmail:z.string().email().nullable().optional(),guardianRelationship:z.string().trim().min(2).max(60).optional(),address:z.string().trim().max(4000).nullable().optional(),emergencyContactName:z.string().trim().max(200).nullable().optional(),emergencyContactPhone:z.string().trim().max(60).nullable().optional(),notes:z.string().trim().max(5000).nullable().optional()}).refine(v=>Object.keys(v).length>0).parse(request.body);",
"  const current=await one<any>(db,'SELECT * FROM admission_applications WHERE id=$1 AND organisation_id=$2',[id,a.core.organisation_id]);",
"  if(current.status==='enrolled')throw fail(409,'An enrolled application cannot be edited');",
"  const row=await one<any>(db,`UPDATE admission_applications SET",
"    first_name=COALESCE($1,first_name),middle_name=CASE WHEN $2 THEN $3 ELSE middle_name END,last_name=COALESCE($4,last_name),",
"    sex=CASE WHEN $5 THEN $6 ELSE sex END,date_of_birth=CASE WHEN $7 THEN $8::date ELSE date_of_birth END,requested_grade_code=COALESCE($9,requested_grade_code),",
"    previous_school=CASE WHEN $10 THEN $11 ELSE previous_school END,guardian_first_name=COALESCE($12,guardian_first_name),guardian_last_name=COALESCE($13,guardian_last_name),",
"    guardian_phone=COALESCE($14,guardian_phone),guardian_alt_phone=CASE WHEN $15 THEN $16 ELSE guardian_alt_phone END,guardian_email=CASE WHEN $17 THEN $18 ELSE guardian_email END,",
"    guardian_relationship=COALESCE($19,guardian_relationship),address=CASE WHEN $20 THEN $21 ELSE address END,emergency_contact_name=CASE WHEN $22 THEN $23 ELSE emergency_contact_name END,",
"    emergency_contact_phone=CASE WHEN $24 THEN $25 ELSE emergency_contact_phone END,notes=CASE WHEN $26 THEN $27 ELSE notes END,updated_at=now()",
"    WHERE id=$28 AND organisation_id=$29 RETURNING *`,[b.firstName??null,Object.hasOwn(b,'middleName'),b.middleName??null,b.lastName??null,Object.hasOwn(b,'sex'),b.sex??null,Object.hasOwn(b,'dateOfBirth'),b.dateOfBirth??null,b.requestedGradeCode??null,Object.hasOwn(b,'previousSchool'),b.previousSchool??null,b.guardianFirstName??null,b.guardianLastName??null,b.guardianPhone??null,Object.hasOwn(b,'guardianAltPhone'),b.guardianAltPhone??null,Object.hasOwn(b,'guardianEmail'),b.guardianEmail??null,b.guardianRelationship??null,Object.hasOwn(b,'address'),b.address??null,Object.hasOwn(b,'emergencyContactName'),b.emergencyContactName??null,Object.hasOwn(b,'emergencyContactPhone'),b.emergencyContactPhone??null,Object.hasOwn(b,'notes'),b.notes??null,id,a.core.organisation_id]);",
"  await audit(a.core.organisation_id,a.core.id,'admission.details_updated','admission_application',id);",
"  await changeLog({organisationId:a.core.organisation_id,actorOsUserId:a.core.id,action:'admission.details_updated',resourceType:'admission_application',resourceId:id,performedOn:row.application_no,oldValue:current,newValue:row});",
"  return row;",
"});"
].join('\n');

patchFile(serverPath, source => {
  let next = source;
  if (!next.includes("app.post('/api/grade-levels'")) {
    const getGradeLevels = /app\.get\('\/api\/grade-levels',[\s\S]*?\}\);(?=\s*app\.get\('\/api\/classes')/;
    if (getGradeLevels.test(next)) next = next.replace(getGradeLevels, gradeLevelApi);
  }
  if (!next.includes("app.get('/api/student-onboarding/admission-candidates'")) {
    const anchor = "app.get('/api/students/directory'";
    if (next.includes(anchor)) next = next.replace(anchor, onboardingApi + "\n" + anchor);
  }
  if (!next.includes("app.patch('/api/admissions/:id/details'")) {
    const anchor = "app.patch('/api/admissions/:id',async request=>";
    if (next.includes(anchor)) next = next.replace(anchor, admissionDetailsApi + "\n" + anchor);
  }
  return next;
});

const validatedFormSource = String.raw`function rxFieldRequired(f){if(f.required===true)return true;if(f.required===false)return false;var k=String(f.key||'').toLowerCase(),l=String(f.label||'').toLowerCase();if(/optional|middle name|notes|note|address|previous|stream|capacity|alternate|alt phone|email|admission no|student id|next term|description|motto/.test(l))return false;if(['middleName','notes','note','address','previousSchool','stream','capacity','guardianEmail','guardianAltPhone','emergencyContactName','emergencyContactPhone','admissionNo','nextTermBegins','sex'].indexOf(f.key)>=0)return false;return true}
function rxReqLabel(f){return esc(f.label||'Field')+(rxFieldRequired(f)?' <span class="req">*</span>':'')}
function field(f,v){v=v==null?'':v;var req=rxFieldRequired(f)?' required':'';if(f.type==='select')return'<label>'+rxReqLabel(f)+'</label><select data-f="'+f.key+'"'+req+'>'+(f.options||[]).map(function(o){var value=typeof o==='string'?o:o.value,label=typeof o==='string'?o:o.label;return'<option value="'+esc(value)+'"'+(String(value)===String(v)?' selected':'')+'>'+esc(label)+'</option>'}).join('')+'</select>';if(f.type==='textarea')return'<label>'+rxReqLabel(f)+'</label><textarea rows="'+(f.rows||4)+'" data-f="'+f.key+'"'+req+'>'+esc(v)+'</textarea>';return'<label>'+rxReqLabel(f)+'</label><input type="'+(f.type||'text')+'" data-f="'+f.key+'" value="'+esc(v)+'"'+req+'>'}
function form(title,fields,vals,save){vals=vals||{};modal('<h2 style="margin-bottom:15px">'+esc(title)+'</h2>'+fields.map(function(f){return field(f,vals[f.key])}).join('')+'<p class="muted"><span class="req">*</span> Required field</p><button id="saveModal" class="primary" style="width:100%;margin:8px 0 12px">Save</button>');E('saveModal').onclick=async function(){var v={},btn=E('saveModal'),missing=[];E('modalBody').querySelectorAll('[data-f]').forEach(function(x){v[x.dataset.f]=x.value});fields.forEach(function(f){if(rxFieldRequired(f)&&!String(v[f.key]||'').trim())missing.push((f.label||f.key).replace(/\s*\(.*?\)/g,''));if(f.type==='email'&&v[f.key]&&!/^\S+@\S+\.\S+$/.test(v[f.key]))missing.push((f.label||f.key)+' must be a valid email')});if(missing.length){alert('Complete required field(s): '+missing.join(', '));return}try{btn.disabled=true;btn.textContent='Saving...';await save(v);btn.textContent='Saved';close();await page(current);successDialog('Record saved',title+' was saved successfully.')}catch(e){btn.disabled=false;btn.textContent='Save';if(typeof toast==='function')toast(e.message||'Could not save record',true);else alert(e.message||'Could not save record')}}}
`;

const uiHelper = String.raw`
function rxSetupOption(v,t){return '<option value="'+esc(v)+'">'+esc(t)+'</option>'}
function rxSetupRows(items,empty,cols){if(!items||!items.length)return '<div class="empty">'+esc(empty)+'</div>';return '<div class="table"><table><thead><tr>'+cols.map(function(c){return '<th>'+esc(c.label)+'</th>'}).join('')+'</tr></thead><tbody>'+items.map(function(item){return '<tr>'+cols.map(function(c){return '<td>'+esc(typeof c.value==='function'?c.value(item):item[c.value])+'</td>'}).join('')+'</tr>'}).join('')+'</tbody></table></div>'}
function rxArray(v){if(Array.isArray(v))return v;try{return JSON.parse(v||'[]')}catch(e){return[]}}
function rxUserLabel(users,id){var u=(users||[]).find(function(x){return x.id===id||x.os_user_id===id});return u?([u.first_name||u.firstName,u.last_name||u.lastName].filter(Boolean).join(' ')||u.email||id):id}
async function ensureSchoolSetupCatalogSections(){
  var content=E('content');if(!content||E('rxSetupCatalogue'))return;var heading=(content.querySelector('h1')||{}).textContent||'';var hasGrade=Array.from(content.querySelectorAll('h2')).some(function(h){return /grade/i.test(h.textContent||'')});if(!/setup/i.test(heading)&&!hasGrade)return;
  var data=await Promise.all([raw('/api/academic-years'),raw('/api/grade-levels'),raw('/api/classes'),raw('/api/subjects'),raw('/api/class-subjects').catch(function(){return[]}),raw('/api/staff/core-users').catch(function(){return[]}),raw('/api/staff/module-memberships').catch(function(){return[]})]).catch(function(){return null});if(!data)return;
  var years=data[0]||[],grades=data[1]||[],classes=data[2]||[],subjects=data[3]||[],classSubjects=data[4]||[],users=data[5]||[],memberships=data[6]||[];
  var teachers=memberships.filter(function(m){return m.status==='active'&&(m.can_teach||m.portal_mode==='teacher'||m.role==='teacher')}).map(function(m){return{value:m.os_user_id,label:rxUserLabel(users,m.os_user_id)+' - '+(m.role_name||m.role||'Teacher')}});
  var html='<div id="rxSetupCatalogue"><div class="section"><h2>Classes</h2><button id="addClass" class="ghost">Add class</button></div><div class="panel">'+rxSetupRows(classes,'No classes created yet',[{label:'Class',value:'name'},{label:'Grade',value:function(r){return r.grade_name||r.grade_code||''}},{label:'Students',value:function(r){return r.student_count==null?'0':r.student_count}},{label:'Subjects',value:function(r){return r.subject_count==null?'0':r.subject_count}}])+'</div><div class="section"><h2>Subjects</h2><button id="addSubject" class="ghost">Add subject</button></div><div class="panel">'+rxSetupRows(subjects,'No subjects created yet',[{label:'Code',value:'code'},{label:'Subject',value:'name'},{label:'Stage',value:'stage'},{label:'Status',value:function(r){return r.is_active?'active':'inactive'}}])+'</div><div class="section"><div><h2>Subject Teachers</h2><p class="muted">Add a subject to a class and assign the teacher in one step.</p></div><button id="assignSubjectTeacher" class="ghost">Assign subject teacher</button></div><div class="panel">'+rxSetupRows(classSubjects,'No class subjects assigned yet',[{label:'Class',value:'classroom_name'},{label:'Subject',value:'subject_name'},{label:'Teacher',value:function(r){var a=rxArray(r.teacher_assignments).find(function(x){return x.active!==false});return a?rxUserLabel(users,a.teacherOsUserId||a.teacher_os_user_id):'Not assigned'}},{label:'Students',value:function(r){return r.student_count==null?'0':r.student_count}}])+'</div></div>';
  var gradeSection=Array.from(content.querySelectorAll('.section h2')).find(function(h){return /grade/i.test(h.textContent||'')});var insertAfter=gradeSection&&gradeSection.parentElement&&gradeSection.parentElement.nextElementSibling?gradeSection.parentElement.nextElementSibling:(content.querySelector('.panel')||content.firstChild);if(insertAfter&&insertAfter.insertAdjacentHTML)insertAfter.insertAdjacentHTML('afterend',html);else content.insertAdjacentHTML('beforeend',html);
  if(E('addSubject'))E('addSubject').onclick=function(){form('New subject',[{key:'code',label:'Code e.g. ENG, MATH, SCI',required:true},{key:'name',label:'Subject name e.g. English Language',required:true},{key:'stage',label:'Stage',type:'select',required:true,options:[{value:'both',label:'Both Primary and JHS'},{value:'primary',label:'Primary only'},{value:'jhs',label:'JHS only'}]}],{stage:'both'},function(v){return raw('/api/subjects',{method:'POST',body:JSON.stringify({code:v.code,name:v.name,stage:v.stage})})})};
  if(E('addClass'))E('addClass').onclick=function(){form('New class',[{key:'academicYearId',label:'Academic year',type:'select',required:true,options:years.map(function(y){return{value:y.id,label:y.name+(y.status==='active'?' - active':'')}})},{key:'gradeLevelId',label:'Grade level',type:'select',required:true,options:grades.map(function(g){return{value:g.id,label:g.name+' ('+g.code+')'}})},{key:'name',label:'Class name e.g. Primary 1 A',required:true},{key:'stream',label:'Stream / Arm e.g. A, B',required:false},{key:'capacity',label:'Capacity',type:'number',required:false}],{academicYearId:(years.find(function(y){return y.status==='active'})||years[0]||{}).id||''},function(v){return raw('/api/classes',{method:'POST',body:JSON.stringify({academicYearId:v.academicYearId,gradeLevelId:v.gradeLevelId,name:v.name,stream:v.stream||undefined,capacity:v.capacity?Number(v.capacity):undefined})})})};
  if(E('assignSubjectTeacher'))E('assignSubjectTeacher').onclick=function(){if(!teachers.length){alert('Create or activate a teacher under Access Management before assigning a subject teacher.');return}form('Assign subject teacher',[{key:'academicYearId',label:'Academic year',type:'select',required:true,options:years.map(function(y){return{value:y.id,label:y.name+(y.status==='active'?' - active':'')}})},{key:'classroomId',label:'Class',type:'select',required:true,options:classes.filter(function(c){return c.is_active!==false}).map(function(c){return{value:c.id,label:c.name+' - '+(c.grade_name||c.grade_code||'')}})},{key:'subjectId',label:'Subject',type:'select',required:true,options:subjects.filter(function(s){return s.is_active!==false}).map(function(s){return{value:s.id,label:s.name+' ('+s.code+')'}})},{key:'teacherOsUserId',label:'Subject teacher',type:'select',required:true,options:teachers}],{academicYearId:(years.find(function(y){return y.status==='active'})||years[0]||{}).id||''},async function(v){await raw('/api/class-subjects',{method:'POST',body:JSON.stringify({academicYearId:v.academicYearId,classroomId:v.classroomId,subjectId:v.subjectId})});return raw('/api/teacher-assignments',{method:'POST',body:JSON.stringify({academicYearId:v.academicYearId,classroomId:v.classroomId,subjectId:v.subjectId,teacherOsUserId:v.teacherOsUserId,replaceExisting:true})})})};
}
var rxAdmissionPanelBusy=false,rxLastAdmissionId=null;document.addEventListener('click',function(e){var b=e.target&&e.target.closest?e.target.closest('[data-open-admission]'):null;if(b)rxLastAdmissionId=b.dataset.openAdmission},true);
async function ensureApprovedAdmissionEnrolmentPanel(){var content=E('content');if(!content||E('approvedAdmissionPanel')||rxAdmissionPanelBusy)return;var h=(content.querySelector('h1')||{}).textContent||'';if(!/student/i.test(h)||/statement/i.test(h))return;rxAdmissionPanelBusy=true;try{var data=await Promise.all([raw('/api/student-onboarding/admission-candidates'),raw('/api/classes')]);var applications=data[0]||[],classes=data[1]||[];var panel=document.createElement('div');panel.id='approvedAdmissionPanel';panel.className='panel';var rows=applications.length?applications.map(function(a){var defaultAdmission=String(a.application_no||'').replace(/^ADM/i,'STU');var classOptions=classes.map(function(c){var label=(c.name||'Class')+' - '+(c.grade_name||c.grade_code||'');return rxSetupOption(c.id,label)}).join('');return '<div class="admission-enrol-row" data-application-id="'+esc(a.id)+'" style="border:1px solid var(--line);border-radius:10px;padding:10px;margin-top:9px"><b>'+esc([a.first_name,a.middle_name,a.last_name].filter(Boolean).join(' '))+'</b> <span class="badge">approved</span><div class="muted">Application: '+esc(a.application_no)+' | Requested grade: '+esc(a.requested_grade_name||a.requested_grade_code||'')+' | Guardian: '+esc(a.guardian_first_name+' '+a.guardian_last_name)+' / '+esc(a.guardian_phone)+'</div><div class="row" style="margin-top:8px"><label>Student ID / Admission No.<input class="rx-enrol-admission-no" value="'+esc(defaultAdmission)+'"></label><label>Class for enrolment<select class="rx-enrol-class">'+classOptions+'</select></label><button class="primary rx-enrol-admission" type="button">Enrol student</button></div></div>'}).join(''):'<div class="empty">No approved admission application is waiting for enrolment.</div>';panel.innerHTML='<div class="section compact"><div><h2>Approved Admissions Ready for Enrolment</h2><p class="muted">Approved admission records appear here. Click Enrol student to reuse the captured details and avoid duplicate student entry.</p></div></div>'+rows;var anchor=content.querySelector('.panel');content.insertBefore(panel,anchor||content.firstChild)}catch(e){}finally{rxAdmissionPanelBusy=false}}
document.addEventListener('click',async function(e){var btn=e.target&&e.target.closest?e.target.closest('.rx-enrol-admission'):null;if(!btn)return;var row=btn.closest('.admission-enrol-row');if(!row)return;btn.disabled=true;var old=btn.textContent;btn.textContent='Enrolling...';try{var id=row.getAttribute('data-application-id');var classroomId=row.querySelector('.rx-enrol-class').value;var admissionNo=row.querySelector('.rx-enrol-admission-no').value;await raw('/api/student-onboarding/admission-candidates/'+encodeURIComponent(id)+'/enrol',{method:'POST',body:JSON.stringify({classroomId:classroomId,admissionNo:admissionNo})});row.innerHTML='<div class="success"><b>Student enrolled successfully.</b> The applicant has been converted into a student record and linked to the selected class.</div>'}catch(err){alert(err.message||'Could not enrol student');btn.disabled=false;btn.textContent=old}});
async function rxEditAdmissionDetails(id){var x=await raw('/api/admissions/'+id),a=x.application,grades=await raw('/api/grade-levels');form('Edit admission details',[{key:'firstName',label:'Student first name',required:true},{key:'middleName',label:'Middle name',required:false},{key:'lastName',label:'Student last name',required:true},{key:'sex',label:'Sex',type:'select',required:false,options:[{value:'',label:'Not specified'},{value:'male',label:'Male'},{value:'female',label:'Female'}]},{key:'dateOfBirth',label:'Date of birth',type:'date',required:true},{key:'requestedGradeCode',label:'Requested grade',type:'select',required:true,options:grades.filter(function(g){return g.is_active!==false}).map(function(g){return{value:g.code,label:g.name}})},{key:'previousSchool',label:'Previous school',required:false},{key:'guardianFirstName',label:'Guardian first name',required:true},{key:'guardianLastName',label:'Guardian last name',required:true},{key:'guardianPhone',label:'Guardian phone',required:true},{key:'guardianEmail',label:'Guardian email (optional)',type:'email',required:false},{key:'guardianRelationship',label:'Relationship',required:true},{key:'address',label:'Address',type:'textarea',required:false},{key:'notes',label:'Notes',type:'textarea',required:false}],{firstName:a.first_name,middleName:a.middle_name||'',lastName:a.last_name,sex:a.sex||'',dateOfBirth:a.date_of_birth?String(a.date_of_birth).slice(0,10):'',requestedGradeCode:a.requested_grade_code,previousSchool:a.previous_school||'',guardianFirstName:a.guardian_first_name,guardianLastName:a.guardian_last_name,guardianPhone:a.guardian_phone,guardianEmail:a.guardian_email||'',guardianRelationship:a.guardian_relationship,address:a.address||'',notes:a.notes||''},function(v){return raw('/api/admissions/'+id+'/details',{method:'PATCH',body:JSON.stringify({firstName:v.firstName,middleName:v.middleName||null,lastName:v.lastName,sex:v.sex||null,dateOfBirth:v.dateOfBirth||null,requestedGradeCode:v.requestedGradeCode,previousSchool:v.previousSchool||null,guardianFirstName:v.guardianFirstName,guardianLastName:v.guardianLastName,guardianPhone:v.guardianPhone,guardianEmail:v.guardianEmail||null,guardianRelationship:v.guardianRelationship,address:v.address||null,notes:v.notes||null})})})}
function rxReviewAdmission(id,status,label,requiredNote){form(label,[{key:'reviewNote',label:'Review note'+(requiredNote?'':' (optional)'),type:'textarea',required:!!requiredNote}],{},function(v){return raw('/api/admissions/'+id,{method:'PATCH',body:JSON.stringify({status:status,reviewNote:v.reviewNote||undefined})})})}
function rxWireAdmissionReviewButtons(){var mb=E('modalBody');if(!mb||!rxLastAdmissionId)return;var actions=mb.querySelector('.actions');if(actions&&!E('rxEditAdmissionDetails'))actions.insertAdjacentHTML('afterbegin','<button id="rxEditAdmissionDetails" class="ghost">Edit Application</button>');var edit=E('rxEditAdmissionDetails');if(edit&&!edit.dataset.rx){edit.dataset.rx='1';edit.onclick=function(){rxEditAdmissionDetails(rxLastAdmissionId)}}[['markAdmissionReview','under_review','Review before approval',false],['approveAdmission','approved','Review and approve admission',true],['waitlistAdmission','waitlisted','Waitlist admission',true],['declineAdmission','declined','Decline admission',true]].forEach(function(x){var b=E(x[0]);if(b&&!b.dataset.rx){b.dataset.rx='1';b.onclick=function(){rxReviewAdmission(rxLastAdmissionId,x[1],x[2],x[3])}}})}
setInterval(function(){ensureSchoolSetupCatalogSections().catch(function(){});ensureApprovedAdmissionEnrolmentPanel().catch(function(){});rxWireAdmissionReviewButtons()},1200);
`;

patchFile(uiPath, source => {
  let next = source;
  next = next.replace(/Grading Setup/g,'Grading Scheme');
  next = next.replace(/<\/style>/,' .req{color:#ff7482;font-weight:900}</style>');
  const formRegex = /function field\(f,v\)\{[\s\S]*?function confirmDo\(/;
  if (formRegex.test(next)) next = next.replace(formRegex, validatedFormSource + 'function confirmDo(');
  if (!next.includes('function rxSetupOption(')) {
    const helperAnchor = 'function E(id){return document.getElementById(id)}';
    if (next.includes(helperAnchor)) next = next.replace(helperAnchor, helperAnchor + uiHelper);
    else console.warn('Could not find function E(id) UI anchor');
  }
  if (!next.includes('id=\\\"addGrade\\\"') && !next.includes('id="addGrade"')) {
    next = next.replace(/<h2>Grade Levels<\/h2><\/div><div class=\\?"panel\\?">/,'<h2>Grade Levels</h2><button id=\\\"addGrade\\\" class=\\\"ghost\\\">Add grade level</button></div><div class=\\\"panel\\\">');
  }
  next = next.replace(/\{key:'stage',render:function\(r\)\{return badge\(r\.stage\)\}\},\{key:'is_active',label:'Status',render:function\(r\)\{return badge\(r\.is_active\?'active':'inactive'\)\}\}\],function\(r\)\{return '<button class=\\?"mini\\?" data-edit-grade=\\?"'\+r\.id\+'\\?">Edit<\/button>'\}\)\+'<\/div>';/,"{key:'stage',render:function(r){return badge(r.stage)}},{key:'level_order',label:'Order'},{key:'is_active',label:'Status',render:function(r){return badge(r.is_active?'active':'inactive')}}],function(r){return '<button class=\\\"mini\\\" data-edit-grade=\\\"'+r.id+'\\\">Edit</button>'})+'</div>';");
  const addGradeHandler = "   E('addGrade').onclick=function(){form('New grade level',[{key:'code',label:'Code e.g. KG1, P1, JHS1',required:true},{key:'name',label:'Grade name e.g. Primary 1',required:true},{key:'stage',label:'Stage',type:'select',required:true,options:[{value:'primary',label:'Primary'},{value:'jhs',label:'JHS'}]},{key:'levelOrder',label:'Display / promotion order',type:'number',required:true},{key:'isActive',label:'Status',type:'select',required:true,options:[{value:'true',label:'Active'},{value:'false',label:'Inactive'}]}],{stage:'primary',isActive:'true'},function(v){return raw('/api/grade-levels',{method:'POST',body:JSON.stringify({code:v.code,name:v.name,stage:v.stage,levelOrder:Number(v.levelOrder),isActive:v.isActive==='true'})})})};\n";
  if (!next.includes("E('addGrade').onclick=function()")) {
    const marker = /\n\s*E\('content'\)\.onclick=async function\(e\)\{/;
    if (marker.test(next)) next = next.replace(marker, '\n' + addGradeHandler + "   E('content').onclick=async function(e){");
  }
  return next;
});

console.log('Academic setup, validation, admission review and subject teacher patch applied before TypeScript build.');
