import { z } from 'zod';

/**
 * Exposes School activity to Core OS without giving Core direct database credentials.
 *
 * This endpoint is intentionally service-to-service only. It returns the School's own audit,
 * change and request logs for one organisation so Commercial Control can see what School
 * administrators are doing. Parent/student/public activity is not presented as administrator
 * activity unless it already appears in the audited School event stream.
 */
export async function registerCommercialObservabilityRoutes(app:any,deps:any){
  const {db,requireCoreServiceRequest}=deps;

  app.get('/api/internal/audit',async(request:any)=>{
    requireCoreServiceRequest(request);
    const q=z.object({
      organisationId:z.string().uuid(),
      limit:z.coerce.number().int().min(1).max(250).default(100)
    }).parse(request.query);

    const [audits,changes,requests]=await Promise.all([
      db.query(`SELECT id,'audit' source,actor_os_user_id,action,resource_type,resource_id,
          metadata,NULL::jsonb old_value,NULL::jsonb new_value,created_at
        FROM school_audit_logs
        WHERE organisation_id=$1
        ORDER BY created_at DESC LIMIT $2`,[q.organisationId,q.limit]),
      db.query(`SELECT id,'change' source,actor_os_user_id,action,resource_type,resource_id,
          metadata,old_value,new_value,created_at
        FROM school_change_logs
        WHERE organisation_id=$1
        ORDER BY created_at DESC LIMIT $2`,[q.organisationId,q.limit]),
      db.query(`SELECT request_id id,'request' source,actor_os_user_id,
          method||' '||path action,'http_request' resource_type,NULL::text resource_id,
          jsonb_build_object('method',method,'path',path,'statusCode',status_code,'durationMs',duration_ms,'outcome',outcome) metadata,
          NULL::jsonb old_value,NULL::jsonb new_value,created_at
        FROM system_request_logs
        WHERE organisation_id=$1 AND actor_os_user_id IS NOT NULL
        ORDER BY created_at DESC LIMIT $2`,[q.organisationId,q.limit])
    ]);

    const activity=[...audits.rows,...changes.rows,...requests.rows]
      .sort((a:any,b:any)=>new Date(b.created_at).getTime()-new Date(a.created_at).getTime())
      .slice(0,q.limit);
    return{organisationId:q.organisationId,count:activity.length,activity};
  });
}
