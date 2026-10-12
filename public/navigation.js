const byId = id => document.getElementById(id);
if(window.vesperDesktop)document.body.dataset.hostMode=window.vesperDesktop.hostMode;
const destinations = {runs:'runs-view',flows:'flow-studio-button',schedules:'schedules-button',help:'help-nav'};
function navigate(view) {
  byId('workspace').dataset.view=view;
  for(const page of document.querySelectorAll('dialog[data-workspace-page]'))if(page.dataset.workspacePage!==view&&page.open)page.close();
  byId('main').hidden=view!=='runs';byId('workbench-guide').hidden=view!=='help';
  for(const item of document.querySelectorAll('.workspace-nav-item'))item.setAttribute('aria-current',item.id===destinations[view]?'page':'false');
}
document.addEventListener('vesper:navigate',event=>navigate(event.detail));
byId('runs-view').addEventListener('click',()=>navigate('runs'));
byId('help-nav').addEventListener('click',()=>navigate('help'));
byId('guide-start-run').addEventListener('click',()=>{navigate('runs');byId('new-run-button').click();});
byId('guide-flow').addEventListener('click',()=>byId('flow-studio-button').click());
byId('guide-schedules').addEventListener('click',()=>byId('schedules-button').click());
byId('proxies-nav').addEventListener('click',()=>{byId('system-button').click();byId('proxy-list').scrollIntoView({block:'start'});});
byId('settings-nav').addEventListener('click',()=>byId('system-button').click());
function highlight(id){for(const item of document.querySelectorAll('.workspace-nav-item'))item.setAttribute('aria-current',item.id===id?'page':'false');}
byId('system-button').addEventListener('click',()=>highlight('settings-nav'));
for(const id of ['proxies-nav','settings-nav'])byId(id).addEventListener('click',()=>highlight(id));
byId('profiles-button').addEventListener('click',()=>{if(byId('profiles-dialog').open)highlight('profiles-button');});
for(const id of ['system-dialog','profiles-dialog'])byId(id).addEventListener('close',()=>highlight(destinations[byId('workspace').dataset.view||'runs']));
const apiHelp=document.createElement('section');apiHelp.className='system-section api-guide';
const apiTitle=document.createElement('h3');apiTitle.textContent='Local API';
const apiText=document.createElement('p');apiText.textContent='Automations and external clients use this authenticated local service. Keep access tokens in private files.';
const apiLink=document.createElement('a');apiLink.href='/api/v1/openapi.json';apiLink.textContent='Open API specification';apiLink.download='vesper-workbench-api.json';
const apiAddress=document.createElement('p');apiAddress.className='field-hint';apiAddress.textContent=location.origin+'/api/v1';
apiHelp.append(apiTitle,apiText,apiAddress,apiLink);byId('system-dialog').querySelector('.drawer-body').append(apiHelp);
