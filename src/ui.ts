export const osFrontend=`<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Revolt-X OS</title>
<style>
:root{--bg:#061018;--panel:#0d1b27;--panel2:#102330;--line:#203543;--text:#f5f8fa;--muted:#8fa6b6;--accent:#43e2b4;--blue:#49a9ff;--warn:#f3b562;--danger:#ff6f7d}
*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--text);font:14px/1.45 Arial,sans-serif}button,input,select,textarea{font:inherit}button{cursor:pointer}
.load{min-height:100vh;display:grid;place-items:center;padding:24px}.layout{display:grid;grid-template-columns:270px 1fr;min-height:100vh}.side{position:fixed;inset:0 auto 0 0;width:270px;background:#09151f;border-right:1px solid var(--line);padding:18px 12px;overflow:auto}.brand{font-weight:900;letter-spacing:.08em;padding:10px 8px 18px}.rx{color:var(--accent);border:1px solid var(--accent);padding:7px;border-radius:8px;margin-right:7px}.nav{display:grid;gap:4px}.nav button{width:100%;text-align:left;border:0;background:none;color:#a9bbc7;padding:10px 12px;border-radius:9px}.nav button:hover,.nav button.active{background:#142735;color:#fff}.nav .group{font-size:10px;text-transform:uppercase;letter-spacing:.12em;color:#607988;padding:14px 10px 5px}
.main{grid-column:2;padding:24px 28px 60px;min-width:0}.top{display:flex;justify-content:space-between;align-items:center;gap:16px;margin-bottom:22px;position:sticky;top:0;background:linear-gradient(var(--bg) 75%,transparent);padding:8px 0 16px;z-index:2}.top-actions{display:flex;gap:8px;flex-wrap:wrap}.panel{background:var(--panel);border:1px solid var(--line);border-radius:15px;padding:17px}.panel+.panel{margin-top:12px}.grid{display:grid;grid-template-columns:repeat(4,minmax(0,1fr));gap:12px}.two{display:grid;grid-template-columns:1fr 1fr;gap:12px}.three{display:grid;grid-template-columns:repeat(3,1fr);gap:12px}.stat b{font-size:28px;display:block;margin-top:8px}.muted,th{color:var(--muted)}.small{font-size:12px}.section-title{display:flex;justify-content:space-between;align-items:center;gap:12px;margin:18px 0 10px}.section-title h2,.section-title h3{margin:0}
table{width:100%;border-collapse:collapse}td,th{padding:10px;border-bottom:1px solid var(--line);text-align:left;vertical-align:top}th{font-size:11px;text-transform:uppercase;letter-spacing:.06em}.tablewrap{overflow:auto}
.primary,.ghost,.danger,.mini{border-radius:9px;padding:9px 12px}.primary{border:0;background:linear-gradient(90deg,var(--accent),var(--blue));color:#041018;font-weight:800}.ghost{border:1px solid var(--line);background:transparent;color:#fff}.danger{border:1px solid #71323a;background:#2a1318;color:#ffbec5}.mini{padding:6px 9px;border:1px solid var(--line);background:#0b1923;color:#dce9ef;font-size:12px}.mini+ .mini{margin-left:5px}
input,select,textarea{width:100%;padding:10px;background:#07131c;border:1px solid var(--line);border-radius:8px;color:#fff;margin:5px 0 10px;outline:none}input:focus,select:focus,textarea:focus{border-color:#3b7d8b}.row{display:flex;gap:10px;align-items:center}.row>*{min-width:0}.toolbar{display:flex;gap:8px;align-items:center;flex-wrap:wrap;margin:12px 0}.toolbar input,.toolbar select{margin:0;max-width:280px}.modal{position:fixed;inset:0;background:#000b;display:grid;place-items:center;z-index:10;padding:18px}.card{width:min(620px,96vw);max-height:90vh;overflow:auto;background:var(--panel);border:1px solid var(--line);border-radius:16px;padding:20px}.hide{display:none!important}.badge{display:inline-flex;align-items:center;font-size:10px;padding:4px 7px;border-radius:12px;background:#143229;color:#6ce6c4}.badge.warn{background:#352b18;color:#ffd893}.badge.off{background:#2c1b1f;color:#ffb0bb}.toast{position:fixed;right:18px;bottom:18px;background:#102b26;border:1px solid #2b6b5a;padding:12px 14px;border-radius:9px;z-index:20;max-width:360px}.empty{padding:24px;text-align:center;color:var(--muted)}.code{font-family:ui-monospace,Consolas,monospace;background:#07131c;padding:10px;border-radius:8px;white-space:pre-wrap;word-break:break-word}.pillbar{display:flex;gap:6px;flex-wrap:wrap}.kpi-label{text-transform:capitalize}.notice{border-left:3px solid var(--blue);padding:10px 12px;background:#0b1d2a;border-radius:8px}.notice.warn{border-left-color:var(--warn)}.notice.danger{border-left-color:var(--danger)}
@media(max-width:1050px){.grid{grid-template-columns:repeat(2,1fr)}.three{grid-template-columns:1fr 1fr}}
@media(max-width:820px){.layout{grid-template-columns:78px 1fr}.side{width:78px}.nav button{font-size:0;text-align:center}.nav button:before{content:attr(data-icon);font-size:18px}.nav .group{display:none}.brand{font-size:0}.main{padding:18px 12px}.two,.three{grid-template-columns:1fr}}
@media(max-width:540px){.grid{grid-template-columns:1fr}.top{align-items:flex-start;flex-direction:column}.row{flex-direction:column;align-items:stretch}.toolbar input,.toolbar select{max-width:none}}
</style>
</head>
<body>
<div id="loading" class="load"><div><div class="brand"><span class="rx">RX</span>REVOLT-X OS</div><p class="muted">Loading workspace...</p></div></div>
<section id="os" class="layout hide">
<aside class="side"><div class="brand"><span class="rx">RX</span>REVOLT-X</div><nav id="nav" class="nav"></nav></aside>
<main class="main">
<header class="top"><div><b id="org">Revolt-X OS</b><div class="muted">Core business operating platform</div></div><div class="top-actions"><button id="refreshPage" class="ghost">Refresh</button><span class="badge">LIVE DATA</span></div></header>
<div id="content"></div>
</main>
</section>
<div id="modal" class="modal hide"><div class="card"><div id="modalBody"></div><button class="ghost" id="closeModal">Close</button></div></div>
<div id="toast" class="toast hide"></div>
<script>
(function(){
var token='',refresh='',data={},currentPage='dashboard';
var pages=[
['group','Core'],['dashboard','Command Centre','⌂'],['organisation','Organisation Hub','O'],['people','People & Access','P'],['operations','Operations Hub','W'],['workflows','Workflow Engine','F'],
['group','Business Services'],['documents','Documents','D'],['assets','Assets','A'],['automation','Automation','↻'],['analytics','Analytics','∿'],['integrations','Integrations','I'],['communication','Communication','C'],['data','Data Hub','H'],
['group','Platform'],['developer','Developer Platform','</>'],['ai','AI Gateway','AI'],['security','Security & Governance','S'],['administration','Administration','⚙'],['search','Search Centre','⌕']
];
function E(x){return document.getElementById(x)}
function esc(x){return String(x==null?'':x).replace(/[&<>"']/g,function(c){return {'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]})}
function fmt(x){if(!x)return'';try{return new Date(x).toLocaleString()}catch(e){return x}}
function toast(x,bad){var t=E('toast');t.textContent=x;t.style.borderColor=bad?'#71323a':'#2b6b5a';t.classList.remove('hide');setTimeout(function(){t.classList.add('hide')},2800)}
function badge(v){var s=String(v==null?'':v);var c=/suspended|disabled|failed|cancelled|lost|retired|archived/i.test(s)?' off':/pending|waiting|maintenance|blocked|draft|invited/i.test(s)?' warn':'';return '<span class="badge'+c+'">'+esc(s||'—')+'</span>'}
function table(rows,cols,actions){
 if(!rows||!rows.length)return '<div class="empty">No records yet.</div>';
 return '<div class="tablewrap"><table><thead><tr>'+cols.map(function(c){return '<th>'+esc(c.label||c.key)+'</th>'}).join('')+(actions?'<th>Actions</th>':'')+'</tr></thead><tbody>'+
 rows.map(function(r){return '<tr>'+cols.map(function(c){var v=typeof c.render==='function'?c.render(r):r[c.key];return '<td>'+String(v==null?'':v)+'</td>'}).join('')+(actions?'<td>'+actions(r)+'</td>':'')+'</tr>'}).join('')+
 '</tbody></table></div>';
}
async function raw(path,opt){
 opt=opt||{};opt.headers=Object.assign({},opt.headers||{}, {'content-type':'application/json'},token?{authorization:'Bearer '+token}:{});
 var r=await fetch(path,opt),j=null;
 try{j=await r.json()}catch(e){}
 if(r.status===401&&refresh){
   var q=await fetch('/v1/auth/refresh',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({refreshToken:refresh})});
   if(q.ok){var n=await q.json();token=n.accessToken;refresh=n.refreshToken;sessionStorage.setItem('rx_access',token);sessionStorage.setItem('rx_refresh',refresh);return raw(path,opt)}
 }
 if(!r.ok)throw Error(j&&j.error&&j.error.message?j.error.message:'Request failed ('+r.status+')');
 return j;
}
function showModal(html){E('modalBody').innerHTML=html;E('modal').classList.remove('hide')}
function closeModal(){E('modal').classList.add('hide');E('modalBody').innerHTML=''}
E('closeModal').onclick=closeModal;
function field(f,val){
 var v=val==null?'':val;
 if(f.type==='select')return '<label>'+esc(f.label)+'</label><select data-f="'+esc(f.key)+'">'+(f.options||[]).map(function(o){var value=typeof o==='string'?o:o.value,label=typeof o==='string'?o:o.label;return '<option value="'+esc(value)+'"'+(String(value)===String(v)?' selected':'')+'>'+esc(label)+'</option>'}).join('')+'</select>';
 if(f.type==='textarea')return '<label>'+esc(f.label)+'</label><textarea data-f="'+esc(f.key)+'" rows="'+(f.rows||5)+'">'+esc(v)+'</textarea>';
 return '<label>'+esc(f.label)+'</label><input data-f="'+esc(f.key)+'" type="'+esc(f.type||'text')+'" value="'+esc(v)+'"'+(f.placeholder?' placeholder="'+esc(f.placeholder)+'"':'')+'>';
}
function form(title,fields,values,onSave){
 values=values||{};
 showModal('<h2>'+esc(title)+'</h2>'+fields.map(function(f){return field(f,values[f.key])}).join('')+'<button class="primary" id="modalSave" style="width:100%;margin:8px 0 12px">Save</button>');
 E('modalSave').onclick=async function(){
   var v={};E('modalBody').querySelectorAll('[data-f]').forEach(function(x){v[x.dataset.f]=x.value});
   try{E('modalSave').disabled=true;await onSave(v);closeModal();toast('Saved successfully');await page(currentPage)}catch(e){toast(e.message,true);E('modalSave').disabled=false}
 };
}
function confirmAction(message,fn){if(confirm(message))fn().catch(function(e){toast(e.message,true)})}
function downloadJson(name,obj){var b=new Blob([JSON.stringify(obj,null,2)],{type:'application/json'});var u=URL.createObjectURL(b);var a=document.createElement('a');a.href=u;a.download=name;a.click();setTimeout(function(){URL.revokeObjectURL(u)},1000)}
async function boot(){
 try{
   token=sessionStorage.getItem('rx_access')||'';refresh=sessionStorage.getItem('rx_refresh')||'';
   if(!token){
     var x=await fetch('/v1/auth/preview-session',{method:'POST'});
     if(!x.ok){var d={};try{d=await x.json()}catch(e){}throw Error('Development access unavailable ('+x.status+'): '+(d&&d.error&&d.error.message?d.error.message:'Preview session request failed'))}
     var j=await x.json();token=j.accessToken;refresh=j.refreshToken||'';sessionStorage.setItem('rx_access',token);sessionStorage.setItem('rx_refresh',refresh)
   }
   data.org=await raw('/v1/organisation');E('org').textContent=data.org.name;
   E('nav').innerHTML=pages.map(function(p){if(p[0]==='group')return '<div class="group">'+esc(p[1])+'</div>';return '<button data-p="'+p[0]+'" data-icon="'+esc(p[2])+'" class="'+(p[0]==='dashboard'?'active':'')+'">'+esc(p[1])+'</button>'}).join('');
   E('nav').onclick=function(e){var b=e.target.closest('button[data-p]');if(b)page(b.dataset.p)};
   E('refreshPage').onclick=function(){page(currentPage)};
   E('loading').classList.add('hide');E('os').classList.remove('hide');await page('dashboard');
 }catch(e){E('loading').innerHTML='<div><h2>Workspace unavailable</h2><p>'+esc(e.message)+'</p></div>'}
}
async function page(p){
 currentPage=p;document.querySelectorAll('.nav button').forEach(function(b){b.classList.toggle('active',b.dataset.p===p)});E('content').innerHTML='<p class="muted">Loading...</p>';
 try{
 if(p==='dashboard'){
   var rs=await Promise.all([raw('/v1/analytics/summary'),raw('/v1/operations?limit=8'),raw('/v1/notifications?limit=6')]);var a=rs[0],ops=rs[1],notes=rs[2];
   E('content').innerHTML='<h1>Command Centre</h1><div class="grid">'+
   [['People',a.users],['Operations',a.operations],['Documents',a.documents],['Assets',a.assets],['Workflow runs',a.workflow_runs],['Active automations',a.active_automations],['Active integrations',a.active_integrations],['Unread notifications',a.unread_notifications]].map(function(v){return '<div class="panel stat"><span class="muted">'+esc(v[0])+'</span><b>'+esc(v[1])+'</b></div>'}).join('')+
   '</div><div class="two" style="margin-top:12px"><div class="panel"><div class="section-title"><h3>Recent operations</h3></div>'+table(ops,[{key:'title',label:'Operation'},{key:'status',render:function(r){return badge(r.status)}},{key:'priority',render:function(r){return badge(r.priority)}}])+'</div><div class="panel"><div class="section-title"><h3>Notifications</h3></div>'+table(notes,[{key:'title'},{key:'created_at',label:'Created',render:function(r){return esc(fmt(r.created_at))}}])+'</div></div>';
 }
 else if(p==='organisation'){
   var rr=await Promise.all([raw('/v1/branches'),raw('/v1/departments'),raw('/v1/teams')]);var branches=rr[0],deps=rr[1],teams=rr[2];
   E('content').innerHTML='<div class="section-title"><h1>Organisation Hub</h1><button class="primary" id="editOrg">Edit organisation</button></div>'+
   '<div class="grid"><div class="panel stat"><span>Branches</span><b>'+branches.length+'</b></div><div class="panel stat"><span>Departments</span><b>'+deps.length+'</b></div><div class="panel stat"><span>Teams</span><b>'+teams.length+'</b></div></div>'+
   '<div class="section-title"><h2>Branches</h2><button class="ghost" id="addBranch">Add branch</button></div><div class="panel">'+table(branches,[{key:'code'},{key:'name'},{key:'timezone'},{key:'is_active',label:'Status',render:function(r){return badge(r.is_active?'active':'inactive')}}],function(r){return '<button class="mini" data-edit-branch="'+r.id+'">Edit</button>'})+'</div>'+
   '<div class="section-title"><h2>Departments</h2><button class="ghost" id="addDep">Add department</button></div><div class="panel">'+table(deps,[{key:'code'},{key:'name'},{key:'is_active',label:'Status',render:function(r){return badge(r.is_active?'active':'inactive')}}],function(r){return '<button class="mini" data-edit-dep="'+r.id+'">Edit</button>'})+'</div>'+
   '<div class="section-title"><h2>Teams</h2><button class="ghost" id="addTeam">Add team</button></div><div class="panel">'+table(teams,[{key:'name'},{key:'description'},{key:'is_active',label:'Status',render:function(r){return badge(r.is_active?'active':'inactive')}}],function(r){return '<button class="mini" data-edit-team="'+r.id+'">Edit</button>'})+'</div>';
   E('editOrg').onclick=function(){form('Edit organisation',[{key:'name',label:'Organisation name'}],{name:data.org.name},async function(v){data.org=await raw('/v1/organisation',{method:'PATCH',body:JSON.stringify({name:v.name})});E('org').textContent=data.org.name})};
   E('addBranch').onclick=function(){form('Add branch',[{key:'code',label:'Code'},{key:'name',label:'Name'},{key:'timezone',label:'Timezone'}],{timezone:'UTC'},function(v){return raw('/v1/branches',{method:'POST',body:JSON.stringify(v)})})};
   E('addDep').onclick=function(){form('Add department',[{key:'code',label:'Code'},{key:'name',label:'Name'},{key:'branchId',label:'Branch',type:'select',options:[{value:'',label:'None'}].concat(branches.map(function(x){return{value:x.id,label:x.name}}))}],{},function(v){return raw('/v1/departments',{method:'POST',body:JSON.stringify({code:v.code,name:v.name,branchId:v.branchId||null})})})};
   E('addTeam').onclick=function(){form('Add team',[{key:'name',label:'Name'},{key:'description',label:'Description',type:'textarea'},{key:'departmentId',label:'Department',type:'select',options:[{value:'',label:'None'}].concat(deps.map(function(x){return{value:x.id,label:x.name}}))}],{},function(v){return raw('/v1/teams',{method:'POST',body:JSON.stringify({name:v.name,description:v.description||null,departmentId:v.departmentId||null})})})};
   E('content').onclick=function(e){
     var id=e.target.dataset.editBranch;if(id){var r=branches.find(function(x){return x.id===id});form('Edit branch',[{key:'code',label:'Code'},{key:'name',label:'Name'},{key:'timezone',label:'Timezone'},{key:'isActive',label:'Status',type:'select',options:[{value:'true',label:'Active'},{value:'false',label:'Inactive'}]}],{code:r.code,name:r.name,timezone:r.timezone,isActive:String(r.is_active)},function(v){return raw('/v1/branches/'+id,{method:'PATCH',body:JSON.stringify({code:v.code,name:v.name,timezone:v.timezone,isActive:v.isActive==='true'})})})}
     id=e.target.dataset.editDep;if(id){var d=deps.find(function(x){return x.id===id});form('Edit department',[{key:'code',label:'Code'},{key:'name',label:'Name'},{key:'branchId',label:'Branch',type:'select',options:[{value:'',label:'None'}].concat(branches.map(function(x){return{value:x.id,label:x.name}}))},{key:'isActive',label:'Status',type:'select',options:[{value:'true',label:'Active'},{value:'false',label:'Inactive'}]}],{code:d.code,name:d.name,branchId:d.branch_id||'',isActive:String(d.is_active)},function(v){return raw('/v1/departments/'+id,{method:'PATCH',body:JSON.stringify({code:v.code,name:v.name,branchId:v.branchId||null,isActive:v.isActive==='true'})})})}
     id=e.target.dataset.editTeam;if(id){var t=teams.find(function(x){return x.id===id});form('Edit team',[{key:'name',label:'Name'},{key:'description',label:'Description',type:'textarea'},{key:'departmentId',label:'Department',type:'select',options:[{value:'',label:'None'}].concat(deps.map(function(x){return{value:x.id,label:x.name}}))},{key:'isActive',label:'Status',type:'select',options:[{value:'true',label:'Active'},{value:'false',label:'Inactive'}]}],{name:t.name,description:t.description||'',departmentId:t.department_id||'',isActive:String(t.is_active)},function(v){return raw('/v1/teams/'+id,{method:'PATCH',body:JSON.stringify({name:v.name,description:v.description||null,departmentId:v.departmentId||null,isActive:v.isActive==='true'})})})}
   };
 }
 else if(p==='people'){
   var pr=await Promise.all([raw('/v1/users'),raw('/v1/roles'),raw('/v1/permissions')]);var users=pr[0],roles=pr[1],perms=pr[2];
   E('content').innerHTML='<div class="section-title"><h1>People & Access</h1><button class="primary" id="inviteUser">Invite user</button></div><div class="panel">'+table(users,[{key:'first_name',label:'Name',render:function(r){return esc(r.first_name+' '+r.last_name)}},{key:'email'},{key:'job_title',label:'Job title'},{key:'roles',render:function(r){return esc((r.roles||[]).join(', '))}},{key:'membership_status',label:'Status',render:function(r){return badge(r.membership_status)}}],function(r){return '<button class="mini" data-edit-user="'+r.membership_id+'">Edit</button><button class="mini" data-toggle-user="'+r.membership_id+'">'+(r.membership_status==='active'?'Suspend':'Activate')+'</button>'})+'</div>'+
   '<div class="section-title"><h2>Roles & Permissions</h2><button class="ghost" id="addRole">Create role</button></div><div class="panel">'+table(roles,[{key:'name'},{key:'key'},{key:'permissions',render:function(r){return esc((r.permissions||[]).join(', '))}}],function(r){return r.is_system?'': '<button class="mini" data-edit-role="'+r.id+'">Edit</button>'})+'</div>';
   E('inviteUser').onclick=function(){form('Invite user',[{key:'email',label:'Email',type:'email'},{key:'firstName',label:'First name'},{key:'lastName',label:'Last name'},{key:'jobTitle',label:'Job title'},{key:'employeeNumber',label:'Employee number'},{key:'roleKey',label:'Role',type:'select',options:roles.map(function(r){return{value:r.key,label:r.name}})}],{roleKey:'member'},function(v){return raw('/v1/users',{method:'POST',body:JSON.stringify(v)})})};
   E('addRole').onclick=function(){form('Create role',[{key:'key',label:'Role key'},{key:'name',label:'Role name'},{key:'description',label:'Description',type:'textarea'},{key:'permissions',label:'Permissions (comma separated)',type:'textarea'}],{},function(v){return raw('/v1/roles',{method:'POST',body:JSON.stringify({key:v.key,name:v.name,description:v.description,permissions:v.permissions.split(',').map(function(x){return x.trim()}).filter(Boolean)})})})};
   E('content').onclick=function(e){
     var id=e.target.dataset.editUser;if(id){var u=users.find(function(x){return x.membership_id===id});form('Edit user',[{key:'firstName',label:'First name'},{key:'lastName',label:'Last name'},{key:'jobTitle',label:'Job title'},{key:'employeeNumber',label:'Employee number'},{key:'roleKey',label:'Role',type:'select',options:roles.map(function(r){return{value:r.key,label:r.name}})}],{firstName:u.first_name,lastName:u.last_name,jobTitle:u.job_title||'',employeeNumber:u.employee_number||'',roleKey:(u.roles||[])[0]||'member'},function(v){return raw('/v1/users/'+id,{method:'PATCH',body:JSON.stringify({firstName:v.firstName,lastName:v.lastName,jobTitle:v.jobTitle||null,employeeNumber:v.employeeNumber||null,roleKey:v.roleKey})})})}
     id=e.target.dataset.toggleUser;if(id){var u2=users.find(function(x){return x.membership_id===id});var next=u2.membership_status==='active'?'suspended':'active';confirmAction((next==='suspended'?'Suspend':'Activate')+' this user?',async function(){await raw('/v1/users/'+id+'/status',{method:'PATCH',body:JSON.stringify({status:next})});toast('User status updated');await page('people')})}
     id=e.target.dataset.editRole;if(id){var ro=roles.find(function(x){return x.id===id});form('Edit role',[{key:'name',label:'Role name'},{key:'description',label:'Description',type:'textarea'},{key:'permissions',label:'Permissions (comma separated)',type:'textarea'}],{name:ro.name,description:ro.description||'',permissions:(ro.permissions||[]).join(', ')},function(v){return raw('/v1/roles/'+id,{method:'PATCH',body:JSON.stringify({name:v.name,description:v.description||null,permissions:v.permissions.split(',').map(function(x){return x.trim()}).filter(Boolean)})})})}
   };
 }
 else if(p==='operations'){
   var ops=await raw('/v1/operations?limit=100');
   E('content').innerHTML='<div class="section-title"><h1>Operations Hub</h1><button class="primary" id="addOp">New operation</button></div><div class="panel">'+table(ops,[{key:'title'},{key:'status',render:function(r){return badge(r.status)}},{key:'priority',render:function(r){return badge(r.priority)}},{key:'due_at',label:'Due',render:function(r){return esc(fmt(r.due_at))}}],function(r){return '<button class="mini" data-edit-op="'+r.id+'">Update</button>'})+'</div>';
   E('addOp').onclick=function(){form('New operation',[{key:'title',label:'Title'},{key:'description',label:'Description',type:'textarea'},{key:'priority',label:'Priority',type:'select',options:['low','normal','high','critical']},{key:'dueAt',label:'Due date/time',type:'datetime-local'}],{priority:'normal'},function(v){var body={title:v.title,description:v.description,priority:v.priority};if(v.dueAt)body.dueAt=new Date(v.dueAt).toISOString();return raw('/v1/operations',{method:'POST',body:JSON.stringify(body)})})};
   E('content').onclick=function(e){var id=e.target.dataset.editOp;if(!id)return;var o=ops.find(function(x){return x.id===id});form('Update operation',[{key:'status',label:'Status',type:'select',options:['open','in_progress','blocked','completed','cancelled']},{key:'priority',label:'Priority',type:'select',options:['low','normal','high','critical']},{key:'dueAt',label:'Due date/time',type:'datetime-local'}],{status:o.status,priority:o.priority,dueAt:o.due_at?new Date(o.due_at).toISOString().slice(0,16):''},function(v){return raw('/v1/operations/'+id,{method:'PATCH',body:JSON.stringify({status:v.status,priority:v.priority,dueAt:v.dueAt?new Date(v.dueAt).toISOString():null,version:o.version})})})};
 }
 else if(p==='workflows'){
   var wr=await Promise.all([raw('/v1/workflows'),raw('/v1/workflow-instances?limit=50')]);var defs=wr[0],runs=wr[1];
   E('content').innerHTML='<div class="section-title"><h1>Workflow Engine</h1><button class="primary" id="addW">New workflow</button></div><div class="panel">'+table(defs,[{key:'name'},{key:'key'},{key:'status',render:function(r){return badge(r.status)}},{key:'trigger_type',label:'Trigger'},{key:'step_count',label:'Steps'}],function(r){var s='';if(r.status==='draft')s+='<button class="mini" data-activate-w="'+r.id+'">Activate</button>';if(r.status==='active')s+='<button class="mini" data-start-w="'+r.id+'">Start</button>';return s})+'</div>'+
   '<div class="section-title"><h2>Workflow runs</h2></div><div class="panel">'+table(runs,[{key:'workflow_name',label:'Workflow'},{key:'status',render:function(r){return badge(r.status)}},{key:'started_at',label:'Started',render:function(r){return esc(fmt(r.started_at))}}],function(r){return '<button class="mini" data-view-run="'+r.id+'">Open</button>'+(r.status==='running'||r.status==='waiting'?'<button class="mini" data-cancel-run="'+r.id+'">Cancel</button>':'')})+'</div>';
   E('addW').onclick=function(){form('New workflow',[{key:'name',label:'Name'},{key:'key',label:'Key'},{key:'description',label:'Description',type:'textarea'},{key:'step1',label:'First step'},{key:'step2',label:'Second step (optional)'}],{},function(v){var steps=[{key:'step-1',name:v.step1,type:'task'}];if(v.step2)steps.push({key:'step-2',name:v.step2,type:'task'});return raw('/v1/workflows',{method:'POST',body:JSON.stringify({name:v.name,key:v.key.toLowerCase().replace(/[^a-z0-9.-]/g,'-'),description:v.description,triggerType:'manual',steps:steps})})})};
   E('content').onclick=async function(e){
     var id=e.target.dataset.activateW;if(id){await raw('/v1/workflows/'+id+'/activate',{method:'POST',body:'{}'});toast('Workflow activated');return page('workflows')}
     id=e.target.dataset.startW;if(id){await raw('/v1/workflows/'+id+'/start',{method:'POST',body:JSON.stringify({context:{startedFrom:'ui'}})});toast('Workflow started');return page('workflows')}
     id=e.target.dataset.cancelRun;if(id){confirmAction('Cancel this workflow run?',async function(){await raw('/v1/workflow-instances/'+id+'/cancel',{method:'POST',body:'{}'});toast('Workflow cancelled');await page('workflows')});return}
     id=e.target.dataset.viewRun;if(id){var run=await raw('/v1/workflow-instances/'+id);var actions=run.steps.map(function(s){return '<tr><td>'+esc(s.name)+'</td><td>'+badge(s.status)+'</td><td>'+(s.status==='running'||s.status==='waiting'?'<button class="mini" data-complete-step="'+s.id+'" data-run="'+run.id+'">Complete</button>':'')+'</td></tr>'}).join('');showModal('<h2>'+esc(run.workflow_name||'Workflow run')+'</h2><p>'+badge(run.status)+'</p><div class="tablewrap"><table><thead><tr><th>Step</th><th>Status</th><th>Action</th></tr></thead><tbody>'+actions+'</tbody></table></div>');E('modalBody').onclick=async function(ev){var sid=ev.target.dataset.completeStep;if(sid){await raw('/v1/workflow-instances/'+ev.target.dataset.run+'/steps/'+sid+'/complete',{method:'POST',body:JSON.stringify({output:{completedFrom:'ui'}})});toast('Step completed');closeModal();await page('workflows')}}}
   };
 }
 else if(p==='documents'){
   var docs=await raw('/v1/documents');
   E('content').innerHTML='<div class="section-title"><h1>Document Hub</h1><button class="primary" id="addDoc">New document</button></div><div class="panel">'+table(docs,[{key:'name'},{key:'category'},{key:'status',render:function(r){return badge(r.status)}},{key:'version'}],function(r){return '<button class="mini" data-open-doc="'+r.id+'">Open</button>'})+'</div>';
   E('addDoc').onclick=function(){form('New document',[{key:'name',label:'Name'},{key:'category',label:'Category'},{key:'content',label:'Content',type:'textarea',rows:10}],{category:'general'},function(v){return raw('/v1/documents',{method:'POST',body:JSON.stringify(v)})})};
   E('content').onclick=async function(e){var id=e.target.dataset.openDoc;if(!id)return;var d=await raw('/v1/documents/'+id);form('Edit document',[{key:'name',label:'Name'},{key:'category',label:'Category'},{key:'status',label:'Status',type:'select',options:['active','archived']},{key:'content',label:'Content',type:'textarea',rows:12}],d,function(v){return raw('/v1/documents/'+id,{method:'PATCH',body:JSON.stringify(v)})})};
 }
 else if(p==='assets'){
   var assets=await raw('/v1/assets');
   E('content').innerHTML='<div class="section-title"><h1>Asset Hub</h1><button class="primary" id="addAsset">Register asset</button></div><div class="panel">'+table(assets,[{key:'code'},{key:'name'},{key:'asset_type',label:'Type'},{key:'status',render:function(r){return badge(r.status)}},{key:'location'}],function(r){return '<button class="mini" data-edit-asset="'+r.id+'">Edit</button>'})+'</div>';
   E('addAsset').onclick=function(){form('Register asset',[{key:'code',label:'Asset code'},{key:'name',label:'Name'},{key:'assetType',label:'Type'},{key:'location',label:'Location'}],{},function(v){return raw('/v1/assets',{method:'POST',body:JSON.stringify(v)})})};
   E('content').onclick=function(e){var id=e.target.dataset.editAsset;if(!id)return;var a=assets.find(function(x){return x.id===id});form('Edit asset',[{key:'name',label:'Name'},{key:'status',label:'Status',type:'select',options:['active','maintenance','retired','lost']},{key:'location',label:'Location'}],{name:a.name,status:a.status,location:a.location||''},function(v){return raw('/v1/assets/'+id,{method:'PATCH',body:JSON.stringify({name:v.name,status:v.status,location:v.location||null})})})};
 }
 else if(p==='automation'){
   var autos=await raw('/v1/automations');
   E('content').innerHTML='<div class="section-title"><h1>Automation Centre</h1><button class="primary" id="addAuto">New automation</button></div><div class="panel">'+table(autos,[{key:'name'},{key:'trigger_event',label:'Trigger'},{key:'action_type',label:'Action'},{key:'is_active',label:'Status',render:function(r){return badge(r.is_active?'active':'disabled')}},{key:'run_count',label:'Runs'}],function(r){return '<button class="mini" data-run-auto="'+r.id+'">Run now</button><button class="mini" data-toggle-auto="'+r.id+'">'+(r.is_active?'Disable':'Enable')+'</button>'})+'</div>';
   E('addAuto').onclick=function(){form('New automation',[{key:'name',label:'Name'},{key:'triggerEvent',label:'Trigger event'},{key:'actionType',label:'Action',type:'select',options:['create_operation','emit_event']},{key:'title',label:'Operation title (for create operation)'}],{actionType:'create_operation'},function(v){return raw('/v1/automations',{method:'POST',body:JSON.stringify({name:v.name,triggerEvent:v.triggerEvent,actionType:v.actionType,actionConfig:v.title?{title:v.title}:{}})})})};
   E('content').onclick=async function(e){var id=e.target.dataset.runAuto;if(id){await raw('/v1/automations/'+id+'/run',{method:'POST',body:'{}'});toast('Automation executed');return page('automation')}id=e.target.dataset.toggleAuto;if(id){var a=autos.find(function(x){return x.id===id});await raw('/v1/automations/'+id,{method:'PATCH',body:JSON.stringify({isActive:!a.is_active})});toast('Automation updated');return page('automation')}};
 }
 else if(p==='analytics'){
   var ar=await Promise.all([raw('/v1/analytics/summary'),raw('/v1/analytics/activity')]);var sum=ar[0],act=ar[1];
   E('content').innerHTML='<div class="section-title"><h1>Reporting & Analytics</h1><button class="ghost" id="exportAnalytics">Export JSON</button></div><div class="grid">'+Object.keys(sum).map(function(k){return '<div class="panel stat"><span class="muted kpi-label">'+esc(k.replaceAll('_',' '))+'</span><b>'+esc(sum[k])+'</b></div>'}).join('')+'</div>'+
   '<div class="three" style="margin-top:12px"><div class="panel"><h3>Operations by status</h3>'+table(act.operationsByStatus,[{key:'status',render:function(r){return badge(r.status)}},{key:'count'}])+'</div><div class="panel"><h3>Assets by status</h3>'+table(act.assetsByStatus,[{key:'status',render:function(r){return badge(r.status)}},{key:'count'}])+'</div><div class="panel"><h3>Workflow runs</h3>'+table(act.workflowsByStatus,[{key:'status',render:function(r){return badge(r.status)}},{key:'count'}])+'</div></div><div class="panel" style="margin-top:12px"><h3>Audit activity, last 14 days</h3>'+table(act.auditByDay,[{key:'day'},{key:'count'}])+'</div>';
   E('exportAnalytics').onclick=function(){downloadJson('revolt-x-analytics.json',{summary:sum,activity:act})};
 }
 else if(p==='integrations'){
   var ints=await raw('/v1/integrations');
   E('content').innerHTML='<div class="section-title"><h1>Integration Hub</h1><button class="primary" id="addInt">Add integration</button></div><div class="panel">'+table(ints,[{key:'name'},{key:'integration_type',label:'Type'},{key:'endpoint_url',label:'Endpoint'},{key:'status',render:function(r){return badge(r.status)}}],function(r){return '<button class="mini" data-test-int="'+r.id+'">Test</button><button class="mini" data-edit-int="'+r.id+'">Edit</button>'})+'</div>';
   E('addInt').onclick=function(){form('Add integration',[{key:'name',label:'Name'},{key:'integrationType',label:'Type'},{key:'endpointUrl',label:'Endpoint URL',type:'url'}],{},function(v){var b={name:v.name,integrationType:v.integrationType};if(v.endpointUrl)b.endpointUrl=v.endpointUrl;return raw('/v1/integrations',{method:'POST',body:JSON.stringify(b)})})};
   E('content').onclick=async function(e){var id=e.target.dataset.testInt;if(id){var r=await raw('/v1/integrations/'+id+'/test',{method:'POST',body:'{}'});toast(r.ok?'Integration test passed':(r.message||'Integration test failed'),!r.ok);return}id=e.target.dataset.editInt;if(id){var x=ints.find(function(y){return y.id===id});form('Edit integration',[{key:'name',label:'Name'},{key:'endpointUrl',label:'Endpoint URL',type:'url'},{key:'status',label:'Status',type:'select',options:['active','disabled']}],{name:x.name,endpointUrl:x.endpoint_url||'',status:x.status},function(v){return raw('/v1/integrations/'+id,{method:'PATCH',body:JSON.stringify({name:v.name,endpointUrl:v.endpointUrl||null,status:v.status})})})}};
 }
 else if(p==='communication'){
   var cr=await Promise.all([raw('/v1/notifications?limit=100'),raw('/v1/users')]);var notes=cr[0],members=cr[1];
   E('content').innerHTML='<div class="section-title"><h1>Communication Centre</h1><div><button class="ghost" id="readAll">Mark all read</button> <button class="primary" id="sendNote">Send notification</button></div></div><div class="panel">'+table(notes,[{key:'title'},{key:'body'},{key:'created_at',label:'Created',render:function(r){return esc(fmt(r.created_at))}},{key:'is_read',label:'Status',render:function(r){return badge(r.is_read?'read':'unread')}}],function(r){return r.is_read?'':'<button class="mini" data-read-note="'+r.id+'">Mark read</button>'})+'</div>';
   E('readAll').onclick=async function(){await raw('/v1/notifications/read-all',{method:'POST',body:'{}'});toast('Notifications marked as read');await page('communication')};
   E('sendNote').onclick=function(){form('Send notification',[{key:'title',label:'Title'},{key:'body',label:'Message',type:'textarea'},{key:'userId',label:'Recipient',type:'select',options:[{value:'',label:'Everyone'}].concat(members.map(function(u){return{value:u.id,label:u.first_name+' '+u.last_name}}))}],{},function(v){return raw('/v1/notifications',{method:'POST',body:JSON.stringify({title:v.title,body:v.body,userId:v.userId||null})})})};
   E('content').onclick=async function(e){var id=e.target.dataset.readNote;if(id){await raw('/v1/notifications/'+id+'/read',{method:'PATCH',body:'{}'});toast('Marked as read');await page('communication')}};
 }
 else if(p==='data'){
   var dr=await Promise.all([raw('/v1/data-hub/summary'),raw('/v1/data-hub/events?limit=100')]);var ds=dr[0],events=dr[1];
   E('content').innerHTML='<div class="section-title"><h1>Data Hub</h1><button class="ghost" id="exportEvents">Export events</button></div><div class="grid">'+Object.keys(ds).map(function(k){return '<div class="panel stat"><span class="muted kpi-label">'+esc(k.replaceAll('_',' '))+'</span><b>'+esc(ds[k])+'</b></div>'}).join('')+'</div><div class="panel" style="margin-top:12px">'+table(events,[{key:'topic'},{key:'aggregate_type',label:'Type'},{key:'aggregate_id',label:'Record'},{key:'created_at',label:'Created',render:function(r){return esc(fmt(r.created_at))}},{key:'published_at',label:'Published',render:function(r){return r.published_at?badge('published'):badge('pending')}}])+'</div>';
   E('exportEvents').onclick=function(){downloadJson('revolt-x-events.json',events)};
 }
 else if(p==='developer'){
   var clients=await raw('/v1/developer/clients');
   E('content').innerHTML='<div class="section-title"><h1>Developer Platform</h1><button class="primary" id="addClient">Create API client</button></div><div class="notice">API clients are scoped credentials for external applications and future business modules.</div><div class="panel" style="margin-top:12px">'+table(clients,[{key:'name'},{key:'client_id',label:'Client ID'},{key:'permissions',render:function(r){return esc((r.permissions||[]).join(', '))}},{key:'is_active',label:'Status',render:function(r){return badge(r.is_active?'active':'disabled')}}],function(r){return '<button class="mini" data-rotate-client="'+r.id+'">Rotate secret</button><button class="mini" data-toggle-client="'+r.id+'">'+(r.is_active?'Disable':'Enable')+'</button>'})+'</div>';
   E('addClient').onclick=function(){form('Create API client',[{key:'name',label:'Application name'},{key:'permissions',label:'Permissions (comma separated)',type:'textarea'}],{},async function(v){var x=await raw('/v1/module-clients',{method:'POST',body:JSON.stringify({name:v.name,permissions:v.permissions.split(',').map(function(x){return x.trim()}).filter(Boolean)})});showModal('<h2>Client created</h2><p class="muted">Copy this secret now. It will not be shown again.</p><div class="code">'+esc(x.clientSecret)+'</div>')})};
   E('content').onclick=async function(e){var id=e.target.dataset.rotateClient;if(id){var x=await raw('/v1/module-clients/'+id+'/rotate-secret',{method:'POST',body:'{}'});showModal('<h2>Secret rotated</h2><p class="muted">Copy this secret now.</p><div class="code">'+esc(x.clientSecret)+'</div>');return}id=e.target.dataset.toggleClient;if(id){var c=clients.find(function(x){return x.id===id});await raw('/v1/module-clients/'+id+'/status',{method:'PATCH',body:JSON.stringify({isActive:!c.is_active})});toast('API client updated');await page('developer')}};
 }
 else if(p==='ai'){
   var st=await raw('/v1/ai/status');
   E('content').innerHTML='<h1>Revolt-X AI Gateway</h1>'+(st.configured?'<div class="notice">AI Gateway is configured and available.</div><div class="panel" style="margin-top:12px"><label>Capability</label><input id="cap" placeholder="e.g. summarise_document"><label>JSON input</label><textarea id="ain" rows="9">{}</textarea><button class="primary" id="invoke">Invoke AI</button><pre id="aiout" class="code"></pre></div>':'<div class="notice warn"><b>AI Gateway is not configured.</b><br>The OS is protecting this feature rather than pretending it works. Configure AI_GATEWAY_URL and AI_GATEWAY_TOKEN to enable invocation.</div>');
   if(st.configured)E('invoke').onclick=async function(){try{var x=await raw('/v1/ai/invoke',{method:'POST',body:JSON.stringify({capability:E('cap').value,input:JSON.parse(E('ain').value||'{}')})});E('aiout').textContent=JSON.stringify(x,null,2)}catch(e){E('aiout').textContent=e.message}};
 }
 else if(p==='security'){
   var sr=await Promise.all([raw('/v1/security/overview'),raw('/v1/security/sessions'),raw('/v1/audit-logs?limit=50')]);var ov=sr[0],sessions=sr[1],logs=sr[2];
   E('content').innerHTML='<h1>Security & Governance</h1><div class="grid"><div class="panel stat"><span>Active sessions</span><b>'+esc(ov.activeSessions)+'</b></div><div class="panel stat"><span>Audit records shown</span><b>'+logs.length+'</b></div></div>'+
   '<div class="section-title"><h2>Sessions</h2></div><div class="panel">'+table(sessions,[{key:'email'},{key:'ip_address',label:'IP'},{key:'created_at',label:'Created',render:function(r){return esc(fmt(r.created_at))}},{key:'expires_at',label:'Expires',render:function(r){return esc(fmt(r.expires_at))}},{key:'revoked_at',label:'Status',render:function(r){return badge(r.revoked_at?'revoked':(r.current?'current':'active'))}}],function(r){return !r.revoked_at&&!r.current?'<button class="mini" data-revoke-session="'+r.id+'">Revoke</button>':''})+'</div>'+
   '<div class="section-title"><h2>Audit trail</h2></div><div class="panel">'+table(logs,[{key:'action'},{key:'resource_type',label:'Resource'},{key:'outcome',render:function(r){return badge(r.outcome)}},{key:'created_at',label:'Time',render:function(r){return esc(fmt(r.created_at))}}])+'</div>';
   E('content').onclick=function(e){var id=e.target.dataset.revokeSession;if(id)confirmAction('Revoke this session?',async function(){await raw('/v1/security/sessions/'+id+'/revoke',{method:'POST',body:'{}'});toast('Session revoked');await page('security')})};
 }
 else if(p==='administration'){
   var health=await fetch('/health/ready').then(function(r){return r.json().catch(function(){return{status:'unknown'}})}).catch(function(){return{status:'unavailable'}});
   var org=await raw('/v1/organisation');
   E('content').innerHTML='<h1>Administration Centre</h1><div class="two"><div class="panel"><h3>Organisation</h3><p><b>'+esc(org.name)+'</b></p><p class="muted">'+esc(org.slug)+'</p><button class="ghost" id="adminEditOrg">Edit organisation</button></div><div class="panel"><h3>System readiness</h3><p>'+badge(health.status)+'</p><p class="muted">Database connectivity and application readiness check.</p><button class="ghost" id="runHealth">Run check</button></div></div><div class="panel" style="margin-top:12px"><h3>Environment controls</h3><p class="muted">Preview access is enabled for development. Commercial launch requires hardened login, MFA, password recovery delivery, monitoring, backups and removal of preview access.</p></div>';
   E('adminEditOrg').onclick=function(){form('Edit organisation',[{key:'name',label:'Organisation name'}],{name:org.name},function(v){return raw('/v1/organisation',{method:'PATCH',body:JSON.stringify({name:v.name})})})};
   E('runHealth').onclick=async function(){var r=await fetch('/health/ready'),j=await r.json().catch(function(){return{status:'unknown'}});toast('Readiness: '+j.status,!r.ok)};
 }
 else if(p==='search'){
   E('content').innerHTML='<h1>Search & Command Centre</h1><div class="toolbar"><input id="q" placeholder="Search people, documents, assets and operations"><button class="primary" id="go">Search</button></div><div id="results" class="panel"><div class="empty">Enter at least two characters.</div></div>';
   async function go(){var q=E('q').value.trim();if(q.length<2){toast('Enter at least two characters',true);return}var a=await raw('/v1/search?q='+encodeURIComponent(q));E('results').innerHTML=table(a,[{key:'type',render:function(r){return badge(r.type)}},{key:'name'}])}
   E('go').onclick=go;E('q').onkeydown=function(e){if(e.key==='Enter')go()};
 }
 }catch(e){E('content').innerHTML='<div class="panel"><h3>Could not load this service</h3><p class="muted">'+esc(e.message)+'</p><button class="ghost" id="retryPage">Retry</button></div>';E('retryPage').onclick=function(){page(p)}}
}
boot();
})();
</script>
</body>
</html>`;
