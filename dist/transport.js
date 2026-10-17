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
function rpcSafeRetry(action,args){return /^(get|list|refresh|adminGet|adminStats)/.test(action)||(['createSupportRequest','transitionSupportRequest','editSupportRequest','deleteSupportRequest'].includes(action)&&args[1]&&args[1].mutationId);}
async function dbCall(action,args){var r=await client().rpc('wlf_rpc',{action:action,args:args});if(r.error)throw Error(r.error.message||'Database action failed');return r.data;}
function statsView(d){var topics=['Login','Component Selection','Travel Time Calculation','Power Calculation','Speed & Slip Calculation','Motor Power Justification','Energy Bill Calculation','Solar Sizing Calculation'];d.logs.forEach(function(x){if(!topics.includes(x.action))topics.push(x.action);});var totals=topics.map(function(){return 0;}),people={};d.people.forEach(function(p){people[p.email]=Object.assign({},p,{counts:topics.map(function(){return 0;}),total:0,lastActive:'-'});});d.logs.forEach(function(x){var n=topics.indexOf(x.action),p=people[x.email];if(p){p.counts[n]++;p.total++;if(p.lastActive==='-'||x.at>p.lastActive)p.lastActive=x.at;}totals[n]++;});return {topics:topics,rows:Object.values(people).sort(function(a,b){return b.total-a.total;}),totals:totals,totalEvents:d.logs.length};}
async function rpcOnce(action,args){
 var sb=client(),r,ctx;
 if(action==='login'){
 if(SIGN_OUT_PROMISE){await SIGN_OUT_PROMISE;SIGN_OUT_PROMISE=null;}
 r=await sb.auth.signInWithPassword({email:String(args[0]).trim().toLowerCase(),password:args[1]});if(r.error)throw r.error;
 try{ctx=await dbCall('getSession',[]);}catch(err){await sb.auth.signOut({scope:'local'});throw err;}
 ctx.token=r.data.user.id;ctx.offlineUntil=Date.now()+Math.min(24,Number(CFG.offlineHours)||24)*3600000;return ctx;
 }
 if(action==='register'){var clean=LiftCore.registration(args[0],args[1],args[2]);r=await sb.auth.signUp({email:clean.email,password:clean.password,options:{data:{name:clean.name}}});if(r.error)throw r.error;await sb.auth.signOut({scope:'local'});return 'Account request sent. Wait for Super Admin approval. If email confirmation is enabled, confirm your email first.';}
 var auth=await sb.auth.getSession();if(!auth.data.session||auth.data.session.user.id!==args[0])throw Error('SESSION_EXPIRED');
 if(action==='changePassword'){
 if(!SESSION||!AccessCore.superUser(SESSION))throw Error('Permission denied');if(String(args[2]||'').length<8)throw Error('New password must be at least 8 characters.');
 r=await sb.auth.signInWithPassword({email:SESSION.email,password:args[1]});if(r.error)throw r.error;await dbCall('getSession',[]);r=await sb.auth.updateUser({password:args[2]});if(r.error)throw r.error;return 'Password changed successfully.';
 }
 if(action==='resetAppUserPassword'){
 r=await sb.functions.invoke('wlf-admin',{body:{action:'resetPassword',email:args[1]}});if(r.error)throw Error('Password reset failed. Deploy wlf-admin Edge Function and check its logs.');if(r.data.error)throw Error(r.data.error);return r.data;
 }
 if(/^calculate/.test(action)){if(!SESSION||!AccessCore.apiCan(SESSION,action))throw Error('Permission denied');return LiftCore.calculate(action,args[1]);}
 var cleanArgs=args.slice(1);
 if(action==='saveTroubleshootingEntry')cleanArgs[0]=TroubleCore.validate(cleanArgs[0]);
 if(action==='saveSupportSchema')cleanArgs[0]=Object.assign({},cleanArgs[0],{schema:{fields:AccessCore.validateSchema(cleanArgs[0].schema)}});
 if(action==='saveEngineeringRecord')cleanArgs[0]=LiftCore.record(cleanArgs[0]);
 var result=await dbCall(action,cleanArgs);
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
function allRecords(){return readStore('lift-records',[]);}
function scopedRecords(){return allRecords().filter(function(item){return SESSION&&item.scope===modeScope()&&item.owner===SESSION.email;});}
async function saveLatestRecord(){
  if(!SESSION||!LiftCore.can(SESSION.role,'saveEngineeringRecord')){showMsg('Your account cannot save calculations.','error');return;}
  if(!LAST_CALC){showMsg('Calculate a result first. After changing inputs, calculate again before saving.','info');return;}
  try{var record=LiftCore.record({version:1,id:crypto.randomUUID(),createdAt:new Date().toISOString(),action:LAST_CALC.action,inputs:LAST_CALC.inputs,note:document.getElementById('recordNote').value});
    var items=allRecords();items.push({scope:modeScope(),owner:SESSION.email,record:record,synced:false,status:'Pending sync'});writeStore('lift-records',items);showMsg('Calculation saved on this device. Syncing when connected.','success');if(APK_SETTINGS.mode==='live')await syncOutbox(true);
  }catch(err){showMsg(err.message,'error');}
}
async function syncOutbox(quiet){
  if(SYNC_BUSY||APK_SETTINGS.mode!=='live'||!navigator.onLine||!SESSION)return;
  var scope=modeScope(),owner=SESSION.email,token=T();
  SYNC_BUSY=true;try{while(navigator.onLine&&SESSION&&SESSION.email===owner&&modeScope()===scope){
    var pending=allRecords().find(function(item){return !item.synced&&item.scope===scope&&item.owner===owner;});if(!pending)break;
    var error=null;try{await rpc('saveEngineeringRecord',[token,pending.record]);}catch(err){error=err.message;}
    // Re-read after the request so entries saved while syncing cannot be overwritten.
    var items=allRecords(),item=items.find(function(item){return item.scope===scope&&item.owner===owner&&item.record.id===pending.record.id;});
    if(item){if(error){item.error=error;item.status='Pending: '+error;}else{item.synced=true;item.status='Synced';delete item.error;}writeStore('lift-records',items);}
    if(error){if(!quiet)document.getElementById('recordStatus').textContent='Pending: '+error;break;}
  }renderRecords();}finally{SYNC_BUSY=false;}
}
function renderRecords(){var items=scopedRecords();document.getElementById('recordStatus').textContent=items.length+' record(s); '+items.filter(function(x){return !x.synced;}).length+' pending. Records are scoped to the current account/backend.';document.getElementById('recordsList').innerHTML=items.slice().reverse().map(function(item){return '<article class="record-item"><b>'+esc(item.record.action.replace(/^calculate/,''))+'</b><p>'+esc(item.record.note||'No note')+'</p><small>'+esc(item.record.createdAt)+' · '+esc(item.status||'Synced')+'</small>'+(item.error?'<p class="msg error">'+esc(item.error)+'</p>':'')+'</article>';}).join('')||'<p>No records saved yet.</p>';}
async function openRecords(){document.getElementById('recordsDialog').showModal();renderRecords();if(APK_SETTINGS.mode==='live'&&navigator.onLine&&SESSION){try{var remote=await rpc('listEngineeringRecords',[T()]),items=allRecords();for(var row of remote)if(!items.some(function(x){return x.scope===modeScope()&&x.owner===SESSION.email&&x.record.id===row.record.id;}))items.push({scope:modeScope(),owner:SESSION.email,record:row.record,synced:true,status:'Synced'});writeStore('lift-records',items);renderRecords();}catch(err){document.getElementById('recordStatus').textContent=err.message;}}}
async function exportText(name,text){if(window.LiftNative&&LiftNative.isNative){await LiftNative.shareFile(name,text);return;}var url=URL.createObjectURL(new Blob([text],{type:'text/csv;charset=utf-8'})),a=document.createElement('a');a.href=url;a.download=name;a.click();setTimeout(function(){URL.revokeObjectURL(url);},1000);}
async function exportLatest(){try{if(!LAST_CALC)throw new Error('Calculate a result first.');await exportText('lift-calculation.csv',LiftCore.csv([['Mode','Calculator','Inputs','Results'],['Live',LAST_CALC.action,JSON.stringify(LAST_CALC.inputs),JSON.stringify(LAST_CALC.result)]]));}catch(err){showMsg(err.message,'error');}}
async function exportRecords(){try{var rows=[['Mode','ID','Date','Calculator','Note','Sync','Inputs','Results']];scopedRecords().forEach(function(item){var r=item.record;rows.push(['Live',r.id,r.createdAt,r.action,r.note,item.status,JSON.stringify(r.inputs),JSON.stringify(r.result)]);});await exportText('lift-records.csv',LiftCore.csv(rows));}catch(err){document.getElementById('recordStatus').textContent=err.message;}}
document.addEventListener('DOMContentLoaded',function(){
  refreshShell();matchMedia('(prefers-color-scheme:dark)').addEventListener('change',applyTheme);
  document.getElementById('tab-calculation').addEventListener('input',function(e){if(e.target.id!=='recordNote')LAST_CALC=null;});
  var originalLogout=forceLogout;forceLogout=function(message){if(WLF_CLIENT){WLF_CLIENT.removeAllChannels();if(!AUTH_UI_ONLY)SIGN_OUT_PROMISE=WLF_CLIENT.auth.signOut({scope:'local'});}window.dispatchEvent(new Event('wlf-logout'));var key=scopedKey('cache');localStorage.removeItem(key);LAST_CALC=null;originalLogout(message);
    ['report','matchesList','ttResult','pwResult','ssResult','mpResult','energyResult','solarResult','statsArea','globalMsg','recordsList'].forEach(function(id){var el=document.getElementById(id);if(el)el.innerHTML='';});
    ['reportWrap','matchesCard','editorCard'].forEach(function(id){document.getElementById(id).classList.add('hidden');});
    var tbody=document.querySelector('#usersTable tbody');if(tbody)tbody.innerHTML='';
    document.getElementById('recordNote').value='';compData=null;editingRow=null;
  };
  printReport=async function(){var area=document.getElementById('apkPrintArea');area.innerHTML='<h1>Lift component report</h1><p>'+esc('Live')+'</p>'+document.getElementById('report').innerHTML;document.body.classList.add('printing');try{if(window.LiftNative&&LiftNative.isNative)await LiftNative.print.print();else window.print();}finally{document.body.classList.remove('printing');}};
});
window.addEventListener('online',async function(){
  refreshShell();if(!SESSION)return;
  var token=T();try{var session=await rpc('getSession',[token]);if(!SESSION||T()!==token)return;if(session.role!==SESSION.role||session.accessRevision!==SESSION.accessRevision){forceLogout('Your access changed. Please log in again.');return;}SESSION.offlineUntil=session.offlineUntil;cacheSession(SESSION);if(window.LiveWorkspace)LiveWorkspace.refreshNotifications();if(AccessCore.superUser(SESSION))syncOutbox(true);}
  catch(err){if(/SESSION_EXPIRED/.test(err.message)){if(SESSION&&T()===token)forceLogout('Your session has expired. Connect and log in again; pending entries remain saved.');}else showMsg('Connection restored, but server verification failed. Pending entries remain saved. '+err.message,'info');}
});window.addEventListener('offline',refreshShell);
