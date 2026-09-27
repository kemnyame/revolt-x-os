import { readFileSync } from 'node:fs';
import vm from 'node:vm';

function checkInlineHtml(relative,name){
  const html=readFileSync(new URL(relative,import.meta.url),'utf8');
  const scripts=[...html.matchAll(/<script(?:\s[^>]*)?>([\s\S]*?)<\/script>/gi)]
    .filter(m=>!/<script[^>]+src=/i.test(m[0]))
    .map(m=>m[1]);
  if(!scripts.length)throw new Error(name+' inline script not found');
  scripts.forEach((source,i)=>new vm.Script(source,{filename:name+'-inline-'+(i+1)+'.js'}));
}

function checkJs(relative,name){
  const source=readFileSync(new URL(relative,import.meta.url),'utf8');
  new vm.Script(source,{filename:name});
}

checkInlineHtml('../public/salon.html','salon');
checkInlineHtml('../public/salon-storefront.html','salon-storefront');
checkInlineHtml('../public/customer-portal.html','customer-portal');
checkJs('../public/shop-enterprise.js','shop-enterprise.js');
console.log('Shop browser JavaScript syntax OK');
