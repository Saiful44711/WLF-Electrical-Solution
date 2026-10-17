(function(){'use strict';var channel=null,owner='',timer=null,installEvent=null,refreshTables=new Set(),running=false,updating=false;
function el(id){return document.getElementById(id);}
function indicator(s){if(el('realtimeStatus'))el('realtimeStatus').textContent=s;}
async function flush(){if(running||!SESSION)return;running=true;var tables=Array.from(refreshTables);refreshTables.clear();try{
 if(tables.includes('wlf_profiles')){var s=await rpc('getSession',[T()]);if(!SESSION)return;if(s.accessRevision!==SESSION.accessRevision||s.role!==SESSION.role){forceLogout('Your access changed. Please log in again.');return;}SESSION.pendingCount=s.pendingCount;setPending(s.pendingCount||0);if(AccessCore.superUser(s)&&el('tab-users')&&!el('tab-users').classList.contains('hidden'))loadUsers();}
 if(tables.includes('wlf_requests'))await LiveWorkspace.realtimeRefresh();
 if(tables.includes('wlf_components')&&(AccessCore.read(SESSION,'selection')||AccessCore.read(SESSION,'calc:energy')||AccessCore.read(SESSION,'calc:solar'))){var data=await rpc('refreshIndex',[T()]);if(SESSION){SESSION.index=data.index;SESSION.componentDetails=data.componentDetails;clearComponentDetails();setIndex(data.index);seedComponentDetails(data.componentDetails);cacheSession(SESSION);}}
 if(tables.includes('wlf_troubleshooting')||tables.includes('wlf_forms')){Troubleshooting.reset();if(!el('tab-troubleshooting').classList.contains('hidden'))Troubleshooting.open();}
 if(el('tab-dashboard')&&!el('tab-dashboard').classList.contains('hidden'))LiveWorkspace.renderSupportDashboard();
 }catch(err){if(/SESSION_EXPIRED/.test(err.message))forceLogout('Access inactive or session expired. Please log in again.');else indicator('Live sync interrupted · reconnecting');}finally{running=false;if(refreshTables.size)schedule();}}
function schedule(){clearTimeout(timer);timer=setTimeout(flush,180);}
function subscribe(){if(!SESSION||!navigator.onLine)return;var sb=client();if(owner===SESSION.email&&channel)return;if(channel)sb.removeChannel(channel);owner=SESSION.email;
 channel=sb.channel('wlf-live-'+SESSION.token).on('postgres_changes',{event:'*',schema:'public',table:'wlf_requests'},p=>{refreshTables.add(p.table);schedule();}).on('postgres_changes',{event:'*',schema:'public',table:'wlf_profiles'},p=>{refreshTables.add(p.table);schedule();}).on('postgres_changes',{event:'*',schema:'public',table:'wlf_components'},p=>{refreshTables.add(p.table);schedule();}).on('postgres_changes',{event:'*',schema:'public',table:'wlf_troubleshooting'},p=>{refreshTables.add(p.table);schedule();}).on('postgres_changes',{event:'*',schema:'public',table:'wlf_forms'},p=>{refreshTables.add(p.table);schedule();}).subscribe(status=>{indicator(status==='SUBSCRIBED'?'Realtime connected':status==='CHANNEL_ERROR'||status==='TIMED_OUT'?'Realtime reconnecting · backup refresh active':'Connecting realtime…');if(status==='SUBSCRIBED'){refreshTables.add('wlf_requests');schedule();}});
}
window.addEventListener('wlf-logout',()=>{channel=null;owner='';refreshTables.clear();clearTimeout(timer);indicator('Signed out');});
window.addEventListener('online',subscribe);window.addEventListener('offline',()=>indicator('Offline · downloaded reference only'));
window.addEventListener('beforeinstallprompt',e=>{e.preventDefault();installEvent=e;if(el('installWlf'))el('installWlf').hidden=false;});
document.addEventListener('DOMContentLoaded',function(){
 var menu=document.querySelector('.appearance-menu');if(menu)menu.querySelector('.appearance-options').insertAdjacentHTML('beforeend','<small id="realtimeStatus" role="status">Sign in to connect</small><button id="installWlf" type="button" hidden>Install app</button><button id="updateWlf" type="button" hidden>Update available · reload</button>');
 el('installWlf').onclick=async()=>{if(!installEvent)return;await installEvent.prompt();installEvent=null;el('installWlf').hidden=true;};
 var start=startApp;startApp=function(s){start(s);subscribe();};
 setInterval(()=>{if(SESSION&&!navigator.onLine&&SESSION.offlineUntil<=Date.now())forceLogout('Offline access expired. Reconnect and log in.');},15000);
 if(!configured())el('authMsg').innerHTML='<div class="msg info">Setup required: configure Supabase URL and publishable key. Read START_HERE.html in your package.</div>';
 if('serviceWorker'in navigator){navigator.serviceWorker.register('./sw.js').then(reg=>{function waiting(){if(reg.waiting){el('updateWlf').hidden=false;el('updateWlf').onclick=()=>{if(confirm('Save any draft before updating. Reload now?')){updating=true;reg.waiting.postMessage('ACTIVATE_UPDATE');}};}}waiting();reg.addEventListener('updatefound',()=>{const sw=reg.installing;sw.addEventListener('statechange',()=>{if(sw.state==='installed')waiting();});});navigator.serviceWorker.addEventListener('controllerchange',()=>{if(updating)location.reload();});}).catch(err=>console.warn('Offline setup:',err.message));}
 });
})();
