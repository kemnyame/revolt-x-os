export const commercialControlFrontend=String.raw`<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Revolt-X OS | Customers & Licensing</title>
<style>
:root{--navy:#081c33;--navy2:#0c2949;--blue:#1d62d6;--gold:#f2b742;--green:#20a36a;--red:#d94f5c;--bg:#f4f7fb;--card:#fff;--ink:#172536;--muted:#718096;--line:#dce5ef}
*{box-sizing:border-box}body{margin:0;font-family:Inter,Arial,sans-serif;background:var(--bg);color:var(--ink)}button,input,select,textarea{font:inherit}
.layout{display:grid;grid-template-columns:250px 1fr;min-height:100vh}.side{background:linear-gradient(180deg,var(--navy),#102e50);color:white;padding:24px 16px;position:sticky;top:0;height:100vh}.brand{font-weight:900;font-size:20px;letter-spacing:.3px;margin-bottom:28px}.brand span{display:inline-grid;place-items:center;width:36px;height:36px;border-radius:10px;background:var(--gold);color:var(--navy);margin-right:8px}.side small{color:#9fb3c9}.nav{display:grid;gap:8px;margin-top:24px}.nav button{border:0;background:transparent;color:#dce9f6;text-align:left;padding:12px 14px;border-radius:10px;cursor:pointer}.nav button.active,.nav button:hover{background:#ffffff16;color:white}.back{position:absolute;bottom:24px;left:16px;right:16px;border:1px solid #ffffff33;background:#ffffff0d;color:white;padding:11px;border-radius:10px;cursor:pointer}
.main{padding:24px 28px 60px;min-width:0}.top{display:flex;justify-content:space-between;gap:20px;align-items:center;margin-bottom:24px}.top h1{margin:0;font-size:25px}.sub{color:var(--muted);font-size:13px}.actions{display:flex;gap:8px;flex-wrap:wrap}.btn{border:0;border-radius:10px;padding:10px 14px;font-weight:700;cursor:pointer}.primary{background:var(--blue);color:white}.gold{background:var(--gold);color:var(--navy)}.ghost{background:white;border:1px solid var(--line);color:var(--ink)}.danger{background:#fff0f1;color:#a62834;border:1px solid #f6cbd0}
.grid{display:grid;grid-template-columns:repeat(4,minmax(0,1fr));gap:12px}.kpi{background:var(--card);border:1px solid var(--line);border-radius:16px;padding:18px;box-shadow:0 8px 24px #2038540b}.kpi span{display:block;color:var(--muted);font-size:12px}.kpi b{display:block;font-size:28px;margin-top:7px}.kpi em{font-style:normal;font-size:11px;color:var(--green)}
.panel{background:var(--card);border:1px solid var(--line);border-radius:16px;padding:18px;box-shadow:0 8px 24px #2038540b;margin-top:14px}.panel h2,.panel h3{margin:0 0 12px}.split{display:grid;grid-template-columns:1.35fr .65fr;gap:14px}.toolbar{display:flex;gap:8px;align-items:center;justify-content:space-between;margin:14px 0}.toolbar input,.toolbar select{border:1px solid var(--line);padding:10px 12px;border-radius:10px;background:#fff;min-width:180px}
.tablewrap{overflow:auto}table{width:100%;border-collapse:collapse;font-size:13px}th,td{text-align:left;padding:11px 10px;border-bottom:1px solid #edf1f5;white-space:nowrap}th{font-size:11px;color:#66788d;text-transform:uppercase;letter-spacing:.04em}.badge{display:inline-flex;padding:5px 9px;border-radius:999px;font-size:11px;font-weight:800;background:#e9f7f0;color:#147a4d}.badge.trial,.badge.grace{background:#fff5da;color:#9b6b00}.badge.suspended,.badge.expired,.badge.cancelled{background:#fdebec;color:#a72934}.badge.unlicensed{background:#eef1f5;color:#627083}.mini{border:1px solid var(--line);background:white;border-radius:8px;padding:6px 9px;cursor:pointer}.mini:hover{border-color:#9fb8d3}
.cards{display:grid;grid-template-columns:repeat(4,minmax(0,1fr));gap:12px}.plan{border:1px solid var(--line);border-radius:16px;padding:16px;background:white;position:relative}.plan.professional{border:2px solid var(--blue)}.plan .price{font-size:26px;font-weight:900;color:var(--navy)}.plan ul{padding-left:18px;color:#52667b;font-size:12px;line-height:1.7}.modulegrid{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:10px}.module{border:1px solid var(--line);padding:12px;border-radius:12px;background:#fbfdff}.module b{display:block}.module small{color:var(--muted)}
.modal{position:fixed;inset:0;background:#07111fa8;display:grid;place-items:center;padding:20px;z-index:50}.modal.hidden,.hidden{display:none!important}.dialog{background:white;width:min(760px,96vw);max-height:90vh;overflow:auto;border-radius:18px;padding:22px;box-shadow:0 30px 80px #0005}.dialog h2{margin-top:0}.fields{display:grid;grid-template-columns:1fr 1fr;gap:12px}.field{display:grid;gap:6px}.field.full{grid-column:1/-1}.field label{font-size:12px;font-weight:700;color:#4a5f76}.field input,.field select,.field textarea{border:1px solid var(--line);padding:11px;border-radius:10px}.modal-actions{display:flex;justify-content:flex-end;gap:8px;margin-top:16px}
.drawer{position:fixed;top:0;right:0;height:100vh;width:min(620px,96vw);background:white;z-index:40;box-shadow:-20px 0 60px #07111f30;padding:22px;overflow:auto}.drawer.hidden{display:none}.drawer-head{display:flex;justify-content:space-between;align-items:flex-start}.drawer .metric{display:grid;grid-template-columns:1fr 1fr;gap:10px}.drawer .metric div{background:#f7f9fc;border-radius:12px;padding:12px}.toggle{display:flex;align-items:center;justify-content:space-between;border-bottom:1px solid #edf1f5;padding:10px 0}.toast{position:fixed;right:22px;bottom:22px;background:#102e50;color:white;padding:12px 16px;border-radius:10px;box-shadow:0 16px 50px #0003;z-index:100}.notice{background:#eef5ff;border:1px solid #cfe0fb;border-radius:12px;padding:12px;color:#315b88}.empty{padding:30px;text-align:center;color:var(--muted)}
@media(max-width:1050px){.grid,.cards{grid-template-columns:repeat(2,1fr)}.modulegrid{grid-template-columns:repeat(2,1fr)}.split{grid-template-columns:1fr}}
@media(max-width:760px){.layout{grid-template-columns:78px 1fr}.side{padding:20px 8px}.brand{font-size:0}.brand span{margin:0}.side small{display:none}.nav button{font-size:0;text-align:center}.nav button:before{content:attr(data-icon);font-size:18px}.back{font-size:0}.back:before{content:"←";font-size:20px}.main{padding:18px 12px}.grid,.cards,.modulegrid,.fields{grid-template-columns:1fr}.top{align-items:flex-start;flex-direction:column}.field.full{grid-column:auto}}
</style>
</head>
<body>
<div class="layout">
<aside class="side">
 <div class="brand"><span>RX</span>REVOLT-X OS</div><small>Commercial Control Centre</small>
 <div class="nav">
  <button class="active" data-page="overview" data-icon="⌂">Overview</button>
  <button data-page="schools" data-icon="S">Schools & Customers</button>
  <button data-page="plans" data-icon="P">Plans & Modules</button>
  <button data-page="billing" data-icon="₵">Billing & Invoices</button>
 </div>
 <button class="back" id="backOs">← Back to Core OS</button>
</aside>
<main class="main">
 <div class="top"><div><h1 id="pageTitle">Commercial Overview</h1><div class="sub">Manage school tenants, pricing, licences, entitlements and subscription billing.</div></div>
 <div class="actions"><button class="btn ghost" id="refresh">Refresh</button><button class="btn gold" id="newSchool">+ Add School</button></div></div>
 <div id="content"></div>
</main>
</div>
<div class="modal hidden" id="modal"><div class="dialog"><div id="modalBody"></div></div></div>
<div class="drawer hidden" id="drawer"><div id="drawerBody"></div></div>
<div class="toast hidden" id="toast"></div>
<script>
(function(){
var token=sessionStorage.getItem("rx_access")||"",refreshToken=sessionStorage.getItem("rx_refresh")||"",catalog=null,schools=[],current="overview";
var E=function(id){return document.getElementById(id)};
var esc=function(v){return String(v==null?"":v).replace(/[&<>"']/g,function(c){return {"&":"&amp;","<":"&lt;",">":"&gt;","\"":"&quot;","'":"&#39;"}[c]})};
var money=function(v,c){return (c||"GHS")+" "+Number(v||0).toLocaleString(undefined,{minimumFractionDigits:2,maximumFractionDigits:2})};
var badge=function(v){var x=String(v||"unlicensed");return '<span class="badge '+esc(x)+'">'+esc(x.replaceAll("_"," "))+'</span>'};
var fmt=function(v){if(!v)return"—";try{return new Date(v).toLocaleDateString()}catch(e){return v}};
function toast(msg,bad){var t=E("toast");t.textContent=msg;t.style.background=bad?"#8f2731":"#102e50";t.classList.remove("hidden");setTimeout(function(){t.classList.add("hidden")},4200)}
function licenceResultToast(result,savedMessage){
  var sync=result&&result.licenseSync;
  if(sync&&sync.ok===false){toast(savedMessage+". School sync is pending: "+(sync.message||"retry Sync Licence Now."),false);return}
  toast(savedMessage+" and synced to School",false)
}
async function raw(path,opt){opt=opt||{};opt.headers=Object.assign({"content-type":"application/json"},opt.headers||{},token?{authorization:"Bearer "+token}:{});
 var r=await fetch(path,opt),j=null;try{j=await r.json()}catch(e){}
 if(r.status===401&&refreshToken){var rr=await fetch("/v1/auth/refresh",{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify({refreshToken:refreshToken})});if(rr.ok){var n=await rr.json();token=n.accessToken;refreshToken=n.refreshToken;sessionStorage.setItem("rx_access",token);sessionStorage.setItem("rx_refresh",refreshToken);return raw(path,opt)}}
 if(!r.ok)throw Error(j&&j.error&&j.error.message?j.error.message:"Request failed ("+r.status+")");return j}
function closeModal(){E("modal").classList.add("hidden");E("modalBody").innerHTML=""}
function showModal(html){E("modalBody").innerHTML=html;E("modal").classList.remove("hidden")}
function closeDrawer(){E("drawer").classList.add("hidden");E("drawerBody").innerHTML=""}
function table(rows,cols,action){if(!rows||!rows.length)return '<div class="empty">No records yet.</div>';return '<div class="tablewrap"><table><thead><tr>'+cols.map(function(c){return"<th>"+esc(c.label||c.key)+"</th>"}).join("")+(action?"<th>Action</th>":"")+'</tr></thead><tbody>'+rows.map(function(r){return"<tr>"+cols.map(function(c){var v=c.render?c.render(r):r[c.key];return"<td>"+(v==null?"":v)+"</td>"}).join("")+(action?"<td>"+action(r)+"</td>":"")+"</tr>"}).join("")+"</tbody></table></div>"}
async function loadBase(){if(!token){location.href="/login";return false}catalog=await raw("/v1/commercial-control/catalog");schools=await raw("/v1/commercial-control/schools");return true}
function planById(id){return (catalog.plans||[]).find(function(p){return p.id===id})}
function openNewSchool(){
 var opts=catalog.plans.map(function(p){return '<option value="'+p.id+'">'+esc(p.name)+" · "+money(p.monthly_price,p.currency)+"/month</option>"}).join("");
 showModal('<h2>Create Commercial School</h2><div class="notice">Revolt-X OS will create the customer organisation, administrator, subscription and an empty Revolt-X School workspace. No sample students, fees or academic records will be added.</div><div class="fields" style="margin-top:14px">'+
 '<div class="field full"><label>School name</label><input id="fName" placeholder="e.g. Grace Preparatory School"></div>'+
 '<div class="field"><label>School type</label><input id="fType" placeholder="Basic, JHS, SHS, Montessori..."></div>'+
 '<div class="field"><label>Contact phone</label><input id="fPhone"></div>'+
 '<div class="field"><label>Administrator first name</label><input id="fAdminFirst"></div>'+
 '<div class="field"><label>Administrator last name</label><input id="fAdminLast"></div>'+
 '<div class="field full"><label>Administrator email</label><input id="fAdminEmail" type="email" placeholder="admin@school.edu.gh"></div>'+
 '<div class="field"><label>Plan</label><select id="fPlan">'+opts+'</select></div>'+
 '<div class="field"><label>Billing</label><select id="fBilling"><option value="monthly">Monthly</option><option value="termly">Termly</option><option value="annual">Annual</option></select></div>'+
 '<div class="field"><label>Initial licence status</label><select id="fStatus"><option value="active">Active</option><option value="trial">14-day Trial</option></select></div>'+
 '<div class="field full"><label>Address</label><textarea id="fAddress" rows="2"></textarea></div></div>'+
 '<div class="modal-actions"><button class="btn ghost" id="mCancel">Cancel</button><button class="btn primary" id="mSave">Create & Provision School</button></div>');
 E("mCancel").onclick=closeModal;
 E("mSave").onclick=async function(){
   var b=E("mSave");b.disabled=true;b.textContent="Creating school...";
   try{
     var x=await raw("/v1/commercial-control/schools",{method:"POST",body:JSON.stringify({
       name:E("fName").value,schoolType:E("fType").value||undefined,adminFirstName:E("fAdminFirst").value,
       adminLastName:E("fAdminLast").value,adminEmail:E("fAdminEmail").value,contactPhone:E("fPhone").value||undefined,
       address:E("fAddress").value||undefined,planId:E("fPlan").value,billingFrequency:E("fBilling").value,licenceStatus:E("fStatus").value
     })});
     await loadBase();
     var admin=x.administrator||{},newAdmin=!admin.existingUser;
     var adminCredentials='<div class="notice" style="margin-top:12px"><b>School Administrator Login</b><p class="sub">This is separate from Staff Login. The administrator signs in with School + Admin Email + Admin Password.</p>'+
       '<div class="field full"><label>Admin Login URL</label><input id="createdAdminUrl" value="'+esc(x.adminLoginUrl||"")+'" readonly></div>'+
       '<div class="field full"><label>Admin Email</label><input id="createdAdminEmail" value="'+esc(admin.email||"")+'" readonly></div>'+
       (newAdmin?'<div class="field full"><label>One-time Admin Password</label><input id="createdAdminPassword" value="'+esc(admin.temporaryPassword||"")+'" readonly></div><p class="sub"><b>Important:</b> copy this password now. The administrator must change it on first login.</p>':'<p class="sub">This email already belongs to an existing Revolt-X account, so the existing password remains in use.</p>')+
       '<div class="actions" style="margin-top:8px"><button class="btn ghost" id="copyAdminUrl">Copy Admin URL</button><button class="btn ghost" id="copyAdminEmail">Copy Admin Email</button>'+(newAdmin?'<button class="btn ghost" id="copyAdminPassword">Copy Admin Password</button>':'')+'<a class="btn primary" href="'+esc(x.adminLoginUrl||"#")+'" target="_blank">Open Admin Login</a></div></div>';
     E("modalBody").innerHTML='<h2>School Created</h2><div class="notice"><b>'+esc(x.organisation.name)+'</b><br>Plan: '+esc(x.entitlement.planName||x.entitlement.plan||"—")+' · Licence: '+esc(x.entitlement.status)+'<br>Provisioning: '+esc(x.provisioning.status)+'</div>'+
       adminCredentials+
       '<div class="field full" style="margin-top:12px"><label>Staff Login URL</label><input id="createdAccessUrl" value="'+esc(x.accessUrl)+'" readonly></div>'+
       '<div class="actions" style="margin-top:8px"><button class="btn ghost" id="copyAccess">Copy Staff Login URL</button><a class="btn ghost" href="'+esc(x.accessUrl)+'" target="_blank">Open Staff Login</a></div>'+
       (x.provisioning.status!=="completed"?'<div class="notice" style="margin-top:12px"><b>Provisioning needs attention.</b><br>'+esc(x.provisioning.message||"Open the school record and retry provisioning.")+'</div>':'')+
       '<div class="modal-actions"><button class="btn primary" id="createdDone">Done</button></div>';
     E("copyAccess").onclick=function(){navigator.clipboard.writeText(x.accessUrl);toast("Staff Login URL copied")};
     E("copyAdminUrl").onclick=function(){navigator.clipboard.writeText(x.adminLoginUrl||"");toast("Admin Login URL copied")};
     E("copyAdminEmail").onclick=function(){navigator.clipboard.writeText(admin.email||"");toast("Admin email copied")};
     if(E("copyAdminPassword"))E("copyAdminPassword").onclick=function(){navigator.clipboard.writeText(admin.temporaryPassword||"");toast("One-time Admin Password copied")};
     E("createdDone").onclick=function(){closeModal();page("schools")};
   }catch(e){toast(e.message,true);b.disabled=false;b.textContent="Create & Provision School"}
 }
}
async function openSchool(id){
 var d=await raw("/v1/commercial-control/schools/"+id),lic=d.license,u={};(d.usage||[]).forEach(function(x){u[x.metric_key]=Number(x.metric_value)});
 var moduleHtml=(catalog.modules||[]).map(function(m){var on=(lic.modules||[]).includes(m.module_key);return '<div class="toggle"><div><b>'+esc(m.name)+'</b><div class="sub">'+esc(m.module_key)+'</div></div><label><input type="checkbox" data-module="'+esc(m.module_key)+'" '+(on?"checked":"")+'> '+(on?"On":"Off")+'</label></div>'}).join("");
 var provisioning=d.provisioning||{},provisionStatus=provisioning.status||"not_started";
 E("drawerBody").innerHTML='<div class="drawer-head"><div><h2>'+esc(d.customer.name)+'</h2><div class="sub">'+esc(d.customer.slug)+'</div></div><button class="btn ghost" id="closeDrawer">Close</button></div>'+
 '<div class="metric" style="margin-top:16px"><div><small>Licence</small><b>'+badge(lic.status)+'</b></div><div><small>Plan</small><b>'+esc(lic.planName||"—")+'</b></div><div><small>Licence reference</small><b style="font-size:13px">'+esc(lic.licenseCode||"—")+'</b></div><div><small>Renews / expires</small><b>'+fmt(lic.periodEnd)+'</b></div><div><small>Students</small><b>'+esc(u.students||0)+' / '+esc((lic.limits||{}).students||"∞")+'</b></div><div><small>Staff</small><b>'+esc(u.staff||0)+' / '+esc((lic.limits||{}).staff||"∞")+'</b></div></div>'+
 '<div class="panel"><h3>School Workspace</h3><p>'+badge(provisionStatus)+' <span class="sub">Provisioning status</span></p><div class="field"><label>Staff Login URL</label><input id="schoolAccessUrl" value="'+esc(d.accessUrl)+'" readonly></div><div class="field"><label>Admin Login URL</label><input id="schoolAdminUrl" value="'+esc((d.adminLoginUrl||String(d.accessUrl||"").replace("/login?","/admin-login?")))+'" readonly></div><div class="actions" style="margin-top:8px"><button class="btn ghost" id="copySchoolUrl">Copy Staff URL</button><button class="btn ghost" id="copySchoolAdminUrl">Copy Admin URL</button><a class="btn primary" href="'+esc((d.adminLoginUrl||String(d.accessUrl||"").replace("/login?","/admin-login?")))+'" target="_blank">Open Admin Login</a><button class="btn gold" id="setSchoolAdmin">Set New Admin</button><button class="btn ghost" id="resetSchoolAdmin">Reset Admin Password</button><button class="btn ghost" id="retryProvision">Provision / Retry</button></div></div>'+
 '<div class="panel"><h3>Plan & Licence Control</h3><p class="sub">These actions take effect in Revolt-X School immediately after a successful licence sync.</p><div class="actions"><button class="btn primary" id="changePlan">Change Plan</button><button class="btn gold" id="extendLicense">Extend / Renew</button><button class="btn ghost" id="syncLicense">Sync Licence Now</button><button class="mini" data-license="active">Activate / Restore</button><button class="mini" data-license="grace">Grace Period</button><button class="mini" data-license="suspended">Suspend</button><button class="mini danger" data-license="expired">Expire</button><button class="mini danger" data-license="cancelled">Cancel</button></div></div>'+
 '<div class="panel"><h3>Module Entitlements</h3>'+moduleHtml+'</div>'+
 '<div class="panel"><h3>Billing</h3><div class="actions"><button class="btn primary" id="issueInvoice">Issue '+esc(lic.billingFrequency||"monthly")+' Invoice</button></div>'+table(d.invoices,[{key:"invoice_no",label:"Invoice"},{key:"status",render:function(r){return badge(r.status)}},{key:"total",render:function(r){return money(r.total,r.currency)}},{key:"amount_paid",label:"Paid",render:function(r){return money(r.amount_paid,r.currency)}}],function(r){return r.status!=="paid"&&r.status!=="void"?'<button class="mini" data-pay-invoice="'+r.id+'" data-balance="'+(Number(r.total)-Number(r.amount_paid))+'">Record payment</button>':""})+'</div>'+
 '<div class="panel"><h3>Tenant Domains</h3>'+table(d.domains,[{key:"domain"},{key:"domain_type",label:"Type"},{key:"status",render:function(r){return badge(r.status)}}])+'</div>';
 E("drawer").classList.remove("hidden");E("closeDrawer").onclick=closeDrawer;
 E("copySchoolUrl").onclick=function(){navigator.clipboard.writeText(d.accessUrl);toast("Staff Login URL copied")};
 E("copySchoolAdminUrl").onclick=function(){navigator.clipboard.writeText(d.adminLoginUrl||String(d.accessUrl||"").replace("/login?","/admin-login?"));toast("Admin Login URL copied")};
 E("setSchoolAdmin").onclick=function(){
   showModal('<h2>Set New School Administrator</h2><div class="notice"><b>This changes the primary administrator for this school.</b><p class="sub">Enter the administrator details and the password they will use to sign in. The previous primary admin will lose owner authority and its active School sessions will be signed out.</p></div><div class="fields" style="margin-top:14px"><div class="field"><label>First name</label><input id="newAdminFirst"></div><div class="field"><label>Last name</label><input id="newAdminLast"></div><div class="field full"><label>Admin email</label><input id="newAdminEmail" type="email" placeholder="admin@school.edu.gh"></div><div class="field"><label>New password</label><input id="newAdminPassword" type="password" autocomplete="new-password" placeholder="Minimum 12 characters"></div><div class="field"><label>Confirm password</label><input id="newAdminPasswordConfirm" type="password" autocomplete="new-password" placeholder="Re-enter password"></div><div class="field full"><p class="sub">Password must contain at least 12 characters, including uppercase, lowercase and a number.</p></div></div><div class="modal-actions"><button class="btn ghost" id="mCancel">Cancel</button><button class="btn primary" id="mSave">Set New Admin</button></div>');
   E("mCancel").onclick=closeModal;
   E("mSave").onclick=async function(){
     var b=E("mSave"),p=E("newAdminPassword").value,pc=E("newAdminPasswordConfirm").value;
     if(p!==pc){toast("The passwords do not match.",true);return}
     if(p.length<12||!/[A-Z]/.test(p)||!/[a-z]/.test(p)||!/[0-9]/.test(p)){toast("Password must be at least 12 characters and include uppercase, lowercase and a number.",true);return}
     b.disabled=true;b.textContent="Setting admin...";
     try{
       var x=await raw("/v1/commercial-control/schools/"+id+"/admin",{method:"POST",body:JSON.stringify({firstName:E("newAdminFirst").value,lastName:E("newAdminLast").value,email:E("newAdminEmail").value,password:p})}),a=x.administrator||{};
       E("modalBody").innerHTML='<h2>New School Administrator Set</h2><div class="notice"><b>'+esc((a.firstName||"")+" "+(a.lastName||""))+'</b><br>'+esc(a.email||"")+'<p class="sub" style="margin-bottom:0">'+(x.schoolSync&&x.schoolSync.ok?"Core OS and School are synchronised. The administrator can sign in now.":"Core OS saved the new administrator. School sync is pending and can be retried from Provision / Retry.")+'</p></div><div class="field"><label>Admin Login URL</label><input id="newAdminUrl" value="'+esc(x.adminLoginUrl||"")+'" readonly></div><div class="notice"><b>Password configured.</b><p class="sub">The administrator can log in using the school, admin email and the password you just entered. No temporary password change is required.</p></div><div class="modal-actions"><button class="btn ghost" id="copyNewAdmin">Copy login details</button><a class="btn primary" href="'+esc(x.adminLoginUrl||"#")+'" target="_blank">Open Admin Login</a><button class="btn primary" id="newAdminDone">Done</button></div>';
       E("copyNewAdmin").onclick=function(){navigator.clipboard.writeText("Admin Login: "+(x.adminLoginUrl||"")+"\nEmail: "+(a.email||""));toast("Admin login details copied")};
       E("newAdminDone").onclick=async function(){closeModal();await openSchool(id)}
     }catch(e){toast(e.message,true);b.disabled=false;b.textContent="Set New Admin"}
   }
 };
 E("resetSchoolAdmin").onclick=async function(){try{if(!confirm("Reset the current primary School Administrator password? Existing admin sessions will be signed out."))return;var x=await raw("/v1/commercial-control/schools/"+id+"/admin-invite",{method:"POST",body:"{}"}),a=x.administrator||{};showModal('<h2>Administrator Password Reset</h2><div class="notice"><b>Use these credentials once.</b><p class="sub">The administrator must change the password after signing in.</p></div><div class="field"><label>Admin Login URL</label><input id="adminResetUrl" value="'+esc(x.adminLoginUrl||"")+'" readonly></div><div class="field"><label>Admin Email</label><input id="adminResetEmail" value="'+esc(a.email||"")+'" readonly></div><div class="field"><label>One-time Admin Password</label><input id="adminResetPassword" value="'+esc(x.temporaryPassword||"")+'" readonly></div><div class="modal-actions"><button class="btn ghost" id="copyAdminReset">Copy credentials</button><a class="btn primary" href="'+esc(x.adminLoginUrl||"#")+'" target="_blank">Open Admin Login</a></div>');E("copyAdminReset").onclick=function(){navigator.clipboard.writeText("Admin Login: "+(x.adminLoginUrl||"")+"\nEmail: "+(a.email||"")+"\nTemporary Password: "+(x.temporaryPassword||""));toast("Admin credentials copied")}}catch(e){toast(e.message,true)}};
 E("retryProvision").onclick=async function(){var b=E("retryProvision");b.disabled=true;b.textContent="Provisioning...";try{var x=await raw("/v1/commercial-control/schools/"+id+"/provision",{method:"POST",body:"{}"});toast(x.ok?"School workspace provisioned":x.message,!x.ok);await openSchool(id)}catch(e){toast(e.message,true);b.disabled=false;b.textContent="Provision / Retry"}};
 E("syncLicense").onclick=async function(){var b=E("syncLicense");b.disabled=true;b.textContent="Syncing...";try{var x=await raw("/v1/commercial-control/schools/"+id+"/sync-license",{method:"POST",body:"{}"});toast(x.ok?"Licence synced to School":x.message,!x.ok);await openSchool(id)}catch(e){toast(e.message,true);b.disabled=false;b.textContent="Sync Licence Now"}};
 E("extendLicense").onclick=function(){
   showModal('<h2>Extend / Renew Licence</h2><p class="sub">Extend from the current expiry date if it is still in the future, otherwise from today. The licence will become Active.</p><div class="fields"><div class="field full"><label>Extension</label><select id="extendMode"><option value="billing_period">1 billing period ('+esc(lic.billingFrequency||"monthly")+')</option><option value="30">30 days</option><option value="90">90 days</option><option value="365">365 days</option></select></div></div><div class="modal-actions"><button class="btn ghost" id="mCancel">Cancel</button><button class="btn primary" id="mSave">Extend Licence</button></div>');
   E("mCancel").onclick=closeModal;
   E("mSave").onclick=async function(){var b=E("mSave"),v=E("extendMode").value;b.disabled=true;b.textContent="Extending...";try{var body=v==="billing_period"?{mode:"billing_period",periods:1}:{mode:"days",days:Number(v)};var x=await raw("/v1/commercial-control/schools/"+id+"/extend-license",{method:"POST",body:JSON.stringify(body)});closeModal();licenceResultToast(x,"Licence extended to "+fmt(x.current_period_end));await loadBase();await openSchool(id)}catch(e){toast(e.message,true);b.disabled=false;b.textContent="Extend Licence"}}
 };
 E("changePlan").onclick=function(){
   var options=catalog.plans.map(function(p){return'<option value="'+p.id+'" '+(p.plan_key===lic.plan?'selected':'')+'>'+esc(p.name)+'</option>'}).join("");
   showModal('<h2>Apply School Plan</h2><div class="fields"><div class="field"><label>Plan</label><select id="applyPlan">'+options+'</select></div><div class="field"><label>Billing</label><select id="applyBilling"><option value="monthly" '+(lic.billingFrequency==="monthly"?"selected":"")+'>Monthly</option><option value="termly" '+(lic.billingFrequency==="termly"?"selected":"")+'>Termly</option><option value="annual" '+(lic.billingFrequency==="annual"?"selected":"")+'>Annual</option></select></div><div class="field"><label>Licence status</label><select id="applyStatus"><option value="active">Active</option><option value="trial">Trial</option><option value="grace">Grace</option><option value="suspended">Suspended</option><option value="expired">Expired</option></select></div></div><div class="modal-actions"><button class="btn ghost" id="mCancel">Cancel</button><button class="btn primary" id="mSave">Apply Plan Now</button></div>');
   E("applyStatus").value=lic.status;E("mCancel").onclick=closeModal;E("mSave").onclick=async function(){try{var x=await raw("/v1/commercial-control/schools/"+id+"/subscription",{method:"PUT",body:JSON.stringify({planId:E("applyPlan").value,billingFrequency:E("applyBilling").value,status:E("applyStatus").value})});closeModal();licenceResultToast(x,"Plan applied");await loadBase();openSchool(id)}catch(e){toast(e.message,true)}}
 };
 E("drawerBody").querySelectorAll("[data-license]").forEach(function(b){
   b.onclick=async function(){
     var status=b.dataset.license;
     if(status==="grace"){
       showModal('<h2>Start Grace Period</h2><p class="sub">The school remains operational during the grace period and receives a licence warning.</p><div class="field"><label>Grace days</label><input id="graceDays" type="number" min="1" max="90" value="14"></div><div class="modal-actions"><button class="btn ghost" id="mCancel">Cancel</button><button class="btn primary" id="mSave">Apply Grace Period</button></div>');
       E("mCancel").onclick=closeModal;E("mSave").onclick=async function(){var x=E("mSave");x.disabled=true;x.textContent="Applying...";try{var r=await raw("/v1/commercial-control/schools/"+id+"/license",{method:"PATCH",body:JSON.stringify({status:"grace",graceDays:Number(E("graceDays").value)||14})});closeModal();licenceResultToast(r,"Grace period applied");await loadBase();await openSchool(id)}catch(e){toast(e.message,true);x.disabled=false;x.textContent="Apply Grace Period"}};return
     }
     var labels={active:"activate / restore",suspended:"suspend",expired:"expire",cancelled:"cancel"};
     if(!confirm("Are you sure you want to "+(labels[status]||status)+" this school licence?"))return;
     var original=b.textContent;b.disabled=true;b.textContent="Working...";
     try{
       var r=await raw("/v1/commercial-control/schools/"+id+"/license",{method:"PATCH",body:JSON.stringify({status:status})});
       licenceResultToast(r,status==="active"?"Licence activated through "+fmt(r.current_period_end):"Licence changed to "+status);
       await loadBase();await openSchool(id)
     }catch(e){toast(e.message,true);b.disabled=false;b.textContent=original}
   }
 });
 E("drawerBody").querySelectorAll("[data-module]").forEach(function(c){c.onchange=async function(){try{var x=await raw("/v1/commercial-control/schools/"+id+"/modules",{method:"PUT",body:JSON.stringify({moduleKey:c.dataset.module,enabled:c.checked})});licenceResultToast(x,"Module entitlement updated")}catch(e){c.checked=!c.checked;toast(e.message,true)}}});
 E("issueInvoice").onclick=async function(){try{await raw("/v1/commercial-control/schools/"+id+"/invoices",{method:"POST",body:JSON.stringify({dueDays:14})});toast("Invoice issued");await openSchool(id)}catch(e){toast(e.message,true)}};
 E("drawerBody").querySelectorAll("[data-pay-invoice]").forEach(function(b){
   b.onclick=function(){
     showModal('<h2>Record Subscription Payment</h2><div class="fields"><div class="field"><label>Amount</label><input id="payAmount" type="number" step="0.01" value="'+b.dataset.balance+'"></div><div class="field"><label>Method</label><select id="payMethod"><option value="bank_transfer">Bank Transfer</option><option value="mobile_money">Mobile Money</option><option value="card">Card</option><option value="cash">Cash</option></select></div><div class="field full"><label>Reference</label><input id="payRef"></div></div><div class="modal-actions"><button class="btn ghost" id="mCancel">Cancel</button><button class="btn primary" id="mSave">Post Payment</button></div>');
     E("mCancel").onclick=closeModal;
     E("mSave").onclick=async function(){
       try{
         await raw("/v1/commercial-control/invoices/"+b.dataset.payInvoice+"/payments",{method:"POST",body:JSON.stringify({amount:Number(E("payAmount").value),paymentMethod:E("payMethod").value,providerReference:E("payRef").value||undefined})});
         closeModal();toast("Payment recorded. Paid subscriptions are renewed and synced.");await loadBase();await openSchool(id);
       }catch(e){toast(e.message,true)}
     };
   };
 });
}
async function overview(){
 var o=await raw("/v1/commercial-control/overview");E("pageTitle").textContent="Commercial Overview";
 var renew=o.renewals||[];
 E("content").innerHTML='<div class="grid"><div class="kpi"><span>Managed Schools</span><b>'+esc(o.schools)+'</b><em>Customer organisations</em></div><div class="kpi"><span>Active Licences</span><b>'+esc(o.active_licences)+'</b><em>Currently enabled</em></div><div class="kpi"><span>Trials</span><b>'+esc(o.trials)+'</b><em>Conversion pipeline</em></div><div class="kpi"><span>Needs Attention</span><b>'+esc(o.attention)+'</b><em>Grace / suspended / expired</em></div><div class="kpi"><span>Estimated MRR</span><b>'+money(o.monthly_recurring_revenue)+'</b><em>Normalised recurring revenue</em></div><div class="kpi"><span>Outstanding Invoices</span><b>'+money(o.outstanding_invoices)+'</b><em>Issued and unpaid</em></div></div>'+
 '<div class="split"><div class="panel"><h3>Renewals Due in 60 Days</h3>'+table(renew,[{key:"name",label:"School"},{key:"plan_name",label:"Plan"},{key:"status",render:function(r){return badge(r.status)}},{key:"current_period_end",label:"Renewal",render:function(r){return fmt(r.current_period_end)}},{key:"recurring_amount",label:"Value",render:function(r){return money(r.recurring_amount,r.currency)}}])+'</div>'+
 '<div class="panel"><h3>Licence Status</h3>'+(o.subscriptionStatus||[]).map(function(x){return '<div class="toggle"><span>'+badge(x.status)+'</span><b>'+esc(x.count)+'</b></div>'}).join("")+'<div class="notice" style="margin-top:12px"><b>How this works</b><br>Revolt-X OS is the source of truth. Each School organisation receives a plan, module entitlements, usage limits and a licence status.</div></div></div>';
}
async function openExistingSchoolImport(){
 try{
   var tenants=await raw("/v1/commercial-control/importable-school-tenants");
   if(!tenants.length){
     showModal('<h2>Import Existing School</h2><div class="notice">No unlicensed Revolt-X School tenants are waiting to be imported.</div><div class="modal-actions"><button class="btn primary" id="mCancel">Close</button></div>');E("mCancel").onclick=closeModal;return;
   }
   var schoolsOpt=tenants.map(function(t){return '<option value="'+esc(t.organisationId)+'">'+esc(t.schoolName)+' · '+esc(t.tenantSlug||t.organisation.slug)+'</option>'}).join("");
   var plansOpt=catalog.plans.map(function(p){return '<option value="'+p.id+'">'+esc(p.name)+' · '+money(p.monthly_price,p.currency)+'/month</option>'}).join("");
   showModal('<h2>Import Existing School</h2><div class="notice">Attach an existing live Revolt-X School workspace to commercial licensing. Existing students, finance, academic and portal data will be preserved.</div><div class="fields" style="margin-top:14px">'+
     '<div class="field full"><label>Existing School</label><select id="importTenant">'+schoolsOpt+'</select></div>'+
     '<div class="field"><label>Plan</label><select id="importPlan">'+plansOpt+'</select></div>'+
     '<div class="field"><label>Billing</label><select id="importBilling"><option value="monthly">Monthly</option><option value="termly">Termly</option><option value="annual">Annual</option></select></div>'+
     '<div class="field"><label>Licence status</label><select id="importStatus"><option value="active">Active</option><option value="trial">14-day Trial</option></select></div>'+
     '<div class="field"><label>School type</label><input id="importType" placeholder="Optional"></div></div>'+
     '<div class="modal-actions"><button class="btn ghost" id="mCancel">Cancel</button><button class="btn primary" id="mSave">Import & Apply Plan</button></div>');
   E("mCancel").onclick=closeModal;
   E("mSave").onclick=async function(){
     var b=E("mSave");b.disabled=true;b.textContent="Importing...";
     try{
       var x=await raw("/v1/commercial-control/adopt-school",{method:"POST",body:JSON.stringify({
         organisationId:E("importTenant").value,planId:E("importPlan").value,billingFrequency:E("importBilling").value,
         licenceStatus:E("importStatus").value,schoolType:E("importType").value||undefined
       })});
       closeModal();toast("Existing school imported and licence applied");await loadBase();await openSchool(x.organisation.id)
     }catch(e){toast(e.message,true);b.disabled=false;b.textContent="Import & Apply Plan"}
   };
 }catch(e){toast(e.message,true)}
}
function schoolsPage(){
 E("pageTitle").textContent="Schools & Customers";
 var q='<div class="toolbar"><input id="schoolSearch" placeholder="Search school, plan or licence status"><div class="actions"><button class="btn ghost" id="importSchool">Import Existing School</button><button class="btn primary" id="addSchool2">+ Add School</button></div></div>';
 var cols=[{key:"name",label:"School"},{key:"school_type",label:"Type"},{key:"plan_name",label:"Plan"},{key:"licence_status",label:"Licence",render:function(r){return badge(r.licence_status)}},{key:"recurring_amount",label:"Price",render:function(r){return money(r.recurring_amount,r.currency)+" / "+esc(r.billing_frequency||"—")}},{key:"current_period_end",label:"Renewal / Expiry",render:function(r){return fmt(r.current_period_end)}},{key:"primary_contact_phone",label:"Contact"}];
 E("content").innerHTML=q+'<div class="panel">'+table(schools,cols,function(r){return '<button class="mini" data-open-school="'+r.id+'">Manage</button>'})+'</div>';
 E("addSchool2").onclick=openNewSchool;E("importSchool").onclick=openExistingSchoolImport;
 E("content").onclick=function(e){var b=e.target.closest("[data-open-school]");if(b)openSchool(b.dataset.openSchool)};
 E("schoolSearch").oninput=function(){var term=this.value.toLowerCase(),rows=schools.filter(function(x){return (x.name+" "+(x.plan_name||"")+" "+(x.licence_status||"")).toLowerCase().includes(term)});E("content").querySelector(".panel").innerHTML=table(rows,cols,function(r){return '<button class="mini" data-open-school="'+r.id+'">Manage</button>'})}
}
function plansPage(){
 E("pageTitle").textContent="Plans & Modules";
 E("content").innerHTML='<div class="notice">Pricing is controlled centrally here. Schools inherit plan modules and limits, while individual subscriptions can receive module overrides.</div><div class="cards" style="margin-top:14px">'+catalog.plans.map(function(p){return '<div class="plan '+esc(p.plan_key)+'"><h3>'+esc(p.name)+'</h3><div class="price">'+money(p.monthly_price,p.currency)+'</div><div class="sub">per month · '+money(p.termly_price,p.currency)+' termly · '+money(p.annual_price,p.currency)+' annually</div><p class="sub">'+esc(p.description||"")+'</p><div class="sub"><b>'+esc(p.student_limit||"∞")+'</b> students · <b>'+esc(p.staff_limit||"∞")+'</b> staff · <b>'+esc(p.campus_limit||"∞")+'</b> campuses</div><ul>'+p.modules.slice(0,7).map(function(k){var m=catalog.modules.find(function(x){return x.module_key===k});return"<li>"+esc(m?m.name:k)+"</li>"}).join("")+(p.modules.length>7?"<li>+"+(p.modules.length-7)+" more</li>":"")+'</ul><button class="btn ghost" data-edit-plan="'+p.id+'">Edit Pricing</button></div>'}).join("")+'</div>'+
 '<div class="panel"><h3>Module Catalogue</h3><div class="modulegrid">'+catalog.modules.map(function(m){return '<div class="module"><b>'+esc(m.name)+'</b><small>'+esc(m.module_key)+'</small><p class="sub">'+esc(m.description||"")+'</p><b>'+money(m.base_monthly_price,"GHS")+' base</b></div>'}).join("")+'</div></div>';
 E("content").querySelectorAll("[data-edit-plan]").forEach(function(b){b.onclick=function(){var p=planById(b.dataset.editPlan);showModal('<h2>Edit '+esc(p.name)+' Pricing</h2><div class="fields"><div class="field"><label>Monthly Price (GHS)</label><input id="pMonthly" type="number" value="'+p.monthly_price+'"></div><div class="field"><label>Termly Price (GHS)</label><input id="pTermly" type="number" value="'+p.termly_price+'"></div><div class="field"><label>Annual Price (GHS)</label><input id="pAnnual" type="number" value="'+p.annual_price+'"></div><div class="field"><label>Student Limit</label><input id="pStudents" type="number" value="'+(p.student_limit||"")+'"></div><div class="field"><label>Staff Limit</label><input id="pStaff" type="number" value="'+(p.staff_limit||"")+'"></div><div class="field"><label>Campus Limit</label><input id="pCampus" type="number" value="'+(p.campus_limit||"")+'"></div></div><div class="modal-actions"><button class="btn ghost" id="mCancel">Cancel</button><button class="btn primary" id="mSave">Save Pricing</button></div>');E("mCancel").onclick=closeModal;E("mSave").onclick=async function(){try{await raw("/v1/commercial-control/plans/"+p.id,{method:"PATCH",body:JSON.stringify({monthlyPrice:Number(E("pMonthly").value),termlyPrice:Number(E("pTermly").value),annualPrice:Number(E("pAnnual").value),studentLimit:Number(E("pStudents").value)||null,staffLimit:Number(E("pStaff").value)||null,campusLimit:Number(E("pCampus").value)||null})});closeModal();toast("Pricing updated");await loadBase();plansPage()}catch(e){toast(e.message,true)}}}}
 )}
async function billingPage(){
 E("pageTitle").textContent="Billing & Invoices";var inv=await raw("/v1/commercial-control/invoices");
 E("content").innerHTML='<div class="grid"><div class="kpi"><span>Total Invoices</span><b>'+inv.length+'</b></div><div class="kpi"><span>Paid</span><b>'+inv.filter(function(x){return x.status==="paid"}).length+'</b></div><div class="kpi"><span>Outstanding</span><b>'+money(inv.filter(function(x){return ["issued","part_paid","overdue"].includes(x.status)}).reduce(function(a,x){return a+Number(x.total)-Number(x.amount_paid)},0))+'</b></div><div class="kpi"><span>Collected</span><b>'+money(inv.reduce(function(a,x){return a+Number(x.amount_paid)},0))+'</b></div></div><div class="panel">'+table(inv,[{key:"invoice_no",label:"Invoice"},{key:"customer_name",label:"School"},{key:"status",render:function(r){return badge(r.status)}},{key:"total",render:function(r){return money(r.total,r.currency)}},{key:"amount_paid",label:"Paid",render:function(r){return money(r.amount_paid,r.currency)}},{key:"due_at",label:"Due",render:function(r){return fmt(r.due_at)}}])+'</div>';
}
async function page(p){current=p;document.querySelectorAll(".nav button").forEach(function(b){b.classList.toggle("active",b.dataset.page===p)});E("content").innerHTML='<div class="empty">Loading...</div>';try{if(p==="overview")await overview();else if(p==="schools")schoolsPage();else if(p==="plans")plansPage();else if(p==="billing")await billingPage()}catch(e){E("content").innerHTML='<div class="panel"><h3>Could not load Commercial Control</h3><p class="sub">'+esc(e.message)+'</p></div>'}}
document.querySelector(".nav").onclick=function(e){var b=e.target.closest("[data-page]");if(b)page(b.dataset.page)};
E("backOs").onclick=function(){location.href="/"};E("refresh").onclick=function(){page(current)};E("newSchool").onclick=openNewSchool;E("modal").onclick=function(e){if(e.target===E("modal"))closeModal()};
(async function(){try{if(!await loadBase())return;await page("overview")}catch(e){if(String(e.message).includes("Permission")||String(e.message).includes("Authentication")||String(e.message).includes("Unauthorized"))location.href="/login";else E("content").innerHTML='<div class="panel"><h3>Commercial Control unavailable</h3><p>'+esc(e.message)+'</p></div>'}})();
})();
</script>
</body></html>`;
