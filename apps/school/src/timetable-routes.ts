import {createHash} from 'node:crypto';
import {z} from 'zod';
import {schoolRecordId} from './record-id.js';
import {planTimetable} from './timetable-agent.js';

/** Preview and apply use the same planner, scope and regeneration rules. Apply
 * takes a transaction lock and only removes old automatic slots after a complete
 * replacement has been verified. Manual and locked periods remain intact. */
export async function registerTimetableAgentRoutes(app:any,d:any){
  const {db,config,authorize,one,tx,fail,audit}=d;
  const schema=z.object({academicYearId:schoolRecordId,termId:schoolRecordId.nullable().optional(),teacherOsUserId:schoolRecordId.nullable().optional(),classroomId:schoolRecordId.nullable().optional(),regenerateAuto:z.boolean().default(true),dryRun:z.boolean().default(false),planFingerprint:z.string().optional()});
  async function run(request:any,reply:any,mode:'preview'|'apply'|'auto'){
    const a=await authorize(request,db,config,'timetable.auto_schedule'),b=schema.parse(request.body);
    const dryRun=mode==='preview'||(mode==='auto'&&b.dryRun);
    const result=await tx(db,async(client:any)=>{
      await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))',['timetable:'+a.core.organisation_id+':'+b.academicYearId]);
      const year=await one(client,'SELECT * FROM academic_years WHERE id=$1 AND organisation_id=$2',[b.academicYearId,a.core.organisation_id]);
      if(year.is_locked||year.status==='closed')throw fail(423,'Reopen the academic year before scheduling');
      if(b.termId){const term=await one(client,'SELECT * FROM terms WHERE id=$1 AND organisation_id=$2 AND academic_year_id=$3',[b.termId,a.core.organisation_id,b.academicYearId]);if(term.is_locked||term.status==='closed')throw fail(423,'Reopen the term before scheduling')}
      const settings=(await client.query(`SELECT * FROM timetable_settings WHERE organisation_id=$1 AND academic_year_id=$2
        AND (term_id IS NOT DISTINCT FROM $3::uuid OR term_id IS NULL) ORDER BY term_id NULLS LAST LIMIT 1`,[a.core.organisation_id,b.academicYearId,b.termId??null])).rows[0]||{};
      const breaks=(await client.query(`SELECT * FROM timetable_breaks WHERE organisation_id=$1 AND academic_year_id=$2 AND (term_id IS NOT DISTINCT FROM $3::uuid OR term_id IS NULL)`,[a.core.organisation_id,b.academicYearId,b.termId??null])).rows;
      const unavailability=(await client.query(`SELECT * FROM timetable_teacher_unavailability WHERE organisation_id=$1 AND academic_year_id=$2 AND (term_id IS NOT DISTINCT FROM $3::uuid OR term_id IS NULL)`,[a.core.organisation_id,b.academicYearId,b.termId??null])).rows;
      const requirements=(await client.query(`SELECT cs.*,c.name classroom_name,s.name subject_name,ta.teacher_os_user_id
        FROM class_subjects cs JOIN classrooms c ON c.id=cs.classroom_id AND c.is_active=true
        JOIN subjects s ON s.id=cs.subject_id AND s.is_active=true
        LEFT JOIN LATERAL(SELECT x.teacher_os_user_id FROM teacher_assignments x
          JOIN school_memberships m ON m.organisation_id=x.organisation_id AND m.os_user_id=x.teacher_os_user_id AND m.status='active'
          JOIN school_roles r ON r.organisation_id=m.organisation_id AND r.key=m.role AND r.can_teach=true AND r.is_active=true
          WHERE x.organisation_id=cs.organisation_id AND x.academic_year_id=cs.academic_year_id AND x.classroom_id=cs.classroom_id AND x.subject_id=cs.subject_id
            AND x.is_active=true AND (x.term_id IS NOT DISTINCT FROM $3::uuid OR x.term_id IS NULL)
          ORDER BY x.term_id NULLS LAST,x.created_at DESC LIMIT 1) ta ON true
        WHERE cs.organisation_id=$1 AND cs.academic_year_id=$2 AND cs.is_active=true
          AND ($4::uuid IS NULL OR ta.teacher_os_user_id=$4) AND ($5::uuid IS NULL OR cs.classroom_id=$5)
        ORDER BY c.name,s.name`,[a.core.organisation_id,b.academicYearId,b.termId??null,b.teacherOsUserId??null,b.classroomId??null])).rows;
      const all=(await client.query(`SELECT * FROM timetable_entries WHERE organisation_id=$1 AND academic_year_id=$2
        AND ($3::uuid IS NULL OR term_id IS NOT DISTINCT FROM $3::uuid OR term_id IS NULL) ORDER BY id`,[a.core.organisation_id,b.academicYearId,b.termId??null])).rows;
      const replace=all.filter((r:any)=>b.regenerateAuto&&r.schedule_source==='auto'&&!r.is_locked&&(r.term_id??null)===(b.termId??null)&&(!b.teacherOsUserId||r.teacher_os_user_id===b.teacherOsUserId)&&(!b.classroomId||r.classroom_id===b.classroomId));
      const ids=new Set(replace.map((r:any)=>r.id)),existing=all.filter((r:any)=>!ids.has(r.id));
      const fingerprint=createHash('sha256').update(JSON.stringify({requirements,all,settings,breaks,unavailability,regenerate:b.regenerateAuto})).digest('hex');
      if(b.planFingerprint&&b.planFingerprint!==fingerprint)throw fail(409,'The timetable, assignments or rules changed after preview. Preview the schedule again before applying it.');
      const plan=planTimetable({requirements,existing,settings,breaks,unavailability,termId:b.termId??null});
      if(!dryRun&&!plan.complete)throw fail(409,'The existing timetable was preserved. '+(plan.conflicts.length?plan.conflicts.map((c:any)=>c.reason).slice(0,5).join(' | '):plan.unscheduled.map((u:any)=>u.classroomName+' / '+u.subjectName+': '+u.reason).slice(0,5).join(' | ')));
      if(!dryRun){
        if(replace.length)await client.query('DELETE FROM timetable_entries WHERE organisation_id=$1 AND id=ANY($2::uuid[])',[a.core.organisation_id,replace.map((r:any)=>r.id)]);
        for(const s of plan.suggestions)await client.query(`INSERT INTO timetable_entries(organisation_id,academic_year_id,term_id,classroom_id,subject_id,teacher_os_user_id,day_of_week,start_time,end_time,room,schedule_source,is_locked)
          VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,'auto',false)`,[a.core.organisation_id,b.academicYearId,b.termId??null,s.classroom_id,s.subject_id,s.teacher_os_user_id,s.day_of_week,s.start_time,s.end_time,s.room]);
      }
      await client.query(`INSERT INTO timetable_agent_runs(organisation_id,academic_year_id,term_id,actor_os_user_id,status,summary)
        VALUES($1,$2,$3,$4,$5,$6)`,[a.core.organisation_id,b.academicYearId,b.termId??null,a.core.id,dryRun?(plan.complete?'preview':'infeasible'):'applied',JSON.stringify({created:plan.created,replaced:replace.length,unscheduled:plan.unscheduled,conflicts:plan.conflicts,agent:plan.agent})]);
      return{...plan,dryRun,regenerateAuto:b.regenerateAuto,replaced:dryRun?0:replace.length,planFingerprint:fingerprint};
    });
    if(!dryRun)await audit(a.core.organisation_id,a.core.id,'timetable.auto_scheduled','timetable',null,{academicYearId:b.academicYearId,termId:b.termId??null,created:result.created,replaced:result.replaced,agent:result.agent});
    return reply.code(dryRun?200:201).send(result);
  }
  app.post('/api/timetable/auto-schedule/preview',(req:any,reply:any)=>run(req,reply,'preview'));
  app.post('/api/timetable/auto-schedule/apply',(req:any,reply:any)=>run(req,reply,'apply'));
  app.post('/api/timetable/auto-schedule',(req:any,reply:any)=>run(req,reply,'auto'));
}
