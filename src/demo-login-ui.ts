export const demoLoginFrontend=String.raw`<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Revolt-X OS Demo</title>
<style>
:root{--navy:#071b31;--navy2:#0d2b4e;--blue:#1f63db;--gold:#f3b942;--bg:#eef3f9;--ink:#172535;--muted:#6f8094;--line:#dbe5ef}
*{box-sizing:border-box}body{margin:0;font-family:Inter,Arial,sans-serif;background:radial-gradient(circle at 15% 20%,#1e5b9e33,transparent 32%),linear-gradient(135deg,#06172b,#0c3157 58%,#153f6a);min-height:100vh;color:white;display:grid;place-items:center;padding:24px}
.shell{width:min(1080px,96vw);display:grid;grid-template-columns:1.05fr .75fr;background:white;border-radius:26px;overflow:hidden;box-shadow:0 40px 120px #0007;min-height:610px}
.hero{background:linear-gradient(150deg,#071b31 0%,#0d3157 62%,#145486 100%);padding:54px;position:relative;overflow:hidden}.hero:after{content:"";position:absolute;width:360px;height:360px;border-radius:50%;background:#f3b94222;right:-130px;bottom:-120px}.brand{font-weight:900;font-size:22px;letter-spacing:.3px}.brand span{display:inline-grid;place-items:center;background:var(--gold);color:var(--navy);width:42px;height:42px;border-radius:12px;margin-right:10px}.hero h1{font-size:46px;line-height:1.03;margin:74px 0 16px;max-width:560px}.hero p{font-size:17px;line-height:1.6;color:#cfe0f0;max-width:520px}.chips{display:flex;gap:9px;flex-wrap:wrap;margin-top:30px}.chip{padding:8px 11px;border:1px solid #ffffff24;background:#ffffff0d;border-radius:999px;font-size:12px;color:#e4eff9}.login{padding:56px 48px;color:var(--ink);display:flex;flex-direction:column;justify-content:center}.login h2{font-size:30px;margin:0 0 7px}.sub{color:var(--muted);line-height:1.5;font-size:14px}.field{display:grid;gap:7px;margin-top:18px}.field label{font-size:12px;font-weight:800;color:#40556d}.field input{padding:13px 14px;border:1px solid var(--line);border-radius:11px;outline:none}.field input:focus{border-color:#7aa8e8;box-shadow:0 0 0 3px #1f63db14}.btn{margin-top:18px;border:0;border-radius:11px;padding:13px 15px;background:var(--blue);color:white;font-weight:850;cursor:pointer}.btn:disabled{opacity:.6}.demo{margin-top:18px;padding:13px;border-radius:12px;background:#f7f9fc;border:1px solid var(--line);font-size:12px;color:#53677d}.demo b{color:var(--ink)}.links{display:flex;justify-content:space-between;margin-top:18px;font-size:12px}.links a{color:var(--blue);text-decoration:none}.error{margin-top:13px;padding:10px 12px;border-radius:10px;background:#fff0f1;color:#a62f39;font-size:12px;display:none}
@media(max-width:780px){.shell{grid-template-columns:1fr}.hero{padding:34px}.hero h1{margin-top:34px;font-size:34px}.login{padding:36px 28px}}
</style>
</head>
<body>
<div class="shell">
<section class="hero">
 <div class="brand"><span>RX</span>REVOLT-X OS</div>
 <h1>Run every school business from one control centre.</h1>
 <p>This demo opens the Revolt-X Technologies workspace for managing customer schools, pricing plans, module licences, usage, invoices and renewals.</p>
 <div class="chips"><span class="chip">Multi-school control</span><span class="chip">Plans & pricing</span><span class="chip">Module licensing</span><span class="chip">Subscription billing</span><span class="chip">Audit ready</span></div>
</section>
<section class="login">
 <div><h2>Demo Sign In</h2><p class="sub">Enter the demo credentials below to explore the OS and the new Customers & Licensing workspace.</p></div>
 <div class="field"><label>Email</label><input id="email" type="email" value="demo@revolt-x.com" autocomplete="username"></div>
 <div class="field"><label>Password</label><input id="password" type="password" value="Demo@2026" autocomplete="current-password"></div>
 <button class="btn" id="login">Enter Revolt-X OS</button>
 <div class="error" id="error"></div>
 <div class="demo"><b>Demo credentials</b><br>Email: demo@revolt-x.com<br>Password: Demo@2026<br><br>This demo uses the OS preview environment and does not expose production passwords.</div>
 <div class="links"><a href="/">Core OS</a><a href="/commercial-control">Customers & Licensing</a></div>
</section>
</div>
<script>
(function(){
var E=function(id){return document.getElementById(id)};
async function login(){
 var b=E("login"),err=E("error");err.style.display="none";
 if(E("email").value.trim().toLowerCase()!=="demo@revolt-x.com"||E("password").value!=="Demo@2026"){err.textContent="Use the demo credentials shown below.";err.style.display="block";return}
 b.disabled=true;b.textContent="Opening workspace...";
 try{
  var r=await fetch("/v1/auth/preview-session",{method:"POST"}),j=await r.json().catch(function(){return{}});
  if(!r.ok)throw Error(j&&j.error&&j.error.message?j.error.message:"Demo access is unavailable");
  sessionStorage.setItem("rx_access",j.accessToken);sessionStorage.setItem("rx_refresh",j.refreshToken||"");
  location.href="/commercial-control?demo=1";
 }catch(e){err.textContent=e.message;err.style.display="block";b.disabled=false;b.textContent="Enter Revolt-X OS"}
}
E("login").onclick=login;E("password").onkeydown=function(e){if(e.key==="Enter")login()};
})();
</script>
</body></html>`;
