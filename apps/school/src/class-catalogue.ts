import { z } from 'zod';
import { schoolRecordId } from './record-id.js';

/** Class names repeat between years by design. Daily operations default to one
 * academic year; setup and rollover explicitly request the full catalogue. */
export const schoolClassCatalogueQuery = `
  WITH selected_year AS (
    SELECT id FROM academic_years WHERE organisation_id=$1
    ORDER BY CASE status WHEN 'active' THEN 0 WHEN 'draft' THEN 1 ELSE 2 END,start_date DESC,id
    LIMIT 1
  )
  SELECT c.*,g.code grade_code,g.name grade_name,y.name academic_year_name,y.status academic_year_status,
    (SELECT count(*)::int FROM enrolments e WHERE e.classroom_id=c.id AND e.status='active') student_count,
    (SELECT count(*)::int FROM class_subjects cs WHERE cs.classroom_id=c.id AND cs.is_active=true) subject_count
  FROM classrooms c JOIN grade_levels g ON g.id=c.grade_level_id JOIN academic_years y ON y.id=c.academic_year_id
  WHERE c.organisation_id=$1 AND (
    ($2::uuid IS NOT NULL AND c.academic_year_id=$2)
    OR ($2::uuid IS NULL AND ($3::boolean OR c.academic_year_id=(SELECT id FROM selected_year)))
  )
  ORDER BY y.start_date DESC,g.level_order,c.name,c.stream,c.id`;

export async function registerSchoolClassCatalogue(app:any,deps:any){
  const {db,config,authorize,schoolRoleProfile}=deps;
  app.get('/api/classes',async(request:any)=>{
    const a=await authorize(request,db,config,'academic.view');
    const q=z.object({academicYearId:schoolRecordId.optional(),includeAllYears:z.enum(['true','false']).default('false')}).parse(request.query);
    const teacher=schoolRoleProfile&&(await schoolRoleProfile(db,a.core.organisation_id,a.role))?.portal_mode==='teacher';
    const sql=teacher?schoolClassCatalogueQuery.replace('ORDER BY y.start_date',"AND y.status='active' AND y.is_locked=false AND c.is_active=true ORDER BY y.start_date"):schoolClassCatalogueQuery;
    return(await db.query(sql,[a.core.organisation_id,q.academicYearId??null,!teacher&&q.includeAllYears==='true'])).rows;
  });
}
