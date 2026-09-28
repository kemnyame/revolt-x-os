(function(){
'use strict';

const opsStyle=document.createElement('style');
opsStyle.textContent=`
.ops-banner{display:flex;align-items:center;justify-content:space-between;gap:14px;padding:13px 15px;border:1px solid var(--line);border-radius:14px;background:linear-gradient(135deg,#fff,#f6fbfa);margin:0 0 14px;box-shadow:var(--shadow)}
.ops-banner.warn{border-color:#efc987;background:#fff9ed}.ops-banner.good{border-color:#c7e6d9;background:#f4fbf8}
.ops-banner strong{display:block}.ops-banner small{display:block;color:var(--muted);margin-top:3px}
.ops-role{display:grid;grid-template-columns:minmax(0,1.5fr) minmax(300px,.8fr);gap:14px;margin:14px 0}
.ops-role-main{background:linear-gradient(135deg,#102c35,#174942);color:white;border-radius:20px;padding:22px;min-height:160px}
.ops-role-main .eyebrow{color:#a8d9d1}.ops-role-main h2{margin:7px 0;font-size:28px}.ops-role-main p{color:#c4dbd7;max-width:720px}
.ops-role-actions{display:flex;gap:8px;flex-wrap:wrap;margin-top:16px}.ops-role-side{display:grid;grid-template-columns:1fr 1fr;gap:9px}
.ops-mini{border:1px solid var(--line);background:#fff;border-radius:14px;padding:13px;box-shadow:var(--shadow)}.ops-mini small{color:var(--muted);font-size:10px;font-weight:850;text-transform:uppercase;letter-spacing:.06em}.ops-mini b{display:block;font-size:20px;margin-top:5px}
.ops-bell{position:relative;width:38px;height:38px;border:1px solid var(--line);background:#fff;border-radius:11px;cursor:pointer;font-size:17px}.ops-bell-count{position:absolute;right:-5px;top:-5px;min-width:18px;height:18px;border-radius:999px;background:#d84c4c;color:#fff;font-size:9px;font-weight:900;display:none;place-items:center;padding:0 4px}
.ops-pop{position:fixed;right:22px;top:70px;width:min(390px,calc(100vw - 28px));max-height:70vh;overflow:auto;background:#fff;border:1px solid var(--line);border-radius:16px;box-shadow:0 24px 70px rgba(15,25,35,.2);z-index:120;display:none}.ops-pop.show{display:block}.ops-pop-head{display:flex;justify-content:space-between;align-items:center;padding:13px;border-bottom:1px solid var(--line)}.ops-notice{padding:11px 13px;border-bottom:1px solid #eef1f2;cursor:pointer}.ops-notice.unread{background:#f1faf8}.ops-notice b{display:block}.ops-notice small{color:var(--muted);display:block;margin-top:4px;line-height:1.4}
.ops-report-layout{display:grid;grid-template-columns:290px minmax(0,1fr);gap:14px}.ops-report-list{display:grid;gap:7px;max-height:68vh;overflow:auto}.ops-report-btn{border:1px solid var(--line);background:#fff;border-radius:11px;padding:11px;text-align:left;cursor:pointer}.ops-report-btn.active,.ops-report-btn:hover{border-color:#6fb7ae;background:#eff9f7}.ops-report-btn b{display:block}.ops-report-btn small{display:block;color:var(--muted);margin-top:3px}
.ops-finance-hero{display:grid;grid-template-columns:repeat(4,minmax(0,1fr));gap:10px;margin:14px 0}.ops-fin-card{border:1px solid var(--line);border-radius:15px;background:#fff;padding:14px;box-shadow:var(--shadow)}.ops-fin-card small{display:block;color:var(--muted);font-size:10px;font-weight:850;text-transform:uppercase}.ops-fin-card b{display:block;font-size:22px;margin-top:5px}.ops-fin-card .hint{font-size:10px;color:var(--muted);margin-top:5px}
.ops-gallery{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:13px}.ops-media-card{border:1px solid var(--line);border-radius:16px;background:#fff;overflow:hidden;box-shadow:var(--shadow)}.ops-media-preview{height:220px;background:#0f1820;display:grid;place-items:center;overflow:hidden}.ops-media-preview img,.ops-media-preview video{width:100%;height:100%;object-fit:cover}.ops-media-body{padding:13px}.ops-media-body h4{margin:0 0 5px}.ops-media-body p{margin:0;color:var(--muted);font-size:12px;line-height:1.45}.ops-media-actions{display:flex;gap:7px;flex-wrap:wrap;margin-top:11px}
.ops-request-grid{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:12px}.ops-request{border:1px solid var(--line);border-radius:16px;background:#fff;padding:14px;display:grid;grid-template-columns:150px minmax(0,1fr);gap:13px}.ops-request-media{height:150px;border-radius:12px;background:#edf1f2;overflow:hidden;display:grid;place-items:center}.ops-request-media img,.ops-request-media video{width:100%;height:100%;object-fit:cover}.ops-request h3{margin:0 0 5px}.ops-request p{margin:4px 0;color:var(--muted);font-size:12px}
.ops-session-status{display:grid;grid-template-columns:repeat(4,1fr);gap:10px;margin-bottom:14px}.ops-session-status .card{box-shadow:none}
.ops-edit-grid{display:grid;grid-template-columns:1fr 1fr;gap:10px}
.ops-image-large{width:100%;max-height:430px;object-fit:contain;border-radius:16px;background:#0c1117}.ops-latest-booking{display:grid;grid-template-columns:minmax(280px,420px) minmax(0,1fr);gap:16px;align-items:stretch;margin:14px 0}.ops-latest-booking-media{min-height:300px;border-radius:18px;background:#0d151a;overflow:hidden;display:grid;place-items:center}.ops-latest-booking-media img,.ops-latest-booking-media video{width:100%;height:100%;max-height:380px;object-fit:cover}.ops-latest-booking-info{padding:8px 2px}.ops-latest-booking-info h2{margin:5px 0 9px}.ops-latest-booking-info p{color:var(--muted);line-height:1.5}
.ops-error-detail{font-size:11px;color:#7a3030;margin-top:4px}
@media(max-width:1100px){.ops-role,.ops-report-layout{grid-template-columns:1fr}.ops-gallery{grid-template-columns:repeat(2,1fr)}.ops-finance-hero{grid-template-columns:repeat(2,1fr)}}
@media(max-width:720px){.ops-latest-booking{grid-template-columns:1fr}.ops-role-side,.ops-finance-hero,.ops-gallery,.ops-request-grid,.ops-session-status,.ops-edit-grid{grid-template-columns:1fr}.ops-request{grid-template-columns:1fr}.ops-request-media{height:230px}}
`;
document.head.appendChild(opsStyle);

function injectOpsNav(groupTitle,page,label,icon){
  const groups=[...document.querySelectorAll('.group')];
  const group=groups.find(g=>g.querySelector('.group-title')?.textContent?.trim()===groupTitle);
  if(!group||group.querySelector('[data-page="'+page+'"]'))return;
  const b=document.createElement('button');
  b.className='navbtn';b.dataset.page=page;b.innerHTML='<span class="ico">'+icon+'</span>'+label;
  b.onclick=()=>showPage(page);
  group.appendChild(b);
}
injectOpsNav('Salon','requests','Booking Requests','●');
injectOpsNav('Salon','gallery','Style Gallery','▣');
injectOpsNav('Salon','leave','Leave & Relief','L');
injectOpsNav('Commerce','cashiers','Cashier Sessions','₵');

const contentRoot=document.querySelector('.content');
contentRoot?.insertAdjacentHTML('beforeend',`
<section class="page" id="requests"><div class="page-head"><div><h1>Booking Requests</h1><p>Public and customer portal appointments, including the style reference selected by the customer.</p></div><button class="btn" onclick="loadExternalRequests()">Refresh</button></div><div id="externalRequestList" class="ops-request-grid"></div></section>
<section class="page" id="gallery"><div class="page-head"><div><h1>Style Gallery</h1><p>Publish haircut photos and videos that customers can choose when booking.</p></div><button class="btn primary" onclick="openMediaModal()">+ Add media</button></div><div id="galleryAdminGrid" class="ops-gallery"></div></section>
<section class="page" id="leave"><div class="page-head"><div><h1>Leave & Relief</h1><p>Staff leave requests, relief arrangements and approval workflow.</p></div><button class="btn primary" onclick="openLeaveModal()">+ Leave request</button></div><div class="card"><div id="leaveTable"></div></div></section>
<section class="page" id="cashiers"><div class="page-head"><div><h1>Cashier Sessions</h1><p>Start work, hand over the cash position to another cashier, and close the business day with a controlled cash count.</p></div><div class="toolbar"><button class="btn" onclick="loadCashierWorkspace()">Refresh</button><button class="btn primary" id="cashierPrimaryAction">Start session</button></div></div><div id="cashierCurrent"></div><div class="card"><div class="card-head"><div><h3>Session history</h3><small>Cash drawer accountability and handovers</small></div></div><div id="cashierHistory"></div></div></section>
`);

document.body.insertAdjacentHTML('beforeend',`
<div class="modal-backdrop" id="cashierStartModal"><div class="modal"><div class="modal-head"><h3>Start cashier session</h3><button class="xbtn" id="cashierStartClose" onclick="closeModal('cashierStartModal')">×</button></div><div class="notice">Start the session before receiving payments, creating sales or processing customer transactions. If another cashier handed over the business day, their closing cash becomes your opening cash automatically.</div><form id="cashierStartForm" class="form-grid" style="margin-top:12px"><div class="field"><label>Opening cash (GHS)</label><input id="cashierOpeningCash" type="number" min="0" step="0.01" value="0" required></div><div class="field wide"><label>Opening note</label><textarea id="cashierStartNote" placeholder="Optional note about the cash drawer"></textarea></div><div class="field wide"><button class="btn primary" style="width:100%">Start work session</button></div></form><div id="cashierStartMessage" class="msg"></div></div></div>
<div class="modal-backdrop" id="cashierEndModal"><div class="modal"><div class="modal-head"><h3>End cashier session</h3><button class="xbtn" onclick="closeModal('cashierEndModal')">×</button></div><form id="cashierEndForm" class="form-grid"><input type="hidden" id="cashierEndSessionId"><div class="field"><label>Close type</label><select id="cashierEndMode"><option value="handover">Hand over to another cashier</option><option value="shift_end">End my shift, keep day open</option><option value="end_day">Close business day</option></select></div><div class="field"><label>Physical cash counted (GHS)</label><input id="cashierActualCash" type="number" min="0" step="0.01" required></div><div class="field wide" id="cashierHandoverWrap"><label>Hand over to</label><select id="cashierHandoverUser"><option value="">Next cashier will start later</option></select></div><div class="field wide"><label>Handover / closing note</label><textarea id="cashierEndNote"></textarea></div><div class="field wide"><div class="notice" id="cashierEndNotice">The system will calculate expected cash and variance from the recorded transactions.</div></div><div class="field wide"><button class="btn primary" style="width:100%">Complete cashier close</button></div></form></div></div>
<div class="modal-backdrop" id="customerEditModal"><div class="modal"><div class="modal-head"><h3>Edit customer</h3><button class="xbtn" onclick="closeModal('customerEditModal')">×</button></div><form id="customerEditForm" class="form-grid"><input type="hidden" id="customerEditId"><div class="field wide"><label>Customer name</label><input id="customerEditName" required></div><div class="field"><label>Phone</label><input id="customerEditPhone"></div><div class="field"><label>Email</label><input id="customerEditEmail" type="email"></div><div class="field"><label>Customer type</label><input id="customerEditType"></div><div class="field"><label>Credit limit</label><input id="customerEditCredit" type="number" min="0" step="0.01"></div><div class="field"><label>Status</label><select id="customerEditStatus"><option value="active">Active</option><option value="inactive">Inactive</option></select></div><div class="field wide"><label>Notes</label><textarea id="customerEditNotes"></textarea></div><div class="field wide"><button class="btn primary" style="width:100%">Save customer changes</button></div></form></div></div>
<div class="modal-backdrop" id="staffEditModal"><div class="modal"><div class="modal-head"><h3>Edit staff member</h3><button class="xbtn" onclick="closeModal('staffEditModal')">×</button></div><form id="staffEditForm" class="form-grid"><input type="hidden" id="staffEditId"><div class="field wide"><label>Full name</label><input id="staffEditName" required></div><div class="field"><label>Phone</label><input id="staffEditPhone"></div><div class="field"><label>Email</label><input id="staffEditEmail" type="email"></div><div class="field"><label>Role</label><select id="staffEditRole"><option value="barber">Barber</option><option value="receptionist">Receptionist</option><option value="cashier">Cashier</option><option value="manager">Manager</option><option value="assistant">Assistant</option></select></div><div class="field"><label>Commission %</label><input id="staffEditCommission" type="number" min="0" max="100" step="0.01"></div><div class="field"><label>Status</label><select id="staffEditStatus"><option value="active">Active</option><option value="inactive">Inactive</option><option value="leave">Leave</option></select></div><div class="field wide"><label>Specialty</label><textarea id="staffEditSpecialty"></textarea></div><div class="field wide"><button class="btn primary" style="width:100%">Save staff changes</button></div></form></div></div>
<div class="modal-backdrop" id="checkinFlowModal"><div class="modal"><div class="modal-head"><div><h3 id="checkinTitle">Customer check-in</h3><small id="checkinCustomer" class="muted"></small></div><button class="xbtn" onclick="closeModal('checkinFlowModal')">×</button></div><div id="checkinReference"></div><form id="checkinFlowForm" class="form-grid" style="margin-top:12px"><input type="hidden" id="checkinAppointmentId"><div class="field"><label>Barber</label><select id="checkinBarber"></select></div><div class="field"><label>Chair</label><select id="checkinChair"></select></div><div class="field wide"><div class="notice">Check in confirms the customer is physically present. Start service only after a barber is ready. Chair assignment is optional if your salon does not track chairs.</div></div><div class="field"><button type="button" class="btn soft" id="checkinOnlyBtn" style="width:100%">Check in only</button></div><div class="field"><button type="submit" class="btn primary" style="width:100%">Check in & start service</button></div></form></div></div>
<div class="modal-backdrop" id="mediaModal"><div class="modal"><div class="modal-head"><h3>Add gallery photo or video</h3><button class="xbtn" onclick="closeModal('mediaModal')">×</button></div><form id="mediaForm" class="form-grid"><div class="field"><label>Title</label><input id="mediaTitle" required></div><div class="field"><label>Category</label><input id="mediaCategory" placeholder="Fade, Beard, Colour..."></div><div class="field"><label>Media type</label><select id="mediaType"><option value="image">Photo</option><option value="video">Video</option></select></div><div class="field"><label>Link to service</label><select id="mediaService"></select></div><div class="field"><label>Link to barber</label><select id="mediaStaff"></select></div><div class="field"><label>Published</label><select id="mediaPublished"><option value="true">Yes</option><option value="false">No</option></select></div><div class="field wide"><label>Upload file</label><input id="mediaFile" type="file" accept="image/*,video/*"><small class="muted">Images up to 8 MB. Videos up to 24 MB.</small></div><div class="field wide"><label>Or external image/video URL</label><input id="mediaExternalUrl" type="url"></div><div class="field wide"><label>Description</label><textarea id="mediaDescription"></textarea></div><div class="field wide"><button class="btn primary" style="width:100%">Publish media</button></div></form></div></div>
<div class="modal-backdrop" id="mediaPreviewModal"><div class="modal" style="width:min(900px,97vw)"><div class="modal-head"><h3 id="mediaPreviewTitle">Style reference</h3><button class="xbtn" onclick="closeModal('mediaPreviewModal')">×</button></div><div id="mediaPreviewBody"></div></div></div>
<div class="modal-backdrop" id="leaveModal"><div class="modal"><div class="modal-head"><h3>New leave request</h3><button class="xbtn" onclick="closeModal('leaveModal')">×</button></div><form id="leaveForm" class="form-grid"><div class="field wide"><label>Staff member</label><select id="leaveStaff"><option value="">My own Shop user account</option></select></div><div class="field"><label>Leave type</label><select id="leaveType"><option>Annual Leave</option><option>Sick Leave</option><option>Emergency Leave</option><option>Compassionate Leave</option><option>Maternity / Paternity Leave</option><option>Other</option></select></div><div class="field"><label>Relief staff</label><select id="leaveRelief"><option value="">No relief assigned yet</option></select></div><div class="field"><label>Start date</label><input id="leaveStart" type="date" required></div><div class="field"><label>End date</label><input id="leaveEnd" type="date" required></div><div class="field wide"><label>Reason</label><textarea id="leaveReason" required></textarea></div><div class="field wide"><label>Relief plan</label><textarea id="leaveReliefNotes" placeholder="Who covers appointments, cash desk, stock or other responsibilities?"></textarea></div><div class="field wide"><button class="btn primary" style="width:100%">Submit leave request</button></div></form></div></div>
`);

const topUser=document.querySelector('.userbox');
if(topUser&&!document.getElementById('opsBell')){
  topUser.insertAdjacentHTML('afterbegin','<button class="ops-bell" id="opsBell" title="Notifications">🔔<span class="ops-bell-count" id="opsBellCount">0</span></button>');
  document.body.insertAdjacentHTML('beforeend','<div class="ops-pop" id="opsNotificationPop"><div class="ops-pop-head"><div><b>Notifications</b><small class="muted">Appointments and operational alerts</small></div><button class="btn sm" id="opsEnableNotifications">Enable sound & desktop alerts</button></div><div id="opsNotificationList"></div></div>');
}

const oldAllowedPages=allowedPages;
allowedPages=function(role){
  const pages=oldAllowedPages(role);
  const caps=new Set(base?.shopCapabilities||[]);
  const all=caps.has('*');
  const add=(page,cap)=>{if(all||caps.has(cap)||(!caps.size&&page==='cashiers'&&role==='cashier'))pages.push(page)};
  add('requests','appointments.manage');add('gallery','media.manage');add('leave','leave.manage');add('cashiers','cashier.session');
  return [...new Set(pages)];
};

let cashierState=null,opsNotifications=[],lastNotificationTime=null,reportCatalog=[],activeReportType='executive_summary',opsGallery=[],externalRequests=[],leaveRows=[],opsAudioContext=null;

const originalApi=api;
api=async function(url,opt={}){
  try{return await originalApi(url,opt)}
  catch(e){
    if(e?.code==='CASHIER_SESSION_REQUIRED'||String(e?.message||'').includes('Start your cashier session')){
      setTimeout(()=>promptCashierSession(),0);
    }
    throw e;
  }
};

function opsMetricLabel(key){
  return {appointments_today:'Appointments today',waiting_now:'Waiting now',new_requests:'New requests',sales_today:'Sales today',payments_today:'Payments today',stock_alerts:'Stock alerts',pending_approvals:'Pending approvals',open_tickets:'Open tickets'}[key]||key.replaceAll('_',' ');
}
function opsMetricValue(key,v){return /sales|payments/.test(key)?money(v):Number(v||0).toLocaleString()}
async function loadLatestBookingReference(){
  if(!selectedShopId)return;
  let host=document.getElementById('opsLatestBookingReference');
  if(!host){host=document.createElement('div');host.id='opsLatestBookingReference';document.getElementById('opsRoleDashboard')?.insertAdjacentElement('afterend',host)}
  try{
    const p=new URLSearchParams({shopId:selectedShopId});if(selectedBranchId)p.set('branchId',selectedBranchId);
    const rows=await originalApi('/api/requests/external?'+p);
    const latest=rows.find(x=>x.inspiration_media_id)||rows[0];
    if(!latest){host.innerHTML='';return}
    const hasMedia=Boolean(latest.inspiration_media_id);
    const preview=hasMedia?(latest.inspiration_media_type==='video'?'<video controls preload="metadata" src="/api/public/media/'+latest.inspiration_media_id+'"></video>':'<img src="/api/public/media/'+latest.inspiration_media_id+'" alt="">'):'<div class="empty">Customer did not select a style reference.</div>';
    host.innerHTML='<div class="card"><div class="card-head"><div><h3>Latest customer booking reference</h3><small>Public and customer portal bookings appear here immediately</small></div>'+(latest.request_seen_at?'':tag('new'))+'</div><div class="ops-latest-booking"><div class="ops-latest-booking-media">'+preview+'</div><div class="ops-latest-booking-info"><div class="eyebrow">'+esc((latest.source||'booking').replaceAll('_',' ').toUpperCase())+'</div><h2>'+esc(latest.customer_name||'Customer')+'</h2><p><b>'+esc(latest.service_name||'Service')+'</b><br>'+new Date(latest.booked_for).toLocaleString()+'<br>'+esc(latest.barber_name||'Any available barber')+'</p>'+(latest.inspiration_title?'<p><b>Chosen look:</b> '+esc(latest.inspiration_title)+'</p>':'')+'<div class="toolbar" style="margin-top:14px"><button class="btn primary" onclick="showPage(\'requests\')">Open booking request</button>'+(hasMedia?'<button class="btn soft" onclick="previewBookingMedia(\''+latest.id+'\')">View style large</button>':'')+'</div></div></div></div>';
    externalRequests=rows;
  }catch{host.innerHTML=''}
}

window.loadRoleDashboard=async function(){
  if(!selectedShopId)return;
  try{
    const p=new URLSearchParams({shopId:selectedShopId});if(selectedBranchId)p.set('branchId',selectedBranchId);
    const d=await api('/api/role-dashboard?'+p);
    let host=document.getElementById('opsRoleDashboard');
    if(!host){host=document.createElement('div');host.id='opsRoleDashboard';document.querySelector('#overview .overview-tabs')?.insertAdjacentElement('afterend',host)}
    const quick={
      shop_admin:[['appointments','Appointments'],['finance','Finance'],['reports','Reports'],['approvals','Approvals']],
      manager:[['appointments','Appointments'],['requests','Booking requests'],['team','Staff'],['inventory','Stock']],
      cashier:[['appointments','Reception'],['checkout','POS / Checkout'],['payments','Payments'],['cashiers','Cashier session']],
      finance:[['finance','Finance & Accounts'],['payments','Payments'],['reports','Reports']],
      service:[['appointments','My service queue'],['queue','Waiting room'],['customers','Customers']],
      inventory:[['inventory','Products & Stock'],['assets','Assets'],['procurement','Procurement']],
      auditor:[['reports','Reports'],['audit','Audit trail'],['finance','Finance']]
    }[d.role]||[];
    host.innerHTML='<div class="ops-role"><div class="ops-role-main"><div class="eyebrow">'+esc(d.role.replaceAll('_',' ').toUpperCase())+' WORKSPACE</div><h2>'+esc(d.profile?.title||'Shop workspace')+'</h2><p>'+esc(d.profile?.subtitle||'')+'</p><div class="ops-role-actions">'+quick.filter(x=>pageAllowed(x[0])).map(x=>'<button class="btn" onclick="showPage(\''+x[0]+'\')">'+esc(x[1])+'</button>').join('')+'</div></div><div class="ops-role-side">'+(d.profile?.metrics||[]).map(k=>'<div class="ops-mini"><small>'+esc(opsMetricLabel(k))+'</small><b>'+opsMetricValue(k,d.metrics?.[k])+'</b></div>').join('')+'</div></div>'+
      (d.role==='cashier'?cashierBannerHtml(d.cashierSession):'');
    cashierState=d.cashierSession||cashierState;
  }catch(e){}
};
function cashierBannerHtml(s){
  return s?'<div class="ops-banner good"><div><strong>Cashier session active · '+esc(s.session_no)+'</strong><small>Started '+new Date(s.started_at).toLocaleString()+' · opening cash '+money(s.opening_cash)+'</small></div><button class="btn primary" onclick="openCashierEnd()">End / hand over</button></div>':'<div class="ops-banner warn"><div><strong>Cashier session not started</strong><small>Start your work session before processing customers, sales or payments.</small></div><button class="btn primary" onclick="promptCashierSession()">Start session</button></div>';
}
window.promptCashierSession=async function(){
  if(base.role!=='cashier'&&!['shop_admin','manager'].includes(base.role))return;
  cashierStartMessage.textContent='';
  if(base.role==='cashier')cashierStartClose.style.display='none';else cashierStartClose.style.display='';
  openModal('cashierStartModal');
};
cashierStartForm.onsubmit=async e=>{
  e.preventDefault();if(!selectedShopId||!selectedBranchId)return showToast('Select a shop and branch first.');
  cashierStartMessage.textContent='Starting cashier session…';
  try{
    const r=await originalApi('/api/cashier/session/start',{method:'POST',body:JSON.stringify({shopId:selectedShopId,branchId:selectedBranchId,openingCash:Number(cashierOpeningCash.value||0),note:cashierStartNote.value||undefined})});
    cashierState=r.session;closeModal('cashierStartModal');showToast('Cashier session started');await Promise.all([loadCashierWorkspace(),loadRoleDashboard()]);
  }catch(err){cashierStartMessage.textContent=err.message;cashierStartMessage.className='msg bad'}
};
window.loadCashierWorkspace=async function(){
  if(!selectedShopId)return;
  try{
    const p=new URLSearchParams({shopId:selectedShopId});if(selectedBranchId)p.set('branchId',selectedBranchId);
    const current=await originalApi('/api/cashier/session/current?'+p);
    cashierState=current.session||current.branchSession||null;
    cashierCurrent.innerHTML=cashierState?'<div class="ops-session-status"><div class="card"><small class="muted">Session</small><h3>'+esc(cashierState.session_no)+'</h3></div><div class="card"><small class="muted">Cashier</small><h3>'+esc(cashierState.cashier_name||base.me?.first_name||'Current user')+'</h3></div><div class="card"><small class="muted">Opening cash</small><h3>'+money(cashierState.opening_cash)+'</h3></div><div class="card"><small class="muted">Started</small><h3>'+new Date(cashierState.started_at).toLocaleTimeString([],{hour:'2-digit',minute:'2-digit'})+'</h3></div></div>':'<div class="ops-banner warn"><div><strong>No active cashier session</strong><small>The next cashier must start a session before processing counter transactions.</small></div></div>';
    cashierPrimaryAction.textContent=cashierState?'End / hand over':'Start session';cashierPrimaryAction.onclick=()=>cashierState?openCashierEnd():promptCashierSession();
    const qs=new URLSearchParams({shopId:selectedShopId});if(selectedBranchId)qs.set('branchId',selectedBranchId);
    const rows=await originalApi('/api/cashier/sessions?'+qs).catch(()=>[]);
    cashierHistory.innerHTML=table([['Date',x=>esc(x.business_date)],['Session',x=>'<b>'+esc(x.session_no)+'</b>'],['Cashier',x=>esc(x.cashier_name||'—')],['Start',x=>new Date(x.started_at).toLocaleString()],['End',x=>x.ended_at?new Date(x.ended_at).toLocaleString():'Open'],['Opening',x=>money(x.opening_cash)],['Expected',x=>x.expected_cash==null?'—':money(x.expected_cash)],['Actual',x=>x.actual_cash==null?'—':money(x.actual_cash)],['Variance',x=>x.variance==null?'—':money(x.variance)],['Status',x=>tag(x.status)]],rows);
  }catch(e){cashierCurrent.innerHTML='<div class="empty">'+esc(e.message)+'</div>'}
};
window.openCashierEnd=async function(){
  if(!cashierState)return;
  cashierEndSessionId.value=cashierState.id;cashierActualCash.value='';cashierEndNote.value='';cashierEndMode.value='handover';cashierHandoverWrap.style.display='';
  try{
    const users=await originalApi('/api/cashier/available-cashiers');
    cashierHandoverUser.innerHTML='<option value="">Next cashier will start later</option>'+users.filter(x=>x.id!==base.me?.id).map(x=>'<option value="'+x.id+'">'+esc((x.first_name||'')+' '+(x.last_name||''))+'</option>').join('');
  }catch{}
  openModal('cashierEndModal');
};
cashierEndMode.onchange=()=>{cashierHandoverWrap.style.display=cashierEndMode.value==='handover'?'':'none';cashierEndNotice.textContent=cashierEndMode.value==='end_day'?'This closes the business day and writes the final end-of-day cash record.':'The business day stays open so the next cashier can continue.'};
cashierEndForm.onsubmit=async e=>{
  e.preventDefault();
  try{
    const r=await originalApi('/api/cashier/session/'+cashierEndSessionId.value+'/end',{method:'POST',body:JSON.stringify({mode:cashierEndMode.value,actualCash:Number(cashierActualCash.value||0),handoverToUserId:cashierHandoverUser.value||undefined,note:cashierEndNote.value||undefined})});
    cashierState=null;closeModal('cashierEndModal');showToast(cashierEndMode.value==='end_day'?'Business day closed':'Cashier session closed');await reloadAll();await Promise.all([loadCashierWorkspace(),loadRoleDashboard()]);
  }catch(err){showToast(err.message)}
};

function notificationSound(){
  try{
    const C=window.AudioContext||window.webkitAudioContext;if(!C)return;
    opsAudioContext=opsAudioContext||new C();const ctx=opsAudioContext;
    if(ctx.state==='suspended')ctx.resume().catch(()=>{});
    const o=ctx.createOscillator(),g=ctx.createGain();o.connect(g);g.connect(ctx.destination);o.frequency.setValueAtTime(880,ctx.currentTime);g.gain.setValueAtTime(.08,ctx.currentTime);g.gain.exponentialRampToValueAtTime(.001,ctx.currentTime+.35);o.start();o.stop(ctx.currentTime+.36);
  }catch{}
}
function renderNotifications(){
  const unread=opsNotifications.filter(x=>x.unread).length;
  opsBellCount.textContent=String(unread);opsBellCount.style.display=unread?'grid':'none';
  opsNotificationList.innerHTML=opsNotifications.length?opsNotifications.map(n=>'<div class="ops-notice '+(n.unread?'unread':'')+'" data-notification="'+n.id+'"><b>'+esc(n.title)+'</b><small>'+esc(n.message)+'<br>'+new Date(n.created_at).toLocaleString()+'</small></div>').join(''):'<div class="empty">No notifications yet.</div>';
  opsNotificationList.querySelectorAll('[data-notification]').forEach(el=>el.onclick=async()=>{const n=opsNotifications.find(x=>x.id===el.dataset.notification);try{await originalApi('/api/notifications/'+el.dataset.notification+'/read',{method:'POST',body:'{}'});if(n)n.unread=false;renderNotifications();if(n?.entity_type==='booking'){showPage('requests');await loadExternalRequests()}}catch{}});
}
async function pollNotifications(initial=false){
  if(!selectedShopId)return;
  try{
    const rows=await originalApi('/api/notifications?shopId='+encodeURIComponent(selectedShopId)+'&limit=40');
    const newest=rows[0]?.created_at||null;
    const incoming=!initial&&lastNotificationTime?rows.filter(x=>new Date(x.created_at)>new Date(lastNotificationTime)&&x.event_type==='booking.request'):[];
    opsNotifications=rows;renderNotifications();
    if(incoming.length){
      notificationSound();
      if(window.Notification?.permission==='granted')incoming.slice(0,3).forEach(n=>new Notification(n.title,{body:n.message}));
      showToast(incoming[0].title);
    }
    if(newest)lastNotificationTime=newest;
    if(incoming.length)loadLatestBookingReference();
  }catch{}
}
opsBell.onclick=()=>opsNotificationPop.classList.toggle('show');
opsEnableNotifications.onclick=async()=>{try{const C=window.AudioContext||window.webkitAudioContext;if(C){opsAudioContext=opsAudioContext||new C();await opsAudioContext.resume();notificationSound()}}catch{}if(window.Notification){const p=await Notification.requestPermission();showToast(p==='granted'?'Sound and desktop booking alerts enabled':'Sound alerts enabled. Desktop notifications were not permitted.')}else showToast('Sound booking alerts enabled.')};
document.addEventListener('click',e=>{if(!opsNotificationPop.contains(e.target)&&e.target!==opsBell&&!opsBell.contains(e.target))opsNotificationPop.classList.remove('show')});

window.loadExternalRequests=async function(){
  if(!selectedShopId)return;
  try{
    const p=new URLSearchParams({shopId:selectedShopId});if(selectedBranchId)p.set('branchId',selectedBranchId);
    externalRequests=await api('/api/requests/external?'+p);
    externalRequestList.innerHTML=externalRequests.length?externalRequests.map(r=>{
      const media=r.inspiration_media_id?'/api/public/media/'+r.inspiration_media_id:null;
      const preview=media?(r.inspiration_media_type==='video'?'<video controls preload="metadata" src="'+media+'"></video>':'<img src="'+media+'" alt="">'):'<span class="muted">No style reference</span>';
      return '<article class="ops-request"><div class="ops-request-media" '+(media?'onclick="previewBookingMedia(\''+r.id+'\')" style="cursor:pointer"':'')+'>'+preview+'</div><div><div style="display:flex;justify-content:space-between;gap:8px"><h3>'+esc(r.customer_name)+'</h3>'+tag(r.status)+'</div><p><b>'+esc(r.service_name||'Service')+'</b> · '+new Date(r.booked_for).toLocaleString()+'</p><p>'+esc(r.barber_name||'Any available barber')+' · '+esc(r.source.replaceAll('_',' '))+'</p>'+(r.inspiration_title?'<p><b>Chosen style:</b> '+esc(r.inspiration_title)+'</p>':'')+'<div class="toolbar" style="margin-top:10px">'+(!r.request_seen_at?'<button class="btn sm soft" onclick="markRequestSeen(\''+r.id+'\')">Mark seen</button>':'')+'<button class="btn sm primary" onclick="openCheckinFlow(\''+r.id+'\')">Open appointment</button></div></div></article>';
    }).join(''):'<div class="card empty">No customer or public booking requests yet.</div>';
  }catch(e){externalRequestList.innerHTML='<div class="card empty">'+esc(e.message)+'</div>'}
};
window.markRequestSeen=async function(id){try{await api('/api/requests/'+id+'/seen',{method:'POST',body:'{}'});await loadExternalRequests();await pollNotifications(true)}catch(e){showToast(e.message)}};
window.previewBookingMedia=function(id){const r=externalRequests.find(x=>x.id===id);if(!r?.inspiration_media_id)return;mediaPreviewTitle.textContent=r.inspiration_title||'Customer style reference';mediaPreviewBody.innerHTML=r.inspiration_media_type==='video'?'<video class="ops-image-large" controls autoplay src="/api/public/media/'+r.inspiration_media_id+'"></video>':'<img class="ops-image-large" src="/api/public/media/'+r.inspiration_media_id+'" alt="">';openModal('mediaPreviewModal')};

const originalAppointmentActions=appointmentActions;
appointmentActions=function(a){
  const permitted=['shop_admin','manager','cashier','service'].includes(base.role);
  let h='<div class="toolbar">';
  if(permitted&&['booked','queued','checked_in'].includes(a.status))h+='<button class="btn sm" onclick="openReschedule(\''+a.id+'\')">Edit</button>';
  if(permitted&&['booked','queued','checked_in'].includes(a.status))h+='<button class="btn sm primary" onclick="openCheckinFlow(\''+a.id+'\')">'+(a.status==='checked_in'?'Start service':'Check in')+'</button>';
  if(permitted&&a.status==='in_chair')h+='<button class="btn sm gold" onclick="setApptStatus(\''+a.id+'\',\'completed\')">Complete</button>';
  if(['shop_admin','manager','cashier'].includes(base.role)&&a.status==='completed')h+='<button class="btn sm dark" onclick="billAppointment(\''+a.id+'\')">Bill</button>';
  if(a.inspiration_media_id)h+='<button class="btn sm soft" onclick="previewAppointmentStyle(\''+a.id+'\')">Style</button>';
  return h+'</div>';
};
window.openCheckinFlow=function(id){
  const a=(salon.appointments||[]).find(x=>x.id===id)||externalRequests.find(x=>x.id===id);if(!a)return;
  checkinAppointmentId.value=id;checkinTitle.textContent=a.status==='checked_in'?'Start service':'Customer check-in';checkinCustomer.textContent=a.customer_name+' · '+(a.service_name||serviceName(a.service_id)||'Service');
  const barbers=filtered(salon.staff).filter(s=>s.role==='barber'&&s.status==='active');
  checkinBarber.innerHTML='<option value="">Choose barber</option>'+barbers.map(s=>'<option value="'+s.id+'" '+(s.id===a.salon_staff_id?'selected':'')+'>'+esc(s.full_name)+'</option>').join('');
  const chairs=filtered(salon.chairs).filter(x=>x.status==='available'||x.id===a.salon_chair_id);
  checkinChair.innerHTML='<option value="">No chair / assign later</option>'+chairs.map(x=>'<option value="'+x.id+'" '+(x.id===a.salon_chair_id?'selected':'')+'>'+esc(x.name)+'</option>').join('');
  checkinOnlyBtn.style.display=a.status==='checked_in'?'none':'';
  checkinReference.innerHTML=a.inspiration_media_id?'<div class="notice"><b>Customer selected this style reference</b><div style="margin-top:8px"><button class="btn sm soft" type="button" onclick="previewAppointmentStyle(\''+a.id+'\')">View large reference</button></div></div>':'';
  openModal('checkinFlowModal');
};
window.previewAppointmentStyle=function(id){const a=(salon.appointments||[]).find(x=>x.id===id)||externalRequests.find(x=>x.id===id);if(!a?.inspiration_media_id)return;mediaPreviewTitle.textContent=a.inspiration_title||'Customer style reference';const type=a.inspiration_media_type||'image';mediaPreviewBody.innerHTML=type==='video'?'<video class="ops-image-large" controls autoplay src="/api/public/media/'+a.inspiration_media_id+'"></video>':'<img class="ops-image-large" src="/api/public/media/'+a.inspiration_media_id+'" alt="">';openModal('mediaPreviewModal')};
checkinOnlyBtn.onclick=async()=>{try{await api('/api/salon/appointments/'+checkinAppointmentId.value+'/status',{method:'PATCH',body:JSON.stringify({status:'checked_in',staffId:checkinBarber.value||undefined,chairId:checkinChair.value||undefined})});closeModal('checkinFlowModal');showToast('Customer checked in');await reloadAll()}catch(e){showToast(e.message)}};
checkinFlowForm.onsubmit=async e=>{e.preventDefault();if(!checkinBarber.value)return showToast('Choose the barber who is starting this service.');try{const a=(salon.appointments||[]).find(x=>x.id===checkinAppointmentId.value);if(a&&a.status!=='checked_in')await api('/api/salon/appointments/'+a.id+'/status',{method:'PATCH',body:JSON.stringify({status:'checked_in',staffId:checkinBarber.value,chairId:checkinChair.value||undefined})});await api('/api/salon/appointments/'+checkinAppointmentId.value+'/status',{method:'PATCH',body:JSON.stringify({status:'in_chair',staffId:checkinBarber.value,chairId:checkinChair.value||undefined})});closeModal('checkinFlowModal');showToast('Service started');await reloadAll()}catch(err){showToast(err.message)}};

const originalRenderAppointments=renderAppointments;
renderAppointments=function(){
  let rows=filtered(salon.appointments);if(apptFilter==='today')rows=rows.filter(a=>isToday(a.booked_for));if(apptFilter==='upcoming')rows=rows.filter(a=>new Date(a.booked_for)>=new Date()&&!['completed','cancelled','no_show'].includes(a.status));
  appointmentTable.innerHTML=table([['Time',a=>new Date(a.booked_for).toLocaleString()],['Customer',a=>'<b>'+esc(a.customer_name)+'</b><br><small class="muted">'+esc(a.phone||'')+'</small>'],['Service',a=>esc(a.service_name||serviceName(a.service_id))],['Barber',a=>esc(a.barber_name||barberName(a.salon_staff_id))],['Source',a=>tag(a.source||'staff')],['Style',a=>a.inspiration_media_id?'<button class="btn sm soft" onclick="previewAppointmentStyle(\''+a.id+'\')">View image/video</button>':'—'],['Status',a=>tag(a.status)],['Actions',a=>appointmentActions(a)]],rows);
};

const oldRenderCustomers=renderCustomers;
renderCustomers=function(){
  const canEdit=['shop_admin','manager','cashier'].includes(base.role);
  customerTable.innerHTML=table([['Customer',c=>'<b>'+esc(c.name)+'</b><br><small class="muted">'+esc(c.customer_no||'')+'</small>'],['Phone',c=>esc(c.phone||'—')],['Email',c=>esc(c.email||'—')],['Status',c=>tag(c.status)],['Loyalty',c=>Number(c.loyalty_points||0).toFixed(0)+' pts'],['Action',c=>'<div class="toolbar"><button class="btn sm" onclick="openCustomer360(\''+c.id+'\')">360</button>'+(canEdit?'<button class="btn sm soft" onclick="openCustomerEdit(\''+c.id+'\')">Edit</button>':'')+'</div>']],filtered(base.customers));
};
window.openCustomerEdit=function(id){const c=base.customers.find(x=>x.id===id);if(!c)return;customerEditId.value=id;customerEditName.value=c.name||'';customerEditPhone.value=c.phone||'';customerEditEmail.value=c.email||'';customerEditType.value=c.customer_type||'retail';customerEditCredit.value=Number(c.credit_limit||0);customerEditStatus.value=c.status||'active';customerEditNotes.value=c.notes||'';openModal('customerEditModal')};
customerEditForm.onsubmit=async e=>{e.preventDefault();try{await api('/api/customers/'+customerEditId.value,{method:'PATCH',body:JSON.stringify({name:customerEditName.value,phone:customerEditPhone.value,email:customerEditEmail.value,address:undefined,customerType:customerEditType.value,creditLimit:Number(customerEditCredit.value||0),notes:customerEditNotes.value,status:customerEditStatus.value})});closeModal('customerEditModal');showToast('Customer updated');await reloadAll()}catch(err){showToast(err.message)}};

const oldRenderStaff=renderStaff;
renderStaff=function(){
  const cs=Object.fromEntries((commissionSummary||[]).map(x=>[x.id,x])),canEdit=['shop_admin','manager'].includes(base.role);
  staffGrid.innerHTML=filtered(salon.staff).length?filtered(salon.staff).map(s=>{const m=cs[s.id]||{};return '<div class="staff-card"><div class="staff-top"><div class="staff-avatar">'+esc(s.full_name.split(' ').map(x=>x[0]).slice(0,2).join(''))+'</div><div><h4>'+esc(s.full_name)+'</h4>'+tag(s.status)+'</div></div><p>'+esc(s.specialty||s.role)+'</p><div class="staff-metrics"><div class="mini"><small>Commission</small><b>'+Number(s.commission_percent||0)+'%</b></div><div class="mini"><small>This month</small><b>'+money(m.commission_earned||0)+'</b></div><div class="mini"><small>Services</small><b>'+(m.services||0)+'</b></div><div class="mini"><small>Gross value</small><b>'+money(m.gross_service_value||0)+'</b></div></div>'+(canEdit?'<button class="btn sm soft" style="margin-top:12px;width:100%" onclick="openStaffEdit(\''+s.id+'\')">Edit staff member</button>':'')+'</div>'}).join(''):'<div class="empty">No salon staff yet.</div>';
};
window.openStaffEdit=function(id){const s=salon.staff.find(x=>x.id===id);if(!s)return;staffEditId.value=id;staffEditName.value=s.full_name||'';staffEditPhone.value=s.phone||'';staffEditEmail.value=s.email||'';staffEditRole.value=s.role||'barber';staffEditCommission.value=Number(s.commission_percent||0);staffEditStatus.value=s.status||'active';staffEditSpecialty.value=s.specialty||'';openModal('staffEditModal')};
staffEditForm.onsubmit=async e=>{e.preventDefault();try{await api('/api/salon/staff/'+staffEditId.value,{method:'PATCH',body:JSON.stringify({fullName:staffEditName.value,phone:staffEditPhone.value,email:staffEditEmail.value,role:staffEditRole.value,specialty:staffEditSpecialty.value,commissionPercent:Number(staffEditCommission.value||0),status:staffEditStatus.value})});closeModal('staffEditModal');showToast('Staff member updated');await reloadAll()}catch(err){showToast(err.message)}};

window.loadGalleryAdmin=async function(){
  if(!selectedShopId)return;
  try{
    opsGallery=await api('/api/gallery?shopId='+encodeURIComponent(selectedShopId));
    galleryAdminGrid.innerHTML=opsGallery.length?opsGallery.map(m=>'<article class="ops-media-card"><div class="ops-media-preview">'+(m.media_type==='video'?'<video controls preload="metadata" src="'+esc(m.media_url)+'"></video>':'<img src="'+esc(m.media_url)+'" alt="">')+'</div><div class="ops-media-body"><div style="display:flex;justify-content:space-between;gap:8px"><h4>'+esc(m.title)+'</h4>'+tag(m.is_published?'published':'hidden')+'</div><p>'+esc(m.description||m.category||'Style inspiration')+'</p><div class="ops-media-actions"><button class="btn sm" onclick="toggleMedia(\''+m.id+'\','+(!m.is_published)+')">'+(m.is_published?'Unpublish':'Publish')+'</button><button class="btn sm danger" onclick="deleteMedia(\''+m.id+'\')">Delete</button></div></div></article>').join(''):'<div class="card empty">No photos or videos have been published yet.</div>';
  }catch(e){galleryAdminGrid.innerHTML='<div class="card empty">'+esc(e.message)+'</div>'}
};
window.openMediaModal=function(){mediaForm.reset();mediaService.innerHTML='<option value="">Any service</option>'+filtered(base.services).map(x=>'<option value="'+x.id+'">'+esc(x.name)+'</option>').join('');mediaStaff.innerHTML='<option value="">Any barber</option>'+filtered(salon.staff).filter(x=>x.role==='barber').map(x=>'<option value="'+x.id+'">'+esc(x.full_name)+'</option>').join('');openModal('mediaModal')};
function fileDataUrl(file){return new Promise((resolve,reject)=>{const r=new FileReader();r.onload=()=>resolve(r.result);r.onerror=()=>reject(new Error('The media file could not be read.'));r.readAsDataURL(file)})}
mediaForm.onsubmit=async e=>{e.preventDefault();try{const file=mediaFile.files?.[0];const dataUrl=file?await fileDataUrl(file):undefined;await api('/api/gallery',{method:'POST',body:JSON.stringify({shopId:selectedShopId,branchId:selectedBranchId||undefined,title:mediaTitle.value,description:mediaDescription.value||undefined,category:mediaCategory.value||undefined,mediaType:mediaType.value,dataUrl,externalUrl:mediaExternalUrl.value||undefined,serviceId:mediaService.value||undefined,staffId:mediaStaff.value||undefined,isPublished:mediaPublished.value==='true'})});closeModal('mediaModal');showToast('Gallery media saved');await loadGalleryAdmin()}catch(err){showToast(err.message)}};
window.toggleMedia=async function(id,published){try{await api('/api/gallery/'+id,{method:'PATCH',body:JSON.stringify({isPublished:published})});await loadGalleryAdmin()}catch(e){showToast(e.message)}};
window.deleteMedia=async function(id){if(!confirm('Delete this gallery media item? Existing bookings keep their appointment but will no longer show this reference.'))return;try{await api('/api/gallery/'+id,{method:'DELETE'});showToast('Media deleted');await loadGalleryAdmin()}catch(e){showToast(e.message)}};

window.openLeaveModal=function(){leaveForm.reset();const staff=filtered(salon.staff);leaveStaff.innerHTML='<option value="">My own Shop user account</option>'+staff.map(x=>'<option value="'+x.id+'">'+esc(x.full_name)+' · '+esc(x.role)+'</option>').join('');leaveRelief.innerHTML='<option value="">No relief assigned yet</option>'+staff.filter(x=>x.status==='active').map(x=>'<option value="'+x.id+'">'+esc(x.full_name)+'</option>').join('');const d=new Date().toISOString().slice(0,10);leaveStart.value=d;leaveEnd.value=d;openModal('leaveModal')};
leaveForm.onsubmit=async e=>{e.preventDefault();try{await api('/api/leave',{method:'POST',body:JSON.stringify({shopId:selectedShopId,branchId:selectedBranchId||undefined,salonStaffId:leaveStaff.value||undefined,leaveType:leaveType.value,startDate:leaveStart.value,endDate:leaveEnd.value,reason:leaveReason.value,reliefStaffId:leaveRelief.value||undefined,reliefNotes:leaveReliefNotes.value||undefined})});closeModal('leaveModal');showToast('Leave request submitted');await loadLeave()}catch(err){showToast(err.message)}};
window.loadLeave=async function(){
  if(!selectedShopId)return;
  try{
    const p=new URLSearchParams({shopId:selectedShopId});if(selectedBranchId)p.set('branchId',selectedBranchId);
    leaveRows=await originalApi('/api/leave?'+p);
    const canReview=base.shopCapabilities?.includes('*')||base.shopCapabilities?.includes('leave.review');
    leaveTable.innerHTML=table([['Staff',x=>'<b>'+esc(x.applicant_name||'Shop user')+'</b>'],['Type',x=>esc(x.leave_type)],['Dates',x=>esc(x.start_date)+' → '+esc(x.end_date)],['Reason',x=>esc(x.reason)],['Relief',x=>esc(x.relief_name||x.relief_notes||'—')],['Status',x=>tag(x.status)],['Action',x=>x.status==='pending'?(canReview?'<div class="toolbar"><button class="btn sm primary" onclick="reviewLeave(\''+x.id+'\',\'approved\')">Approve</button><button class="btn sm danger" onclick="reviewLeave(\''+x.id+'\',\'rejected\')">Reject</button></div>':'<button class="btn sm danger" onclick="cancelLeave(\''+x.id+'\')">Cancel</button>'):'—']],leaveRows);
  }catch(e){leaveTable.innerHTML='<div class="empty">'+esc(e.message)+'</div>'}
};
window.reviewLeave=async function(id,decision){const note=decision==='rejected'?prompt('Reason for rejection:')||'':prompt('Approval note (optional):')||'';if(decision==='rejected'&&!note)return;try{await originalApi('/api/leave/'+id+'/review',{method:'POST',body:JSON.stringify({decision,note:note||undefined})});showToast('Leave request '+decision);await loadLeave()}catch(e){showToast(e.message)}};
window.cancelLeave=async function(id){try{await originalApi('/api/leave/'+id+'/cancel',{method:'PATCH',body:'{}'});showToast('Leave request cancelled');await loadLeave()}catch(e){showToast(e.message)}};

window.loadReports=async function(){
  if(!selectedShopId)return;
  try{
    if(!reportCatalog.length)reportCatalog=await api('/api/reports/catalog');
    const from=reportFrom.value||new Date(Date.now()-30*86400000).toISOString().slice(0,10),to=reportTo.value||new Date().toISOString().slice(0,10);reportFrom.value=from;reportTo.value=to;
    const result=await api('/api/reports/run?'+new URLSearchParams({type:activeReportType,shopId:selectedShopId,...(selectedBranchId?{branchId:selectedBranchId}:{}),from,to}));
    const active=reportCatalog.find(x=>x.key===activeReportType)||reportCatalog[0];
    reportArea.innerHTML='<div class="ops-report-layout"><div class="card"><div class="card-head"><div><h3>Report Library</h3><small>'+reportCatalog.length+' operational and control reports</small></div></div><div class="ops-report-list">'+reportCatalog.map(r=>'<button class="ops-report-btn '+(r.key===activeReportType?'active':'')+'" data-report="'+r.key+'"><b>'+esc(r.name)+'</b><small>'+esc(r.group)+' · '+esc(r.description)+'</small></button>').join('')+'</div></div><div class="card"><div class="page-head" style="margin-bottom:10px"><div><h2>'+esc(active?.name||activeReportType)+'</h2><div class="muted">'+esc(active?.description||'')+' · '+esc(from)+' to '+esc(to)+'</div></div><button class="btn primary" onclick="exportActiveReport()">Export CSV</button></div><div id="opsReportResult">'+renderGenericReport(result.rows||[])+'</div></div></div>';
    reportArea.querySelectorAll('[data-report]').forEach(btn=>btn.onclick=()=>{activeReportType=btn.dataset.report;loadReports()});
  }catch(e){reportArea.innerHTML='<div class="card empty">'+esc(e.message)+'</div>'}
};
function renderGenericReport(rows){
  if(!rows.length)return'<div class="empty">No records for this report and date range.</div>';
  const cols=Object.keys(rows[0]).slice(0,14);
  return'<div class="table-wrap"><table><thead><tr>'+cols.map(k=>'<th>'+esc(k.replaceAll('_',' '))+'</th>').join('')+'</tr></thead><tbody>'+rows.slice(0,500).map(r=>'<tr>'+cols.map(k=>'<td>'+reportValue(k,r[k])+'</td>').join('')+'</tr>').join('')+'</tbody></table></div>'+(rows.length>500?'<div class="notice" style="margin-top:10px">Showing first 500 rows. Export CSV for the complete result.</div>':'');
}
function reportValue(k,v){if(v==null)return'—';if(typeof v==='object')return'<small>'+esc(JSON.stringify(v))+'</small>';if(/amount|total|sales|payment|expense|balance|cash|commission|cost|price|tax|fee|value/i.test(k)&&!isNaN(Number(v)))return money(v);if(/_at$|date$|booked_for/.test(k)){const d=new Date(v);if(!isNaN(d))return esc(d.toLocaleString())}return esc(v)}
window.exportActiveReport=function(){if(!selectedShopId)return;const q=new URLSearchParams({type:activeReportType,shopId:selectedShopId,from:reportFrom.value,to:reportTo.value,format:'csv'});if(selectedBranchId)q.set('branchId',selectedBranchId);window.open('/api/reports/run?'+q,'_blank')};

window.loadFinanceControl=async function(){
  if(!selectedShopId||!document.getElementById('finance'))return;
  let hero=document.getElementById('opsFinanceHero');
  if(!hero){hero=document.createElement('div');hero.id='opsFinanceHero';document.querySelector('#finance .page-head')?.insertAdjacentElement('afterend',hero)}
  try{
    const d=await api('/api/finance/overview?shopId='+encodeURIComponent(selectedShopId)),s=d.summary||{};
    const accountBalance=(d.accounts||[]).reduce((x,a)=>x+Number(a.balance||0),0);
    hero.innerHTML='<div class="ops-finance-hero"><div class="ops-fin-card"><small>Customer receipts</small><b>'+money(s.receipts||0)+'</b><div class="hint">Successful recorded payments</div></div><div class="ops-fin-card"><small>Operating expenses</small><b>'+money(s.expenses||0)+'</b><div class="hint">Recorded Shop expenses</div></div><div class="ops-fin-card"><small>Receivables</small><b>'+money(s.receivables||0)+'</b><div class="hint">Outstanding invoice balances</div></div><div class="ops-fin-card"><small>Ledger position</small><b>'+money(accountBalance)+'</b><div class="hint">Combined account balances</div></div></div><div class="notice">Finance is connected to Shop payments, expenses, cash sessions, end-of-day close, journals, budgets, suppliers, tax records and reconciliation. Use the tabs below for detailed control.</div>';
    const heading=document.querySelector('#finance .page-head h1');if(heading)heading.textContent='Finance & Accounts Control Centre';const desc=document.querySelector('#finance .page-head p');if(desc)desc.textContent='Collections, cash control, expenses, journals, vendors, budgets, tax obligations and reconciliation in one workspace.';
  }catch(e){hero.innerHTML='<div class="ops-banner warn"><div><strong>Finance summary unavailable</strong><small>'+esc(e.message)+'</small></div></div>'}
};

const oldShowPage=showPage;
showPage=function(id){
  oldShowPage(id);
  setTimeout(()=>{
    if(id==='requests')loadExternalRequests();
    if(id==='gallery')loadGalleryAdmin();
    if(id==='leave')loadLeave();
    if(id==='cashiers')loadCashierWorkspace();
    if(id==='finance')loadFinanceControl();
    if(id==='reports')loadReports();
  },0);
};

const oldReloadAll=reloadAll;
reloadAll=async function(){
  await oldReloadAll();
  await Promise.allSettled([loadRoleDashboard(),loadLatestBookingReference(),pollNotifications(!lastNotificationTime)]);
  if(base.role==='cashier'){
    try{const p=new URLSearchParams({shopId:selectedShopId||''});if(selectedBranchId)p.set('branchId',selectedBranchId);const s=await originalApi('/api/cashier/session/current?'+p);cashierState=s.session||null;if(!cashierState)setTimeout(()=>promptCashierSession(),250)}catch{}
  }
};

const oldRenderAll=renderAll;
renderAll=function(){
  oldRenderAll();
  renderAppointments();renderCustomers();renderStaff();
  setTimeout(()=>{loadRoleDashboard();if(document.querySelector('#finance.active'))loadFinanceControl()},0);
};

setInterval(()=>pollNotifications(false),8000);
setTimeout(()=>{pollNotifications(true);loadRoleDashboard();loadLatestBookingReference()},1200);
})();