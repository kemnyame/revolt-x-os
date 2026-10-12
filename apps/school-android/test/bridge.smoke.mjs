import fs from 'node:fs';
import assert from 'node:assert/strict';
import vm from 'node:vm';

const script=fs.readFileSync(new URL('../assets/android-bridge.js',import.meta.url),'utf8');
const listeners=new Map(),messages=[],alerts=[];
let closed=0,originalClicks=0;
class Anchor { click(){originalClicks++} }
const window={top:null,addEventListener(name,fn){listeners.set('window:'+name,fn)},removeEventListener(name,fn){if(listeners.get('window:'+name)===fn)listeners.delete('window:'+name)},alert:message=>alerts.push(message)};window.top=window;
const document={addEventListener(name,fn){listeners.set('document:'+name,fn)},removeEventListener(name,fn){if(listeners.get('document:'+name)===fn)listeners.delete('document:'+name)}};
let blob=new Blob(['School report data'],{type:'application/pdf'}),fetched=[];
class Reader { async readAsDataURL(blob){this.result='data:'+blob.type+';base64,'+Buffer.from(await blob.arrayBuffer()).toString('base64');this.onload()} }
const context=vm.createContext({window,document,HTMLAnchorElement:Anchor,URL,FileReader:Reader,location:{href:'https://revolt-x-school.onrender.com/parent',origin:'https://revolt-x-school.onrender.com'},fetch:async url=>{fetched.push(url);return{ok:true,blob:async()=>blob}}});
vm.runInContext(script.replaceAll('__RX_CHANNEL_TOKEN__','token-one'),context);
const port={start(){},close(){closed++},postMessage:message=>messages.push(JSON.parse(message))};
listeners.get('window:message')({data:'wrong-token',ports:[port]});window.print();assert.equal(messages.length,0);
listeners.get('window:message')({data:'token-one',ports:[port]});window.print();assert.equal(messages.pop().type,'print');
const detached=new Anchor();detached.href='blob:https://revolt-x-school.onrender.com/example';detached.download='report.pdf';detached.click();
await new Promise(resolve=>setTimeout(resolve,15));
assert.equal(messages[0].type,'download_start');assert.equal(messages[0].name,'report.pdf');assert.equal(messages.at(-1).type,'download_end');
assert.equal(Buffer.concat(messages.filter(x=>x.type==='download_chunk').map(x=>Buffer.from(x.data,'base64'))).toString(),'School report data');assert.equal(originalClicks,0);
messages.length=0;blob=new Blob([Buffer.alloc(80000,4)]);detached.click();await new Promise(resolve=>setTimeout(resolve,15));
assert.ok(messages.filter(x=>x.type==='download_chunk').length>1);assert.ok(messages.filter(x=>x.type==='download_chunk').every(x=>x.data.length<=32768));assert.equal(Buffer.concat(messages.filter(x=>x.type==='download_chunk').map(x=>Buffer.from(x.data,'base64'))).length,80000);
messages.length=0;blob=new Blob([Buffer.alloc(16*1024*1024+1)]);detached.click();await new Promise(resolve=>setTimeout(resolve,15));assert.equal(messages.length,0);assert.match(alerts.at(-1),/too large/);
let prevented=false;const foreign={href:'https://foreign.example/file.pdf',download:'file.pdf'};
listeners.get('document:click')({target:{closest:()=>foreign},preventDefault(){prevented=true}});assert.equal(prevented,false);
vm.runInContext(script.replaceAll('__RX_CHANNEL_TOKEN__','token-two'),context);assert.equal(closed,1);
listeners.get('window:message')({data:'token-one',ports:[port]});window.print();assert.equal(messages.length,0);
listeners.get('window:message')({data:'token-two',ports:[port]});window.print();assert.equal(messages.pop().type,'print');
const plain=new Anchor();plain.href='https://revolt-x-school.onrender.com/parent';plain.click();assert.equal(originalClicks,1);
console.log('Android message channel checks passed: nonce, detached exports, bounded chunks, size limit, external links and channel replacement.');
