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
  function control(field,value,editing) {
    const label=h(field.label)+(field.required?' *':'');
    const options=field.options||[];
    const mode=auto(field);
    if (value==null && !editing) value=mode==='today'?date():mode==='name'?SESSION?.name:mode==='empid'?SESSION?.empId:mode==='identity'?[SESSION?.name,SESSION?.empId].filter(Boolean).join(' - '):'';
    const id='dynamic-'+field.id;
    const inputId=h(id), inputName=h(field.id);
    const input=' id="'+inputId+'" name="'+inputName+'"'+(field.required?' required':'');
    const details=field.help?'<details class="field-help"><summary>Help</summary><p>'+h(field.help)+'</p></details>':'';
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
    return fields.map(field=>control(field,values[field.id],editing)).join('');
  }
  function values(form,fields) {
    const data = new FormData(form);
    return Object.fromEntries(fields.map(f=>{
      const group=f.type==='multi'||f.type==='checkbox'&&f.options?.length;
      let value=group ? data.getAll(f.id) : f.type==='checkbox' ? data.has(f.id) : data.get(f.id)||'';
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
  function row(field) {
    return '<fieldset class="schema-field" data-field-id="'+h(field.id)+'"><legend>Form field</legend>'+
      '<div class="review-fields"><label>Field label<input class="schema-label" maxlength="180" required value="'+h(field.label)+'"></label>'+
      '<label>Field type<select class="schema-type">'+Object.entries(types).map(([v,l])=>option(v,l,field.type)).join('')+'</select></label>'+
      '<label>Auto-fill<select class="schema-auto">'+Object.entries(autoOptions).map(([v,l])=>option(v,l,field.autoFill||'')).join('')+'</select></label></div>'+
      '<label>Help text<textarea class="schema-help" rows="2" maxlength="2000">'+h(field.help)+'</textarea></label>'+
      '<label>Options (one per line). Leave blank for a single checkbox.<textarea class="schema-options" rows="3">'+
      h((field.options||[]).join('\n'))+'</textarea></label>'+
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
    root.addEventListener('click',event=>{
      const button=event.target.closest('[data-wlf-field]');
      if (!button || !root.contains(button)) return;
      const action=button.dataset.wlfField, field=button.closest('.schema-field');
      if (action==='add') root.querySelector('[data-wlf-fields]').insertAdjacentHTML('beforeend',row({
        id:'custom-'+crypto.randomUUID(),label:'',type:'text'
      }));
      if (action==='remove') field.remove();
      if (action==='up' && field.previousElementSibling) field.previousElementSibling.before(field);
      if (action==='down' && field.nextElementSibling) field.after(field.nextElementSibling);
    });
  }
  function read(root) {
    return Array.from(root.querySelectorAll('.schema-field'),node=>({
      id:node.dataset.fieldId,label:node.querySelector('.schema-label').value.trim(),
      type:node.querySelector('.schema-type').value,help:node.querySelector('.schema-help').value,
      autoFill:node.querySelector('.schema-auto').value,required:node.querySelector('.schema-required').checked,
      options:[...new Set(node.querySelector('.schema-options').value.split('\n').map(x=>x.trim()).filter(Boolean))]
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
  document.addEventListener('click',event=>{
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
