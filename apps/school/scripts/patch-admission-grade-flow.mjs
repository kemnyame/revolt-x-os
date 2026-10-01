import fs from 'node:fs';
import path from 'node:path';

const serverPath = path.join(process.cwd(), 'src', 'server.ts');
const admissionsPath = path.join(process.cwd(), 'src', 'admissions-ui.ts');
const uiPath = path.join(process.cwd(), 'src', 'ui.ts');

function patchFile(filePath, patcher) {
  if (!fs.existsSync(filePath)) throw new Error(`Missing source file: ${filePath}`);
  const before = fs.readFileSync(filePath, 'utf8');
  const after = patcher(before);
  if (after !== before) fs.writeFileSync(filePath, after);
  else console.log(`No admission grade-flow changes needed for ${path.basename(filePath)}`);
}

patchFile(serverPath, source => {
  let next = source;
  const oldPublicGrades = "const grades=(await db.query('SELECT code,name,stage FROM grade_levels WHERE organisation_id=$1 AND is_active=true ORDER BY level_order',[school.organisation_id])).rows;";
  const newPublicGrades = `let grades=(await db.query('SELECT code,name,stage FROM grade_levels WHERE organisation_id=$1 AND is_active=true ORDER BY level_order',[school.organisation_id])).rows;
  if(!grades.length){
    grades=(await db.query(\`SELECT DISTINCT g.code,g.name,g.stage,g.level_order
      FROM classrooms c JOIN grade_levels g ON g.id=c.grade_level_id
      WHERE c.organisation_id=$1 AND c.is_active=true
      ORDER BY g.level_order\`,[school.organisation_id])).rows;
  }`;
  if (next.includes(oldPublicGrades)) next = next.replace(oldPublicGrades, newPublicGrades);
  return next;
});

patchFile(admissionsPath, source => {
  let next = source;
  next = next.replace(/<label>Requested grade<\/label><select id=\"grade\"><\/select>/g, '<label>Grade applied for</label><select id="grade"></select>');
  next = next.replace("E('grade').innerHTML=x.grades.map(function(g){return'<option value=\"'+g.code+'\">'+esc(g.name)+'</option>'}).join('')", "E('grade').innerHTML=x.grades&&x.grades.length?x.grades.map(function(g){return'<option value=\"'+g.code+'\">'+esc(g.name)+'</option>'}).join(''):'<option value=\"\">No grade level available</option>'");
  next = next.replace("requestedGradeCode:E('grade').value", "requestedGradeCode:E('grade').value");
  next = next.replace("var b={schoolSlug:schoolSlug||undefined,firstName:E('firstName').value", "if(!E('grade').value)throw Error('Create grade levels under School Setup before submitting admission. Admission uses grade applied for; class is selected later during enrolment.');var b={schoolSlug:schoolSlug||undefined,firstName:E('firstName').value");
  return next;
});

patchFile(uiPath, source => {
  let next = source;
  next = next.replace(/\{key:'requestedGradeCode',label:'Requested grade'/g, "{key:'requestedGradeCode',label:'Grade applied for'");
  next = next.replace(/<b>Requested grade:<\/b>/g, '<b>Grade applied for:</b>');
  next = next.replace(/Requested Grade/g, 'Grade Applied For');
  return next;
});
