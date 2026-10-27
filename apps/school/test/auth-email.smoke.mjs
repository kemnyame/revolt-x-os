import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {createHash,randomUUID} from 'node:crypto';
import {runInNewContext} from 'node:vm';
import {loadSchoolConfig} from '../dist/config.js';
import {authEmailStatus,gmailMailerUrl,sendAuthEmail,schoolAccessEmail} from '../dist/auth-email.js';
import {staffPasswordSetupFrontend} from '../dist/login-ui.js';
const config=loadSchoolConfig({NODE_ENV:'test',SCHOOL_DATABASE_URL:'postgres://localhost/test',CORE_OS_URL:'https://core.example.test',PUBLIC_BASE_URL:'https://school.example.test',AUTH_EMAIL_PROVIDER:'gmail',GMAIL_FROM_EMAIL:'owner@gmail.com',GMAIL_MAILER_URL:'https://script.google.com/macros/s/deployment_test/exec',GMAIL_MAILER_SECRET:'test-secret-'.repeat(5)});
const message=schoolAccessEmail(config,{email:'staff@example.test',schoolSlug:'alpha',schoolName:'Alpha <School>',kind:'password_reset',staffId:'STF-001',resetToken:'t'.repeat(43)});
test('account emails bind the correct School and recipient, escape markup and omit temporary passwords',()=>{
 assert.equal(message.to,'staff@example.test');assert.match(message.body,/\/s\/alpha\/staff-password-setup\?token=/);assert.match(message.body,/30 minutes/);assert.match(message.html,/Alpha &lt;School&gt;/);assert.ok(!message.messageKey.includes('t'.repeat(43)));assert.equal(authEmailStatus(config).configured,true);
 const admin=schoolAccessEmail(config,{email:'admin@example.test',schoolSlug:'beta',schoolName:'Beta',kind:'password_reset',administrator:true,resetToken:'s'.repeat(43)});assert.match(admin.body,/\/s\/beta\/admin-password-reset\?token=/);
 assert.throws(()=>gmailMailerUrl('https://attacker.example/macros/s/test/exec'));assert.throws(()=>gmailMailerUrl(config.GMAIL_MAILER_URL+'?secret=test'));
 assert.ok(staffPasswordSetupFrontend.includes('/api/auth/staff-password-setup'));assert.ok(!staffPasswordSetupFrontend.includes("fetch('/api/auth/admin-password-reset'"));
 for(const script of staffPasswordSetupFrontend.matchAll(/<script[^>]*>([\s\S]*?)<\/script>/gi))assert.doesNotThrow(()=>new Function(script[1]));
});
test('Gmail sends immediately to the exact recipient without the Resend test restriction or an outbox',async t=>{
 const calls=[];t.mock.method(globalThis,'fetch',async(url,init)=>{calls.push({url,init});return Response.json({ok:true,id:'gas-test-receipt',sender:'owner@gmail.com'})});
 const result=await sendAuthEmail(config,message);assert.equal(result.provider,'gmail');assert.equal(calls.length,1);const body=JSON.parse(calls[0].init.body);assert.equal(body.to,'staff@example.test');assert.equal(body.expectedSender,'owner@gmail.com');assert.match(body.requestId,/^[a-f0-9]{64}$/);assert.equal(calls[0].init.redirect,'manual');assert.equal(calls[0].init.headers.authorization,undefined);
});
test('Google content redirects receive a GET with no shared secret or message',async t=>{
 const calls=[];t.mock.method(globalThis,'fetch',async(url,init)=>{calls.push({url,init});return calls.length===1?new Response(null,{status:302,headers:{location:'https://script.googleusercontent.com/macros/echo?user_content_key=test'}}):Response.json({ok:true,id:'gas-test-receipt',sender:'owner@gmail.com'})});
 await sendAuthEmail(config,message);assert.equal(calls.length,2);assert.equal(calls[1].init.body,undefined);assert.equal(calls[1].init.headers,undefined);assert.equal(calls[1].init.method,undefined);
});
test('untrusted redirects, sender mismatches and uncertain submissions cannot trigger a duplicate',async t=>{
 const calls=[];t.mock.method(globalThis,'fetch',async(url,init)=>{calls.push({url,init});return new Response(null,{status:302,headers:{location:'https://attacker.example/collect'}})});
 await assert.rejects(sendAuthEmail(config,message),error=>error.kind==='configuration');assert.equal(calls.length,1);
});
test('transport failures are held for review without automatic resend or secret disclosure',async t=>{
 const mock=t.mock.method(globalThis,'fetch',async()=>{throw new Error(config.GMAIL_MAILER_SECRET)});await assert.rejects(sendAuthEmail(config,message),error=>error.kind==='review'&&!error.message.includes(config.GMAIL_MAILER_SECRET));assert.equal(mock.mock.callCount(),1);
});
const source=await readFile(new URL('../integrations/gmail/Code.gs',import.meta.url),'utf8');
function relay(){const store=new Map([['MAILER_SECRET',config.GMAIL_MAILER_SECRET],['SENDER_EMAIL','owner@gmail.com']]);let sends=0,throwOnSend=false;const props={getProperty:key=>store.get(key),setProperty:(key,value)=>store.set(key,value),getProperties:()=>Object.fromEntries(store),deleteProperty:key=>store.delete(key)};const context={PropertiesService:{getScriptProperties:()=>props},Session:{getEffectiveUser:()=>({getEmail:()=> 'owner@gmail.com'})},MailApp:{getRemainingDailyQuota:()=>100,sendEmail:()=>{sends++;if(throwOnSend)throw new Error('simulated failure')}},LockService:{getScriptLock:()=>({tryLock:()=>true,releaseLock(){}})},Utilities:{getUuid:randomUUID,DigestAlgorithm:{SHA_256:'sha256'},computeDigest:(_algorithm,value)=>[...createHash('sha256').update(value).digest()],base64Encode:bytes=>Buffer.from(bytes).toString('base64')},ContentService:{MimeType:{JSON:'json'},createTextOutput:text=>({setMimeType:()=>text})}};runInNewContext(source,context);return{post:data=>JSON.parse(context.doPost({postData:{contents:JSON.stringify(data)}})),count:()=>sends,fail:()=>{throwOnSend=true}}}
const request={secret:config.GMAIL_MAILER_SECRET,expectedSender:'owner@gmail.com',requestId:'a'.repeat(64),to:'staff@example.test',replyTo:'owner@gmail.com',subject:'Choose your password',text:'Test only',html:'<p>Test only</p>'};
test('Google sender authenticates requests and deduplicates identical messages',()=>{const r=relay();assert.equal(r.post({...request,secret:'wrong'}).code,'AUTH');assert.equal(r.post({...request,expectedSender:'another@gmail.com'}).code,'WRONG_SENDER');assert.equal(r.count(),0);const first=r.post(request),second=r.post(request);assert.equal(first.ok,true);assert.equal(second.id,first.id);assert.equal(r.count(),1);assert.equal(r.post({...request,text:'changed'}).code,'CONFLICT');assert.equal(r.count(),1)});
test('an interrupted Google send remains uncertain and is not automatically retried',()=>{const r=relay();r.fail();assert.equal(r.post(request).code,'NEEDS_REVIEW');assert.equal(r.post(request).code,'NEEDS_REVIEW');assert.equal(r.count(),1)});
test('malformed sender requests never submit mail',()=>{const r=relay();for(const value of [null,[],42,'text'])assert.equal(r.post(value).code,'BAD_REQUEST');assert.equal(r.count(),0)});
