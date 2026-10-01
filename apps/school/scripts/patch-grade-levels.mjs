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
  else console.log(`No school setup/onboarding patch changes needed for ${path.basename(filePath)}`);
}

const gradeLevelApi = `app.get('/api/grade-levels',async request=>{const a=await authorize(request,db,config,'academic.view');return (await db.query('SELECT * FROM grade_levels WHERE organisation_id=$1 ORDER BY level_order',[a.core.organisation_id])).rows});
app.post('/api/grade-levels',async(request,reply)=>{
  const a=await authorize(request,db,config,'academic.create');
  const b=z.object({
    code:z.string().trim().min(1).max(20),
    name:z.string().trim().min(2).max(80),
    stage:z.enum(['primary','jhs']),
    levelOrder:z.coerce.number().int().min(1).max(99),
    isActive:z.boolean().default(true)
  }).parse(request.body);
  try{
    const row=await one<any>(db,'INSERT INTO grade_levels(organisation_id,code,name,stage,level_order,is_active) VALUES($1,$2,$3,$4,$5,$6) RETURNING *',[a.core.organisation_id,b.code.toUpperCase(),b.name,b.stage,b.levelOrder,b.isActive]);
    await audit(a.core.organisation_id,a.core.id,'grade_level.created','grade_level',row.id,{code:row.code,stage:row.stage,levelOrder:row.level_order});
    return reply.code(201).send(row);
  }catch(error:any){
    if(error?.code==='23505')throw fail(409,'A grade level with this code or order already exists. Use a unique code and display order.');
    throw error;
  }
});`;

const onboardingApi = String.raw`
app.get('/api/student-onboarding/admission-candidates',async request=>{
  const a=await authorize(request,db,config,'students.create');
  return (await db.query(\`SELECT aa.*,g.id requested_grade_id,g.name requested_grade_name,g.level_order requested_grade_order,
      (SELECT count(*)::int FROM classrooms c WHERE c.organisation_id=aa.organisation_id AND c.grade_level_id=g.id AND c.is_active=true) matching_class_count
    FROM admission_applications aa
    LEFT JOIN grade_levels g ON g.organisation_id=aa.organisation_id AND lower(g.code)=lower(aa.requested_grade_code)
    WHERE aa.organisation_id=$1 AND aa.status='approved' AND aa.student_id IS NULL
    ORDER BY aa.reviewed_at DESC NULLS LAST,aa.submitted_at DESC\`,[a.core.organisation_id])).rows;
});
app.post('/api/student-onboarding/admission-candidates/:id/enrol',async(request,reply)=>{
  const a=await authorize(request,db,config,'students.create');
  const {id}=z.object({id:z.string().uuid()}).parse(request.params);
  const b=z.object({
    classroomId:z.string().uuid(),
    admissionNo:z.string().trim().min(1).max(60).optional()
  }).parse(request.body);
  const result=await tx(db,async client=>{
    const application=await one<any>(client,'SELECT * FROM admission_applications WHERE id=$1 AND organisation_id=$2 FOR UPDATE',[id,a.core.organisation_id]);
    if(application.status!=='approved')throw fail(409,'Only approved admission applications can be enrolled');
    if(application.student_id)throw fail(409,'This admission application has already been converted into a student record');
    const classroom=await one<any>(client,\`SELECT c.*,g.code grade_code,g.name grade_name FROM classrooms c
      JOIN grade_levels g ON g.id=c.grade_level_id
      WHERE c.id=$1 AND c.organisation_id=$2 AND c.is_active=true\`,[b.classroomId,a.core.organisation_id]);
    const admissionNo=(b.admissionNo||String(application.application_no||'').replace(/^ADM/i,'STU')).trim();
    if(!admissionNo)throw fail(400,'Enter a Student ID / admission number');
    const student=await one<any>(client,\`INSERT INTO students(
        organisation_id,admission_no,first_name,middle_name,last_name,sex,date_of_birth,admission_date,notes
      ) VALUES($1,$2,$3,$4,$5,$6,$7,current_date,$8) RETURNING *\`,[
        a.core.organisation_id,admissionNo,application.first_name,application.middle_name,application.last_name,
        application.sex,application.date_of_birth,
        [application.notes,application.previous_school?'Previous school: '+application.previous_school:null,'Created from admission application '+application.application_no].filter(Boolean).join('\\n')
      ]);
    let guardian=await maybeOne<any>(client,'SELECT * FROM guardians WHERE organisation_id=$1 AND phone=$2 ORDER BY created_at LIMIT 1',
      [a.core.organisation_id,application.guardian_phone]);
    if(!guardian){
      guardian=await one<any>(client,\`INSERT INTO guardians(organisation_id,first_name,last_name,phone,email,address)
        VALUES($1,$2,$3,$4,$5,$6) RETURNING *\`,[
        a.core.organisation_id,application.guardian_first_name,application.guardian_last_name,
        application.guardian_phone,application.guardian_email||null,application.address||null
      ]);
    }else{
      guardian=await one<any>(client,\`UPDATE guardians SET first_name=$1,last_name=$2,email=COALESCE($3,email),address=COALESCE($4,address),updated_at=now()
        WHERE id=$5 RETURNING *\`,[
        application.guardian_first_name,application.guardian_last_name,application.guardian_email||null,application.address||null,guardian.id
      ]);
    }
    await client.query('UPDATE student_guardians SET is_primary=false WHERE student_id=$1',[student.id]);
    await client.query(\`INSERT INTO student_guardians(student_id,guardian_id,relationship,is_primary)
      VALUES($1,$2,$3,true)
      ON CONFLICT(student_id,guardian_id) DO UPDATE SET relationship=EXCLUDED.relationship,is_primary=true\`,
      [student.id,guardian.id,application.guardian_relationship]);
    const enrolment=await one<any>(client,\`INSERT INTO enrolments(organisation_id,student_id,academic_year_id,classroom_id,status)
      VALUES($1,$2,$3,$4,'active') RETURNING *\`,[
      a.core.organisation_id,student.id,classroom.academic_year_id,classroom.id
    ]);
    await assignMandatoryFees(client,a.core.organisation_id,student.id,classroom.academic_year_id,classroom.id);
    await client.query(\`INSERT INTO student_status_history(organisation_id,student_id,old_status,new_status,reason,changed_by_os_user_id,enrolment_id,classroom_id)
      VALUES($1,$2,NULL,'active',$3,$4,$5,$6)\`,[
      a.core.organisation_id,student.id,'Student enrolled from approved admission application '+application.application_no,a.core.id,enrolment.id,classroom.id
    ]);
    await client.query(\`UPDATE admission_applications SET status='enrolled',student_id=$1,updated_at=now(),reviewed_at=COALESCE(reviewed_at,now()),reviewed_by_os_user_id=COALESCE(reviewed_by_os_user_id,$2)
      WHERE id=$3 AND organisation_id=$4\`,[student.id,a.core.id,id,a.core.organisation_id]);
    await client.query(\`INSERT INTO admission_status_history(organisation_id,application_id,old_status,new_status,note,actor_os_user_id)
      VALUES($1,$2,'approved','enrolled',$3,$4)\`,[
      a.core.organisation_id,id,'Converted to student record '+student.admission_no+' and enrolled in '+classroom.name,a.core.id
    ]);
    return{student,guardian,enrolment,classroom,applicationNo:application.application_no};
  });
  await audit(a.core.organisation_id,a.core.id,'admission.enrolled','admission_application',id,{studentId:result.student.id,classroomId:result.classroom.id});
  return reply.code(201).send(result);
});
`;

patchFile(serverPath, source => {
  let next = source;

  if (!next.includes("app.post('/api/grade-levels'")) {
    const getGradeLevels = /app\.get\('\/api\/grade-levels',[\s\S]*?\}\);(?=\s*app\.get\('\/api\/classes')/;
    if (getGradeLevels.test(next)) next = next.replace(getGradeLevels, gradeLevelApi);
    else console.warn('Could not find grade-level API anchor in src/server.ts; skipped grade-level create route.');
  }

  if (!next.includes("app.get('/api/student-onboarding/admission-candidates'")) {
    const anchor = "app.get('/api/students/directory'";
    if (next.includes(anchor)) next = next.replace(anchor, onboardingApi + "\n" + anchor);
    else console.warn('Could not find students directory anchor in src/server.ts; skipped admission onboarding API.');
  }

  return next;
});

const uiHelper = String.raw`
function rxSetupOption(v,t){return '<option value="'+esc(v)+'">'+esc(t)+'</option>'}
function rxSetupRows(items,empty,cols){if(!items||!items.length)return '<div class="empty">'+esc(empty)+'</div>';return '<div class="table"><table><thead><tr>'+cols.map(function(c){return '<th>'+esc(c.label)+'</th>'}).join('')+'</tr></thead><tbody>'+items.map(function(item){return '<tr>'+cols.map(function(c){return '<td>'+esc(typeof c.value==='function'?c.value(item):item[c.value])+'</td>'}).join('')+'</tr>'}).join('')+'</tbody></table></div>'}
async function ensureSchoolSetupCatalogSections(){
  var content=E('content');if(!content||E('addSubject')||!Array.from(content.querySelectorAll('h2')).some(function(h){return h.textContent.trim()==='Grade Levels'}))return;
  var data=await Promise.all([raw('/api/academic-years'),raw('/api/grade-levels'),raw('/api/classes'),raw('/api/subjects')]).catch(function(){return null});
  if(!data)return;
  var years=data[0]||[],grades=data[1]||[],classes=data[2]||[],subjects=data[3]||[];
  var gradeSection=Array.from(content.querySelectorAll('.section h2')).find(function(h){return h.textContent.trim()==='Grade Levels'});
  if(!gradeSection)return;
  var insertAfter=gradeSection.parentElement&&gradeSection.parentElement.nextElementSibling?gradeSection.parentElement.nextElementSibling:gradeSection.parentElement;
  var html='<div class="section"><h2>Classes</h2><button id="addClass" class="ghost">Add class</button></div><div class="panel">'+
    rxSetupRows(classes,'No classes created yet',[
      {label:'Class',value:'name'},{label:'Grade',value:function(r){return r.grade_name||r.grade_code||''}},
      {label:'Academic year',value:function(r){return r.academic_year||r.academic_year_id||''}},
      {label:'Students',value:function(r){return r.student_count==null?'0':r.student_count}},
      {label:'Subjects',value:function(r){return r.subject_count==null?'0':r.subject_count}}
    ])+'</div>'+ 
    '<div class="section"><h2>Subjects</h2><button id="addSubject" class="ghost">Add subject</button></div><div class="panel">'+
    rxSetupRows(subjects,'No subjects created yet',[
      {label:'Code',value:'code'},{label:'Subject',value:'name'},{label:'Stage',value:'stage'},
      {label:'Status',value:function(r){return r.is_active?'active':'inactive'}}
    ])+'</div>';
  insertAfter.insertAdjacentHTML('afterend',html);
  E('addSubject').onclick=function(){form('New subject',[
    {key:'code',label:'Code e.g. ENG, MATH, SCI'},
    {key:'name',label:'Subject name e.g. English Language'},
    {key:'stage',label:'Stage',type:'select',options:[{value:'both',label:'Both Primary and JHS'},{value:'primary',label:'Primary only'},{value:'jhs',label:'JHS only'}]}
  ],{stage:'both'},function(v){return raw('/api/subjects',{method:'POST',body:JSON.stringify({code:v.code,name:v.name,stage:v.stage})})})};
  E('addClass').onclick=function(){form('New class',[
    {key:'academicYearId',label:'Academic year',type:'select',options:years.map(function(y){return{value:y.id,label:y.name+(y.status==='active'?' - active':'')}})},
    {key:'gradeLevelId',label:'Grade level',type:'select',options:grades.map(function(g){return{value:g.id,label:g.name+' ('+g.code+')'}})},
    {key:'name',label:'Class name e.g. Primary 1 A'},
    {key:'stream',label:'Stream / Arm e.g. A, B',required:false},
    {key:'capacity',label:'Capacity',type:'number',required:false}
  ],{academicYearId:(years.find(function(y){return y.status==='active'})||years[0]||{}).id||''},function(v){return raw('/api/classes',{method:'POST',body:JSON.stringify({academicYearId:v.academicYearId,gradeLevelId:v.gradeLevelId,name:v.name,stream:v.stream||undefined,capacity:v.capacity?Number(v.capacity):undefined})})})};
}
var rxAdmissionPanelBusy=false;
async function ensureApprovedAdmissionEnrolmentPanel(){
  var content=E('content');if(!content||E('approvedAdmissionPanel')||rxAdmissionPanelBusy)return;
  var h=content.querySelector('h1');if(!h||!/student/i.test(h.textContent)||/statement/i.test(h.textContent))return;
  rxAdmissionPanelBusy=true;
  try{
    var data=await Promise.all([raw('/api/student-onboarding/admission-candidates'),raw('/api/classes')]);
    var applications=data[0]||[],classes=data[1]||[];
    var panel=document.createElement('div');panel.id='approvedAdmissionPanel';panel.className='panel';
    var rows=applications.length?applications.map(function(a){
      var defaultAdmission=String(a.application_no||'').replace(/^ADM/i,'STU');
      var classOptions=classes.map(function(c){var label=(c.name||'Class')+' - '+(c.grade_name||c.grade_code||'');return rxSetupOption(c.id,label)}).join('');
      return '<div class="admission-enrol-row" data-application-id="'+esc(a.id)+'" style="border:1px solid var(--line);border-radius:10px;padding:10px;margin-top:9px">'+
        '<b>'+esc([a.first_name,a.middle_name,a.last_name].filter(Boolean).join(' '))+'</b> <span class="badge">approved</span>'+ 
        '<div class="muted">Application: '+esc(a.application_no)+' • Requested grade: '+esc(a.requested_grade_name||a.requested_grade_code||'')+' • Guardian: '+esc(a.guardian_first_name+' '+a.guardian_last_name)+' / '+esc(a.guardian_phone)+'</div>'+ 
        '<div class="row" style="margin-top:8px"><label>Student ID / Admission No.<input class="rx-enrol-admission-no" value="'+esc(defaultAdmission)+'"></label><label>Class for enrolment<select class="rx-enrol-class">'+classOptions+'</select></label><button class="primary rx-enrol-admission" type="button">Enrol student</button></div>'+ 
      '</div>';
    }).join(''):'<div class="empty">No approved admission application is waiting for enrolment.</div>';
    panel.innerHTML='<div class="section compact"><div><h2>Approved Admissions Ready for Enrolment</h2><p class="muted">Approved admission records appear here. Click Enrol student to reuse the captured details and avoid duplicate student entry.</p></div></div>'+rows;
    var anchor=content.querySelector('.panel');content.insertBefore(panel,anchor||content.firstChild);
  }catch(e){}finally{rxAdmissionPanelBusy=false}
}
document.addEventListener('click',async function(e){
  var btn=e.target&&e.target.closest?e.target.closest('.rx-enrol-admission'):null;if(!btn)return;
  var row=btn.closest('.admission-enrol-row');if(!row)return;
  btn.disabled=true;var old=btn.textContent;btn.textContent='Enrolling...';
  try{
    var id=row.getAttribute('data-application-id');
    var classroomId=row.querySelector('.rx-enrol-class').value;
    var admissionNo=row.querySelector('.rx-enrol-admission-no').value;
    await raw('/api/student-onboarding/admission-candidates/'+encodeURIComponent(id)+'/enrol',{method:'POST',body:JSON.stringify({classroomId:classroomId,admissionNo:admissionNo})});
    row.innerHTML='<div class="success"><b>Student enrolled successfully.</b> The applicant has been converted into a student record and linked to the selected class.</div>';
  }catch(err){alert(err.message||'Could not enrol student');btn.disabled=false;btn.textContent=old}
});
setInterval(function(){ensureSchoolSetupCatalogSections().catch(function(){});ensureApprovedAdmissionEnrolmentPanel().catch(function(){})},1200);
`;

patchFile(uiPath, source => {
  let next = source;

  if (!next.includes('function rxSetupOption(')) {
    const helperAnchor = "function E(i){return document.getElementById(i)}";
    if (next.includes(helperAnchor)) next = next.replace(helperAnchor, helperAnchor + uiHelper);
    else console.warn('Could not find UI helper anchor; skipped School Setup/Admission panel helpers.');
  }

  if (!next.includes('id=\\\"addGrade\\\"') && !next.includes('id="addGrade"')) {
    next = next.replace(
      /<h2>Grade Levels<\/h2><\/div><div class=\\?"panel\\?">/,
      '<h2>Grade Levels</h2><button id=\\\"addGrade\\\" class=\\\"ghost\\\">Add grade level</button></div><div class=\\\"panel\\\">'
    );
  }

  next = next.replace(
    /\{key:'stage',render:function\(r\)\{return badge\(r\.stage\)\}\},\{key:'is_active',label:'Status',render:function\(r\)\{return badge\(r\.is_active\?'active':'inactive'\)\}\}\],function\(r\)\{return '<button class=\\?"mini\\?" data-edit-grade=\\?"'\+r\.id\+'\\?">Edit<\/button>'\}\)\+'<\/div>';/,
    "{key:'stage',render:function(r){return badge(r.stage)}},{key:'level_order',label:'Order'},{key:'is_active',label:'Status',render:function(r){return badge(r.is_active?'active':'inactive')}}],function(r){return '<button class=\\\"mini\\\" data-edit-grade=\\\"'+r.id+'\\\">Edit</button>'})+'</div>';"
  );

  const addGradeHandler = "   E('addGrade').onclick=function(){form('New grade level',[{key:'code',label:'Code e.g. KG1, P1, JHS1'},{key:'name',label:'Grade name e.g. Primary 1'},{key:'stage',label:'Stage',type:'select',options:[{value:'primary',label:'Primary'},{value:'jhs',label:'JHS'}]},{key:'levelOrder',label:'Display / promotion order',type:'number'},{key:'isActive',label:'Status',type:'select',options:[{value:'true',label:'Active'},{value:'false',label:'Inactive'}]}],{stage:'primary',isActive:'true'},function(v){return raw('/api/grade-levels',{method:'POST',body:JSON.stringify({code:v.code,name:v.name,stage:v.stage,levelOrder:Number(v.levelOrder),isActive:v.isActive==='true'})})})};\n";
  if (!next.includes("E('addGrade').onclick=function()")) {
    const marker = /\n\s*E\('content'\)\.onclick=async function\(e\)\{/;
    if (marker.test(next)) next = next.replace(marker, '\n' + addGradeHandler + "   E('content').onclick=async function(e){");
    else console.warn('Could not find setup click handler anchor in src/ui.ts; skipped Add Grade handler.');
  }

  return next;
});

console.log('School setup catalogue and admission enrolment patch applied before TypeScript build.');
