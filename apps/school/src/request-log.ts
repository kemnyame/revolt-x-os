/** Reset tokens must never enter request logs through URL query strings. */
export function safeRequestUrl(url:string){
  return String(url||'').replace(/([?&]token=)[^&]*/gi,'$1[redacted]');
}
