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
function cell(value,address) {
  if (typeof value==='number' && Number.isFinite(value)) return '<c r="'+address+'"><v>'+value+'</v></c>';
  if (typeof value==='boolean') return '<c r="'+address+'" t="b"><v>'+Number(value)+'</v></c>';
  const display=Array.isArray(value)?value.join(', '):String(value??'');
  return '<c r="'+address+'" t="inlineStr"><is><t xml:space="preserve">'+text(display.slice(0,32767))+'</t></is></c>';
}

async function buildWorkbook(Zip,groups) {
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
    const data=rows.map((row,i)=>'<row r="'+(i+1)+'">'+headers.map((_,j)=>cell(row[j],letters(j)+(i+1))).join('')+'</row>').join('');
    const columns=headers.map((header,i)=>'<col min="'+(i+1)+'" max="'+(i+1)+'" width="'+
      Math.max(14,Math.min(43,header.length+4))+'" customWidth="1"/>').join('');
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
  add('xl/_rels/workbook.xml.rels',relationships(workbookRelationships.join('')));
  add('[Content_Types].xml','<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">'+
    '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>'+
    '<Default Extension="xml" ContentType="application/xml"/>'+
    override('workbook.xml','application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml')+
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
  /* options.lean: Technical Support menu download — leaves out the bookkeeping columns (request id, people, timestamps) */
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
    rows:lifts.filter(l=>!l.serialsHidden).flatMap(l=>qmsSerials.filter(([k])=>l.serials[k]).map(([k,t])=>[l.liftId,l.project,t,l.serials[k]]))});
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
  blocks.push({no:3,name:'Control system — '+rec.system+' · '+rec.controllerModel,short:'Control system',columns:[{head:'Group',key:'a',span:2},{head:'Hardware',key:'b',span:2},{head:'Spec',key:'spec',span:1},
    {head:'Item code',key:'code',span:1},{head:'Item name',key:'name',span:2},{head:'Brand',key:'brand',span:1},{head:'Price (৳)',key:'price',span:1,num:true}],
    rows:parts(['control']).map(p=>({a:p.grp||'',b:p.hardware||'',spec:p.spec||'',code:codeOf(p),name:p.name||'',brand:p.brand||'',price:priceOf(p)}))});
  blocks.push({no:4,name:'Serial numbers',columns:[{head:'Part',key:'a',span:3},{head:'Serial number',key:'spec',span:7}],
    rows:rec.serialsHidden?[]:qmsSerials.map(([k,t])=>({a:t,spec:rec.serials?.[k]||'—'})),
    hidden:rec.serialsHidden,empty0:'Serial numbers are not shown to this account.'});
  const names={lop:'LOP',cop:'COP',faceplate:'COP faceplate',transom:'Transom',cable:'Travelling cable'};
  blocks.push({no:5,name:'COP · LOP · Transom · Travelling cable',short:'COP LOP Transom Cable',columns:[{head:'Part',key:'a',span:2},{head:'Model',key:'b',span:2},{head:'Item code',key:'code',span:1},
    {head:'Item name',key:'name',span:3},{head:'Brand',key:'brand',span:1},{head:'Price (৳)',key:'price',span:1,num:true}],
    rows:parts(['lop','cop','faceplate','transom','cable']).map(p=>({a:names[p.section]+(p.grp&&p.section==='cop'?' · '+p.grp.replace('COP ',''):''),b:p.hardware||'',
      code:codeOf(p),name:p.name||'',brand:p.brand||'',price:priceOf(p)}))});
  const avrModel=parts(['avr'])[0]?.model||'';
  blocks.push({no:6,name:'AVR'+(avrModel?' — '+avrModel:''),short:'AVR',columns:[{head:'Category',key:'a',span:2},{head:'Hardware',key:'b',span:2},{head:'Spec',key:'spec',span:2},
    {head:'Item code',key:'code',span:1},{head:'Brand',key:'brand',span:1},{head:'Supplier',key:'supplier',span:1},{head:'Price (৳)',key:'price',span:1,num:true}],
    rows:parts(['avr']).map(p=>({a:p.grp||'',b:[p.hardware,p.name].filter(Boolean).join(' · ')||p.model||'',spec:p.spec||'',code:codeOf(p),brand:p.brand||'',supplier:p.supplier||'',price:priceOf(p)})),empty0:'No AVR was selected.'});
  const other=parts(['other']).map(p=>({a:p.hardware||'',code:codeOf(p),name:p.name||'',spec:p.spec||'',supplier:p.supplier||'',brand:p.brand||'',price:priceOf(p)}));
  if (qmsSdb(sel)) other.push({a:'SDB main breaker rating',code:'—',name:'—',spec:qmsSdb(sel),supplier:'',brand:'',price:''});
  blocks.push({no:7,name:'Other components',short:'Other components',columns:[{head:'Category',key:'a',span:2},{head:'Item code',key:'code',span:1},{head:'Item name',key:'name',span:3},
    {head:'Spec',key:'spec',span:1},{head:'Supplier',key:'supplier',span:1},{head:'Brand',key:'brand',span:1},{head:'Price (৳)',key:'price',span:1,num:true}],rows:other});
  blocks.push({no:8,name:'Paid feature information',short:'Paid feature information',columns:[{head:'Category',key:'a',span:2},{head:'Item code',key:'code',span:1},{head:'Item name',key:'name',span:3},
    {head:'Spec',key:'spec',span:1},{head:'Brand',key:'brand',span:1},{head:'Supplier',key:'supplier',span:1},{head:'Price (৳)',key:'price',span:1,num:true}],
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
  const blank=v=>v==='—'?'':v;
  for (const b of blocks) {
    if (b.hidden) continue;
    const name=b.short||b.name.split(' — ')[0];
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
  return '<c r="'+address+'" s="'+style+'" t="inlineStr"><is><t xml:space="preserve">'+text(display.slice(0,32767))+'</t></is></c>';
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
async function buildReportWorkbook(Zip,report) {
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
      row=r+1; put(span(row,0,UNITS,block.no+' · '+block.name,3),20);
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
  add('xl/_rels/workbook.xml.rels',relationships(rel('rId1','worksheet','worksheets/sheet1.xml')+rel('rId2','styles','styles.xml')));
  add('[Content_Types].xml','<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">'+
    '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/>'+
    override('workbook.xml','application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml')+
    override('worksheets/sheet1.xml','application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml')+
    override('styles.xml','application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml')+'</Types>');
  return zip.generateAsync({type:'uint8array',compression:'DEFLATE',compressionOptions:{level:3}});
}
function qmsReport(raw) {
  const {rec,blocks}=qmsTables(raw);
  const sub=['Recorded by '+rec.createdName,rec.updatedAt?'Updated '+qmsClock(rec.updatedAt)+' by '+rec.updatedName:''].filter(Boolean).join(' · ');
  return {name:'QMS Report',title:'QMS — Lift '+rec.liftId+' · '+rec.project,subtitle:sub,blocks};
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
function fileName(run,extension='xlsx') {
  const module={support:'Technical-Support',activity:'RI-Team-Activity',project:'RI-Project',qms:'QMS-Data',damage:'Damage-Demand',claim:'Supplier-Claim'}[run.kind]||'Backup';
  const period=run.date_from?run.date_from+'_to_'+run.date_to:'All-Dates';
  return 'WLF-'+module+'-'+period+'-'+run.id.slice(0,8)+'.'+extension;
}

async function excelMaintenance({action,payload,sql,drive,folder,project,Zip}) {
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
      const parent=await folder(),workbook=await saveFile(bytes,fileName(run),excelMime,parent);
      let recovery;
      if(payload.withClear) {
        const archive={format:recoveryFormat,project,id,kind:run.kind,records:snapshot.records};
        recovery=await saveFile(encoder.encode(JSON.stringify(archive)),fileName(run,'recovery.json'),jsonMime,parent);
      }
      const verified=await sql('verify',{id,nonce,workbookId:workbook.id,workbookHash:workbook.sha256,
        recoveryId:recovery?.id,recoveryHash:recovery?.sha256});
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

// ---- Request handler
const headers={'Access-Control-Allow-Origin':'*','Access-Control-Allow-Headers':'authorization,x-client-info,apikey,content-type','Access-Control-Allow-Methods':'POST,OPTIONS','Content-Type':'application/json','Cache-Control':'no-store'};
const digest=async(text:string)=>Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',new TextEncoder().encode(text)))).map(x=>x.toString(16).padStart(2,'0')).join('');
Deno.serve(async(req)=>{
 if(req.method==='OPTIONS')return new Response('ok',{headers});
 let status=400;
 try{
 if(req.method!=='POST')throw Error('POST required');
 const url=Deno.env.get('SUPABASE_URL')!,keys=JSON.parse(Deno.env.get('SUPABASE_SECRET_KEYS')||'{}'),key=keys.default||Deno.env.get('SUPABASE_SERVICE_ROLE_KEY');
 if(!url||!key)throw Error('Server configuration missing');
 const admin=createClient(url,key,{auth:{persistSession:false,autoRefreshToken:false}});
 const token=(req.headers.get('Authorization')||'').replace(/^Bearer\s+/i,'');
 const {data:auth,error:authError}=await admin.auth.getUser(token);if(authError||!auth.user){status=401;throw Error('Sign in required');}
 const {data:me,error:meError}=await admin.from('wlf_profiles').select('id,role,status').eq('id',auth.user.id).single();
 if(meError||me?.role!=='Super Admin'||me?.status!=='Approved'){status=403;throw Error('Super Admin only');}
 if(Number(req.headers.get('content-length')||0)>12000000)throw Error('Request too large');
 const body=await req.json(),action=body.action,p=body.payload||{};
 const project=new URL(url).hostname.split('.')[0];
 async function sql(action:string,payload:any={}){const r=await admin.rpc('wlf_backup_admin',{action,actor:auth.user.id,payload});if(r.error)throw Error(r.error.message);return r.data;}
async function usageSql(action:string,payload:any={}){const r=await admin.rpc('wlf_usage_admin',{action,actor:auth.user.id,payload});if(r.error)throw Error(r.error.message);return r.data;}
 async function fullSql(action:string,payload:any={}){const r=await admin.rpc('wlf_full_admin',{action,actor:auth.user.id,payload});if(r.error)throw Error(r.error.message);return r.data;}
 async function excelSql(action:string,payload:any={}){const r=await admin.rpc('wlf_excel_admin',{action,actor:auth.user.id,payload});if(r.error)throw Error(r.error.message);return r.data;}
 const clientId=Deno.env.get('WLF_GOOGLE_CLIENT_ID'),clientSecret=Deno.env.get('WLF_GOOGLE_CLIENT_SECRET'),refreshToken=Deno.env.get('WLF_GOOGLE_REFRESH_TOKEN');
 const configured=!!(clientId&&clientSecret&&refreshToken);
 if(action==='status')return new Response(JSON.stringify({...await sql('status'),driveConfigured:configured}),{headers});
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
 if(!excelAction&&!archiveAction&&!['backupPart','downloadPart','clearPart'].includes(action))throw Error('Unsupported action');
 if(!configured)throw Error('Google Drive setup required. Read GOOGLE_DRIVE_SETUP_BN.html in the update package.');
 const tr=await fetch('https://oauth2.googleapis.com/token',{method:'POST',headers:{'Content-Type':'application/x-www-form-urlencoded'},body:new URLSearchParams({client_id:clientId!,client_secret:clientSecret!,refresh_token:refreshToken!,grant_type:'refresh_token'})});
 const t=await tr.json();if(!tr.ok||!t.access_token)throw Error('Google Drive authorization expired or invalid. Reconnect using the setup guide.');
 async function drive(path:string,init:any={}){const r=await fetch('https://www.googleapis.com/'+path,{...init,headers:{Authorization:'Bearer '+t.access_token,...(init.headers||{})}});if(!r.ok)throw Error('Google Drive request failed ('+r.status+'). Nothing was cleared.');return r;}
 async function driveFolder(kind='backup'){
 const cfg:any={backup:['wlfProject','WLF Backups — '],activity:['wlfActivityProject','WLF Activity backup — '],full:['wlfFullProject','WLF Full Backup — ']}[kind];
 const q="mimeType='application/vnd.google-apps.folder' and trashed=false and appProperties has { key='"+cfg[0]+"' and value='"+project+"' }";
 const folders=await(await drive('drive/v3/files?q='+encodeURIComponent(q)+'&fields=files(id)&pageSize=1')).json();let folder=folders.files?.[0]?.id;
 if(!folder){const r=await drive('drive/v3/files?fields=id',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({name:cfg[1]+project,mimeType:'application/vnd.google-apps.folder',appProperties:{[cfg[0]]:project}})});folder=(await r.json()).id;}
  if(!/^[a-zA-Z0-9_-]+$/.test(folder||''))throw Error('Drive did not return a backup folder ID.');
  return folder;
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
