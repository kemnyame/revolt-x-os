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

// Consistent navigation icons and a filter for the existing workspace modules.
(() => {
 const nav=document.querySelector('.sidebar');if(!nav)return;
 const paths={overview:'M3 3h7v7H3z M14 3h7v7h-7z M3 14h7v7H3z M14 14h7v7h-7z',appointments:'M4 5h16v16H4z M8 3v4 M16 3v4 M4 10h16',queue:'M8 6h13 M8 12h13 M8 18h13 M3 6h1 M3 12h1 M3 18h1',customers:'M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2 M16 3a4 4 0 0 1 0 8 M22 21v-2a4 4 0 0 0-3-3.87 M13 7a4 4 0 1 1-8 0 4 4 0 0 1 8 0',team:'M12 8a3 3 0 1 1-6 0 3 3 0 0 1 6 0 M3 21v-3a5 5 0 0 1 12 0v3 M17 5h4 M19 3v4 M18 12h3 M18 16h3',services:'M3 3h8l10 10-8 8L3 11z M7 7h.01',checkout:'M3 3h2l3 13h10l3-9H6 M9 21h.01 M18 21h.01',inventory:'M3 7l9-5 9 5v10l-9 5-9-5z M3 7l9 5 9-5 M12 12v10 M7 4l10 5',payments:'M3 5h18v14H3z M3 10h18 M7 15h3',finance:'M3 21h18 M5 21V10 M10 21V10 M15 21V10 M20 21V10 M2 7l10-5 10 5z',reports:'M4 3v18h17 M8 16v-4 M13 16V8 M18 16V5',retention:'M3 11a9 9 0 1 1 3 8 M3 4v7h7',communications:'M3 4h18v14H8l-5 3z M7 8h10 M7 12h7',assets:'M14 6l4 4 M3 18l9-9a6 6 0 0 1 8-7l-4 4 2 2 4-4a6 6 0 0 1-7 8l-9 9z',procurement:'M3 7h16 M15 3l4 4-4 4 M21 17H5 M9 13l-4 4 4 4',tickets:'M3 5h18v5a2 2 0 0 0 0 4v5H3v-5a2 2 0 0 0 0-4z M15 5v3 M15 11v2 M15 16v3',posdevices:'M6 2h12v20H6z M9 5h6v6H9z M9 15h.01 M15 15h.01 M9 18h.01 M15 18h.01',access:'M12 2l8 4v6c0 5-8 10-8 10S4 17 4 12V6z M9 12l2 2 4-4',audit:'M6 3h12v18H6z M9 8h6 M9 12h6 M9 16h4',settings:'M9 3h6l1 4 4 1v8l-4 1-1 4H9l-1-4-4-1V8l4-1z M15 12a3 3 0 1 1-6 0 3 3 0 0 1 6 0',approvals:'M5 3h14v18H5z M8 12l3 3 5-6'};
 const decorate=()=>nav.querySelectorAll('.navbtn').forEach(b=>{const icon=b.querySelector('.ico');if(icon&&!icon.dataset.drawn){icon.innerHTML='<svg viewBox="0 0 24 24" aria-hidden="true"><path d="'+(paths[b.dataset.page]||paths.overview)+'"/></svg>';icon.dataset.drawn='true';}});decorate();
 const search=document.createElement('div');search.className='nav-search';search.innerHTML='<svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="10" cy="10" r="6"/><path d="m15 15 5 5"/></svg><input type="search" placeholder="Find a module" aria-label="Find a navigation module">';nav.querySelector('.brand').after(search);
 const empty=document.createElement('div');empty.className='nav-empty';empty.textContent='No matching modules';empty.hidden=true;search.after(empty);
 const groups=[...nav.querySelectorAll('.group')];
 groups.forEach((g,i)=>{const title=g.querySelector('.group-title');const label=title.textContent.trim();const b=document.createElement('button');b.type='button';b.innerHTML=label+'<span aria-hidden="true">⌄</span>';b.setAttribute('aria-expanded','true');b.setAttribute('aria-label',label+' navigation');title.replaceChildren(b);b.onclick=()=>{g.classList.toggle('collapsed');b.setAttribute('aria-expanded',String(!g.classList.contains('collapsed')))};});
 search.querySelector('input').addEventListener('input',e=>{const q=e.target.value.trim().toLowerCase();let found=0;groups.forEach(g=>{let matched=0;if(q){g.classList.remove('collapsed');g.querySelector('.group-title button').setAttribute('aria-expanded','true');}g.querySelectorAll('.navbtn').forEach(b=>{const match=b.textContent.toLowerCase().includes(q);b.classList.toggle('nav-search-hidden',!match);if(match&&b.style.display!=='none')matched++;});g.hidden=!!q&&!matched;found+=matched;});empty.hidden=found>0;});
 document.addEventListener('keydown',e=>{if(e.key==='Escape'&&document.activeElement===search.querySelector('input')){search.querySelector('input').value='';search.querySelector('input').dispatchEvent(new Event('input'));}});
})();
