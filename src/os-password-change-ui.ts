export const osPasswordChangeFrontend=String.raw`<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Choose your password | Revolt-X OS</title><style>
*{box-sizing:border-box}body{margin:0;min-height:100vh;display:grid;place-items:center;padding:24px;background:#071b31;font:16px Arial,sans-serif;color:#172536}
main{width:min(460px,100%);padding:32px;background:white;border-radius:20px}h1{font-size:26px}p{line-height:1.5;color:#52677b}label{display:block;margin:16px 0 6px;font-weight:bold;font-size:14px}input{width:100%;padding:12px;border:1px solid #bdccda;border-radius:8px;font:inherit}.show{display:flex;gap:8px;align-items:center}.show input{width:auto}button{width:100%;padding:13px;margin-top:18px;border:0;border-radius:8px;background:#1f63db;color:white;font:inherit;font-weight:bold;cursor:pointer}button:disabled{opacity:.6}.error{color:#a62934}a{color:#1f63db}
</style></head><body><main><h1>Choose your own password</h1><p>Your administrator gave you a temporary password. Choose a new password before opening your workspace.</p><p id="account"></p>
<form id="passwordForm"><label for="currentPassword">Temporary or current password *</label><input id="currentPassword" type="password" autocomplete="current-password" required maxlength="128">
<label for="newPassword">New password *</label><input id="newPassword" type="password" autocomplete="new-password" required minlength="12" maxlength="128">
<label for="confirmPassword">Confirm new password *</label><input id="confirmPassword" type="password" autocomplete="new-password" required minlength="12" maxlength="128">
<p>Use at least 12 characters, including uppercase, lowercase and a number.</p><label class="show"><input id="showPasswords" type="checkbox">Show passwords</label>
<p id="message" role="status" aria-live="polite"></p><button id="savePassword" type="submit">Save my password</button></form><button id="signOut" type="button">Back to sign in</button></main>
<script>(function(){
var E=function(id){return document.getElementById(id)},token=sessionStorage.getItem('rx_access')||'';
function clear(){['rx_access','rx_refresh','rx_os_session_expires_at'].forEach(function(key){sessionStorage.removeItem(key)})}
function signIn(expired){clear();location.replace('/login'+(expired?'?expired=1':''))}
if(!token){signIn(false);return}
fetch('/v1/auth/context',{headers:{authorization:'Bearer '+token},cache:'no-store'}).then(async function(r){if(r.status===401){signIn(true);return}if(!r.ok)throw Error('Your account could not be loaded. Please try again.');var x=await r.json();E('account').textContent=x.email||''}).catch(function(e){E('message').textContent=e.message;E('message').className='error'});
E('showPasswords').onchange=function(){['currentPassword','newPassword','confirmPassword'].forEach(function(id){E(id).type=E('showPasswords').checked?'text':'password'})};
E('signOut').onclick=async function(){try{await fetch('/v1/auth/logout',{method:'POST',headers:{authorization:'Bearer '+token}})}finally{signIn(false)}};
E('passwordForm').onsubmit=async function(event){event.preventDefault();var current=E('currentPassword').value,password=E('newPassword').value,button=E('savePassword');
E('message').className='error';if(password.length<12||!/[a-z]/.test(password)||!/[A-Z]/.test(password)||!/[0-9]/.test(password)){E('message').textContent='Use at least 12 characters, including uppercase, lowercase and a number.';return}
if(password!==E('confirmPassword').value){E('message').textContent='The new passwords do not match.';return}
if(password===current){E('message').textContent='Choose a password different from your temporary or current password.';return}
button.disabled=true;try{var r=await fetch('/v1/auth/change-password',{method:'POST',headers:{authorization:'Bearer '+token,'content-type':'application/json'},body:JSON.stringify({currentPassword:current,newPassword:password})});var x=await r.json().catch(function(){return{}});if(r.status===401){signIn(true);return}if(!r.ok)throw Error(x.error&&x.error.message||'Your password could not be changed. Please try again.');clear();location.replace('/login?passwordChanged=1')}catch(e){E('message').textContent=e.message}finally{button.disabled=false}};
})();</script></body></html>`;
