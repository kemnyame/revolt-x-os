function loginDocument(mode:'core'|'licence'){
  const licenceMode=mode==='licence';
  const title=licenceMode?'Revolt-X OS Licence Sign In':'Revolt-X OS Sign In';
  const heading=licenceMode?'Licence & Commercial Control':'Commercial control for every Revolt-X product.';
  const description=licenceMode
    ?'Sign in with a Core OS account that has Commercial Control access. Your permissions determine what you can manage.'
    :'Manage your organisation, users, operations, controls and connected Revolt-X products from the main operating platform.';

  return String.raw`<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${title}</title>
<style>
:root{--navy:#071b31;--blue:#1f63db;--gold:#f2b742;--line:#dbe5ef;--ink:#172536;--muted:#718096}
*{box-sizing:border-box}body{margin:0;min-height:100vh;display:grid;place-items:center;padding:24px;font-family:Inter,Arial,sans-serif;background:linear-gradient(145deg,#06172b,#0c3157 65%,#124d78);color:white}
.shell{width:min(1040px,96vw);display:grid;grid-template-columns:1.05fr .8fr;background:white;border-radius:24px;overflow:hidden;box-shadow:0 36px 100px #0006}
.hero{padding:52px;background:linear-gradient(150deg,#071b31,#0d3157);display:flex;flex-direction:column;justify-content:space-between;min-height:620px}.brand{font-size:21px;font-weight:900}.brand span{display:inline-grid;place-items:center;width:42px;height:42px;border-radius:12px;background:var(--gold);color:var(--navy);margin-right:9px}.hero h1{font-size:46px;line-height:1.04;margin:65px 0 15px}.hero p{color:#c9d9e8;max-width:520px;font-size:16px;line-height:1.6}.chips{display:flex;flex-wrap:wrap;gap:8px}.chip{border:1px solid #ffffff24;background:#ffffff0c;padding:7px 10px;border-radius:999px;font-size:12px}
.form{color:var(--ink);padding:48px;display:flex;align-items:center}.card{width:100%;max-width:420px;margin:auto}.tabs{display:flex;background:#f4f7fb;border-radius:10px;padding:4px;margin-bottom:22px}.tabs button{flex:1;border:0;background:transparent;padding:10px;border-radius:8px;font-weight:800;cursor:pointer}.tabs button.active{background:white;box-shadow:0 2px 8px #102e5014}.card h2{font-size:30px;margin:0 0 6px}.muted{color:var(--muted);font-size:13px;line-height:1.5}label{display:block;margin-top:14px;font-size:12px;font-weight:800;color:#4d6176}input{width:100%;margin-top:6px;padding:12px 13px;border:1px solid var(--line);border-radius:10px;outline:none}input:focus{border-color:#77a7e8;box-shadow:0 0 0 3px #1f63db14}.primary{width:100%;border:0;border-radius:10px;background:var(--blue);color:white;padding:12px 14px;font-weight:850;margin-top:18px;cursor:pointer}.error,.success{padding:10px 12px;border-radius:10px;margin-top:12px;font-size:12px}.error{background:#fff0f1;color:#a62934}.success{background:#eaf7f0;color:#177448}.hidden{display:none!important}.password-field{position:relative}.password-field input{padding-right:72px}.password-toggle{position:absolute;right:8px;bottom:8px;border:0;background:#eef4fb;color:#315b88;border-radius:8px;padding:6px 9px;font-size:11px;font-weight:800;cursor:pointer}.switch-link{display:block;text-align:center;margin-top:16px;color:#315b88;font-size:12px;font-weight:800;text-decoration:none}
@media(max-width:760px){.shell{grid-template-columns:1fr}.hero{min-height:auto;padding:30px}.hero h1{font-size:34px;margin-top:30px}.form{padding:32px 26px}}
</style></head>
<body data-login-mode="${mode}">
<div class="shell">
<section class="hero"><div><div class="brand"><span>RX</span>REVOLT-X OS</div><h1>${heading}</h1><p>${description}</p></div><div class="chips"><span class="chip">Secure authentication</span><span class="chip">Role-based access</span><span class="chip">Audit logging</span><span class="chip">Licence control</span></div></section>
<section class="form"><div class="card">
${licenceMode?'':'<div class="tabs"><button id="loginTab" class="active">Sign in</button><button id="registerTab">Create workspace</button></div>'}
<div id="message"></div>
<div id="loginView"><h2>${licenceMode?'Licence access':'Welcome back'}</h2><p class="muted">${licenceMode?'Only users granted Commercial Control permissions can continue.':'Sign in to your Revolt-X Technologies workspace.'}</p><label>Email</label><input id="loginEmail" type="email" autocomplete="username" required><label>Password</label><div class="password-field"><input id="loginPassword" type="password" autocomplete="current-password" required><button type="button" class="password-toggle" data-toggle-password="loginPassword">Show</button></div><button id="loginBtn" class="primary">${licenceMode?'Sign in to Licence Control':'Sign in to OS'}</button>${licenceMode?'<a class="switch-link" href="/login">← Main OS sign in</a>':'<a class="switch-link" href="/license-login">Licence & Commercial Control sign in →</a>'}</div>
${licenceMode?'':`<div id="registerView" class="hidden"><h2>Create your OS workspace</h2><p class="muted">Use this once for the Revolt-X Technologies commercial organisation.</p><label>Organisation name</label><input id="orgName" value="Revolt-X Technologies" required><label>Workspace slug</label><input id="orgSlug" value="revolt-x-technologies" required><label>First name</label><input id="firstName" required><label>Last name</label><input id="lastName" required><label>Email</label><input id="registerEmail" type="email" required><label>Password</label><div class="password-field"><input id="registerPassword" type="password" required><button type="button" class="password-toggle" data-toggle-password="registerPassword">Show</button></div><p class="muted">Minimum 8 characters with uppercase, lowercase and a number.</p><button id="registerBtn" class="primary">Create Commercial Workspace</button></div>`}
</div></section></div>
<script>
(function(){
var licenceMode=document.body.dataset.loginMode==='licence';
function E(id){return document.getElementById(id)}
function msg(text,bad){E('message').innerHTML='<div class="'+(bad?'error':'success')+'">'+String(text).replace(/[<>&]/g,'')+'</div>'}
function storeTokens(x){sessionStorage.setItem('rx_access',x.accessToken);sessionStorage.setItem('rx_refresh',x.refreshToken||'')}
function clearTokens(){sessionStorage.removeItem('rx_access');sessionStorage.removeItem('rx_refresh')}
async function destinationFor(x){
  storeTokens(x);
  if(!licenceMode)return '/';
  var r=await fetch('/v1/auth/context',{headers:{authorization:'Bearer '+x.accessToken}}),ctx=await r.json().catch(function(){return{}});
  if(!r.ok)throw Error(ctx&&ctx.error&&ctx.error.message?ctx.error.message:'Could not verify Licence Control access');
  var permissions=Array.isArray(ctx.permissions)?ctx.permissions:[];
  if(!permissions.includes('commercial.read')){clearTokens();throw Error('This account does not have Licence & Commercial Control access. Ask a Core OS administrator to grant the Licence Administrator role.')}
  return '/commercial-control';
}
function tab(which){var login=which==='login';E('loginView').classList.toggle('hidden',!login);E('registerView').classList.toggle('hidden',login);E('loginTab').classList.toggle('active',login);E('registerTab').classList.toggle('active',!login);E('message').innerHTML=''}
document.querySelectorAll('[data-toggle-password]').forEach(function(button){button.onclick=function(){var input=E(button.dataset.togglePassword),show=input.type==='password';input.type=show?'text':'password';button.textContent=show?'Hide':'Show'}});
if(E('loginTab'))E('loginTab').onclick=function(){tab('login')};if(E('registerTab'))E('registerTab').onclick=function(){tab('register')};
E('loginBtn').onclick=async function(){var b=E('loginBtn');if(!E('loginEmail').value.trim()||!E('loginPassword').value)return msg('Email and password are required.',true);b.disabled=true;try{var r=await fetch('/v1/auth/login',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({email:E('loginEmail').value.trim(),password:E('loginPassword').value})});var j=await r.json().catch(function(){return{}});if(!r.ok)throw Error(j&&j.error&&j.error.message?j.error.message:'Sign in failed');location.replace(await destinationFor(j))}catch(e){msg(e.message,true);b.disabled=false}};
if(E('registerBtn'))E('registerBtn').onclick=async function(){var b=E('registerBtn');b.disabled=true;try{var r=await fetch('/v1/auth/register-organisation',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({organisationName:E('orgName').value.trim(),slug:E('orgSlug').value.trim(),firstName:E('firstName').value.trim(),lastName:E('lastName').value.trim(),email:E('registerEmail').value.trim(),password:E('registerPassword').value})});var j=await r.json().catch(function(){return{}});if(!r.ok)throw Error(j&&j.error&&j.error.message?j.error.message:'Workspace creation failed');storeTokens(j);location.replace('/')}catch(e){msg(e.message,true);b.disabled=false}};
E('loginPassword').onkeydown=function(e){if(e.key==='Enter')E('loginBtn').click()};
})();
</script></body></html>`;
}

/** Main Core OS authentication. Successful login always enters the OS home page. */
export const osLoginFrontend=loginDocument('core');

/** Dedicated entry point for users assigned the Licence Administrator/commercial permissions. */
export const licenseLoginFrontend=loginDocument('licence');
