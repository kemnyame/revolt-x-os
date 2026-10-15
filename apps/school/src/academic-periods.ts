/** Period changes share one school lock so two administrators cannot activate
 * different terms or years concurrently. Historical records are never deleted. */
export async function activateYearPeriod(client:any,org:string,yearId:string,actor:string){
  await client.query("SELECT pg_advisory_xact_lock(hashtextextended($1,0))",['academic:'+org]);
  const target=(await client.query('SELECT * FROM academic_years WHERE id=$1 AND organisation_id=$2 FOR UPDATE',[yearId,org])).rows[0];
  if(!target)throw Object.assign(Error('Academic year was not found'),{statusCode:404});
  if(target.is_locked||target.status==='closed')throw Object.assign(Error('Reopen the closed academic year before activating it'),{statusCode:423});
  if(target.status==='active')return target;
  await client.query(`UPDATE terms SET status='closed',is_locked=true,locked_at=now(),locked_by_os_user_id=$3
    WHERE organisation_id=$1 AND academic_year_id<>$2 AND status='active'`,[org,yearId,actor]);
  await client.query(`UPDATE academic_years SET status='closed',is_locked=true,locked_at=now(),locked_by_os_user_id=$3
    WHERE organisation_id=$1 AND status='active' AND id<>$2`,[org,yearId,actor]);
  const row=(await client.query("UPDATE academic_years SET status='active',is_locked=false WHERE id=$1 AND organisation_id=$2 RETURNING *",[yearId,org])).rows[0];
  const first=(await client.query('SELECT id FROM terms WHERE organisation_id=$1 AND academic_year_id=$2 AND term_no=1',[org,yearId])).rows[0];
  if(!first)throw Object.assign(Error('The academic year must have First Term, Second Term and Third Term'),{statusCode:409});
  await client.query("UPDATE terms SET status='planned',is_locked=false,locked_at=NULL,locked_by_os_user_id=NULL WHERE organisation_id=$1 AND academic_year_id=$2",[org,yearId]);
  await client.query("UPDATE terms SET status='active' WHERE id=$1 AND organisation_id=$2",[first.id,org]);
  return row;
}

export async function activateTermPeriod(client:any,org:string,termId:string,actor:string){
  await client.query("SELECT pg_advisory_xact_lock(hashtextextended($1,0))",['academic:'+org]);
  const term=(await client.query(`SELECT t.*,y.status year_status,y.is_locked year_locked FROM terms t
    JOIN academic_years y ON y.id=t.academic_year_id AND y.organisation_id=t.organisation_id
    WHERE t.id=$1 AND t.organisation_id=$2 FOR UPDATE OF t,y`,[termId,org])).rows[0];
  if(!term)throw Object.assign(Error('Term was not found'),{statusCode:404});
  if(term.year_status!=='active'||term.year_locked)throw Object.assign(Error('Activate the academic year before activating a term'),{statusCode:409});
  if(term.is_locked||term.status==='closed')throw Object.assign(Error('An administrator must reopen this closed term first'),{statusCode:423});
  if(term.status==='active')return term;
  const preceding=(await client.query(`SELECT term_no,status FROM terms WHERE organisation_id=$1 AND academic_year_id=$2
    AND term_no<$3 ORDER BY term_no`,[org,term.academic_year_id,term.term_no])).rows;
  if(preceding.some((t:any)=>t.status==='planned'))throw Object.assign(Error('Activate terms in order: First Term, Second Term, then Third Term'),{statusCode:409});
  await client.query(`UPDATE terms SET status='closed',is_locked=true,locked_at=now(),locked_by_os_user_id=$3
    WHERE organisation_id=$1 AND academic_year_id=$2 AND status='active'`,[org,term.academic_year_id,actor]);
  return(await client.query("UPDATE terms SET status='active',is_locked=false WHERE id=$1 AND organisation_id=$2 RETURNING *",[termId,org])).rows[0];
}

export async function attendanceByClass(db:any,org:string,classIds:string[]|null=null,date?:string){
  return(await db.query(`SELECT c.id classroom_id,c.name classroom_name,
    count(DISTINCT e.student_id)::int students,
    count(DISTINCT ar.student_id) FILTER(WHERE ar.status='present')::int present,
    count(DISTINCT ar.student_id) FILTER(WHERE ar.status='absent')::int absent,
    count(DISTINCT ar.student_id) FILTER(WHERE ar.status='late')::int late,
    count(DISTINCT ar.student_id) FILTER(WHERE ar.status='excused')::int excused,
    (count(DISTINCT e.student_id)-count(DISTINCT ar.student_id))::int unmarked
    FROM classrooms c JOIN academic_years y ON y.id=c.academic_year_id AND y.status='active' AND y.is_locked=false
    LEFT JOIN enrolments e ON e.classroom_id=c.id AND e.organisation_id=c.organisation_id AND e.status='active'
    LEFT JOIN attendance_records ar ON ar.organisation_id=c.organisation_id AND ar.classroom_id=c.id
      AND ar.student_id=e.student_id AND ar.attendance_date=COALESCE($3::date,current_date)
    WHERE c.organisation_id=$1 AND c.is_active=true AND ($2::uuid[] IS NULL OR c.id=ANY($2::uuid[]))
    GROUP BY c.id ORDER BY c.name`,[org,classIds,date??null])).rows;
}

/** Teachers may only change work in the active year and term, including when
 * an old bookmark or a hand-written request supplies a different period. */
export async function registerTeachingPeriodGuard(app:any,d:any){
  const {db,config,authorize,schoolRoleProfile,fail}=d;
  app.addHook('preHandler',async(request:any)=>{
    if(['GET','HEAD','OPTIONS'].includes(request.method))return;
    const path=String(request.url).split('?')[0]||'';
    if(!/^\/api\/(assessments|homework|lesson-notes|attendance\/mark)(\/|$)/.test(path))return;
    const a=await authorize(request,db,config);
    if((await schoolRoleProfile(db,a.core.organisation_id,a.role))?.portal_mode!=='teacher')return;
    const b=request.body&&typeof request.body==='object'?request.body:{};
    let yearId=b.academicYearId||null,termId=b.termId||null,classId=b.classroomId||null;
    const match=path.match(/^\/api\/(assessments|homework|lesson-notes)\/([0-9a-f-]{36})(?:\/|$)/i);
    if(match){
      const table=({assessments:'assessments',homework:'homework_assignments','lesson-notes':'lesson_notes'} as Record<string,string>)[match[1]!];
      const row=(await db.query('SELECT academic_year_id,term_id,classroom_id FROM '+table+' WHERE id=$1 AND organisation_id=$2',[match[2],a.core.organisation_id])).rows[0];
      if(!row)throw fail(404,'The school record was not found');
      yearId=row.academic_year_id;termId=row.term_id;classId=row.classroom_id;
    }
    if(!yearId&&!termId&&!classId)return;
    const period=(await db.query(`SELECT 1 FROM academic_years y JOIN terms t ON t.academic_year_id=y.id AND t.organisation_id=y.organisation_id
      WHERE y.organisation_id=$1 AND y.status='active' AND NOT y.is_locked AND t.status='active' AND NOT t.is_locked
      AND ($2::uuid IS NULL OR y.id=$2) AND ($3::uuid IS NULL OR t.id=$3)
      AND ($4::uuid IS NULL OR EXISTS(SELECT 1 FROM classrooms c WHERE c.id=$4 AND c.organisation_id=$1 AND c.academic_year_id=y.id AND c.is_active))`,[a.core.organisation_id,yearId,termId,classId])).rows[0];
    if(!period)throw fail(423,'Teachers can change records only in the active academic year and term. Ask an administrator to reopen and activate a closed period.');
  });
}
