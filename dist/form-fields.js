/* Shared dynamic form controls for Technical Support and R&I Team Activity. */
const WlfFields = (() => {
  'use strict';
  const h = value => esc(String(value ?? ''));
  const types = {
    text: 'Text', textarea: 'Long text', date: 'Date', number: 'Number', select: 'Dropdown',
    radio: 'Single choice', multi: 'Multi-select', checkbox: 'Checkbox'
  };
  const autoOptions = {'':'By field name', identity:'Login Name & ID', today:'Today (Dhaka)', none:'Off'};
  const option = (value,label,current) => '<option value="'+h(value)+'"'+(value===current?' selected':'')+'>'+h(label)+'</option>';
  const date = () => AccessCore.dateKey(new Date());
  const display = value => Array.isArray(value) ? value.join(', ') : typeof value==='boolean' ? (value?'Yes':'No') : String(value??'');
  function auto(field) {
    if (field.autoFill==='none') return '';
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
    if (value==null && !editing) value=mode==='today'?date():mode==='identity'?SESSION?.name:'';
    const id='dynamic-'+field.id;
    const inputId=h(id), inputName=h(field.id);
    const input=' id="'+inputId+'" name="'+inputName+'"'+(field.required?' required':'');
    const details=field.help?'<details class="field-help"><summary>Help</summary><p>'+h(field.help)+'</p></details>':'';
    let body;
    if (field.type==='radio' || field.type==='multi' || field.type==='checkbox' && options.length) {
      const chosen=Array.isArray(value)?value:[value];
      const radios=field.type==='radio';
      const choices=options.map((choice,i)=>'<label class="wlf-choice" for="'+inputId+'-'+i+'"><input id="'+inputId+'-'+i+
        '" type="'+(radios?'radio':'checkbox')+'" name="'+inputName+'" value="'+h(choice)+'"'+
        (chosen.includes(choice)?' checked':'')+(radios&&field.required?' required':'')+'> '+h(choice)+'</label>');
      return '<fieldset class="wlf-choices span-all"><legend>'+label+'</legend><div>'+choices.join('')+'</div>'+details+'</fieldset>';
    }
    if (field.type==='checkbox') {
      return '<div class="field"><label class="wlf-choice" for="'+inputId+'"><input type="checkbox"'+input+
        (value===true?' checked':'')+'> '+label+'</label>'+details+'</div>';
    }
    if (field.type==='select') {
      body='<select'+input+'>'+option('','Select…',value)+options.map(o=>option(o,o,value)).join('')+'</select>';
    } else if (field.type==='textarea' || field.type==='text' && /^(problem|problem details|remarks|task details|solution details)$/i.test(field.label)) {
      body='<textarea rows="3" maxlength="4000"'+input+(mode?' readonly':'')+'>'+h(value)+'</textarea>';
    } else {
      body='<input type="'+(field.type==='date'?'date':'text')+'" maxlength="4000"'+input+
        (field.type==='number'?' inputmode="decimal"':'')+
        (mode?' readonly':'')+' value="'+h(value)+'">';
    }
    return '<div class="field"><label for="'+inputId+'">'+label+'</label>'+body+details+'</div>';
  }
  function inputs(fields,values={},editing=false) {
    return fields.map(field=>control(field,values[field.id],editing)).join('');
  }
  function values(form,fields) {
    const data = new FormData(form);
    return Object.fromEntries(fields.map(f=>{
      const group=f.type==='multi'||f.type==='checkbox'&&f.options?.length;
      const value=group ? data.getAll(f.id) : f.type==='checkbox' ? data.has(f.id) : data.get(f.id)||'';
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
  return {inputs,values,editor,bind,read,display,option};
})();
