/* Presentation-only interactions shared by the existing Shop screens. */
(() => {
  const path=location.pathname;
  document.body.classList.add(path.startsWith('/customer/')?'customer-screen':path.startsWith('/store/')?'store-screen':path==='/demo-login'?'demo-screen':path==='/login'||path==='/reset-password'?'auth-screen':'workspace-screen');
  const main=document.querySelector('main');
  if(main){main.id=main.id||'main-content';main.tabIndex=-1;const skip=document.createElement('a');skip.className='skip-link';skip.href='#'+main.id;skip.textContent='Skip to content';document.body.prepend(skip);}
  const drawer=document.querySelector('.sidebar,.app>.side');
  if(drawer){
    const shade=document.createElement('button');shade.className='drawer-shade';shade.setAttribute('aria-label','Close navigation');shade.tabIndex=-1;document.body.append(shade);
    const close=document.createElement('button');close.className='drawer-close';close.type='button';close.setAttribute('aria-label','Close navigation');close.textContent='×';drawer.prepend(close);
    const trigger=document.querySelector('.mobile-menu,#menu');
    if(trigger){trigger.setAttribute('aria-label','Open navigation');trigger.setAttribute('aria-controls',drawer.id);}
    const sync=()=>{const open=drawer.classList.contains('open');shade.classList.toggle('open',open);trigger?.setAttribute('aria-expanded',String(open));};
    const dismiss=()=>{drawer.classList.remove('open');sync();trigger?.focus();};
    close.onclick=shade.onclick=dismiss;
    new MutationObserver(sync).observe(drawer,{attributes:true,attributeFilter:['class']});sync();
    document.addEventListener('keydown',e=>{if(e.key==='Escape'&&drawer.classList.contains('open'))dismiss();});
    drawer.addEventListener('click',e=>{if(e.target.closest('[data-page]')){drawer.classList.remove('open');sync();}});
  }
  const nav=document.querySelector('.sidebar,.app>.side');
  if(nav){const mark=()=>nav.querySelectorAll('[data-page]').forEach(b=>{if(b.classList.contains('active'))b.setAttribute('aria-current','page');else b.removeAttribute('aria-current');});new MutationObserver(mark).observe(nav,{subtree:true,attributes:true,attributeFilter:['class'],childList:true});mark();}
  // Keep wide operational records inside their card on small screens.
  const wrapTables=()=>document.querySelectorAll('table').forEach(table=>{if(table.closest('.table-wrap,.table,.rx-table'))return;const wrap=document.createElement('div');wrap.className='table-wrap rx-table';wrap.tabIndex=0;wrap.setAttribute('role','region');wrap.setAttribute('aria-label',(table.closest('.card')?.querySelector('h3')?.textContent||'Records')+' table');table.before(wrap);wrap.append(table);});
  wrapTables();new MutationObserver(wrapTables).observe(document.body,{childList:true,subtree:true});
  document.querySelectorAll('input').forEach(input=>{if(input.type==='email')input.autocomplete='email';});
})();
