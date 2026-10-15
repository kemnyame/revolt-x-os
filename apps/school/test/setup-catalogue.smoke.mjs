import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import {parseHTML} from 'linkedom';
import {schoolCatalogueUi,workflowSharedUi} from '../dist/workflow-ui.js';

function catalogue(){
 const {document}=parseHTML('<main id="content"><h1>School Setup</h1></main>');
 const years=[{id:'old-year',name:'2027/2028',status:'closed',is_locked:true},{id:'current-year',name:'2028/2029',status:'active'}];
 const classes=[{id:'old-class',name:'Old Class',academic_year_id:'old-year'},{id:'current-class',name:'Current Class',academic_year_id:'current-year'}];
 const data={'/api/academic-years':years,'/api/grade-levels':[], '/api/classes?includeAllYears=true':classes,'/api/subjects':[], '/api/class-subjects':[], '/api/staff/core-users':[], '/api/staff/module-memberships':[]};
 const saved=new Map(),calls=[];
 const context={document,current:'setup',E:id=>document.getElementById(id),raw:async path=>{calls.push(path);assert.ok(path in data,path);return data[path]},
   sessionStorage:{getItem:key=>saved.get(key),setItem:(key,value)=>saved.set(key,value)},esc:value=>String(value??''),can:()=>true,badge:x=>x,
   table:rows=>'<div class="table"><table><tbody>'+rows.map(row=>'<tr data-test-class="'+row.id+'"><td>'+row.name+'</td></tr>').join('')+'</tbody></table></div>',rxUserLabel:()=>'',rxSetupCatalogueBusy:false};
 vm.runInNewContext(workflowSharedUi+schoolCatalogueUi,context);return{document,context,calls};
}
test('setup renders one catalogue for concurrent refreshes and switches classes by academic year',async()=>{
 const {document,context,calls}=catalogue();await Promise.all([context.ensureSchoolSetupCatalogSections(),context.ensureSchoolSetupCatalogSections(),context.ensureSchoolSetupCatalogSections()]);
 assert.equal(document.querySelectorAll('#rxSetupCatalogue').length,1);assert.equal(calls.filter(path=>path.startsWith('/api/classes')).length,1);
 assert.ok(document.querySelector('[data-test-class="current-class"]'));assert.equal(document.querySelector('[data-test-class="old-class"]'),null);
 await document.getElementById('rxSetupYear').onchange.call({value:'old-year'});
 assert.equal(document.querySelectorAll('#rxSetupCatalogue').length,1);assert.ok(document.querySelector('[data-test-class="old-class"]'));assert.equal(document.querySelector('[data-test-class="current-class"]'),null);
 assert.equal(document.getElementById('addClass').disabled,true);
});
test('salary grades in HR do not cause academic classes, subjects or teachers to appear there',async()=>{
 const {document,context,calls}=catalogue();context.current='hr';document.getElementById('content').innerHTML='<h1>HR & Payroll</h1><h2>Salary Grades</h2>';
 await context.ensureSchoolSetupCatalogSections();assert.equal(calls.length,0);assert.equal(document.getElementById('rxSetupCatalogue'),null);
});
test('pagination keeps all editable records in the DOM and displays ten at a time',()=>{
 const {document,context}=catalogue();const root=document.getElementById('content');root.innerHTML='<div class="table"><table><tbody>'+Array.from({length:25},(_,i)=>'<tr><td><input value="'+i+'"></td></tr>').join('')+'</tbody></table></div>';
 context.enhancePagination(root);const rows=Array.from(root.querySelectorAll('tbody tr')),visible=()=>rows.filter(r=>r.style.display!=='none');assert.equal(visible().length,10);assert.equal(root.querySelectorAll('input').length,25);
 root.querySelector('[data-next]').onclick();assert.equal(visible()[0],rows[10]);root.querySelector('[data-next]').onclick();assert.equal(visible().length,5);assert.equal(root.querySelector('[data-next]').disabled,true);
 context.enhancePagination(root);assert.equal(root.querySelectorAll('.rx-pagination').length,1);root.querySelector('[data-prev]').onclick();assert.equal(visible()[0],rows[10]);
});
