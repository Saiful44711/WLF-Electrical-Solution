(function(root,factory){var api=factory();if(typeof module==='object'&&module.exports)module.exports=api;root.TroubleCore=api;})(typeof globalThis!=='undefined'?globalThis:this,function(){
'use strict';
var actions=['getTroubleshooting','saveTroubleshootingEntry','deleteTroubleshootingEntry'];
function allowed(a){return actions.indexOf(a)>=0;}
function can(role,a){return allowed(a)&&(a==='getTroubleshooting'?['Super Admin','Admin','R&I','User'].indexOf(role)>=0:role==='Super Admin');}
function text(v,max){var s=String(v==null?'':v).trim();if(s.length>max)throw Error('Text is too long (maximum '+max+' characters).');return s;}
function list(v,max){if(!Array.isArray(v)||v.length>max)throw Error('Too many fields or invalid list.');return v;}
function norm(v){return String(v||'').toLowerCase().replace(/[^a-z0-9\u0980-\u09ff]/g,'');}
function errorCode(controller,value){var m=text(value,32).match(/^(?:err?|e|h)?\s*0*(\d+)$/i);if(!m)throw Error('Enter a numeric error code, e.g. Er07, Err38 or H12.');if(controller==='MOTCUBE')return 'H'+String(Number(m[1]));return (controller==='MOT'?'Er':'Err')+String(Number(m[1])).padStart(2,'0');}
function stepList(v){return list(v||[],80).map(function(s){return text(s,4000);}).filter(Boolean);}
function validate(raw){
 if(!raw||['MOT','NICE3000+','MOTCUBE','GENERAL'].indexOf(raw.controller)<0)throw Error('Select a valid troubleshooting section.');
 var e={id:text(raw.id,100),controller:raw.controller,kind:raw.kind==='procedure'?'procedure':'error',code:'',description:text(raw.description,2000),conditions:text(raw.conditions,6000),solution:stepList(raw.solution),subcodes:[],fields:[],category:text(raw.category,180),revision:Number(raw.revision||0)};
 if(!/^[-a-zA-Z0-9]{6,100}$/.test(e.id))throw Error('Invalid entry ID.');if(!Number.isSafeInteger(e.revision)||e.revision<0)throw Error('Invalid entry revision.');
 if(e.controller==='GENERAL'||e.kind==='procedure'){if(!e.category)throw Error('Enter a subcategory name.');e.fields=list(raw.fields||[],80).map(function(f){return {label:text(f.label,180),text:text(f.text,6000)};});if((e.controller==='GENERAL'&&!e.fields.length)||e.fields.some(function(f){return !f.label||!f.text;}))throw Error('Each procedure field needs a label and text.');}
 else{e.code=errorCode(e.controller,raw.code);if(!e.description)throw Error('Enter the error description.');}
 // v2.5.5: MOTCUBE codes also carry the manual's parameter list and the permanent / contact R&I flags.
 if(e.controller==='MOTCUBE'&&e.kind!=='procedure'){e.parameters=list(raw.parameters||[],30).map(function(x){return text(x,200);}).filter(Boolean);e.permanent=!!raw.permanent;e.contactRni=!!raw.contactRni;}
 if(e.controller==='NICE3000+'&&e.kind!=='procedure'){
  var seen={};e.subcodes=list(raw.subcodes||[],100).map(function(sc){var code=text(sc.code,24);if(!/^\d+$/.test(code))throw Error('Enter a numeric subcode.');code=String(Number(code));if(seen[code])throw Error('Duplicate subcode: '+code);seen[code]=true;var result={code:code,description:text(sc.description,3000),solution:stepList(sc.solution)};if(!result.description)throw Error('Enter the description for subcode '+code+'.');if(Array.isArray(sc.pages))result.pages=sc.pages.filter(function(p){return Number.isInteger(p)&&p>0;});return result;});
 }
 if(raw.source&&typeof raw.source==='object')e.source={manual:text(raw.source.manual,300),version:text(raw.source.version,200),file:text(raw.source.file,300),pages:list(raw.source.pages||[],50).map(Number).filter(function(n){return Number.isInteger(n)&&n>0;})};
 if(raw.mutationId){e.mutationId=text(raw.mutationId,100);if(!/^[-a-zA-Z0-9]{6,100}$/.test(e.mutationId))throw Error('Invalid mutation ID.');}
 e.sourceNote=text(raw.sourceNote,2000);if(raw.reserved)e.reserved=true;
 // v2.5.0: optional Bangla text (bn) is kept with the entry; English stays the main record.
 if(raw.bn&&typeof raw.bn==='object'){var bn={};var d=text(raw.bn.description,4000),c=text(raw.bn.conditions,8000);if(d)bn.description=d;if(c)bn.conditions=c;
  if(Array.isArray(raw.bn.solution)&&raw.bn.solution.length)bn.solution=stepList(raw.bn.solution);
  if(Array.isArray(raw.bn.subcodes))bn.subcodes=list(raw.bn.subcodes,100).map(function(sc){var code=text(sc&&sc.code,24);return {code:/^\d+$/.test(code)?String(Number(code)):code,description:text(sc&&sc.description,4000),solution:stepList(sc&&sc.solution)};}).filter(function(sc){return sc.code&&sc.description;});
  if(bn.subcodes&&!bn.subcodes.length)delete bn.subcodes;
  // v2.5.1: src = fingerprint of the English text each Bangla part was written for.
  var src=raw.bn.src;if(Object.keys(bn).length&&src&&typeof src==='object'){var fx=function(v){return typeof v==='string'&&/^[0-9a-f]{8}$/.test(v)?v:'';};var keep={};['d','c','s'].forEach(function(k){if(fx(src[k]))keep[k]=src[k];});
   if(src.sub&&typeof src.sub==='object'){var subs={};Object.keys(src.sub).slice(0,100).forEach(function(k){var code=text(k,24);if(code&&fx(src.sub[k]))subs[/^\d+$/.test(code)?String(Number(code)):code]=src.sub[k];});if(Object.keys(subs).length)keep.sub=subs;}
   if(Object.keys(keep).length)bn.src=keep;}
  if(Object.keys(bn).length)e.bn=bn;}
 if(JSON.stringify(e).length>40000)throw Error('This entry exceeds the supported record size. Split the procedure into smaller entries.');return e;
}
function isProcedure(e){return e.controller==='GENERAL'||e.kind==='procedure';}
function sameKey(a,b){return a.controller===b.controller&&isProcedure(a)===isProcedure(b)&&norm(a.code||a.category)===norm(b.code||b.category);}
function index(entries){return entries.map(function(e){return {entry:e,hay:norm([e.code,e.description,e.conditions,e.category].concat(e.parameters||[],e.solution||[],(e.fields||[]).map(function(f){return f.label+' '+f.text;}),(e.subcodes||[]).map(function(s){return s.code+' '+s.description+' '+(s.solution||[]).join(' ');}),bnText(e.bn)).join(' '))};});}
function bnText(b){if(!b)return [];return [b.description||'',b.conditions||''].concat(b.solution||[],(b.subcodes||[]).map(function(s){return s.description+' '+(s.solution||[]).join(' ');}));}
function search(indexed,controller,query,subquery){
 var rawTokens=String(query||'').trim().toLowerCase().split(/[-.\s,/:]+/).filter(Boolean),tokens=rawTokens.map(norm),sub=norm(subquery),target=null;if(controller!=='GENERAL'&&rawTokens[0]&&/^(?:err?|e|h)?0*\d+$/i.test(rawTokens[0]))target=errorCode(controller,rawTokens[0]);
 return indexed.filter(function(row){if(row.entry.controller!==controller||target&&row.entry.code!==target)return false;if(!tokens.every(function(t,i){if(target&&i===0)return true;if(target&&i>0&&/^\d+$/.test(t))return (row.entry.subcodes||[]).some(function(s){return s.code===String(Number(t));});return row.hay.indexOf(t)>=0||norm(row.entry.code).replace(/^(?:err?|h)/,'').replace(/^0+/,'')===t.replace(/^0+/,'');}))return false;return !sub||(row.entry.subcodes||[]).some(function(s){return norm(s.code)===sub.replace(/^0+/,'')||norm(s.code)===sub;});}).map(function(r){return r.entry;});
}
// FNV-1a 32-bit over the UTF-8 JSON text (same as the Python generator).
function fp(v){var b=new TextEncoder().encode(JSON.stringify(v==null?'':v)),h=0x811c9dc5;for(var i=0;i<b.length;i++){h^=b[i];h=Math.imul(h,0x01000193)>>>0;}return ('0000000'+h.toString(16)).slice(-8);}
function enPart(e,k,code){if(k==='d')return e.description||'';if(k==='c')return e.conditions||'';if(k==='s')return e.solution||[];var sc=(e.subcodes||[]).find(function(x){return x.code===code;});return sc?[sc.description||'',sc.solution||[]]:null;}
function bnFresh(e,k,code){var src=e&&e.bn&&e.bn.src;if(!src)return true;var want=k==='sub'?src.sub&&src.sub[code]:src[k];if(!want)return true;var en=enPart(e,k,code);return en!=null&&fp(en)===want;}
return {fp:fp,enPart:enPart,bnFresh:bnFresh,isProcedure:isProcedure,sameKey:sameKey,allowed:allowed,can:can,validate:validate,norm:norm,errorCode:errorCode,index:index,search:search};
});
