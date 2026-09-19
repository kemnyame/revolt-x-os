export const parentFrontend=`<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Revolt-X School Parent Portal</title>
<style>
:root{--bg:#071018;--panel:#0e1e29;--line:#203844;--text:#f4f8fa;--muted:#90a8b5;--green:#45ddb2;--blue:#48a9ff;--red:#ff7482}
*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--text);font:14px Arial,sans-serif}.wrap{max-width:1100px;margin:auto;padding:22px}.brand{font-size:20px;font-weight:900;margin-bottom:22px}.brand span{color:var(--green)}.panel{background:var(--panel);border:1px solid var(--line);border-radius:14px;padding:16px;margin-bottom:12px}.grid{display:grid;grid-template-columns:repeat(3,1fr);gap:12px}.stat b{font-size:25px;display:block;margin-top:6px}.muted{color:var(--muted)}input,select{width:100%;padding:11px;margin:6px 0 12px;background:#07141d;border:1px solid var(--line);border-radius:8px;color:white}.primary,.ghost{padding:10px 14px;border-radius:9px;cursor:pointer}.primary{border:0;background:linear-gradient(90deg,var(--green),var(--blue));font-weight:800;color:#041018}.ghost{border:1px solid var(--line);background:transparent;color:white}.top{display:flex;justify-content:space-between;gap:12px;align-items:center}.hide{display:none}.badge{display:inline-block;padding:4px 7px;border-radius:10px;background:#15342b;color:#73e6c6;font-size:11px}.table{overflow:auto}.table table{width:100%;border-collapse:collapse}.table td,.table th{padding:9px;border-bottom:1px solid var(--line);text-align:left}.table th{color:var(--muted);font-size:11px;text-transform:uppercase}.tabs{display:flex;gap:8px;flex-wrap:wrap;margin:12px 0}.tabs button{padding:8px 10px}.error{color:#ffb0bb}.child{cursor:pointer}.child:hover{border-color:#3a6578}@media(max-width:760px){.grid{grid-template-columns:1fr}.top{align-items:flex-start;flex-direction:column}}
</style></head><body>
<div class="wrap">
<div class="brand"><span>RX</span> REVOLT-X SCHOOL <span class="muted">Parent Portal</span></div>
<section id="login" class="panel" style="max-width:480px;margin:70px auto">
<h2>Parent / Guardian Sign In</h2><p class="muted">Use your phone number, a linked student admission number and your school-issued PIN.</p>
<label>Phone number</label><input id="phone"><label>Student admission number</label><input id="admission"><label>PIN</label><input id="pin" type="password" maxlength="6">
<button id="signin" class="primary" style="width:100%">Sign in</button><p id="loginError" class="error"></p>
</section>
<section id="portal" class="hide"><div class="top"><div><h2 id="guardianName"></h2><div class="muted" id="schoolName"></div></div><button id="logout" class="ghost">Sign out</button></div><div id="children" class="grid"></div><div id="studentArea"></div></section>
</div>
<script>
(function(){
var token=sessionStorage.getItem('rx_parent_token')||'',me=null,currentStudent=null;
function E(i){return document.getElementById(i)}function esc(v){return String(v==null?'':v).replace(/[&<>"']/g,function(c){return{'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]})}
async function raw(path,opt){opt=opt||{};opt.headers=Object.assign({'content-type':'application/json'},opt.headers||{},token?{authorization:'Bearer '+token}:{});var r=await fetch(path,opt),j=null;try{j=await r.json()}catch(e){}if(!r.ok)throw Error(j&&j.error&&j.error.message?j.error.message:'Request failed');return j}
function table(rows,cols,act){if(!rows||!rows.length)return'<p class="muted">No records yet.</p>';return'<div class="table"><table><thead><tr>'+cols.map(function(c){return'<th>'+esc(c.label||c.key)+'</th>'}).join('')+(act?'<th>Actions</th>':'')+'</tr></thead><tbody>'+rows.map(function(r){return'<tr>'+cols.map(function(c){var v=c.render?c.render(r):r[c.key];return'<td>'+String(v==null?'':v)+'</td>'}).join('')+(act?'<td>'+act(r)+'</td>':'')+'</tr>'}).join('')+'</tbody></table></div>'}
async function boot(){if(!token)return;try{me=await raw('/api/parent/me');showPortal();var q=new URLSearchParams(location.search),p=q.get('payment');if(p){setTimeout(function(){alert(p==='success'?'Payment received successfully. Your fee statement has been updated.':'Payment status: '+p)},200)}}catch(e){sessionStorage.removeItem('rx_parent_token');token=''}}
function showPortal(){E('login').classList.add('hide');E('portal').classList.remove('hide');E('guardianName').textContent=me.guardian.first_name+' '+me.guardian.last_name;E('schoolName').textContent=me.school.school_name;E('children').innerHTML=me.students.map(function(s){return'<div class="panel child" data-student="'+s.id+'"><b>'+esc(s.first_name+' '+s.last_name)+'</b><div class="muted">'+esc(s.admission_no)+'</div><div>'+esc(s.classroom_name||'Not currently enrolled')+'</div></div>'}).join('');E('children').onclick=function(e){var c=e.target.closest('[data-student]');if(c)loadStudent(c.dataset.student)};if(me.students[0])loadStudent(me.students[0].id)}
async function loadStudent(id){
 currentStudent=id;var d=await raw('/api/parent/students/'+id+'/dashboard');
 E('studentArea').innerHTML='<div class="panel"><div class="top"><div><h2>'+esc(d.student.first_name+' '+d.student.last_name)+'</h2><div class="muted">'+esc(d.student.admission_no)+' • '+esc(d.student.classroom_name||'No class')+'</div></div></div><div class="grid" style="margin-top:12px"><div class="panel stat"><span class="muted">Outstanding fees</span><b>GHS '+Number(d.fees.outstanding||0).toFixed(2)+'</b></div><div class="panel stat"><span class="muted">Present days</span><b>'+esc(d.attendance.present||0)+'</b></div><div class="panel stat"><span class="muted">Absent days</span><b>'+esc(d.attendance.absent||0)+'</b></div></div></div><div class="tabs"><button class="ghost" id="tabHomework">Homework</button><button class="ghost" id="tabFees">Fees & Payments</button><button class="ghost" id="tabReports">Report Card</button><button class="ghost" id="tabTimetable">Timetable</button><button class="ghost" id="tabNews">Announcements</button></div><div id="detail"></div>';
 E('tabHomework').onclick=function(){E('detail').innerHTML='<div class="panel"><h3>Homework</h3>'+table(d.homework,[{key:'subject_name',label:'Subject'},{key:'title'},{key:'due_at',label:'Due',render:function(r){return esc(r.due_at?new Date(r.due_at).toLocaleString():'') }},{key:'status'}])+'</div>'};
 E('tabFees').onclick=async function(){
   var x=await raw('/api/parent/students/'+id+'/fees'),requests=await raw('/api/parent/students/'+id+'/payment-requests').catch(function(){return[]});
   E('detail').innerHTML='<div class="panel"><div class="top"><div><h3>Fee Statement</h3><p class="muted">Pay outstanding fees securely by Mobile Money or card.</p></div></div>'+
     (requests.length?'<div class="panel" style="background:#102821"><h3>School Payment Requests</h3>'+table(requests,[{key:'fee_name',label:'Fee'},{key:'amount',render:function(r){return'GHS '+Number(r.amount).toFixed(2)}},{key:'note'},{key:'created_at',label:'Requested',render:function(r){return esc(new Date(r.created_at).toLocaleDateString())}}],function(r){return'<button class="primary" data-pay-request="'+r.id+'" data-fee="'+(r.student_fee_id||'')+'" data-amount="'+r.amount+'">Pay now</button>'})+'</div>':'')+
     '<h3>Outstanding / Assigned Fees</h3>'+table(x.items,[{key:'fee_name',label:'Fee'},{key:'due',render:function(r){return'GHS '+Number(r.due).toFixed(2)}},{key:'paid',render:function(r){return'GHS '+Number(r.paid).toFixed(2)}},{key:'balance',render:function(r){return'GHS '+Number(r.balance).toFixed(2)}},{key:'status'}],function(r){return Number(r.balance)>0?'<button class="ghost" data-pay-fee="'+r.id+'" data-amount="'+r.balance+'">Pay online</button>':''})+
     '<h3 style="margin-top:18px">Payments</h3>'+table(x.payments,[{key:'paid_at',label:'Date',render:function(r){return esc(new Date(r.paid_at).toLocaleString())}},{key:'amount',render:function(r){return'GHS '+Number(r.amount).toFixed(2)}},{key:'payment_method',label:'Method'},{key:'reference'}])+'</div>';
   E('detail').onclick=async function(ev){
     var b=ev.target.closest('[data-pay-request],[data-pay-fee]');if(!b)return;
     var method=prompt('Type payment method: mobile_money or card','mobile_money');if(method!=='mobile_money'&&method!=='card')return;
     var amount=Number(b.dataset.amount),body={studentId:id,amount:amount,method:method};
     if(b.dataset.payRequest){body.paymentRequestId=b.dataset.payRequest;if(b.dataset.fee)body.studentFeeId=b.dataset.fee}
     else body.studentFeeId=b.dataset.payFee;
     try{var intent=await raw('/api/parent/payment-intents',{method:'POST',body:JSON.stringify(body)});if(intent.authorization_url)window.location.href=intent.authorization_url}catch(err){alert(err.message)}
   };
 };
 E('tabReports').onclick=async function(){
   var x=await raw('/api/parent/students/'+id+'/latest-report');
   if(!x.available)return E('detail').innerHTML='<div class="panel"><h3>Report Card</h3><p class="muted">The latest report has not yet been approved for release by the school.</p></div>';
   E('detail').innerHTML='<div class="panel"><h3>'+esc(x.term?x.term.name:'Latest Report')+'</h3>'+table(x.subjects,[{key:'subject_name',label:'Subject'},{key:'percentage',label:'Average %'},{key:'grade'},{key:'remark'}])+'<p><b>Class teacher comment:</b> '+esc(x.comments&&x.comments.class_teacher_comment||'')+'</p><p><b>Headteacher comment:</b> '+esc(x.comments&&x.comments.headteacher_comment||'')+'</p><p><b>Next term begins:</b> '+esc((x.comments&&x.comments.next_term_begins)||(x.term&&x.term.next_term_begins)||'—')+'</p></div>'
 };
 E('tabTimetable').onclick=async function(){
   var rows=await raw('/api/parent/students/'+id+'/timetable'),days=['','Monday','Tuesday','Wednesday','Thursday','Friday'];
   E('detail').innerHTML='<div class="panel"><div class="top"><div><h3>Class Timetable</h3><p class="muted">Current timetable for '+esc(d.student.classroom_name||'this class')+'.</p></div><button id="printParentTimetable" class="ghost">Print</button></div>'+table(rows,[{key:'day_of_week',label:'Day',render:function(r){return days[r.day_of_week]}},{key:'start_time',label:'Start',render:function(r){return esc(String(r.start_time).slice(0,5))}},{key:'end_time',label:'End',render:function(r){return esc(String(r.end_time).slice(0,5))}},{key:'subject_name',label:'Subject'},{key:'room'}])+'</div>';E('printParentTimetable').onclick=function(){window.print()}
 };
 E('tabNews').onclick=function(){E('detail').innerHTML='<div class="panel"><h3>Announcements</h3>'+table(d.announcements,[{key:'title'},{key:'body'},{key:'published_at',label:'Published',render:function(r){return esc(r.published_at?new Date(r.published_at).toLocaleDateString():'')}}])+'</div>'};
 E('tabHomework').click();
}
E('signin').onclick=async function(){E('loginError').textContent='';try{var x=await raw('/api/parent/login',{method:'POST',body:JSON.stringify({phone:E('phone').value,admissionNo:E('admission').value,pin:E('pin').value})});token=x.token;sessionStorage.setItem('rx_parent_token',token);me=await raw('/api/parent/me');showPortal()}catch(e){E('loginError').textContent=e.message}};
E('logout').onclick=async function(){try{await raw('/api/parent/logout',{method:'POST',body:'{}'})}catch(e){}sessionStorage.removeItem('rx_parent_token');location.reload()};
boot();
})();
</script></body></html>`;
