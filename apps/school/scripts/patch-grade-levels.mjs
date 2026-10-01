import fs from 'node:fs';
import path from 'node:path';

const root = process.cwd();
const serverPath = path.join(root, 'dist', 'server.js');
const uiPath = path.join(root, 'dist', 'ui.js');

function patchFile(filePath, patcher) {
  if (!fs.existsSync(filePath)) throw new Error(`Missing compiled file: ${filePath}`);
  const before = fs.readFileSync(filePath, 'utf8');
  const after = patcher(before);
  if (after !== before) fs.writeFileSync(filePath, after);
  else console.log(`No grade-level patch changes needed for ${path.basename(filePath)}`);
}

const gradeLevelApi = `app.get('/api/grade-levels',async request=>{const a=await authorize(request,db,config,'academic.view');return (await db.query('SELECT * FROM grade_levels WHERE organisation_id=$1 ORDER BY level_order',[a.core.organisation_id])).rows});
app.post('/api/grade-levels',async(request,reply)=>{
  const a=await authorize(request,db,config,'academic.create');
  const b=z.object({
    code:z.string().trim().min(1).max(20),
    name:z.string().trim().min(2).max(80),
    stage:z.enum(['primary','jhs']),
    levelOrder:z.coerce.number().int().min(1).max(99),
    isActive:z.boolean().default(true)
  }).parse(request.body);
  try{
    const row=await one(db,'INSERT INTO grade_levels(organisation_id,code,name,stage,level_order,is_active) VALUES($1,$2,$3,$4,$5,$6) RETURNING *',[a.core.organisation_id,b.code.toUpperCase(),b.name,b.stage,b.levelOrder,b.isActive]);
    await audit(a.core.organisation_id,a.core.id,'grade_level.created','grade_level',row.id,{code:row.code,stage:row.stage,levelOrder:row.level_order});
    return reply.code(201).send(row);
  }catch(error){
    if(error?.code==='23505')throw fail(409,'A grade level with this code or order already exists. Use a unique code and display order.');
    throw error;
  }
});
app.patch('/api/grade-levels/:id',async request=>{
  const a=await authorize(request,db,config,'academic.edit');
  const {id}=z.object({id:z.string().uuid()}).parse(request.params);
  const b=z.object({
    code:z.string().trim().min(1).max(20).optional(),
    name:z.string().trim().min(2).max(80).optional(),
    stage:z.enum(['primary','jhs']).optional(),
    levelOrder:z.coerce.number().int().min(1).max(99).optional(),
    isActive:z.boolean().optional()
  }).refine(v=>Object.keys(v).length>0).parse(request.body);
  const before=await one(db,'SELECT * FROM grade_levels WHERE id=$1 AND organisation_id=$2',[id,a.core.organisation_id]);
  try{
    const row=await one(db,\`UPDATE grade_levels SET
      code=COALESCE($1,code),
      name=COALESCE($2,name),
      stage=COALESCE($3,stage),
      level_order=COALESCE($4,level_order),
      is_active=COALESCE($5,is_active)
      WHERE id=$6 AND organisation_id=$7 RETURNING *\`,[
        b.code?b.code.toUpperCase():null,b.name??null,b.stage??null,b.levelOrder??null,b.isActive??null,id,a.core.organisation_id
      ]);
    await audit(a.core.organisation_id,a.core.id,'grade_level.updated','grade_level',row.id,{before,after:row});
    return row;
  }catch(error){
    if(error?.code==='23505')throw fail(409,'A grade level with this code or order already exists. Use a unique code and display order.');
    throw error;
  }
});`;

patchFile(serverPath, source => {
  if (source.includes("app.post('/api/grade-levels'")) return source;
  const getGradeLevels = /app\.get\('\/api\/grade-levels',[\s\S]*?\}\);(?=\s*app\.get\('\/api\/classes')/;
  if (!getGradeLevels.test(source)) throw new Error('Could not find grade-level API anchor in dist/server.js');
  return source.replace(getGradeLevels, gradeLevelApi);
});

patchFile(uiPath, source => {
  let next = source;

  if (!next.includes('id=\\"addGrade\\"') && !next.includes('id="addGrade"')) {
    next = next.replace(
      /<h2>Grade Levels<\/h2><\/div><div class=\\?"panel\\?">/,
      '<h2>Grade Levels</h2><button id=\\"addGrade\\" class=\\"ghost\\">Add grade level</button></div><div class=\\"panel\\">'
    );
  }

  next = next.replace(
    /\{key:'stage',render:function\(r\)\{return badge\(r\.stage\)\}\},\{key:'is_active',label:'Status',render:function\(r\)\{return badge\(r\.is_active\?'active':'inactive'\)\}\}\],function\(r\)\{return '<button class=\\?"mini\\?" data-edit-grade=\\?"'\+r\.id\+'\\?">Edit<\/button>'\}\)\+'<\/div>';/,
    "{key:'stage',render:function(r){return badge(r.stage)}},{key:'level_order',label:'Order'},{key:'is_active',label:'Status',render:function(r){return badge(r.is_active?'active':'inactive')}}],function(r){return '<button class=\\\"mini\\\" data-edit-grade=\\\"'+r.id+'\\\">Edit</button>'})+'</div>';"
  );

  const addGradeHandler = "   E('addGrade').onclick=function(){form('New grade level',[{key:'code',label:'Code e.g. KG1, P1, JHS1'},{key:'name',label:'Grade name e.g. Primary 1'},{key:'stage',label:'Stage',type:'select',options:[{value:'primary',label:'Primary'},{value:'jhs',label:'JHS'}]},{key:'levelOrder',label:'Display / promotion order',type:'number'},{key:'isActive',label:'Status',type:'select',options:[{value:'true',label:'Active'},{value:'false',label:'Inactive'}]}],{stage:'primary',isActive:'true'},function(v){return raw('/api/grade-levels',{method:'POST',body:JSON.stringify({code:v.code,name:v.name,stage:v.stage,levelOrder:Number(v.levelOrder),isActive:v.isActive==='true'})})})};\n";
  if (!next.includes("E('addGrade').onclick=function()")) {
    const marker = /\n\s*E\('content'\)\.onclick=async function\(e\)\{/;
    if (!marker.test(next)) throw new Error('Could not find setup click handler anchor in dist/ui.js');
    next = next.replace(marker, '\n' + addGradeHandler + "   E('content').onclick=async function(e){");
  }

  const editRegex = /id=e\.target\.dataset\.editGrade;if\(id\)\{var g=grades\.find\(function\(x\)\{return x\.id===id\}\);return form\('Edit grade level',[\s\S]*?raw\('\/api\/grade-levels\/'\+id,\{method:'PATCH',body:JSON\.stringify\(\{name:v\.name,isActive:v\.isActive==='true'\}\)\}\)\}\)\}/;
  const editReplacement = "id=e.target.dataset.editGrade;if(id){var g=grades.find(function(x){return x.id===id});return form('Edit grade level',[{key:'code',label:'Code e.g. KG1, P1, JHS1'},{key:'name',label:'Name'},{key:'stage',label:'Stage',type:'select',options:[{value:'primary',label:'Primary'},{value:'jhs',label:'JHS'}]},{key:'levelOrder',label:'Display / promotion order',type:'number'},{key:'isActive',label:'Status',type:'select',options:[{value:'true',label:'Active'},{value:'false',label:'Inactive'}]}],{code:g.code,name:g.name,stage:g.stage,levelOrder:g.level_order,isActive:String(g.is_active)},function(v){return raw('/api/grade-levels/'+id,{method:'PATCH',body:JSON.stringify({code:v.code,name:v.name,stage:v.stage,levelOrder:Number(v.levelOrder),isActive:v.isActive==='true'})})})}";
  if (editRegex.test(next)) next = next.replace(editRegex, editReplacement);
  else console.log('Grade level edit handler already patched or old handler not found.');

  return next;
});

console.log('Grade level create/edit patch applied to compiled School build.');
