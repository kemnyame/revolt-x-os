(function(){
'use strict';

const enterpriseStyle=document.createElement('style');
enterpriseStyle.textContent=`
.enterprise-badge{display:inline-flex;align-items:center;gap:6px;padding:6px 9px;border-radius:999px;background:#eef8f6;color:#0e7469;font-size:10px;font-weight:900}
.enterprise-kpis{display:grid;grid-template-columns:repeat(6,minmax(0,1fr));gap:10px;margin:14px 0}
.enterprise-kpi{background:#fff;border:1px solid var(--line);border-radius:14px;padding:13px;box-shadow:var(--shadow)}
.enterprise-kpi small{display:block;color:var(--muted);font-size:10px;font-weight:850;text-transform:uppercase;letter-spacing:.05em}
.enterprise-kpi b{display:block;font-size:22px;margin-top:5px}
.enterprise-grid{display:grid;grid-template-columns:1fr 1fr;gap:14px}.enterprise-grid.three{grid-template-columns:repeat(3,minmax(0,1fr))}
.enterprise-tabs{display:flex;gap:7px;flex-wrap:wrap;margin:12px 0}.enterprise-tab{border:1px solid var(--line);background:white;color:var(--ink);padding:8px 10px;border-radius:10px;font-weight:800}.enterprise-tab.active{background:#17343a;color:#fff;border-color:#17343a}
.metric-strip{display:grid;grid-template-columns:repeat(4,1fr);gap:9px}.metric-strip>div{background:#f7f9fa;border:1px solid var(--line);border-radius:11px;padding:10px}.metric-strip small{display:block;color:var(--muted);font-size:10px}.metric-strip b{display:block;font-size:18px;margin-top:3px}
.timeline-list{display:grid;gap:9px}.timeline-item{border-left:3px solid #2e9b90;padding:7px 10px;background:#f8faf9;border-radius:0 10px 10px 0}.timeline-item small{color:var(--muted)}
.chat-layout{display:grid;grid-template-columns:330px minmax(0,1fr);gap:12px}.conversation-list{max-height:560px;overflow:auto}.conversation-card{width:100%;border:0;border-bottom:1px solid var(--line);background:#fff;padding:12px;text-align:left}.conversation-card:hover,.conversation-card.active{background:#eef8f6}.conversation-card b{display:block}.conversation-card small{color:var(--muted)}
.admin-chat{height:420px;overflow:auto;background:#f7f9fa;border:1px solid var(--line);border-radius:12px;padding:12px;display:flex;flex-direction:column;gap:8px}.admin-bubble{max-width:78%;padding:9px 11px;border-radius:12px;background:#fff;border:1px solid var(--line)}.admin-bubble.staff{align-self:flex-end;background:#e8f7f3}.admin-bubble small{display:block;color:var(--muted);font-size:9px;margin-top:4px}
.cap-grid{display:grid;grid-template-columns:repeat(2,1fr);gap:8px}.cap-item{display:flex;gap:9px;align-items:flex-start;border:1px solid var(--line);border-radius:11px;padding:10px;background:#fff}.cap-item b{display:block;font-size:12px}.cap-item small{color:var(--muted);display:block;margin-top:2px}
.alert-critical{border-left:4px solid var(--red)}.alert-warning{border-left:4px solid var(--amber)}
.finance-summary{display:grid;grid-template-columns:repeat(3,1fr);gap:10px}.finance-summary>div{background:#f7f9fa;border-radius:12px;padding:12px}.finance-summary small{color:var(--muted);font-size:10px}.finance-summary b{display:block;font-size:20px;margin-top:3px}
.link-card{display:flex;justify-content:space-between;gap:12px;align-items:center;padding:13px;border:1px solid var(--line);border-radius:12px;background:#fff}
@media(max-width:1200px){.enterprise-kpis{grid-template-columns:repeat(3,1fr)}.enterprise-grid.three{grid-template-columns:1fr 1fr}}
@media(max-width:900px){.enterprise-grid,.chat-layout{grid-template-columns:1fr}.enterprise-kpis,.metric-strip,.finance-summary{grid-template-columns:repeat(2,1fr)}.cap-grid{grid-template-columns:1fr}}
@media(max-width:620px){.enterprise-kpis,.metric-strip,.finance-summary,.enterprise-grid.three{grid-template-columns:1fr}.conversation-list{max-height:260px}}
`;
document.head.appendChild(enterpriseStyle);

function injectNav(groupTitle,page,label,icon){
  const groups=[...document.querySelectorAll('.group')];
  const group=groups.find(g=>g.querySelector('.group-title')?.textContent?.trim()===groupTitle);
  if(!group||group.querySelector('[data-page="'+page+'"]'))return;
  const b=document.createElement('button');
  b.className='navbtn';b.dataset.page=page;b.innerHTML='<span class="ico">'+icon+'</span>'+label;
  b.onclick=()=>{showPage(page);loadEnterprisePage(page)};
  group.appendChild(b);
}
injectNav('Salon','retention','Retention & Inactive','↺');
injectNav('Salon','communications','Customer Messages','✉');
injectNav('Commerce','assets','Assets & Equipment','⚒');
injectNav('Commerce','procurement','Procurement','⇄');
injectNav('Commerce','tickets','Ticketing','◫');
injectNav('Commerce','posdevices','POS Devices','▦');
injectNav('Administration','approvals','Approvals','✓');

const contentRoot=document.querySelector('.content');
contentRoot?.insertAdjacentHTML('beforeend',`
<section class="page" id="retention"><div class="page-head"><div><h1>Customer Retention</h1><p>Customers without a completed visit for the configured period are automatically moved to inactive.</p></div><div class="toolbar"><button class="btn" onclick="refreshCustomerLifecycle()">Refresh lifecycle</button><button class="btn primary" onclick="openBulkCustomerMessage()">Message all inactive</button></div></div><div class="enterprise-kpis" id="retentionKpis"></div><div class="card"><div class="card-head"><h3>Inactive customers</h3><small>Individual or bulk re-engagement</small></div><div id="inactiveCustomerTable"></div></div></section>

<section class="page" id="communications"><div class="page-head"><div><h1>Customer Communication Centre</h1><p>In-app customer chat with SMS, email and WhatsApp hand-off.</p></div><button class="btn" onclick="loadConversations()">Refresh</button></div><div class="chat-layout"><div class="card"><div class="card-head"><h3>Conversations</h3></div><div class="conversation-list" id="conversationList"></div></div><div class="card"><div class="card-head"><div><h3 id="conversationTitle">Select a conversation</h3><small id="conversationContact"></small></div><a id="conversationWhatsApp" class="btn sm soft" target="_blank" rel="noopener" style="display:none">WhatsApp</a></div><div class="admin-chat" id="conversationMessages"><div class="empty">Choose a customer conversation.</div></div><form id="conversationReplyForm" class="form-grid" style="margin-top:10px"><input type="hidden" id="activeConversationId"><div class="field wide"><label>Reply</label><textarea id="conversationReply" required placeholder="Type your reply"></textarea></div><div class="field"><label>Send via</label><select id="conversationChannel"><option value="in_app">In-app chat</option><option value="whatsapp">WhatsApp</option><option value="sms">SMS</option><option value="email">Email</option></select></div><div class="field"><label>&nbsp;</label><button class="btn primary" style="width:100%">Send reply</button></div></form></div></div></section>

<section class="page" id="assets"><div class="page-head"><div><h1>Assets & Equipment</h1><p>Track barber chairs, clippers, dryers, sterilizers, generators, POS hardware and maintenance.</p></div><button class="btn primary" onclick="openModal('assetModal')">+ Equipment</button></div><div class="enterprise-grid"><div class="card"><div class="card-head"><h3>Equipment register</h3></div><div id="assetTable"></div></div><div class="card"><div class="card-head"><h3>Inventory & maintenance alerts</h3></div><div id="enterpriseAlerts"></div></div></div></section>

<section class="page" id="procurement"><div class="page-head"><div><h1>Procurement</h1><p>Supplier purchase orders, approvals, goods receiving and automatic stock updates.</p></div><button class="btn primary" onclick="openPurchaseOrder()">+ Purchase order</button></div><div class="enterprise-grid"><div class="card"><div class="card-head"><h3>Purchase orders</h3><button class="btn sm" onclick="loadProcurement()">Refresh</button></div><div id="purchaseOrderTable"></div></div><div class="card"><div class="card-head"><h3>Goods receipts</h3><small>Stock received from approved POs</small></div><div id="goodsReceiptTable"></div></div></div></section>

<section class="page" id="tickets"><div class="page-head"><div><h1>Ticketing & Requests</h1><p>Track customer complaints, appointment issues, payment queries and internal service requests.</p></div><button class="btn primary" onclick="openModal('ticketModal')">+ Ticket</button></div><div class="card"><div id="ticketTable"></div></div></section>

<section class="page" id="posdevices"><div class="page-head"><div><h1>POS Devices</h1><p>Register checkout terminals and prepare Shop for device-based payment and counter workflows.</p></div><button class="btn primary" onclick="openModal('posDeviceModal')">+ POS device</button></div><div class="card"><div id="posDeviceTable"></div></div></section>

<section class="page" id="approvals"><div class="page-head"><div><h1>Approvals</h1><p>Controlled changes are reviewed before they affect live operations or customer-facing information.</p></div><button class="btn" onclick="loadApprovals()">Refresh</button></div><div class="card"><div id="approvalTable"></div></div></section>
`);

document.body.insertAdjacentHTML('beforeend',`
<div class="modal-backdrop" id="customer360Modal"><div class="modal" style="width:min(920px,97vw)"><div class="modal-head"><h3>Customer 360</h3><button class="xbtn" onclick="closeModal('customer360Modal')">×</button></div><div id="customer360Body"></div></div></div>
<div class="modal-backdrop" id="customerMessageModal"><div class="modal"><div class="modal-head"><h3 id="customerMessageTitle">Message customer</h3><button class="xbtn" onclick="closeModal('customerMessageModal')">×</button></div><form id="customerMessageForm" class="form-grid"><input type="hidden" id="messageCustomerId"><input type="hidden" id="messageBulk"><div class="field"><label>Channel</label><select id="messageChannel"><option value="sms">SMS</option><option value="whatsapp">WhatsApp</option><option value="email">Email</option></select></div><div class="field"><label>Subject</label><input id="messageSubject" placeholder="Optional"></div><div class="field wide"><label>Message</label><textarea id="messageBody" required>We have missed seeing you. Book your next grooming appointment with us and let us take care of you again.</textarea></div><div class="field wide"><button class="btn primary" style="width:100%">Send message</button></div></form></div></div>
<div class="modal-backdrop" id="serviceEditModal"><div class="modal"><div class="modal-head"><h3>Edit service & submit for approval</h3><button class="xbtn" onclick="closeModal('serviceEditModal')">×</button></div><form id="serviceEditForm" class="form-grid"><input type="hidden" id="editServiceId"><div class="field wide"><label>Service name</label><input id="editServiceName" required></div><div class="field"><label>Category</label><input id="editServiceCategory"></div><div class="field"><label>Price (GHS)</label><input id="editServicePrice" type="number" step="0.01" min="0" required></div><div class="field"><label>Duration minutes</label><input id="editServiceDuration" type="number" min="5" required></div><div class="field"><label>Deposit %</label><input id="editServiceDeposit" type="number" min="0" max="100"></div><div class="field wide"><label>Description</label><textarea id="editServiceDescription"></textarea></div><div class="field wide"><label>Reason for change</label><textarea id="editServiceReason" required placeholder="Why is this price or service being changed?"></textarea></div><div class="field wide"><div class="notice">The live service and customer portal remain unchanged until this request is approved.</div></div><div class="field wide"><button class="btn primary" style="width:100%">Submit change for approval</button></div></form></div></div>
<div class="modal-backdrop" id="assetModal"><div class="modal"><div class="modal-head"><h3>Add equipment / asset</h3><button class="xbtn" onclick="closeModal('assetModal')">×</button></div><form id="assetForm" class="form-grid"><div class="field"><label>Asset number</label><input name="assetNo" required placeholder="EQ-001"></div><div class="field"><label>Name</label><input name="name" required></div><div class="field"><label>Category</label><input name="category" required placeholder="Clipper, Chair, Dryer, POS"></div><div class="field"><label>Brand</label><input name="brand"></div><div class="field"><label>Model</label><input name="model"></div><div class="field"><label>Serial number</label><input name="serialNumber"></div><div class="field"><label>Purchase cost</label><input name="purchaseCost" type="number" min="0" step="0.01" value="0"></div><div class="field"><label>Next service date</label><input name="nextServiceDate" type="date"></div><div class="field wide"><label>Notes</label><textarea name="notes"></textarea></div><div class="field wide"><button class="btn primary" style="width:100%">Add equipment</button></div></form></div></div>
<div class="modal-backdrop" id="maintenanceModal"><div class="modal"><div class="modal-head"><h3>Record equipment maintenance</h3><button class="xbtn" onclick="closeModal('maintenanceModal')">×</button></div><form id="maintenanceForm" class="form-grid"><input type="hidden" id="maintenanceAssetId"><div class="field"><label>Maintenance type</label><input id="maintenanceType" required placeholder="Service / Repair"></div><div class="field"><label>Cost</label><input id="maintenanceCost" type="number" min="0" step="0.01" value="0"></div><div class="field"><label>Vendor</label><input id="maintenanceVendor"></div><div class="field"><label>Next service date</label><input id="maintenanceNext" type="date"></div><div class="field wide"><label>Description</label><textarea id="maintenanceDescription"></textarea></div><div class="field wide"><button class="btn primary" style="width:100%">Save maintenance</button></div></form></div></div>
<div class="modal-backdrop" id="purchaseOrderModal"><div class="modal" style="width:min(820px,97vw)"><div class="modal-head"><h3>Create purchase order</h3><button class="xbtn" onclick="closeModal('purchaseOrderModal')">×</button></div><form id="purchaseOrderForm" class="form-grid"><div class="field"><label>Supplier</label><select id="poVendor"></select></div><div class="field"><label>Expected date</label><input id="poExpectedDate" type="date"></div><div class="field wide"><label>Notes</label><input id="poNotes"></div><div class="field wide"><div class="card" style="padding:12px"><div class="card-head"><h4 style="margin:0">Items</h4><button class="btn sm" type="button" onclick="addPoLine()">+ Line</button></div><div id="poLines"></div></div></div><div class="field"><label>Tax / levy (GHS)</label><input id="poTax" type="number" min="0" step="0.01" value="0"></div><div class="field"><label>&nbsp;</label><button class="btn primary" style="width:100%">Save draft PO</button></div></form></div></div>
<div class="modal-backdrop" id="receivePoModal"><div class="modal" style="width:min(760px,97vw)"><div class="modal-head"><h3 id="receivePoTitle">Receive goods</h3><button class="xbtn" onclick="closeModal('receivePoModal')">×</button></div><form id="receivePoForm" class="form-grid"><input type="hidden" id="receivePoId"><div class="field wide"><div id="receivePoLines"></div></div><div class="field wide"><label>Receiving notes</label><textarea id="receivePoNotes"></textarea></div><div class="field wide"><button class="btn primary" style="width:100%">Post goods receipt & update stock</button></div></form></div></div>
<div class="modal-backdrop" id="ticketModal"><div class="modal"><div class="modal-head"><h3>Create ticket</h3><button class="xbtn" onclick="closeModal('ticketModal')">×</button></div><form id="ticketFormAdmin" class="form-grid"><div class="field"><label>Customer</label><select id="ticketCustomer"></select></div><div class="field"><label>Category</label><select id="ticketCategory"><option value="general">General</option><option value="appointment">Appointment</option><option value="payment">Payment</option><option value="service">Service</option><option value="complaint">Complaint</option></select></div><div class="field"><label>Priority</label><select id="ticketPriority"><option value="normal">Normal</option><option value="low">Low</option><option value="high">High</option><option value="urgent">Urgent</option></select></div><div class="field wide"><label>Subject</label><input id="ticketSubject" required></div><div class="field wide"><label>Description</label><textarea id="ticketDescription" required></textarea></div><div class="field wide"><button class="btn primary" style="width:100%">Create ticket</button></div></form></div></div>
<div class="modal-backdrop" id="posDeviceModal"><div class="modal"><div class="modal-head"><h3>Register POS device</h3><button class="xbtn" onclick="closeModal('posDeviceModal')">×</button></div><form id="posDeviceForm" class="form-grid"><div class="field"><label>Device name</label><input name="deviceName" required></div><div class="field"><label>Device code</label><input name="deviceCode" required placeholder="POS-FRONT-01"></div><div class="field"><label>Provider</label><input name="provider" placeholder="Optional"></div><div class="field"><label>Terminal ID</label><input name="terminalId"></div><div class="field wide"><button class="btn primary" style="width:100%">Register device</button></div></form></div></div>
<div class="modal-backdrop" id="posTokenModal"><div class="modal"><div class="modal-head"><h3>POS device credential</h3><button class="xbtn" onclick="closeModal('posTokenModal')">×</button></div><div class="notice"><b>Copy this device token now.</b> For security, it is shown only at registration and should be stored in the POS terminal configuration, not shared with staff who do not administer devices.</div><div class="field" style="margin-top:14px"><label>Device token</label><textarea id="posDeviceToken" readonly style="min-height:110px"></textarea></div><button class="btn primary" style="width:100%" onclick="navigator.clipboard?.writeText(posDeviceToken.value);showToast('Device token copied')">Copy token</button></div></div>
<div class="modal-backdrop" id="roleModal"><div class="modal"><div class="modal-head"><h3>Create custom Shop role</h3><button class="xbtn" onclick="closeModal('roleModal')">×</button></div><form id="roleForm" class="form-grid"><div class="field"><label>Role key</label><input name="key" required placeholder="supervisor"></div><div class="field"><label>Role name</label><input name="name" required placeholder="Salon Supervisor"></div><div class="field wide"><label>Description</label><textarea name="description"></textarea></div><div class="field wide"><button class="btn primary" style="width:100%">Create role</button></div></form></div></div>
<div class="modal-backdrop" id="actionPromptModal"><div class="modal"><div class="modal-head"><h3 id="actionPromptTitle">Confirm action</h3><button class="xbtn" onclick="closeModal('actionPromptModal')">×</button></div><form id="actionPromptForm" class="form-grid"><div class="field wide"><div id="actionPromptNotice" class="notice"></div></div><div class="field wide" id="actionPromptSelectWrap" style="display:none"><label id="actionPromptSelectLabel">Select</label><select id="actionPromptSelect"></select></div><div class="field wide"><label id="actionPromptInputLabel">Comment</label><textarea id="actionPromptInput"></textarea></div><div class="field wide"><button class="btn primary" id="actionPromptSubmit" style="width:100%">Continue</button></div></form></div></div>
<div class="modal-backdrop" id="financeEntryModal"><div class="modal" style="width:min(760px,97vw)"><div class="modal-head"><h3 id="financeEntryTitle">Finance entry</h3><button class="xbtn" onclick="closeModal('financeEntryModal')">×</button></div><div id="financeEntryBody"></div></div></div>
`);

const oldAllowed=allowedPages;
allowedPages=function(role){
  const caps=new Set(base?.shopCapabilities||[]);
  if(caps.has('*'))return['overview','appointments','queue','customers','team','services','checkout','inventory','payments','finance','reports','retention','communications','assets','procurement','tickets','posdevices','approvals','access','audit','settings'];
  if(!caps.size){
    const basePages=oldAllowed(role);
    const extra={
      shop_admin:['retention','communications','assets','procurement','tickets','posdevices','approvals'],
      manager:['retention','communications','assets','procurement','tickets','posdevices','approvals'],
      cashier:['communications','tickets','posdevices'],
      inventory:['assets','procurement']
    }[role]||[];
    return [...new Set([...basePages,...extra])];
  }
  const pageCaps={
    overview:['dashboard.read'],appointments:['appointments.manage'],queue:['appointments.manage'],
    customers:['customers.read'],team:['appointments.manage'],services:['services.read'],
    checkout:['sales.manage'],inventory:['inventory.read'],payments:['payments.read'],
    finance:['finance.read','finance.manage'],reports:['reports.read'],retention:['retention.manage'],
    communications:['communications.manage'],assets:['assets.manage'],procurement:['procurement.manage'],
    tickets:['tickets.manage'],posdevices:['sales.manage'],approvals:['approvals.review'],
    access:['access.manage','roles.manage'],audit:['audit.read','system.read'],settings:['settings.manage']
  };
  return Object.entries(pageCaps).filter(([,required])=>required.some(x=>caps.has(x))).map(([page])=>page);
};

const oldRenderAll=renderAll;
renderAll=function(){
  oldRenderAll();
  renderCustomer360Actions();
  renderServiceApprovalActions();
  installEnterprisePanels();
  loadEnterpriseSummary();
};

function installEnterprisePanels(){
  const inventory=document.getElementById('inventory');
  if(inventory&&!document.getElementById('inventoryAlertPanel')){
    inventory.insertAdjacentHTML('beforeend','<div class="card" id="inventoryAlertPanel" style="margin-top:16px"><div class="card-head"><div><h3>Reorder alerts</h3><small>Automatic low-stock monitoring</small></div><button class="btn sm" onclick="loadInventoryAlerts()">Refresh</button></div><div id="inventoryAlertTable"></div></div>');
  }
  const paymentModal=document.getElementById('paymentModal');
  if(paymentModal&&document.getElementById('paymentMethod')&&!document.querySelector('#paymentMethod option[value="pos_terminal"]')){
    paymentMethod.insertAdjacentHTML('beforeend','<option value="pos_terminal">Registered POS terminal</option>');
    const notice=document.getElementById('paymentModeNotice')?.closest('.field');
    if(notice){
      notice.insertAdjacentHTML('beforebegin','<div class="field wide" id="paymentPosWrap" style="display:none"><div class="form-grid"><div class="field"><label>POS device</label><select id="paymentPosDevice"></select></div><div class="field"><label>Terminal payment type</label><select id="paymentPosMethod"><option value="card">Card</option><option value="mobile_money">Mobile Money</option></select></div></div></div>');
    }
  }
  const payments=document.getElementById('payments');
  if(payments&&!document.getElementById('paymentOperationsPanel')){
    payments.insertAdjacentHTML('beforeend',`<div class="card" id="paymentOperationsPanel" style="margin-top:16px"><div class="card-head"><div><h3>Payment Operations & Reconciliation</h3><small>Payment intents, settlement control, review exceptions and POS readiness</small></div><button class="btn sm" onclick="loadPaymentOperations()">Refresh</button></div><div id="paymentOperationsBody"><div class="empty">Open Payments to load payment operations.</div></div></div>`);
  }
  const finance=document.getElementById('finance');
  if(finance&&!document.getElementById('enterpriseFinancePanel')){
    finance.insertAdjacentHTML('beforeend',`<div class="card" id="enterpriseFinancePanel" style="margin-top:16px"><div class="card-head"><div><h3>Finance & Accounts</h3><small>Chart of accounts, journals, vendors, budgets and taxes</small></div><button class="btn sm" onclick="loadEnterpriseFinance()">Refresh</button></div><div class="enterprise-tabs" id="financeTabs"><button class="enterprise-tab active" data-fin="overview">Overview</button><button class="enterprise-tab" data-fin="journals">Journals</button><button class="enterprise-tab" data-fin="accounts">Chart of Accounts</button><button class="enterprise-tab" data-fin="vendors">Vendors</button><button class="enterprise-tab" data-fin="budgets">Budgets</button><button class="enterprise-tab" data-fin="taxes">Taxes</button></div><div id="enterpriseFinanceBody"><div class="empty">Open Finance to load accounts.</div></div></div>`);
    finance.querySelectorAll('[data-fin]').forEach(b=>b.onclick=()=>{finance.dataset.fin=b.dataset.fin;finance.querySelectorAll('[data-fin]').forEach(x=>x.classList.toggle('active',x===b));renderEnterpriseFinance()});
  }
  const access=document.getElementById('access');
  if(access&&!document.getElementById('roleCapabilityPanel')){
    access.insertAdjacentHTML('beforeend','<div class="card" id="roleCapabilityPanel" style="margin-top:16px"><div class="card-head"><div><h3>Roles & Privileges</h3><small>School-style granular module access for Shop</small></div><button class="btn sm primary" onclick="openModal(\'roleModal\')">+ Custom role</button></div><div id="roleCapabilityBody"><div class="empty">Open Access & Roles to load privilege controls.</div></div></div>');
  }
  const audit=document.getElementById('audit');
  if(audit&&!document.getElementById('systemDiagnosticsPanel')){
    audit.insertAdjacentHTML('afterbegin',`<div class="card" id="systemDiagnosticsPanel" style="margin-bottom:16px"><div class="card-head"><div><h3>System & Integration Diagnostics</h3><small>Core OS, database, payment, messaging, portal, POS and control services</small></div><button class="btn sm" onclick="loadSystemDiagnostics()">Run checks</button></div><div id="systemDiagnosticsBody"><div class="empty">Run checks to view current integration status.</div></div></div>`);
  }
  const settings=document.getElementById('settings');
  if(settings&&!document.getElementById('automationPanel')){
    settings.insertAdjacentHTML('beforeend',`<div class="card" id="automationPanel" style="margin-top:16px"><div class="card-head"><div><h3>Automation & Customer Controls</h3><small>Inactive customer threshold, welcome discount, reorder alerts and automated end-of-day close</small></div><button class="btn sm" onclick="loadAutomationSettings()">Reload</button></div><form id="automationForm" class="form-grid"><div class="field"><label>Inactive after (days)</label><input name="inactivityDays" type="number" min="30" value="90"></div><div class="field"><label>Customer registration discount %</label><input name="welcomeDiscountPercent" type="number" min="0" max="100" value="10"></div><div class="field"><label>Automatic EOD close</label><select name="autoEodEnabled"><option value="true">Enabled</option><option value="false">Disabled</option></select></div><div class="field"><label>Automatic EOD time</label><input name="autoEodTime" type="time" value="21:00"></div><div class="field"><label>Reorder alerts</label><select name="reorderAlertsEnabled"><option value="true">Enabled</option><option value="false">Disabled</option></select></div><div class="field wide"><div class="notice">Automatic cash close creates a system EOD snapshot from recorded transactions and marks it for physical cash review.</div></div><div class="field wide"><button class="btn primary" style="width:100%">Save automation settings</button></div></form><div id="portalLinks" style="margin-top:14px"></div></div>`);
    document.getElementById('automationForm').onsubmit=saveAutomationSettings;
  }
}

async function loadEnterpriseSummary(){
  try{
    const x=await api('/api/enterprise/summary');
    const overview=document.getElementById('overview');
    if(overview&&!document.getElementById('enterpriseSummary')){
      const el=document.createElement('div');el.id='enterpriseSummary';el.className='enterprise-kpis';const hero=overview.querySelector('.hero');hero?.insertAdjacentElement('afterend',el);
    }
    const el=document.getElementById('enterpriseSummary');
    if(el)el.innerHTML=[
      ['Inactive customers',x.inactive_customers],['Inventory alerts',x.inventory_alerts],['Pending approvals',x.pending_approvals],
      ['Open tickets',x.open_tickets],['Customer chats',x.open_conversations],['EOD review',x.eod_review_required]
    ].map(x=>'<div class="enterprise-kpi"><small>'+x[0]+'</small><b>'+Number(x[1]||0)+'</b></div>').join('');
  }catch{}
}

window.loadEnterprisePage=async function(page){
  if(page==='retention')return loadRetention();
  if(page==='communications')return loadConversations();
  if(page==='assets')return loadAssets();
  if(page==='procurement')return loadProcurement();
  if(page==='tickets')return loadTickets();
  if(page==='posdevices')return loadPosDevices();
  if(page==='approvals')return loadApprovals();
  if(page==='payments')return loadPaymentOperations();
  if(page==='audit')return loadSystemDiagnostics();
  if(page==='finance')return loadEnterpriseFinance();
  if(page==='access')return loadRoleCapabilities();
  if(page==='settings'){await loadAutomationSettings();return}
  if(page==='inventory')return loadInventoryAlerts();
};
document.querySelectorAll('.navbtn').forEach(btn=>{
  if(['finance','access','settings','inventory','payments','audit'].includes(btn.dataset.page)){
    btn.addEventListener('click',()=>setTimeout(()=>loadEnterprisePage(btn.dataset.page),0));
  }
});

window.refreshCustomerLifecycle=async function(){try{await api('/api/customers/lifecycle/refresh',{method:'POST',body:'{}'});showToast('Customer lifecycle updated');await reloadAll();await loadRetention()}catch(e){showToast(e.message)}};
window.loadRetention=async function(){
  try{
    const rows=await api('/api/customers/inactive?shopId='+encodeURIComponent(selectedShopId));
    retentionKpis.innerHTML='<div class="enterprise-kpi"><small>Inactive customers</small><b>'+rows.length+'</b></div><div class="enterprise-kpi"><small>Threshold</small><b>90+ days</b></div><div class="enterprise-kpi"><small>Bulk channels</small><b>SMS · WA</b></div>';
    inactiveCustomerTable.innerHTML=table([
      ['Customer',x=>'<b>'+esc(x.name)+'</b><br><small class="muted">'+esc(x.phone||x.email||'No contact')+'</small>'],
      ['Last visit',x=>esc(x.last_visit_at?new Date(x.last_visit_at).toLocaleDateString():'No completed visit')],
      ['Days away',x=>'<b>'+Number(x.days_since_visit||0)+'</b>'],
      ['Status',x=>tag(x.status)],
      ['Action',x=>'<div class="toolbar"><button class="btn sm" onclick="openCustomer360(\''+x.id+'\')">360</button><button class="btn sm soft" onclick="openCustomerMessage(\''+x.id+'\',\''+esc(x.name).replace(/'/g,'&#39;')+'\')">Message</button></div>']
    ],rows);
  }catch(e){inactiveCustomerTable.innerHTML='<div class="empty">'+esc(e.message)+'</div>'}
};
window.openCustomerMessage=function(id,name){
  messageCustomerId.value=id;messageBulk.value='';customerMessageTitle.textContent='Message '+name;openModal('customerMessageModal');
};
window.openBulkCustomerMessage=function(){
  messageCustomerId.value='';messageBulk.value='1';customerMessageTitle.textContent='Message all inactive customers';openModal('customerMessageModal');
};
customerMessageForm.onsubmit=async e=>{
  e.preventDefault();
  const body=messageBody.value.trim(),channel=messageChannel.value,subject=messageSubject.value.trim()||undefined;
  if(!body)return;
  try{
    if(messageBulk.value)await api('/api/customers/inactive/communications',{method:'POST',body:JSON.stringify({shopId:selectedShopId,channel,body,subject})});
    else await api('/api/customers/'+encodeURIComponent(messageCustomerId.value)+'/communications',{method:'POST',body:JSON.stringify({channel,body,subject})});
    closeModal('customerMessageModal');showToast(messageBulk.value?'Retention campaign queued':'Customer message queued');
  }catch(err){showToast(err.message)}
};

function renderCustomer360Actions(){
  if(!document.getElementById('customerTable'))return;
  const canView=['shop_admin','manager','cashier','finance','service','auditor'].includes(base.role);
  if(!canView)return;
  customerTable.innerHTML=table([
    ['Customer',c=>'<b>'+esc(c.name)+'</b><br><small class="muted">'+esc(c.customer_no||'')+'</small>'],
    ['Phone',c=>esc(c.phone||'—')],['Email',c=>esc(c.email||'—')],
    ['Last visit',c=>c.last_visit_at?new Date(c.last_visit_at).toLocaleDateString():'—'],
    ['Status',c=>tag(c.status)],
    ['Action',c=>'<div class="toolbar"><button class="btn sm" onclick="openCustomer360(\''+c.id+'\')">Customer 360</button>'+(c.status==='inactive'&&['shop_admin','manager','cashier'].includes(base.role)?'<button class="btn sm soft" onclick="openCustomerMessage(\''+c.id+'\',\''+esc(c.name).replace(/'/g,'&#39;')+'\')">Message</button>':'')+'</div>']
  ],filtered(base.customers));
}
window.openCustomer360=async function(id){
  customer360Body.innerHTML='<div class="empty">Loading customer profile…</div>';openModal('customer360Modal');
  try{
    const d=await api('/api/customers/'+encodeURIComponent(id)+'/360'),c=d.customer,m=d.metrics;
    const phone=String(c.phone||'').replace(/\D/g,'');let wap=phone;if(wap.startsWith('0'))wap='233'+wap.slice(1);
    customer360Body.innerHTML=`<div class="page-head"><div><h1 style="margin:0">${esc(c.name)}</h1><div class="muted">${esc(c.customer_no||'')} · ${esc(c.shop_name||'')}</div></div><div class="toolbar"><button class="btn soft" onclick="openCustomerMessage('${c.id}','${esc(c.name).replace(/'/g,'&#39;')}')">Message</button>${wap?'<a class="btn primary" target="_blank" rel="noopener" href="https://wa.me/'+wap+'">WhatsApp</a>':''}</div></div>
    <div class="metric-strip"><div><small>Total visits</small><b>${m.visits}</b></div><div><small>Lifetime spend</small><b>${money(m.lifetimeSpend)}</b></div><div><small>Average spend</small><b>${money(m.averageSpend)}</b></div><div><small>Loyalty points</small><b>${m.loyaltyPoints}</b></div></div>
    <div class="enterprise-grid" style="margin-top:14px"><div class="card"><h3>Customer profile</h3><p><b>Phone:</b> ${esc(c.phone||'—')}<br><b>Email:</b> ${esc(c.email||'—')}<br><b>Status:</b> ${esc(c.status)}<br><b>Last visit:</b> ${m.lastVisit?new Date(m.lastVisit).toLocaleString():'—'}<br><b>Preferred barber:</b> ${esc(c.preferred_barber||'—')}<br><b>Preferred service:</b> ${esc(c.preferred_service||'—')}</p><p class="muted">${esc(c.haircut_notes||'')}</p></div><div class="card"><h3>Activity</h3><div class="timeline-list">${d.visits.slice(0,8).map(v=>'<div class="timeline-item"><b>'+esc(v.service_name||'Salon visit')+'</b><small>'+new Date(v.booked_for).toLocaleString()+' · '+esc(v.barber_name||'Any barber')+' · '+esc(v.status)+'</small></div>').join('')||'<div class="empty">No visit activity yet.</div>'}</div></div></div>
    <div class="card" style="margin-top:14px"><h3>Recent invoices & payments</h3>${table([['Invoice',x=>esc(x.order_no)],['Total',x=>money(x.total)],['Paid',x=>money(x.amount_paid)],['Balance',x=>money(x.balance)],['Status',x=>tag(x.status)]],d.orders.slice(0,10))}</div>`;
  }catch(e){customer360Body.innerHTML='<div class="empty">'+esc(e.message)+'</div>'}
};

let activeConversation=null;
window.loadConversations=async function(){
  try{
    const rows=await api('/api/conversations?shopId='+encodeURIComponent(selectedShopId));
    conversationList.innerHTML=rows.map(x=>'<button class="conversation-card" data-conv="'+x.id+'" onclick="openConversation(\''+x.id+'\')"><b>'+esc(x.customer_name||'Customer')+'</b><small>'+esc(x.last_message||x.subject||'No message yet')+'</small></button>').join('')||'<div class="empty">No conversations yet. Customer portal messages will appear here.</div>';
  }catch(e){conversationList.innerHTML='<div class="empty">'+esc(e.message)+'</div>'}
};
window.openConversation=async function(id){
  try{
    const rows=await api('/api/conversations?shopId='+encodeURIComponent(selectedShopId)),conv=rows.find(x=>x.id===id);activeConversation=conv||null;
    document.querySelectorAll('.conversation-card').forEach(x=>x.classList.toggle('active',x.dataset.conv===id));
    conversationTitle.textContent=conv?.customer_name||'Customer conversation';conversationContact.textContent=conv?.customer_phone||'';
    let p=String(conv?.customer_phone||'').replace(/\D/g,'');if(p.startsWith('0'))p='233'+p.slice(1);conversationWhatsApp.style.display=p?'inline-flex':'none';conversationWhatsApp.href=p?'https://wa.me/'+p:'#';
    activeConversationId.value=id;
    const messages=await api('/api/conversations/'+encodeURIComponent(id)+'/messages');
    conversationMessages.innerHTML=messages.map(m=>'<div class="admin-bubble '+(m.sender_type==='staff'?'staff':'')+'">'+esc(m.body)+'<small>'+esc(m.sender_type)+' · '+new Date(m.created_at).toLocaleString()+'</small></div>').join('')||'<div class="empty">No messages yet.</div>';conversationMessages.scrollTop=conversationMessages.scrollHeight;
  }catch(e){showToast(e.message)}
};
conversationReplyForm.onsubmit=async e=>{
  e.preventDefault();if(!activeConversationId.value)return showToast('Select a conversation first');
  try{await api('/api/conversations/'+encodeURIComponent(activeConversationId.value)+'/messages',{method:'POST',body:JSON.stringify({body:conversationReply.value,channel:conversationChannel.value})});conversationReply.value='';await openConversation(activeConversationId.value)}catch(err){showToast(err.message)}
};

window.loadAssets=async function(){
  try{
    const [assets,alerts]=await Promise.all([api('/api/assets?shopId='+encodeURIComponent(selectedShopId)),api('/api/inventory/alerts?shopId='+encodeURIComponent(selectedShopId))]);
    assetTable.innerHTML=table([
      ['Asset',x=>'<b>'+esc(x.name)+'</b><br><small class="muted">'+esc(x.asset_no)+'</small>'],['Category',x=>esc(x.category)],['Condition',x=>esc(x.condition)],['Status',x=>tag(x.status)],['Next service',x=>esc(x.next_service_date||'—')],['Action',x=>'<button class="btn sm" onclick="openMaintenance(\''+x.id+'\')">Maintenance</button>']
    ],assets);
    renderAlerts(alerts);
  }catch(e){assetTable.innerHTML='<div class="empty">'+esc(e.message)+'</div>'}
};
window.loadInventoryAlerts=async function(){
  try{const rows=await api('/api/inventory/alerts?shopId='+encodeURIComponent(selectedShopId));if(document.getElementById('inventoryAlertTable'))inventoryAlertTable.innerHTML=renderAlertTable(rows);if(document.getElementById('enterpriseAlerts'))renderAlerts(rows)}catch(e){if(document.getElementById('inventoryAlertTable'))inventoryAlertTable.innerHTML='<div class="empty">'+esc(e.message)+'</div>'}
};
function renderAlertTable(rows){return table([['Alert',x=>'<b>'+esc(x.product_name||x.asset_name||x.alert_type)+'</b><br><small class="muted">'+esc(x.message)+'</small>'],['Type',x=>esc(x.alert_type)],['Stock',x=>x.product_id?(Number(x.stock_quantity)+' / reorder '+Number(x.reorder_level)):'—'],['Status',x=>tag(x.status)],['Action',x=>x.status!=='resolved'?'<button class="btn sm" onclick="resolveInventoryAlert(\''+x.id+'\')">Resolve</button>':'']],rows)}
function renderAlerts(rows){enterpriseAlerts.innerHTML=renderAlertTable(rows)}
window.resolveInventoryAlert=async function(id){try{await api('/api/inventory/alerts/'+id,{method:'PATCH',body:JSON.stringify({status:'resolved'})});await loadInventoryAlerts()}catch(e){showToast(e.message)}};
assetForm.onsubmit=async e=>{e.preventDefault();const f=Object.fromEntries(new FormData(assetForm));try{await api('/api/assets',{method:'POST',body:JSON.stringify({shopId:selectedShopId,branchId:selectedBranchId||undefined,assetNo:f.assetNo,name:f.name,category:f.category,brand:f.brand||undefined,model:f.model||undefined,serialNumber:f.serialNumber||undefined,purchaseCost:Number(f.purchaseCost||0),nextServiceDate:f.nextServiceDate||undefined,notes:f.notes||undefined})});assetForm.reset();closeModal('assetModal');showToast('Equipment added');await loadAssets()}catch(err){showToast(err.message)}};
window.openMaintenance=function(id){maintenanceAssetId.value=id;maintenanceForm.reset();maintenanceAssetId.value=id;openModal('maintenanceModal')};
maintenanceForm.onsubmit=async e=>{e.preventDefault();try{await api('/api/assets/'+maintenanceAssetId.value+'/maintenance',{method:'POST',body:JSON.stringify({maintenanceType:maintenanceType.value,description:maintenanceDescription.value||undefined,cost:Number(maintenanceCost.value||0),vendorName:maintenanceVendor.value||undefined,nextServiceDate:maintenanceNext.value||undefined})});closeModal('maintenanceModal');showToast('Maintenance recorded');await loadAssets()}catch(err){showToast(err.message)}};

function renderServiceApprovalActions(){
  if(!document.getElementById('serviceGrid'))return;
  const canEdit=['shop_admin','manager'].includes(base.role);
  serviceGrid.innerHTML=filtered(base.services).length?filtered(base.services).map(s=>'<div class="service-card"><div style="display:flex;justify-content:space-between;gap:10px"><b>'+esc(s.name)+'</b>'+tag(s.category||'service')+'</div><p>'+esc(s.description||'Salon service')+'</p><div class="price">'+money(s.price)+'</div><div class="service-meta"><small>'+Number(s.duration_minutes||0)+' min · '+Number(s.deposit_percent||0)+'% deposit</small>'+(canEdit?'<div class="toolbar"><button class="btn sm" onclick="openServiceEdit(\''+s.id+'\')">Edit</button><button class="btn sm danger" onclick="requestServiceDelete(\''+s.id+'\')">Deactivate</button></div>':'')+'</div></div>').join(''):'<div class="empty">No services configured.</div>';
}
window.openServiceEdit=function(id){const s=(base.services||[]).find(x=>x.id===id);if(!s)return;editServiceId.value=s.id;editServiceName.value=s.name;editServiceCategory.value=s.category||'';editServicePrice.value=s.price;editServiceDuration.value=s.duration_minutes||30;editServiceDeposit.value=s.deposit_percent||0;editServiceDescription.value=s.description||'';editServiceReason.value='';openModal('serviceEditModal')};
serviceEditForm.onsubmit=async e=>{e.preventDefault();try{await api('/api/services/'+editServiceId.value,{method:'PATCH',body:JSON.stringify({name:editServiceName.value,category:editServiceCategory.value||undefined,description:editServiceDescription.value||undefined,price:Number(editServicePrice.value),durationMinutes:Number(editServiceDuration.value),depositPercent:Number(editServiceDeposit.value||0),reason:editServiceReason.value})});closeModal('serviceEditModal');showToast('Service change submitted for approval');await loadApprovals()}catch(err){showToast(err.message)}};
window.requestServiceDelete=function(id){openActionPrompt({title:'Deactivate service',notice:'The service will remain live until the change is approved.',label:'Reason for deactivation',required:true,button:'Submit for approval',onSubmit:async({text})=>{await api('/api/services/'+id,{method:'DELETE',body:JSON.stringify({reason:text})});showToast('Service deactivation submitted for approval');await loadApprovals()}})};

window.loadApprovals=async function(){
  try{const rows=await api('/api/approvals?status=pending');approvalTable.innerHTML=table([
    ['Request',x=>'<b>'+esc(x.request_title)+'</b><br><small class="muted">'+esc(x.action_key)+'</small>'],['Reason',x=>esc(x.reason||'—')],['Requested',x=>new Date(x.requested_at).toLocaleString()],['Approvals',x=>Number(x.approvals||0)],['Action',x=>'<div class="toolbar"><button class="btn sm primary" onclick="reviewApproval(\''+x.id+'\',\'approve\')">Approve</button><button class="btn sm danger" onclick="reviewApproval(\''+x.id+'\',\'reject\')">Reject</button></div>']
  ],rows)}catch(e){approvalTable.innerHTML='<div class="empty">'+esc(e.message)+'</div>'}
};
window.reviewApproval=function(id,action){openActionPrompt({title:action==='approve'?'Approve request':'Reject request',notice:action==='approve'?'Confirm that this controlled change can be applied to the live system.':'Rejecting prevents this request from changing the live system.',label:action==='approve'?'Approval comment':'Reason for rejection',required:action==='reject',button:action==='approve'?'Approve':'Reject',onSubmit:async({text})=>{await api('/api/approvals/'+id+'/review',{method:'POST',body:JSON.stringify({action,comment:text||undefined})});showToast(action==='approve'?'Request approved':'Request rejected');await Promise.all([loadApprovals(),reloadAll()])}})};

let enterpriseFinance=null;
window.loadEnterpriseFinance=async function(){
  if(!selectedShopId)return;
  try{enterpriseFinance=await api('/api/finance/overview?shopId='+encodeURIComponent(selectedShopId));renderEnterpriseFinance()}catch(e){if(document.getElementById('enterpriseFinanceBody'))enterpriseFinanceBody.innerHTML='<div class="empty">'+esc(e.message)+'</div>'}
};
window.renderEnterpriseFinance=function(){
  if(!enterpriseFinance||!document.getElementById('enterpriseFinanceBody'))return;
  const tab=document.getElementById('finance')?.dataset.fin||'overview',d=enterpriseFinance;
  if(tab==='overview'){enterpriseFinanceBody.innerHTML='<div class="finance-summary"><div><small>Total receipts</small><b>'+money(d.summary?.receipts)+'</b></div><div><small>Total expenses</small><b>'+money(d.summary?.expenses)+'</b></div><div><small>Receivables</small><b>'+money(d.summary?.receivables)+'</b></div></div><div class="notice" style="margin-top:12px">Payments and expenses remain connected to Shop operational ledgers. Manual finance journals use balanced double-entry posting.</div>';return}
  if(tab==='accounts'){enterpriseFinanceBody.innerHTML='<div class="page-head"><h3>Chart of Accounts</h3><button class="btn sm primary" onclick="openFinanceForm(\'account\')">+ Account</button></div>'+table([['Code',x=>esc(x.code)],['Account',x=>'<b>'+esc(x.name)+'</b>'],['Type',x=>esc(x.account_type)],['Subtype',x=>esc(x.subtype||'')],['Balance',x=>money(x.balance)]],d.accounts);return}
  if(tab==='journals'){enterpriseFinanceBody.innerHTML='<div class="page-head"><h3>General Journals</h3><button class="btn sm primary" onclick="openFinanceForm(\'journal\')">+ Journal</button></div>'+table([['Date',x=>esc(x.entry_date)],['Entry',x=>'<b>'+esc(x.entry_no)+'</b>'],['Description',x=>esc(x.description)],['Debit',x=>money(x.total_debit)],['Credit',x=>money(x.total_credit)],['Status',x=>tag(x.status)],['Action',x=>x.status==='posted'&&['shop_admin','finance'].includes(base.role)?'<button class="btn sm danger" onclick="reverseFinanceJournal(\''+x.id+'\',\''+esc(x.entry_no)+'\')">Reverse</button>':'']],d.journals);return}
  if(tab==='vendors'){enterpriseFinanceBody.innerHTML='<div class="page-head"><h3>Vendors & Suppliers</h3><button class="btn sm primary" onclick="openFinanceForm(\'vendor\')">+ Vendor</button></div>'+table([['Vendor',x=>'<b>'+esc(x.name)+'</b>'],['Contact',x=>esc(x.contact_person||'')],['Phone',x=>esc(x.phone||'')],['Email',x=>esc(x.email||'')]],d.vendors);return}
  if(tab==='budgets'){enterpriseFinanceBody.innerHTML='<div class="page-head"><h3>Budgets</h3><button class="btn sm primary" onclick="openFinanceForm(\'budget\')">+ Budget</button></div>'+table([['Account',x=>esc(x.account_code)+' '+esc(x.account_name)],['From',x=>esc(x.period_start)],['To',x=>esc(x.period_end)],['Amount',x=>money(x.amount)]],d.budgets);return}
  if(tab==='taxes'){enterpriseFinanceBody.innerHTML='<div class="page-head"><h3>Taxes & Statutory Obligations</h3><div class="toolbar"><button class="btn sm" onclick="openFinanceForm(\'taxType\')">Tax setup</button><button class="btn sm primary" onclick="openFinanceForm(\'taxObligation\')">+ Obligation</button></div></div>'+table([['Tax',x=>'<b>'+esc(x.tax_name)+'</b>'],['Period',x=>esc(x.period_start)+' → '+esc(x.period_end)],['Due date',x=>esc(x.due_date||'—')],['Amount',x=>money(x.amount_due)],['Paid',x=>money(x.amount_paid)],['Status',x=>tag(x.status)]],d.taxObligations)+'<div class="card" style="margin-top:12px"><h4>Tax types</h4>'+table([['Code',x=>esc(x.code)],['Name',x=>esc(x.name)],['Rate',x=>Number(x.rate)+'%'],['Authority',x=>esc(x.authority||'')]],d.taxTypes)+'</div>';return}
};
window.reverseFinanceJournal=function(id,entryNo){openActionPrompt({title:'Reverse '+entryNo,notice:'A balanced reversal journal will be created and the original entry will be marked voided. The accounting history is preserved.',label:'Reason for reversal',required:true,button:'Post reversal',onSubmit:async({text})=>{await api('/api/finance/journals/'+id+'/reverse',{method:'POST',body:JSON.stringify({reason:text})});showToast('Journal reversed');await loadEnterpriseFinance()}})};

window.openFinanceForm=function(type){
  const accounts=enterpriseFinance?.accounts||[],taxes=enterpriseFinance?.taxTypes||[];
  financeEntryTitle.textContent={account:'Add finance account',vendor:'Add vendor',journal:'Post journal',budget:'Create budget',taxType:'Tax setup',taxObligation:'New tax obligation'}[type]||'Finance entry';
  let html='';
  if(type==='account')html='<form id="financeDynamicForm" class="form-grid"><div class="field"><label>Code</label><input name="code" required></div><div class="field"><label>Name</label><input name="name" required></div><div class="field"><label>Type</label><select name="accountType"><option>asset</option><option>liability</option><option>equity</option><option>income</option><option>expense</option></select></div><div class="field"><label>Subtype</label><input name="subtype"></div><div class="field"><label>Opening balance</label><input name="openingBalance" type="number" step="0.01" value="0"></div><div class="field"><label>Cash account</label><select name="isCashAccount"><option value="false">No</option><option value="true">Yes</option></select></div><div class="field wide"><button class="btn primary">Save account</button></div></form>';
  if(type==='vendor')html='<form id="financeDynamicForm" class="form-grid"><div class="field wide"><label>Name</label><input name="name" required></div><div class="field"><label>Contact person</label><input name="contactPerson"></div><div class="field"><label>Tax ID</label><input name="taxId"></div><div class="field"><label>Phone</label><input name="phone"></div><div class="field"><label>Email</label><input name="email" type="email"></div><div class="field wide"><label>Address</label><input name="address"></div><div class="field wide"><button class="btn primary">Save vendor</button></div></form>';
  if(type==='journal')html='<form id="financeDynamicForm" class="form-grid"><div class="field"><label>Date</label><input name="entryDate" type="date"></div><div class="field"><label>Reference</label><input name="reference"></div><div class="field wide"><label>Description</label><input name="description" required></div><div class="field"><label>Debit account</label><select name="debitAccount">'+accounts.map(x=>'<option value="'+x.id+'">'+esc(x.code)+' '+esc(x.name)+'</option>').join('')+'</select></div><div class="field"><label>Credit account</label><select name="creditAccount">'+accounts.map(x=>'<option value="'+x.id+'">'+esc(x.code)+' '+esc(x.name)+'</option>').join('')+'</select></div><div class="field wide"><label>Amount</label><input name="amount" type="number" min="0.01" step="0.01" required></div><div class="field wide"><button class="btn primary">Post balanced journal</button></div></form>';
  if(type==='budget')html='<form id="financeDynamicForm" class="form-grid"><div class="field wide"><label>Account</label><select name="accountId">'+accounts.map(x=>'<option value="'+x.id+'">'+esc(x.code)+' '+esc(x.name)+'</option>').join('')+'</select></div><div class="field"><label>From</label><input name="periodStart" type="date" required></div><div class="field"><label>To</label><input name="periodEnd" type="date" required></div><div class="field wide"><label>Amount</label><input name="amount" type="number" min="0" step="0.01" required></div><div class="field wide"><button class="btn primary">Create budget</button></div></form>';
  if(type==='taxType')html='<form id="financeDynamicForm" class="form-grid"><div class="field"><label>Code</label><input name="code" required placeholder="VAT"></div><div class="field"><label>Name</label><input name="name" required></div><div class="field"><label>Rate %</label><input name="rate" type="number" min="0" max="100" step="0.01" required></div><div class="field"><label>Authority</label><input name="authority"></div><div class="field wide"><button class="btn primary">Save tax type</button></div></form>';
  if(type==='taxObligation')html='<form id="financeDynamicForm" class="form-grid"><div class="field wide"><label>Tax type</label><select name="taxTypeId">'+taxes.map(x=>'<option value="'+x.id+'">'+esc(x.code)+' '+esc(x.name)+'</option>').join('')+'</select></div><div class="field"><label>Period start</label><input name="periodStart" type="date" required></div><div class="field"><label>Period end</label><input name="periodEnd" type="date" required></div><div class="field"><label>Due date</label><input name="dueDate" type="date"></div><div class="field"><label>Amount due</label><input name="amountDue" type="number" min="0" step="0.01" required></div><div class="field wide"><button class="btn primary">Create obligation</button></div></form>';
  financeEntryBody.innerHTML=html;openModal('financeEntryModal');
  document.getElementById('financeDynamicForm').onsubmit=async e=>{
    e.preventDefault();const f=Object.fromEntries(new FormData(e.target));let path='',body={shopId:selectedShopId};
    if(type==='account'){path='/api/finance/accounts';Object.assign(body,{code:f.code,name:f.name,accountType:f.accountType,subtype:f.subtype||undefined,isCashAccount:f.isCashAccount==='true',openingBalance:Number(f.openingBalance||0)})}
    if(type==='vendor'){path='/api/finance/vendors';Object.assign(body,{name:f.name,contactPerson:f.contactPerson||undefined,taxId:f.taxId||undefined,phone:f.phone||undefined,email:f.email||undefined,address:f.address||undefined})}
    if(type==='journal'){path='/api/finance/journals';const amount=Number(f.amount);Object.assign(body,{branchId:selectedBranchId||undefined,entryDate:f.entryDate||undefined,reference:f.reference||undefined,description:f.description,lines:[{accountId:f.debitAccount,debit:amount,credit:0},{accountId:f.creditAccount,debit:0,credit:amount}]})}
    if(type==='budget'){path='/api/finance/budgets';Object.assign(body,{accountId:f.accountId,periodStart:f.periodStart,periodEnd:f.periodEnd,amount:Number(f.amount)})}
    if(type==='taxType'){path='/api/finance/tax-types';Object.assign(body,{code:f.code,name:f.name,rate:Number(f.rate),authority:f.authority||undefined})}
    if(type==='taxObligation'){path='/api/finance/tax-obligations';Object.assign(body,{taxTypeId:f.taxTypeId,periodStart:f.periodStart,periodEnd:f.periodEnd,dueDate:f.dueDate||undefined,amountDue:Number(f.amountDue)})}
    try{await api(path,{method:'POST',body:JSON.stringify(body)});closeModal('financeEntryModal');showToast('Finance record saved');await loadEnterpriseFinance()}catch(err){showToast(err.message)}
  };
};

let roleData=null,selectedRoleKey=null;
renderAccess=function(){
  const fallback=['shop_admin','manager','cashier','finance','service','inventory','auditor'].map(key=>({key,name:key.replaceAll('_',' ')}));
  const roles=roleData?.roles?.length?roleData.roles:fallback;
  const editable=base.role==='shop_admin';
  accessTable.innerHTML=table([
    ['User',u=>'<b>'+esc((u.first_name||'')+' '+(u.last_name||''))+'</b><br><small class="muted">'+esc(u.email)+'</small>'],
    ['Core status',u=>tag(u.membership_status||u.core_status)],
    ['Shop role',u=>editable?'<select id="role-'+u.user_id+'">'+roles.map(r=>'<option value="'+esc(r.key)+'" '+(u.shop_role===r.key?'selected':'')+'>'+esc(r.name||r.key.replaceAll('_',' '))+'</option>').join('')+'</select>':tag(u.shop_role||'not assigned')],
    ['Shop status',u=>editable?'<select id="status-'+u.user_id+'"><option value="active" '+(u.shop_status!=='inactive'?'selected':'')+'>active</option><option value="inactive" '+(u.shop_status==='inactive'?'selected':'')+'>inactive</option></select>':tag(u.shop_status||'not assigned')],
    ['Action',u=>editable?'<button class="btn sm primary" onclick="saveAccess(\''+u.user_id+'\')">Submit change</button>':'Read only']
  ],accessUsers||[]);
};
saveAccess=function(userId){
  const role=document.getElementById('role-'+userId).value,status=document.getElementById('status-'+userId).value;
  openActionPrompt({title:'Change Shop access',notice:'Access changes are controlled and will not apply until approved.',label:'Reason for access change',required:true,button:'Submit for approval',onSubmit:async({text})=>{await api('/api/access/users/'+userId,{method:'PUT',body:JSON.stringify({role,status,reason:text})});showToast('Access change submitted for approval');await loadApprovals()}});
};

window.loadRoleCapabilities=async function(){
  if(!document.getElementById('roleCapabilityBody'))return;
  try{
    roleData=await api('/api/access/roles');selectedRoleKey=selectedRoleKey||roleData.roles[0]?.key||null;renderRoleCapabilities();renderAccess();const btn=document.querySelector('#roleCapabilityPanel .card-head .primary');if(btn)btn.style.display=base.role==='shop_admin'?'inline-flex':'none';
  }catch(e){roleCapabilityBody.innerHTML='<div class="empty">'+esc(e.message)+'</div>'}
};
function renderRoleCapabilities(){
  if(!roleData)return;
  const role=roleData.roles.find(x=>x.key===selectedRoleKey)||roleData.roles[0];if(!role)return;
  const explicit=roleData.grants.filter(x=>x.role===role.key);const grantMap=new Map(explicit.map(x=>[x.capability_key,x.allowed]));
  roleCapabilityBody.innerHTML='<div class="enterprise-grid"><div><label class="muted">Role</label><select id="roleSelect" class="shop-switch" style="width:100%;margin-top:5px">'+roleData.roles.map(x=>'<option value="'+x.key+'" '+(x.key===role.key?'selected':'')+'>'+esc(x.name)+'</option>').join('')+'</select><div class="notice" style="margin-top:10px">'+esc(role.description||'')+'</div></div><div><div class="cap-grid">'+roleData.capabilities.map(cap=>'<label class="cap-item"><input type="checkbox" data-cap="'+cap.key+'" '+(grantMap.get(cap.key)===true?'checked':'')+'><span><b>'+esc(cap.name)+'</b><small>'+esc(cap.module)+' · '+esc(cap.description||'')+'</small></span></label>').join('')+'</div><button id="saveRoleCaps" class="btn primary" style="margin-top:12px;width:100%">Save role privileges</button></div></div>';
  roleSelect.onchange=()=>{selectedRoleKey=roleSelect.value;renderRoleCapabilities()};
  saveRoleCaps.onclick=()=>{const caps=[...roleCapabilityBody.querySelectorAll('[data-cap]:checked')].map(x=>x.dataset.cap);openActionPrompt({title:'Submit privilege changes',notice:'Role privilege changes are controlled. The current access remains active until this request is approved.',label:'Reason for privilege change',required:true,button:'Submit for approval',onSubmit:async({text})=>{await api('/api/access/roles/'+encodeURIComponent(role.key)+'/capabilities',{method:'PUT',body:JSON.stringify({capabilities:caps,reason:text})});showToast('Role privilege change submitted for approval');await loadApprovals()}})};
}
roleForm.onsubmit=async e=>{e.preventDefault();const f=Object.fromEntries(new FormData(roleForm));try{await api('/api/access/roles',{method:'POST',body:JSON.stringify(f)});roleForm.reset();closeModal('roleModal');showToast('Custom role created');selectedRoleKey=f.key;await loadRoleCapabilities()}catch(err){showToast(err.message)}};

window.loadSystemDiagnostics=async function(){
  const el=document.getElementById('systemDiagnosticsBody');if(!el)return;
  try{
    const d=await api('/api/integrations/status');
    const cards=[
      ['Core Revolt-X OS',d.coreOs?.status||'unknown',d.coreOs?.configured],
      ['Railway Database',d.database?.status||'unknown',d.database?.configured],
      ['Online Payments',d.onlinePayments?.configured?'ready':'setup required',d.onlinePayments?.configured],
      ['SMS',d.messaging?.sms?.configured?'configured':'not configured',d.messaging?.sms?.configured],
      ['WhatsApp API',d.messaging?.whatsapp?.configured?'configured':'not configured',d.messaging?.whatsapp?.configured],
      ['Customer Portal',(d.customerPortal?.activeAccounts||0)+' active',d.customerPortal?.configured],
      ['POS Devices',(d.pos?.registeredDevices||0)+' registered',d.pos?.ready],
      ['Ticketing',d.ticketing?.ready?'ready':'unavailable',d.ticketing?.ready],
      ['Approvals',d.approvals?.ready?'ready':'unavailable',d.approvals?.ready],
      ['Finance & Accounts',d.finance?.ready?'ready':'unavailable',d.finance?.ready]
    ];
    el.innerHTML='<div class="enterprise-grid three">'+cards.map(x=>'<div class="card" style="box-shadow:none"><small class="muted">'+esc(x[0])+'</small><div style="margin-top:8px">'+tag(String(x[1]).replaceAll('_',' '))+'</div></div>').join('')+'</div>'+
      (d.onlinePayments?.webhookUrl?'<div class="notice" style="margin-top:12px"><b>Payment webhook</b><br>'+esc(d.onlinePayments.webhookUrl)+'</div>':'')+
      ((!d.messaging?.sms?.configured||!d.messaging?.whatsapp?.configured)?'<div class="notice" style="margin-top:10px">SMS and WhatsApp business delivery remain queued until provider credentials are configured. In-app chat and WhatsApp hand-off links continue to work.</div>':'');
  }catch(e){el.innerHTML='<div class="empty">'+esc(e.message)+'</div>'}
};

window.loadPaymentOperations=async function(){
  if(!selectedShopId||!document.getElementById('paymentOperationsBody'))return;
  try{
    const d=await api('/api/payments/operations?shopId='+encodeURIComponent(selectedShopId)),s=d.summary||{};
    paymentOperationsBody.innerHTML='<div class="enterprise-kpis"><div class="enterprise-kpi"><small>Successful</small><b>'+Number(s.successful||0)+'</b></div><div class="enterprise-kpi"><small>Pending</small><b>'+Number(s.pending||0)+'</b></div><div class="enterprise-kpi"><small>Review required</small><b>'+Number(s.review_required||0)+'</b></div><div class="enterprise-kpi"><small>Unreconciled</small><b>'+money(s.unreconciled_amount||0)+'</b></div></div><div class="enterprise-grid"><div><h4>Unreconciled payments</h4>'+table([['Reference',x=>'<b>'+esc(x.reference)+'</b><br><small>'+esc(x.provider)+'</small>'],['Invoice',x=>esc(x.order_no||'—')],['Method',x=>esc(x.method)],['Amount',x=>money(x.amount)],['Action',x=>['shop_admin','finance'].includes(base.role)?'<button class="btn sm primary" onclick="reconcilePayment(\''+x.id+'\')">Reconcile</button>':'']],d.unreconciled||[])+'</div><div><h4>POS payment intents</h4>'+table([['Invoice',x=>esc(x.order_no||'—')],['Device',x=>esc(x.device_name||'—')],['Method',x=>esc(x.method)],['Amount',x=>money(x.amount)],['Status',x=>tag(x.status)]],d.intents||[])+'</div></div>';
  }catch(e){paymentOperationsBody.innerHTML='<div class="empty">'+esc(e.message)+'</div>'}
};
window.reconcilePayment=async function(id){try{await api('/api/payments/'+id+'/reconcile',{method:'PATCH',body:JSON.stringify({note:'Reconciled from Shop payment operations'})});showToast('Payment reconciled');await Promise.all([reloadAll(),loadPaymentOperations()])}catch(e){showToast(e.message)}};

let actionPromptHandler=null;
window.openActionPrompt=function(opts){
  actionPromptTitle.textContent=opts.title||'Confirm action';
  actionPromptNotice.textContent=opts.notice||'';
  actionPromptInputLabel.textContent=opts.label||'Comment';
  actionPromptInput.value='';
  actionPromptInput.required=Boolean(opts.required);
  actionPromptSubmit.textContent=opts.button||'Continue';
  if(opts.options?.length){
    actionPromptSelectWrap.style.display='';
    actionPromptSelectLabel.textContent=opts.selectLabel||'Select';
    actionPromptSelect.innerHTML=opts.options.map(x=>'<option value="'+esc(x[0])+'">'+esc(x[1])+'</option>').join('');
  }else{
    actionPromptSelectWrap.style.display='none';
    actionPromptSelect.innerHTML='';
  }
  actionPromptHandler=opts.onSubmit||null;
  openModal('actionPromptModal');
};
actionPromptForm.onsubmit=async e=>{
  e.preventDefault();
  const handler=actionPromptHandler;if(!handler)return;
  actionPromptSubmit.disabled=true;
  try{await handler({text:actionPromptInput.value.trim(),value:actionPromptSelect.value});closeModal('actionPromptModal')}
  catch(err){showToast(err.message)}
  finally{actionPromptSubmit.disabled=false}
};

let procurementData=null;
window.loadProcurement=async function(){
  if(!selectedShopId)return;
  try{
    procurementData=await api('/api/procurement?shopId='+encodeURIComponent(selectedShopId));
    purchaseOrderTable.innerHTML=table([
      ['PO',x=>'<b>'+esc(x.po_no)+'</b><br><small class="muted">'+esc(x.vendor_name||'No supplier')+'</small>'],
      ['Date',x=>esc(x.order_date)],['Expected',x=>esc(x.expected_date||'—')],['Total',x=>money(x.total)],['Status',x=>tag(x.status)],
      ['Action',x=>{let h='<div class="toolbar">';if(x.status==='draft')h+='<button class="btn sm primary" onclick="submitPo(\''+x.id+'\')">Submit</button>';if(['approved','part_received'].includes(x.status))h+='<button class="btn sm soft" onclick="openReceivePo(\''+x.id+'\')">Receive</button>';return h+'</div>'}]
    ],procurementData.orders||[]);
    goodsReceiptTable.innerHTML=table([
      ['GRN',x=>'<b>'+esc(x.grn_no)+'</b><br><small class="muted">'+esc(x.po_no)+'</small>'],['Supplier',x=>esc(x.vendor_name||'—')],['Received',x=>new Date(x.received_at).toLocaleString()],['Cost',x=>money(x.total_cost)]
    ],procurementData.receipts||[]);
  }catch(e){purchaseOrderTable.innerHTML='<div class="empty">'+esc(e.message)+'</div>'}
};
window.openPurchaseOrder=async function(){
  if(!procurementData)await loadProcurement();
  poVendor.innerHTML='<option value="">No supplier selected</option>'+(procurementData?.vendors||[]).map(x=>'<option value="'+x.id+'">'+esc(x.name)+'</option>').join('');
  poExpectedDate.value='';poNotes.value='';poTax.value='0';poLines.innerHTML='';addPoLine();openModal('purchaseOrderModal');
};
window.addPoLine=function(){
  const row=document.createElement('div');row.className='form-grid po-line';row.style.marginBottom='9px';
  row.innerHTML='<div class="field"><label>Product</label><select class="po-product"><option value="">Other / non-stock item</option>'+filtered(base.products).map(x=>'<option value="'+x.id+'" data-name="'+esc(x.name)+'" data-cost="'+Number(x.cost_price||0)+'">'+esc(x.name)+'</option>').join('')+'</select></div><div class="field"><label>Description</label><input class="po-description" required></div><div class="field"><label>Quantity</label><input class="po-qty" type="number" min="0.001" step="0.001" value="1" required></div><div class="field"><label>Unit cost</label><input class="po-cost" type="number" min="0" step="0.01" value="0" required></div><div class="field wide"><button class="btn sm danger" type="button">Remove line</button></div>';
  row.querySelector('.po-product').onchange=e=>{const opt=e.target.selectedOptions[0];if(opt?.value){row.querySelector('.po-description').value=opt.dataset.name||opt.textContent;row.querySelector('.po-cost').value=opt.dataset.cost||0}};
  row.querySelector('.danger').onclick=()=>{if(document.querySelectorAll('.po-line').length>1)row.remove()};
  poLines.appendChild(row);
};
purchaseOrderForm.onsubmit=async e=>{
  e.preventDefault();const lines=[...document.querySelectorAll('.po-line')].map(row=>({productId:row.querySelector('.po-product').value||undefined,description:row.querySelector('.po-description').value,quantity:Number(row.querySelector('.po-qty').value),unitCost:Number(row.querySelector('.po-cost').value)}));
  try{await api('/api/procurement/purchase-orders',{method:'POST',body:JSON.stringify({shopId:selectedShopId,branchId:selectedBranchId||undefined,vendorId:poVendor.value||undefined,expectedDate:poExpectedDate.value||undefined,tax:Number(poTax.value||0),notes:poNotes.value||undefined,lines})});closeModal('purchaseOrderModal');showToast('Purchase order draft created');await loadProcurement()}catch(err){showToast(err.message)}
};
window.submitPo=async function(id){try{await api('/api/procurement/purchase-orders/'+id+'/submit',{method:'POST',body:JSON.stringify({reason:'Purchase stock and supplies for salon operations'})});showToast('Purchase order submitted for approval');await Promise.all([loadProcurement(),loadApprovals()])}catch(e){showToast(e.message)}};
window.openReceivePo=function(id){
  const po=procurementData?.orders?.find(x=>x.id===id);if(!po)return;receivePoId.value=id;receivePoTitle.textContent='Receive '+po.po_no;receivePoNotes.value='';
  const lines=Array.isArray(po.lines)?po.lines:JSON.parse(po.lines||'[]');
  receivePoLines.innerHTML=lines.map(l=>{const remaining=Math.max(0,Number(l.ordered_quantity)-Number(l.received_quantity));return '<div class="form-grid receive-line" data-line="'+l.id+'" style="margin-bottom:8px"><div class="field wide"><label>'+esc(l.description)+' · Remaining '+remaining+'</label><input class="receive-qty" type="number" min="0" max="'+remaining+'" step="0.001" value="'+remaining+'"></div></div>'}).join('');
  openModal('receivePoModal');
};
receivePoForm.onsubmit=async e=>{e.preventDefault();const lines=[...document.querySelectorAll('.receive-line')].map(x=>({lineId:x.dataset.line,quantity:Number(x.querySelector('.receive-qty').value||0)})).filter(x=>x.quantity>0);if(!lines.length)return showToast('Enter at least one quantity received');try{await api('/api/procurement/purchase-orders/'+receivePoId.value+'/receive',{method:'POST',body:JSON.stringify({notes:receivePoNotes.value||undefined,lines})});closeModal('receivePoModal');showToast('Goods received and stock updated');await Promise.all([reloadAll(),loadProcurement(),loadInventoryAlerts()])}catch(err){showToast(err.message)}};

window.loadTickets=async function(){
  try{const rows=await api('/api/tickets?shopId='+encodeURIComponent(selectedShopId));ticketTable.innerHTML=table([
    ['Ticket',x=>'<b>'+esc(x.ticket_no)+'</b><br><small class="muted">'+esc(x.source)+'</small>'],['Customer',x=>esc(x.customer_name||'Internal')],['Subject',x=>esc(x.subject)],['Priority',x=>tag(x.priority)],['Status',x=>tag(x.status)],['Action',x=>['resolved','closed','cancelled'].includes(x.status)?'':'<button class="btn sm primary" onclick="advanceTicket(\''+x.id+'\')">Advance</button>']
  ],rows);ticketCustomer.innerHTML='<option value="">Internal / no customer</option>'+filtered(base.customers).map(x=>'<option value="'+x.id+'">'+esc(x.name)+'</option>').join('')}catch(e){ticketTable.innerHTML='<div class="empty">'+esc(e.message)+'</div>'}
};
ticketFormAdmin.onsubmit=async e=>{e.preventDefault();try{await api('/api/tickets',{method:'POST',body:JSON.stringify({shopId:selectedShopId,branchId:selectedBranchId||undefined,customerId:ticketCustomer.value||undefined,category:ticketCategory.value,subject:ticketSubject.value,description:ticketDescription.value,priority:ticketPriority.value})});ticketFormAdmin.reset();closeModal('ticketModal');showToast('Ticket created');await loadTickets()}catch(err){showToast(err.message)}};
window.advanceTicket=function(id){openActionPrompt({title:'Update ticket status',notice:'Choose the next support status for this ticket.',selectLabel:'Status',options:[['in_progress','In progress'],['waiting_customer','Waiting for customer'],['resolved','Resolved'],['closed','Closed']],label:'Internal note (optional)',required:false,button:'Update ticket',onSubmit:async({text,value})=>{await api('/api/tickets/'+id,{method:'PATCH',body:JSON.stringify({status:value})});await loadTickets();showToast('Ticket updated')}})};

const baseSyncPaymentMode=typeof syncPaymentMode==='function'?syncPaymentMode:null;
syncPaymentMode=function(){
  if(baseSyncPaymentMode)baseSyncPaymentMode();
  const pos=paymentMethod?.value==='pos_terminal';
  if(document.getElementById('paymentPosWrap'))paymentPosWrap.style.display=pos?'':'none';
  if(pos){
    paymentEmailWrap.style.display='none';paymentPhoneWrap.style.display='none';paymentReferenceWrap.style.display='none';
    paymentSubmit.textContent='Send to POS terminal';
    paymentModeNotice.textContent='A secure payment intent will be assigned to the selected registered POS device. The invoice is settled only after the terminal confirms success.';
  }
};
const baseOpenPaymentModal=typeof openPaymentModal==='function'?openPaymentModal:null;
openPaymentModal=function(orderId){
  if(baseOpenPaymentModal)baseOpenPaymentModal(orderId);
  api('/api/pos/devices?shopId='+encodeURIComponent(selectedShopId)).then(rows=>{
    if(document.getElementById('paymentPosDevice'))paymentPosDevice.innerHTML='<option value="">Choose POS device</option>'+rows.filter(x=>x.status!=='disabled').map(x=>'<option value="'+x.id+'">'+esc(x.device_name)+' · '+esc(x.status)+'</option>').join('');
  }).catch(()=>{});
};
paymentForm?.addEventListener('submit',async e=>{
  if(paymentMethod.value!=='pos_terminal')return;
  e.preventDefault();e.stopImmediatePropagation();
  const amount=Number(paymentForm.amount.value||0),orderId=paymentOrderId.value,deviceId=paymentPosDevice?.value;
  if(!deviceId){showToast('Choose a registered POS device');return}
  if(!amount){showToast('Enter a payment amount');return}
  paymentSubmit.disabled=true;
  try{
    const intent=await api('/api/pos/payment-intents',{method:'POST',body:JSON.stringify({
      shopId:selectedShopId,branchId:selectedBranchId||undefined,orderId,posDeviceId:deviceId,
      idempotencyKey:'web-'+(crypto.randomUUID?crypto.randomUUID():Date.now()+'-'+Math.random()),
      method:paymentPosMethod.value,amount,currency:'GHS',provider:'registered_pos'
    })});
    closeModal('paymentModal');showToast('Payment sent to POS terminal · '+intent.id.slice(0,8));await loadPaymentOperations();
  }catch(err){showToast(err.message)}
  finally{paymentSubmit.disabled=false;syncPaymentMode()}
},true);

window.loadPosDevices=async function(){
  try{const rows=await api('/api/pos/devices?shopId='+encodeURIComponent(selectedShopId));posDeviceTable.innerHTML=table([
    ['Device',x=>'<b>'+esc(x.device_name)+'</b><br><small class="muted">'+esc(x.device_code)+'</small>'],['Provider',x=>esc(x.provider||'—')],['Terminal',x=>esc(x.terminal_id||'—')],['Status',x=>tag(x.status)],['Last seen',x=>x.last_seen_at?new Date(x.last_seen_at).toLocaleString():'Never'],['Action',x=>'<button class="btn sm" onclick="pingPos(\''+x.id+'\')">Heartbeat</button>']
  ],rows)}catch(e){posDeviceTable.innerHTML='<div class="empty">'+esc(e.message)+'</div>'}
};
posDeviceForm.onsubmit=async e=>{e.preventDefault();const f=Object.fromEntries(new FormData(posDeviceForm));try{const d=await api('/api/pos/devices',{method:'POST',body:JSON.stringify({shopId:selectedShopId,branchId:selectedBranchId||undefined,deviceName:f.deviceName,deviceCode:f.deviceCode,provider:f.provider||undefined,terminalId:f.terminalId||undefined,capabilities:{checkout:true,payments:true,receipts:true,paymentIntents:true}})});posDeviceForm.reset();closeModal('posDeviceModal');posDeviceToken.value=d.deviceToken||'';openModal('posTokenModal');showToast('POS device registered');await loadPosDevices()}catch(err){showToast(err.message)}};
window.pingPos=async function(id){try{await api('/api/pos/devices/'+id+'/heartbeat',{method:'POST',body:'{}'});await loadPosDevices()}catch(e){showToast(e.message)}};

window.loadAutomationSettings=async function(){
  if(!selectedShopId||!document.getElementById('automationForm'))return;
  try{
    const s=await api('/api/automation/settings/'+selectedShopId+(selectedBranchId?'?branchId='+encodeURIComponent(selectedBranchId):''));
    automationForm.inactivityDays.value=s.inactivity_days||90;automationForm.welcomeDiscountPercent.value=s.welcome_discount_percent||10;automationForm.autoEodEnabled.value=String(s.auto_eod_enabled!==false);automationForm.autoEodTime.value=String(s.auto_eod_time||'21:00').slice(0,5);automationForm.reorderAlertsEnabled.value=String(s.reorder_alerts_enabled!==false);
    const sh=shop();if(sh){portalLinks.innerHTML='<div class="link-card"><div><b>Public booking page</b><small class="muted" style="display:block">'+location.origin+'/store/'+esc(sh.public_slug||sh.slug)+'</small></div><a class="btn soft" target="_blank" href="/store/'+encodeURIComponent(sh.public_slug||sh.slug)+'">Open</a></div><div class="link-card" style="margin-top:8px"><div><b>Customer dashboard</b><small class="muted" style="display:block">'+location.origin+'/customer/'+esc(sh.public_slug||sh.slug)+'</small></div><a class="btn primary" target="_blank" href="/customer/'+encodeURIComponent(sh.public_slug||sh.slug)+'">Open portal</a></div>'}
  }catch(e){showToast(e.message)}
};
async function saveAutomationSettings(e){e.preventDefault();const f=Object.fromEntries(new FormData(automationForm));try{await api('/api/automation/settings/'+selectedShopId,{method:'PUT',body:JSON.stringify({branchId:selectedBranchId||null,inactivityDays:Number(f.inactivityDays),welcomeDiscountPercent:Number(f.welcomeDiscountPercent),autoEodEnabled:f.autoEodEnabled==='true',autoEodTime:f.autoEodTime,reorderAlertsEnabled:f.reorderAlertsEnabled==='true'})});showToast('Automation settings submitted for approval');await loadApprovals()}catch(err){showToast(err.message)}}

const oldShowPage=showPage;
showPage=function(id){
  oldShowPage(id);
  setTimeout(()=>loadEnterprisePage(id),0);
};

installEnterprisePanels();
applyRoleUI();
loadEnterpriseSummary();
renderCustomer360Actions();
renderServiceApprovalActions();
})();