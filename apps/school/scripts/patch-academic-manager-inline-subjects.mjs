import fs from 'node:fs';
import path from 'node:path';

const uiPath = path.join(process.cwd(), 'src', 'ui.ts');

if (!fs.existsSync(uiPath)) {
  throw new Error(`Missing source file: ${uiPath}`);
}

let source = fs.readFileSync(uiPath, 'utf8');

const start = "     E('managerAddSubjects').onclick=function(){\n";
const end = "     E('managerSubjectRows').onclick=function(e){";
const startIndex = source.indexOf(start);
const endIndex = source.indexOf(end, startIndex + start.length);

if (startIndex < 0 || endIndex < 0) {
  console.warn('Academic Manager Add subjects handler anchor was not found. No inline subject picker patch applied.');
} else if (source.includes('managerInlineSubjectPicker')) {
  console.log('Academic Manager inline subject picker already present.');
} else {
  const replacement = `     E('managerAddSubjects').onclick=function(){
       syncDraft();
       var selected=draft.subjects.map(function(v){return v.subjectId});
       var available=eligibleSubjects(x).filter(function(s){return selected.indexOf(s.id)<0});
       var old=E('managerInlineSubjectPicker');
       if(old){old.remove();return}
       var section=E('managerSubjectRows').parentElement;
       var picker=document.createElement('div');
       picker.id='managerInlineSubjectPicker';
       picker.className='panel';
       picker.style.marginTop='10px';
       picker.innerHTML='<div class="section compact"><div><h3>Add subjects to '+esc(x.name)+'</h3><p class="muted">Select the subjects taught in this class. After adding them, choose the Subject Teacher, periods and hours, then click Save Class Setup.</p></div><button id="managerCloseSubjectPicker" class="ghost" type="button">Close</button></div><input id="managerSubjectSearch" placeholder="Search subject or code"><div id="managerSubjectPicker" class="simple-subject-picker" style="margin-top:8px"></div><button id="managerConfirmSubjects" class="primary" type="button" style="width:100%;margin-top:10px">Add selected subjects to class</button>';
       section.insertBefore(picker,E('managerSubjectRows'));
       function draw(){
         var q=E('managerSubjectSearch').value.trim().toLowerCase();
         var rows=q?available.filter(function(s){return ((s.code||'')+' '+(s.name||'')).toLowerCase().includes(q)}):available;
         E('managerSubjectPicker').innerHTML=rows.length?rows.map(function(s){return '<label class="simple-subject-choice" style="display:flex;gap:10px;align-items:flex-start;padding:9px;border:1px solid var(--line);border-radius:9px;margin:7px 0"><input type="checkbox" data-pick-manager-subject="'+s.id+'" style="width:auto;margin-top:3px"><span><b>'+esc(s.name)+'</b><small style="display:block;color:var(--muted)">'+esc(s.code)+' • '+esc(s.stage)+'</small></span></label>'}).join(''):'<div class="empty">No more subjects are available for this class. Create more subjects under School Setup → Subjects if needed.</div>';
       }
       draw();
       E('managerSubjectSearch').oninput=draw;
       E('managerCloseSubjectPicker').onclick=function(){picker.remove()};
       E('managerConfirmSubjects').onclick=function(){
         var ids=[];
         E('managerSubjectPicker').querySelectorAll('[data-pick-manager-subject]:checked').forEach(function(i){ids.push(i.dataset.pickManagerSubject)});
         if(!ids.length)return toast('Select at least one subject',true);
         ids.forEach(function(id){if(!draftSubject(id))draft.subjects.push({subjectId:id,weeklyPeriods:3,creditHours:2,teacherOsUserId:''})});
         renderClassSetup();
       };
     };
`;
  source = source.slice(0, startIndex) + replacement + source.slice(endIndex);
  fs.writeFileSync(uiPath, source);
  console.log('Academic Manager Add subjects now uses inline subject picker.');
}
