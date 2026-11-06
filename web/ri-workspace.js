/* Server-backed R&I modules. The database also checks access and ownership on every action. */
const WlfRi = (() => {
  'use strict';
  const el=id=>document.getElementById(id);
  const h=value=>esc(String(value??''));
  const admin=()=>AccessCore.superUser(SESSION);
  const owner=record=>admin()||record.owner===SESSION?.token;
  const buttons=(id,label)=>' <button type="button" class="btn ghost" id="'+id+'">'+h(label)+'</button>';
  const sections={team:'Team Activity',scm:'Supplier & SCM Cooperation',sales:'Sales Support',reports:'Reports'};
  const impactTypes=['Product Development','Process Improvement','Business Development'];
  const projectStates=['In Progress','On Hold','Done','Cancelled'];
  const taskStates=['Pending','In Progress','On Hold','Done','Cancelled'];
  const activityTab='ri-activity',projectTab='ri-projects';
  const date=()=>AccessCore.dateKey(new Date());
  const stamp=value=>value?new Date(value).toLocaleString('en-GB',{timeZone:'Asia/Dhaka'}):'';
  const option=WlfFields.option;
  const input=(label,name,type,value='',extra='')=>`<label>${h(label)}<input name="${name}" type="${type}" value="${h(value)}" ${extra}></label>`;
  const select=(label,name,options,value='',all='')=>`<label>${h(label)}<select name="${name}">${
    all?option('',all,value):''}${options.map(item=>Array.isArray(item)?
      option(item[0],item[1],value):option(item,item,value)).join('')}</select></label>`;
  const button=(label,action,id='',primary=false)=>`<button type="button" class="btn ${primary?'':'ghost'}" data-ri-action="${action}" data-ri-id="${h(id)}">${h(label)}</button>`;
  const rowActions=html=>`<div class="wlf-module-actions">${html}</div>`;
  let activities, projects;
  const reset=()=>{
    activities={section:'team',category:'',categories:[],filters:{},rows:[],next:null,cursors:[],seq:0};
    projects={rows:[],people:[],filters:{},next:null,cursors:[],seq:0,expanded:new Set()};
  };
  reset();

  async function call(action,payload={}) {
    const account=T();
    const result=await rpc(action,[account,payload]);
    if (!SESSION||account!==T()) throw Error('Session changed');
    return result;
  }
  function report(id,message,error=false) {
    const node=el(id);
    if(node){node.textContent=message;node.classList.toggle('error',error);}
  }
  function showError(id,err) { if(SESSION) report(id,cleanError(err),true); }
  function badge(status) {
    const closed=['Completed','Solved','Done'].includes(status);
    return `<span class="support-status ${closed?'status-solved':'status-pending'}">${h(status)}</span>`;
  }
  function dialog(title,content,onSubmit,init) {
    const node=el('wlfRiDialog');
    node.innerHTML=`<h3>${h(title)}</h3><form><div>${content}</div><p role="status"></p>${rowActions(
      '<button type="submit" class="btn">Save</button><button type="button" class="btn ghost" data-ri-cancel>Cancel</button>')}</form>`;
    const form=node.querySelector('form'), submit=form.querySelector('[type=submit]');
    form.querySelector('[data-ri-cancel]').onclick=()=>node.close();
    form.onsubmit=async event=>{
      event.preventDefault();submit.disabled=true;
      try{await onSubmit(form);if(node.open&&node.contains(form))node.close();}
      catch(err){if(node.contains(form)){form.querySelector('[role=status]').textContent=cleanError(err);submit.disabled=false;}}
    };
    init?.(form);
    if(!node.open)node.showModal();
  }
  function attachActions(root,handler) {
    root.onclick=event=>{
      const b=event.target.closest('[data-ri-action]');
      if(b&&root.contains(b)) handler(b.dataset.riAction,b.dataset.riId,b);
    };
  }

  function activeCategory() { return activities.categories.find(c=>c.id===activities.category&&c.active); }
  function activityCursor() { return activities.cursors.at(-1)||{}; }
  async function refreshCategories() {
    const target=activities, categories=await call('getRiCategories');
    if(target!==activities)return;
    activities.categories=categories;
    const active=categories.filter(c=>c.section===activities.section&&c.active);
    if (!active.some(c=>c.id===activities.category)) {
      activities.category=active[0]?.id||'';
      activities.filters={};activities.cursors=[];
    }
    renderActivity();
    if (activities.category) await loadEntries();
  }
  function renderActivity() {
    const root=el('tab-'+activityTab), category=activeCategory();
    const active=activities.categories.filter(c=>c.active&&c.section===activities.section);
    const archived=activities.categories.filter(c=>!c.active&&c.section===activities.section);
    root.innerHTML=`<div class="wlf-module">
      <section class="card"><div class="review-heading"><div><h3>R&I Team Activity</h3>
        <p class="note">Choose an activity or report form and submit it below.</p></div>${admin()?button('+ Add category','new-category') : ''}</div>
        <div class="wlf-section-tabs" aria-label="Activity tabs">${Object.entries(sections).map(([id,label])=>
          `<button type="button" class="btn ghost ${id===activities.section?'active':''}" aria-pressed="${id===activities.section}"
            data-ri-action="section" data-ri-id="${id}">${h(label)}</button>`).join('')}</div>
        ${active.length>1||activities.section==='reports'?rowActions(active.map(c=>
          `<button type="button" class="btn ghost ${c.id===category?.id?'active':''}" aria-pressed="${c.id===category?.id}"
            data-ri-action="category" data-ri-id="${h(c.id)}">${h(c.name)}</button>`).join('')):''}
        ${admin()&&category?rowActions(button('Manage form fields','edit-category',category.id)+button('Remove category','archive-category',category.id)):''}
        ${admin()&&archived.length?`<details><summary>Removed categories (${archived.length})</summary>${rowActions(
          archived.map(c=>button('Restore '+c.name,'restore-category',c.id)).join(''))}</details>`:''}
        <p id="riActivityStatus" role="status" aria-live="polite"></p></section>
      ${category?' <div id="riActivityForm"></div><div id="riEntryList" class="card" aria-live="polite">Loading entries…</div>':
        '<section class="card"><p>No active forms in this tab.</p></section>'}</div>`;
    if(category)renderActivityForm(category);
    attachActions(root,(action,id,b)=>activityAction(action,id,b).catch(err=>showError('riActivityStatus',err)));
  }
  async function activityAction(action,id,b) {
    const category=activeCategory();
    const saved=activities.categories.find(c=>c.id===id);
    if(action==='section'||action==='category'){
      if(action==='section'){
        activities.section=id;
        activities.category=activities.categories.find(c=>c.section===id&&c.active)?.id||'';
      } else activities.category=id;
      activities.filters={};activities.cursors=[];renderActivity();
      if(activities.category)await loadEntries();
    } else if(action==='new-category'||action==='edit-category') {
      categoryDialog(saved);
    } else if(action==='archive-category'||action==='restore-category') {
      if(!admin()||!saved)return;
      const active=action==='restore-category';
      if(!active&&!confirm('Remove this category from the active tabs? Its submissions will stay available for backup.'))return;
      b.disabled=true;
      try{
        await call('setRiCategoryActive',{category:id,revision:saved.revision,active});
        await refreshCategories();
      }finally{b.disabled=false;}
    } else if(action==='edit-entry') {
      const entry=activities.rows.find(r=>r.id===id);
      if(entry&&owner(entry)&&category)renderActivityForm(category,entry);
    } else if(action==='delete-entry') {
      const entry=activities.rows.find(r=>r.id===id);
      if(!admin()||!entry||!confirm('Remove this submitted entry?'))return;
      b.disabled=true;
      try{
        await call('deleteRiEntry',{id,category:entry.category,revision:entry.revision,operation:crypto.randomUUID()});
        await loadEntries();
      }finally{b.disabled=false;}
    } else if(action==='entry-next'||action==='entry-prev') {
      if(action==='entry-next'&&activities.next)activities.cursors.push(activities.next);
      if(action==='entry-prev')activities.cursors.pop();
      await loadEntries();
    } else if(action==='refresh-activity') {
      await loadEntries();
    } else if(action==='export-activity'&&category) {
      b.disabled=true;
      try{
        let cursor={},rows=[];
        for(;;) {
          const data=await call('getRiEntries',{...activities.filters,...cursor,category:category.id});
          if(activeCategory()?.id!==category.id)return;
          rows.push(...data.entries);
          if(rows.length>1000)throw Error('Refine the date filters to export up to 1,000 matching entries.');
          if(!data.hasMore)break;
          cursor=toCursor(data.entries);
        }
        await WlfExports.excel(WlfExports.activitySheets([category],rows),'WLF-Activity-'+category.id);
      }finally{b.disabled=false;}
    }
  }
  function categoryDialog(category) {
    if(!admin())return;
    const id=category?.id||'custom-'+crypto.randomUUID();
    const starter=[
      {id:'date',label:'Date',type:'date',autoFill:'today',required:true},
      {id:'identity',label:'Name & ID',type:'text',autoFill:'identity',required:true},
      {id:'subject',label:'Task name',type:'text',required:true},
      {id:'problem',label:'Task details',type:'textarea',required:true},
      {id:'status',label:'Task status',type:'select',options:['Completed','Ongoing','Hold','Canceled'],required:true}
    ];
    dialog(category?'Manage activity form fields':'Add activity category',`<div class="review-fields">${
      input('Category name','name','text',category?.name,'required maxlength="120"')}${
      select('Tab','section',Object.entries(sections),category?.section||activities.section)}</div>${
      WlfFields.editor(category?.schema.fields||starter)}`,async form=>{
      const data=new FormData(form);
      const saved=await call('saveRiCategory',{category:id,revision:category?.revision||0,
        name:data.get('name'),section:data.get('section'),fields:WlfFields.read(form)});
      activities.section=saved.section;activities.category=saved.id;activities.filters={};activities.cursors=[];
      await refreshCategories();
    },WlfFields.bind);
  }
  function renderActivityForm(category,entry=null) {
    const panel=el('riActivityForm'),formSchema=entry?.form_schema||category.schema;
    const id=entry?.id||crypto.randomUUID(),operation=crypto.randomUUID();
    panel.innerHTML=`<section class="card"><div class="review-heading"><div><h3>${h(category.name)}</h3>
      ${entry?'<p class="note">Editing a submitted entry using its saved field definitions.</p>':''}</div>
      ${entry?buttons('riCancelEdit','Cancel edit'):''}</div>
      <form id="riSubmitForm"><div class="review-fields">${WlfFields.inputs(formSchema.fields,entry?.values,!!entry)}</div>
      <button class="btn" type="submit">${entry?'Save changes':'Submit'}</button>
      <p id="riSubmitStatus" role="status" aria-live="polite"></p></form></section>`;
    if(entry)el('riCancelEdit').onclick=()=>renderActivityForm(category);
    const form=el('riSubmitForm'),submit=form.querySelector('[type=submit]');
    form.onsubmit=async event=>{
      event.preventDefault();submit.disabled=true;
      try{
        const saved=await call('saveRiEntry',{id,operation,category:category.id,formRevision:category.revision,
          revision:entry?.revision||0,values:WlfFields.values(form,formSchema.fields)});
        if(!form.isConnected||activeCategory()?.id!==category.id)return;
        renderActivityForm(category);
        report('riSubmitStatus','Saved · '+saved.status);
        activities.cursors=[];
        await loadEntries();
      }catch(err){if(form.isConnected){showError('riSubmitStatus',err);submit.disabled=false;}}
    };
    if(entry)panel.scrollIntoView({behavior:'smooth',block:'start'});
  }
  function toCursor(records) {
    const last=records.at(-1);
    return last?{beforeAt:last.created_at,beforeId:last.id}:null;
  }
  function pageActions(type,cursors,next) {
    return rowActions(`<button class="btn ghost" type="button" data-ri-action="${type}-prev" ${cursors.length?'':'disabled'}>Previous</button>
      <span>Page ${cursors.length+1}</span><button class="btn ghost" type="button" data-ri-action="${type}-next" ${next?'':'disabled'}>Next</button>`);
  }
  async function loadEntries() {
    const target=activities, seq=++target.seq, category=activeCategory(),root=el('riEntryList');
    if(!category||!root)return;
    try{
      const data=await call('getRiEntries',{category:category.id,...target.filters,...activityCursor()});
      if(target!==activities||seq!==target.seq||!root.isConnected||activeCategory()?.id!==category.id)return;
      target.rows=data.entries;target.next=data.hasMore?toCursor(data.entries):null;
      const f=target.filters;
      root.innerHTML=`<div class="review-heading"><h3>Submitted entries</h3>${button('Download filtered Excel','export-activity')}</div>
        <form id="riActivityFilters"><div class="review-fields">${
          input('Search','query','search',f.query,'maxlength="200"')}${select('Status','status',data.statuses,f.status,'All statuses')}${
          input('From date','from','date',f.from)}${input('To date','to','date',f.to)}</div>
          <button type="submit" class="btn ghost">Apply filters</button> ${button('Refresh','refresh-activity')}</form>
        ${pageActions('entry',target.cursors,target.next)}
        <div class="tbl-wrap"><table class="tbl"><thead><tr><th>Submitted by</th><th>Submitted (Dhaka)</th><th>Status</th><th>Details</th></tr></thead><tbody>
        ${data.entries.map(e=>`<tr><td>${h(e.author_name)}</td><td>${h(stamp(e.created_at))}</td><td>${badge(e.status)}</td>
          <td><details><summary>View entry</summary><dl class="wlf-entry-values">${e.form_schema.fields.map(field=>
            '<dt>'+h(field.label)+'</dt><dd>'+h(WlfFields.display(e.values[field.id])||'—')+'</dd>').join('')}</dl></details>
          ${rowActions((owner(e)?button('Edit entry','edit-entry',e.id):'')+(admin()?button('Delete entry','delete-entry',e.id):''))}</td></tr>`).join('')
          ||'<tr><td colspan="4">No matching entries.</td></tr>'}</tbody></table></div>`;
      el('riActivityFilters').onsubmit=event=>{
        event.preventDefault(); target.filters=Object.fromEntries(new FormData(event.target));target.cursors=[];loadEntries();
      };
    }catch(err){if(target===activities&&seq===target.seq&&root.isConnected)root.textContent=cleanError(err);}
  }

  const labelPerson=id=>projects.people.find(person=>person.id===id)?.name||(id?'Former team member':'Unassigned');
  function peopleOptions() { return projects.people.filter(p=>p.eligible).map(p=>[p.id,p.name]); }
  function projectCursor() { return projects.cursors.at(-1)||{}; }
  async function loadProjects() {
    const target=projects, seq=++target.seq;
    try{
      const data=await call('getRiProjects',{...target.filters,...projectCursor()});
      if(target!==projects||seq!==target.seq)return;
      target.rows=data.projects;target.people=data.people;target.next=data.hasMore?toCursor(data.projects):null;
      renderProjects();
    }catch(err){if(target===projects&&seq===target.seq)el('tab-'+projectTab).textContent=cleanError(err);}
  }
  function projectCard(row) {
    const p=row.data, can=owner(row), pct=WlfExports.progress(p.tasks);
    return `<details class="card" data-project="${h(row.id)}" ${projects.expanded.has(row.id)?'open':''}>
      <summary><b>${h(p.name)}</b> · ${h(p.impact)} · ${badge(p.status)} · ${pct}% complete</summary>
      <div class="review-heading"><div><h3>${h(p.name)}</h3><p class="note">Created by ${h(row.owner_name)}
        · Lead ${h(labelPerson(p.lead))} · ${h(p.start)} to ${h(p.end)}</p></div>
        ${button('Download PPTX','project-ppt',row.id)}</div>
      <p>Collaborators ${h(p.collaborators.map(labelPerson).join(', ')||'None')}</p>
      <p>Financial outcome ${p.financial?'Yes':'No'} · Documentation ${p.documentation?'Yes':'No'}</p>
      ${p.brief?'<p>'+h(p.brief)+'</p>':''}
      ${can?rowActions(button('Edit project','edit-project',row.id)+button('+ Add task','add-task',row.id)+
        button('Delete project','delete-project',row.id)):''}
      <h4>Gantt chart</h4>${gantt(p)}
      <div class="tbl-wrap"><table class="tbl"><thead><tr><th>Task</th><th>Assignee</th><th>Start</th><th>End</th><th>Status</th>
        <th>Progress</th>${can?'<th>Actions</th>':''}</tr></thead><tbody>${p.tasks.map(t=>`<tr><td>${h(t.name)}</td>
        <td>${h(labelPerson(t.owner))}</td><td>${h(t.start)}</td><td>${h(t.end)}</td><td>${badge(t.status)}</td><td>${t.progress}%</td>
        ${can?'<td>'+button('Edit task','edit-task',row.id+'|'+t.id)+button('Delete task','delete-task',row.id+'|'+t.id)+'</td>':''}</tr>`).join('')||
        '<tr><td colspan="7">No tasks added.</td></tr>'}</tbody></table></div></details>`;
  }
  function gantt(p) {
    if(!p.tasks.length)return '<p class="note">Add dated tasks to build the timeline.</p>';
    const range=WlfExports.ganttRange(p);
    const ticks=Array.from({length:5},(_,i)=>'<span>'+new Date(range.start+(range.end-range.start-86400000)*i/4).toISOString().slice(0,10)+'</span>').join('');
    return `<div class="wlf-gantt"><div class="wlf-project-chart"><div class="wlf-gantt-row"><b>Task</b><div class="wlf-gantt-scale">${ticks}</div></div>${
      p.tasks.map(t=>`<div class="wlf-gantt-row"><span>${h(t.name)} · ${t.progress}%</span>
        <div class="wlf-gantt-track" title="${h(t.start+' to '+t.end)}">
        <div class="wlf-gantt-bar" style="left:${range.offset(t.start)*100}%;width:${range.length(t.start,t.end)*100}%"><span style="width:${t.progress}%"></span></div>
        </div></div>`).join('')}</div></div>`;
  }
  function renderProjects() {
    const root=el('tab-'+projectTab),p=projects,f=p.filters,people=peopleOptions();
    root.innerHTML=`<div class="wlf-module"><section class="card"><div class="review-heading"><div><h3>R&I Project Manager</h3>
      <p class="note">Review projects, task schedules and delivery progress.</p></div>${button('+ Add project','new-project','',true)}</div>
      <form id="riProjectFilters"><div class="review-fields">${input('Project search','query','search',f.query,'maxlength="200"')}
        ${select('Project lead','lead',people,f.lead,'All leads')}${select('Collaborator','collaborator',people,f.collaborator,'All collaborators')}
        ${select('Impact type','impact',impactTypes,f.impact,'All types')}${select('Status','status',projectStates,f.status,'All statuses')}</div>
        <button class="btn ghost" type="submit">Apply filters</button> ${button('Refresh','refresh-projects')}</form>
      ${pageActions('project',p.cursors,p.next)}<p id="riProjectStatus" role="status" aria-live="polite"></p></section>
      ${p.rows.map(projectCard).join('')||'<section class="card"><p>No matching projects.</p></section>'}</div>`;
    el('riProjectFilters').onsubmit=event=>{
      event.preventDefault();p.filters=Object.fromEntries(new FormData(event.target));p.cursors=[];loadProjects();
    };
    root.querySelectorAll('[data-project]').forEach(details=>details.addEventListener('toggle',()=>{
      if(details.open)p.expanded.add(details.dataset.project);
      else p.expanded.delete(details.dataset.project);
    }));
    attachActions(root,(action,id,b)=>projectAction(action,id,b).catch(err=>showError('riProjectStatus',err)));
  }
  function peopleList() {
    const active=projects.people.filter(person=>person.eligible);
    const names=new Map();
    for (const p of projects.people) names.set(p.name,(names.get(p.name)||0)+1);
    const display=p=>names.get(p.name)>1?p.name+' ('+p.id.slice(-6)+')':p.name;
    return {inputFor:id=>{const p=projects.people.find(x=>x.id===id);return p?display(p):id?'Former team member':'';},
      idFor:(value,current='')=>{
        if(!value)return '';
        const option=active.find(p=>display(p)===value);
        const previous=projects.people.find(p=>p.id===current);
        if(option)return option.id;
        if(current&&value===(previous?display(previous):'Former team member'))return current;
        throw Error('Choose a team member from the suggestions.');
      },
      html:'<datalist id="riPeopleOptions">'+active.map(p=>'<option value="'+h(display(p))+'"></option>').join('')+'</datalist>'};
  }
  async function saveProject(row,id,operation,data){
    const saved=await call('saveRiProject',{id,operation,revision:row?.revision||0,data});
    projects.expanded.add(saved.id);
    if(!row)projects.cursors=[];
    await loadProjects();
  }
  function projectDialog(row) {
    if(row&&!owner(row))return;
    const data=row?.data||{name:'',lead:T(),collaborators:[],start:date(),end:date(),impact:impactTypes[0],
      status:projectStates[0],brief:'',financial:false,documentation:false,tasks:[]};
    const people=peopleList(),id=row?.id||crypto.randomUUID(),operation=crypto.randomUUID();
    const collaborators=new Set(data.collaborators);
    dialog(row?'Edit project':'Add project',`<div class="review-fields">
      ${input('Project name','name','text',data.name,'required maxlength="180"')}
      ${input('Project lead','lead','text',people.inputFor(data.lead),'required list="riPeopleOptions" autocomplete="off"')}
      ${select('Impact type','impact',impactTypes,data.impact)}${select('Status','status',projectStates,data.status)}
      ${input('Start date','start','date',data.start,'required')}${input('Target date','end','date',data.end,'required')}
      ${input('Collaborator','new-collaborator','text','','list="riPeopleOptions" autocomplete="off"')}
      <button class="btn ghost" type="button" data-add-collab>Add collaborator</button></div>
      <div class="wlf-choice-list" data-collaborators></div>${people.html}
      <label class="wlf-choice"><input type="checkbox" name="financial" ${data.financial?'checked':''}> Financial outcome</label>
      <label class="wlf-choice"><input type="checkbox" name="documentation" ${data.documentation?'checked':''}> Documentation</label>
      <label>Project briefing<textarea name="brief" rows="4" maxlength="4000">${h(data.brief)}</textarea></label>`,async form=>{
        const values=Object.fromEntries(new FormData(form)),lead=people.idFor(values.lead,data.lead);
        if(values['new-collaborator'].trim())collaborators.add(people.idFor(values['new-collaborator'].trim()));
        await saveProject(row,id,operation,{...data,name:values.name,lead,collaborators:[...collaborators],
          impact:values.impact,status:values.status,start:values.start,end:values.end,brief:values.brief,
          financial:!!values.financial,documentation:!!values.documentation});
      },form=>{
        const list=form.querySelector('[data-collaborators]'),field=form.elements['new-collaborator'];
        const refresh=()=>{list.innerHTML=[...collaborators].map(x=>
          '<button type="button" class="btn ghost" data-remove-collab="'+h(x)+'">Remove '+h(labelPerson(x))+'</button>').join('');};
        refresh();
        list.onclick=event=>{
          const b=event.target.closest('[data-remove-collab]');
          if(b){collaborators.delete(b.dataset.removeCollab);refresh();}
        };
        form.querySelector('[data-add-collab]').onclick=()=>{
          const status=form.querySelector('[role=status]');
          try{
            const id=people.idFor(field.value.trim());
            if(id){collaborators.add(id);field.value='';refresh();}
            status.textContent='';
          }catch(err){status.textContent=err.message;}
        };
      });
  }
  function taskDialog(row,task) {
    if(!owner(row))return;
    const p=row.data, data=task||{name:'',owner:p.lead,start:p.start,end:p.end,progress:0,status:'Pending'};
    const id=task?.id||crypto.randomUUID(),operation=crypto.randomUUID(),people=peopleList();
    dialog(task?'Edit task':'Add task',`<div class="review-fields">
      ${input('Task name','name','text',data.name,'required maxlength="180"')}
      ${input('Assignee','owner','text',people.inputFor(data.owner),'list="riPeopleOptions" autocomplete="off"')}
      ${input('Start date','start','date',data.start,'required')}${input('End date','end','date',data.end,'required')}
      ${select('Status','status',taskStates,data.status)}${input('Progress %','progress','number',data.progress,'min="0" max="100" step="1" required')}
      </div>${people.html}`,async form=>{
        const values=Object.fromEntries(new FormData(form));
        const update={...values,id,owner:people.idFor(values.owner.trim(),data.owner),progress:Number(values.progress)};
        const tasks=task?p.tasks.map(t=>t.id===id?update:t):[...p.tasks,update];
        await saveProject(row,row.id,operation,{...p,tasks});
      });
  }
  async function projectAction(action,key,b) {
    const [id,taskId]=key.split('|');
    const row=projects.rows.find(r=>r.id===id),task=row?.data.tasks.find(t=>t.id===taskId);
    if(action==='new-project')projectDialog();
    else if(action==='edit-project'&&row)projectDialog(row);
    else if(action==='add-task'&&row)taskDialog(row);
    else if(action==='edit-task'&&task)taskDialog(row,task);
    else if(action==='project-ppt'&&row){
      b.disabled=true;try{await WlfExports.projectPpt(row.data,projects.people);}finally{b.disabled=false;}
    } else if(action==='delete-task'&&task&&owner(row)){
      if(!confirm('Delete this task from the project?'))return;
      b.disabled=true;try{
        await saveProject(row,id,crypto.randomUUID(),{...row.data,tasks:row.data.tasks.filter(t=>t.id!==task.id)});
      }finally{b.disabled=false;}
    } else if(action==='delete-project'&&row&&owner(row)){
      if(!confirm('Remove this project and its tasks?'))return;
      b.disabled=true;try{
        await call('deleteRiProject',{id,revision:row.revision,operation:crypto.randomUUID()});await loadProjects();
      }finally{b.disabled=false;}
    } else if(['project-next','project-prev','refresh-projects'].includes(action)){
      if(action==='project-next'&&projects.next)projects.cursors.push(projects.next);
      if(action==='project-prev')projects.cursors.pop();
      await loadProjects();
    }
  }
  async function dashboard() {
    const node=el('riDashboard');
    if(!node||!SESSION)return;
    try{
      const data=await call('getRiDashboard');
      if(!node.isConnected)return;
      node.innerHTML=[['activity','R&I Team Activity',activityTab],['projects','R&I Project Manager',projectTab]]
        .filter(([key])=>data[key]).map(([key,title,tab])=>`<section class="card">
          <div class="review-heading"><h3>${h(title)}</h3>${button('Open','dashboard-open',tab)}</div>
          <div class="support-stat-row">${Object.entries(data[key]).map(([status,n])=>'<div><b>'+Number(n)+'</b><span>'+
          h(status)+'</span></div>').join('')||'<p class="note">No records yet.</p>'}</div></section>`).join('');
      attachActions(node,(_,id)=>openTab(id));
    }catch(err){if(SESSION&&node.isConnected)node.textContent=cleanError(err);}
  }
  function open(tab) {
    const node=el('tab-'+tab);
    node.innerHTML='<div class="card">Loading live records…</div>';
    if(tab===activityTab)refreshCategories().catch(err=>{if(SESSION)node.textContent=cleanError(err);});
    if(tab===projectTab)loadProjects();
  }
  document.addEventListener('DOMContentLoaded',()=>{
    const docs=document.querySelector('#nav [data-tab="documents"]');
    const activityIcon='<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><path d="M5 4h14v16H5zM8 9h8M8 13h8M8 17h5"/></svg>';
    const projectIcon='<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><path d="M3 5h18v14H3zM6 9h6m-2 4h7m-4 3h5"/></svg>';
    docs.insertAdjacentHTML('afterend','<button data-tab="'+activityTab+'" hidden>'+activityIcon+'R&I Team Activity</button>'+
      '<button data-tab="'+projectTab+'" hidden>'+projectIcon+'R&I Project Manager</button>');
    document.querySelector('.content').insertAdjacentHTML('beforeend','<section id="tab-'+activityTab+'" class="tab-content hidden"></section>'+
      '<section id="tab-'+projectTab+'" class="tab-content hidden"></section>');
    document.body.insertAdjacentHTML('beforeend','<dialog id="wlfRiDialog" class="wlf-tools-dialog"></dialog>');
    PAGES[activityTab]=['R&I Team Activity','Team activity, supplier cooperation, sales support and reports'];
    PAGES[projectTab]=['R&I Project Manager','Project ownership, work progress and submission-ready presentations'];
  });
  window.addEventListener('wlf-logout',()=>{
    reset();
    for(const id of ['tab-'+activityTab,'tab-'+projectTab,'riDashboard','wlfRiDialog']){
      const node=el(id);if(node?.open)node.close();node?.replaceChildren();
    }
  });
  return {open,dashboard};
})();
