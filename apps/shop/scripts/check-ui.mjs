import { readFileSync } from 'node:fs';
import vm from 'node:vm';

const html=readFileSync(new URL('../public/salon.html',import.meta.url),'utf8');
const start=html.indexOf('<script>');
const end=html.lastIndexOf('</script>');
if(start<0||end<0||end<=start)throw new Error('salon.html inline script not found');
const source=html.slice(start+8,end);
new vm.Script(source,{filename:'salon-inline.js'});
console.log('Salon UI JavaScript syntax OK');
