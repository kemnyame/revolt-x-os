/** Do not persist bearer reset links in request logs. */
export function safeRequestUrl(value:string){
  const url=new URL(String(value||'/'),'http://localhost');
  for(const key of [...url.searchParams.keys()])if(key.toLowerCase()==='token')url.searchParams.set(key,'[redacted]');
  return url.pathname+(url.search?url.search.replace(/%5Bredacted%5D/g,'[redacted]'):'');
}
