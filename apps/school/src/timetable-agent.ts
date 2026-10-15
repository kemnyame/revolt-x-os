/** A constraint-planning agent: inspect requirements, search, independently
 * verify, then let the route commit one complete plan. No external AI key is
 * needed and a probabilistic text response never decides whether slots clash. */
export const minutes=(v:unknown)=>{const [h,m]=String(v||'00:00').split(':').map(Number);return Number(h)*60+Number(m)};
const time=(n:number)=>String(Math.floor(n/60)).padStart(2,'0')+':'+String(n%60).padStart(2,'0');
const overlap=(a:any,b:any)=>Number(a.day_of_week)===Number(b.day_of_week)&&minutes(a.start_time)<minutes(b.end_time)&&minutes(a.end_time)>minutes(b.start_time);
const samePeriod=(a:any,b:any)=>!a.term_id||!b.term_id||a.term_id===b.term_id;
const sameRoom=(a:any,b:any)=>a.room&&b.room&&String(a.room).trim().toLowerCase()===String(b.room).trim().toLowerCase();

export function timetableConflicts(entries:any[]){
  const conflicts:any[]=[];
  for(let i=0;i<entries.length;i++)for(let j=i+1;j<entries.length;j++){
    const a=entries[i],b=entries[j];if(!samePeriod(a,b)||!overlap(a,b))continue;
    if(a.classroom_id===b.classroom_id||(a.teacher_os_user_id&&a.teacher_os_user_id===b.teacher_os_user_id)||sameRoom(a,b))conflicts.push({first:a.id||i,second:b.id||j,reason:a.classroom_id===b.classroom_id?'Class conflict':sameRoom(a,b)?'Room conflict':'Teacher conflict'});
  }
  return conflicts;
}

export function planTimetable(input:{requirements:any[];existing:any[];breaks:any[];unavailability:any[];settings:any;termId?:string|null;maxNodes?:number}){
  const {requirements,existing,breaks,unavailability,settings}=input;
  const period=Math.max(15,Number(settings.default_period_minutes||40)),start=minutes(settings.school_day_start||'07:30'),end=minutes(settings.school_day_end||'15:30');
  const maxLoad=Math.max(1,Number(settings.max_teacher_periods_per_day||8));
  const slots:any[]=[];
  for(let day=1;day<=5;day++)for(let cursor=start;cursor+period<=end;){
    const blocked=breaks.find(b=>(b.day_of_week==null||Number(b.day_of_week)===day)&&cursor<minutes(b.end_time)&&cursor+period>minutes(b.start_time));
    if(blocked){cursor=Math.max(cursor+1,minutes(blocked.end_time));continue}
    slots.push({day_of_week:day,start_time:time(cursor),end_time:time(cursor+period)});cursor+=period;
  }
  const unscheduled:any[]=[],tasks:any[]=[];
  const conflicts=timetableConflicts(existing);
  for(const entry of existing){
    const validDay=Number(entry.day_of_week)>=1&&Number(entry.day_of_week)<=5;
    if(!validDay||minutes(entry.start_time)<start||minutes(entry.end_time)>end||minutes(entry.end_time)<=minutes(entry.start_time))conflicts.push({first:entry.id,reason:'An existing period falls outside school hours'});
    if(breaks.some(b=>(b.day_of_week==null||Number(b.day_of_week)===Number(entry.day_of_week))&&overlap({...b,day_of_week:entry.day_of_week},entry)))conflicts.push({first:entry.id,reason:'An existing period overlaps a break'});
    if(unavailability.some(u=>u.teacher_os_user_id===entry.teacher_os_user_id&&samePeriod(u,entry)&&overlap(u,entry)))conflicts.push({first:entry.id,reason:'An existing period overlaps teacher unavailability'});
    if(entry.teacher_os_user_id&&existing.filter(o=>o.teacher_os_user_id===entry.teacher_os_user_id&&Number(o.day_of_week)===Number(entry.day_of_week)&&samePeriod(o,entry)).length>maxLoad)conflicts.push({first:entry.id,reason:'An existing teacher workload exceeds the daily maximum'});
  }
  for(const req of requirements){
    const required=Math.max(Number(req.weekly_periods||1),Math.ceil(Number(req.credit_hours||0)*60/period));
    const count=existing.filter(e=>(input.termId?(!e.term_id||e.term_id===input.termId):!e.term_id)&&e.classroom_id===req.classroom_id&&e.subject_id===req.subject_id&&e.teacher_os_user_id===req.teacher_os_user_id).length;
    const missing=Math.max(0,required-count);if(!missing)continue;
    if(!req.teacher_os_user_id){unscheduled.push({classroomId:req.classroom_id,classroomName:req.classroom_name,subjectId:req.subject_id,subjectName:req.subject_name,remainingPeriods:missing,reason:'Assign a subject teacher before scheduling'});continue}
    tasks.push({...req,required:missing,remaining:missing,lastSlot:-1,positions:slots.map((s,i)=>({...s,index:i})).filter(s=>!unavailability.some(u=>u.teacher_os_user_id===req.teacher_os_user_id&&Number(u.day_of_week)===s.day_of_week&&minutes(s.start_time)<minutes(u.end_time)&&minutes(s.end_time)>minutes(u.start_time)))});
  }
  const proposed:any[]=[],occupancy=[...existing];
  let nodes=0,best:any[]=[],exhausted=false;
  const maxNodes=input.maxNodes||25000,deadline=Date.now()+4000;
  function candidates(task:any){
    return task.positions.filter((s:any)=>{
      if(s.index<=task.lastSlot)return false;
      const entry={...s,classroom_id:task.classroom_id,teacher_os_user_id:task.teacher_os_user_id,room:task.room||null,term_id:input.termId||null};
      if(occupancy.filter(o=>o.teacher_os_user_id===task.teacher_os_user_id&&Number(o.day_of_week)===s.day_of_week&&samePeriod(o,entry)).length>=maxLoad)return false;
      return !occupancy.some(o=>samePeriod(o,entry)&&overlap(o,entry)&&(o.classroom_id===task.classroom_id||o.teacher_os_user_id===task.teacher_os_user_id||sameRoom(o,entry)));
    }).sort((a:any,b:any)=>{
      const cost=(s:any)=>occupancy.filter(o=>o.classroom_id===task.classroom_id&&o.subject_id===task.subject_id&&Number(o.day_of_week)===s.day_of_week).length*100+occupancy.filter(o=>o.teacher_os_user_id===task.teacher_os_user_id&&Number(o.day_of_week)===s.day_of_week).length*10;
      return cost(a)-cost(b)||a.index-b.index;
    });
  }
  function search():boolean{
    if(++nodes>maxNodes||Date.now()>deadline){exhausted=true;return false}
    if(proposed.length>best.length)best=proposed.slice();
    let selected:any=null,choices:any[]=[];
    for(const t of tasks){if(!t.remaining)continue;const available=candidates(t);if(available.length<t.remaining)return false;if(!selected||available.length<choices.length){selected=t;choices=available}}
    if(!selected)return true;
    for(const slot of choices){
      const entry={classroom_id:selected.classroom_id,classroom_name:selected.classroom_name,subject_id:selected.subject_id,subject_name:selected.subject_name,teacher_os_user_id:selected.teacher_os_user_id,term_id:input.termId||null,room:selected.room||null,day_of_week:slot.day_of_week,start_time:slot.start_time,end_time:slot.end_time,schedule_source:'auto',is_locked:false};
      const previous=selected.lastSlot;selected.lastSlot=slot.index;selected.remaining--;proposed.push(entry);occupancy.push(entry);
      if(search())return true;
      occupancy.pop();proposed.pop();selected.remaining++;selected.lastSlot=previous;if(exhausted)break;
    }
    return false;
  }
  const complete=!conflicts.length&&!unscheduled.length&&search();
  const suggestions=complete?proposed:best;
  if(!complete)for(const task of tasks){const planned=suggestions.filter(e=>e.classroom_id===task.classroom_id&&e.subject_id===task.subject_id).length;const remaining=task.required-planned;if(remaining>0)unscheduled.push({classroomId:task.classroom_id,classroomName:task.classroom_name,subjectId:task.subject_id,subjectName:task.subject_name,remainingPeriods:remaining,reason:exhausted?'Planning limit reached. Reduce the scope or relax workload/availability rules.':'No complete timetable fits the current periods, availability and workload rules.'})}
  const verified=[...conflicts,...timetableConflicts([...existing,...suggestions])];
  return{created:suggestions.length,suggestions,unscheduled,complete:complete&&!verified.length,conflicts:verified,
    periodMinutes:period,schoolDayStart:time(start),schoolDayEnd:time(end),preservedManual:existing.filter(e=>e.schedule_source!=='auto'||e.is_locked).length,
    agent:{engine:'constraint-planning',nodes,exhausted,steps:[{tool:'inspect',result:requirements.length+' class-subject requirements'},{tool:'search',result:nodes+' search states'},{tool:'verify',result:verified.length+' conflicts; '+unscheduled.length+' unmet requirements'},{tool:'commit',result:complete&&!verified.length?'Complete plan ready':'Existing timetable will be preserved'}]}};
}
