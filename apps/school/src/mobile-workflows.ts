/** These same validation and reset rules run in the mobile UI and its flow checks. */
export const mobileWorkflowScript=String.raw`
window.RevoltMobileFlow=(function(){
 function score(value,max){
  if(value==null||String(value).trim()==='')return null;
  var number=Number(value);
  if(!Number.isFinite(number)||number<0||number>Number(max))throw Error('Enter a mark from 0 to '+max+'.');
  return number;
 }
 function scorePayload(students,draft,max){
  var rows=[];
  students.forEach(function(student){
   var item=draft[student.student_id]||{},value=score(item.score,max),before=student.score==null?null:Number(student.score);
   if(value===null&&before!==null)throw Error('Enter a corrected mark for '+student.first_name+'. A saved mark cannot be removed by leaving it blank.');
   if(value!==null&&(value!==before||String(item.comment||'')!==String(student.comment||'')))rows.push({studentId:student.student_id,score:value,comment:String(item.comment||'')});
  });
  if(!rows.length)throw Error('Enter or change at least one mark before saving.');
  return{scores:rows};
 }
 function attendancePayload(students,draft,classroomId,date){
  if(!classroomId||!date)throw Error('Choose a class and attendance date.');
  var rows=[];
  students.forEach(function(student){var value=draft[student.student_id];if(!value||value==='unmarked')return;if(!['present','absent','late','excused'].includes(value))throw Error('Choose a valid attendance status.');rows.push({studentId:student.student_id,status:value})});
  if(!rows.length)throw Error('Mark at least one learner before saving.');
  return{classroomId:classroomId,date:date,records:rows};
 }
 function saved(state){state.dirty=false;state.attendance=null;state.scoring=null;state.formRecord=null;state.scoreSelection=null}
 return{score:score,scorePayload:scorePayload,attendancePayload:attendancePayload,saved:saved};
})();
`;
