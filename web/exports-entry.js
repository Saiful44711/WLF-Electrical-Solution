import JSZip from 'jszip';
import PptxGenJS from 'pptxgenjs';
import {buildWorkbook,excelMime,supportSheets,activitySheets} from '../supabase/functions/_shared/wlf-excel.mjs';

function download(bytes,name) {
  const url=URL.createObjectURL(new Blob([bytes],{type:excelMime}));
  const link=document.createElement('a');
  link.href=url; link.download=name; link.click();
  setTimeout(()=>URL.revokeObjectURL(url),5000);
}
async function excel(groups,name) {
  download(await buildWorkbook(JSZip,groups),name+'.xlsx');
}
function progress(tasks) {
  return tasks.length?Math.round(tasks.reduce((total,t)=>total+t.progress,0)/tasks.length):0;
}
function ganttRange(project) {
  const days=value=>Date.parse(value+'T00:00:00Z');
  const start=Math.min(days(project.start),...project.tasks.map(task=>days(task.start)));
  const end=Math.max(days(project.end),...project.tasks.map(task=>days(task.end)))+86400000;
  return {start,end,offset:value=>(days(value)-start)/(end-start),
    length:(from,to)=>(days(to)-days(from)+86400000)/(end-start)};
}
async function projectPpt(project,people) {
  const deck=new PptxGenJS();
  deck.layout='LAYOUT_WIDE'; deck.author='WLF Electrical Solution'; deck.company='WLF';
  deck.subject='R&I project review'; deck.title=project.name;
  const person=id=>people.find(p=>p.id===id)?.name||(id?'Former team member':'Unassigned');
  const palette={background:'101827',accent:'9D86E9',white:'F2F5FC',soft:'C1CDE2',track:'2D3D5D',done:'48C79C'};
  const add=(slide,value,opts)=>slide.addText(String(value??''),{margin:0,color:palette.white,fontFace:'Arial',...opts});
  function slide(title,subtitle) {
    const page=deck.addSlide(); page.background={color:palette.background};
    page.addShape(deck.ShapeType.rect,{x:0,y:0,w:13.333,h:.12,fill:{color:palette.accent},line:{color:palette.accent}});
    add(page,'WLF ELECTRICAL SOLUTION   /   R&I PROJECT MANAGER',{x:.6,y:.38,w:12,h:.24,fontSize:12,color:palette.accent});
    add(page,title,{x:.6,y:.88,w:12.1,h:.75,fontSize:28,bold:true,fit:'shrink'});
    add(page,subtitle,{x:.6,y:1.64,w:12,h:.32,fontSize:13,color:palette.soft,fit:'shrink'});
    return page;
  }
  const cover=slide(project.name,project.impact+'  •  '+project.status+'  •  '+progress(project.tasks)+'% complete');
  add(cover,'Project lead  '+person(project.lead)+'\nCollaborators  '+(project.collaborators.map(person).join(', ')||'None')+
    '\nSchedule  '+project.start+' to '+project.end+
    '\nFinancial outcome  '+(project.financial?'Yes':'No')+'    Documentation  '+(project.documentation?'Yes':'No'),
    {x:.6,y:2.37,w:12.0,h:1.75,fontSize:17,fit:'shrink'});
  add(cover,'PROJECT BRIEFING',{x:.6,y:4.48,w:12,h:.28,fontSize:12,bold:true,color:palette.accent});
  add(cover,project.brief||'No briefing recorded.',{x:.6,y:4.96,w:12,h:2.0,fontSize:16,fit:'shrink',valign:'top'});
  const range=ganttRange(project), pageSize=7;
  const count=Math.max(1,Math.ceil(project.tasks.length/pageSize));
  for (let page=0;page<count;page++) {
    const timeline=slide('Task schedule and progress',project.name+(count>1?'  •  Page '+(page+1)+' of '+count:''));
    const tasks=project.tasks.slice(page*pageSize,(page+1)*pageSize);
    if (!tasks.length) add(timeline,'No tasks recorded.',{x:.6,y:2.8,w:10,h:.4,fontSize:20});
    for (let tick=0;tick<=4 && tasks.length;tick++) {
      const day=new Date(range.start+(range.end-range.start-86400000)*tick/4).toISOString().slice(0,10);
      add(timeline,day,{x:4.62+tick*1.88,y:2.13,w:1,h:.22,fontSize:9,color:palette.soft});
    }
    tasks.forEach((task,i)=>{
      const y=2.55+i*.6, x=4.7+range.offset(task.start)*7.8, width=range.length(task.start,task.end)*7.8;
      add(timeline,task.name,{x:.6,y,w:4,h:.26,fontSize:14,bold:true,fit:'shrink'});
      add(timeline,person(task.owner)+'  •  '+task.status+'  •  '+task.progress+'%  •  '+task.start+' to '+task.end,
        {x:.6,y:y+.28,w:4,h:.22,fontSize:9,color:palette.soft,fit:'shrink'});
      timeline.addShape(deck.ShapeType.rect,{x:4.7,y:y+.14,w:7.8,h:.17,fill:{color:palette.track},line:{transparency:100}});
      timeline.addShape(deck.ShapeType.rect,{x,y:y+.14,w:width,h:.17,fill:{color:palette.accent},line:{transparency:100}});
      if(task.progress) timeline.addShape(deck.ShapeType.rect,{x,y:y+.14,w:width*task.progress/100,h:.17,
        fill:{color:palette.done},line:{transparency:100}});
    });
  }
  const stem=project.name.replace(/[<>:"/\\|?*\u0000-\u001f]+/g,'-').trim().slice(0,90)||'project';
  await deck.writeFile({fileName:'WLF-'+stem+'.pptx'});
}
window.WlfExports={download,excel,supportSheets,activitySheets,projectPpt,progress,ganttRange};
