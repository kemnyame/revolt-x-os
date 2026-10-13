import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import {parseHTML} from 'linkedom';
import {schoolAppScript} from '../dist/ui.js';

test('setup renders one catalogue for concurrent refreshes and switches class lists by academic year',async()=>{
  const {document}=parseHTML('<main id="content"><h1>School Setup</h1><div class="section"><h2>Grade levels</h2></div><div class="panel"></div></main>');
  const years=[{id:'old-year',name:'2027/2028',status:'closed'},{id:'current-year',name:'2028/2029',status:'active'}];
  const classes=[{id:'old-class',name:'Class 1',academic_year_id:'old-year'},{id:'current-class',name:'Class 1',academic_year_id:'current-year'}];
  const data={'/api/academic-years':years,'/api/grade-levels':[], '/api/classes?includeAllYears=true':classes,'/api/subjects':[], '/api/class-subjects':[], '/api/staff/core-users':[], '/api/staff/module-memberships':[]};
  const saved=new Map(),calls=[];
  const context={document,E:id=>document.getElementById(id),raw:async path=>{calls.push(path);assert.ok(path in data,path);return data[path]},
    sessionStorage:{getItem:key=>saved.get(key),setItem:(key,value)=>saved.set(key,value)},esc:value=>String(value??''),
    rxSetupRows:(rows,_empty,columns)=>'<table>'+rows.map(row=>'<tr data-test-class="'+row.id+'">'+columns.map(column=>'<td>'+String(typeof column.value==='function'?column.value(row):row[column.value]??'')+'</td>').join('')+'</tr>').join('')+'</table>',
    rxArray:value=>value||[],rxUserLabel:()=>'',rxSetupCatalogueBusy:false};
  const start=schoolAppScript.indexOf('async function ensureSchoolSetupCatalogSections()'),end=schoolAppScript.indexOf('var rxAdmissionPanelBusy=',start);
  assert.ok(start>=0&&end>start);vm.runInNewContext(schoolAppScript.slice(start,end),context);
  await Promise.all([context.ensureSchoolSetupCatalogSections(),context.ensureSchoolSetupCatalogSections(),context.ensureSchoolSetupCatalogSections()]);
  assert.equal(document.querySelectorAll('#rxSetupCatalogue').length,1);assert.equal(calls.filter(path=>path.startsWith('/api/classes')).length,1);
  assert.ok(document.querySelector('[data-test-class="current-class"]'));assert.equal(document.querySelector('[data-test-class="old-class"]'),null);
  const year=document.getElementById('rxSetupYear');
  await year.onchange.call({value:'old-year'});
  assert.equal(document.querySelectorAll('#rxSetupCatalogue').length,1);assert.ok(document.querySelector('[data-test-class="old-class"]'));assert.equal(document.querySelector('[data-test-class="current-class"]'),null);
});
