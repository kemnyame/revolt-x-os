import { schoolAppScript } from '../dist/ui.js';
import { teacherFrontend } from '../dist/teacher-ui.js';
import { parentFrontend } from '../dist/parent-ui.js';
import { studentFrontend } from '../dist/student-ui.js';
import { admissionsFrontend } from '../dist/admissions-ui.js';
import { loginFrontend } from '../dist/login-ui.js';
import { schoolDesignScript } from '../dist/school-design.js';

function validateScript(name,source){
  try{
    new Function(source);
  }catch(error){
    throw new Error(`${name} browser script is invalid: ${error.message}`);
  }
}

function inlineScripts(name,html){
  const scripts=[];
  const re=/<script(?![^>]*\bsrc=)[^>]*>([\s\S]*?)<\/script>/gi;
  let match;
  while((match=re.exec(html)))scripts.push(match[1]);
  if(!scripts.length)throw new Error(`${name} has no inline browser script to validate`);
  return scripts;
}

validateScript('School',schoolAppScript);
validateScript('Shared school design',schoolDesignScript);

for(const [name,html] of [
  ['Teacher',teacherFrontend],
  ['Parent',parentFrontend],
  ['Student',studentFrontend],
  ['Admissions',admissionsFrontend],
  ['Login',loginFrontend]
]){
  inlineScripts(name,html).forEach((script,index)=>validateScript(`${name} #${index+1}`,script));
}

console.log('Browser frontend validation passed');
