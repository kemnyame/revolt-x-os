import { readFileSync, writeFileSync } from 'node:fs';

function replaceOnce(source,needle,replacement,label){
  if(source.includes(replacement))return source;
  if(!source.includes(needle))throw new Error('Patch marker not found: '+label);
  return source.replace(needle,replacement);
}

const serverPath='apps/school/src/server.ts';
let server=readFileSync(serverPath,'utf8');
server=replaceOnce(server,
  "import { registerSchoolRemediationRoutes } from './school-remediation-routes.js';",
  "import { registerSchoolRemediationRoutes } from './school-remediation-routes.js';\nimport { registerReportFeePolicyRoutes, reportDeliveryPolicy, studentsWithOutstandingFees } from './report-fee-policy.js';",
  'server import');

server=replaceOnce(server,
  "app.post('/api/auth/admin-login',async(request,reply)=>withSchoolAuthThrottle(db,'school_admin',request,()=>handleSchoolAdminLogin(request,reply)));\nregisterSchoolAccessRoutes(app,{db,config,requireCoreServiceRequest,",
  "app.post('/api/auth/admin-login',async(request,reply)=>withSchoolAuthThrottle(db,'school_admin',request,()=>handleSchoolAdminLogin(request,reply)));\nregisterReportFeePolicyRoutes(app,{db,config});\nregisterSchoolAccessRoutes(app,{db,config,requireCoreServiceRequest,",
  'route registration');

server=replaceOnce(server,
  "  const newlyReleased:any[]=[];\n  await tx(db,async client=>{",
  "  const reportPolicy=await reportDeliveryPolicy(db,a.core.organisation_id);\n  const feeBlockedStudentIds=reportPolicy.blockReportDeliveryWhenFeesOwed\n    ?await studentsWithOutstandingFees(db,a.core.organisation_id,pool.rows.map((row:any)=>row.student_id))\n    :new Set<string>();\n  const newlyReleased:any[]=[];\n  await tx(db,async client=>{",
  'release policy lookup');

server=replaceOnce(server,
  "    for(const row of pool.rows){\n      if(row.released_at)continue;",
  "    for(const row of pool.rows){\n      if(row.released_at||feeBlockedStudentIds.has(row.student_id))continue;",
  'release debt skip');

server=replaceOnce(server,
  "    termId:b.termId,released:newlyReleased.length,communications:communicationCount,missingGuardianEmail\n  });",
  "    termId:b.termId,released:newlyReleased.length,withheldForFees:feeBlockedStudentIds.size,communications:communicationCount,missingGuardianEmail\n  });",
  'release audit');

server=replaceOnce(server,
  "    released:newlyReleased.length,\n    alreadyReleased:pool.rows.length-newlyReleased.length,\n    communications:communicationCount,",
  "    released:newlyReleased.length,\n    withheldForFees:feeBlockedStudentIds.size,\n    alreadyReleased:pool.rows.filter((x:any)=>Boolean(x.released_at)).length,\n    communications:communicationCount,",
  'release response');

server=replaceOnce(server,
  "        (rc.workflow_status='approved' AND rc.released_at IS NOT NULL) report_released",
  "        (rc.workflow_status='approved' AND (rc.released_at IS NOT NULL OR report_delivery_withheld_for_fees($1,ts.student_id))) report_released",
  'promotion readiness for fee-withheld reports');

writeFileSync(serverPath,server);

const uiPath='apps/school/src/ui.ts';
let ui=readFileSync(uiPath,'utf8');
ui=replaceOnce(ui,
  '<button id="sessionSecurity" class="ghost">Session Security</button><button id="promotionThreshold" class="ghost">Promotion Threshold</button>',
  '<button id="sessionSecurity" class="ghost">Session Security</button><button id="reportFeePolicy" class="ghost">Report Delivery</button><button id="promotionThreshold" class="ghost">Promotion Threshold</button>',
  'setup report delivery button');

const editProfileMarker="   if(E('editProfile'))E('editProfile').onclick=function(){";
const reportPolicyHandler=`   var reportFeePolicy=E('reportFeePolicy');if(reportFeePolicy)reportFeePolicy.onclick=async function(){var p=await raw('/api/security/report-delivery-policy');modal('<h2>Report Delivery & Fees</h2><p class="muted">Choose whether parents may receive report cards while a learner still owes school fees.</p><label style="display:flex;gap:10px;align-items:flex-start;margin:14px 0"><input id="blockReportsForDebt" type="checkbox" '+(p.blockReportDeliveryWhenFeesOwed?'checked':'')+'><span><b>Withhold report cards when fees are outstanding</b><br><span class="muted">When enabled, an approved report remains unreleased and no parent notification is sent until the learner has no outstanding fee balance.</span></span></label><div class="notice">This rule affects report delivery only. It does not change academic scores or promotion decisions.</div><button id="saveReportFeePolicy" class="primary" style="width:100%;margin-top:12px">Save report delivery rule</button>');if(E('saveReportFeePolicy'))E('saveReportFeePolicy').onclick=async function(){await raw('/api/security/report-delivery-policy',{method:'PUT',body:JSON.stringify({blockReportDeliveryWhenFeesOwed:Boolean(E('blockReportsForDebt').checked)})});close();toast('Report delivery rule updated')}};\n`;
ui=replaceOnce(ui,editProfileMarker,reportPolicyHandler+editProfileMarker,'setup report policy handler');
writeFileSync(uiPath,ui);

console.log('Report fee policy patch applied.');
