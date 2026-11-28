// @ts-nocheck
// Server only. No secret belongs in web/config.js or GitHub.
import {createClient} from 'npm:@supabase/supabase-js@2.118.0';
import JSZip from 'npm:jszip@3.10.1';

// ---- Excel workbook writer (from _shared/wlf-excel.mjs)
/* Write Office Open XML tables. All untrusted form text is emitted as inline text cells. */
const excelMime = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';
const main = 'http://schemas.openxmlformats.org/spreadsheetml/2006/main';
const office = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships';
const packageRels = 'http://schemas.openxmlformats.org/package/2006/relationships';
const declaration = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>';
const text = value => String(value??'').replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\ufffe\uffff]/g,'')
  .replace(/[&<>"']/g, char=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&apos;'}[char]));
const override = (part,type) => '<Override PartName="/xl/'+part+'" ContentType="'+type+'"/>';
const rel = (id,type,target) => '<Relationship Id="'+id+'" Type="'+office+'/'+type+'" Target="'+target+'"/>';
const relationships = children => '<Relationships xmlns="'+packageRels+'">'+children+'</Relationships>';
/* v2.7.0: text cells use the shared string table (xl/sharedStrings.xml), the standard Excel way.
   Google Sheets drops the spaces of inline strings ("Damage Demand" became "DamageDemand"). */
let SST=null;
function textCell(address,style,display) {
  const s=style==null?'':' s="'+style+'"';
  if (!SST) return '<c r="'+address+'"'+s+' t="inlineStr"><is><t xml:space="preserve">'+text(display)+'</t></is></c>';
  let i=SST.map.get(display);
  if (i===undefined) { i=SST.list.length; SST.list.push(display); SST.map.set(display,i); }
  return '<c r="'+address+'"'+s+' t="s"><v>'+i+'</v></c>';
}
const sharedStringsXml=()=>'<sst xmlns="'+main+'" count="'+SST.list.length+'" uniqueCount="'+SST.list.length+'">'+SST.list.map(t=>'<si><t xml:space="preserve">'+text(t)+'</t></si>').join('')+'</sst>';
function withSharedStrings(build) { SST={list:[],map:new Map()}; try { return build(); } finally { SST=null; } }   /* the text is all written before the first await, so parallel builds never mix */
function letters(index) {
  let result='';
  for (let n=index+1;n;n=Math.floor((n-1)/26)) result=String.fromCharCode(65+(n-1)%26)+result;
  return result;
}
function unique(label,fallback,seen,limit) {
  const base=(label||fallback).slice(0,limit);
  let name=base, i=1;
  while (seen.has(name.toLowerCase())) {
    const suffix=' ('+(++i)+')';
    name=base.slice(0,limit-suffix.length)+suffix;
  }
  seen.add(name.toLowerCase());
  return name;
}
const shown=value=>Array.isArray(value)?value.join(', '):String(value??'');
function cell(value,address,wrap) {
  if (typeof value==='number' && Number.isFinite(value)) return '<c r="'+address+'"><v>'+value+'</v></c>';
  if (typeof value==='boolean') return '<c r="'+address+'" t="b"><v>'+Number(value)+'</v></c>';
  return textCell(address,wrap?1:null,shown(value).slice(0,32767));
}
/* v2.7.2: column width from the content (10 to 60 characters); longer text wraps and the row grows (up to 8 lines) */
const longestLine=t=>String(t).split(/\r?\n/).reduce((m,l)=>Math.max(m,l.length),0);
function layout(headers,rows) {
  const widths=headers.map((h,j)=>{let w=String(h).length+3;for(let i=0;i<Math.min(rows.length,400);i++){const v=rows[i][j];if(v!==undefined&&v!==null&&v!=='')w=Math.max(w,longestLine(shown(v))+2);}return Math.max(10,Math.min(60,w));});
  return {widths,lines:(row)=>Math.min(8,Math.max(1,...headers.map((_,j)=>{const v=row[j];if(v===undefined||v===null||typeof v==='number')return 1;
    return String(shown(v)).split(/\r?\n/).reduce((n,l)=>n+Math.max(1,Math.ceil(l.length/(widths[j]-1))),0);})))};
}
const tableStyles='<styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><fonts count="1"><font><sz val="11"/><name val="Calibri"/></font></fonts>'+
  '<fills count="2"><fill><patternFill patternType="none"/></fill><fill><patternFill patternType="gray125"/></fill></fills><borders count="1"><border/></borders>'+
  '<cellStyleXfs count="1"><xf/></cellStyleXfs><cellXfs count="2"><xf/><xf applyAlignment="1"><alignment wrapText="1" vertical="top"/></xf></cellXfs></styleSheet>';

async function buildWorkbook(Zip,groups) { return withSharedStrings(()=>buildWorkbookInner(Zip,groups)); }
async function buildWorkbookInner(Zip,groups) {
  if (!groups.length) groups=[{name:'Activity',headers:['Record ID'],rows:[]}];
  const zip = new Zip(), names=new Set(), sheets=[], workbookRelationships=[], overrides=[];
  function add(path,xml) { zip.file(path,declaration+xml); }
  add('_rels/.rels',relationships(rel('rId1','officeDocument','xl/workbook.xml')));
  for (const [index, group] of groups.entries()) {
    const number=index+1, relation='rId'+number, table='WLFTable'+number;
    const file='worksheets/sheet'+number+'.xml', tableFile='tables/table'+number+'.xml';
    const name=unique(String(group.name??'').replace(/[:\\/?*[\]]/g,' ').trim().replace(/^'+|'+$/g,'').trim(),'Sheet '+number,names,31);
    const seen=new Set(), headers=group.headers.map((header,i)=>unique(String(header??'').trim(),'Column '+(i+1),seen,220));
    const rows=[headers,...(group.rows.length?group.rows:[[]])];
    const range='A1:'+letters(headers.length-1)+rows.length;
    sheets.push('<sheet name="'+text(name)+'" sheetId="'+number+'" r:id="'+relation+'"/>');
    workbookRelationships.push(rel(relation,'worksheet',file));
    overrides.push(override(file,'application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml'),
      override(tableFile,'application/vnd.openxmlformats-officedocument.spreadsheetml.table+xml'));
    const lay=layout(headers,rows);
    const data=rows.map((row,i)=>{const n=i?lay.lines(row):1;return '<row r="'+(i+1)+'"'+(n>1?' ht="'+(n*15)+'" customHeight="1"':'')+'>'+headers.map((_,j)=>cell(row[j],letters(j)+(i+1),i>0&&n>1)).join('')+'</row>';}).join('');
    const columns=headers.map((header,i)=>'<col min="'+(i+1)+'" max="'+(i+1)+'" width="'+lay.widths[i]+'" customWidth="1"/>').join('');
    add('xl/'+file,'<worksheet xmlns="'+main+'" xmlns:r="'+office+'"><dimension ref="'+range+'"/>'+
      '<sheetViews><sheetView workbookViewId="0"><pane ySplit="1" topLeftCell="A2" activePane="bottomLeft" state="frozen"/></sheetView></sheetViews>'+
      '<cols>'+columns+'</cols><sheetData>'+data+'</sheetData><tableParts count="1"><tablePart r:id="rId1"/></tableParts></worksheet>');
    add('xl/worksheets/_rels/sheet'+number+'.xml.rels',relationships(rel('rId1','table','../'+tableFile)));
    add('xl/'+tableFile,'<table xmlns="'+main+'" id="'+number+'" name="'+table+'" displayName="'+table+
      '" ref="'+range+'" totalsRowShown="0"><autoFilter ref="'+range+'"/><tableColumns count="'+headers.length+'">'+
      headers.map((header,i)=>'<tableColumn id="'+(i+1)+'" name="'+text(header)+'"/>').join('')+'</tableColumns>'+
      '<tableStyleInfo name="TableStyleMedium2" showFirstColumn="0" showLastColumn="0" showRowStripes="1" showColumnStripes="0"/></table>');
  }
  add('xl/workbook.xml','<workbook xmlns="'+main+'" xmlns:r="'+office+'"><bookViews><workbookView/></bookViews><sheets>'+sheets.join('')+'</sheets></workbook>');
  add('xl/sharedStrings.xml',sharedStringsXml());
  add('xl/styles.xml',tableStyles);
  add('xl/_rels/workbook.xml.rels',relationships(workbookRelationships.join('')+rel('rIdSST','sharedStrings','sharedStrings.xml')+rel('rIdSTY','styles','styles.xml')));
  add('[Content_Types].xml','<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">'+
    '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>'+
    '<Default Extension="xml" ContentType="application/xml"/>'+
    override('workbook.xml','application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml')+
    override('sharedStrings.xml','application/vnd.openxmlformats-officedocument.spreadsheetml.sharedStrings+xml')+
    override('styles.xml','application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml')+
    overrides.join('')+'</Types>');
  return zip.generateAsync({type:'uint8array',compression:'DEFLATE',compressionOptions:{level:3}});
}

const supportNames={
  commissioning:'Commissioning',aftersales:'After Sales',production:'Production',
  maintenance:'Factory Maintenance',qc:'QC',installation:'Installation'
};
const fieldKey=field=>field.id+'\0'+field.label;
function formSheet(name,schema,records,baseHeaders,baseRow,getForm) {
  const columns=new Map();
  for (const form of [schema,...records.map(getForm)]) {
    for (const field of form?.fields||[]) columns.set(fieldKey(field),field.label);
  }
  return {
    name,headers:[...baseHeaders,...columns.values()],
    rows:records.map(record=>{
      const vals=new Map((getForm(record)||schema)?.fields?.map(f=>[fieldKey(f),record.values?.[f.id]])||[]);
      return [...baseRow(record),...Array.from(columns.keys(),key=>vals.get(key)??'')];
    })
  };
}
function supportSheets(categories,tickets,options={}) {
  /* options.lean: Technical Support menu download \u2014 leaves out the bookkeeping columns (request id, people, timestamps) */
  const sheets=categories.map(c=>formSheet(supportNames[c.id]||c.name,c.schema,tickets.filter(r=>r.category===c.id),
    ['Request ID','Workflow status','Submitted by','Submitted at (UTC)','Last updated (UTC)','Assigned to','Solved by','Solved at (UTC)','Solution'],
    r=>[r.reference,r.status,r.authorName||r.createdBy,r.createdAt,r.updatedAt,r.assigneeName||r.assignedTo,
      r.solverName||r.solvedBy,r.solvedAt,r.solution],r=>r.formSchema));
  if (!options.lean) return sheets;
  const drop=new Set([0,2,3,4,5,6]);
  return sheets.map(sheet=>({...sheet,headers:sheet.headers.filter((_,i)=>!drop.has(i)),rows:sheet.rows.map(row=>row.filter((_,i)=>!drop.has(i)))}));
}
function activitySheets(categories,entries) {
  return categories.map(c=>formSheet(c.name,c.schema,entries.filter(r=>r.category===c.id),
    [],r=>[],r=>r.form_schema));
}
const when=value=>value?String(value):'';
const hwSections={control:'Control system',lop:'LOP',cop:'COP',faceplate:'COP faceplate',transom:'Transom',cable:'Travelling cable',other:'Other components',avr:'AVR',paid:'Paid feature'};
function projectSheets(records) {
  const tasks=r=>Array.isArray(r.project?.data?.tasks)?r.project.data.tasks:[];
  const progress=list=>list.length?Math.round(list.reduce((sum,t)=>sum+Number(t.progress||0),0)/list.length):0;
  return [
    {name:'Projects',headers:['Project ID','Project','Status','Lead','Start','End','Created by','Created at (UTC)','Updated at (UTC)','Tasks','Progress %','Brief'],
      rows:records.map(r=>{const d=r.project.data||{};return [r.project.id,d.name,d.status,d.lead,d.start,d.end,r.ownerName,when(r.project.created_at),
        when(r.project.updated_at),tasks(r).length,progress(tasks(r)),d.brief];})},
    {name:'Tasks',headers:['Project','Task','Assignee','Start','End','Status','Progress %'],
      rows:records.flatMap(r=>tasks(r).map(t=>[r.project.data?.name,t.name,t.owner,t.start,t.end,t.status,Number(t.progress||0)]))}
  ];
}
function qmsSheets(records) {
  const lifts=records.map(r=>qmsNormalize(r.lift||r));
  const sheets=[
    {name:'QMS Lifts',headers:['Lift ID','Project','Address','Delivery date','Motor type','Lift type','Control system','Controller model','AVR model','Created by','Created at (UTC)','Updated by','Updated at (UTC)','Components','Special note'],
      rows:lifts.map(l=>[l.liftId,l.project,l.address,l.deliveryDate,l.motorType,l.liftType,l.system,l.controllerModel,(l.parts.find(p=>p.section==='avr')||{}).model||'',l.createdName,when(l.createdAt),
        l.updatedName,when(l.updatedAt),l.parts.length,l.specialNote])},
    {name:'QMS Components',headers:['Lift ID','Project','Section','Group','Hardware','Spec','Item code','Item name','Brand','Supplier','Price (BDT)','Serial'],
      rows:lifts.flatMap(l=>l.parts.map(p=>[l.liftId,l.project,hwSections[p.section]||p.section||'',p.grp,p.hardware,p.spec,p.code,p.name,p.brand,p.supplier,
        p.value===null||p.value===undefined||p.value===''?'':Number(p.value),p.serial]))}
  ];
  /* serial numbers only for lifts whose serials were sent (accounts without the permission get none) */
  if (lifts.some(l=>!l.serialsHidden)) sheets.push({name:'QMS Serial numbers',headers:['Lift ID','Project','Part','Serial number'],
    rows:lifts.filter(l=>!l.serialsHidden).flatMap(l=>qmsSerials.filter(([k])=>l.serials[k]).map(([k,t])=>[l.liftId,l.project,serialName(k,t,l.system),l.serials[k]]))});
  sheets.push({name:'QMS Output Tables',headers:qmsFlatHeaders,rows:lifts.flatMap(l=>qmsFlatRows(l))});
  return sheets;
}
function demandSheets(records) {
  const d=records.map(r=>r.demand);
  return [{name:'Damage Demand',headers:['Demand no','Request','Team','Project','Lift ID','Requested by','Requested at (UTC)','Controllers','Problem categories','Item name','Item code','Item spec','Quantity',
    'Solution','Duration (min)','Confirmed by','Received by','Received at (UTC)','Supplier claim','Supplier'],
    rows:d.map(x=>[x.demand_no,x.request_reference,x.category,x.project,x.lift_id,x.requester_name,when(x.requested_at),x.controllers,x.problem_categories,x.item_name,x.item_code,
      x.item_spec,x.quantity,x.solution_statement,x.duration_minutes===null?'':Number(x.duration_minutes),x.confirmed_name,x.received_name||'',when(x.received_at),
      x.claim_at?(x.sc_received_at?'Goods received':x.confirm_at?'Confirmed':'Yes'):'No',x.claim_supplier||''])}];
}
function claimSheets(records) {
  const d=records.map(r=>r.demand);
  return [{name:'Supplier Claim',headers:['Demand no','Request','Team','Project','Lift ID','Item name','Item code','Quantity','Supplier','Claim date','Claim raised by','Claim raised at (UTC)',
    'Note','Confirmed by','Confirmed at (UTC)','Goods received by','Goods received at (UTC)'],
    rows:d.map(x=>[x.demand_no,x.request_reference,x.category,x.project,x.lift_id,x.item_name,x.item_code,x.quantity,x.claim_supplier||'',x.claim_date||'',x.claim_name||'',
      when(x.claim_at),x.claim_note||'',x.confirm_name||'',when(x.confirm_at),x.sc_received_name||'',when(x.sc_received_at)])}];
}
function backupSheets(snapshot) {
  if (snapshot.kind==='project') return projectSheets(snapshot.records);
  if (snapshot.kind==='qms') return qmsSheets(snapshot.records);
  if (snapshot.kind==='damage') return demandSheets(snapshot.records);
  if (snapshot.kind==='claim') return claimSheets(snapshot.records);
  if (snapshot.kind==='activity') return activitySheets(snapshot.categories,snapshot.records.map(r=>r.entry));
  return supportSheets(snapshot.categories,snapshot.records.map(item=>{
    const r=item.request;
    return {
      category:r.category,reference:r.reference,status:r.status,values:r.values,formSchema:r.form_schema,
      authorName:item.authorName,assigneeName:item.assigneeName,solverName:item.solverName,
      createdAt:r.created_at,updatedAt:r.updated_at,solvedAt:r.solved_at,solution:r.solution
    };
  }));
}

/* ---------- v2.6.4: QMS output tables (one source for the lift Excel report and the backup flat sheet) ---------- */
const serialName=(k,t,system)=>k==='ups'&&/NICE/i.test(String(system||''))?'ARD':t;   // a NICE controller has an ARD, not a UPS (same stored number)
const qmsSerials=[['motor','Motor'],['encoder','Encoder'],['drive','Drive'],['ups','UPS'],['cartop','Cartop PCB'],['cop','COP PCB'],['copDisplay','COP Display'],['avr','AVR'],['battery','Battery']];
const monthNames=['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
function qmsDate(value) {
  const m=/^(\d{4})-(\d{2})-(\d{2})/.exec(String(value||''));
  return m?Number(m[3])+' '+monthNames[Number(m[2])-1]+' '+m[1]:String(value||'');
}
function qmsClock(value) {
  if (!value) return '';
  const d=new Date(value);
  if (Number.isNaN(d.getTime())) return String(value);
  const p=new Intl.DateTimeFormat('en-GB',{timeZone:'Asia/Dhaka',day:'numeric',month:'short',year:'numeric',hour:'2-digit',minute:'2-digit',hour12:false}).format(d);
  return p;
}
const pick=(...v)=>v.find(x=>x!==undefined&&x!==null);
function qmsNormalize(l) {
  return {liftId:pick(l.liftId,l.lift_id)||'',project:l.project||'',address:l.address||'',deliveryDate:pick(l.deliveryDate,l.delivery_date)||'',
    motorType:pick(l.motorType,l.motor_type)||'',liftType:pick(l.liftType,l.lift_type)||'',system:l.system||'',
    controllerModel:pick(l.controllerModel,l.controller_model)||'',specialNote:pick(l.specialNote,l.paidNote,l.paid_note)||'',serials:l.serials||{},serialsHidden:!!pick(l.serialsHidden,false),createdAt:pick(l.createdAt,l.created_at)||'',selection:l.selection||null,parts:Array.isArray(l.parts)?l.parts:[],
    createdName:pick(l.createdName,l.created_name)||'',updatedName:pick(l.updatedName,l.updated_name)||'',updatedAt:pick(l.updatedAt,l.updated_at)||''};
}
const qmsSdb=sel=>{
  const it=(sel?.categories||[]).flatMap(c=>c.items||[]).find(x=>/^SDB/i.test(x.label));
  const v=String(it?.value??'').trim();
  return v&&v!=='-'?(/^[\d.]+$/.test(v)?v+' A':v):'';
};
const priceOf=p=>p.value===null||p.value===undefined||p.value===''||!Number.isFinite(Number(p.value))?'':Number(p.value);
const codeOf=p=>p.code||'no code';
/* Tables 1-9 exactly as QMS Data shows them. Every block's spans add up to 10 grid units. */
function qmsTables(raw) {
  const rec=qmsNormalize(raw);
  const parts=sections=>rec.parts.filter(p=>sections.includes(p.section));
  const sel=rec.selection, cats=sel?.categories||[];
  const kv=(no,name,sub,rows)=>({no,name,sub,hideHead:true,columns:[{head:'',key:'b',span:3,bold:true},{head:'',key:'spec',span:7}],rows});
  const blocks=[];
  blocks.push({no:1,name:'Project information',columns:[{head:'Project',key:'project',span:2},{head:'Lift ID',key:'liftId',span:1},{head:'Address',key:'address',span:2},
    {head:'Delivery',key:'delivery',span:2},{head:'Motor type',key:'motorType',span:1},{head:'Lift type',key:'liftType',span:2}],
    rows:[{project:rec.project,liftId:rec.liftId,address:rec.address,delivery:qmsDate(rec.deliveryDate),motorType:rec.motorType,liftType:rec.liftType}],
    flat:()=>[{a:'',b:'Motor type',spec:rec.motorType},{a:'',b:'Lift type',spec:rec.liftType}]});
  if (cats[0]) {
    const inputs=sel.inputs||{};
    blocks.push(kv(2,'Selected motor','Inputs',[['Capacity',inputs.capacity],['Speed',inputs.speed],['Usage type',inputs.usageType],['Roping',inputs.roping]]
      .map(([b,spec])=>({b,spec:spec??''}))));
    blocks.push(kv(2,'Selected motor',cats[0].title,(cats[0].items||[]).map(it=>({b:it.label,spec:it.value??''}))));
    for (const c of cats.slice(1)) blocks.push(kv(2,'Selected motor',c.title,(c.items||[]).map(it=>({b:it.label,spec:it.value??''}))));
  } else blocks.push({no:2,name:'Selected motor',empty:'No motor was recorded.',columns:[],rows:[]});
  blocks.push({no:3,name:'Control system \u2014 '+rec.system+' \u00b7 '+rec.controllerModel,short:'Control system',columns:[{head:'Group',key:'a',span:2},{head:'Hardware',key:'b',span:2},{head:'Spec',key:'spec',span:1},
    {head:'Item code',key:'code',span:1},{head:'Item name',key:'name',span:2},{head:'Brand',key:'brand',span:1},{head:'Price (\u09f3)',key:'price',span:1,num:true}],
    rows:parts(['control']).map(p=>({a:p.grp||'',b:p.hardware||'',spec:p.spec||'',code:codeOf(p),name:p.name||'',brand:p.brand||'',price:priceOf(p)}))});
  blocks.push({no:4,name:'Serial numbers',columns:[{head:'Part',key:'a',span:3},{head:'Serial number',key:'spec',span:7}],
    rows:rec.serialsHidden?[]:qmsSerials.map(([k,t])=>({a:serialName(k,t,rec.system),spec:rec.serials?.[k]||'\u2014'})),
    hidden:rec.serialsHidden,empty0:'Serial numbers are not shown to this account.'});
  const names={lop:'LOP',cop:'COP',faceplate:'COP faceplate',transom:'Transom',cable:'Travelling cable'};
  blocks.push({no:5,name:'COP \u00b7 LOP \u00b7 Transom \u00b7 Travelling cable',short:'COP LOP Transom Cable',columns:[{head:'Part',key:'a',span:2},{head:'Model',key:'b',span:2},{head:'Item code',key:'code',span:1},
    {head:'Item name',key:'name',span:3},{head:'Brand',key:'brand',span:1},{head:'Price (\u09f3)',key:'price',span:1,num:true}],
    rows:parts(['lop','cop','faceplate','transom','cable']).map(p=>({a:names[p.section]+(p.grp&&p.section==='cop'?' \u00b7 '+p.grp.replace('COP ',''):''),b:p.hardware||'',
      code:codeOf(p),name:p.name||'',brand:p.brand||'',price:priceOf(p)}))});
  const avrModel=parts(['avr'])[0]?.model||'';
  blocks.push({no:6,name:'AVR'+(avrModel?' \u2014 '+avrModel:''),short:'AVR',columns:[{head:'Category',key:'a',span:2},{head:'Hardware',key:'b',span:2},{head:'Spec',key:'spec',span:2},
    {head:'Item code',key:'code',span:1},{head:'Brand',key:'brand',span:1},{head:'Supplier',key:'supplier',span:1},{head:'Price (\u09f3)',key:'price',span:1,num:true}],
    rows:parts(['avr']).map(p=>({a:p.grp||'',b:[p.hardware,p.name].filter(Boolean).join(' \u00b7 ')||p.model||'',spec:p.spec||'',code:codeOf(p),brand:p.brand||'',supplier:p.supplier||'',price:priceOf(p)})),empty0:'No AVR was selected.'});
  const other=parts(['other']).map(p=>({a:p.hardware||'',code:codeOf(p),name:p.name||'',spec:p.spec||'',supplier:p.supplier||'',brand:p.brand||'',price:priceOf(p)}));
  if (qmsSdb(sel)) other.push({a:'SDB main breaker rating',code:'\u2014',name:'\u2014',spec:qmsSdb(sel),supplier:'',brand:'',price:''});
  blocks.push({no:7,name:'Other components',short:'Other components',columns:[{head:'Category',key:'a',span:2},{head:'Item code',key:'code',span:1},{head:'Item name',key:'name',span:3},
    {head:'Spec',key:'spec',span:1},{head:'Supplier',key:'supplier',span:1},{head:'Brand',key:'brand',span:1},{head:'Price (\u09f3)',key:'price',span:1,num:true}],rows:other});
  blocks.push({no:8,name:'Paid feature information',short:'Paid feature information',columns:[{head:'Category',key:'a',span:2},{head:'Item code',key:'code',span:1},{head:'Item name',key:'name',span:3},
    {head:'Spec',key:'spec',span:1},{head:'Brand',key:'brand',span:1},{head:'Supplier',key:'supplier',span:1},{head:'Price (\u09f3)',key:'price',span:1,num:true}],
    rows:parts(['paid']).map(p=>({a:p.grp||p.hardware||'',code:codeOf(p),name:p.name||'',spec:p.spec||'',brand:p.brand||'',supplier:p.supplier||'',price:priceOf(p)})),
    empty0:'No paid feature was selected.'});
  blocks.push({no:9,name:'Special note',short:'Special note',columns:[{head:'Special note',key:'a',span:10}],rows:rec.specialNote?[{a:rec.specialNote}]:[],empty0:'No special note.'});
  return {rec,blocks};
}
/* One flat sheet for analysis: one row per table row, with the lift columns first. */
const qmsFlatHeaders=['Lift ID','Project','Address','Delivery date','Controller','Table no.','Table name','Section','Group / Part / Category','Hardware / Model','Spec / Value','Item code','Item name','Brand','Supplier','Price (BDT)'];
function qmsFlatRows(raw) {
  const {rec,blocks}=qmsTables(raw), out=[];
  const lead=[rec.liftId,rec.project,rec.address,rec.deliveryDate,rec.controllerModel];
  const blank=v=>v==='\u2014'?'':v;
  for (const b of blocks) {
    if (b.hidden) continue;
    const name=b.short||b.name.split(' \u2014 ')[0];
    const rows=b.flat?b.flat():[...b.rows];
    if (b.note) rows.push({a:'Special note',spec:b.note});
    for (const r of rows) {
      out.push([...lead,b.no,name,b.sub||'',r.a||'',r.b||'',blank(r.spec??''),blank(r.code||''),blank(r.name||''),r.brand||'',r.supplier||'',r.price===undefined?'':r.price]);
    }
  }
  return out;
}

/* ---------- v2.6.4: one print-ready report sheet for a single lift ---------- */
const UNIT=11.5, UNITS=10;
function styledCell(value,address,style) {
  if (typeof value==='number' && Number.isFinite(value)) return '<c r="'+address+'" s="'+style+'"><v>'+value+'</v></c>';
  const display=String(value??'');
  if (!display) return '<c r="'+address+'" s="'+style+'"/>';
  return textCell(address,style,display.slice(0,32767));
}
const linesFor=(value,units)=>{
  const per=Math.max(4,Math.floor(units*UNIT*0.85));
  return String(value??'').split('\n').reduce((n,part)=>n+Math.max(1,Math.ceil(part.length/per)),0);
};
const reportStyles='<styleSheet xmlns="'+main+'"><numFmts count="1"><numFmt numFmtId="164" formatCode="#,##0.00"/></numFmts>'+
  '<fonts count="5"><font><sz val="10"/><name val="Calibri"/></font><font><b/><sz val="16"/><color rgb="FF1F2A44"/><name val="Calibri"/></font>'+
  '<font><i/><sz val="10"/><color rgb="FF595959"/><name val="Calibri"/></font><font><b/><sz val="10"/><color rgb="FFFFFFFF"/><name val="Calibri"/></font>'+
  '<font><b/><sz val="10"/><name val="Calibri"/></font></fonts>'+
  '<fills count="4"><fill><patternFill patternType="none"/></fill><fill><patternFill patternType="gray125"/></fill>'+
  '<fill><patternFill patternType="solid"><fgColor rgb="FF1F2A44"/><bgColor indexed="64"/></patternFill></fill>'+
  '<fill><patternFill patternType="solid"><fgColor rgb="FFE8ECF4"/><bgColor indexed="64"/></patternFill></fill></fills>'+
  '<borders count="2"><border><left/><right/><top/><bottom/><diagonal/></border>'+
  '<border><left style="thin"><color rgb="FFBFC6D4"/></left><right style="thin"><color rgb="FFBFC6D4"/></right><top style="thin"><color rgb="FFBFC6D4"/></top><bottom style="thin"><color rgb="FFBFC6D4"/></bottom><diagonal/></border></borders>'+
  '<cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs>'+
  '<cellXfs count="9"><xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/>'+
  '<xf numFmtId="0" fontId="1" fillId="0" borderId="0" xfId="0" applyFont="1"/>'+
  '<xf numFmtId="0" fontId="2" fillId="0" borderId="0" xfId="0" applyFont="1"/>'+
  '<xf numFmtId="0" fontId="3" fillId="2" borderId="0" xfId="0" applyFont="1" applyFill="1" applyAlignment="1"><alignment vertical="center"/></xf>'+
  '<xf numFmtId="0" fontId="4" fillId="3" borderId="1" xfId="0" applyFont="1" applyFill="1" applyBorder="1" applyAlignment="1"><alignment vertical="center" wrapText="1"/></xf>'+
  '<xf numFmtId="0" fontId="0" fillId="0" borderId="1" xfId="0" applyBorder="1" applyAlignment="1"><alignment vertical="top" wrapText="1"/></xf>'+
  '<xf numFmtId="164" fontId="0" fillId="0" borderId="1" xfId="0" applyNumberFormat="1" applyBorder="1" applyAlignment="1"><alignment horizontal="right" vertical="top"/></xf>'+
  '<xf numFmtId="0" fontId="4" fillId="0" borderId="1" xfId="0" applyFont="1" applyBorder="1" applyAlignment="1"><alignment vertical="top" wrapText="1"/></xf>'+
  '<xf numFmtId="0" fontId="4" fillId="0" borderId="0" xfId="0" applyFont="1"/></cellXfs><cellStyles count="1"><cellStyle name="Normal" xfId="0" builtinId="0"/></cellStyles></styleSheet>';
/* report = {name,title,subtitle,blocks:[{no,name,sub,hideHead,empty,columns:[{head,key,span,num,bold}],rows:[{key:value}]}]} */
async function buildReportWorkbook(Zip,report) { return withSharedStrings(()=>buildReportWorkbookInner(Zip,report)); }
async function buildReportWorkbookInner(Zip,report) {
  const zip=new Zip(), rows=[], merges=[];
  const add=(path,xml)=>zip.file(path,declaration+xml);
  const grid=i=>letters(i);
  let r=0;
  const put=(cells,height)=>{r++;rows.push('<row r="'+r+'"'+(height?' ht="'+height+'" customHeight="1"':'')+'>'+cells.join('')+'</row>');return r;};
  const span=(row,start,units,value,style,extra=[])=>{ /* one merged cell plus styled blanks, so borders show */
    const cells=[styledCell(value,grid(start)+row,style)];
    for (let k=1;k<units;k++) cells.push(styledCell('',grid(start+k)+row,style));
    if (units>1) merges.push(grid(start)+row+':'+grid(start+units-1)+row);
    return cells;
  };
  const title=String(report.title||''), subtitle=String(report.subtitle||'');
  let row=r+1; put(span(row,0,UNITS,title,1),26);
  if (subtitle) { row=r+1; put(span(row,0,UNITS,subtitle,2),16); }
  put([],8);
  let lastNo=null;
  for (const block of report.blocks||[]) {
    if (block.no!==lastNo) {
      lastNo=block.no;
      row=r+1; put(span(row,0,UNITS,block.no+' \u00b7 '+block.name,3),20);
    }
    if (block.sub) { row=r+1; put(span(row,0,UNITS,block.sub,8),18); }
    if (block.empty) { row=r+1; put(span(row,0,UNITS,block.empty,5),18); put([],8); continue; }
    if (!block.hideHead) {
      row=r+1; let col=0, cells=[];
      for (const c of block.columns) { cells.push(...span(row,col,c.span,c.head,4)); col+=c.span; }
      put(cells,20);
    }
    for (const data of block.rows) {
      row=r+1; let col=0, cells=[], lines=1;
      for (const c of block.columns) {
        const value=data[c.key];
        lines=Math.max(lines,linesFor(value,c.span));
        cells.push(...span(row,col,c.span,c.num?value:(value===undefined||value===null?'':String(value)),c.num&&typeof value==='number'?6:(c.bold?7:5)));
        col+=c.span;
      }
      put(cells,Math.max(18,lines*14+6));
    }
    if (!block.rows.length) { row=r+1; put(span(row,0,UNITS,block.empty0||'Nothing recorded.',5),18); }
    if (block.note) { row=r+1; const t='Special note: '+block.note; put(span(row,0,UNITS,t,5),Math.max(18,linesFor(t,UNITS)*14+6)); }
    put([],8);
  }
  const cols='<cols><col min="1" max="'+UNITS+'" width="'+UNIT+'" customWidth="1"/></cols>';
  const footer='&amp;L&amp;8Design &amp;&amp; Developed by Md. Saiful Islam&amp;R&amp;8Page &amp;P of &amp;N';
  add('_rels/.rels',relationships(rel('rId1','officeDocument','xl/workbook.xml')));
  const sheetName=String(report.name||'QMS Report').replace(/[:\\/?*[\]]/g,' ').slice(0,31)||'QMS Report';
  add('xl/worksheets/sheet1.xml','<worksheet xmlns="'+main+'" xmlns:r="'+office+'"><sheetPr><pageSetUpPr fitToPage="1"/></sheetPr>'+
    '<dimension ref="A1:'+grid(UNITS-1)+r+'"/><sheetViews><sheetView showGridLines="0" workbookViewId="0"/></sheetViews><sheetFormatPr defaultRowHeight="15"/>'+
    cols+'<sheetData>'+rows.join('')+'</sheetData>'+(merges.length?'<mergeCells count="'+merges.length+'">'+merges.map(m=>'<mergeCell ref="'+m+'"/>').join('')+'</mergeCells>':'')+
    '<printOptions horizontalCentered="1"/><pageMargins left="0.4" right="0.4" top="0.5" bottom="0.6" header="0.3" footer="0.3"/>'+
    '<pageSetup paperSize="9" orientation="landscape" fitToWidth="1" fitToHeight="0"/><headerFooter><oddFooter>'+footer+'</oddFooter></headerFooter></worksheet>');
  add('xl/styles.xml',reportStyles.replace(/^<\?xml[^>]*>/,''));
  add('xl/workbook.xml','<workbook xmlns="'+main+'" xmlns:r="'+office+'"><bookViews><workbookView/></bookViews><sheets><sheet name="'+text(sheetName)+'" sheetId="1" r:id="rId1"/></sheets></workbook>');
  add('xl/sharedStrings.xml',sharedStringsXml());
  add('xl/_rels/workbook.xml.rels',relationships(rel('rId1','worksheet','worksheets/sheet1.xml')+rel('rId2','styles','styles.xml')+rel('rId3','sharedStrings','sharedStrings.xml')));
  add('[Content_Types].xml','<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">'+
    '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/>'+
    override('workbook.xml','application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml')+
    override('worksheets/sheet1.xml','application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml')+
    override('styles.xml','application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml')+
    override('sharedStrings.xml','application/vnd.openxmlformats-officedocument.spreadsheetml.sharedStrings+xml')+'</Types>');
  return zip.generateAsync({type:'uint8array',compression:'DEFLATE',compressionOptions:{level:3}});
}
function qmsReport(raw) {
  const {rec,blocks}=qmsTables(raw);
  const sub=['Recorded by '+rec.createdName,rec.updatedAt?'Updated '+qmsClock(rec.updatedAt)+' by '+rec.updatedName:''].filter(Boolean).join(' \u00b7 ');
  return {name:'QMS Report',title:'QMS \u2014 Lift '+rec.liftId+' \u00b7 '+rec.project,subtitle:sub,blocks};
}

// ---- Excel backup handler (from _shared/wlf-excel-edge.mjs)
const jsonMime='application/json';
const recoveryFormat='WLF-EXCEL-RECOVERY-2.2';
const encoder=new TextEncoder();
const maxDownload=12000000;
async function excelDigest(bytes) {
  return Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',bytes)),n=>n.toString(16).padStart(2,'0')).join('');
}
function base64(bytes) {
  let result='';
  for(let offset=0;offset<bytes.length;offset+=32766) {
    result+=btoa(String.fromCharCode(...bytes.subarray(offset,offset+32766)));
  }
  return result;
}
/* v2.7.2 monthly automatic backup: "Technical Support Backup 2026-11.xlsx" */
function monthlyName(kind,month) {
  return ({support:'Technical Support',activity:'R&I Team Activity',project:'R&I Project Manager',qms:'QMS Data',damage:'Damage Demand',claim:'Supplier Claim'}[kind]||'Backup')+' Backup '+month+'.xlsx';
}
function fileName(run,extension='xlsx') {
  const module={support:'Technical-Support',activity:'RI-Team-Activity',project:'RI-Project',qms:'QMS-Data',damage:'Damage-Demand',claim:'Supplier-Claim'}[run.kind]||'Backup';
  const period=run.date_from?run.date_from+'_to_'+run.date_to:'All-Dates';
  return 'WLF-'+module+'-'+period+'-'+run.id.slice(0,8)+'.'+extension;
}

async function excelMaintenance({action,payload,sql,drive,folder,project,Zip,monthly}) {
  const id=payload.id;
  async function readFile(fileId,expected) {
    if(!/^[-a-zA-Z0-9_]{5,200}$/.test(fileId||''))throw Error('A verified backup file was not found.');
    const response=await drive('drive/v3/files/'+encodeURIComponent(fileId)+'?alt=media');
    if(Number(response.headers.get('content-length')||0)>maxDownload)throw Error('Verified file exceeds the download limit.');
    const bytes=new Uint8Array(await response.arrayBuffer());
    if(bytes.length>maxDownload||await excelDigest(bytes)!==expected)throw Error('Google Drive verification failed. No clear was performed.');
    return bytes;
  }
  async function saveFile(bytes,name,mimeType,parent) {
    const boundary='wlf_'+crypto.randomUUID();
    const metadata={name,mimeType,parents:[parent],appProperties:{wlfExcelRun:id}};
    const body=new Blob([
      '--'+boundary+'\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n'+JSON.stringify(metadata)+'\r\n',
      '--'+boundary+'\r\nContent-Type: '+mimeType+'\r\n\r\n',bytes,'\r\n--'+boundary+'--\r\n'
    ]);
    const response=await drive('upload/drive/v3/files?uploadType=multipart&fields=id',{
      method:'POST',headers:{'Content-Type':'multipart/related; boundary='+boundary},body
    });
    const file=await response.json(),sha256=await excelDigest(bytes);
    await readFile(file.id,sha256);
    return {id:file.id,sha256};
  }
  const encodeDownload=(run,bytes)=>({run,name:fileName(run),bytes:base64(bytes)});
  if(action==='excelBackup') {
    const nonce=crypto.randomUUID(), snapshot=await sql('prepare',{...payload,nonce});
    if(snapshot.verified) {
      const run=await sql('read',{id});
      return encodeDownload(run,await readFile(run.workbook_id,run.workbook_hash));
    }
    try {
      const bytes=await buildWorkbook(Zip,backupSheets(snapshot));
      if(bytes.length>4000000)throw Error('Workbook is too large. Choose a shorter date range.');
      const run={id,kind:snapshot.kind,date_from:payload.from,date_to:payload.to};
      const parent=await folder(),workbook=await saveFile(bytes,monthly?monthlyName(run.kind,monthly):fileName(run),excelMime,parent);
      let recovery;
      if(payload.withClear) {
        const archive={format:recoveryFormat,project,id,kind:run.kind,records:snapshot.records};
        recovery=await saveFile(encoder.encode(JSON.stringify(archive)),fileName(run,'recovery.json'),jsonMime,parent);
      }
      const verified=await sql('verify',{id,nonce,workbookId:workbook.id,workbookHash:workbook.sha256,
        recoveryId:recovery?.id,recoveryHash:recovery?.sha256});
      if(monthly)return {run:verified,name:monthlyName(run.kind,monthly),records:snapshot.total};
      return encodeDownload(verified,bytes);
    } catch(err) {
      try { await sql('release',{id,nonce}); } catch (_) { /* The short database lease also expires. */ }
      throw err;
    }
  }
  const run=await sql('read',{id});
  if(action==='excelDownload')return encodeDownload(run,await readFile(run.workbook_id,run.workbook_hash));
  if(action==='excelClear') {
    if(payload.confirmed!==true||!run.with_clear)throw Error('Confirm Clear for a verified backup first.');
    if(run.clear_finished)return run;
    await readFile(run.workbook_id,run.workbook_hash);
    await readFile(run.recovery_id,run.recovery_hash);
    return sql('clear',{id});
  }
  if(action==='excelRestore') {
    if(payload.confirmed!==true)throw Error('Confirm recovery before restoring.');
    const archive=JSON.parse(new TextDecoder().decode(await readFile(run.recovery_id,run.recovery_hash)));
    return sql('restore',{id,project,archive});
  }
  throw Error('Unsupported Excel backup action');
}

// ---- v2.6.3: Activity log archive and Backup of all other data (own Google Drive folders)
const fullFormat='WLF-FULL-2.6.3';
const dhaka=value=>new Date(value).toLocaleString('en-GB',{timeZone:'Asia/Dhaka',hour12:false});
async function driveRead(drive,fileId,expected) {
  if(!/^[-a-zA-Z0-9_]{5,200}$/.test(fileId||''))throw Error('A verified backup file was not found.');
  const response=await drive('drive/v3/files/'+encodeURIComponent(fileId)+'?alt=media');
  const bytes=new Uint8Array(await response.arrayBuffer());
  if(bytes.length>maxDownload||await excelDigest(bytes)!==expected)throw Error('Google Drive verification failed.');
  return bytes;
}
async function driveSave(drive,bytes,name,mimeType,parent) {
  const boundary='wlf_'+crypto.randomUUID();
  const body=new Blob([
    '--'+boundary+'\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n'+JSON.stringify({name,mimeType,parents:[parent]})+'\r\n',
    '--'+boundary+'\r\nContent-Type: '+mimeType+'\r\n\r\n',bytes,'\r\n--'+boundary+'--\r\n'
  ]);
  const response=await drive('upload/drive/v3/files?uploadType=multipart&fields=id',{method:'POST',headers:{'Content-Type':'multipart/related; boundary='+boundary},body});
  const file=await response.json(),sha256=await excelDigest(bytes);
  await driveRead(drive,file.id,sha256);
  return {id:file.id,sha256};
}
async function archiveMaintenance({action,payload,usageSql,fullSql,drive,folderFor,project,Zip}) {
  if(action==='usageArchive') {
    const snapshot=await usageSql('prepare');
    if(!snapshot.count)return {archived:0,remaining:0};
    const sheet={name:'Activity log',headers:['When (Dhaka)','User','Activity','Details'],
      rows:snapshot.rows.map(r=>[dhaka(r.at),r.who,r.action,r.details])};
    const bytes=await buildWorkbook(Zip,[sheet]);
    if(bytes.length>8000000)throw Error('The activity log file is too large. Nothing was deleted.');
    const stamp=d=>String(d).slice(0,10);
    const name='WLF-Activity-Log-'+stamp(snapshot.from)+'_to_'+stamp(snapshot.to)+'-'+crypto.randomUUID().slice(0,8)+'.xlsx';
    const saved=await driveSave(drive,bytes,name,excelMime,await folderFor('activity'));
    const done=await usageSql('finish',{maxId:snapshot.maxId,count:snapshot.count,cutoff:snapshot.cutoff,fileId:saved.id,sha256:saved.sha256});
    return {archived:done.deleted,remaining:snapshot.remaining};
  }
  if(action==='fullBackup') {
    const snapshot=await fullSql('export');
    const archive={format:fullFormat,project,created_at:new Date().toISOString(),id:snapshot.id,counts:snapshot.counts,tables:snapshot.tables};
    const bytes=encoder.encode(JSON.stringify(archive));
    if(bytes.length>maxDownload)throw Error('The backup file is too large to send. Nothing was changed.');
    const name='WLF-Backup-'+new Date().toISOString().slice(0,10)+'-'+snapshot.id.slice(0,8)+'.json';
    const saved=await driveSave(drive,bytes,name,jsonMime,await folderFor('full'));
    await fullSql('record',{id:snapshot.id,fileId:saved.id,sha256:saved.sha256,bytes:bytes.length,counts:snapshot.counts});
    return {id:snapshot.id,name,bytes:base64(bytes),counts:snapshot.counts};
  }
  if(action==='fullDownload'||action==='fullRestore') {
    if(action==='fullRestore'&&payload.confirmed!==true)throw Error('Confirm the restore first.');
    let archiveBytes,name='WLF-Backup.json';
    if(action==='fullRestore'&&payload.archive) {
      if(payload.archive.project&&payload.archive.project!==project)throw Error('This backup belongs to another project.');
      return fullSql('restore',{archive:payload.archive});
    }
    const run=await fullSql('read',{id:payload.id});
    archiveBytes=await driveRead(drive,run.file_id,run.sha256);
    if(action==='fullDownload')return {id:run.id,name:'WLF-Backup-'+String(run.created_at).slice(0,10)+'-'+run.id.slice(0,8)+'.json',bytes:base64(archiveBytes),counts:run.counts};
    const archive=JSON.parse(new TextDecoder().decode(archiveBytes));
    if(archive.project&&archive.project!==project)throw Error('This backup belongs to another project.');
    return fullSql('restore',{archive});
  }
  throw Error('Unsupported backup action');
}

// ---- Monthly reports (from _shared/wlf-report.mjs)
/* WLF v2.7.0 \u00b7 Monthly reports: Technical Support, R&I Team Activity and Damage Demand.
   Pure functions: data from wlf_report_admin('data') in, a styled, print-ready .xlsx out. Used by the wlf-maintenance Edge Function. */

const reportMime = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';
const MAIN = 'http://schemas.openxmlformats.org/spreadsheetml/2006/main';
const OREL = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships';
const PREL = 'http://schemas.openxmlformats.org/package/2006/relationships';
const XML = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>';
const xmlText = v => String(v ?? '').replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\ufffe\uffff]/g, '')
  .replace(/[&<>"']/g, c => ({'&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&apos;'}[c]));
const col = i => { let s = ''; for (let n = i + 1; n; n = Math.floor((n - 1) / 26)) s = String.fromCharCode(65 + (n - 1) % 26) + s; return s; };

/* ------------------------------------------------------------------ styles
   cellXfs index: 0 plain \u00b7 1 title \u00b7 2 subtitle \u00b7 3 block heading \u00b7 4 table header
   text/int/pct/dec: 5/6/7/8 normal \u00b7 9/10/11/12 highlighted \u00b7 13/14/15/16 total row \u00b7 17 note */
const STYLES = XML + '<styleSheet xmlns="' + MAIN + '">' +
  '<numFmts count="2"><numFmt numFmtId="164" formatCode="0.0%"/><numFmt numFmtId="165" formatCode="#,##0.0"/></numFmts>' +
  '<fonts count="6"><font><sz val="10"/><name val="Calibri"/><family val="2"/></font>' +
  '<font><b/><sz val="16"/><color rgb="FF1F3864"/><name val="Calibri"/><family val="2"/></font>' +
  '<font><i/><sz val="10"/><color rgb="FF595959"/><name val="Calibri"/><family val="2"/></font>' +
  '<font><b/><sz val="12"/><color rgb="FF1F4E79"/><name val="Calibri"/><family val="2"/></font>' +
  '<font><b/><sz val="10"/><color rgb="FFFFFFFF"/><name val="Calibri"/><family val="2"/></font>' +
  '<font><b/><sz val="10"/><name val="Calibri"/><family val="2"/></font></fonts>' +
  '<fills count="5"><fill><patternFill patternType="none"/></fill><fill><patternFill patternType="gray125"/></fill>' +
  '<fill><patternFill patternType="solid"><fgColor rgb="FF1F4E79"/><bgColor indexed="64"/></patternFill></fill>' +
  '<fill><patternFill patternType="solid"><fgColor rgb="FFFFE699"/><bgColor indexed="64"/></patternFill></fill>' +
  '<fill><patternFill patternType="solid"><fgColor rgb="FFE7E6E6"/><bgColor indexed="64"/></patternFill></fill></fills>' +
  '<borders count="2"><border><left/><right/><top/><bottom/><diagonal/></border>' +
  '<border><left style="thin"><color rgb="FFA6A6A6"/></left><right style="thin"><color rgb="FFA6A6A6"/></right>' +
  '<top style="thin"><color rgb="FFA6A6A6"/></top><bottom style="thin"><color rgb="FFA6A6A6"/></bottom><diagonal/></border></borders>' +
  '<cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs><cellXfs count="19">' +
  '<xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/>' +
  '<xf numFmtId="0" fontId="1" fillId="0" borderId="0" xfId="0" applyFont="1"/>' +
  '<xf numFmtId="0" fontId="2" fillId="0" borderId="0" xfId="0" applyFont="1"/>' +
  '<xf numFmtId="0" fontId="3" fillId="0" borderId="0" xfId="0" applyFont="1"/>' +
  '<xf numFmtId="0" fontId="4" fillId="2" borderId="1" xfId="0" applyFont="1" applyFill="1" applyBorder="1" applyAlignment="1"><alignment vertical="center" wrapText="1"/></xf>' +
  [[0, 0], [3, 0], [164, 0], [165, 0], [0, 3], [3, 3], [164, 3], [165, 3], [0, 4], [3, 4], [164, 4], [165, 4]].map(([fmt, fill], i) =>
    '<xf numFmtId="' + fmt + '" fontId="' + (fill ? 5 : 0) + '" fillId="' + fill + '" borderId="1" xfId="0" applyNumberFormat="1" applyFont="1" applyFill="1" applyBorder="1" applyAlignment="1">' +
    '<alignment vertical="top"' + (i % 4 === 0 ? ' wrapText="1"' : '') + '/></xf>').join('') +
  '<xf numFmtId="0" fontId="2" fillId="0" borderId="0" xfId="0" applyFont="1"/>' +
  '<xf numFmtId="3" fontId="0" fillId="0" borderId="1" xfId="0" applyNumberFormat="1" applyBorder="1" applyAlignment="1"><alignment horizontal="left" vertical="top" wrapText="1"/></xf>' +
  '</cellXfs><cellStyles count="1"><cellStyle name="Normal" xfId="0" builtinId="0"/></cellStyles></styleSheet>';
const KIND = {text: 0, int: 1, pct: 2, dec: 3};
const styleOf = (type, mode) => type === 'value' ? 18 : 5 + (mode === 'hl' ? 4 : mode === 'total' ? 8 : 0) + (KIND[type] ?? 0);

/* sheet = {name, title, subtitle, blocks:[{heading, note, headers, types, rows:[{cells, mode}], empty}]} */
function sheetXml(sheet) {
  const rows = [], merges = [];
  let r = 0, width = 1;
  const widths = [];
  const measure = (i, v, header, cap = 58) => {
    const s = String(v ?? ''), longest = header ? Math.max(...s.split(' ').map(w => w.length), Math.ceil(s.length / 2)) : Math.max(...s.split('\n').map(x => x.length));
    widths[i] = Math.max(widths[i] || 0, Math.min(cap, longest));
  };
  const put = cells => { r += 1; rows.push('<row r="' + r + '">' + cells.map(([v, s], i) => cellXml(v, s, col(i) + r)).join('') + '</row>'); };
  for (const b of sheet.blocks) width = Math.max(width, b.headers ? b.headers.length : 2);
  put([[sheet.title, 1]]); merges.push('A1:' + col(Math.max(width, 4) - 1) + '1');
  put([[sheet.subtitle, 2]]); merges.push('A2:' + col(Math.max(width, 4) - 1) + '2');
  for (const b of sheet.blocks) {
    r += 1; rows.push('<row r="' + r + '"/>');
    put([[b.heading, 3]]);
    if (b.note) put([[b.note, 17]]);
    if (!b.rows.length) { put([[b.empty || 'No records in this month.', 17]]); continue; }
    put(b.headers.map(hd => [hd, 4]));
    b.headers.forEach((hd, i) => measure(i, hd, true));
    for (const row of b.rows) {
      put(row.cells.map((v, i) => [v, styleOf(b.types[i] || 'text', row.mode)]));
      row.cells.forEach((v, i) => measure(i, b.types[i] === 'pct' ? '100.0%' : typeof v === 'number' ? v.toLocaleString('en-US') : v, false, (b.widths || [])[i] || 58));
    }
  }
  const cols = widths.map((w, i) => '<col min="' + (i + 1) + '" max="' + (i + 1) + '" width="' + Math.max(10, Math.min(60, (w || 8) + 2)) + '" customWidth="1"/>').join('');
  return XML + '<worksheet xmlns="' + MAIN + '" xmlns:r="' + OREL + '"><sheetPr><pageSetUpPr fitToPage="1"/></sheetPr>' +
    '<dimension ref="A1:' + col(width - 1) + r + '"/><sheetViews><sheetView workbookViewId="0" showGridLines="0"/></sheetViews>' +
    '<sheetFormatPr defaultRowHeight="15"/>' + (cols ? '<cols>' + cols + '</cols>' : '') + '<sheetData>' + rows.join('') + '</sheetData>' +
    '<mergeCells count="' + merges.length + '">' + merges.map(m => '<mergeCell ref="' + m + '"/>').join('') + '</mergeCells>' +
    '<printOptions horizontalCentered="1"/><pageMargins left="0.4" right="0.4" top="0.5" bottom="0.6" header="0.3" footer="0.3"/>' +
    '<pageSetup paperSize="9" orientation="landscape" fitToWidth="1" fitToHeight="0"/>' +
    '<headerFooter><oddFooter>&amp;L' + xmlText(String(sheet.footer || '').replace(/&/g, '&&')) + '&amp;RPage &amp;P of &amp;N</oddFooter></headerFooter></worksheet>';
}
/* Text goes into one shared string table (xl/sharedStrings.xml), the standard Excel way.
   Google Sheets drops the spaces of inline strings, so inline text is not used. */
let REPORT_SST = null;
function reportSharedIndex(t) {
  let i = REPORT_SST.map.get(t);
  if (i === undefined) { i = REPORT_SST.list.length; REPORT_SST.list.push(t); REPORT_SST.map.set(t, i); }
  return i;
}
function cellXml(v, s, ref) {
  if (typeof v === 'number' && Number.isFinite(v)) return '<c r="' + ref + '" s="' + s + '"><v>' + v + '</v></c>';
  return '<c r="' + ref + '" s="' + s + '" t="s"><v>' + reportSharedIndex(String(v ?? '').slice(0, 32000)) + '</v></c>';
}
function reportSharedStringsXml() {
  return XML + '<sst xmlns="' + MAIN + '" count="' + REPORT_SST.list.length + '" uniqueCount="' + REPORT_SST.list.length + '">' +
    REPORT_SST.list.map(t => '<si><t xml:space="preserve">' + xmlText(t) + '</t></si>').join('') + '</sst>';
}
async function buildMonthlyWorkbook(Zip, sheets) {
  const zip = new Zip(), seen = new Set();
  const rel = (id, type, target) => '<Relationship Id="' + id + '" Type="' + OREL + '/' + type + '" Target="' + target + '"/>';
  const names = sheets.map((s, i) => {
    let base = String(s.name || 'Sheet ' + (i + 1)).replace(/[:\\/?*[\]]/g, ' ').trim().slice(0, 31) || 'Sheet ' + (i + 1), name = base, n = 1;
    while (seen.has(name.toLowerCase())) name = base.slice(0, 27) + ' (' + (++n) + ')';
    seen.add(name.toLowerCase());
    return name;
  });
  zip.file('_rels/.rels', XML + '<Relationships xmlns="' + PREL + '">' + rel('rId1', 'officeDocument', 'xl/workbook.xml') + '</Relationships>');
  zip.file('xl/workbook.xml', XML + '<workbook xmlns="' + MAIN + '" xmlns:r="' + OREL + '"><bookViews><workbookView/></bookViews><sheets>' +
    names.map((n, i) => '<sheet name="' + xmlText(n) + '" sheetId="' + (i + 1) + '" r:id="rId' + (i + 1) + '"/>').join('') + '</sheets>' +
    '<definedNames>' + names.map((n, i) => '<definedName name="_xlnm.Print_Titles" localSheetId="' + i + '">\'' + xmlText(n.replace(/'/g, "''")) + '\'!$1:$2</definedName>').join('') + '</definedNames></workbook>');
  zip.file('xl/_rels/workbook.xml.rels', XML + '<Relationships xmlns="' + PREL + '">' + names.map((_, i) => rel('rId' + (i + 1), 'worksheet', 'worksheets/sheet' + (i + 1) + '.xml')).join('') +
    rel('rId' + (names.length + 1), 'styles', 'styles.xml') + rel('rId' + (names.length + 2), 'sharedStrings', 'sharedStrings.xml') + '</Relationships>');
  zip.file('xl/styles.xml', STYLES);
  REPORT_SST = {list: [], map: new Map()};
  try { sheets.forEach((s, i) => zip.file('xl/worksheets/sheet' + (i + 1) + '.xml', sheetXml(s))); zip.file('xl/sharedStrings.xml', reportSharedStringsXml()); } finally { REPORT_SST = null; }
  zip.file('[Content_Types].xml', XML + '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">' +
    '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/>' +
    '<Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>' +
    '<Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/>' +
    '<Override PartName="/xl/sharedStrings.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sharedStrings+xml"/>' +
    names.map((_, i) => '<Override PartName="/xl/worksheets/sheet' + (i + 1) + '.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>').join('') + '</Types>');
  return zip.generateAsync({type: 'uint8array', compression: 'DEFLATE', compressionOptions: {level: 6}});
}

/* ------------------------------------------------------------------ helpers */
const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
const monthName = m => MONTHS[Number(m.slice(5, 7)) - 1] + ' ' + m.slice(0, 4);
const dhakaTime = iso => { if (!iso) return ''; const d = new Date(new Date(iso).getTime() + 6 * 3600e3); return String(d.getUTCDate()).padStart(2, '0') + ' ' + MONTHS[d.getUTCMonth()].slice(0, 3) + ' ' + d.getUTCFullYear() + ' ' + String(d.getUTCHours()).padStart(2, '0') + ':' + String(d.getUTCMinutes()).padStart(2, '0'); };
const share = (n, total) => total ? n / total : 0;
const clean = v => (Array.isArray(v) ? v.map(clean).filter(Boolean).join(', ') : String(v ?? '').replace(/\s+/g, ' ').trim());
const fieldsOf = schema => Array.isArray(schema) ? schema : Array.isArray(schema?.fields) ? schema.fields : [];
function countBy(list, key, weight) {
  const m = new Map();
  for (const x of list) for (const k of [].concat(key(x))) { if (!k) continue; const e = m.get(k) || {key: k, n: 0, w: 0, items: []}; e.n += 1; e.w += weight ? weight(x) : 1; e.items.push(x); m.set(k, e); }
  return [...m.values()].sort((a, b) => (weight ? b.w - a.w : 0) || b.n - a.n || String(a.key).localeCompare(String(b.key)));
}
/* highlight the first row only when it is a real, single top value */
const top = (rows, value) => rows.map((r, i) => ({...r, mode: i === 0 && rows.length && value(rows[0]) > 0 && (rows.length === 1 || value(rows[1]) < value(rows[0])) ? 'hl' : r.mode}));
const block = (heading, headers, types, rows, extra = {}) => ({heading, headers, types, rows, ...extra});
const pctText = p => (p * 100).toFixed(1) + '%';
const header = (kind, month, generated) => ({footer: 'WLF Electrical Solution \u00b7 ' + kind + ' \u00b7 ' + monthName(month) + ' \u00b7 Generated ' + generated});

/* ------------------------------------------------------------------ Technical Support */
const sectionName = name => String(name || '').replace(/ Team$/, '');
function supportFacts(r) {
  const fields = fieldsOf(r.schema), values = r.values || {};
  const pick = test => { const f = fields.find(test); return f ? clean(values[f.id]) : ''; };
  const errorFields = fields.filter(f => /error/i.test(f.label || f.id || '') && !/category/i.test(f.label || ''));
  const errors = errorFields.flatMap(f => clean(values[f.id]).split(/\s*[,;]\s*/)).map(x => x.trim()).filter(x => x && !/^(none|n\/?a|-)$/i.test(x));
  return {
    problem: pick(f => f.id === 'problem_category' || /problem\s*category/i.test(f.label || '')) || 'Not given',
    lift: pick(f => f.id === 'lift' || /lift\s*id/i.test(f.label || '')),
    project: pick(f => f.id === 'project' || /^project/i.test(f.label || '')),
    details: pick(f => f.id === 'problem' || /^(problem|problem details|description)$/i.test(f.label || '')),
    errors: [...new Set(errors)]
  };
}
const isOpen = s => !['Solved', 'Not Solved'].includes(s);
function supportBlocks(list, totalAll, scopeLabel) {
  const total = list.length, solved = list.filter(r => r.status === 'Solved'), notSolved = list.filter(r => r.status === 'Not Solved').length;
  const hours = solved.filter(r => r.solvedAt).map(r => (new Date(r.solvedAt) - new Date(r.at)) / 3600e3).filter(x => x >= 0);
  const problems = countBy(list, r => r.f.problem), errors = countBy(list, r => r.f.errors);
  const repeat = countBy(list.filter(r => r.f.lift), r => r.f.lift + '\u0000' + r.f.problem).filter(e => e.n > 1);
  const people = countBy(list, r => r.requester || 'Unknown');
  const blocks = [];
  blocks.push({heading: 'Overview', headers: ['Item', 'Value'], types: ['text', 'value'], rows: [
    ['Support requests', total], ...(totalAll != null ? [['Share of all support requests', pctText(share(total, totalAll))]] : []),
    ['Solved', solved.length], ['Not solved', notSolved], ['Still open (pending, received or forwarded)', total - solved.length - notSolved],
    ['Solve rate', pctText(share(solved.length, total))], ['Forwarded at least once', list.filter(r => r.forwards > 0).length],
    ['Average time to solve', hours.length ? (hours.reduce((a, b) => a + b, 0) / hours.length).toFixed(1) + ' hours' : '\u2014'],
    ['Most frequent problem', problems.length ? problems[0].key + ' (' + problems[0].n + ', ' + pctText(share(problems[0].n, total)) + ')' : '\u2014']
  ].map(c => ({cells: c}))});
  blocks.push(block('Problems ' + scopeLabel + ' \u00b7 most frequent first', ['Problem category', 'Requests', 'Share', 'Solved', 'Still open'], ['text', 'int', 'pct', 'int', 'int'],
    top(problems.map(e => ({cells: [e.key, e.n, share(e.n, total), e.items.filter(r => r.status === 'Solved').length, e.items.filter(r => isOpen(r.status)).length]})), r => r.cells[1]),
    {note: 'Highlighted: the problem that came most often (the repeat problem of the month).'}));
  blocks.push(block('Error codes reported', ['Error code', 'Times', 'Share of requests'], ['text', 'int', 'pct'],
    top(errors.slice(0, 25).map(e => ({cells: [e.key, e.n, share(e.n, total)]})), r => r.cells[1]), {empty: 'No error codes were entered this month.'}));
  blocks.push(block('Same problem on the same lift (2 or more times this month)', ['Lift ID', 'Project', 'Section', 'Problem category', 'Times', 'References'],
    ['text', 'text', 'text', 'text', 'int', 'text'],
    repeat.map(e => ({cells: [e.items[0].f.lift, e.items[0].f.project, [...new Set(e.items.map(r => r.section))].join(', '), e.items[0].f.problem, e.n, e.items.map(r => r.reference).join(', ')], mode: 'hl'})),
    {empty: 'No lift had the same problem twice this month.'}));
  blocks.push(block('Support needed by requester', ['Requester', 'Section', 'Requests', 'Share'], ['text', 'text', 'int', 'pct'],
    top(people.slice(0, 25).map(e => ({cells: [e.key, [...new Set(e.items.map(r => r.section))].join(', '), e.n, share(e.n, total)]})), r => r.cells[2])));
  return blocks;
}
function supportReport(data, generated) {
  const teams = new Map((data.teams || []).map(t => [t.id, sectionName(t.name)]));
  const list = (data.records || []).map(r => ({...r, section: teams.get(r.team) || r.team, f: supportFacts(r)}));
  const total = list.length, month = data.month, info = header('Technical Support Monthly Report', month, generated);
  const sub = 'Month: ' + monthName(month) + ' (Bangladesh time) \u00b7 Generated ' + generated + ' \u00b7 Section = the section of the person who sent the request';
  const bySection = [...teams.entries()].map(([id, name]) => { const xs = list.filter(r => r.team === id); return {name, xs}; }).sort((a, b) => b.xs.length - a.xs.length);
  const summary = {name: 'Summary', title: 'Technical Support Monthly Report \u00b7 ' + monthName(month), subtitle: sub, ...info, blocks: []};
  const sectionBlock = block('Support by section', ['Section', 'Requests', 'Share', 'Solved', 'Not solved', 'Still open'], ['text', 'int', 'pct', 'int', 'int', 'int'],
    [...top(bySection.map(s => ({cells: [s.name, s.xs.length, share(s.xs.length, total), s.xs.filter(r => r.status === 'Solved').length, s.xs.filter(r => r.status === 'Not Solved').length, s.xs.filter(r => isOpen(r.status)).length]})), r => r.cells[1]),
      {cells: ['Total', total, total ? 1 : 0, list.filter(r => r.status === 'Solved').length, list.filter(r => r.status === 'Not Solved').length, list.filter(r => isOpen(r.status)).length], mode: 'total'}],
    {note: 'Highlighted: the section that needed the most support.'});
  const all = supportBlocks(list, null, 'in all sections');
  summary.blocks.push(all[0], sectionBlock, ...all.slice(1));
  const given = (data.given || []).slice().sort((a, b) => b.solved - a.solved || b.received - a.received);
  summary.blocks.push(block('Support given by R&I members', ['R&I member', 'Received', 'Solved', 'Not solved', 'Forwarded'], ['text', 'int', 'int', 'int', 'int'],
    top(given.map(g => ({cells: [g.name, g.received, g.solved, g.notSolved, g.forwarded]})), r => r.cells[2]), {note: 'Counted from the actions taken in this month.'}));
  const sheets = [summary];
  for (const [id, name] of teams) sheets.push({name, title: 'Technical Support \u00b7 ' + name + ' \u00b7 ' + monthName(month), subtitle: sub, ...info,
    blocks: supportBlocks(list.filter(r => r.team === id), total, 'in ' + name)});
  const order = [...teams.keys()];
  sheets.push({name: 'All requests', title: 'Technical Support \u00b7 All requests \u00b7 ' + monthName(month), subtitle: sub, ...info, blocks: [
    block('All support requests of the month, by section', ['Section', 'Reference', 'Date (Dhaka)', 'Requester', 'Lift ID', 'Project', 'Problem category', 'Error code', 'Problem', 'Status', 'Solved by', 'Solution'],
      ['text', 'text', 'text', 'text', 'text', 'text', 'text', 'text', 'text', 'text', 'text', 'text'],
      list.slice().sort((a, b) => order.indexOf(a.team) - order.indexOf(b.team) || String(a.at).localeCompare(String(b.at)))
        .map(r => ({cells: [r.section, r.reference, dhakaTime(r.at), r.requester, r.f.lift, r.f.project, r.f.problem, r.f.errors.join(', '), r.f.details, r.status, r.solver, clean(r.solution)]})),
      {widths: [14, 12, 17, 20, 9, 18, 18, 12, 40, 10, 18, 34]})]});
  return {sheets, records: total};
}

/* ------------------------------------------------------------------ R&I Team Activity */
const SECTORS = [['team', 'Team R&I Activity'], ['scm', 'Supplier & SCM Communication'], ['reports', 'Reports'], ['sales', 'Sales Support']];
const stateOf = s => /^(completed|solved|done)$/i.test(s || '') ? 'done' : /^(ongoing|in progress)$/i.test(s || '') ? 'ongoing' : 'other';
const hoursOf = xs => Math.round(xs.reduce((a, e) => a + Number(e.minutes || 0), 0) / 6) / 10;
function details(e) {
  const v = e.values || {};
  return fieldsOf(e.schema).filter(f => !/^(status|duration|duration_min|duration_minute)$/.test(f.id) && clean(v[f.id]))
    .map(f => (f.label || f.id) + ': ' + clean(v[f.id])).join(' \u00b7 ');
}
function activityCounts(xs) { return [xs.length, xs.filter(e => stateOf(e.status) === 'done').length, xs.filter(e => stateOf(e.status) === 'ongoing').length, xs.filter(e => stateOf(e.status) === 'other').length, hoursOf(xs)]; }
function activityReport(data, generated) {
  const list = data.records || [], total = list.length, month = data.month, info = header('R&I Team Activity Monthly Report', month, generated);
  const sub = 'Month: ' + monthName(month) + ' (Bangladesh time) \u00b7 Generated ' + generated;
  const H = ['Entries', 'Share', 'Completed', 'Ongoing', 'Other status', 'Time (hours)'], T = ['int', 'pct', 'int', 'int', 'int', 'dec'];
  const row = (name, xs, base) => { const c = activityCounts(xs); return {cells: [name, c[0], share(c[0], base), c[1], c[2], c[3], c[4]]}; };
  const sectors = SECTORS.map(([k, name]) => ({k, name, xs: list.filter(e => e.sector === k)}));
  const members = countBy(list, e => e.member || 'Unknown');
  const summary = {name: 'Summary', title: 'R&I Team Activity Monthly Report \u00b7 ' + monthName(month), subtitle: sub, ...info, blocks: [
    {heading: 'Overview', headers: ['Item', 'Value'], types: ['text', 'value'], rows: [
      ['Activity entries', total], ['Completed', activityCounts(list)[1]], ['Ongoing', activityCounts(list)[2]], ['Other status', activityCounts(list)[3]],
      ['Time invested', hoursOf(list) + ' hours'], ['R&I members with entries', members.length],
      ['Busiest sector', total ? sectors.slice().sort((a, b) => b.xs.length - a.xs.length)[0].name : '\u2014']].map(c => ({cells: c}))},
    block('Activity by sector', ['Sector', ...H], ['text', ...T], [...top(sectors.slice().sort((a, b) => b.xs.length - a.xs.length).map(s => row(s.name, s.xs, total)), r => r.cells[1]),
      {...row('Total', list, total), mode: 'total'}]),
    block('Activity by R&I member', ['R&I member', ...SECTORS.map(s => s[1]), 'Total', 'Share', 'Time (hours)'], ['text', 'int', 'int', 'int', 'int', 'int', 'pct', 'dec'],
      top(members.map(m => ({cells: [m.key, ...SECTORS.map(([k]) => m.items.filter(e => e.sector === k).length), m.n, share(m.n, total), hoursOf(m.items)]})), r => r.cells[5]),
      {note: 'Highlighted: the member with the most entries this month.'}),
    block('Most used forms', ['Form', 'Sector', 'Entries', 'Share'], ['text', 'text', 'int', 'pct'],
      top(countBy(list, e => e.form).slice(0, 20).map(f => ({cells: [f.key, (SECTORS.find(s => s[0] === f.items[0].sector) || [, ''])[1], f.n, share(f.n, total)]})), r => r.cells[2]))]};
  const sheets = [summary];
  for (const s of sectors) {
    const n = s.xs.length;
    sheets.push({name: s.name, title: 'R&I Team Activity \u00b7 ' + s.name + ' \u00b7 ' + monthName(month), subtitle: sub, ...info, blocks: [
      {heading: 'Overview', headers: ['Item', 'Value'], types: ['text', 'value'], rows: [['Entries', n], ['Share of all R&I entries', pctText(share(n, total))],
        ['Completed', activityCounts(s.xs)[1]], ['Ongoing', activityCounts(s.xs)[2]], ['Other status', activityCounts(s.xs)[3]], ['Time invested', hoursOf(s.xs) + ' hours']].map(c => ({cells: c}))},
      block('By form', ['Form', ...H], ['text', ...T], top(countBy(s.xs, e => e.form).map(f => row(f.key, f.items, n)), r => r.cells[1])),
      block('By R&I member', ['R&I member', ...H], ['text', ...T], top(countBy(s.xs, e => e.member || 'Unknown').map(m => row(m.key, m.items, n)), r => r.cells[1]))]});
  }
  const order = SECTORS.map(x => x[0]);
  sheets.push({name: 'All entries', title: 'R&I Team Activity \u00b7 All entries \u00b7 ' + monthName(month), subtitle: sub, ...info, blocks: [
    block('All activity entries of the month, by sector', ['Sector', 'Date (Dhaka)', 'R&I member', 'Form', 'Status', 'Time (min)', 'Details'], ['text', 'text', 'text', 'text', 'text', 'dec', 'text'],
      list.slice().sort((a, b) => order.indexOf(a.sector) - order.indexOf(b.sector) || String(a.at).localeCompare(String(b.at)))
        .map(e => ({cells: [(SECTORS.find(x => x[0] === e.sector) || [, e.sector])[1], dhakaTime(e.at), e.member, e.form, e.status, Number(e.minutes || 0), details(e)]})),
      {widths: [22, 17, 20, 22, 12, 10, 60]})]});
  return {sheets, records: total};
}

/* ------------------------------------------------------------------ Damage Demand */
const qty = d => Number(d.quantity || 0);
const componentKey = d => [d.item, d.model].filter(Boolean).join('\u0000');
function damageBlocks(list, units, scope) {
  const n = list.length, u = list.reduce((a, d) => a + qty(d), 0);
  const problems = countBy(list, d => (d.problems || []).length ? d.problems : ['Not given']);
  const parts = countBy(list, componentKey, qty), users = countBy(list, d => d.requester || 'Unknown', qty);
  return [
    {heading: 'Overview', headers: ['Item', 'Value'], types: ['text', 'value'], rows: [
      ['Damage demands', n], ['Units (total quantity)', u], ...(units != null ? [['Share of all damaged units', pctText(share(u, units))]] : []),
      ['Received from stock', list.filter(d => d.received).length], ['Waiting', list.filter(d => !d.received).length], ['Sent to supplier (claim)', list.filter(d => d.claimed).length],
      ['Most frequent problem', problems.length ? problems[0].key + ' (' + problems[0].n + ', ' + pctText(share(problems[0].n, n)) + ')' : '\u2014'],
      ['Component failing most', parts.length ? parts[0].items[0].item + (parts[0].items[0].model ? ' \u00b7 ' + parts[0].items[0].model : '') + ' (' + parts[0].w + ' units)' : '\u2014']].map(c => ({cells: c}))},
    block('Problems ' + scope + ' \u00b7 most frequent first', ['Problem category', 'Demands', 'Share', 'Units'], ['text', 'int', 'pct', 'int'],
      top(problems.map(e => ({cells: [e.key, e.n, share(e.n, n), e.items.reduce((a, d) => a + qty(d), 0)]})), r => r.cells[1])),
    block('Components failing most', ['Component', 'Model', 'Brand', 'Units', 'Demands', 'Share of units'], ['text', 'text', 'text', 'int', 'int', 'pct'],
      top(parts.slice(0, 25).map(e => ({cells: [e.items[0].item, e.items[0].model, [...new Set(e.items.map(d => d.brand).filter(Boolean))].join(', '), e.w, e.n, share(e.w, u)]})), r => r.cells[3]),
      {note: 'Highlighted: the component with the most damaged units.'}),
    block('Damage by user (requester)', ['User', 'Section', 'Demands', 'Units', 'Share of units'], ['text', 'text', 'int', 'int', 'pct'],
      top(users.slice(0, 25).map(e => ({cells: [e.key, [...new Set(e.items.map(d => d.section))].join(', '), e.n, e.w, share(e.w, u)]})), r => r.cells[3]),
      {note: 'Highlighted: the user under whom the most units were damaged.'})
  ];
}
function damageReport(data, generated) {
  const teams = new Map((data.teams || []).map(t => [t.id, sectionName(t.name)]));
  const list = (data.records || []).map(d => ({...d, section: teams.get(d.team) || d.team}));
  const month = data.month, info = header('Damage Demand Monthly Report', month, generated), units = list.reduce((a, d) => a + qty(d), 0);
  const sub = 'Month: ' + monthName(month) + ' (Bangladesh time) \u00b7 Generated ' + generated;
  const sections = [...teams.entries()].map(([id, name]) => ({name, xs: list.filter(d => d.team === id)})).sort((a, b) => b.xs.reduce((s, d) => s + qty(d), 0) - a.xs.reduce((s, d) => s + qty(d), 0));
  const blocks = damageBlocks(list, null, 'in all sections');
  const secRows = sections.map(s => { const u = s.xs.reduce((a, d) => a + qty(d), 0); return {cells: [s.name, s.xs.length, u, share(u, units)]}; });
  blocks.splice(1, 0, block('Damage by section', ['Section', 'Demands', 'Units', 'Share of units'], ['text', 'int', 'int', 'pct'],
    [...top(secRows, r => r.cells[2]), {cells: ['Total', list.length, units, units ? 1 : 0], mode: 'total'}], {note: 'Highlighted: the section with the most damaged units.'}));
  blocks.push(block('Damage by controller', ['Controller', 'Demands', 'Units'], ['text', 'int', 'int'],
    top(countBy(list, d => (d.controllers || []).length ? d.controllers : ['Not given'], qty).map(e => ({cells: [e.key, e.n, e.w]})), r => r.cells[2])));
  const sheets = [{name: 'Summary', title: 'Damage Demand Monthly Report \u00b7 ' + monthName(month), subtitle: sub, ...info, blocks}];
  for (const [id, name] of teams) sheets.push({name, title: 'Damage Demand \u00b7 ' + name + ' \u00b7 ' + monthName(month), subtitle: sub, ...info,
    blocks: damageBlocks(list.filter(d => d.team === id), units, 'in ' + name)});
  const order = [...teams.keys()];
  sheets.push({name: 'All demands', title: 'Damage Demand \u00b7 All demands \u00b7 ' + monthName(month), subtitle: sub, ...info, blocks: [
    block('All damage demands of the month, by section', ['Section', 'Reference', 'Date (Dhaka)', 'Requester', 'Project', 'Lift ID', 'Controller', 'Problem', 'Component', 'Model', 'Brand', 'Qty', 'Confirmed by', 'Status'],
      ['text', 'text', 'text', 'text', 'text', 'text', 'text', 'text', 'text', 'text', 'text', 'int', 'text', 'text'],
      list.slice().sort((a, b) => order.indexOf(a.team) - order.indexOf(b.team) || String(a.at).localeCompare(String(b.at)))
        .map(d => ({cells: [d.section, d.reference, dhakaTime(d.at), d.requester, d.project, d.liftId, clean(d.controllers), clean(d.problems), d.item, d.model, d.brand, qty(d), d.confirmedBy,
          d.claimed ? 'Sent to supplier' : d.received ? 'Received' : 'Waiting']})),
      {widths: [16, 10, 17, 20, 18, 9, 12, 22, 22, 16, 12, 6, 18, 14]})]});
  return {sheets, records: list.length};
}

/* ------------------------------------------------------------------ Edge Function part */
const REPORTS = {
  support: {title: 'Technical Support Monthly Report', folder: 'reportSupport', build: supportReport},
  activity: {title: 'R&I Team Activity Monthly Report', folder: 'reportActivity', build: activityReport},
  damage: {title: 'Damage Demand Monthly Report', folder: 'reportDamage', build: damageReport}
};
const reportFileName = (kind, month) => REPORTS[kind].title + ' ' + month + '.xlsx';
const nowDhaka = () => dhakaTime(new Date().toISOString());
async function sha(bytes) { return Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', bytes)), n => n.toString(16).padStart(2, '0')).join(''); }

const BACKUP_KINDS = ['support', 'activity', 'project', 'qms', 'damage', 'claim'];
function monthBounds(m) {
  if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(String(m || ''))) throw Error('Choose a month (YYYY-MM).');
  const [y, mo] = m.split('-').map(Number), last = new Date(Date.UTC(y, mo, 0)).getUTCDate();
  return {from: m + '-01', to: m + '-' + String(last).padStart(2, '0')};
}
async function makeReport(kind, data, Zip, generated = nowDhaka()) {
  if (!REPORTS[kind]) throw Error('Unknown report');
  const {sheets, records} = REPORTS[kind].build(data, generated);
  return {bytes: await buildMonthlyWorkbook(Zip, sheets), records};
}

/* sql(action,payload) = wlf_report_admin; drive(path,init) = Google Drive call; folderFor(name) = folder id */
async function reportMaintenance({action, payload = {}, sql, drive, folderFor, Zip, selfUrl, backup}) {
  if (action === 'reportStatus') return sql('status');
  if (action === 'reportHistory') return sql('history');
  if (action === 'reportDeleteHistory') return sql('deleteHistory', {id: payload.id});
  if (action === 'reportSchedule') return sql('schedule', {...(typeof payload.enable === 'boolean' ? {enable: payload.enable} : {}), ...(typeof payload.backup === 'boolean' ? {backup: payload.backup} : {}), url: selfUrl});
  if (action === 'backupHistory') return sql('backupHistory');
  if (action === 'backupDeleteHistory') return sql('backupDeleteHistory', {id: payload.id});
  async function one(kind, month) {
    const data = await sql('data', {kind, month});
    const {bytes, records} = await makeReport(kind, data, Zip);
    const name = reportFileName(kind, month), parent = await folderFor(REPORTS[kind].folder), boundary = 'wlf_' + crypto.randomUUID();
    const body = new Blob(['--' + boundary + '\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n' + JSON.stringify({name, mimeType: reportMime, parents: [parent], appProperties: {wlfReport: kind + ':' + month}}) + '\r\n',
      '--' + boundary + '\r\nContent-Type: ' + reportMime + '\r\n\r\n', bytes, '\r\n--' + boundary + '--\r\n']);
    const file = await (await drive('upload/drive/v3/files?uploadType=multipart&fields=id', {method: 'POST', headers: {'Content-Type': 'multipart/related; boundary=' + boundary}, body})).json();
    if (!/^[-a-zA-Z0-9_]{5,200}$/.test(file.id || '')) throw Error('Drive did not return a report file ID.');
    const hash = await sha(bytes), saved = new Uint8Array(await (await drive('drive/v3/files/' + encodeURIComponent(file.id) + '?alt=media')).arrayBuffer());
    if (await sha(saved) !== hash) throw Error('The report saved in Google Drive failed verification.');
    await sql('saved', {kind, month, fileId: file.id, fileName: name, sha256: hash, records});
    /* a report made again for the same month replaces the old file: the old one goes to the Drive bin */
    if (data.existing?.fileId && data.existing.fileId !== file.id) {
      try { await drive('drive/v3/files/' + encodeURIComponent(data.existing.fileId), {method: 'PATCH', headers: {'Content-Type': 'application/json'}, body: JSON.stringify({trashed: true})}); } catch (_) { /* already removed by hand */ }
    }
    return {kind, month, fileId: file.id, fileName: name, records};
  }
  if (action === 'reportGenerate') {
    const kinds = [...new Set(payload.kinds || [])].filter(k => REPORTS[k]);
    if (!kinds.length) throw Error('Choose at least one report.');
    const made = [];
    for (const k of kinds) made.push(await one(k, payload.month));
    return {made};
  }
  if (action === 'backupGenerate') {
    /* Super Admin: make the monthly Excel backup of a chosen month now (never clears) */
    const kinds = [...new Set(payload.kinds || [])].filter(k => BACKUP_KINDS.includes(k));
    if (!kinds.length) throw Error('Choose at least one backup.');
    const {from, to} = monthBounds(payload.month), made = [];
    for (const k of kinds) made.push(await backup(k, payload.month, from, to));
    return {made};
  }
  if (action === 'monthlyReports') {
    const made = [];
    try {
      const pending = await sql('pending');
      /* a few files per call (Edge Function time limit); the schedule calls again every hour from 02:00 to 05:00 */
      let budget = 3;
      for (const k of pending.kinds) { if (budget-- <= 0) break; made.push(await one(k, pending.month)); }
      for (const k of pending.backups || []) { if (budget-- <= 0) break; made.push(await backup(k, pending.month, pending.from, pending.to)); }
      await sql('checked', {});
    } catch (err) {
      try { await sql('checked', {error: err.message}); } catch (_) { /* nothing more to record */ }
      throw err;
    }
    return {made};
  }
  throw Error('Unsupported report action');
}

// ---- Request handler
const headers={'Access-Control-Allow-Origin':'*','Access-Control-Allow-Headers':'authorization,x-client-info,apikey,content-type,x-wlf-cron','Access-Control-Allow-Methods':'POST,OPTIONS','Content-Type':'application/json','Cache-Control':'no-store'};
const EDGE_VERSION='2.7.3';   // shown on the System status card; must match the app
const digest=async(text:string)=>Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',new TextEncoder().encode(text)))).map(x=>x.toString(16).padStart(2,'0')).join('');
Deno.serve(async(req)=>{
 if(req.method==='OPTIONS')return new Response('ok',{headers});
 let status=400;
 try{
 if(req.method!=='POST')throw Error('POST required');
 const url=Deno.env.get('SUPABASE_URL')!,keys=JSON.parse(Deno.env.get('SUPABASE_SECRET_KEYS')||'{}'),key=keys.default||Deno.env.get('SUPABASE_SERVICE_ROLE_KEY');
 if(!url||!key)throw Error('Server configuration missing');
 const admin=createClient(url,key,{auth:{persistSession:false,autoRefreshToken:false}});
 // v2.7.0: the monthly schedule (pg_cron + pg_net) calls with its own token instead of a signed-in Super Admin
 const cronToken=req.headers.get('x-wlf-cron')||'';
 let auth:any={user:{id:null}};
 if(cronToken){
  if(!/^[a-f0-9]{48}$/.test(cronToken)){status=401;throw Error('Schedule token rejected');}
 }else{
 const token=(req.headers.get('Authorization')||'').replace(/^Bearer\s+/i,'');
 const r=await admin.auth.getUser(token);if(r.error||!r.data.user){status=401;throw Error('Sign in required');}
 auth=r.data;
 const {data:me,error:meError}=await admin.from('wlf_profiles').select('id,role,status').eq('id',auth.user.id).single();
 if(meError||me?.role!=='Super Admin'||me?.status!=='Approved'){status=403;throw Error('Super Admin only');}
 }
 if(Number(req.headers.get('content-length')||0)>12000000)throw Error('Request too large');
 const body=await req.json(),action=body.action,p=body.payload||{};
 if(cronToken&&action!=='monthlyReports'){status=403;throw Error('Not allowed for the schedule');}
 async function reportSql(a:string,x:any={}){const r=await admin.rpc('wlf_report_admin',{action:a,actor:auth.user.id,payload:cronToken?{...x,token:cronToken}:x});if(r.error)throw Error(r.error.message);return r.data;}
 const selfUrl=url.replace(/\/$/,'')+'/functions/v1/wlf-maintenance';
 const project=new URL(url).hostname.split('.')[0];
 async function sql(action:string,payload:any={}){const r=await admin.rpc('wlf_backup_admin',{action,actor:auth.user.id,payload});if(r.error)throw Error(r.error.message);return r.data;}
async function usageSql(action:string,payload:any={}){const r=await admin.rpc('wlf_usage_admin',{action,actor:auth.user.id,payload});if(r.error)throw Error(r.error.message);return r.data;}
 async function fullSql(action:string,payload:any={}){const r=await admin.rpc('wlf_full_admin',{action,actor:auth.user.id,payload});if(r.error)throw Error(r.error.message);return r.data;}
 async function excelSql(action:string,payload:any={}){const r=await admin.rpc('wlf_excel_admin',{action,actor:auth.user.id,payload});if(r.error)throw Error(r.error.message);return r.data;}
 const clientId=Deno.env.get('WLF_GOOGLE_CLIENT_ID'),clientSecret=Deno.env.get('WLF_GOOGLE_CLIENT_SECRET'),refreshToken=Deno.env.get('WLF_GOOGLE_REFRESH_TOKEN');
 const configured=!!(clientId&&clientSecret&&refreshToken);
 if(action==='version')return new Response(JSON.stringify({edge:EDGE_VERSION,driveConfigured:configured}),{headers});
 if(action==='status')return new Response(JSON.stringify({...await sql('status'),driveConfigured:configured}),{headers});
 if(['reportStatus','reportHistory','reportDeleteHistory','reportSchedule','backupHistory','backupDeleteHistory'].includes(action))
  {const out=await reportMaintenance({action,payload:p,sql:reportSql,selfUrl});return new Response(JSON.stringify(action==='reportStatus'?{...out,driveConfigured:configured}:out),{headers});}
 const reportAction=['reportGenerate','monthlyReports','backupGenerate'].includes(action);
 if(cronToken&&!configured){await reportSql('checked',{error:'Google Drive is not set up'});throw Error('Google Drive setup required');}
 if(action==='deleteRejectedUser'){
 const target=await sql('reserveDeleteUser',{email:p.email});try{const {error}=await admin.auth.admin.deleteUser(target.id);if(error)throw error;}finally{await sql('releaseDeleteUser',{id:target.id});}
 return new Response(JSON.stringify({deleted:true}),{headers});
 }
 if(action==='usageHistory')return new Response(JSON.stringify(await usageSql('history')),{headers});
 if(action==='fullHistory')return new Response(JSON.stringify(await fullSql('history')),{headers});
 if(action==='fullDeleteHistory')return new Response(JSON.stringify(await fullSql('deleteHistory',p.all?{all:true,confirm:p.confirm}:{id:p.id})),{headers});
 if(action==='excelHistory')return new Response(JSON.stringify(await excelSql('history')),{headers});
 if(action==='deleteBackupHistory')return new Response(JSON.stringify(await sql('deleteBackupHistory',p.all?{all:true,confirm:p.confirm}:{id:p.id})),{headers});
 if(action==='excelDeleteHistory')return new Response(JSON.stringify(await excelSql('deleteHistory',p.all?{all:true,confirm:p.confirm}:{id:p.id})),{headers});
 const excelAction=['excelBackup','excelDownload','excelClear','excelRestore'].includes(action);
 const archiveAction=['usageArchive','fullBackup','fullDownload','fullRestore'].includes(action);
 if(action==='start')return new Response(JSON.stringify(await sql('start',p)),{headers});
 if(action==='restore'){
 if(JSON.stringify(p.archive||{}).length>10000000)throw Error('Archive part too large');
 return new Response(JSON.stringify(await sql('restore',{archive:p.archive,project})),{headers});}
 if(action==='files')return new Response(JSON.stringify(await sql('files',p)),{headers});
 if(action==='abandon')return new Response(JSON.stringify(await sql('abandon',p)),{headers});
 if(!excelAction&&!archiveAction&&!reportAction&&!['backupPart','downloadPart','clearPart'].includes(action))throw Error('Unsupported action');
 if(!configured)throw Error('Google Drive setup required. Read GOOGLE_DRIVE_SETUP_BN.html in the update package.');
 const tr=await fetch('https://oauth2.googleapis.com/token',{method:'POST',headers:{'Content-Type':'application/x-www-form-urlencoded'},body:new URLSearchParams({client_id:clientId!,client_secret:clientSecret!,refresh_token:refreshToken!,grant_type:'refresh_token'})});
 const t=await tr.json();if(!tr.ok||!t.access_token)throw Error('Google Drive authorization expired or invalid. Reconnect using the setup guide.');
 async function drive(path:string,init:any={}){const r=await fetch('https://www.googleapis.com/'+path,{...init,headers:{Authorization:'Bearer '+t.access_token,...(init.headers||{})}});if(!r.ok)throw Error('Google Drive request failed ('+r.status+'). Nothing was cleared.');return r;}
 /* v2.7.2: monthly files live in one main folder each: "Monthly Analysis Report" (3 report folders) and
    "Monthly Excel Backup" (one folder per category). Folders are found by a hidden mark, not by name; an old
    report folder from v2.7.0 is moved into the main folder with its files. */
 const FOLDERS:any={backup:['wlfProject','WLF Backups \u2014 '],activity:['wlfActivityProject','WLF Activity backup \u2014 '],full:['wlfFullProject','WLF Full Backup \u2014 '],
  reportRoot:['wlfReportRoot','Monthly Analysis Report'],
  reportSupport:['wlfReportSupport','Technical Support Monthly Report','reportRoot'],reportActivity:['wlfReportActivity','R&I Team Activity Monthly Report','reportRoot'],reportDamage:['wlfReportDamage','Damage Demand Monthly Report','reportRoot'],
  backupRoot:['wlfMonthlyBackupRoot','Monthly Excel Backup'],
  mb_support:['wlfMonthlyBackupSupport','Technical Support','backupRoot'],mb_activity:['wlfMonthlyBackupActivity','R&I Team Activity','backupRoot'],
  mb_project:['wlfMonthlyBackupProject','R&I Project Manager','backupRoot'],mb_qms:['wlfMonthlyBackupQms','QMS Data','backupRoot'],
  mb_damage:['wlfMonthlyBackupDamage','Damage Demand','backupRoot'],mb_claim:['wlfMonthlyBackupClaim','Supplier Claim','backupRoot']};
 const folderCache:any={};
 async function driveFolder(kind='backup'):Promise<string>{
 if(folderCache[kind])return folderCache[kind];
 const cfg=FOLDERS[kind];if(!cfg)throw Error('Unknown Drive folder');
 const parent=cfg[2]?await driveFolder(cfg[2]):null;
 const q="mimeType='application/vnd.google-apps.folder' and trashed=false and appProperties has { key='"+cfg[0]+"' and value='"+project+"' }";
 const found=(await(await drive('drive/v3/files?q='+encodeURIComponent(q)+'&fields=files(id,parents)&pageSize=1')).json()).files?.[0];
 let folder=found?.id;
 if(folder&&parent&&!(found.parents||[]).includes(parent)){
  await drive('drive/v3/files/'+encodeURIComponent(folder)+'?addParents='+encodeURIComponent(parent)+((found.parents||[]).length?'&removeParents='+encodeURIComponent(found.parents.join(',')):'')+'&fields=id',{method:'PATCH',headers:{'Content-Type':'application/json'},body:'{}'});
 }
 if(!folder){const plain=kind.startsWith('report')||kind.startsWith('mb_')||kind==='backupRoot';
  const r=await drive('drive/v3/files?fields=id',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({name:cfg[1]+(plain?'':project),mimeType:'application/vnd.google-apps.folder',appProperties:{[cfg[0]]:project},...(parent?{parents:[parent]}:{})})});folder=(await r.json()).id;}
  if(!/^[a-zA-Z0-9_-]+$/.test(folder||''))throw Error('Drive did not return a backup folder ID.');
  return folderCache[kind]=folder;
 }
 /* v2.7.2: one monthly Excel backup (previous month, never clears) in the name of a Super Admin */
 async function backupOne(kind:string,month:string,from:string,to:string,actor:string){
  const exSql=async(a:string,x:any={})=>{const r=await admin.rpc('wlf_excel_admin',{action:a,actor,payload:x});if(r.error)throw Error(r.error.message);return r.data;};
  const id=crypto.randomUUID();
  const res=await excelMaintenance({action:'excelBackup',payload:{kind,from,to,withClear:false,id},sql:exSql,drive,folder:()=>driveFolder('mb_'+kind),project,Zip:JSZip,monthly:month});
  const saved=await reportSql('backupSaved',{id,month});
  for(const old of saved?.replaced||[]){if(/^[-a-zA-Z0-9_]{5,200}$/.test(old||''))try{await drive('drive/v3/files/'+encodeURIComponent(old),{method:'PATCH',headers:{'Content-Type':'application/json'},body:JSON.stringify({trashed:true})});}catch(_){/* already removed by hand */}}
  return {kind,month,backup:true,fileName:res.name,records:res.records};
 }
 if(reportAction){
  const backup=async(kind:string,month:string,from:string,to:string)=>backupOne(kind,month,from,to,cronToken?(await reportSql('backupActor')).actor:auth.user.id);
  const result=await reportMaintenance({action,payload:p,sql:reportSql,drive,folderFor:driveFolder,Zip:JSZip,selfUrl,backup});
  return new Response(JSON.stringify(result),{headers});
 }
 if(archiveAction){
  const result=await archiveMaintenance({action,payload:p,usageSql,fullSql,drive,folderFor:driveFolder,project,Zip:JSZip});
  return new Response(JSON.stringify(result),{headers});
 }
 if(excelAction){
  const result=await excelMaintenance({action,payload:p,sql:excelSql,drive,folder:driveFolder,project,Zip:JSZip});
  return new Response(JSON.stringify(result),{headers});
 }
 async function verifiedFile(){const f=await sql('download',p);if(!f?.verified||!f.file_id)throw Error('Verified archive part not found');const r=await drive('drive/v3/files/'+encodeURIComponent(f.file_id)+'?alt=media');const text=await r.text();if(await digest(text)!==f.sha256)throw Error('Backup integrity mismatch. Clear blocked.');const data=JSON.parse(text);if(data.project!==project||data.run!==p.id||data.batch!==p.batch)throw Error('Backup identity mismatch. Clear blocked.');return {text,data};}
 if(action==='downloadPart'){const f=await verifiedFile();return new Response(f.text,{headers});}
 if(action==='clearPart'){await verifiedFile();return new Response(JSON.stringify(await sql('clear',p)),{headers});}
 const nonce=crypto.randomUUID(),archive=await sql('prepare',{...p,project,nonce});
 if(archive.alreadyVerified)return new Response(JSON.stringify({alreadyVerified:true}),{headers});
 const text=JSON.stringify(archive),bytes=new TextEncoder().encode(text);if(bytes.length>8000000)throw Error('Archive part exceeds safe server memory limit. Nothing was cleared.');
 const folder=await driveFolder();
 const boundary='wlf_'+crypto.randomUUID(),meta={name:'WLF-Support-'+archive.run+'-part-'+p.batch+'.json',parents:[folder],mimeType:'application/json'};
 const multipart='--'+boundary+'\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n'+JSON.stringify(meta)+'\r\n--'+boundary+'\r\nContent-Type: application/json\r\n\r\n'+text+'\r\n--'+boundary+'--';
 const upload=await drive('upload/drive/v3/files?uploadType=multipart&fields=id',{method:'POST',headers:{'Content-Type':'multipart/related; boundary='+boundary},body:multipart});
 const file=await upload.json();if(!/^[a-zA-Z0-9_-]+$/.test(file.id||''))throw Error('Drive did not return an archive ID');
 const saved=await(await drive('drive/v3/files/'+file.id+'?alt=media')).text(),sha256=await digest(text);
 if(await digest(saved)!==sha256)throw Error('Uploaded backup failed integrity verification. Nothing was cleared.');
 await sql('verify',{...p,nonce,fileId:file.id,sha256});
 return new Response(JSON.stringify({verified:true,fileId:file.id,sha256,records:archive.records.length}),{headers});
 }catch(e){return new Response(JSON.stringify({error:(e as Error).message}),{status,headers});}
});
