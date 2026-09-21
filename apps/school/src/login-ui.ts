export const loginFrontend=`<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Revolt-X School Sign In</title>
<style>
:root{--bg:#061018;--panel:#0c1c27;--line:#203844;--text:#f4f8fa;--muted:#91a8b5;--green:#45ddb2;--blue:#48a9ff;--red:#ff7482}
*{box-sizing:border-box}
body{margin:0;min-height:100vh;background:
radial-gradient(circle at 15% 10%,#123240 0,transparent 34%),
radial-gradient(circle at 90% 88%,#123027 0,transparent 32%),var(--bg);
color:var(--text);font:14px/1.5 Arial,sans-serif;display:grid;place-items:center;padding:24px}
.shell{width:min(980px,96vw);display:grid;grid-template-columns:1.05fr .95fr;background:#081721;border:1px solid var(--line);border-radius:24px;overflow:hidden;box-shadow:0 28px 90px #0008}
.hero{padding:48px;background:linear-gradient(145deg,#0b202b,#0c2825);display:flex;flex-direction:column;justify-content:space-between;min-height:590px}
.brand{font-weight:900;letter-spacing:.08em;font-size:18px}.brand span{color:var(--green)}
.hero h1{font-size:46px;line-height:1.02;margin:24px 0 14px;max-width:520px}.hero p{color:#b7c9d2;max-width:500px;font-size:16px}
.role-grid{display:grid;grid-template-columns:1fr 1fr;gap:10px;margin-top:28px}.role{border:1px solid #28505d;background:#0a1b24;border-radius:12px;padding:12px}.role b{display:block}.role small{color:var(--muted)}
.form-side{padding:48px;display:flex;align-items:center}.card{width:100%;max-width:420px;margin:auto}.eyebrow{color:var(--green);font-weight:800;text-transform:uppercase;letter-spacing:.08em;font-size:11px}.card h2{font-size:30px;margin:6px 0}.muted{color:var(--muted)}
label{display:block;margin-top:16px;font-size:12px;color:#bad0db;font-weight:700}
input,select{width:100%;margin-top:7px;padding:13px 14px;background:#06131b;border:1px solid var(--line);border-radius:10px;color:white;outline:none}
input:focus{border-color:#4ca5b9;box-shadow:0 0 0 3px #48a9ff1a}
button{width:100%;border:0;border-radius:10px;padding:13px;margin-top:18px;background:linear-gradient(90deg,var(--green),var(--blue));color:#041018;font-weight:900;cursor:pointer}
button:disabled{opacity:.6;cursor:wait}.error,.success,.status{padding:10px 12px;border-radius:10px;margin-top:14px}.error{background:#2b161a;border:1px solid #6d3038;color:#ffc1c8}.success{background:#112a24;border:1px solid #2c6d5c;color:#8af0d3}.status{background:#0b1720;border:1px solid var(--line);color:var(--muted)}
.links{display:flex;justify-content:space-between;gap:12px;margin-top:14px;font-size:12px}.links a{color:#91cfff;text-decoration:none}
.password-rule{color:var(--muted);font-size:11px;margin-top:6px}.demo-box{margin-top:22px;padding-top:18px;border-top:1px solid var(--line)}.demo-box h3{margin:0 0 4px}.demo-box button.secondary{background:#102833;color:#dff8ff;border:1px solid #315466}.demo-row{display:grid;grid-template-columns:1fr auto;gap:8px;align-items:end}.demo-row button{width:auto;min-width:120px}.hide{display:none!important}
@media(max-width:760px){.shell{grid-template-columns:1fr}.hero{min-height:auto;padding:28px}.hero h1{font-size:34px}.role-grid{display:none}.form-side{padding:28px}}
</style>
</head>
<body>
<div class="shell">
  <section class="hero">
    <div>
      <div class="brand"><span>REVOLT-X</span> SCHOOL</div>
      <h1>One secure sign-in for every School staff user.</h1>
      <p>Your School role decides what opens after sign-in. Every active School role uses this same account screen. The role profile and privileges decide which workspace and functions open after sign-in.</p>
      <div class="role-grid">
        <div class="role"><b>Teachers</b><small>Classes, scores, attendance, lesson notes and reports</small></div>
        <div class="role"><b>Headteachers</b><small>Academic oversight, approvals and teaching access</small></div>
        <div class="role"><b>Administrators</b><small>School operations, setup and access control</small></div>
        <div class="role"><b>Registrar / Bursar</b><small>Admissions, records, fees and assigned functions</small></div>
      </div>
    </div>
    <small class="muted">Revolt-X School • Secure staff access powered by Core Revolt-X OS</small>
  </section>
  <section class="form-side">
    <div class="card">
      <div id="signinView">
        <div class="eyebrow">Staff access</div>
        <h2>Sign in</h2>
        <p class="muted">Use the email address and password assigned to your Revolt-X School account.</p>
        <div id="message"></div>
        <label>Email address</label>
        <input id="email" type="email" autocomplete="username" placeholder="name@school.edu">
        <label>Password</label>
        <input id="password" type="password" autocomplete="current-password">
        <button id="signin">Sign in to Revolt-X School</button>
        <div id="status" class="status" style="display:none"></div>
        <div id="demoAccess" class="demo-box hide">
          <div class="eyebrow">Demo access</div>
          <h3>Select a School user</h3>
          <p class="muted">Demo users include every active School role, including custom roles. Each opens the workspace configured on its role profile.</p>
          <div id="demoGate">
            <label>Demo access password</label>
            <input id="demoPassword" type="password" autocomplete="current-password">
            <button id="unlockDemo" class="secondary">Unlock Demo Access</button>
          </div>
          <div id="demoChooser" class="hide">
            <label>Staff user</label>
            <select id="demoStaff"><option value="">Loading staff...</option></select>
            <button id="openDemoStaff">Open Selected Workspace</button>
          </div>
          <div id="demoStatus" class="muted" style="margin-top:8px"></div>
        </div>
        <div class="links"><a href="/admissions">Public admissions</a><a href="/parent">Parent portal</a></div>
      </div>
      <div id="setupView" style="display:none">
        <div class="eyebrow">Account activation</div>
        <h2>Create your password</h2>
        <p class="muted">Set a password for your School staff account, then use this same sign-in page going forward.</p>
        <div id="setupMessage"></div>
        <label>New password</label>
        <input id="newPassword" type="password" autocomplete="new-password">
        <div class="password-rule">At least 12 characters with uppercase, lowercase and a number.</div>
        <label>Confirm password</label>
        <input id="confirmPassword" type="password" autocomplete="new-password">
        <button id="savePassword">Create password</button>
      </div>
    </div>
  </section>
</div>
<script>
(function(){
function E(id){return document.getElementById(id)}
function esc(v){return String(v==null?'':v).replace(/[&<>"']/g,function(c){return{'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]})}
async function json(path,opt){opt=opt||{};opt.headers=Object.assign({'content-type':'application/json'},opt.headers||{});var r=await fetch(path,opt),j=null;try{j=await r.json()}catch(e){}if(!r.ok){var er=Error(j&&j.error&&j.error.message?j.error.message:'Request failed ('+r.status+')');er.status=r.status;throw er}return j}
function roleHome(profile){return profile&&profile.portal_mode==='teacher'?'/teacher':'/'}
function allowedNext(profile,next){
  var home=roleHome(profile);
  if(next&&next===home)return next;
  return home
}
async function existingSession(){
  try{
    var r=await fetch('/api/context'),j=await r.json();
    if(r.ok&&j&&j.schoolRole){location.replace(allowedNext(j.roleProfile,new URLSearchParams(location.search).get('next')||''));return true}
  }catch(e){}
  return false
}
async function signIn(){
  var email=E('email').value.trim(),password=E('password').value,btn=E('signin'),status=E('status');
  E('message').innerHTML='';
  if(!email||!password){E('message').innerHTML='<div class="error">Enter your email address and password.</div>';return}
  btn.disabled=true;btn.textContent='Signing in...';status.style.display='block';status.textContent='Authenticating your School account...';
  try{
    var x=await json('/api/auth/login',{method:'POST',body:JSON.stringify({email:email,password:password})});
    status.textContent='Signed in as '+(x.user?x.user.firstName+' '+x.user.lastName:'School user')+'. Opening your workspace...';
    try{sessionStorage.setItem('rx_school_token',x.accessToken);if(x.redirectTo==='/teacher')sessionStorage.setItem('rx_teacher_token',x.accessToken);else sessionStorage.removeItem('rx_teacher_token')}catch(e){}
    var next=new URLSearchParams(location.search).get('next')||'';
    location.replace(x.redirectTo||allowedNext(x.roleProfile,next))
  }catch(err){
    E('message').innerHTML='<div class="error">'+esc(err.message)+'</div>';status.style.display='none';btn.disabled=false;btn.textContent='Sign in to Revolt-X School'
  }
}
async function configureDemoAccess(){
  var state;
  try{state=await json('/api/test-access/status')}catch(e){return}
  if(!state.enabled)return;
  E('demoAccess').classList.remove('hide');

  async function loadStaff(){
    try{
      var staff=await json('/api/test-access/staff');
      E('demoGate').classList.add('hide');E('demoChooser').classList.remove('hide');
      E('demoStaff').innerHTML=staff.length?staff.map(function(u){
        return '<option value="'+esc(u.id)+'">'+esc(u.first_name+' '+u.last_name+' • '+u.role.replace('_',' ')+' • '+(u.job_title||''))+'</option>'
      }).join(''):'<option value="">No demo staff configured</option>'
    }catch(err){
      if(err.status===401){E('demoGate').classList.remove('hide');E('demoChooser').classList.add('hide');return}
      E('demoStatus').textContent=err.message
    }
  }

  E('unlockDemo').onclick=async function(){
    var btn=E('unlockDemo');btn.disabled=true;btn.textContent='Unlocking...';E('demoStatus').textContent='';
    try{
      await json('/api/test-access/unlock',{method:'POST',body:JSON.stringify({password:E('demoPassword').value})});
      await loadStaff()
    }catch(err){E('demoStatus').textContent=err.message;btn.disabled=false;btn.textContent='Unlock Demo Access'}
  };
  E('demoPassword').onkeydown=function(e){if(e.key==='Enter')E('unlockDemo').click()};
  E('openDemoStaff').onclick=async function(){
    var id=E('demoStaff').value;if(!id)return;
    var btn=E('openDemoStaff');btn.disabled=true;btn.textContent='Opening workspace...';E('demoStatus').textContent='';
    try{
      var x=await json('/api/test-access/staff-login',{method:'POST',body:JSON.stringify({osUserId:id})});
      try{
        sessionStorage.setItem('rx_school_token',x.accessToken);
        if(x.redirectTo==='/teacher')sessionStorage.setItem('rx_teacher_token',x.accessToken);else sessionStorage.removeItem('rx_teacher_token')
      }catch(e){}
      location.replace(x.redirectTo||roleHome(x.roleProfile))
    }catch(err){E('demoStatus').textContent=err.message;btn.disabled=false;btn.textContent='Open Selected Workspace'}
  };
  if(state.unlocked)await loadStaff()
}
async function setup(){
  var p1=E('newPassword').value,p2=E('confirmPassword').value,btn=E('savePassword'),token=new URLSearchParams(location.search).get('setup');
  E('setupMessage').innerHTML='';
  if(p1!==p2){E('setupMessage').innerHTML='<div class="error">The passwords do not match.</div>';return}
  btn.disabled=true;btn.textContent='Creating password...';
  try{
    await json('/api/auth/set-password',{method:'POST',body:JSON.stringify({token:token,password:p1})});
    history.replaceState({},document.title,'/login');
    E('setupView').style.display='none';E('signinView').style.display='block';
    E('message').innerHTML='<div class="success">Password created successfully. Sign in with your email address and new password.</div>'
  }catch(err){E('setupMessage').innerHTML='<div class="error">'+esc(err.message)+'</div>';btn.disabled=false;btn.textContent='Create password'}
}
async function boot(){
  var setupToken=new URLSearchParams(location.search).get('setup');
  if(setupToken){E('signinView').style.display='none';E('setupView').style.display='block';E('savePassword').onclick=setup;return}
  if(await existingSession())return;
  E('signin').onclick=signIn;E('password').onkeydown=function(e){if(e.key==='Enter')signIn()};
  await configureDemoAccess()
}
boot()
})();
</script>
</body></html>`;
