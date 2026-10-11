import { readFile, writeFile } from 'node:fs/promises';

const uiPath=new URL('../src/ui.ts',import.meta.url);
let ui=await readFile(uiPath,'utf8');

const reserved="else if(p==='hr'||p==='payroll'){";
if(ui.includes(reserved)){
  ui=ui.replace(reserved,"else if(p==='hr_reserved'||p==='payroll_reserved'){");
  ui=ui.replace("var moduleName=p==='hr'?'HR':'Payroll',moduleIcon=p==='hr'?'staff':'money';","var moduleName=p==='hr_reserved'?'HR':'Payroll',moduleIcon=p==='hr_reserved'?'staff':'money';");
}

await writeFile(uiPath,ui);
console.log('Retired reserved School module placeholder routes and checks');
