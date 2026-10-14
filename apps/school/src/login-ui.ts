import {schoolLocationScript} from './tenant-ui.js';
import { schoolSessionScript } from './session-ui.js';
import { applySchoolDesign } from './school-design.js';
import { schoolSignInStartupScript } from './sign-in-startup.js';

const schoolSelectionScript=`
  ${schoolLocationScript}
  async function loadSchool(){
    var button=E('signin'),requested=schoolFromLocation();button.disabled=true;E('retrySignIn').hidden=true;
    if(!requested){show('Open the sign-in link provided by your school.');return false}
    try{
      var data=document.body&&document.body.dataset,school=data&&data.schoolId?{id:data.schoolId,name:data.schoolName}:null;
      if(!school)school=await window.RevoltSchoolSignIn.loadData('/api/auth/school-context?'+new URLSearchParams({school:requested}),{valid:function(value){return value&&value.id&&value.name},progress:function(message){show(message,'success')}});
      E('schoolId').value=school.id;E('schoolName').textContent=school.name;document.title=school.name+' · Sign in';
      var peer=E('otherLogin');if(peer)peer.href='/s/'+encodeURIComponent(school.id)+(location.pathname.endsWith('/admin-login')?'/login':'/admin-login');
      E('status').textContent='';E('status').className='';button.disabled=false;return true;
    }catch(err){show(err.message||'Could not load your school');E('retrySignIn').hidden=false;return false}
  }
`;

const sharedStyles=`
:root{font-family:Inter,system-ui,-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;color:#172334;background:#eef3f7}
*{box-sizing:border-box}
body{margin:0;min-height:100vh;background:linear-gradient(135deg,#eef4f7 0%,#f8fbfc 55%,#edf2f5 100%);display:flex;align-items:center;justify-content:center;padding:24px}
.shell{width:min(980px,100%);display:grid;grid-template-columns:1.05fr .95fr;background:#fff;border:1px solid #dbe5eb;border-radius:24px;overflow:hidden;box-shadow:0 24px 70px rgba(32,59,78,.14)}
.brand{padding:54px;background:linear-gradient(150deg,#17324a,#315466);color:#fff;display:flex;flex-direction:column;justify-content:space-between;min-height:580px}
.brand h1{font-size:38px;line-height:1.05;margin:14px 0 16px}.brand p{color:#d9e7ee;font-size:16px;line-height:1.65;max-width:430px}
.mark{font-weight:800;letter-spacing:.08em;font-size:14px}.brand-card{border:1px solid rgba(255,255,255,.18);background:rgba(255,255,255,.08);border-radius:16px;padding:18px}
.form-side{padding:54px 46px;display:flex;align-items:center}.form-wrap{width:100%;max-width:390px;margin:auto}
.eyebrow{text-transform:uppercase;letter-spacing:.12em;font-weight:800;font-size:12px;color:#527188}
h2{font-size:30px;margin:8px 0 8px;color:#172334}.muted{color:#667b8b;line-height:1.55}
label{display:block;font-weight:700;font-size:13px;margin:20px 0 7px;color:#294254}
input,select{width:100%;border:1px solid #cdd9e0;border-radius:12px;padding:13px 14px;font-size:16px;outline:none;background:#fbfdfe;color:#172334}
input:focus,select:focus{border-color:#315466;box-shadow:0 0 0 3px rgba(49,84,102,.12)}
button{width:100%;margin-top:22px;border:0;border-radius:12px;background:#315466;color:#fff;font-size:15px;font-weight:800;padding:13px 16px;cursor:pointer}
button:disabled{opacity:.6;cursor:wait}.status{margin-top:14px;border-radius:10px;padding:11px 12px;font-size:14px}
.error{background:#fff1f0;color:#a22c22;border:1px solid #ffd2cf}.success{background:#edf8f1;color:#23623d;border:1px solid #ccebd7}
.help{margin-top:20px;padding:14px;border:1px solid #dbe5eb;border-radius:12px;background:#f7fafb;color:#617583;font-size:13px;line-height:1.55}.switch{margin-top:16px;text-align:center;font-size:13px}.switch a{color:#315466;font-weight:800;text-decoration:none}.switch a:hover{text-decoration:underline}.password-visibility{display:flex;align-items:center;gap:8px;margin:8px 0 0;color:#526979;font-size:13px;font-weight:700}.password-visibility input{width:auto;margin:0;padding:0}
@media(max-width:760px){body{padding:0}.shell{grid-template-columns:1fr;border-radius:0;min-height:100vh}.brand{min-height:auto;padding:32px}.brand-card{display:none}.form-side{padding:34px 28px}.brand h1{font-size:30px}}
`;

export const loginFrontend=applySchoolDesign(`<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Revolt-X School • Staff Login</title>
<style>${sharedStyles}.req{color:#b42318;font-weight:800}.field-error{font-size:12px;color:#b42318;margin-top:5px}input:invalid:not(:placeholder-shown),select:invalid{border-color:#b42318;box-shadow:0 0 0 3px rgba(180,35,24,.08)}</style>
</head>
<body>
<main class="shell">
  <section class="brand">
    <div>
      <div class="mark">REVOLT-X SCHOOL</div>
      <h1>Welcome back to your school workspace.</h1>
      <p>Enter the Staff ID assigned to you and the password provided by your administrator.</p>
    </div>
    <div class="brand-card">
      <b>Staff ID + Password</b>
      <p style="margin:8px 0 0">Staff IDs are generated inside each school. They do not need the school name or school code added to them.</p>
    </div>
  </section>
  <section class="form-side">
    <div class="form-wrap">
      <div class="eyebrow">Staff access</div>
      <h2>Sign in to your school</h2>
      <p class="muted">Enter your Staff ID and password.</p>

      <p id="schoolName" class="eyebrow" aria-live="polite">Your school</p>
      <input id="schoolId" type="hidden">

      <label for="staffId">Staff ID</label>
      <input id="staffId" autocomplete="username" autocapitalize="none" autocorrect="off" spellcheck="false" placeholder="e.g. STF-000001">

      <label for="password">Password</label>
      <input id="password" type="password" autocomplete="current-password" placeholder="Enter your password">

      <button id="signin" type="button">Sign in</button>
      <p id="sessionExpired" class="help" hidden>Your session expired. Please sign in again.</p><div id="status" role="status" aria-live="polite"></div>
      <button id="retrySignIn" type="button" hidden>Retry loading sign-in</button>

      <div class="help"><b>First sign-in:</b> use the temporary password given by your administrator. You will be asked to create your own password before your workspace opens.</div>\n      <div class="switch">School Administrator? <a id="otherLogin" href="/admin-login">Use Admin Login</a></div>
    </div>
  </section>
</main>
<script>
${schoolSignInStartupScript}
(function(){
  function E(id){return document.getElementById(id)}
  function enablePasswordVisibility(){document.querySelectorAll('input[type=\"password\"]').forEach(function(input){if(input.dataset.visibilityReady)return;input.dataset.visibilityReady='1';var label=document.createElement('label');label.className='password-visibility';var check=document.createElement('input');check.type='checkbox';check.onchange=function(){input.type=check.checked?'text':'password'};label.appendChild(check);label.appendChild(document.createTextNode('Show password'));input.insertAdjacentElement('afterend',label)})}
  enablePasswordVisibility();
  if(new URLSearchParams(location.search).get('expired')==='1')E('sessionExpired').hidden=false;
  function show(message,type){var box=E('status');box.className='status '+(type||'error');box.textContent=message}
  async function json(url,options){
    var res=await fetch(url,Object.assign({headers:{'content-type':'application/json'}},options||{}));
    var body=await res.json().catch(function(){return null});
    if(!res.ok){var err=new Error(body&&body.error&&body.error.message?body.error.message:'Request failed');err.status=res.status;throw err}
    return body
  }
  ${schoolSelectionScript}
  async function signIn(){
    if(E('signin').disabled)return;
    var schoolId=E('schoolId').value,staffId=E('staffId').value.trim(),password=E('password').value;
    if(!schoolId){show('Open the sign-in link provided by your school.');return}
    if(!staffId){show('Enter your Staff ID.');E('staffId').focus();return}
    if(!password){show('Enter your password.');E('password').focus();return}
    var btn=E('signin'),old=btn.textContent;btn.disabled=true;btn.textContent='Signing in...';show('Connecting securely. This may take a moment if the sign-in service is starting.','success');
    try{
      await window.RevoltSchoolSignIn.ensureReady(function(message){show(message,'success')});
      var result=await json('/api/auth/staff-id-login',{method:'POST',body:JSON.stringify({schoolId:schoolId,staffId:staffId,password:password})});
      try{
        sessionStorage.removeItem('rx_school_session_expires_at');sessionStorage.setItem('rx_school_login_url','/s/'+encodeURIComponent(result.school&&result.school.id||schoolId)+'/login');
        sessionStorage.setItem('rx_school_token',result.accessToken);
        if(String(result.redirectTo||'').split('?')[0]==='/teacher')sessionStorage.setItem('rx_teacher_token',result.accessToken);else sessionStorage.removeItem('rx_teacher_token');
        localStorage.setItem('rx_school_id',result.school&&result.school.id?result.school.id:schoolId)
      }catch(e){}
      if(result.requiresPasswordChange){
        show('Sign-in successful. Create your new password to continue.','success');
        location.replace('/s/'+encodeURIComponent(result.school&&result.school.id||schoolId)+'/change-password');
        return
      }
      show('Welcome '+(result.user&&result.user.firstName?result.user.firstName:'')+'. Opening your workspace...','success');
      location.replace(schoolWorkspacePath(result.redirectTo||'/',result.school&&result.school.id||schoolId))
    }catch(err){
      show(err.message||'Sign in failed');btn.disabled=false;btn.textContent=old
    }
  }
  loadSchool();
  E('retrySignIn').onclick=loadSchool;
  E('signin').onclick=signIn;
  E('staffId').onkeydown=function(e){if(e.key==='Enter')E('password').focus()};
  E('password').onkeydown=function(e){if(e.key==='Enter')signIn()};
})();
</script>
</body>
</html>`,'login');

export const adminLoginFrontend=applySchoolDesign(`<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Revolt-X School • Administrator Login</title>
<style>${sharedStyles}</style>
</head>
<body>
<main class="shell">
  <section class="brand">
    <div>
      <div class="mark">REVOLT-X SCHOOL</div>
      <h1>School Administrator access.</h1>
      <p>This login is created when the school is first provisioned in Revolt-X OS and is separate from normal staff access.</p>
    </div>
    <div class="brand-card">
      <b>Admin Email + Password</b>
      <p style="margin:8px 0 0">The primary School Administrator does not use a Staff ID on this login.</p>
    </div>
  </section>
  <section class="form-side">
    <div class="form-wrap">
      <div class="eyebrow">Administrator access</div>
      <h2>School Admin Login</h2>
      <p class="muted">Sign in with the administrator account created for this school.</p>

      <p id="schoolName" class="eyebrow" aria-live="polite">Your school</p>
      <input id="schoolId" type="hidden">

      <label for="email">Administrator email</label>
      <input id="email" type="email" autocomplete="username" placeholder="admin@school.edu.gh">

      <label for="password">Administrator password</label>
      <input id="password" type="password" autocomplete="current-password" placeholder="Enter administrator password">

      <button id="signin" type="button">Sign in as Administrator</button>
      <p id="sessionExpired" class="help" hidden>Your session expired. Please sign in again.</p><div id="status" role="status" aria-live="polite"></div>
      <button id="retrySignIn" type="button" hidden>Retry loading sign-in</button>

      <div class="help"><b>Administrator access:</b> use the Admin Email and password configured for this school in Revolt-X OS Commercial Control.</div>
      <div class="switch">Staff member? <a id="otherLogin" href="/login">Use Staff Login</a></div>
    </div>
  </section>
</main>
<script>
${schoolSignInStartupScript}
(function(){
  function E(id){return document.getElementById(id)}
  function enablePasswordVisibility(){document.querySelectorAll('input[type=\"password\"]').forEach(function(input){if(input.dataset.visibilityReady)return;input.dataset.visibilityReady='1';var label=document.createElement('label');label.className='password-visibility';var check=document.createElement('input');check.type='checkbox';check.onchange=function(){input.type=check.checked?'text':'password'};label.appendChild(check);label.appendChild(document.createTextNode('Show password'));input.insertAdjacentElement('afterend',label)})}
  enablePasswordVisibility();
  if(new URLSearchParams(location.search).get('expired')==='1')E('sessionExpired').hidden=false;
  function show(message,type){var box=E('status');box.className='status '+(type||'error');box.textContent=message}
  async function json(url,options){
    var res=await fetch(url,Object.assign({headers:{'content-type':'application/json'}},options||{}));
    var body=await res.json().catch(function(){return null});
    if(!res.ok){var err=new Error(body&&body.error&&body.error.message?body.error.message:'Request failed');err.status=res.status;throw err}
    return body
  }
  ${schoolSelectionScript}
  var administratorId=(new URLSearchParams(location.search).get('admin')||'').trim();
  var boundAdministrator=null;
  async function loadAdministrator(){
    E('signin').disabled=true;E('schoolId').disabled=true;E('email').readOnly=true;
    E('retrySignIn').hidden=true;
    try{
      var school=schoolFromLocation();if(!school)throw Error('This administrator link is missing its school. Open the link from your school record.');
      var context=await window.RevoltSchoolSignIn.loadData('/api/auth/admin-login-context?'+new URLSearchParams({schoolId:school,adminUserId:administratorId}),{core:true,valid:function(value){return value&&value.administrator&&value.administrator.id===administratorId&&value.school&&value.school.id&&value.administrator.email},progress:function(message){show(message,'success')}});
      boundAdministrator=context.administrator;E('schoolId').value=context.school.id;E('schoolName').textContent=context.school.name;
      E('email').value=boundAdministrator.email;E('signin').disabled=false;
      show('Sign in as '+boundAdministrator.name+' for '+context.school.name+'. Enter this administrator’s password. If you reset it, use the new password.','success');
    }catch(err){show(err.message||'The administrator link could not be verified.');E('signin').disabled=true;E('retrySignIn').hidden=false}
  }
  async function signIn(){
    if(E('signin').disabled)return;
    var schoolId=E('schoolId').value,email=boundAdministrator?boundAdministrator.email:E('email').value.trim().toLowerCase(),password=E('password').value;
    if(!schoolId){show('Open the sign-in link provided by your school.');return}
    if(!email){show('Enter the administrator email.');E('email').focus();return}
    if(!password){show('Enter the administrator password.');E('password').focus();return}
    var btn=E('signin'),old=btn.textContent;btn.disabled=true;btn.textContent='Signing in...';E('status').className='';E('status').textContent='';
    try{
      await window.RevoltSchoolSignIn.ensureReady(function(message){show(message,'success')});
      var result=await json('/api/auth/admin-login',{method:'POST',body:JSON.stringify({schoolId:schoolId,email:email,password:password,adminUserId:boundAdministrator?boundAdministrator.id:undefined})});
      try{
        sessionStorage.removeItem('rx_school_session_expires_at');sessionStorage.setItem('rx_school_login_url','/s/'+encodeURIComponent(result.school&&result.school.id||schoolId)+'/admin-login'+(result.user&&result.user.id?'?admin='+encodeURIComponent(result.user.id):''));
        sessionStorage.setItem('rx_school_token',result.accessToken);
        sessionStorage.removeItem('rx_teacher_token');
        localStorage.setItem('rx_school_id',result.school&&result.school.id?result.school.id:schoolId)
      }catch(e){}
      if(result.requiresPasswordChange){
        show('Administrator verified. Create your new password to continue.','success');
        location.replace('/s/'+encodeURIComponent(result.school&&result.school.id||schoolId)+'/change-password');
        return
      }
      show('Welcome '+(result.user&&result.user.firstName?result.user.firstName:'')+'. Opening Admin workspace...','success');
      location.replace(schoolWorkspacePath(result.redirectTo||'/',result.school&&result.school.id||schoolId))
    }catch(err){
      show(err.message||'Administrator sign in failed');btn.disabled=false;btn.textContent=old
    }
  }
  async function initialize(){if(await loadSchool()){if(administratorId)await loadAdministrator()}}
  initialize();
  E('retrySignIn').onclick=initialize;
  E('signin').onclick=signIn;
  E('email').onkeydown=function(e){if(e.key==='Enter')E('password').focus()};
  E('password').onkeydown=function(e){if(e.key==='Enter')signIn()};
})();
</script>
</body>
</html>`,'login');

export const passwordChangeFrontend=applySchoolDesign(`<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Revolt-X School • Change Password</title>
<style>${sharedStyles}</style>
</head>
<body>
<main class="shell">
  <section class="brand">
    <div>
      <div class="mark">REVOLT-X SCHOOL</div>
      <h1>Create your personal password.</h1>
      <p>Your temporary password is only for first access. Set a new password before entering your assigned workspace.</p>
    </div>
    <div class="brand-card"><b>Secure first login</b><p style="margin:8px 0 0">Use at least 12 characters with an uppercase letter, lowercase letter and number.</p></div>
  </section>
  <section class="form-side">
    <div class="form-wrap">
      <div class="eyebrow">Password change required</div>
      <h2>Choose a new password</h2>
      <p class="muted">This will replace the temporary password supplied by your administrator.</p>

      <label for="newPassword">New password</label>
      <input id="newPassword" type="password" autocomplete="new-password">

      <label for="confirmPassword">Confirm new password</label>
      <input id="confirmPassword" type="password" autocomplete="new-password">

      <button id="save" type="button">Save new password</button>
      <div id="status"></div>
      <div class="help">School administrators sign in again with the new password. Staff continue to their assigned workspace.</div>
    </div>
  </section>
</main>
<script>
${schoolSessionScript('staff')}
(function(){
  function E(id){return document.getElementById(id)}
  function enablePasswordVisibility(){document.querySelectorAll('input[type=\"password\"]').forEach(function(input){if(input.dataset.visibilityReady)return;input.dataset.visibilityReady='1';var label=document.createElement('label');label.className='password-visibility';var check=document.createElement('input');check.type='checkbox';check.onchange=function(){input.type=check.checked?'text':'password'};label.appendChild(check);label.appendChild(document.createTextNode('Show password'));input.insertAdjacentElement('afterend',label)})}
  enablePasswordVisibility();
  function show(message,type){var box=E('status');box.className='status '+(type||'error');box.textContent=message}
  async function save(){
    var p1=E('newPassword').value,p2=E('confirmPassword').value;
    if(p1.length<12){show('Use at least 12 characters.');return}
    if(p1.length>128){show('Use no more than 128 characters.');return}
    if(p1!==p2){show('The passwords do not match.');return}
    var b=E('save'),old=b.textContent;b.disabled=true;b.textContent='Updating password...';
    try{
      var r=await fetch('/api/auth/change-password',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({newPassword:p1})});
      var j=await r.json().catch(function(){return null});
      if(!r.ok)throw new Error(j&&j.error&&j.error.message?j.error.message:'Could not change password');
      if(j.requiresSignIn){
        try{sessionStorage.removeItem('rx_school_token');sessionStorage.removeItem('rx_teacher_token');if(j.schoolId)localStorage.setItem('rx_school_id',j.schoolId)}catch(e){}
        show('Password changed. Sign in with your new password.','success');location.replace(j.redirectTo||'/admin-login');return
      }
      show('Password changed. Opening your workspace...','success');
      location.replace(schoolWorkspacePath(j.redirectTo||'/',schoolFromLocation()))
    }catch(err){show(err.message||'Could not change password');b.disabled=false;b.textContent=old}
  }
  E('save').onclick=save;
  E('confirmPassword').onkeydown=function(e){if(e.key==='Enter')save()}
})();
</script>
</body>
</html>`,'login');


export const adminPasswordResetFrontend=applySchoolDesign(`<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Revolt-X School • Reset Administrator Password</title>
<style>${sharedStyles}</style>
</head>
<body>
<main class="shell">
  <section class="brand">
    <div>
      <div class="mark">REVOLT-X SCHOOL</div>
      <h1>Reset your administrator password.</h1>
      <p>This secure link was generated from Revolt-X OS for the organisation administrator recorded against your school licence.</p>
    </div>
    <div class="brand-card">
      <b>Create a new password</b>
      <p style="margin:8px 0 0">Use at least 12 characters with an uppercase letter, lowercase letter and number.</p>
    </div>
  </section>
  <section class="form-side">
    <div class="form-wrap">
      <div class="eyebrow">Administrator password reset</div>
      <h2>Enter a new password</h2>
      <p class="muted">This secure link is single-use and expires automatically. Enter and confirm your new administrator password below.</p>

      <label for="newPassword">New password</label>
      <input id="newPassword" type="password" autocomplete="new-password">

      <label for="confirmPassword">Confirm new password</label>
      <input id="confirmPassword" type="password" autocomplete="new-password">

      <button id="save" type="button">Save new password</button>
      <div id="status"></div>
      <div class="switch"><a id="backLogin" href="/admin-login">Back to Admin Login</a></div>
    </div>
  </section>
</main>
<script>
(function(){
  function E(id){return document.getElementById(id)}
  function enablePasswordVisibility(){document.querySelectorAll('input[type=\"password\"]').forEach(function(input){if(input.dataset.visibilityReady)return;input.dataset.visibilityReady='1';var label=document.createElement('label');label.className='password-visibility';var check=document.createElement('input');check.type='checkbox';check.onchange=function(){input.type=check.checked?'text':'password'};label.appendChild(check);label.appendChild(document.createTextNode('Show password'));input.insertAdjacentElement('afterend',label)})}
  enablePasswordVisibility();
  function show(message,type){var box=E('status');box.className='status '+(type||'error');box.textContent=message}
  ${schoolLocationScript}
  var q=new URLSearchParams(location.search),token=q.get('token')||'',school=schoolFromLocation();
  E('backLogin').href=school?'/s/'+encodeURIComponent(school)+'/admin-login':'/admin-login';
  if(!/^[A-Za-z0-9_-]{32,500}$/.test(token)){token='';E('save').disabled=true;show('This password reset link is incomplete or invalid. Generate a new reset link from Revolt-X OS Commercial Control.');}

  async function save(){
    if(E('save').disabled)return;
    var p1=E('newPassword').value,p2=E('confirmPassword').value;
    if(!token){show('This password reset link is incomplete. Generate a new reset link.');return}
    if(p1.length<12||!/[A-Z]/.test(p1)||!/[a-z]/.test(p1)||!/[0-9]/.test(p1)){show('Use at least 12 characters with uppercase, lowercase and a number.');return}
    if(p1.length>128){show('Use no more than 128 characters.');return}
    if(p1!==p2){show('The passwords do not match.');return}
    var b=E('save'),old=b.textContent;b.disabled=true;b.textContent='Saving new password...';
    try{
      var body={token:token,newPassword:p1};if(school)body.schoolId=school;
      var r=await fetch('/api/auth/admin-password-reset',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(body)});
      var j=await r.json().catch(function(){return null});
      if(!r.ok)throw new Error(j&&j.error&&j.error.message?j.error.message:'Could not reset password');
      try{sessionStorage.removeItem('rx_school_token');sessionStorage.removeItem('rx_teacher_token');if(j.schoolId)localStorage.setItem('rx_school_id',j.schoolId)}catch(e){}
      try{history.replaceState(null,'',location.pathname)}catch(e){}
      show('Password changed successfully. Opening School Admin Login...','success');
      setTimeout(function(){location.replace(j.adminLoginUrl||(school?'/s/'+encodeURIComponent(school)+'/admin-login':'/admin-login'))},700)
    }catch(err){show(err.message||'Could not reset password');b.disabled=false;b.textContent=old}
  }
  E('save').onclick=save;
  E('confirmPassword').onkeydown=function(e){if(e.key==='Enter')save()}
})();
</script>
</body>
</html>`,'login');

