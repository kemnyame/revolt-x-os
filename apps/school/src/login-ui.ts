import { applySchoolDesign } from './school-design.js';

export const loginFrontend=applySchoolDesign(`<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Revolt-X School • Staff Login</title>
<style>
:root{font-family:Inter,system-ui,-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;color:#172334;background:#eef3f7}
*{box-sizing:border-box}
body{margin:0;min-height:100vh;background:linear-gradient(135deg,#eef4f7 0%,#f8fbfc 55%,#edf2f5 100%);display:flex;align-items:center;justify-content:center;padding:24px}
.shell{width:min(980px,100%);display:grid;grid-template-columns:1.05fr .95fr;background:#fff;border:1px solid #dbe5eb;border-radius:24px;overflow:hidden;box-shadow:0 24px 70px rgba(32,59,78,.14)}
.brand{padding:54px;background:linear-gradient(150deg,#17324a,#315466);color:#fff;display:flex;flex-direction:column;justify-content:space-between;min-height:580px}
.brand h1{font-size:38px;line-height:1.05;margin:14px 0 16px}
.brand p{color:#d9e7ee;font-size:16px;line-height:1.65;max-width:430px}
.mark{font-weight:800;letter-spacing:.08em;font-size:14px}
.brand-card{border:1px solid rgba(255,255,255,.18);background:rgba(255,255,255,.08);border-radius:16px;padding:18px}
.form-side{padding:54px 46px;display:flex;align-items:center}
.form-wrap{width:100%;max-width:390px;margin:auto}
.eyebrow{text-transform:uppercase;letter-spacing:.12em;font-weight:800;font-size:12px;color:#527188}
h2{font-size:30px;margin:8px 0 8px;color:#172334}
.muted{color:#667b8b;line-height:1.55}
label{display:block;font-weight:700;font-size:13px;margin:20px 0 7px;color:#294254}
input{width:100%;border:1px solid #cdd9e0;border-radius:12px;padding:13px 14px;font-size:16px;outline:none;background:#fbfdfe}
input:focus{border-color:#315466;box-shadow:0 0 0 3px rgba(49,84,102,.12)}
button{width:100%;margin-top:22px;border:0;border-radius:12px;background:#315466;color:#fff;font-size:15px;font-weight:800;padding:13px 16px;cursor:pointer}
button:disabled{opacity:.6;cursor:wait}
.status{margin-top:14px;border-radius:10px;padding:11px 12px;font-size:14px}
.error{background:#fff1f0;color:#a22c22;border:1px solid #ffd2cf}
.success{background:#edf8f1;color:#23623d;border:1px solid #ccebd7}
.help{margin-top:20px;padding:14px;border:1px solid #dbe5eb;border-radius:12px;background:#f7fafb;color:#617583;font-size:13px;line-height:1.55}
code{font-family:ui-monospace,SFMono-Regular,Menlo,monospace}
@media(max-width:760px){body{padding:0}.shell{grid-template-columns:1fr;border-radius:0;min-height:100vh}.brand{min-height:auto;padding:32px}.brand-card{display:none}.form-side{padding:34px 28px}.brand h1{font-size:30px}}
</style>
</head>
<body>
<main class="shell">
  <section class="brand">
    <div>
      <div class="mark">REVOLT-X SCHOOL</div>
      <h1>One login for every school staff profile.</h1>
      <p>Revolt-X School now uses the School ID and the automatically assigned Staff ID. Email addresses and passwords are not used for staff sign-in.</p>
    </div>
    <div class="brand-card">
      <b>How it works</b>
      <p style="margin:8px 0 0">Your School ID identifies the tenant. Your Staff ID identifies your profile inside that school and opens the workspace assigned to your role.</p>
    </div>
  </section>
  <section class="form-side">
    <div class="form-wrap">
      <div class="eyebrow">Staff access</div>
      <h2>Sign in to your school</h2>
      <p class="muted">Enter the School ID and Staff ID provided by your school administrator.</p>

      <label for="schoolId">School ID</label>
      <input id="schoolId" autocomplete="organization" placeholder="e.g. kem-company">

      <label for="staffId">Staff ID</label>
      <input id="staffId" autocomplete="username" placeholder="e.g. STF-000001">

      <button id="signin" type="button">Sign in to Revolt-X School</button>
      <div id="status"></div>

      <div class="help"><b>Staff ID is automatic.</b> A Staff ID is created when a user is added. Existing staff keep their current Staff ID. The School ID is the school's unique tenant code.</div>
    </div>
  </section>
</main>
<script>
(function(){
  function E(id){return document.getElementById(id)}
  function show(message,type){
    var box=E('status');
    box.className='status '+(type||'error');
    box.textContent=message;
  }
  async function json(url,options){
    var res=await fetch(url,Object.assign({headers:{'content-type':'application/json'}},options||{}));
    var body=await res.json().catch(function(){return null});
    if(!res.ok){
      var err=new Error(body&&body.error&&body.error.message?body.error.message:'Sign in failed');
      err.status=res.status;
      throw err;
    }
    return body;
  }
  async function signIn(){
    var schoolId=E('schoolId').value.trim();
    var staffId=E('staffId').value.trim();
    if(!schoolId){show('Enter your School ID.');E('schoolId').focus();return}
    if(!staffId){show('Enter your Staff ID.');E('staffId').focus();return}
    var btn=E('signin'),old=btn.textContent;
    btn.disabled=true;btn.textContent='Signing in...';E('status').className='';E('status').textContent='';
    try{
      var result=await json('/api/auth/staff-id-login',{
        method:'POST',
        body:JSON.stringify({schoolId:schoolId,staffId:staffId})
      });
      try{
        sessionStorage.setItem('rx_school_token',result.accessToken);
        if(result.redirectTo==='/teacher')sessionStorage.setItem('rx_teacher_token',result.accessToken);
        else sessionStorage.removeItem('rx_teacher_token');
        localStorage.setItem('rx_school_id',result.school&&result.school.id?result.school.id:schoolId);
      }catch(e){}
      show('Welcome '+(result.user&&result.user.firstName?result.user.firstName:'')+'. Opening your workspace...','success');
      location.replace(result.redirectTo||'/');
    }catch(err){
      show(err.message||'Sign in failed');
      btn.disabled=false;btn.textContent=old;
    }
  }
  var params=new URLSearchParams(location.search);
  var school=params.get('school')||'';
  try{if(!school)school=localStorage.getItem('rx_school_id')||''}catch(e){}
  E('schoolId').value=school;
  E('signin').onclick=signIn;
  E('schoolId').onkeydown=function(e){if(e.key==='Enter')E('staffId').focus()};
  E('staffId').onkeydown=function(e){if(e.key==='Enter')signIn()};
})();
</script>
</body>
</html>`, 'login');
