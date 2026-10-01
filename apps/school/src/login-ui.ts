import { applySchoolDesign } from './school-design.js';

export const loginFrontend=applySchoolDesign(`<!doctype html>
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
.shell{width:min(980px,96vw);display:grid;grid-template-columns:1.05fr .95fr;background:#f7f9fb;border:1px solid var(--line);border-radius:24px;overflow:hidden;box-shadow:0 28px 90px #0008}
.hero{padding:48px;background:linear-gradient(145deg,#0b202b,#0c2825);display:flex;flex-direction:column;justify-content:space-between;min-height:590px}
.brand{font-weight:900;letter-spacing:.08em;font-size:18px}.brand span{color:var(--green)}
.hero h1{font-size:46px;line-height:1.02;margin:24px 0 14px;max-width:520px}.hero p{color:#35658d;max-width:500px;font-size:16px}
.role-grid{display:grid;grid-template-columns:1fr 1fr;gap:10px;margin-top:28px}.role{border:1px solid #28505d;background:#f7f9fb;border-radius:12px;padding:12px}.role b{display:block}.role small{color:var(--muted)}
.form-side{padding:48px;display:flex;align-items:center}.card{width:100%;max-width:420px;margin:auto}.eyebrow{color:var(--green);font-weight:800;text-transform:uppercase;letter-spacing:.08em;font-size:11px}.card h2{font-size:30px;margin:6px 0}.muted{color:var(--muted)}
label{display:block;margin-top:16px;font-size:12px;color:#35658d;font-weight:700}
input,select{width:100%;margin-top:7px;padding:13px 14px;background:#f7f9fb;border:1px solid var(--line);border-radius:10px;color:var(--text);outline:none}
input:focus{border-color:#4ca5b9;box-shadow:0 0 0 3px #48a9ff1a}
button{width:100%;border:0;border-radius:10px;padding:13px;margin-top:18px;background:linear-gradient(90deg,var(--green),var(--blue));color:#041018;font-weight:900;cursor:pointer}
button:disabled{opacity:.6;cursor:wait}.error,.success,.status{padding:10px 12px;border-radius:10px;margin-top:14px}.error{background:#fff0f2;border:1px solid #6d3038;color:#a63b4e}.success{background:#edf4ef;border:1px solid #2c6d5c;color:#2a6d48}.status{background:#f7f9fb;border:1px solid var(--line);color:var(--muted)}
.links{display:flex;justify-content:space-between;gap:12px;margin-top:14px;font-size:12px}.links a{color:#35658d;text-decoration:none}
.password-rule{color:var(--muted);font-size:11px;margin-top:6px}.demo-box{margin-top:22px;padding-top:18px;border-top:1px solid var(--line)}.demo-box h3{margin:0 0 4px}.demo-box button.secondary{background:#f7f9fb;color:#35658d;border:1px solid #315466}.demo-row{display:grid;grid-template-columns:1fr auto;gap:8px;align-items:end}.demo-row button{width:auto;min-width:120px}.quick-grid{display:grid;gap:10px;margin-top:12px}.quick-profile{display:grid;grid-template-columns:1fr auto;gap:10px;align-items:center;padding:12px;border:1px solid var(--line);border-radius:12px;background:#f7f9fb}.quick-profile b{display:block}.quick-profile small{display:block;color:var(--muted);margin-top:2px}.quick-profile button{width:auto;min-width:92px;margin:0;padding:9px 11px}.quick-head{display:flex;justify-content:space-between;gap:10px;align-items:center}.quick-head button{width:auto;margin:0;padding:7px 9px}.hide{display:none!important}
@media(max-width:760px){.shell{grid-template-columns:1fr}.hero{min-height:auto;padding:28px}.hero h1{font-size:34px}.role-grid{display:none}.form-side{padding:28px}}
</style>
</head>
<body>
<div class="shell">
  <section class="hero">
    <div>
      <div class="brand"><span>RX</span><div class="rx-brand-copy">Revolt-X School<small>Your connected school</small></div></div>
      <h1>A great school day<br>starts here.</h1>
      <p>The people, learning and everyday work of your school, thoughtfully connected in one place.</p>
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
        <div id="loginEyebrow" class="eyebrow">Staff access</div>
        <h2 id="loginHeading">Welcome back.</h2>
        <p id="loginIntro" class="muted">Sign in with your school administrator or staff account.</p>
        <div id="message"></div>
        <div class="demo-box" style="margin-top:14px">
          <div class="eyebrow">What do I use to sign in?</div>
          <p class="muted" style="margin:6px 0 0"><b>School code:</b> comes from the school link and is normally filled automatically.<br><b>Email:</b> use the email address provided when your School user account was created.<br><b>Password:</b> new staff use the temporary generic password issued by the school administrator. Administrators can reset a staff password from Access Management.</p>
        </div>
        <label>School code</label>
        <input id="schoolSlug" autocomplete="organization" placeholder="your-school-code">
        <label>Email address</label>
        <input id="email" type="email" autocomplete="username" placeholder="name@school.edu">
        <label>Password</label>
        <input id="password" type="password" autocomplete="current-password">
        <button id="signin">Sign in to Revolt-X School</button>
        <button id="adminReset" class="secondary hide" type="button">Reset administrator password</button>
        <div id="status" class="status" style="display:none"></div>
        <div id="quickAccess" class="demo-box hide">
          <div class="quick-head"><div><div class="eyebrow">Quick Login</div><h3>Open any staff profile</h3></div><button id="lockQuick" class="secondary hide" type="button">Lock</button></div>
          <p class="muted">Enter the School generic password once, then choose the staff profile you want to open. Active administrators, headteachers, teachers, bursars, registrars and custom staff roles are included.</p>
          <div id="quickGate">
            <label>Generic staff password</label>
            <input id="quickPassword" type="password" autocomplete="current-password">
            <button id="unlockQuick" class="secondary">Unlock Quick Login</button>
          </div>
          <div id="quickChooser" class="hide">
            <div id="quickProfiles" class="quick-grid"></div>
          </div>
          <div id="quickStatus" class="muted" style="margin-top:8px"></div>
        </div>
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
        <div class="links"><a href="/admissions">Public admissions</a><a href="/parent">Parent portal</a><a href="/student">Student portal</a></div>
      </div>
      <div id="setupView" style="display:none">
        <div class="eyebrow">Account activation</div>
        <h2>Create your password</h2>
        <p class="muted">Create the password for the administrator email that was entered in Revolt-X OS. After this step, Revolt-X School will sign you in automatically.</p>
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
function applyLoginMode(){
  var path=location.pathname.toLowerCase(),mode='staff',title='School Staff Sign In',intro='Sign in with the email address and password issued for your School account.';
  if(path.indexOf('teacher-login')>=0){mode='teacher';title='Teacher Sign In';intro='Teachers sign in with the email address provided by the school and the temporary generic password issued by the administrator.'}
  else if(path.indexOf('headteacher-login')>=0){mode='headteacher';title='Headteacher Sign In';intro='Sign in with your Headteacher School account.'}
  else if(path.indexOf('bursar-login')>=0){mode='bursar';title='Bursar Sign In';intro='Sign in with your Bursar School account.'}
  else if(path.indexOf('registrar-login')>=0){mode='registrar';title='Registrar Sign In';intro='Sign in with your Registrar School account.'}
  else if(path.indexOf('admin-login')>=0){mode='admin';title='Administrator Sign In';intro='Sign in with your School administrator account.'}
  E('loginEyebrow').textContent=mode==='staff'?'Staff access':mode+' access';
  E('loginHeading').textContent=title;
  E('loginIntro').textContent=intro;
  document.title='Revolt-X School • '+title;
  if(mode==='admin'||mode==='staff')E('adminReset').classList.remove('hide');
}
async function requestAdminReset(){
  var email=E('email').value.trim(),schoolSlug=E('schoolSlug').value.trim();
  E('message').innerHTML='';
  if(!email||!schoolSlug){E('message').innerHTML='<div class="error">Enter the school code and administrator email first.</div>';return}
  var btn=E('adminReset');btn.disabled=true;btn.textContent='Creating reset...';
  try{
    await json('/api/auth/admin-reset/request',{method:'POST',body:JSON.stringify({email:email,schoolSlug:schoolSlug})});
    E('message').innerHTML='<div class="success">If this is an active School administrator account, password-reset instructions have been sent.</div>'
  }catch(err){E('message').innerHTML='<div class="error">'+esc(err.message)+'</div>'}
  finally{btn.disabled=false;btn.textContent='Reset administrator password'}
}

async function signIn(){
  var email=E('email').value.trim(),password=E('password').value,btn=E('signin'),status=E('status');
  E('message').innerHTML='';
  if(!email||!password){E('message').innerHTML='<div class="error">Enter your email address and password.</div>';return}
  btn.disabled=true;btn.textContent='Signing in...';status.style.display='block';status.textContent='Authenticating your School account...';
  try{
    var x=await json('/api/auth/login',{method:'POST',body:JSON.stringify({email:email,password:password,schoolSlug:E('schoolSlug').value.trim()||undefined})});
    status.textContent='Signed in as '+(x.user?x.user.firstName+' '+x.user.lastName:'School user')+'. Opening your workspace...';
    try{sessionStorage.setItem('rx_school_token',x.accessToken);if(x.redirectTo==='/teacher')sessionStorage.setItem('rx_teacher_token',x.accessToken);else sessionStorage.removeItem('rx_teacher_token')}catch(e){}
    var next=new URLSearchParams(location.search).get('next')||'';
    location.replace(x.redirectTo||allowedNext(x.roleProfile,next))
  }catch(err){
    E('message').innerHTML='<div class="error">'+esc(err.message)+'</div>';status.style.display='none';btn.disabled=false;btn.textContent='Sign in to Revolt-X School'
  }
}
async function configureQuickLogin(){
  var state;
  try{state=await json('/api/quick-login/status')}catch(e){return}
  if(!state.enabled)return;
  E('quickAccess').classList.remove('hide');

  async function loadProfiles(){
    var slug=E('schoolSlug').value.trim();
    E('quickStatus').textContent='Loading staff profiles...';
    try{
      var result=await json('/api/quick-login/staff'+(slug?'?schoolSlug='+encodeURIComponent(slug):''));
      var staff=result.staff||[];
      E('quickGate').classList.add('hide');E('quickChooser').classList.remove('hide');E('lockQuick').classList.remove('hide');
      var schoolName=result.school&&result.school.name||'',schoolSlug=result.school&&result.school.slug||'';
      var gracePrep=/grace\s*prep/i.test(schoolName)||/grace[-_\s]*prep/i.test(schoolSlug);
      E('quickStatus').textContent=staff.length?((schoolName?schoolName+' • ':'')+staff.length+' active staff profile'+(staff.length===1?'':'s')):'No active staff profiles are available.';
      E('quickProfiles').innerHTML=staff.length?staff.map(function(u){
        var fullName=(u.first_name+' '+u.last_name).trim(),role=(u.role_name||u.role||'Staff').replace(/_/g,' ');
        return gracePrep
          ?'<div class="quick-profile"><div><b>'+esc(fullName)+'</b></div><button data-quick-user="'+esc(u.id)+'">Login</button></div>'
          :'<div class="quick-profile"><div><b>'+esc(fullName)+'</b><small>'+esc(role)+(u.job_title?' • '+esc(u.job_title):'')+(u.email?' • '+esc(u.email):'')+'</small></div><button data-quick-user="'+esc(u.id)+'">Open</button></div>'
      }).join(''):'';
      E('quickProfiles').querySelectorAll('[data-quick-user]').forEach(function(btn){btn.onclick=async function(){
        var old=btn.textContent;btn.disabled=true;btn.textContent='Opening...';E('quickStatus').textContent='';
        try{
          var x=await json('/api/quick-login/staff-login',{method:'POST',body:JSON.stringify({osUserId:btn.dataset.quickUser,schoolSlug:slug||undefined})});
          try{
            sessionStorage.setItem('rx_school_token',x.accessToken);
            if(x.redirectTo==='/teacher')sessionStorage.setItem('rx_teacher_token',x.accessToken);else sessionStorage.removeItem('rx_teacher_token')
          }catch(e){}
          location.replace(x.redirectTo||roleHome(x.roleProfile))
        }catch(err){E('quickStatus').textContent=err.message;btn.disabled=false;btn.textContent=old}
      }})
    }catch(err){
      if(err.status===401){E('quickGate').classList.remove('hide');E('quickChooser').classList.add('hide');E('lockQuick').classList.add('hide')}
      E('quickStatus').textContent=err.message
    }
  }

  E('unlockQuick').onclick=async function(){
    var slug=E('schoolSlug').value.trim(),btn=E('unlockQuick');btn.disabled=true;btn.textContent='Unlocking...';E('quickStatus').textContent='';
    try{
      await json('/api/quick-login/unlock',{method:'POST',body:JSON.stringify({password:E('quickPassword').value,schoolSlug:slug||undefined})});
      E('quickPassword').value='';
      await loadProfiles()
    }catch(err){E('quickStatus').textContent=err.message}
    finally{btn.disabled=false;btn.textContent='Unlock Quick Login'}
  };
  E('quickPassword').onkeydown=function(e){if(e.key==='Enter')E('unlockQuick').click()};
  E('lockQuick').onclick=async function(){
    try{await json('/api/quick-login/lock',{method:'POST',body:'{}'})}catch(e){}
    E('quickChooser').classList.add('hide');E('quickGate').classList.remove('hide');E('lockQuick').classList.add('hide');E('quickProfiles').innerHTML='';E('quickStatus').textContent='Quick Login locked.'
  };
  if(state.unlocked)await loadProfiles()
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
    var result=await json('/api/auth/set-password',{method:'POST',body:JSON.stringify({token:token,password:p1})});
    var school=new URLSearchParams(location.search).get('school')||E('schoolSlug')&&E('schoolSlug').value||'';
    history.replaceState({},document.title,'/login'+(school?'?school='+encodeURIComponent(school):''));
    E('setupView').style.display='none';E('signinView').style.display='block';
    if(E('schoolSlug'))E('schoolSlug').value=school;
    if(result&&result.email)E('email').value=result.email;
    E('password').value=p1;
    E('signin').onclick=signIn;
    E('password').onkeydown=function(e){if(e.key==='Enter')signIn()};
    E('message').innerHTML='<div class="success">Password created successfully. Signing you in with the administrator email and the password you just created...</div>';
    await signIn()
  }catch(err){E('setupMessage').innerHTML='<div class="error">'+esc(err.message)+'</div>';btn.disabled=false;btn.textContent='Create password'}
}
async function boot(){
  applyLoginMode();
  E('adminReset').onclick=requestAdminReset;
  var params=new URLSearchParams(location.search),schoolCode=params.get('school')||'';
  if(E('schoolSlug'))E('schoolSlug').value=schoolCode;
  var setupToken=params.get('setup');
  if(setupToken){E('signinView').style.display='none';E('setupView').style.display='block';E('savePassword').onclick=setup;return}
  if(await existingSession())return;
  E('signin').onclick=signIn;E('password').onkeydown=function(e){if(e.key==='Enter')signIn()};
  await configureQuickLogin();
  await configureDemoAccess()
}
boot()
})();
</script>
</body></html>`,'login');
