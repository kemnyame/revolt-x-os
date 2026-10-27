/* Private Google Apps Script sender. Never put credentials in this source file. */
function authorizeSender() {
  var properties = PropertiesService.getScriptProperties();
  var email = Session.getEffectiveUser().getEmail().toLowerCase();
  if (!email) throw new Error('Sign in to the Gmail account that will send School emails.');
  if (!properties.getProperty('MAILER_SECRET')) properties.setProperty('MAILER_SECRET',Utilities.getUuid().replace(/-/g,'')+Utilities.getUuid().replace(/-/g,''));
  properties.setProperty('SENDER_EMAIL',email);
  MailApp.getRemainingDailyQuota();
  // Connection secrets are available only in Project Settings > Script properties.
}
function reply_(value) { return ContentService.createTextOutput(JSON.stringify(value)).setMimeType(ContentService.MimeType.JSON); }
function sameSecret_(left,right) {
  var a=Utilities.computeDigest(Utilities.DigestAlgorithm.SHA_256,String(left||'')),b=Utilities.computeDigest(Utilities.DigestAlgorithm.SHA_256,String(right||'')),difference=0;
  for(var i=0;i<a.length;i++)difference|=a[i]^b[i];return difference===0;
}
function email_(value) {return typeof value==='string'&&value.length<=254&&/^[^\s@<>,;]+@[^\s@<>,;]+\.[^\s@<>,;]+$/.test(value);}
function doGet() {return reply_({service:'Revolt-X School account email',version:1});}
function doPost(event) {
  var props=PropertiesService.getScriptProperties(),secret=props.getProperty('MAILER_SECRET'),sender=props.getProperty('SENDER_EMAIL');
  if(!secret||!sender)return reply_({ok:false,code:'NOT_CONFIGURED'});
  var data;try{if(!event||!event.postData||event.postData.contents.length>300000)throw new Error();data=JSON.parse(event.postData.contents);if(!data||typeof data!=='object'||Array.isArray(data))throw new Error();}catch(_){return reply_({ok:false,code:'BAD_REQUEST'});}
  if(!sameSecret_(data.secret,secret))return reply_({ok:false,code:'AUTH'});
  if(Session.getEffectiveUser().getEmail().toLowerCase()!==sender||data.expectedSender!==sender)return reply_({ok:false,code:'WRONG_SENDER'});
  if(!/^[a-f0-9]{64}$/.test(data.requestId)||!email_(data.to)||!email_(data.replyTo)||typeof data.subject!=='string'||data.subject.length>300||/[\r\n]/.test(data.subject)||typeof data.text!=='string'||typeof data.html!=='string')return reply_({ok:false,code:'BAD_REQUEST'});
  var lock=LockService.getScriptLock();if(!lock.tryLock(10000))return reply_({ok:false,code:'BUSY'});
  try {
    var key='sent_'+data.requestId,old=props.getProperty(key),fingerprint=Utilities.base64Encode(Utilities.computeDigest(Utilities.DigestAlgorithm.SHA_256,JSON.stringify([sender,data.to,data.subject,data.text,data.html,data.replyTo])));
    if(old){var receipt=JSON.parse(old);if(receipt.hash!==fingerprint)return reply_({ok:false,code:'CONFLICT'});return receipt.state==='accepted'?reply_({ok:true,id:receipt.id,sender:sender}):reply_({ok:false,code:'NEEDS_REVIEW'});}
    if(MailApp.getRemainingDailyQuota()<1)return reply_({ok:false,code:'QUOTA'});
    // Remember an uncertain attempt before sending. A crash must never cause a duplicate reset email.
    var id='gas-'+Utilities.getUuid(),now=Date.now();props.setProperty(key,JSON.stringify({id:id,hash:fingerprint,state:'sending',at:now}));
    try {MailApp.sendEmail({to:data.to,subject:data.subject,body:data.text,htmlBody:data.html,replyTo:data.replyTo,name:'Revolt-X School'});}
    catch(_){return reply_({ok:false,code:'NEEDS_REVIEW'});}
    props.setProperty(key,JSON.stringify({id:id,hash:fingerprint,state:'accepted',at:now}));
    // Retain only receipt hashes and correlation IDs. Message contents and reset links are never stored here.
    var all=props.getProperties();Object.keys(all).forEach(function(name){if(name.indexOf('sent_')!==0)return;try{if(now-JSON.parse(all[name]).at>7*86400000)props.deleteProperty(name);}catch(_){}});
    return reply_({ok:true,id:id,sender:sender});
  } finally {lock.releaseLock();}
}
