/** Public school context survives authentication changes. It is never a credential. */
export const schoolLocationScript=String.raw`
function schoolFromLocation(){
  var parts=location.pathname.split('/').filter(Boolean);
  if(parts[0]==='s'&&parts[1]){try{return decodeURIComponent(parts[1]).trim()}catch(e){return ''}}
  return(new URLSearchParams(location.search).get('school')||'').trim();
}
function schoolWorkspacePath(path,school){
  var url=new URL(path||'/',location.origin);
  if(url.origin!==location.origin||!/^\/(?:teacher|headteacher|parent|student|mobile(?:\/(?:teacher|parent))?|students\/[^/]+)?$/.test(url.pathname))url=new URL('/',location.origin);
  if(school)url.searchParams.set('school',school);
  return url.pathname+url.search+url.hash;
}
`;

function escapeAttribute(value:unknown){return String(value??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]!))}

/** Only the locally resolved tenant is rendered into a dedicated school page. */
export function schoolTenantDocument(html:string,school:{tenant_slug:string;school_name:string}){
  return html.replace(/<body\b/, '<body data-school-id="'+escapeAttribute(school.tenant_slug)+'" data-school-name="'+escapeAttribute(school.school_name)+'"');
}

export function schoolWorkspaceUrl(school:string,path='/'){
  const url=new URL(path,'https://school.invalid');
  url.searchParams.set('school',school);
  return url.pathname+url.search+url.hash;
}

export function schoolCookieValue(header:string|undefined,name:string){
  const entry=String(header||'').split(';').map(p=>p.trim()).find(p=>p.startsWith(name+'='));
  if(!entry)return '';
  try{return decodeURIComponent(entry.slice(name.length+1))}catch{return ''}
}
