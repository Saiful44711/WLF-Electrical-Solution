/* Write Office Open XML tables. All untrusted form text is emitted as inline text cells. */
export const excelMime = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';
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

export async function buildWorkbook(Zip,groups) {
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
export function supportSheets(categories,tickets) {
  return categories.map(c=>formSheet(supportNames[c.id]||c.name,c.schema,tickets.filter(r=>r.category===c.id),
    ['Request ID','Workflow status','Submitted by','Submitted at (UTC)','Last updated (UTC)','Assigned to','Solved by','Solved at (UTC)','Solution'],
    r=>[r.reference,r.status,r.authorName||r.createdBy,r.createdAt,r.updatedAt,r.assigneeName||r.assignedTo,
      r.solverName||r.solvedBy,r.solvedAt,r.solution],r=>r.formSchema));
}
export function activitySheets(categories,entries) {
  return categories.map(c=>formSheet(c.name,c.schema,entries.filter(r=>r.category===c.id),
    ['Entry ID','Recorded status','Submitted by','Submitted at (UTC)','Last updated (UTC)'],
    r=>[r.id,r.status,r.author_name,r.created_at,r.updated_at],r=>r.form_schema));
}
export function backupSheets(snapshot) {
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
