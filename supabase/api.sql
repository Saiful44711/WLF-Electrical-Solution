begin;
create function wlf_private.options() returns jsonb language sql stable security definer set search_path='' as $$
 select '[{"id":"group-mot-error","controller":"MOT","kind":"error"},{"id":"group-nice-error","controller":"NICE3000+","kind":"error"}]'::jsonb || coalesce(jsonb_agg(jsonb_build_object('id',id,'controller',controller,'kind',content->>'kind','category',content->>'category')) filter(where controller='GENERAL' or content->>'kind'='procedure'),'[]') from public.wlf_troubleshooting where not deleted and wlf_private.approved()$$;
create function wlf_private.catalog() returns jsonb language sql stable security definer set search_path='' as $$
 select '[{"key":"selection","label":"Component Selection","group":"Workspace"},{"key":"calc:travel","label":"Travel Time","group":"Calculations"},{"key":"calc:power","label":"Total Power","group":"Calculations"},{"key":"calc:speed","label":"Nominal Speed & Slip frequency","group":"Calculations"},{"key":"calc:motor","label":"Motor Power Justification","group":"Calculations"},{"key":"calc:energy","label":"Energy Bill","group":"Calculations"},{"key":"calc:solar","label":"Solar Sizing","group":"Calculations"},{"key":"support:commissioning:request","label":"Commissioning / Submit & own status","group":"Technical Support"},{"key":"support:aftersales:request","label":"After Sales / Submit & own status","group":"Technical Support"},{"key":"dashboard","label":"Dashboard","group":"Workspace"}]'::jsonb || coalesce((select jsonb_agg(jsonb_build_object('key',case when e->>'controller'='GENERAL' then 'tb:general:'||(e->>'id') when e->>'kind'='procedure' then 'tb:option:'||(e->>'id') else 'tb:'||(e->>'controller')||':error' end,'label',(e->>'controller')||' / '||coalesce(nullif(e->>'category',''),'Error Solution'),'group','Troubleshooting')) from jsonb_array_elements(wlf_private.options()) e),'[]')$$;
create function wlf_private.summary() returns jsonb language plpgsql stable security definer set search_path='' as $$declare u public.wlf_profiles;out jsonb;begin
 u=wlf_private.me();
 with grouped as materialized(select category,status,count(*) n from public.wlf_requests where deleted_at is null and u.status='Approved'and(u.role<>'User'or(created_by=u.id and ('support:'||category||':request')=any(u.permissions)))group by category,status),
 counts as(select c.category,coalesce(sum(g.n)filter(where g.status='Pending'),0)p,coalesce(sum(g.n)filter(where g.status<>'Solved'),0)o,coalesce(jsonb_object_agg(g.status,g.n)filter(where g.status is not null),'{}')st from(values('commissioning'),('aftersales'))c(category)left join grouped g on g.category=c.category group by c.category)
 select jsonb_build_object('pending',jsonb_object_agg(category,p),'open',jsonb_object_agg(category,o),'statuses',jsonb_object_agg(category,st),'version',clock_timestamp(),'user',wlf_private.safe_user(u))into out from counts;return out;
 end$$;
 create function wlf_private.ticket(r public.wlf_requests,full_data boolean default true) returns jsonb language sql stable security definer set search_path='' as $$
 select jsonb_build_object('id',r.id,'reference',r.reference,'category',r.category,'status',r.status,'createdBy',(select email from public.wlf_profiles where id=r.created_by),'assignedTo',coalesce((select email from public.wlf_profiles where id=r.assigned_to),''),'createdAt',r.created_at,'updatedAt',r.updated_at,'revision',r.revision,'values',r.values,'formSchema',case when full_data then r.form_schema else '{}'::jsonb end,'solution',case when full_data then r.solution else '' end,'solvedBy',coalesce((select email from public.wlf_profiles where id=r.solved_by),''),'solvedAt',r.solved_at,'notSolvedBy',coalesce((select email from public.wlf_profiles where id=r.not_solved_by),''),'notSolvedAt',r.not_solved_at,'history',case when full_data then coalesce((select jsonb_agg(ev order by hid) from(select h.id hid,jsonb_build_object('at',h.at,'actor',p.email,'action',h.action,'comment',h.comment,'to',coalesce(q.email,'')) ev from public.wlf_history h join public.wlf_profiles p on p.id=h.actor left join public.wlf_profiles q on q.id=h.to_user where h.request_id=r.id order by h.id desc limit 150)x),'[]') else '[]'::jsonb end)$$;
create function wlf_private.filtered(f jsonb) returns setof public.wlf_requests language sql stable security definer set search_path='' as $$
 select r.* from public.wlf_requests r where r.deleted_at is null and wlf_private.visible(r.category,r.created_by)
 and(coalesce(f->>'category','')='' or r.category=f->>'category')
 and(coalesce(f->>'status','')='' or r.status=f->>'status')
 and(coalesce(f->>'assignee','')='' or r.assigned_to=(select id from public.wlf_profiles where email=f->>'assignee'))
 and(coalesce(f->>'engineer','')='' or case when f->>'dateBasis'='solved' or f->>'status'='Solved' then r.solved_by=(select id from public.wlf_profiles where email=f->>'engineer') else exists(select 1 from public.wlf_history h join public.wlf_profiles p on p.id=h.actor where h.request_id=r.id and p.email=f->>'engineer' and h.action in ('receive','solve','forward','notSolved','pending')) end)
 and(coalesce(f->>'from','')='' or (case when f->>'dateBasis'='solved' then r.solved_at else r.created_at end at time zone 'Asia/Dhaka')::date >= (f->>'from')::date)
 and(coalesce(f->>'to','')='' or (case when f->>'dateBasis'='solved' then r.solved_at else r.created_at end at time zone 'Asia/Dhaka')::date <= (f->>'to')::date)
 and(coalesce(f->>'query','')='' or position(lower(left(f->>'query',200)) in lower(r.search_text||' '||r.reference||' '||r.id||' '||r.solution))>0)
 order by r.updated_at desc,r.id$$;
create function wlf_private.validate_values(form jsonb,v jsonb) returns jsonb language plpgsql immutable set search_path='' as $$declare f jsonb;x jsonb;out jsonb='{}';txt text;begin
 if jsonb_typeof(v)<>'object' or length(v::text)>30000 then raise exception 'Invalid or oversized form';end if;
 for f in select * from jsonb_array_elements(form->'fields') loop
 x=coalesce(v->(f->>'id'),case when f->>'type'='multi' then '[]'::jsonb else '""'::jsonb end);
 if f->>'type'='multi' then
 if jsonb_typeof(x)<>'array' then raise exception 'Invalid multiple choice';end if;
 else
 if jsonb_typeof(x)<>'string' then raise exception 'Invalid field value';end if;
 txt=btrim(x#>>'{}');if length(txt)>4000 then raise exception 'Field text too long';end if;x=to_jsonb(txt);
 if f->>'type'='date' and txt<>'' then if txt !~ '^\d{4}-\d{2}-\d{2}$' or to_char(txt::date,'YYYY-MM-DD')<>txt then raise exception 'Invalid date';end if;end if;
 end if;
 if (f->>'required')::boolean and (x='""'::jsonb or x='[]'::jsonb) then raise exception 'Required: %',f->>'label';end if;
 if jsonb_array_length(coalesce(f->'options','[]'))>0 then
 if exists(select 1 from jsonb_array_elements(case when f->>'type'='multi' then x else jsonb_build_array(x) end) a where a<>'""'::jsonb and not(f->'options' @> jsonb_build_array(a))) then raise exception 'Invalid choice: %',f->>'label';end if;
 end if;out=out||jsonb_build_object(f->>'id',x);
 end loop;return out;end$$;
create function wlf_private.ref(c text,v jsonb,f jsonb) returns text language plpgsql immutable set search_path='' as $$declare lid text;dt text;begin
 select v->>(x->>'id') into lid from jsonb_array_elements(f->'fields')x where x->>'id'='field_1369800003' or lower(x->>'label') in('project lift id','lift id') limit 1;
 select v->>(x->>'id') into dt from jsonb_array_elements(f->'fields')x where x->>'id'='submitted_date' or x->>'id'='field_2064608726' or lower(x->>'label') in('submitted date','date','date of incident') order by case when x->>'id'='submitted_date'then 0 else 1 end limit 1;
 if coalesce(lid,'')='' or coalesce(dt,'')='' then raise exception 'Lift ID and Date are required';end if;
 return (case when c='commissioning' then 'TCS-' else 'TAS-' end)||btrim(lid)||'-'||to_char(dt::date,'YYYYMMDD');end$$;
create function wlf_private.usage_stats()returns jsonb language plpgsql stable security definer set search_path=''as $$
declare u public.wlf_profiles;topics text[];out jsonb;base text[]=array['Login','Component Selection','Travel Time Calculation','Power Calculation','Speed & Slip Calculation','Motor Power Justification','Energy Bill Calculation','Solar Sizing Calculation'];begin
 u=wlf_private.me();if not wlf_private.can('dashboard')then raise exception 'Permission denied';end if;
 topics=base||coalesce((select array_agg(action order by action)from(select distinct action from public.wlf_usage where(u.role<>'User'or actor=u.id)and not(action=any(base)))x),'{}'::text[]);
 with grouped as materialized(select actor,action,count(*)n,max(at)last_at from public.wlf_usage where u.role<>'User'or actor=u.id group by actor,action),
 people as(select p.id,p.email,p.name,p.role from public.wlf_profiles p where(u.role<>'User'or p.id=u.id)and(p.status='Approved'or exists(select 1 from grouped g where g.actor=p.id))),
 rows as(select p.email,p.name,p.role,coalesce((select sum(g.n)from grouped g where g.actor=p.id),0)total,
 coalesce((select max(g.last_at)::text from grouped g where g.actor=p.id),'-')last_active,
 (select jsonb_agg(coalesce(g.n,0)order by t.ord)from unnest(topics)with ordinality t(action,ord)left join grouped g on g.action=t.action and g.actor=p.id)counts from people p)
 select jsonb_build_object('topics',topics,'rows',coalesce((select jsonb_agg(jsonb_build_object('email',email,'name',name,'role',role,'total',total,'lastActive',last_active,'counts',counts)order by total desc)from rows),'[]'),'totals',(select jsonb_agg(n order by ord)from(select t.ord,coalesce(sum(g.n),0)n from unnest(topics)with ordinality t(action,ord)left join grouped g on g.action=t.action group by t.ord)x),'totalEvents',coalesce((select sum(n)from grouped),0))into out;return out;
end$$;
create function wlf_private.rpc(a text,args jsonb) returns jsonb language plpgsql security definer set search_path='' as $$
declare u public.wlf_profiles;target public.wlf_profiles;r public.wlf_requests;form public.wlf_forms;tr public.wlf_troubleshooting;
 raw jsonb=coalesce(args->0,'{}');out jsonb;arr jsonb;v jsonb;oldop public.wlf_operations;
 c text;op text;act text;comment text;rid uuid;toid uuid;cnt integer;lim integer;offst integer;rev integer;newref text;
begin
 if auth.uid() is null then raise exception 'SESSION_EXPIRED';end if;
 select * into u from public.wlf_profiles where id=auth.uid();
 if u.status is distinct from 'Approved' then raise exception 'SESSION_EXPIRED: Account is pending approval or inactive';end if;
 if length(args::text)>100000 then raise exception 'Request too large';end if;
 if a in('listAppUsers','adminListUsers','saveAppUserAccess','adminUpdateUser','adminResetPassword','resetAppUserPassword','adminSaveComponent','adminDeleteComponent','saveSupportSchema','editSupportRequest','deleteSupportRequest','saveTroubleshootingEntry','deleteTroubleshootingEntry','saveEngineeringRecord','exportBackup','restoreBackup') and u.role<>'Super Admin' then raise exception 'Permission denied: Super Admin only';end if;
 if a in('getSession','getAppContext') then
 out=wlf_private.safe_user(u)||jsonb_build_object('token',u.id,'isSuperAdmin',u.role='Super Admin','isAdmin',u.role<>'User' or 'dashboard'=any(u.permissions),'canCalculate',u.role<>'User' or exists(select 1 from unnest(u.permissions)k where k like 'calc:%'),'pendingCount',case when u.role='Super Admin' then(select count(*) from public.wlf_profiles where status='Pending')else 0 end,'index','[]'::jsonb,'bootstrapPending',true,'build','2.0.0');
 if a='getSession' then return out;end if;
 out=out||jsonb_build_object('user',wlf_private.safe_user(u),'directory',wlf_private.directory(),'optionEntries',wlf_private.options(),'summary',wlf_private.summary());
 if wlf_private.can('selection') or wlf_private.can('calc:energy') or wlf_private.can('calc:solar') then
 select jsonb_build_object('headers',(select value from public.wlf_settings where key='component_headers'),'records',coalesce(jsonb_agg(jsonb_build_object('sheetRow',id,'values',values) order by id),'[]')) into arr from public.wlf_components;out=out||jsonb_build_object('components',arr);end if;return out;
 elsif a in('refreshIndex','adminGetComponents','getComponentDetails') then
 if a='adminGetComponents' then if u.role='User' then raise exception 'Permission denied';end if;
 elsif not(wlf_private.can('selection') or wlf_private.can('calc:energy') or wlf_private.can('calc:solar')) then raise exception 'Permission denied';end if;
 return jsonb_build_object('headers',(select value from public.wlf_settings where key='component_headers'),'records',coalesce((select jsonb_agg(jsonb_build_object('sheetRow',id,'values',values) order by id)from public.wlf_components where a<>'getComponentDetails' or id=(args->>0)::bigint),'[]'));
 elsif a='adminSaveComponent' then
 v=args->1;if jsonb_typeof(v)<>'array' or jsonb_array_length(v)<>(select jsonb_array_length(value)from public.wlf_settings where key='component_headers') or length(v::text)>30000 then raise exception 'Invalid component columns';end if;
 for cnt in 0..3 loop if coalesce(btrim(v->>cnt),'')='' then raise exception 'First four fields required';end if;end loop;
 if args->>0 is null or args->>0='' then insert into public.wlf_components(values)values(v);else update public.wlf_components set values=v,revision=revision+1 where id=(args->>0)::bigint;if not found then raise exception 'Component not found';end if;end if;return 'true';
 elsif a='adminDeleteComponent' then delete from public.wlf_components where id=(args->>0)::bigint;return 'true';
 elsif a in('listAppUsers','adminListUsers') then
 select coalesce(jsonb_agg(wlf_private.safe_user(p)order by p.created_at),'[]')into arr from public.wlf_profiles p;return jsonb_build_object('users',arr,'catalog',wlf_private.catalog());
 elsif a='saveAppUserAccess' then
 select * into target from public.wlf_profiles where email=lower(raw->>'email')for update;
 if not found then raise exception 'User not found';end if;
 if target.id=u.id and(raw->>'role'<>'Super Admin' or raw->>'status'<>'Approved')then raise exception 'Cannot remove your own Super Admin access';end if;
 if target.access_revision is distinct from (raw->>'accessRevision')::integer then raise exception 'CONFLICT: Access changed';end if;
 if jsonb_typeof(raw->'permissions')<>'array' or jsonb_array_length(raw->'permissions')>500 or exists(select 1 from jsonb_array_elements_text(raw->'permissions')k where not exists(select 1 from jsonb_array_elements(wlf_private.catalog())x where x->>'key'=k))then raise exception 'Invalid permissions';end if;
 update public.wlf_profiles set role=raw->>'role',status=raw->>'status',permissions=array(select distinct jsonb_array_elements_text(raw->'permissions')),access_revision=access_revision+1 where id=target.id returning * into target;return wlf_private.safe_user(target);
 elsif a='getSupportSummary' then return wlf_private.summary();
 elsif a in('getSupportWorkspace','getSupportReport') then
 if a='getSupportReport' and u.role='User' then raise exception 'Permission denied';end if;
 if coalesce(raw->>'from','')<>'' and coalesce(raw->>'to','')<>'' and(raw->>'from')::date>(raw->>'to')::date then raise exception 'Invalid date range';end if;
 if a='getSupportReport' then lim=25;else lim=least(50,greatest(1,coalesce((raw->>'pageSize')::integer,25)));end if;offst=greatest(0,coalesce(nullif(raw->>'cursor','')::integer,0));
 select count(*)into cnt from wlf_private.filtered(raw) where a='getSupportReport' or coalesce(raw->>'category','')<>'';
 select coalesce(jsonb_agg(wlf_private.ticket(x,a='getSupportReport')),'[]')into arr from(select * from wlf_private.filtered(raw) where a='getSupportReport' or coalesce(raw->>'category','')<>'' limit lim offset offst)x;
 out=jsonb_build_object('tickets',arr,'total',cnt,'nextCursor',case when offst+lim<cnt then(offst+lim)::text else '' end,'cursor',offst::text,'summary',wlf_private.summary(),'user',wlf_private.safe_user(u),'users',wlf_private.directory(),'forms',coalesce((select jsonb_object_agg(category,schema||jsonb_build_object('revision',revision))from public.wlf_forms where wlf_private.team(category)),'{}'));
 if a='getSupportReport' then
 select coalesce(jsonb_agg(jsonb_build_object('email',p.email,'name',p.name,
 'received',(select count(distinct h.request_id)from public.wlf_history h join wlf_private.filtered(raw)f on f.id=h.request_id where h.actor=p.id and h.action='receive'),
 'forwarded',(select count(distinct h.request_id)from public.wlf_history h join wlf_private.filtered(raw)f on f.id=h.request_id where h.actor=p.id and h.action='forward'),
 'solved',(select count(*)from wlf_private.filtered(raw)f where f.status='Solved'and f.solved_by=p.id),
 'notSolved',(select count(*)from wlf_private.filtered(raw)f where f.status='Not Solved'and f.not_solved_by=p.id),
 'pending',(select count(*)from wlf_private.filtered(raw)f where f.status='Pending'and f.assigned_to=p.id),
 'inProgress',(select count(*)from wlf_private.filtered(raw)f where f.status='Received'and f.assigned_to=p.id))),'[]')into arr from public.wlf_profiles p where p.status='Approved'and p.role='R&I';
 out=out||jsonb_build_object('performance',arr,'totals',coalesce((select jsonb_object_agg(category,stats)from(select category,jsonb_object_agg(status,n)stats from(select category,status,count(*)n from wlf_private.filtered(raw)group by category,status)x group by category)y),'{}'));end if;return out;
 elsif a='getSupportRequest' then
 select * into r from public.wlf_requests where id=(args->>0)::uuid and deleted_at is null and wlf_private.visible(category,created_by);if not found then raise exception 'Request not found';end if;return wlf_private.ticket(r);
 elsif a in('createSupportRequest','transitionSupportRequest','editSupportRequest','deleteSupportRequest')then
 op=raw->>'mutationId';if op is null or op!~'^[-a-zA-Z0-9]{12,100}$'then raise exception 'Invalid operation ID';end if;
 perform pg_advisory_xact_lock(hashtextextended(u.id::text||op,0));
 select * into oldop from public.wlf_operations where actor=u.id and mutation_id=op;
 if found then
 if oldop.action<>a or oldop.payload<>raw then raise exception 'Operation ID reused with different data';end if;
 select * into r from public.wlf_requests where id=oldop.request_id;
 if not wlf_private.visible(r.category,r.created_by)or(r.deleted_at is not null and a<>'deleteSupportRequest')then raise exception 'Request no longer available';end if;
 return jsonb_build_object('id',r.id,'revision',r.revision,'status',r.status,'duplicate',true,'ticket',wlf_private.ticket(r),'summary',wlf_private.summary());end if;
 comment=left(coalesce(raw->>'comment',''),6000);act=raw->>'action';
 if a='createSupportRequest' then
 c=raw->>'category';if not wlf_private.team(c) or u.role not in('User','Super Admin')then raise exception 'Permission denied';end if;
 select * into form from public.wlf_forms where category=c;if not found then raise exception 'Unknown team';end if;
 v=wlf_private.validate_values(form.schema,raw->'values');newref=wlf_private.ref(c,v,form.schema);
 insert into public.wlf_requests(category,created_by,values,form_schema,reference,search_text)values(c,u.id,v,form.schema,newref,v::text)returning * into r;act='submit';comment='Request submitted';
 else
 select * into r from public.wlf_requests where id=(raw->>'id')::uuid and deleted_at is null for update;
 if not found or not wlf_private.visible(r.category,r.created_by)then raise exception 'Request not found';end if;
 if r.revision is distinct from (raw->>'revision')::integer then raise exception 'CONFLICT: Request changed. Refresh and review';end if;
 if a='transitionSupportRequest' then
 if u.role<>'R&I' or r.status='Solved' then raise exception 'Permission denied or request closed';end if;
 if act='receive' then
 if not((r.status='Pending' and(r.assigned_to is null or r.assigned_to=u.id)) or(r.status in('Forwarded','Not Solved')and r.assigned_to=u.id))then raise exception 'Request already assigned';end if;r.status='Received';r.assigned_to=u.id;
 else
 if r.status<>'Received' or r.assigned_to is distinct from u.id then raise exception 'Receive this request first; only assigned R&I can process it';end if;
 if act<>'pending'and btrim(comment)=''then raise exception 'Describe solution or reason';end if;
 if act='solve' then r.status='Solved';r.solution=comment;r.solved_by=u.id;r.solved_at=now();
 elsif act='forward'then select id into toid from public.wlf_profiles where email=raw->>'to'and status='Approved'and role='R&I'and id<>u.id;if toid is null then raise exception 'Select another approved R&I user';end if;r.status='Forwarded';r.assigned_to=toid;
 elsif act='notSolved'then r.status='Not Solved';r.not_solved_by=u.id;r.not_solved_at=now();
 elsif act='pending'then r.status='Pending';else raise exception 'Invalid transition';end if;end if;
 elsif a='editSupportRequest'then r.values=wlf_private.validate_values(r.form_schema,raw->'values');r.reference=wlf_private.ref(r.category,r.values,r.form_schema);act='edit form';comment='Form corrected by Super Admin';
 else r.deleted_at=now();act='delete';comment='Removed by Super Admin';end if;
 r.revision=r.revision+1;r.updated_at=now();
 update public.wlf_requests set status=r.status,assigned_to=r.assigned_to,updated_at=r.updated_at,revision=r.revision,values=r.values,reference=r.reference,solution=r.solution,solved_by=r.solved_by,solved_at=r.solved_at,not_solved_by=r.not_solved_by,not_solved_at=r.not_solved_at,deleted_at=r.deleted_at,search_text=r.values::text where id=r.id;
 end if;
 insert into public.wlf_history(request_id,actor,action,comment,to_user)values(r.id,u.id,act,comment,r.assigned_to);
 insert into public.wlf_operations(actor,mutation_id,action,request_id,payload)values(u.id,op,a,r.id,raw);
 return jsonb_build_object('id',r.id,'revision',r.revision,'status',r.status,'ticket',wlf_private.ticket(r),'summary',wlf_private.summary());
 elsif a='saveSupportSchema'then
 select * into form from public.wlf_forms where category=raw->>'category'for update;
 if not found or form.revision is distinct from (raw->>'revision')::integer then raise exception 'CONFLICT: Form changed';end if;
 v=raw->'schema'->'fields';if jsonb_typeof(v)<>'array'or jsonb_array_length(v)not between 1 and 60 or length(v::text)>28000 then raise exception 'Invalid form fields';end if;
 if exists(select 1 from jsonb_array_elements(v)x where coalesce(x->>'id','')!~'^[-a-zA-Z0-9_]{4,100}$'or length(coalesce(x->>'label',''))not between 1 and 180 or x->>'type'not in('text','date','select','multi')or jsonb_typeof(x->'options')<>'array'or jsonb_array_length(x->'options')>100 or(x->>'type'in('select','multi')and jsonb_array_length(x->'options')=0)) or(select count(distinct x->>'id')from jsonb_array_elements(v)x)<>jsonb_array_length(v)then raise exception 'Invalid or duplicate field';end if;
 if not exists(select 1 from jsonb_array_elements(v)x where x->>'id'='field_1369800003')or not exists(select 1 from jsonb_array_elements(v)x where x->>'id'='submitted_date'and x->>'type'='date')then raise exception 'Keep Lift ID and Date identity fields';end if;
 update public.wlf_forms set schema=jsonb_set(schema,'{fields}',v),revision=revision+1 where category=form.category returning * into form;return form.schema||jsonb_build_object('revision',form.revision);
 elsif a in('getTroubleshooting','getTroubleshootingSummary')then
 select coalesce(jsonb_agg(content||jsonb_build_object('revision',revision)order by id),'[]')into arr from public.wlf_troubleshooting where not deleted and wlf_private.can(case when controller='GENERAL'then'tb:general:'||id when content->>'kind'='procedure'then'tb:option:'||id else'tb:'||controller||':error'end);
 if a='getTroubleshooting'then return jsonb_build_object('entries',arr,'initialized',true,'updatedAt',now());end if;
 return jsonb_build_object('errors',(select count(*)from jsonb_array_elements(arr)e where e->>'controller'<>'GENERAL'and coalesce(e->>'kind','error')<>'procedure'),'subcodes',(select coalesce(sum(jsonb_array_length(coalesce(e->'subcodes','[]'))),0)from jsonb_array_elements(arr)e),'options',(select count(*)from jsonb_array_elements(arr)e where e->>'kind'='procedure'),'general',(select count(*)from jsonb_array_elements(arr)e where e->>'controller'='GENERAL'));
 elsif a='saveTroubleshootingEntry'then
 if coalesce(raw->>'id','')!~'^[-a-zA-Z0-9]{6,100}$'or raw->>'controller'not in('MOT','NICE3000+','GENERAL')or length(raw::text)>40000 then raise exception 'Invalid troubleshooting entry';end if;
 if(raw->>'controller'='GENERAL'or raw->>'kind'='procedure')and coalesce(btrim(raw->>'category'),'')=''then raise exception 'Subcategory name required';end if;
 if raw->>'controller'<>'GENERAL'and coalesce(raw->>'kind','error')<>'procedure'and(coalesce(raw->>'code','')!~'^(Er|Err)[0-9]+$'or coalesce(raw->>'description','')='')then raise exception 'Code and description required';end if;
 select * into tr from public.wlf_troubleshooting where id=raw->>'id'for update;
 if found and not tr.deleted and coalesce(raw->>'mutationId','')<>'' and tr.content->>'mutationId'=raw->>'mutationId' and (tr.content-'revision'-'updatedAt'-'updatedBy')=(raw-'revision'-'updatedAt'-'updatedBy') then return tr.content;end if;
 if found and(tr.deleted or tr.revision<>coalesce((raw->>'revision')::integer,0))then raise exception 'TB_CONFLICT: Entry changed';end if;
 rev=coalesce(tr.revision,0)+1;v=raw||jsonb_build_object('revision',rev,'updatedAt',now(),'updatedBy',u.email);
 insert into public.wlf_troubleshooting(id,controller,option_key,content,revision)values(raw->>'id',raw->>'controller',case when raw->>'controller'='GENERAL'or raw->>'kind'='procedure'then'procedure:'||lower(regexp_replace(raw->>'category','[^a-zA-Z0-9ঀ-৿]+','','g'))else raw->>'code'end,v,rev)on conflict(id)do update set content=excluded.content,revision=excluded.revision,controller=excluded.controller,option_key=excluded.option_key;return v;
 elsif a='deleteTroubleshootingEntry'then if exists(select 1 from public.wlf_troubleshooting where id=args->>0 and deleted)then return jsonb_build_object('id',args->>0,'deleted',true);end if;update public.wlf_troubleshooting set deleted=true,revision=revision+1 where id=args->>0 and revision=(args->>1)::integer;if not found then raise exception 'TB_CONFLICT: Entry changed';end if;return jsonb_build_object('id',args->>0,'deleted',true);
 elsif a='logAction'then
 act=left(args->>0,220);
 c=case act when 'Login'then '' when 'Component Selection'then'selection'when'Travel Time Calculation'then'calc:travel'when'Power Calculation'then'calc:power'when'Speed & Slip Calculation'then'calc:speed'when'Motor Power Justification'then'calc:motor'when'Energy Bill Calculation'then'calc:energy'when'Solar Sizing Calculation'then'calc:solar'else null end;
 if c is null then
 if act!~'^Troubleshooting / (MOT|NICE3000\+|GENERAL) / .{1,180}$'then raise exception 'Invalid usage action';end if;
 if not exists(select 1 from public.wlf_troubleshooting t where not t.deleted and t.controller=split_part(act,' / ',2)and(case when t.controller='GENERAL'or t.content->>'kind'='procedure'then t.content->>'category'else'Error Solution'end)=split_part(act,' / ',3)and wlf_private.can(case when t.controller='GENERAL'then'tb:general:'||t.id when t.content->>'kind'='procedure'then'tb:option:'||t.id else'tb:'||t.controller||':error'end))then raise exception 'Permission denied';end if;
 elsif c<>''and not wlf_private.can(c)then raise exception 'Permission denied';end if;
 insert into public.wlf_usage(actor,action,details)values(u.id,act,left(coalesce(args->>1,''),300));return 'true';
 elsif a='adminStats'then return wlf_private.usage_stats();
 elsif a='saveEngineeringRecord'then
 if coalesce(raw->>'id','')=''or length(raw::text)>30000 then raise exception 'Invalid record';end if;
 if exists(select 1 from public.wlf_records where id=(raw->>'id')::uuid and owner<>u.id)then raise exception 'Record belongs to another account';end if;
 insert into public.wlf_records(id,owner,record)values((raw->>'id')::uuid,u.id,raw)on conflict(id)do nothing;return jsonb_build_object('id',raw->>'id','synced',true);
 elsif a='listEngineeringRecords'then return coalesce((select jsonb_agg(jsonb_build_object('record',record,'synced',true,'owner',u.email))from public.wlf_records where owner=u.id),'[]');
 else raise exception 'Unsupported action: %',a;end if;
end$$;
-- Exposed wrapper uses invoker privileges; private implementation has explicit identity,
-- approval, role, option, ownership, assignment and revision checks on EVERY operation.
create function public.wlf_rpc(action text,args jsonb default '[]')returns jsonb language sql security invoker set search_path='' as $$select wlf_private.rpc(action,args)$$;
revoke all on all functions in schema wlf_private from public,anon,authenticated;
grant execute on function wlf_private.me(),wlf_private.approved(),wlf_private.super(),wlf_private.can(text),wlf_private.team(text),wlf_private.visible(text,uuid),wlf_private.rpc(text,jsonb)to authenticated;
revoke all on function public.wlf_rpc(text,jsonb)from public,anon;
grant execute on function public.wlf_rpc(text,jsonb)to authenticated;
commit;
