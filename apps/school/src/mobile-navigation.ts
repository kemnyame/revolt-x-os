/** Route history contains navigation identifiers only. Form data and API results
 * stay in the current tab's memory and never enter URLs or persistent history. */
export const schoolNavigationScript=String.raw`
(function(){
 if(window.rxSchoolHistory)return;
 var config=null,current=null,entries=new Map(),sequence=0,restoring=false,leaving=false,dialog=null;
 function path(){return location.pathname+location.search}
 function state(entry,root){return{rxSchoolView:true,root:!!root,id:entry.id}}
 function write(entry,replace,root){history[replace?'replaceState':'pushState'](state(entry,root),'',path())}
 function dismiss(){if(dialog){dialog.remove();dialog=null}}
 function rootBack(){
  var nativeApp=typeof navigator!=='undefined'&&/RevoltSchoolAndroid\//.test(navigator.userAgent||'');
  write(current,false,false);if(dialog)return;
  dialog=document.createElement('div');dialog.className='rx-exit-dialog';dialog.setAttribute('role','dialog');dialog.setAttribute('aria-modal','true');dialog.setAttribute('aria-label','Leave School app?');
  dialog.innerHTML='<div><h2>Leave School app?</h2><p>You are on the home screen. You can stay here or return to the previous website.</p><button type="button" data-stay>Stay in School</button><button type="button" data-leave>Leave School</button></div>';
  if(nativeApp){dialog.querySelector('p').textContent='You are on the home screen. You can stay here or return to the account choices.';dialog.querySelector('[data-leave]').textContent='Account choices'}
  document.body.appendChild(dialog);dialog.querySelector('[data-stay]').onclick=dismiss;dialog.querySelector('[data-leave]').onclick=function(){dismiss();if(nativeApp){var school=new URLSearchParams(location.search).get('school');location.replace('/mobile'+(school?'?school='+encodeURIComponent(school):''));return}leaving=true;history.go(-2)};dialog.querySelector('[data-stay]').focus();
 }
 function back(event){
  if(!config||leaving)return;
  if(dialog){dismiss();write(current,false,false);return}
  if(config.close&&config.close()){write(current,false,false);return}
  if(config.canLeave&&!config.canLeave()){write(current,false,false);return}
  var next=event.state&&event.state.rxSchoolView&&entries.get(event.state.id);
  if(!next||event.state.root){rootBack();return}
  current=next;restoring=true;Promise.resolve(config.restore(next.page,next.arg)).finally(function(){restoring=false});
 }
 window.rxSchoolHistory={
  bind:function(options){if(config)return;config=options;if(typeof history==='undefined'||!history.pushState){config=null;return}current={id:++sequence,page:options.home,arg:null};entries.set(current.id,current);write(current,true,true);write(current,false,false);addEventListener('popstate',back)},
  visit:function(page,arg){if(arg===undefined)arg=null;if(!config||restoring||leaving)return;if(current.page===page&&current.arg===arg)return;current={id:++sequence,page:page,arg:arg};entries.set(current.id,current);write(current,false,false)},
  back:function(){if(!config)return false;history.back();return true}
 };
})();
`;

export const mobileControlCss=String.raw`
.rx-optimize-controls{display:none;align-items:center;justify-content:center;gap:6px;min-height:44px;border:1px solid #b9d1c4;border-radius:12px;background:#f0f7f2;color:#244d39;padding:9px 12px;font:600 13px/1.2 system-ui;cursor:pointer}.rx-optimize-controls[aria-pressed=true]{background:#24634e;color:white}.rx-exit-dialog{position:fixed;inset:0;z-index:15000;background:#10241a88;display:grid;place-items:center;padding:20px}.rx-exit-dialog>div{max-width:420px;border-radius:20px;background:#fff;color:#223c32;padding:24px;box-shadow:0 20px 60px #0003}.rx-exit-dialog button{min-height:44px;padding:10px 15px;border:1px solid #b9d1c4;border-radius:10px;background:#edf6ef;color:#234c39;margin:5px 6px 0 0}.rx-exit-dialog h2{margin-top:0}
@media(max-width:1100px),(pointer:coarse){.rx-optimize-controls{display:inline-flex}.m-header{flex-wrap:wrap}.m-header .rx-optimize-controls{margin-left:auto}html[data-mobile-controls=optimized]{font-size:16px;scroll-padding-top:100px}html[data-mobile-controls=optimized] input:not([type=checkbox]):not([type=radio]),html[data-mobile-controls=optimized] select,html[data-mobile-controls=optimized] textarea{font-size:16px!important;min-height:46px;max-width:100%;box-sizing:border-box}html[data-mobile-controls=optimized] button,html[data-mobile-controls=optimized] .m-mini{min-height:44px;white-space:normal}html[data-mobile-controls=optimized] .row,html[data-mobile-controls=optimized] .toolbar{flex-wrap:wrap}html[data-mobile-controls=optimized] .row>*{min-width:min(220px,100%)}html[data-mobile-controls=optimized] .table{max-width:100%;overflow:auto;overscroll-behavior-x:contain;-webkit-overflow-scrolling:touch}html[data-mobile-controls=optimized] .modalbox,html[data-mobile-controls=optimized] .box{width:min(900px,calc(100vw - 24px));max-height:calc(100dvh - 30px);box-sizing:border-box}html[data-mobile-controls=optimized] .main{min-width:0;padding-left:14px;padding-right:14px}html[data-mobile-controls=optimized] .three,html[data-mobile-controls=optimized] .two{grid-template-columns:repeat(auto-fit,minmax(min(260px,100%),1fr))}}
@media(max-width:600px){html[data-mobile-controls=optimized] .row{flex-direction:column}html[data-mobile-controls=optimized] .row>*{min-width:0;width:100%}.m-header .rx-optimize-controls{font-size:11px;padding:8px}}
@media print{.rx-optimize-controls,.rx-exit-dialog{display:none!important}}
`;

export const mobileControlScript=String.raw`
(function(){
 if(document.getElementById('rxOptimizeControls'))return;
 var enabled=false;try{enabled=localStorage.getItem('rx_mobile_controls')==='optimized'}catch(e){}
 var button=document.createElement('button');button.id='rxOptimizeControls';button.type='button';button.className='rx-optimize-controls';button.textContent='Optimize controls';button.title='Adjust controls for phones and tablets';
 var target=document.querySelector('.top .right')||document.querySelector('.m-header')||document.querySelector('header.top')||document.querySelector('.top')||document.body;
 target.appendChild(button);function apply(){document.documentElement.setAttribute('data-mobile-controls',enabled?'optimized':'standard');button.setAttribute('aria-pressed',String(enabled));button.textContent=enabled?'Controls optimized':'Optimize controls'}
 button.onclick=function(){enabled=!enabled;try{localStorage.setItem('rx_mobile_controls',enabled?'optimized':'standard')}catch(e){}apply()};apply();
})();
`;
