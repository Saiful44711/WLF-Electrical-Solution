// WLF 2.0: Supabase Auth + PostgreSQL RPC. Public configuration only.
function readStore(key,fallback){try{return JSON.parse(localStorage.getItem(key))||fallback;}catch(e){return fallback;}}
function writeStore(key,value){localStorage.setItem(key,JSON.stringify(value));}
var CFG=window.WLF_CONFIG||{},DEFAULT_BACKEND=CFG.supabaseUrl||'',APK_SETTINGS=readStore('wlf-appearance',{theme:'system',motion:false});
APK_SETTINGS.mode='live';APK_SETTINGS.backend=DEFAULT_BACKEND;
var LAST_CALC=null,SYNC_BUSY=false,RPC_INFLIGHT={},WLF_CLIENT=null,SIGN_OUT_PROMISE=null,AUTH_UI_ONLY=false;
function configured(){return /^https:\/\/[a-z0-9-]+\.supabase\.co$/.test(DEFAULT_BACKEND)&&!DEFAULT_BACKEND.includes('YOUR_')&&/^sb_publishable_/.test(CFG.supabasePublishableKey||'');}
function client(){if(!configured())throw Error('Setup incomplete. The owner must set Supabase Project URL and publishable key in web/config.js and deploy.');if(!WLF_CLIENT)WLF_CLIENT=window.createWlfClient(DEFAULT_BACKEND,CFG.supabasePublishableKey,{auth:{storageKey:'wlf-auth:'+DEFAULT_BACKEND,persistSession:true,autoRefreshToken:true,detectSessionInUrl:true}});if(!WLF_CLIENT.__wlfAuthWatch){WLF_CLIENT.__wlfAuthWatch=true;WLF_CLIENT.auth.onAuthStateChange(function(event,session){setTimeout(function(){if(typeof SESSION!=='undefined'&&SESSION&&(!session||session.user.id!==SESSION.token)){AUTH_UI_ONLY=true;forceLogout('Signed out or account changed in another window. Please log in again.');AUTH_UI_ONLY=false;}},0);});}return WLF_CLIENT;}
function modeScope(){return DEFAULT_BACKEND;}
function scopedKey(kind){return 'wlf2-'+kind+':'+modeScope();}
function rpcSafeRetry(action,args){return /^(get|list|refresh|adminGet|adminStats)/.test(action)||action==='receiveDamageDemand'||(['createDamageDemand','createSupportRequest','transitionSupportRequest','editSupportRequest','deleteSupportRequest','saveRiEntry','deleteRiEntry','saveRiProject','deleteRiProject','saveQmsComponent'].includes(action)&&args[1]&&(args[1].mutationId||args[1].operation));}
// v2.5.0 speed: at sign-in/app open, the two follow-up reads start together with getSession.
var PREFETCH={};
function prefetchStart(uid){['getAppContext','getSupportSummary'].forEach(function(a){var p=dbCall(a,[]);p.catch(function(){});PREFETCH[a]={uid:uid,at:Date.now(),promise:p};});}
function prefetchTake(action,uid,args){var x=PREFETCH[action];if(!x)return null;delete PREFETCH[action];return args.length===0&&x.uid===uid&&Date.now()-x.at<10000?x.promise:null;}
function pushFlush(){try{WLF_CLIENT&&WLF_CLIENT.functions.invoke('wlf-push',{body:{}}).catch(function(){});}catch(e){}}
async function dbCall(action,args){var r=await client().rpc('wlf_rpc',{action:action,args:args});if(r.error)throw Error(r.error.message||'Database action failed');return r.data;}
function statsView(d){var topics=['Login','Component Selection','Travel Time Calculation','Power Calculation','Speed & Slip Calculation','Motor Power Justification','Energy Bill Calculation','Solar Sizing Calculation'];d.logs.forEach(function(x){if(!topics.includes(x.action))topics.push(x.action);});var totals=topics.map(function(){return 0;}),people={};d.people.forEach(function(p){people[p.email]=Object.assign({},p,{counts:topics.map(function(){return 0;}),total:0,lastActive:'-'});});d.logs.forEach(function(x){var n=topics.indexOf(x.action),p=people[x.email];if(p){p.counts[n]++;p.total++;if(p.lastActive==='-'||x.at>p.lastActive)p.lastActive=x.at;}totals[n]++;});return {topics:topics,rows:Object.values(people).sort(function(a,b){return b.total-a.total;}),totals:totals,totalEvents:d.logs.length};}
async function rpcOnce(action,args){
 var sb=client(),r,ctx;
 if(action==='login'){
 if(SIGN_OUT_PROMISE){await SIGN_OUT_PROMISE;SIGN_OUT_PROMISE=null;}
 r=await sb.auth.signInWithPassword({email:String(args[0]).trim().toLowerCase(),password:args[1]});if(r.error)throw r.error;
 prefetchStart(r.data.user.id);
 try{ctx=await dbCall('getSession',[]);}catch(err){PREFETCH={};await sb.auth.signOut({scope:'local'});throw err;}
 ctx.token=r.data.user.id;ctx.offlineUntil=Date.now()+Math.min(24,Number(CFG.offlineHours)||24)*3600000;return ctx;
 }
 if(action==='register'){var clean=LiftCore.registration(args[0],args[1],args[2],args[3],args[4]);r=await sb.auth.signUp({email:clean.email,password:clean.password,options:{data:{name:clean.name,employeeId:clean.employeeId,section:clean.section}}});if(r.error)throw r.error;pushFlush();await sb.auth.signOut({scope:'local'});return 'Account request sent. Wait for Super Admin approval. If email confirmation is enabled, confirm your email first.';}
 var auth=await sb.auth.getSession();if(!auth.data.session||auth.data.session.user.id!==args[0])throw Error('SESSION_EXPIRED');
 if(action==='changePassword'){
 if(!SESSION||!AccessCore.approved(SESSION))throw Error('Permission denied');if(String(args[2]||'').length<8)throw Error('New password must be at least 8 characters.');
 var ownerId=auth.data.session.user.id,ownerEmail=auth.data.session.user.email;
 r=await sb.auth.signInWithPassword({email:ownerEmail,password:args[1]});if(r.error)throw r.error;
 if(!r.data.user||r.data.user.id!==ownerId)throw Error('SESSION_EXPIRED');
 await dbCall('getSession',[]);r=await sb.auth.updateUser({password:args[2]});if(r.error)throw r.error;return 'Password changed successfully.';
 }
 if(action==='resetAppUserPassword'){
 r=await sb.functions.invoke('wlf-admin',{body:{action:'resetPassword',email:args[1]}});if(r.error)throw Error('Password reset failed. Deploy wlf-admin Edge Function and check its logs.');if(r.data.error)throw Error(r.data.error);return r.data;
 }
 if(/^calculate/.test(action)){if(!SESSION||!AccessCore.apiCan(SESSION,action))throw Error('Permission denied');return LiftCore.calculate(action,args[1]);}
 var cleanArgs=args.slice(1);
 if(action==='saveTroubleshootingEntry')cleanArgs[0]=TroubleCore.validate(cleanArgs[0]);
 if(action==='saveEngineeringRecord')cleanArgs[0]=LiftCore.record(cleanArgs[0]);
 if(action==='getSession'&&!SESSION)prefetchStart(auth.data.session.user.id);
 var result;try{result=await(prefetchTake(action,auth.data.session.user.id,cleanArgs)||dbCall(action,cleanArgs));}catch(err){if(action==='getSession')PREFETCH={};throw err;}
 if(action==='transitionSupportRequest'&&cleanArgs[0]&&cleanArgs[0].action==='forward')pushFlush();
 if(action==='transitionSupportRequest'&&window.WlfForwarded)setTimeout(function(){WlfForwarded.refresh(true);},0);
 if(action==='getSession'){result.token=auth.data.session.user.id;result.offlineUntil=Date.now()+Math.min(24,Number(CFG.offlineHours)||24)*3600000;}
 if(action==='getAppContext'&&result.components){Object.assign(result,componentSnapshot(result.components));delete result.components;}
 if(action==='refreshIndex')result=componentSnapshot(result);
 if(action==='getComponentDetails')result=componentSnapshot(result).componentDetails[args[1]];
 if(action==='adminStats'&&result.logs)result=statsView(result);
 if(action==='getSupportWorkspace')result.tickets.forEach(function(t){delete t.formSchema;});
 return result;
}
function rpc(action,args){
 if(!LiftCore.allowed(action))return Promise.reject(Error('Unsupported action.'));
 if(!navigator.onLine)return Promise.reject(Error('Offline: reconnect to use this live action.'));
 var safe=rpcSafeRetry(action,args),key=safe?JSON.stringify([action,args]):'';if(key&&RPC_INFLIGHT[key])return RPC_INFLIGHT[key];
 var request=(async function(){try{return await rpcOnce(action,args);}catch(err){if(!safe||!/Failed to fetch|NetworkError|network request|fetch failed/i.test(err.message)||!navigator.onLine)throw err;await new Promise(function(r){setTimeout(r,350);});return rpcOnce(action,args);}})();
 if(key){RPC_INFLIGHT[key]=request;request.finally(function(){delete RPC_INFLIGHT[key];}).catch(function(){});}return request;
}
async function apiCall(action,args){
  var result;
  if(!navigator.onLine){
    var cache=readStore(scopedKey('cache'),{});
    if(action==='getSession'&&cache.session&&cache.session.token===args[0]&&cache.session.offlineUntil>Date.now())result=cache.session;
    else if(action==='logAction')return true;
    else if(/^calculate/.test(action)&&SESSION&&LiftCore.can(SESSION.role,action))result=LiftCore.calculate(action,args[1]);
    else if(action==='refreshIndex'&&SESSION&&cache.session&&cache.session.email===SESSION.email)result={index:cache.session.index};
    else if(action==='getComponentDetails'&&SESSION&&LiftCore.can(SESSION.role,action)&&cache.details&&cache.details[args[1]])result=cache.details[args[1]];
    else throw new Error('Offline: login, approvals and component changes need internet. Saved calculations can use the outbox.');
  }else result=await rpc(action,args);
  if(action==='refreshIndex'&&SESSION){var cache=readStore(scopedKey('cache'),{});if(cache.session&&cache.session.email===SESSION.email){cache.session.index=result.index;cache.session.componentDetails=result.componentDetails||{};if(result.componentDetails)cache.details=Object.assign(cache.details||{},result.componentDetails);writeStore(scopedKey('cache'),cache);}}
  if(action==='getComponentDetails'&&APK_SETTINGS.mode==='live'){var cache=readStore(scopedKey('cache'),{});cache.details=cache.details||{};cache.details[args[1]]=result;writeStore(scopedKey('cache'),cache);}
  if(/^calculate/.test(action))LAST_CALC={action:action,inputs:JSON.parse(JSON.stringify(args[1])),result:result};
  return result;
}
var google={script:{get run(){var success=function(){},failure=function(){};var handler={get:function(target,key){if(key==='withSuccessHandler')return function(fn){success=fn;return new Proxy(target,handler);};if(key==='withFailureHandler')return function(fn){failure=fn;return new Proxy(target,handler);};return function(){var args=Array.prototype.slice.call(arguments);Promise.resolve().then(function(){return apiCall(key,args);}).then(success).catch(failure);};}};return new Proxy({},handler);}}};
function cacheSession(session){var previous=readStore(scopedKey('last-access')+':'+session.email,null);if(previous!==null&&previous!==session.accessRevision){localStorage.removeItem('wlf-tb-cache:'+modeScope()+':'+session.email);if(typeof Troubleshooting!=='undefined')Troubleshooting.reset();}writeStore(scopedKey('last-access')+':'+session.email,session.accessRevision);var cache=readStore(scopedKey('cache'),{});if(cache.session&&(cache.session.email!==session.email||cache.session.accessRevision!==session.accessRevision||cache.session.role!==session.role)){localStorage.removeItem('wlf-tb-cache:'+modeScope()+':'+session.email);cache={};}cache.session=session;if(session.componentDetails)cache.details=Object.assign(cache.details||{},session.componentDetails);writeStore(scopedKey('cache'),cache);if(AccessCore.superUser(session))setTimeout(function(){syncOutbox(true);},0);}
function applyTheme(){var dark=APK_SETTINGS.theme==='dark'||APK_SETTINGS.theme==='system'&&matchMedia('(prefers-color-scheme:dark)').matches;document.documentElement.dataset.theme=dark?'dark':'light';document.body.classList.toggle('motion-on',!!APK_SETTINGS.motion);}
function cycleTheme(){APK_SETTINGS.theme=document.documentElement.dataset.theme==='dark'?'light':'dark';writeStore('wlf-appearance',APK_SETTINGS);applyTheme();}
function refreshShell(){applyTheme();}
function openSettings(){document.getElementById('themeSetting').value=APK_SETTINGS.theme;document.getElementById('motionSetting').checked=APK_SETTINGS.motion;document.getElementById('settingsDialog').showModal();}
function applySettings(){
  APK_SETTINGS={mode:'live',backend:DEFAULT_BACKEND,theme:document.getElementById('themeSetting').value,motion:document.getElementById('motionSetting').checked};
  writeStore('wlf-appearance',APK_SETTINGS);refreshShell();document.getElementById('settingsDialog').close();
}
/* v2.6.3: calculations are no longer saved; the old on-device outbox is cleared. */
function printCalculation(){document.body.classList.add('printing-calc');try{if(window.LiftNative&&LiftNative.isNative&&LiftNative.print)LiftNative.print.print();else window.print();}finally{setTimeout(function(){document.body.classList.remove('printing-calc');},500);}}
function syncOutbox(){}
function renderRecords(){}
try{localStorage.removeItem('lift-records');}catch(_){}
async function exportText(name,text){if(window.LiftNative&&LiftNative.isNative){await LiftNative.shareFile(name,text);return;}var url=URL.createObjectURL(new Blob([text],{type:'text/csv;charset=utf-8'})),a=document.createElement('a');a.href=url;a.download=name;a.click();setTimeout(function(){URL.revokeObjectURL(url);},1000);}
document.addEventListener('DOMContentLoaded',function(){
  refreshShell();matchMedia('(prefers-color-scheme:dark)').addEventListener('change',applyTheme);
  document.getElementById('tab-calculation').addEventListener('input',function(e){LAST_CALC=null;});
  var originalLogout=forceLogout;forceLogout=function(message){if(WLF_CLIENT){WLF_CLIENT.removeAllChannels();if(!AUTH_UI_ONLY)SIGN_OUT_PROMISE=WLF_CLIENT.auth.signOut({scope:'local'});}window.dispatchEvent(new Event('wlf-logout'));var key=scopedKey('cache');localStorage.removeItem(key);LAST_CALC=null;originalLogout(message);
    ['report','matchesList','ttResult','pwResult','ssResult','mpResult','energyResult','solarResult','statsArea','globalMsg','recordsList'].forEach(function(id){var el=document.getElementById(id);if(el)el.innerHTML='';});
    ['reportWrap','matchesCard','editorCard'].forEach(function(id){document.getElementById(id).classList.add('hidden');});
    var tbody=document.querySelector('#usersTable tbody');if(tbody)tbody.innerHTML='';
    compData=null;editingRow=null;
  };
  printReport=async function(){var area=document.getElementById('apkPrintArea');area.innerHTML='<h1>Lift component report</h1><p>'+esc('Live')+'</p>'+document.getElementById('report').innerHTML;document.body.classList.add('printing');try{if(window.LiftNative&&LiftNative.isNative)await LiftNative.print.print();else window.print();}finally{document.body.classList.remove('printing');}};
});
window.addEventListener('online',async function(){
  refreshShell();if(!SESSION)return;
  var token=T();try{var session=await rpc('getSession',[token]);if(!SESSION||T()!==token)return;if(session.role!==SESSION.role||session.accessRevision!==SESSION.accessRevision){forceLogout('Your access changed. Please log in again.');return;}SESSION.offlineUntil=session.offlineUntil;cacheSession(SESSION);if(window.LiveWorkspace)LiveWorkspace.refreshNotifications();if(AccessCore.superUser(SESSION))syncOutbox(true);}
  catch(err){if(/SESSION_EXPIRED/.test(err.message)){if(SESSION&&T()===token)forceLogout('Your session has expired. Connect and log in again; pending entries remain saved.');}else showMsg('Connection restored, but server verification failed. Pending entries remain saved. '+err.message,'info');}
});window.addEventListener('offline',refreshShell);
