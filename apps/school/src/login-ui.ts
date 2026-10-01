import { applySchoolDesign } from './school-design.js';

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
.help{margin-top:20px;padding:14px;border:1px solid #dbe5eb;border-radius:12px;background:#f7fafb;color:#617583;font-size:13px;line-height:1.55}
@media(max-width:760px){body{padding:0}.shell{grid-template-columns:1fr;border-radius:0;min-height:100vh}.brand{min-height:auto;padding:32px}.brand-card{display:none}.form-side{padding:34px 28px}.brand h1{font-size:30px}}
`;

export const loginFrontend=applySchoolDesign(`<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Revolt-X School • Staff Login</title>
<style>${sharedStyles}</style>
</head>
<body>
<main class="shell">
  <section class="brand">
    <div>
      <div class="mark">REVOLT-X SCHOOL</div>
      <h1>Welcome back to your school workspace.</h1>
      <p>Select your school, enter the Staff ID assigned to you and use the password provided by your administrator.</p>
    </div>
    <div class="brand-card">
      <b>School + Staff ID + Password</b>
      <p style="margin:8px 0 0">Staff IDs are generated inside each school. They do not need the school name or school code added to them.</p>
    </div>
  </section>
  <section class="form-side">
    <div class="form-wrap">
      <div class="eyebrow">Staff access</div>
      <h2>Sign in to your school</h2>
      <p class="muted">Choose your school, then enter your Staff ID and password.</p>

      <label for="schoolId">School</label>
      <select id="schoolId"><option value="">Loading schools...</option></select>

      <label for="staffId">Staff ID</label>
      <input id="staffId" autocomplete="username" placeholder="e.g. STF-000001">

      <label for="password">Password</label>
      <input id="password" type="password" autocomplete="current-password" placeholder="Enter your password">

      <button id="signin" type="button">Sign in</button>
      <div id="status"></div>

      <div class="help"><b>First sign-in:</b> use the temporary password given by your administrator. You will be asked to create your own password before your workspace opens.</div>
    </div>
  </section>
</main>
<script>
(function(){
  function E(id){return document.getElementById(id)}
  function show(message,type){var box=E('status');box.className='status '+(type||'error');box.textContent=message}
  async function json(url,options){
    var res=await fetch(url,Object.assign({headers:{'content-type':'application/json'}},options||{}));
    var body=await res.json().catch(function(){return null});
    if(!res.ok){var err=new Error(body&&body.error&&body.error.message?body.error.message:'Request failed');err.status=res.status;throw err}
    return body
  }
  async function loadSchools(){
    var select=E('schoolId'),requested=new URLSearchParams(location.search).get('school')||'',saved='';
    try{saved=localStorage.getItem('rx_school_id')||''}catch(e){}
    try{
      var schools=await json('/api/auth/schools');
      select.innerHTML='<option value="">Select your school</option>'+schools.map(function(s){return '<option value="'+String(s.id).replace(/"/g,'&quot;')+'">'+String(s.name).replace(/[&<>"]/g,function(c){return{'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[c]})+'</option>'}).join('');
      var preferred=requested||saved;
      if(preferred&&schools.some(function(s){return s.id===preferred}))select.value=preferred;
    }catch(err){
      select.innerHTML='<option value="">Schools unavailable</option>';
      show(err.message||'Could not load schools')
    }
  }
  async function signIn(){
    var schoolId=E('schoolId').value,staffId=E('staffId').value.trim(),password=E('password').value;
    if(!schoolId){show('Select your school.');E('schoolId').focus();return}
    if(!staffId){show('Enter your Staff ID.');E('staffId').focus();return}
    if(!password){show('Enter your password.');E('password').focus();return}
    var btn=E('signin'),old=btn.textContent;btn.disabled=true;btn.textContent='Signing in...';E('status').className='';E('status').textContent='';
    try{
      var result=await json('/api/auth/staff-id-login',{method:'POST',body:JSON.stringify({schoolId:schoolId,staffId:staffId,password:password})});
      try{
        sessionStorage.setItem('rx_school_token',result.accessToken);
        if(result.redirectTo==='/teacher')sessionStorage.setItem('rx_teacher_token',result.accessToken);else sessionStorage.removeItem('rx_teacher_token');
        localStorage.setItem('rx_school_id',result.school&&result.school.id?result.school.id:schoolId)
      }catch(e){}
      if(result.requiresPasswordChange){
        show('Sign-in successful. Create your new password to continue.','success');
        location.replace(result.passwordChangeUrl||'/change-password');
        return
      }
      show('Welcome '+(result.user&&result.user.firstName?result.user.firstName:'')+'. Opening your workspace...','success');
      location.replace(result.redirectTo||'/')
    }catch(err){
      show(err.message||'Sign in failed');btn.disabled=false;btn.textContent=old
    }
  }
  loadSchools();
  E('signin').onclick=signIn;
  E('staffId').onkeydown=function(e){if(e.key==='Enter')E('password').focus()};
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

      <button id="save" type="button">Change password and continue</button>
      <div id="status"></div>
      <div class="help">After the password is changed, your assigned staff workspace will open automatically.</div>
    </div>
  </section>
</main>
<script>
(function(){
  function E(id){return document.getElementById(id)}
  function show(message,type){var box=E('status');box.className='status '+(type||'error');box.textContent=message}
  async function save(){
    var p1=E('newPassword').value,p2=E('confirmPassword').value;
    if(p1.length<12){show('Use at least 12 characters.');return}
    if(p1!==p2){show('The passwords do not match.');return}
    var b=E('save'),old=b.textContent;b.disabled=true;b.textContent='Updating password...';
    try{
      var r=await fetch('/api/auth/change-password',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({newPassword:p1})});
      var j=await r.json().catch(function(){return null});
      if(!r.ok)throw new Error(j&&j.error&&j.error.message?j.error.message:'Could not change password');
      show('Password changed. Opening your workspace...','success');
      location.replace(j.redirectTo||'/')
    }catch(err){show(err.message||'Could not change password');b.disabled=false;b.textContent=old}
  }
  E('save').onclick=save;
  E('confirmPassword').onkeydown=function(e){if(e.key==='Enter')save()}
})();
</script>
</body>
</html>`,'login');
