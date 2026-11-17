/* Shared dynamic form controls for Technical Support and R&I Team Activity. */
const WlfFields = (() => {
  'use strict';
  const h = value => esc(String(value ?? ''));
  const types = {
    text: 'Text', textarea: 'Long text', date: 'Date', number: 'Number', select: 'Dropdown',
    radio: 'Single choice', multi: 'Multi-select', checkbox: 'Checkbox'
  };
  const autoOptions = {'':'By field name', name:'Login Name', empid:'Login ID', identity:'Login Name & ID (one field)', today:'Today (Dhaka)', none:'Off'};
  const option = (value,label,current) => '<option value="'+h(value)+'"'+(value===current?' selected':'')+'>'+h(label)+'</option>';
  const date = () => AccessCore.dateKey(new Date());
  // v2.5.1: an option named Other / Others / Other: asks for the name in a text box.
  // The value is saved in the same field as "Other: <name>" so lists and Excel keep it.
  const otherBase = o => String(o||'').trim().replace(/:+$/,'').trim();
  const isOther = o => /^others?$/i.test(otherBase(o));
  const otherText = (o,value) => { const p=otherBase(o)+': '; return typeof value==='string'&&value.startsWith(p)?value.slice(p.length):null; };
  const display = value => Array.isArray(value) ? value.join(', ') : typeof value==='boolean' ? (value?'Yes':'No') : String(value??'');
  function auto(field) {
    if (field.autoFill==='none') return '';
    if (['text','textarea'].includes(field.type) && (field.autoFill==='name' || field.autoFill==='empid')) return field.autoFill;
    if (field.type==='date' && (field.autoFill==='today' || field.id==='submitted_date')) return 'today';
    if (['text','textarea'].includes(field.type) && (field.autoFill==='identity'
      || ['identity','field_1674702979'].includes(field.id)
      || ['name & id','name & (id)','name (id)','full name-id','responder name & id'].includes(field.label.toLowerCase()))) return 'identity';
    return '';
  }
  function control(field,value,editing,all) {
    const label=h(field.label)+(field.required?' *':'');
    const options=field.options||[];
    const mode=auto(field);
    if (value==null && !editing) value=mode==='today'?date():mode==='name'?SESSION?.name:mode==='empid'?SESSION?.empId:mode==='identity'?[SESSION?.name,SESSION?.empId].filter(Boolean).join(' - '):'';
    const id='dynamic-'+field.id;
    const inputId=h(id), inputName=h(field.id);
    const input=' id="'+inputId+'" name="'+inputName+'"'+(field.required?' required':'');
    const details=field.help?'<details class="field-help"><summary>Help</summary><p>'+h(field.help)+'</p></details>':'';
    // v2.5.2: sub-category list that depends on another field (e.g. Problem Category). Chosen in a popup.
    if (field.dependsOn) {
      const list=((field.optionMap||{})[String(all?.[field.dependsOn]??'')])||[];
      const cur=list.includes(value)?value:'';
      return '<div class="field wlf-dependent" data-depends-on="'+h(field.dependsOn)+'" data-dep-name="'+inputName+'" data-dep-label="'+h(field.label)+'" data-option-map="'+h(JSON.stringify(field.optionMap||{}))+'"'+(list.length?'':' hidden')+'>'+
        '<label for="'+inputId+'">'+h(field.label)+' *</label><input type="hidden" name="'+inputName+'" value="'+h(cur)+'">'+
        '<button type="button" class="wlf-pick" id="'+inputId+'" data-pick-for="'+inputName+'" aria-haspopup="dialog">'+(cur?h(cur):'Choose…')+'</button>'+details+'</div>';
    }
    // v2.5.1: Name, ID and today's date are filled by the server, so they are not shown in the form.
    if (mode) return '<input type="hidden"'+input.replace(' required','')+' value="'+h(value)+'" data-auto-fill="'+h(mode)+'">';
    const otherOpt=options.find(isOther);
    const otherBox=(current,shown)=>otherOpt?'<input type="text" class="wlf-other" data-other-for="'+inputName+'" maxlength="300" placeholder="Write the '+h(otherBase(otherOpt).toLowerCase())+' name" aria-label="'+h(field.label)+': '+h(otherBase(otherOpt))+' name" value="'+h(current||'')+'"'+(shown?'':' hidden')+'>':'';
    let body;
    if (field.type==='radio' || field.type==='multi' || field.type==='checkbox' && options.length) {
      const chosen=Array.isArray(value)?value:[value];
      const radios=field.type==='radio';
      let otherValue=null;
      if (otherOpt) chosen.forEach(v=>{const t=otherText(otherOpt,v);if(t!=null)otherValue=t;});
      const picked=choice=>chosen.includes(choice)||(choice===otherOpt&&otherValue!=null);
      const choices=options.map((choice,i)=>'<label class="wlf-choice" for="'+inputId+'-'+i+'"><input id="'+inputId+'-'+i+
        '" type="'+(radios?'radio':'checkbox')+'" name="'+inputName+'" value="'+h(choice)+'"'+
        (picked(choice)?' checked':'')+(radios&&field.required?' required':'')+'> '+h(choice)+'</label>');
      return '<fieldset class="wlf-choices span-all"><legend>'+label+'</legend><div>'+choices.join('')+'</div>'+otherBox(otherValue,otherOpt&&picked(otherOpt))+details+'</fieldset>';
    }
    if (field.type==='checkbox') {
      return '<div class="field"><label class="wlf-choice" for="'+inputId+'"><input type="checkbox"'+input+
        (value===true?' checked':'')+'> '+label+'</label>'+details+'</div>';
    }
    if (field.type==='select') {
      const otherValue=otherOpt?otherText(otherOpt,value):null;
      const current=otherValue!=null?otherOpt:value;
      body='<select'+input+'>'+option('','Select…',current)+options.map(o=>option(o,o,current)).join('')+'</select>'+otherBox(otherValue,otherOpt&&current===otherOpt);
    } else if (field.type==='textarea' || field.type==='text' && /^(problem|problem details|remarks|task details|solution details)$/i.test(field.label)) {
      body='<textarea rows="3" maxlength="4000"'+input+'>'+h(value)+'</textarea>';
      return '<div class="field span-all"><label for="'+inputId+'">'+label+'</label>'+body+details+'</div>';
    } else {
      body='<input type="'+(field.type==='date'?'date':'text')+'" maxlength="4000"'+input+
        (field.type==='number'?' inputmode="decimal"':'')+
        ' value="'+h(value)+'">';
    }
    const wide=field.type!=='date'&&field.type!=='number'&&field.type!=='select'&&/^(task name|task details|project \/ task name|problem details|solution statement|possible damage reason|note.*)$/i.test(field.label.trim());
    return '<div class="field'+(wide?' span-all':'')+'"><label for="'+inputId+'">'+label+'</label>'+body+details+'</div>';
  }
  function inputs(fields,values={},editing=false) {
    return fields.map(field=>control(field,values[field.id],editing,values||{})).join('');
  }
  function values(form,fields) {
    const data = new FormData(form);
    return Object.fromEntries(fields.map(f=>{
      const group=f.type==='multi'||f.type==='checkbox'&&f.options?.length;
      let value=group ? data.getAll(f.id) : f.type==='checkbox' ? data.has(f.id) : data.get(f.id)||'';
      if (f.dependsOn) {
        const holder=form.querySelector('[data-dep-name="'+CSS.escape(f.id)+'"]');
        if (holder && !holder.hidden && !value) { openPicker(holder); throw Error('Choose the '+f.label+'.'); }
        return [f.id, holder && !holder.hidden ? value : ''];
      }
      const otherOpt=(f.options||[]).find(isOther);
      if (otherOpt && f.type!=='checkbox' || otherOpt && group) {
        const withName=v=>{ if(v!==otherOpt) return v;
          const box=form.querySelector('[data-other-for="'+CSS.escape(f.id)+'"]'), name=(box?.value||'').trim();
          if (!name) { box?.focus(); throw Error('Write the '+otherBase(otherOpt).toLowerCase()+' name for: '+f.label); }
          return otherBase(otherOpt)+': '+name; };
        value=Array.isArray(value)?value.map(withName):withName(value);
      }
      if (f.required && (!value || Array.isArray(value)&&!value.length)) throw Error('Required: '+f.label);
      return [f.id,value];
    }));
  }
  function subLists(field) {
    if (!field.dependsOn) return '';
    const map=field.optionMap||{};
    return '<div class="schema-sublists" data-depends-on="'+h(field.dependsOn)+'"><p class="note">Sub-category lists: when a user chooses one of these options in the field above, its list opens in a popup and one item must be chosen. One item per line; empty a list to remove it.</p>'+
      Object.keys(map).map(k=>subList(k,map[k])).join('')+
      '<div class="engineering-actions"><select class="schema-sublist-new" aria-label="Add a list for"><option value="">Add a list for…</option></select><button type="button" class="btn ghost" data-wlf-field="add-list">+ Add list</button></div></div>';
  }
  function subList(key,items) {
    return '<details class="schema-sublist"><summary>'+h(key)+' <small>('+items.length+')</small></summary><textarea class="schema-sublist-items" data-key="'+h(key)+'" rows="8">'+h(items.join('\n'))+'</textarea></details>';
  }
  function row(field) {
    return '<fieldset class="schema-field" data-field-id="'+h(field.id)+'"'+(field.dependsOn?' data-depends-on="'+h(field.dependsOn)+'"':'')+'><legend>Form field</legend>'+
      '<div class="review-fields"><label>Field label<input class="schema-label" maxlength="180" required value="'+h(field.label)+'"></label>'+
      '<label>Field type<select class="schema-type">'+Object.entries(types).map(([v,l])=>option(v,l,field.type)).join('')+'</select></label>'+
      '<label>Auto-fill<select class="schema-auto">'+Object.entries(autoOptions).map(([v,l])=>option(v,l,field.autoFill||'')).join('')+'</select></label></div>'+
      '<label>Help text<textarea class="schema-help" rows="2" maxlength="2000">'+h(field.help)+'</textarea></label>'+
      '<label'+(field.dependsOn?' hidden':'')+'>Options (one per line). Leave blank for a single checkbox.<textarea class="schema-options" rows="3">'+
      h((field.options||[]).join('\n'))+'</textarea></label>'+subLists(field)+
      '<label class="wlf-choice"><input type="checkbox" class="schema-required"'+(field.required?' checked':'')+'> Required</label>'+
      '<div class="engineering-actions"><button type="button" class="btn ghost" data-wlf-field="up" aria-label="Move field up">↑</button>'+
      '<button type="button" class="btn ghost" data-wlf-field="down" aria-label="Move field down">↓</button>'+
      '<button type="button" class="btn ghost" data-wlf-field="remove">Delete field</button></div></fieldset>';
  }
  function editor(fields) {
    return '<div data-wlf-fields>'+fields.map(row).join('')+'</div>'+
      '<button type="button" class="btn ghost" data-wlf-field="add">+ Add field</button>';
  }
  function bind(root) {
    // the "Add a list for" choices come from the parent field's current options
    root.addEventListener('focusin',event=>{
      const pick=event.target.closest('.schema-sublist-new'); if(!pick) return;
      const field=pick.closest('.schema-field'), parent=root.querySelector('.schema-field[data-field-id="'+CSS.escape(field.dataset.dependsOn)+'"]');
      const have=new Set(Array.from(field.querySelectorAll('.schema-sublist-items'),t=>t.dataset.key));
      const opts=parent?parent.querySelector('.schema-options').value.split('\n').map(x=>x.trim()).filter(Boolean):[];
      pick.innerHTML='<option value="">Add a list for…</option>'+opts.filter(o=>!have.has(o)).map(o=>option(o,o,'')).join('');
    });
    root.addEventListener('click',event=>{
      const button=event.target.closest('[data-wlf-field]');
      if (!button || !root.contains(button)) return;
      const action=button.dataset.wlfField, field=button.closest('.schema-field');
      if (action==='add') root.querySelector('[data-wlf-fields]').insertAdjacentHTML('beforeend',row({
        id:'custom-'+crypto.randomUUID(),label:'',type:'text'
      }));
      if (action==='remove') field.remove();
      if (action==='add-list') {
        const pick=field.querySelector('.schema-sublist-new'), key=pick.value;
        if (key && !field.querySelector('.schema-sublist-items[data-key="'+CSS.escape(key)+'"]')) {
          field.querySelector('.schema-sublists > .engineering-actions').insertAdjacentHTML('beforebegin',subList(key,[]));
          const added=field.querySelectorAll('.schema-sublist'); added[added.length-1].open=true; added[added.length-1].querySelector('textarea').focus();
        }
      }
      if (action==='up' && field.previousElementSibling) field.previousElementSibling.before(field);
      if (action==='down' && field.nextElementSibling) field.after(field.nextElementSibling);
    });
  }
  function read(root) {
    return Array.from(root.querySelectorAll('.schema-field'),node=>({
      id:node.dataset.fieldId,label:node.querySelector('.schema-label').value.trim(),
      type:node.querySelector('.schema-type').value,help:node.querySelector('.schema-help').value,
      autoFill:node.querySelector('.schema-auto').value,required:node.querySelector('.schema-required').checked,
      options:node.dataset.dependsOn?[]:[...new Set(node.querySelector('.schema-options').value.split('\n').map(x=>x.trim()).filter(Boolean))],
      ...(node.dataset.dependsOn?{dependsOn:node.dataset.dependsOn,optionMap:Object.fromEntries(Array.from(node.querySelectorAll('.schema-sublist-items'),t=>
        [t.dataset.key,[...new Set(t.value.split('\n').map(x=>x.trim()).filter(Boolean))]]).filter(([,v])=>v.length))}:{})
    }));
  }
  // Show the Other box only while Other is chosen; a click anywhere in a date box opens the calendar.
  document.addEventListener('change',event=>{
    const t=event.target; if(!t||!t.name) return;
    const box=t.closest('form')?.querySelector('[data-other-for="'+CSS.escape(t.name)+'"]'); if(!box) return;
    const holder=t.closest('fieldset')||t.closest('.field'); const chosen=Array.from((holder||document).querySelectorAll('[name="'+CSS.escape(t.name)+'"]'))
      .some(x=>x.tagName==='SELECT'?isOther(x.value):x.checked&&isOther(x.value));
    box.hidden=!chosen; if(chosen&&event.isTrusted) box.focus();
  });
  // v2.5.2: show/hide the sub-category when its parent changes; open the popup straight away when there is a list.
  document.addEventListener('change',event=>{
    const t=event.target, form=t&&t.name&&t.closest('form'); if(!form) return;
    form.querySelectorAll('.wlf-dependent[data-depends-on="'+CSS.escape(t.name)+'"]').forEach(holder=>{
      const list=JSON.parse(holder.dataset.optionMap||'{}')[t.value]||[], input=holder.querySelector('input[type=hidden]'), btn=holder.querySelector('.wlf-pick');
      holder.hidden=!list.length; if(!list.includes(input.value)){input.value='';btn.textContent='Choose…';}
      if(list.length&&event.isTrusted) openPicker(holder);
    });
  });
  function openPicker(holder) {
    const form=holder.closest('form'), parent=form&&form.querySelector('[name="'+CSS.escape(holder.dataset.dependsOn)+'"]');
    const list=JSON.parse(holder.dataset.optionMap||'{}')[parent?parent.value:'']||[]; if(!list.length) return;
    let dlg=document.getElementById('wlfPicker');
    if(!dlg){dlg=document.createElement('dialog');dlg.id='wlfPicker';dlg.className='wlf-picker';document.body.appendChild(dlg);}
    dlg.innerHTML='<div class="wlf-picker-head"><h3 id="wlfPickerTitle">'+h(holder.dataset.depLabel)+'</h3><button type="button" class="tb-close" data-picker-close aria-label="Close">×</button></div>'+
      '<p class="note">'+h(parent.value)+' · '+list.length+' item(s)</p><input type="search" class="wlf-picker-search" placeholder="Search…" aria-label="Search '+h(holder.dataset.depLabel)+'">'+
      '<div class="wlf-picker-list" role="listbox" aria-labelledby="wlfPickerTitle">'+list.map(x=>'<button type="button" role="option" data-pick="'+h(x)+'">'+h(x)+'</button>').join('')+'</div>';
    dlg.setAttribute('aria-labelledby','wlfPickerTitle');
    const search=dlg.querySelector('.wlf-picker-search');
    search.oninput=()=>{const q=search.value.trim().toLowerCase().replace(/\s+/g,' ');dlg.querySelectorAll('[data-pick]').forEach(b=>{b.hidden=q&&!b.dataset.pick.toLowerCase().includes(q);});};
    dlg.onclick=e=>{const b=e.target.closest('[data-pick]');if(b){const input=holder.querySelector('input[type=hidden]');input.value=b.dataset.pick;holder.querySelector('.wlf-pick').textContent=b.dataset.pick;dlg.close();holder.querySelector('.wlf-pick').focus();}
      else if(e.target===dlg||e.target.closest('[data-picker-close]'))dlg.close();};
    try{dlg.showModal();}catch(e){dlg.setAttribute('open','');}
    search.focus();
  }
  document.addEventListener('click',event=>{
    const pick=event.target.closest&&event.target.closest('.wlf-pick'); if(pick){openPicker(pick.closest('.wlf-dependent'));return;}
    const t=event.target; if(t&&t.tagName==='INPUT'&&t.type==='date'&&!t.readOnly&&!t.disabled&&typeof t.showPicker==='function'){try{t.showPicker();}catch(e){}}
  });
  // v2.5.1: confirmation after the server has saved a submission.
  function savedPopup(title,lines) {
    let dlg=document.getElementById('wlfSavedDialog');
    if(!dlg){dlg=document.createElement('dialog');dlg.id='wlfSavedDialog';dlg.className='wlf-saved-dialog';dlg.setAttribute('aria-labelledby','wlfSavedTitle');document.body.appendChild(dlg);
      dlg.addEventListener('click',e=>{if(e.target===dlg||e.target.closest('[data-saved-close]'))dlg.close();});}
    dlg.innerHTML='<div class="wlf-saved-body"><div class="wlf-saved-tick" aria-hidden="true">✓</div><h3 id="wlfSavedTitle">'+h(title)+'</h3>'+
      '<dl>'+lines.filter(x=>x&&x[1]).map(([k,v])=>'<dt>'+h(k)+'</dt><dd>'+h(v)+'</dd>').join('')+'</dl>'+
      '<button type="button" class="btn" data-saved-close autofocus>OK</button></div>';
    try{dlg.showModal();}catch(e){dlg.setAttribute('open','');}
  }
  return {inputs,values,editor,bind,read,display,option,isOther,savedPopup};
})();
