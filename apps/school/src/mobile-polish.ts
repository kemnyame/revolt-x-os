export const mobilePolishCss=String.raw`
/* Native-feeling launch, touch and state polish shared by the dedicated phone app. */
.rx-app-launch{position:fixed;inset:0;z-index:9999;display:grid;place-items:center;background:radial-gradient(circle at 50% 30%,#f8fbf8 0,#edf4ef 46%,#e5eee8 100%);transition:opacity .28s ease,visibility .28s ease}.rx-app-launch.out{opacity:0;visibility:hidden}.rx-launch-inner{text-align:center;padding:34px}.rx-launch-logo{width:78px;height:78px;border-radius:24px;box-shadow:0 18px 45px #173b3326;animation:rxLaunchFloat 1.6s ease-in-out infinite}.rx-launch-title{margin:20px 0 4px;font-size:20px;font-weight:800;letter-spacing:-.03em;color:#18362a}.rx-launch-copy{margin:0;color:#748379;font-size:12px}.rx-launch-dots{display:flex;justify-content:center;gap:6px;margin-top:20px}.rx-launch-dots i{width:7px;height:7px;border-radius:50%;background:#24634e;animation:rxLaunchDot 1s ease-in-out infinite}.rx-launch-dots i:nth-child(2){animation-delay:.14s}.rx-launch-dots i:nth-child(3){animation-delay:.28s}@keyframes rxLaunchFloat{50%{transform:translateY(-5px)}}@keyframes rxLaunchDot{0%,60%,100%{opacity:.25;transform:translateY(0)}30%{opacity:1;transform:translateY(-5px)}}
body[data-mobile-role] .m-card{box-shadow:0 8px 26px #18362a08}body[data-mobile-role] .m-action,body[data-mobile-role] .m-list-button,body[data-mobile-role] .m-btn{transition:transform .12s ease,box-shadow .12s ease,background .12s ease}body[data-mobile-role] .m-action:active,body[data-mobile-role] .m-list-button:active,body[data-mobile-role] .m-btn:active{transform:scale(.985)}body[data-mobile-role=parent] .m-child-card{background:linear-gradient(145deg,#fff8ed,#fdf1df);box-shadow:0 10px 28px #7b5e2710}body[data-mobile-role=parent] .m-hero{background:linear-gradient(145deg,#1f654d,#234f42)}
.rx-phone-auth-note{display:flex;gap:11px;align-items:flex-start;padding:14px 15px;margin:0 0 14px;border:1px solid #d7e7db;border-radius:16px;background:#eff7f1;color:#315c48;font-size:12px}.rx-phone-auth-note b{display:block;color:#234f3d;margin-bottom:2px}.rx-otp-wrap{margin-top:18px;padding-top:18px;border-top:1px solid #e5ebe5}.rx-otp-input{font-size:26px!important;font-weight:800;letter-spacing:.34em;text-align:center;font-variant-numeric:tabular-nums;padding-left:calc(14px + .34em)!important}.rx-auth-actions{display:flex;gap:10px;margin-top:12px}.rx-auth-actions button{margin:0;flex:1}.rx-auth-meta{font-size:11px;color:#748379;margin-top:9px;text-align:center}.rx-admin-reset-target{margin:15px 0 4px;padding:14px 15px;border-radius:12px;background:#edf8f1;border:1px solid #ccebd7;color:#245d3c;font-size:13px}.rx-admin-reset-target b{display:block;font-size:14px;margin-bottom:2px}.rx-status-success{background:#e9f4ed!important;color:#2a6d48!important;border-color:#cfe3d5!important}.rx-status-pending{background:#fff1d9!important;color:#885d19!important;border-color:#edd8ae!important}.rx-status-closed{background:#eff1f4!important;color:#606c7a!important;border-color:#dde1e6!important}.rx-status-attention{background:#fdebed!important;color:#ac3a4f!important;border-color:#efccd3!important}.rx-status-info{background:#e8f1fc!important;color:#33649a!important;border-color:#d2e1f1!important}
@media(prefers-reduced-motion:reduce){.rx-launch-logo,.rx-launch-dots i{animation:none}.rx-app-launch,.m-action,.m-list-button,.m-btn{transition:none!important}}
`;

export const mobilePolishScript=String.raw`
(function(){
'use strict';
function esc(v){return String(v==null?'':v).replace(/[&<>"']/g,function(c){return{'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]})}
function json(url,options){return fetch(url,options).then(async function(response){var body=await response.json().catch(function(){return null});if(!response.ok){var error=new Error(body&&body.error&&body.error.message?body.error.message:(body&&body.message?body.message:'Request failed'));error.status=response.status;throw error}return body})}
function launch(){
 if(!document.body.hasAttribute('data-mobile-role')||document.querySelector('.rx-app-launch'))return;
 var el=document.createElement('div');el.className='rx-app-launch';el.setAttribute('role','status');el.setAttribute('aria-live','polite');el.innerHTML='<div class="rx-launch-inner"><img class="rx-launch-logo" src="/school-icon-192.png" alt=""><div class="rx-launch-title">Revolt School</div><p class="rx-launch-copy">Preparing your school workspace</p><div class="rx-launch-dots" aria-hidden="true"><i></i><i></i><i></i></div></div>';document.body.appendChild(el);
 var started=Date.now(),finish=function(){var delay=Math.max(0,420-(Date.now()-started));setTimeout(function(){el.classList.add('out');setTimeout(function(){el.remove()},320)},delay)};
 if(document.readyState==='complete')finish();else addEventListener('load',finish,{once:true});setTimeout(finish,2600);
}
function statusClass(text){
 var x=String(text||'').trim().toLowerCase().replace(/[\s-]+/g,'_');
 if(/^(success|successful|complete|completed|approved|paid|active|present|published|submitted|graded|taught|released|verified|enrolled)$/.test(x))return'rx-status-success';
 if(/^(pending|draft|requested|processing|open|checking|awaiting|in_review|review)$/.test(x))return'rx-status-pending';
 if(/^(closed|cancelled|canceled|inactive|not_submitted|void|archived|withdrawn|graduated)$/.test(x))return'rx-status-closed';
 if(/^(late|overdue|returned|failed|failure|absent|expired|declined|rejected|suspended|error)$/.test(x))return'rx-status-attention';
 return'rx-status-info';
}
function paintStatuses(root){
 var scope=root&&root.querySelectorAll?root:document;Array.from(scope.querySelectorAll('.badge,.m-pill,[data-status-label]')).forEach(function(el){var text=(el.dataset.statusLabel||el.textContent||'').trim();if(!text)return;el.classList.remove('rx-status-success','rx-status-pending','rx-status-closed','rx-status-attention','rx-status-info');el.classList.add(statusClass(text));el.setAttribute('aria-label','Status: '+text.replaceAll('_',' '))});
}
function schoolFromLocation(){var parts=location.pathname.split('/').filter(Boolean);if(parts[0]==='s'&&parts[1]){try{return decodeURIComponent(parts[1]).trim()}catch(e){return parts[1]}}return(new URLSearchParams(location.search).get('school')||'').trim()}
async function identifyAdminReset(){
 if(!/admin-password-reset/.test(location.pathname))return;
 var q=new URLSearchParams(location.search),admin=(q.get('admin')||'').trim(),school=schoolFromLocation();if(!admin||!school)return;
 try{
  var context=await json('/api/auth/admin-login-context?'+new URLSearchParams({schoolId:school,adminUserId:admin}));
  var form=document.querySelector('.form-wrap');if(!form||form.querySelector('.rx-admin-reset-target'))return;
  var target=document.createElement('div');target.className='rx-admin-reset-target';target.innerHTML='<b>'+esc(context.administrator.name||context.administrator.email)+'</b>'+esc(context.school.name)+' · '+esc(context.administrator.email);var label=form.querySelector('label');if(label)form.insertBefore(target,label);else form.appendChild(target);
  var heading=form.querySelector('h2');if(heading&&context.administrator.name)heading.textContent='Reset '+context.administrator.name+'’s password';
  var copy=form.querySelector('.muted');if(copy)copy.textContent='This secure reset changes only this administrator’s password for '+context.school.name+'. Other school administrators and other schools are not affected.';
  var back=document.getElementById('backLogin');if(back)back.href='/s/'+encodeURIComponent(context.school.id)+'/admin-login?admin='+encodeURIComponent(context.administrator.id);
 }catch(_error){}
}
function parentPhoneAuth(){
 if(document.body.dataset.mobileRole!=='parent')return;
 var scheduled=false;
 function enhance(){
  scheduled=false;var old=document.getElementById('mLoginForm'),school=document.getElementById('mLoginSchool');if(!old||!school||school.disabled||old.dataset.rxPhoneAuthReady)return;
  var selected=school.value,options=school.innerHTML;var form=document.createElement('form');form.id='mLoginForm';form.className='m-form m-card';form.dataset.rxPhoneAuthReady='1';form.innerHTML='<div class="rx-phone-auth-note"><span aria-hidden="true">✓</span><div><b>Secure phone verification</b>We will send a one-time 6-digit code to the mobile number registered with your school.</div></div><label for="mLoginSchool">School <span class="m-required">*</span></label><select id="mLoginSchool" required>'+options+'</select><label for="mLoginPhone">Registered mobile number <span class="m-required">*</span></label><input id="mLoginPhone" type="tel" required autocomplete="tel" inputmode="tel" placeholder="024… or +233…"><label for="mLoginStudent">Student ID <span class="m-required">*</span></label><input id="mLoginStudent" type="text" required autocomplete="off" autocapitalize="characters"><button id="mLoginSubmit" class="m-btn" type="submit">Send verification code</button><div id="rxPhoneAuthMessage" class="m-help" aria-live="polite"></div><div id="rxOtpWrap" class="rx-otp-wrap" hidden><label for="rxOtpCode">6-digit verification code</label><input id="rxOtpCode" class="rx-otp-input" type="text" inputmode="numeric" autocomplete="one-time-code" maxlength="6" pattern="[0-9]{6}" placeholder="000000"><div class="rx-auth-actions"><button id="rxVerifyPhone" class="m-btn" type="button">Verify & sign in</button><button id="rxChangePhone" class="m-btn ghost" type="button">Change details</button></div><div id="rxAuthMeta" class="rx-auth-meta"></div></div>';
  old.replaceWith(form);document.getElementById('mLoginSchool').value=selected;
  var challengeId='',expiresAt=0,locked=false;
  function message(text,bad){var el=document.getElementById('rxPhoneAuthMessage');if(!el)return;el.textContent=text||'';el.style.color=bad?'var(--red)':'var(--muted)'}
  function setIdentityDisabled(value){['mLoginSchool','mLoginPhone','mLoginStudent'].forEach(function(id){var el=document.getElementById(id);if(el)el.disabled=value})}
  form.addEventListener('submit',async function(event){event.preventDefault();if(locked)return;var schoolId=document.getElementById('mLoginSchool').value,phone=document.getElementById('mLoginPhone').value.trim(),student=document.getElementById('mLoginStudent').value.trim();if(!schoolId||!phone||!student){message('Select your school and enter the registered phone number and Student ID.',true);return}var button=document.getElementById('mLoginSubmit');button.disabled=true;button.textContent='Sending code…';message('Verifying your parent account…');
   try{var result=await json('/api/mobile/parent/phone-auth/start',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({schoolSlug:schoolId,phone:phone,studentId:student})});challengeId=result.challengeId;expiresAt=Date.now()+Number(result.expiresInSeconds||300)*1000;locked=true;setIdentityDisabled(true);document.getElementById('rxOtpWrap').hidden=false;document.getElementById('rxOtpCode').focus();document.getElementById('rxAuthMeta').textContent='Code sent to '+result.destination+'. It expires in about 5 minutes.';message('Code sent. Enter it below to sign in securely.');button.hidden=true}
   catch(error){message(error.message||'Could not send the verification code.',true);button.disabled=false;button.textContent='Send verification code'}
  });
  document.getElementById('rxVerifyPhone').addEventListener('click',async function(){if(!challengeId)return;var code=document.getElementById('rxOtpCode').value.trim();if(!/^\d{6}$/.test(code)){message('Enter the 6-digit code sent to your phone.',true);return}var button=this;button.disabled=true;button.textContent='Verifying…';
   try{var result=await json('/api/mobile/parent/phone-auth/verify',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({challengeId:challengeId,code:code})});sessionStorage.setItem('rx_parent_token',result.token);sessionStorage.removeItem('rx_parent_session_expires_at');var schoolId=document.getElementById('mLoginSchool').value;try{localStorage.setItem('rx_school_id',result.schoolSlug||schoolId)}catch(e){}message('Phone verified. Opening your parent app…');location.reload()}
   catch(error){message(error.message||'That code could not be verified.',true);button.disabled=false;button.textContent='Verify & sign in'}
  });
  document.getElementById('rxOtpCode').addEventListener('keydown',function(event){if(event.key==='Enter'){event.preventDefault();document.getElementById('rxVerifyPhone').click()}});
  document.getElementById('rxChangePhone').addEventListener('click',function(){challengeId='';expiresAt=0;locked=false;setIdentityDisabled(false);document.getElementById('rxOtpWrap').hidden=true;document.getElementById('mLoginSubmit').hidden=false;document.getElementById('mLoginSubmit').disabled=false;document.getElementById('mLoginSubmit').textContent='Send verification code';document.getElementById('rxOtpCode').value='';message('Update your details and request a new code.')});
  setInterval(function(){if(!challengeId||!expiresAt)return;var left=Math.max(0,Math.ceil((expiresAt-Date.now())/1000));var meta=document.getElementById('rxAuthMeta');if(meta&&left===0)meta.textContent='This code has expired. Change details and request a new code.'},1000);
 }
 new MutationObserver(function(){if(scheduled)return;scheduled=true;setTimeout(enhance,60)}).observe(document.body,{childList:true,subtree:true,attributes:true,attributeFilter:['disabled']});setTimeout(enhance,120);
}
launch();paintStatuses(document);new MutationObserver(function(records){records.forEach(function(record){record.addedNodes.forEach(function(node){if(node.nodeType===1)paintStatuses(node)})})}).observe(document.body,{childList:true,subtree:true});identifyAdminReset();parentPhoneAuth();
})();
`;
