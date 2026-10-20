(function(root,factory){var api=factory();if(typeof module==='object'&&module.exports)module.exports=api;root.AccessCore=api;})(typeof globalThis!=='undefined'?globalThis:this,function(){
'use strict';
var categories=['commissioning','aftersales'],roles=['Super Admin','Admin','R&I','User'];
var calculators={calculateTravelTime:'calc:travel',calculatePowerAndAVR:'calc:power',calculateSpeedSlip:'calc:speed',calculateMotorPower:'calc:motor',calculateEnergyBill:'calc:energy',calculateSolarSizing:'calc:solar'};
function superUser(u){return !!u&&u.status==='Approved'&&u.role==='Super Admin';}
function approved(u){return !!u&&u.status==='Approved'&&roles.indexOf(u.role)>=0;}
function read(u,key){return approved(u)&&(u.role==='Super Admin'||u.role==='Admin'||u.role==='R&I'||(u.permissions||[]).indexOf(key)>=0);}
function operate(u,key){return approved(u)&&(key.slice(-8)===':request'?(u.role==='User'&&read(u,key)||superUser(u)):key.slice(-7)===':handle'?u.role==='R&I':superUser(u));}
function categoryRead(u,c){return categories.indexOf(c)>=0&&['request','handle','senior'].some(function(k){return read(u,'support:'+c+':'+k);});}
function handler(u,c){return approved(u)&&u.role==='R&I'&&categories.indexOf(c)>=0;}
function canReport(u){return approved(u)&&['Super Admin','Admin','R&I'].indexOf(u.role)>=0;}
function visible(u,t){return !t.deletedAt&&categoryRead(u,t.category)&&(u.role==='Admin'||superUser(u)||handler(u,t.category)||t.createdBy===u.email);}
function reference(t){
 var values=t.values||{},schema=t.formSchema||{},fields=schema.fields||[],liftField=fields.find(function(f){return f.id==='field_1369800003'||/^(project\s*)?lift\s*id$/i.test(f.label||'');}),dateField=fields.find(function(f){return f.id==='submitted_date';})||fields.find(function(f){return f.id==='field_2064608726'||/^(submitted date|date|date of incident)$/i.test(f.label||'');});
 var lift=String(values[liftField?liftField.id:'field_1369800003']||'').trim(),date=String(values[dateField?dateField.id:'field_2064608726']||'').trim();
 if(!lift||!/^\d{4}-\d{2}-\d{2}$/.test(date))return t.id;
 return (t.category==='commissioning'?'TCS-':'TAS-')+lift+'-'+date.replace(/-/g,'');
}
function unresolvedCount(tickets,user,category){return tickets.filter(function(t){return t.status!=='Solved'&&visible(user,t)&&(!category||t.category===category);}).length;}
function pendingCount(tickets,user,category){return tickets.filter(function(t){return t.status==='Pending'&&visible(user,t)&&(!category||t.category===category);}).length;}
function clean(v,n){var s=String(v==null?'':v).trim();if(s.length>n)throw Error('Text is too long.');return s;}
function validateForm(schema,values){
 var result={};schema.fields.forEach(function(f){var v=f.type==='multi'?(Array.isArray(values[f.id])?values[f.id].map(function(x){return clean(x,300);}):[]):clean(values[f.id],4000);if(f.required&&(!v||Array.isArray(v)&&!v.length))throw Error('Required: '+f.label);if(f.options.length){var opts=Array.isArray(v)?v:[v];if(opts.some(function(o){return o&&f.options.indexOf(o)<0;}))throw Error('Invalid choice: '+f.label);}if(f.type==='date'&&v){var d=new Date(v+'T00:00:00Z');if(!/^\d{4}-\d{2}-\d{2}$/.test(v)||isNaN(d)||d.toISOString().slice(0,10)!==v)throw Error('Invalid date.');}result[f.id]=v;});return result;
}
function transition(ticket,action,actor,payload,users,now){
 if(!visible(actor,ticket)||!handler(actor,ticket.category))throw Error('You do not have permission to process this request.');
 if(Number(payload.revision)!==ticket.revision)throw Error('CONFLICT: Request changed. Refresh and review.');
 var t=JSON.parse(JSON.stringify(ticket)),comment=clean(payload.comment,6000),to=null;
 if(t.status==='Solved')throw Error('Solved requests are closed.');
 if(action==='receive'){
  if(!(t.status==='Pending'&&(!t.assignedTo||t.assignedTo===actor.email))&&!(['Forwarded','Not Solved'].indexOf(t.status)>=0&&t.assignedTo===actor.email))throw Error('This request is already assigned.');
  t.status='Received';t.assignedTo=actor.email;
 }else{
  if(t.status!=='Received')throw Error('Receive this request before recording a solution or forwarding it.');
  if(t.assignedTo!==actor.email)throw Error('Only the assigned R&I user can update this request.');
  if(!comment&&action!=='pending')throw Error(action==='solve'?'Describe the solution before marking solved.':action==='notSolved'?'Explain why the request could not be solved.':'Add a comment before forwarding.');
  if(action==='solve'){t.status='Solved';t.solution=comment;t.solvedBy=actor.email;t.solvedAt=now;}
  else if(action==='forward'){
   to=users.find(function(u){return u.email===payload.to&&u.email!==actor.email&&handler(u,t.category);});
   if(!to)throw Error('Select another approved R&I user.');
   t.status='Forwarded';t.assignedTo=to.email;
  }else if(action==='notSolved'){t.status='Not Solved';t.notSolvedBy=actor.email;t.notSolvedAt=now;}
  else if(action==='pending'){t.status='Pending';if(!comment)comment='Kept pending by assigned R&I user.';}
  else throw Error('Unknown request action.');
 }
 t.revision++;t.updatedAt=now;t.history.push({at:now,actor:actor.email,action:action,comment:comment,to:to?to.email:t.assignedTo});return t;
}
function dateKey(value){if(!value)return '';var d=new Date(value);if(isNaN(d))return '';var p=new Intl.DateTimeFormat('en-CA',{timeZone:'Asia/Dhaka',year:'numeric',month:'2-digit',day:'2-digit'}).formatToParts(d),o={};p.forEach(function(x){o[x.type]=x.value;});return o.year+'-'+o.month+'-'+o.day;}
function filterTickets(tickets,f){f=f||{};return tickets.filter(function(t){var date=dateKey(f.dateBasis==='solved'?t.solvedAt:t.createdAt);return !t.deletedAt&&(!f.category||t.category===f.category)&&(!f.status||t.status===f.status)&&(!f.assignee||t.assignedTo===f.assignee)&&(!f.engineer||((f.status==='Solved'||f.dateBasis==='solved')?t.solvedBy===f.engineer:t.assignedTo===f.engineer||t.solvedBy===f.engineer||(t.history||[]).some(function(ev){return ev.actor===f.engineer&&['receive','solve','forward','notSolved','pending'].indexOf(ev.action)>=0;})))&&(!f.from||date>=f.from)&&(!f.to||date<=f.to)&&(!f.query||(reference(t)+' '+t.id+' '+Object.values(t.values||{}).join(' ')+' '+(t.solution||'')).toLowerCase().indexOf(f.query.toLowerCase())>=0);});}
function performance(tickets,users){return users.filter(function(u){return u.role==='R&I';}).map(function(u){function count(fn){return tickets.filter(fn).length;}return {email:u.email,name:u.name,received:count(function(t){return t.history.some(function(ev){return ev.actor===u.email&&ev.action==='receive';});}),solved:count(function(t){return t.status==='Solved'&&t.solvedBy===u.email;}),notSolved:count(function(t){return t.status==='Not Solved'&&t.notSolvedBy===u.email;}),pending:count(function(t){return t.status==='Pending'&&t.assignedTo===u.email;}),inProgress:count(function(t){return t.status==='Received'&&t.assignedTo===u.email;}),forwarded:count(function(t){return t.history.some(function(ev){return ev.actor===u.email&&ev.action==='forward';});})};});}
var liveActions=['getDocuments','saveDocumentCategory','deleteDocumentCategory','saveDocument','deleteDocument','getDashboardSupport','getAppContext','listAppUsers','saveAppUserAccess','resetAppUserPassword','getSupportWorkspace','getSupportRequest','getSupportSummary','getSupportReport','createSupportRequest','transitionSupportRequest','editSupportRequest','deleteSupportRequest','saveSupportSchema','getTroubleshootingSummary'];
function apiAllowed(a){return liveActions.indexOf(a)>=0;}
function apiCan(u,a){if(!approved(u))return false;if(calculators[a])return read(u,calculators[a]);if(['adminSaveComponent','adminDeleteComponent','adminUpdateUser','adminResetPassword','saveEngineeringRecord','saveAppUserAccess','resetAppUserPassword','editSupportRequest','deleteSupportRequest','saveSupportSchema','saveTroubleshootingEntry','deleteTroubleshootingEntry'].indexOf(a)>=0)return superUser(u);if(['adminListUsers','listAppUsers'].indexOf(a)>=0)return superUser(u);if(a==='adminGetComponents')return superUser(u);if(['saveDocumentCategory','deleteDocumentCategory','saveDocument','deleteDocument'].indexOf(a)>=0)return superUser(u);if(['getSupportReport','getDashboardSupport','adminStats'].indexOf(a)>=0)return canReport(u);if(a==='transitionSupportRequest')return u.role==='R&I';if(a==='createSupportRequest')return superUser(u)||u.role==='User';if(a==='getComponentDetails'||a==='refreshIndex')return read(u,'selection')||read(u,'calc:energy')||read(u,'calc:solar');return true;}
function validateSchema(raw){if(!raw||!Array.isArray(raw.fields)||raw.fields.length<1||raw.fields.length>60)throw Error('A form needs 1–60 valid fields.');var seen={};var fields=raw.fields.map(function(f){var id=clean(f.id,100),label=clean(f.label,180),help=clean(f.help,2000),type=String(f.type||'text');if(!/^[-a-zA-Z0-9_]{4,100}$/.test(id)||seen[id]||!label||['text','date','select','multi'].indexOf(type)<0)throw Error('Check field name, type and unique ID.');seen[id]=true;var options=Array.from(new Set((Array.isArray(f.options)?f.options:[]).map(function(o){return clean(o,300);}).filter(Boolean)));if(options.length>100||(['select','multi'].indexOf(type)>=0&&!options.length))throw Error('Choice fields need 1–100 valid options.');return {id:id,label:label,help:help,type:type,required:!!f.required,options:['select','multi'].indexOf(type)>=0?options:[]};});if(JSON.stringify(fields).length>28000)throw Error('Form definition is too large.');return fields;}
function entryKey(e){return e.controller==='GENERAL'?'tb:general:'+e.id:e.kind==='procedure'?'tb:option:'+e.id:'tb:'+e.controller+':error';}
return {dateKey:dateKey,reference:reference,unresolvedCount:unresolvedCount,categories:categories,roles:roles,calculators:calculators,superUser:superUser,approved:approved,read:read,operate:operate,categoryRead:categoryRead,handler:handler,visible:visible,validateForm:validateForm,transition:transition,entryKey:entryKey,apiAllowed:apiAllowed,apiCan:apiCan,liveActions:liveActions,validateSchema:validateSchema,canReport:canReport,pendingCount:pendingCount,filterTickets:filterTickets,performance:performance};
});
