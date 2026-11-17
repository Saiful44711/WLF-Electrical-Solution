// WLF v2.5.0 push notifications (My Profile > Notifications).
// Each person turns it on for their own device. The server decides who gets what:
// new access request -> Super Admins, forwarded support request -> the receiver.
(function(){'use strict';
var busy=false,routed=false;
function el(id){return document.getElementById(id);}
function supported(){return 'serviceWorker' in navigator&&'PushManager' in window&&'Notification' in window;}
function ios(){return /iPad|iPhone|iPod/.test(navigator.userAgent)||(navigator.platform==='MacIntel'&&navigator.maxTouchPoints>1);}
function standalone(){return (window.matchMedia&&matchMedia('(display-mode: standalone)').matches)||navigator.standalone===true;}
function bytes(b64){var s=atob(String(b64).replace(/-/g,'+').replace(/_/g,'/')+'='.repeat((4-String(b64).length%4)%4)),out=new Uint8Array(s.length);for(var i=0;i<s.length;i++)out[i]=s.charCodeAt(i);return out;}
function same(buf,key){if(!buf)return false;var a=new Uint8Array(buf),b=bytes(key);if(a.length!==b.length)return false;for(var i=0;i<a.length;i++)if(a[i]!==b[i])return false;return true;}
function flush(){try{if(navigator.onLine)client().functions.invoke('wlf-push',{body:{}}).catch(function(){});}catch(e){}}
async function current(){if(!supported())return null;var reg=await navigator.serviceWorker.getRegistration();return reg?reg.pushManager.getSubscription():null;}
async function publicKey(){
 var key=SESSION&&SESSION.pushPublicKey;if(key)return key;
 var status=await rpc('getPushStatus',[T(),{}]);if(status&&status.publicKey)return status.publicKey;
 // First use: the wlf-push Edge Function creates the keys and keeps them in the database.
 var r=await client().functions.invoke('wlf-push',{body:{}});
 if(r&&r.data&&r.data.publicKey)return r.data.publicKey;
 throw Error('Notifications are not ready yet. Super Admin must deploy the wlf-push Edge Function (see the v2.5.0 guide).');
}
async function save(sub){var j=sub.toJSON();return rpc('savePushSubscription',[T(),{endpoint:j.endpoint,p256dh:j.keys.p256dh,auth:j.keys.auth,device:(navigator.userAgentData&&navigator.userAgentData.platform||navigator.platform||'').slice(0,60)}]);}
async function enable(){
 if(busy)return;busy=true;note('Turning on…');
 try{
  var permission=await Notification.requestPermission();
  if(permission!=='granted')throw Error(permission==='denied'?'Notifications are blocked for this site. Allow them in the browser/phone settings, then try again.':'Notification permission was not given.');
  var key=await publicKey(),reg=await navigator.serviceWorker.ready,sub=await reg.pushManager.getSubscription();
  if(sub&&!same(sub.options&&sub.options.applicationServerKey,key)){await sub.unsubscribe();sub=null;}
  if(!sub)sub=await reg.pushManager.subscribe({userVisibleOnly:true,applicationServerKey:bytes(key)});
  await save(sub);if(SESSION)SESSION.pushPublicKey=key;
  await render('Notifications are on for this device.');
 }catch(err){await render();note(cleanError(err),'error');}finally{busy=false;}
}
async function disable(){
 if(busy)return;busy=true;note('Turning off…');
 try{var sub=await current();if(sub){var endpoint=sub.endpoint;await sub.unsubscribe();await rpc('deletePushSubscription',[T(),{endpoint:endpoint}]);}
  await render('Notifications are off for this device.');
 }catch(err){await render();note(cleanError(err),'error');}finally{busy=false;}
}
function note(text,kind){var n=el('pushNote');if(n){n.textContent=text||'';n.className='push-note'+(kind==='error'?' error':'');}}
function who(){if(!SESSION)return '';return SESSION.role==='Super Admin'?'You will get a message when someone sends a new access request, and when a support request is forwarded to you.':SESSION.role==='R&I'?'You will get a message when a support request is forwarded to you.':'Messages are sent for new access requests (Super Admin) and forwarded support requests (R&I users).';}
async function render(message){
 var card=el('pushCard');if(!card)return;if(!SESSION){card.hidden=true;return;}card.hidden=false;
 var head='<div class="card-head"><div class="card-icon ci-indigo"><svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="#fff" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M18 8a6 6 0 0 0-12 0c0 7-3 9-3 9h18s-3-2-3-9"/><path d="M13.7 21a2 2 0 0 1-3.4 0"/></svg></div><div><h3>Notifications</h3><p>'+esc(who())+'</p></div></div>';
 if(!supported()){card.innerHTML=head+'<p class="note">'+(ios()&&!standalone()?'On iPhone/iPad: tap Share → <b>Add to Home Screen</b>, open WLF from the Home Screen icon, then turn notifications on here.':'This browser does not support notifications. Use Chrome, Edge or the installed app.')+'</p>';return;}
 var sub=null;try{sub=await current();}catch(e){}
 var blocked=Notification.permission==='denied',on=!!sub&&Notification.permission==='granted';
 card.innerHTML=head+'<div class="push-row"><span class="overview-pill push-state'+(on?' on':'')+'">'+(on?'On for this device':blocked?'Blocked in settings':'Off for this device')+'</span>'+
  (on?'<button type="button" class="btn ghost" id="pushOff">Turn off</button>':'<button type="button" class="btn" id="pushOn"'+(blocked?' disabled':'')+'>Turn on notifications</button>')+'</div>'+
  (ios()&&!standalone()?'<p class="note">iPhone/iPad: notifications work only from the Home Screen app.</p>':'')+'<p class="push-note" id="pushNote" role="status"></p>';
 if(el('pushOn'))el('pushOn').onclick=enable;if(el('pushOff'))el('pushOff').onclick=disable;
 if(blocked)note('Notifications are blocked for this site. Allow them in the browser/phone settings.','error');else if(message)note(message);
}
function route(url){try{var tab=new URL(url||location.href,location.href).hash.slice(1);if(!tab)return;var b=document.querySelector('#nav button[data-tab="'+tab.replace(/[^a-z-]/g,'')+'"]');if(b&&!b.hidden&&!b.classList.contains('hidden'))b.click();history.replaceState(null,'',location.pathname+location.search);}catch(e){}}
async function ready(){
 await render();flush();
 if(!routed){routed=true;setTimeout(function(){route(location.href);},300);}
 // keep this device linked to whoever is signed in on it
 try{var sub=await current();if(sub&&Notification.permission==='granted'&&SESSION)await save(sub);}catch(e){}
}
window.addEventListener('wlf-ready',function(){ready();});
window.addEventListener('wlf-logout',function(){var c=el('pushCard');if(c){c.hidden=true;c.innerHTML='';}routed=false;});
if('serviceWorker' in navigator)navigator.serviceWorker.addEventListener('message',function(ev){if(ev.data&&ev.data.type==='wlf-open')route(ev.data.url);});
window.WlfPush={flush:flush,render:render,enable:enable,disable:disable};
})();
// WLF v2.5.2: My Profile > "Forwarded to you" — requests forwarded to me that I have not received yet.
(function(){'use strict';
var last=0,busy=false;
function el(id){return document.getElementById(id);}
function canReceive(){return !!SESSION&&(SESSION.role==='R&I'||SESSION.role==='Super Admin');}
async function refresh(force){
 var card=el('forwardedCard');if(!card)return;
 if(!canReceive()){card.hidden=true;card.innerHTML='';return;}
 if(busy||(!force&&Date.now()-last<20000))return;busy=true;last=Date.now();
 try{var list=await rpc('getMyForwarded',[T()]);render(list||[]);}catch(err){if(!card.innerHTML)card.hidden=true;}finally{busy=false;}
}
function title(c){return String((AccessCore.supportTitles&&AccessCore.supportTitles[c])||c).replace(/ Team Support Request$/,'').replace(/ Support Request$/,'');}
function render(list){
 var card=el('forwardedCard');if(!card)return;card.hidden=false;
 card.innerHTML='<div class="card-head"><div class="card-icon ci-amber"><svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="#fff" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M15 3h6v6"/><path d="M10 14 21 3"/><path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6"/></svg></div><div><h3>Forwarded to you <span class="team-badge"'+(list.length?'':' hidden')+'>'+list.length+'</span></h3><p>Support requests waiting for you to receive. They leave this list when you press Receive.</p></div></div>'+
  (list.length?'<ul class="forwarded-list">'+list.map(function(x){return '<li><button type="button" class="forwarded-item" data-fw-cat="'+esc(x.category)+'" data-fw-id="'+esc(x.id)+'"><b>'+esc(x.reference)+'</b><span>'+esc(title(x.category))+(x.project?' · '+esc(x.project):'')+(x.lift?' · Lift '+esc(x.lift):'')+'</span>'+
    '<small>From '+esc(x.forwardedBy||'—')+' · '+esc(new Date(x.forwardedAt).toLocaleString('en-GB',{timeZone:'Asia/Dhaka',dateStyle:'medium',timeStyle:'short'}))+'</small>'+(x.comment?'<q>'+esc(x.comment)+'</q>':'')+'</button></li>';}).join('')+'</ul>':'<p class="note">Nothing waiting. Requests forwarded to you will appear here.</p>');
 card.querySelectorAll('[data-fw-id]').forEach(function(b){b.onclick=function(){if(window.LiveWorkspace&&LiveWorkspace.openRequest)LiveWorkspace.openRequest(b.dataset.fwCat,b.dataset.fwId);};});
}
window.addEventListener('wlf-ready',function(){refresh(true);});
window.addEventListener('wlf-logout',function(){var c=el('forwardedCard');if(c){c.hidden=true;c.innerHTML='';}last=0;});
document.addEventListener('click',function(e){var b=e.target.closest&&e.target.closest('#nav button[data-tab="account"]');if(b)refresh(true);});
window.WlfForwarded={refresh:refresh};
})();
