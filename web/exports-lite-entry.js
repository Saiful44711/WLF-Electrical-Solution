// v2.5.0: small always-loaded helpers. The big Excel/PowerPoint bundle (wlf-exports.js)
// is loaded only when someone actually downloads a file, so the app opens faster.
import {excelMime,supportSheets,activitySheets} from '../supabase/functions/_shared/wlf-excel.mjs';

let loading=null;
function full() {
  if (window.WlfExportsFull) return Promise.resolve(window.WlfExportsFull);
  if (!loading) loading=new Promise((resolve,reject)=>{
    const s=document.createElement('script');
    s.src='wlf-exports.js'; s.async=true;
    s.onload=()=>window.WlfExportsFull?resolve(window.WlfExportsFull):reject(Error('Export tools did not load. Refresh and try again.'));
    s.onerror=()=>{loading=null;reject(Error('Export tools could not load. Check the connection and try again.'));};
    document.head.appendChild(s);
  });
  return loading;
}
function download(bytes,name) {
  const url=URL.createObjectURL(new Blob([bytes],{type:excelMime}));
  const link=document.createElement('a');
  link.href=url; link.download=name; link.click();
  setTimeout(()=>URL.revokeObjectURL(url),5000);
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
async function excel(groups,name) { return (await full()).excel(groups,name); }
async function qmsExcel(lift,name) { return (await full()).qmsExcel(lift,name); }
async function qmsFlatExcel(lifts,name) { return (await full()).qmsFlatExcel(lifts,name); }
async function projectPpt(project,people) { return (await full()).projectPpt(project,people); }
window.WlfExports={download,excel,qmsExcel,qmsFlatExcel,supportSheets,activitySheets,projectPpt,progress,ganttRange,load:full};
