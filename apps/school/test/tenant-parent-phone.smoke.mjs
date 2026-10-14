import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import {parseHTML} from 'linkedom';
import {mobilePolishScript} from '../dist/mobile-polish.js';

test('parent phone verification preserves the automatically identified school and never recreates a school selector',async()=>{
  const {document,window}=parseHTML('<!doctype html><html><head></head><body data-mobile-role="parent"><form id="mLoginForm"><p id="mLoginSchoolName">Alpha School</p><input id="mLoginSchool" type="hidden" value="alpha"></form></body></html>');
  window.HTMLElement.prototype.focus=()=>{};
  const timers=[],requests=[];
  const context={document,window,Date,URL,URLSearchParams,location:{pathname:'/mobile/parent',search:'?school=alpha'},
    MutationObserver:class{observe(){}},setTimeout:fn=>{timers.push(fn)},setInterval:()=>0,addEventListener(){},
    fetch:async(url,options)=>{requests.push({url,body:JSON.parse(options.body)});return{ok:true,json:async()=>({challengeId:'fixture-challenge',expiresInSeconds:300,destination:'024…000'})}}};
  vm.runInNewContext(mobilePolishScript,context);
  for(let i=0;i<8&&timers.length;i++)timers.shift()();
  assert.equal(document.querySelector('select'),null);assert.equal(document.getElementById('mLoginSchool').value,'alpha');assert.match(document.body.textContent,/Alpha School/);
  document.getElementById('mLoginPhone').value='0240000000';document.getElementById('mLoginStudent').value='STD-001';
  document.getElementById('mLoginForm').dispatchEvent(new window.Event('submit',{bubbles:true,cancelable:true}));
  await new Promise(resolve=>setImmediate(resolve));
  assert.deepEqual(requests,[{url:'/api/mobile/parent/phone-auth/start',body:{schoolSlug:'alpha',phone:'0240000000',studentId:'STD-001'}}]);
});
