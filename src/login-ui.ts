export const osLoginFrontend=String.raw`<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Revolt-X OS Sign In</title>
<style>
:root{--navy:#071b31;--blue:#1f63db;--gold:#f2b742;--line:#dbe5ef;--ink:#172536;--muted:#718096}
*{box-sizing:border-box}body{margin:0;min-height:100vh;display:grid;place-items:center;padding:24px;font-family:Inter,Arial,sans-serif;background:linear-gradient(145deg,#06172b,#0c3157 65%,#124d78);color:white}
.shell{width:min(1040px,96vw);display:grid;grid-template-columns:1.05fr .8fr;background:white;border-radius:24px;overflow:hidden;box-shadow:0 36px 100px #0006}
.hero{padding:52px;background:linear-gradient(150deg,#071b31,#0d3157);display:flex;flex-direction:column;justify-content:space-between;min-height:620px}.brand{font-size:21px;font-weight:900}.brand span{display:inline-grid;place-items:center;width:42px;height:42px;border-radius:12px;background:var(--gold);color:var(--navy);margin-right:9px}.hero h1{font-size:46px;line-height:1.04;margin:65px 0 15px}.hero p{color:#c9d9e8;max-width:520px;font-size:16px;line-height:1.6}.chips{display:flex;flex-wrap:wrap;gap:8px}.chip{border:1px solid #ffffff24;background:#ffffff0c;padding:7px 10px;border-radius:999px;font-size:12px}
.form{color:var(--ink);padding:48px;display:flex;align-items:center}.card{width:100%;max-width:420px;margin:auto}.tabs{display:flex;background:#f4f7fb;border-radius:10px;padding:4px;margin-bottom:22px}.tabs button{flex:1;border:0;background:transparent;padding:10px;border-radius:8px;font-weight:800;cursor:pointer}.tabs button.active{background:white;box-shadow:0 2px 8px #102e5014}.card h2{font-size:30px;margin:0 0 6px}.muted{color:var(--muted);font-size:13px;line-height:1.5}label{display:block;margin-top:14px;font-size:12px;font-weight:800;color:#4d6176}input{width:100%;margin-top:6px;padding:12px 13px;border:1px solid var(--line);border-radius:10px;outline:none}input:focus{border-color:#77a7e8;box-shadow:0 0 0 3px #1f63db14}.primary{width:100%;border:0;border-radius:10px;background:var(--blue);color:white;padding:12px 14px;font-weight:850;margin-top:18px;cursor:pointer}.error,.success{padding:10px 12px;border-radius:10px;margin-top:12px;font-size:12px}.error{background:#fff0f1;color:#a62934}.success{background:#eaf7f0;color:#177448}.hidden{display:none!important}
@media(max-width:760px){.shell{grid-template-columns:1fr}.hero{min-height:auto;padding:30px}.hero h1{font-size:34px;margin-top:30px}.form{padding:32px 26px}}
</style></head>
<body>
<div class="shell">
<section class="hero"><div><div class="brand"><span>RX</span>REVOLT-X OS</div><h1>Commercial control for every Revolt-X product.</h1><p>Manage customers, provision schools, assign plans, control licences, monitor renewals and run subscription billing from one secure operating platform.</p></div><div class="chips"><span class="chip">Customer provisioning</span><span class="chip">Plan enforcement</span><span class="chip">Licence control</span><span class="chip">Billing & renewals</span></div></section>
<section class="form"><div class="card">
<div class="tabs"><button id="loginTab" class="active">Sign in</button><button id="registerTab">Create workspace</button></div>
<div id="message"></div>
<div id="loginView"><h2>Welcome back</h2><p class="muted">Sign in to your Revolt-X Technologies workspace.</p><label>Email</label><input id="loginEmail" type="email" autocomplete="username"><label>Password</label><input id="loginPassword" type="password" autocomplete="current-password"><button id="loginBtn" class="primary">Sign in to OS</button></div>
<div id="registerView" class="hidden"><h2>Create your OS workspace</h2><p class="muted">Use this once for the Revolt-X Technologies commercial organisation.</p><label>Organisation name</label><input id="orgName" value="Revolt-X Technologies"><label>Workspace slug</label><input id="orgSlug" value="revolt-x-technologies"><label>First name</label><input id="firstName"><label>Last name</label><input id="lastName"><label>Email</label><input id="registerEmail" type="email"><label>Password</label><input id="registerPassword" type="password"><p class="muted">Minimum 8 characters with uppercase, lowercase and a number.</p><button id="registerBtn" class="primary">Create Commercial Workspace</button></div>
</div></section></div>
<script>
(function(){
function E(id){return document.getElementById(id)}
function msg(text,bad){E('message').innerHTML='<div class="'+(bad?'error':'success')+'">'+String(text).replace(/[<>&]/g,'')+'</div>'}
function save(x){sessionStorage.setItem('rx_access',x.accessToken);sessionStorage.setItem('rx_refresh',x.refreshToken||'');location.replace('/commercial-control')}
function tab(which){var login=which==='login';E('loginView').classList.toggle('hidden',!login);E('registerView').classList.toggle('hidden',login);E('loginTab').classList.toggle('active',login);E('registerTab').classList.toggle('active',!login);E('message').innerHTML=''}
E('loginTab').onclick=function(){tab('login')};E('registerTab').onclick=function(){tab('register')};
E('loginBtn').onclick=async function(){var b=E('loginBtn');b.disabled=true;try{var r=await fetch('/v1/auth/login',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({email:E('loginEmail').value.trim(),password:E('loginPassword').value})});var j=await r.json().catch(function(){return{}});if(!r.ok)throw Error(j&&j.error&&j.error.message?j.error.message:'Sign in failed');save(j)}catch(e){msg(e.message,true);b.disabled=false}};
E('registerBtn').onclick=async function(){var b=E('registerBtn');b.disabled=true;try{var r=await fetch('/v1/auth/register-organisation',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({organisationName:E('orgName').value.trim(),slug:E('orgSlug').value.trim(),firstName:E('firstName').value.trim(),lastName:E('lastName').value.trim(),email:E('registerEmail').value.trim(),password:E('registerPassword').value})});var j=await r.json().catch(function(){return{}});if(!r.ok)throw Error(j&&j.error&&j.error.message?j.error.message:'Workspace creation failed');save(j)}catch(e){msg(e.message,true);b.disabled=false}};
E('loginPassword').onkeydown=function(e){if(e.key==='Enter')E('loginBtn').click()};
})();
</script></body></html>`;
