/** Public school context survives authentication changes. It is never a credential. */
export const schoolLocationScript=String.raw`
function schoolFromLocation(){
  var parts=location.pathname.split('/').filter(Boolean);
  if(parts[0]==='s'&&parts[1]){try{return decodeURIComponent(parts[1]).trim()}catch(e){return ''}}
  return(new URLSearchParams(location.search).get('school')||'').trim();
}
function recoverSchoolLocation(portal){
  if(schoolFromLocation()||location.pathname.startsWith('/s/')||new URLSearchParams(location.search).has('school'))return false;
  var family=portal==='teacher'?'school':portal==='staff'?'school':portal,hint='',school='',target;
  if(location.pathname.startsWith('/mobile')){try{school=localStorage.getItem('rx_mobile_school')||''}catch(e){}}
  try{hint=sessionStorage.getItem('rx_'+family+'_login_url')||''}catch(e){}
  try{
    var saved=new URL(hint,location.origin),match=saved.pathname.match(/^\/s\/([^/]+)\/(login|admin-login)$/);
    if(!school&&hint&&saved.origin===location.origin&&match){school=decodeURIComponent(match[1]);target=saved}
    else if(!school&&hint&&saved.origin===location.origin&&(saved.pathname==='/'+portal||saved.pathname==='/mobile/'+portal))school=saved.searchParams.get('school')||'';
  }catch(e){}
  // These are navigation hints from earlier releases, never authentication or
  // account selection. The destination still resolves and verifies its tenant.
  if(!school){try{school=localStorage.getItem('rx_school_id')||''}catch(e){}}
  if(!school||school.length>120||/[\s/\\?#<>]/.test(school))return false;
  var mobile=/^\/mobile(?:\/|$)/.test(location.pathname);
  if(mobile||family!=='school')target=new URL(location.pathname,location.origin);
  else if(!target||(location.pathname==='/admin-login'&&!target.pathname.endsWith('/admin-login')))target=new URL('/s/'+encodeURIComponent(school)+(location.pathname==='/admin-login'?'/admin-login':'/login'),location.origin);
  if(mobile||family!=='school')target.searchParams.set('school',school);
  var query=new URLSearchParams(location.search);
  for(var key of ['expired','next','setup'])if(query.has(key))target.searchParams.set(key,query.get(key));
  location.replace(target.pathname+target.search);return true;
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
  const mobileSetup='<p class="rx-mobile-setup-link" style="text-align:center;margin:18px"><a href="/mobile/setup?school='+encodeURIComponent(school.tenant_slug)+'">Set up mobile app for this school</a></p>';
  if(html.includes('id="schoolCredentials"'))html=html.replace('</body>',mobileSetup+'</body>');
  return html.replace('href="/school.webmanifest"','href="/school.webmanifest?school='+encodeURIComponent(school.tenant_slug)+'"').replace(/<body\b/, '<body data-school-id="'+escapeAttribute(school.tenant_slug)+'" data-school-name="'+escapeAttribute(school.school_name)+'"');
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
