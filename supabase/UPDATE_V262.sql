-- =====================================================================
-- WLF Electrical Solution v2.6.2
--  * Storage & Backup > Excel backup: four new modules (R&I Project,
--    QMS data, Damage Demand, Supplier Claim). Each can be backed up
--    WITHOUT clearing, or WITH clearing (the data is removed only after the
--    Excel file and a recovery file are saved and verified on Google Drive).
--    Every backup is also downloaded to the PC.
--  * Old Excel backup history can be deleted (one row or all rows). The files
--    already saved on Google Drive are never touched.
--  * QMS: a deleted lift goes to the Recycle bin. Restore brings it back;
--    deleting it from the Recycle bin removes it from the database.
--  * Documents Links: the Super Admin decides who can open it (new option
--    "Documents Links / View" in Users). Existing approved users keep access.
--    Only the Super Admin can add, edit or delete documents, folders and
--    sub menus (this was already enforced and stays so).
-- Run in Supabase > SQL Editor after v2.6.1 (UPDATE_V261.sql). Safe to run
-- twice. Back up first. If an RLS warning appears, choose "Run without RLS".
-- =====================================================================
begin;

do $pre$ begin
  if to_regprocedure('wlf_private.rpc_before_v261(text,jsonb)') is null then
    raise exception 'STOP: apply UPDATE_V261.sql (v2.6.1) first. Nothing was changed.';
  end if;
end $pre$;

-- ---------------------------------------------------------------- constraints
do $c$ declare k record; begin
  for k in select conname from pg_constraint where conrelid='wlf_private.excel_runs'::regclass and contype='c'
           and pg_get_constraintdef(oid) like '%kind%' loop
    execute format('alter table wlf_private.excel_runs drop constraint %I',k.conname);
  end loop;
  alter table wlf_private.excel_runs add constraint excel_runs_kind_v262
    check (kind in ('support','activity','project','qms','damage','claim'));
  for k in select conname from pg_constraint where conrelid='wlf_private.recycle_bin'::regclass and contype='c'
           and pg_get_constraintdef(oid) like '%kind%' loop
    execute format('alter table wlf_private.recycle_bin drop constraint %I',k.conname);
  end loop;
  alter table wlf_private.recycle_bin add constraint recycle_bin_kind_v262
    check (kind in ('request','ri-entry','project','task','troubleshooting','document','doc-category','doc-folder','announcement','qms-lift'));
end $c$;

-- ---------------------------------------------------------------- permission: Documents Links
do $c$ begin
  if to_regprocedure('wlf_private.catalog_before_v262()') is null then
    alter function wlf_private.catalog() rename to catalog_before_v262;
  end if;
end $c$;
create or replace function wlf_private.catalog() returns jsonb
language sql stable security definer set search_path='' as $$
  select wlf_private.catalog_before_v262() || jsonb_build_array(
    jsonb_build_object('key','documents:view','label','Documents Links / Open documents','group','Workspace'))
$$;

-- everybody who could open Documents Links until now keeps that access
update public.wlf_profiles
   set permissions=array_append(permissions,'documents:view'), access_revision=access_revision+1
 where status='Approved' and role<>'Super Admin' and not ('documents:view'=any(permissions));

-- ---------------------------------------------------------------- helpers
create or replace function wlf_private.hw_snap_gc() returns integer
language plpgsql security definer set search_path='' as $$
declare refs text; n integer;
begin
  select coalesce(string_agg(parts::text||coalesce(selection::text,''),' '),'') into refs from wlf_private.qms_lifts;
  delete from wlf_private.hw_snap s where position(s.h in refs)=0;
  get diagnostics n = row_count;
  return n;
end $$;

create or replace function wlf_private.excel_eligible(k text, d wlf_private.damage_demands) returns boolean
language sql immutable set search_path='' as $$
  select case k
    when 'damage' then d.received_at is not null and (d.claim_at is null or d.sc_received_at is not null)
    when 'claim' then d.claim_at is not null and d.sc_received_at is not null
    else false end
$$;
revoke all on function wlf_private.hw_snap_gc(), wlf_private.excel_eligible(text,wlf_private.damage_demands) from public, anon, authenticated;


-- ---------------------------------------------------------------- Recycle bin: QMS lifts
create or replace function wlf_private.recycle_api(a text, p jsonb, u public.wlf_profiles) returns jsonb
language plpgsql security definer set search_path='' as $$
declare
  b wlf_private.recycle_bin;
  x jsonb;
  ids bigint[];
  counts jsonb := '{}';
  n integer;
  proj public.wlf_ri_projects;
  everything boolean := coalesce(p->>'all','')='true';
begin
  if u.role is distinct from 'Super Admin' then raise exception 'Permission denied: Super Admin only'; end if;
  -- forget rows whose item is gone or was brought back some other way
  delete from wlf_private.recycle_bin r where
       (r.kind='request' and not exists(select 1 from public.wlf_requests q where q.id::text=r.ref and q.deleted_at is not null))
    or (r.kind='ri-entry' and not exists(select 1 from public.wlf_ri_entries q where q.id::text=r.ref and q.deleted_at is not null))
    or (r.kind='project' and not exists(select 1 from public.wlf_ri_projects q where q.id::text=r.ref and q.deleted_at is not null))
    or (r.kind='troubleshooting' and not exists(select 1 from public.wlf_troubleshooting q where q.id=r.ref and q.deleted)
    or (r.kind='qms-lift' and not exists(select 1 from wlf_private.qms_lifts q where q.id::text=r.ref and q.deleted_at is not null)));

  if a='getRecycleBin' then
    return jsonb_build_object(
      'items',coalesce((select jsonb_agg(jsonb_build_object('id',r.id,'kind',r.kind,'label',r.label,'detail',r.detail,
          'deletedBy',coalesce(wlf_private.person_label(r.deleted_by),''),'deletedAt',r.deleted_at) order by r.deleted_at desc, r.id desc)
        from wlf_private.recycle_bin r),'[]'::jsonb),
      'purges',coalesce((select jsonb_agg(jsonb_build_object('at',l.at,'by',coalesce(wlf_private.person_label(l.actor),''),
          'what',l.what,'counts',l.counts) order by l.at desc, l.id desc)
        from (select * from wlf_private.purge_log order by at desc, id desc limit 30) l),'[]'::jsonb));

  elsif a='restoreRecycleItem' then
    select * into b from wlf_private.recycle_bin where id=nullif(p->>'id','')::bigint for update;
    if not found then raise exception 'This item is no longer in the recycle bin. Refresh the list.'; end if;
    x := b.payload;
    begin
      if b.kind='request' then
        update public.wlf_requests set deleted_at=null, revision=revision+1, updated_at=now() where id=b.ref::uuid;
        insert into public.wlf_history(request_id,actor,action,comment) values(b.ref::uuid,u.id,'restore','Restored from the recycle bin');
      elsif b.kind='ri-entry' then
        update public.wlf_ri_entries set deleted_at=null, revision=revision+1, updated_at=now() where id=b.ref::uuid;
      elsif b.kind='project' then
        update public.wlf_ri_projects set deleted_at=null, revision=revision+1, updated_at=now() where id=b.ref::uuid;
      elsif b.kind='task' then
        select * into proj from public.wlf_ri_projects where id=(x->>'project')::uuid for update;
        if not found then raise exception 'The project of this task no longer exists. Delete the task permanently instead.'; end if;
        if proj.deleted_at is not null then raise exception 'Restore the project "%" first.', proj.data->>'name'; end if;
        if not exists(select 1 from jsonb_array_elements(proj.data->'tasks') t where t->>'id'=x->'task'->>'id') then
          if jsonb_array_length(proj.data->'tasks')>=150 then raise exception 'This project already has 150 tasks.'; end if;
          update public.wlf_ri_projects set data=jsonb_set(data,'{tasks}',(data->'tasks')||jsonb_build_array(x->'task')),
            revision=revision+1, updated_at=now() where id=proj.id;
        end if;
      elsif b.kind='troubleshooting' then
        update public.wlf_troubleshooting set deleted=false, revision=revision+1,
          content=jsonb_set(content,'{revision}',to_jsonb(revision+1)) where id=b.ref;
      elsif b.kind='document' then
        if not exists(select 1 from public.wlf_document_categories where id=(x->>'category')::uuid) then
          raise exception 'Its sub menu was deleted. Restore the sub menu first.';
        end if;
        if not exists(select 1 from public.wlf_document_folders where id=nullif(x->>'folder','')::uuid) then
          x := x||jsonb_build_object('folder',null);
        end if;
        insert into public.wlf_documents select * from jsonb_populate_record(null::public.wlf_documents,x) on conflict (id) do nothing;
      elsif b.kind='doc-folder' then
        if not exists(select 1 from public.wlf_document_categories where id=(x->>'category')::uuid) then
          raise exception 'Its sub menu was deleted. Restore the sub menu first.';
        end if;
        if not exists(select 1 from public.wlf_document_folders where id=nullif(x->>'parent','')::uuid) then
          x := x||jsonb_build_object('parent',null);
        end if;
        insert into public.wlf_document_folders select * from jsonb_populate_record(null::public.wlf_document_folders,x) on conflict (id) do nothing;
      elsif b.kind='doc-category' then
        insert into public.wlf_document_categories select * from jsonb_populate_record(null::public.wlf_document_categories,x->'category') on conflict (id) do nothing;
        loop  -- parents first
          insert into public.wlf_document_folders
          select r.* from jsonb_populate_recordset(null::public.wlf_document_folders,coalesce(x->'folders','[]')) r
          where not exists(select 1 from public.wlf_document_folders z where z.id=r.id)
            and (r.parent is null or exists(select 1 from public.wlf_document_folders z where z.id=r.parent));
          get diagnostics n = row_count;
          exit when n=0;
        end loop;
        insert into public.wlf_documents select r.* from jsonb_populate_recordset(null::public.wlf_documents,coalesce(x->'documents','[]')) r
          on conflict (id) do nothing;
      elsif b.kind='qms-lift' then
        update wlf_private.qms_lifts set deleted_at=null,deleted_by=null,revision=revision+1,updated_at=now(),
          history=history||jsonb_build_array(jsonb_build_object('at',now(),'by',coalesce(u.name,''),'action','restored from the recycle bin'))
          where id=b.ref::uuid and deleted_at is not null;
      elsif b.kind='announcement' then
        insert into wlf_private.announcements select * from jsonb_populate_record(null::wlf_private.announcements,x) on conflict (id) do nothing;
      end if;
    exception when unique_violation then
      raise exception 'Cannot restore "%": another item with the same name or code exists now. Rename or delete that one first.', b.label;
    end;
    delete from wlf_private.recycle_bin where id=b.id;
    return jsonb_build_object('restored',b.kind,'label',b.label);

  elsif a='purgeRecycleItems' then
    if everything then
      if p->>'confirm' is distinct from 'DELETE' then raise exception 'Type DELETE to empty the recycle bin.'; end if;
      select array_agg(id) into ids from wlf_private.recycle_bin;
    else
      if jsonb_typeof(p->'ids') is distinct from 'array' or jsonb_array_length(p->'ids') not between 1 and 1000 then
        raise exception 'Select the items to delete.';
      end if;
      select array_agg(r.id) into ids from wlf_private.recycle_bin r
        where r.id::text in (select jsonb_array_elements_text(p->'ids'));
    end if;
    if ids is null then raise exception 'Nothing to delete. Refresh the list.'; end if;
    for b in select * from wlf_private.recycle_bin where id=any(ids) order by id for update loop
      if b.kind='request' then
        if exists(select 1 from public.wlf_requests where id=b.ref::uuid and deleted_at is not null) then
          insert into wlf_private.archived_operations select o.actor,o.mutation_id,o.request_id
            from public.wlf_operations o where o.request_id=b.ref::uuid on conflict do nothing;
          delete from public.wlf_operations where request_id=b.ref::uuid;
          delete from public.wlf_history where request_id=b.ref::uuid;
          delete from wlf_private.damage_demands where request_id=b.ref::uuid;
          delete from public.wlf_requests where id=b.ref::uuid;
        end if;
      elsif b.kind='ri-entry' then
        if exists(select 1 from public.wlf_ri_entries where id=b.ref::uuid and deleted_at is not null) then
          insert into wlf_private.ri_entry_archive(id) values(b.ref::uuid) on conflict do nothing;
          delete from public.wlf_ri_entries where id=b.ref::uuid;
        end if;
      elsif b.kind='project' then
        delete from public.wlf_ri_projects where id=b.ref::uuid and deleted_at is not null;
      elsif b.kind='troubleshooting' then
        delete from public.wlf_troubleshooting where id=b.ref and deleted;
      elsif b.kind='qms-lift' then
        delete from wlf_private.qms_lifts where id=b.ref::uuid and deleted_at is not null;
      end if;  -- tasks, documents, sub menus, folders, announcements live only in the bin row
      counts := counts||jsonb_build_object(b.kind,coalesce((counts->>b.kind)::integer,0)+1);
    end loop;
    delete from wlf_private.recycle_bin where id=any(ids);
    if coalesce((counts->>'qms-lift')::integer,0)>0 then perform wlf_private.hw_snap_gc(); end if;
    insert into wlf_private.purge_log(actor,what,counts)
      values(u.id,case when everything then 'Empty bin' else 'Delete permanently' end,counts);
    return jsonb_build_object('deleted',cardinality(ids),'counts',counts);
  end if;
  raise exception 'Unsupported recycle bin action';
end
$$;
revoke all on function wlf_private.recycle_api(text,jsonb,public.wlf_profiles) from public, anon, authenticated;

-- lifts deleted before v2.6.2 were hidden but not listed: put them in the bin
insert into wlf_private.recycle_bin(kind,ref,label,detail,deleted_by,deleted_at)
select 'qms-lift',q.id::text,q.lift_id,'QMS lift · '||q.project,q.deleted_by,q.deleted_at
  from wlf_private.qms_lifts q where q.deleted_at is not null
on conflict (kind,ref) do nothing;

-- ---------------------------------------------------------------- Documents Links in the activity report

create or replace function wlf_private.workspace_sections(own boolean)
returns table(section text,label text) language sql stable set search_path='' as $$
  select v.section,v.label from (values
    ('support','Technical Support',exists(select 1 from wlf_private.support_teams() t where wlf_private.team(t.id))),
    ('activity','R&I Team Activity',wlf_private.ri_enabled('ri:activity')),
    ('projects','R&I Project Manager',wlf_private.ri_enabled('ri:projects')),
    ('damage','Damage Demand',wlf_private.ri_enabled('damage:dashboard') or
      (own and (wlf_private.ri_enabled('damage:demand') or (wlf_private.me()).role='R&I'))),
    ('qms','QMS',wlf_private.ri_enabled('qms:components')),
    ('selection','Component Selection',wlf_private.can('selection')),
    ('calculations','Calculations',exists(select 1 from unnest(array['travel','power','speed','motor','energy','solar']) x where wlf_private.can('calc:'||x))),
    ('troubleshooting','Troubleshooting',exists(
      select 1 from public.wlf_troubleshooting t where not t.deleted and wlf_private.can(
        case when t.controller='GENERAL' then 'tb:general:'||t.id
        when t.content->>'kind'='procedure' then 'tb:option:'||t.id else 'tb:'||t.controller||':error' end))),
    ('documents','Documents Links',wlf_private.can('documents:view'))
  ) v(section,label,allowed) where v.allowed
$$;
revoke all on function wlf_private.workspace_sections(boolean) from public, anon, authenticated;

-- ---------------------------------------------------------------- Excel backup: new modules + history delete
create or replace function public.wlf_excel_admin(action text, actor uuid, payload jsonb default '{}')
returns jsonb language plpgsql security definer set search_path='' as $$
declare
  run_id uuid; run_row wlf_private.excel_runs; workbook_kind text=payload->>'kind';
  period_from date; period_to date; clear_mode boolean;
  x jsonb; obj jsonb; source_row record; records jsonb[]='{}'; row_count int=0; total_bytes int=0;
  categories jsonb; ids uuid[]; archive jsonb; restored int=0; restore_offset integer; entries jsonb[];
  rec wlf_private.qms_lifts; n integer; removed integer;
begin
  if not exists(select 1 from public.wlf_profiles where id=actor and status='Approved' and role='Super Admin') then
    raise exception 'Super Admin only';
  end if;
  if action='history' then
    return (select coalesce(jsonb_agg(wlf_private.excel_receipt(r) order by created_at desc,id),'[]')
      from (select * from wlf_private.excel_runs where workbook_id is not null order by created_at desc,id limit 100) r);
  end if;
  if action='deleteHistory' then
    if coalesce((payload->>'all')::boolean,false) then
      if payload->>'confirm' is distinct from 'DELETE' then raise exception 'Type DELETE to delete all backup history.'; end if;
      delete from wlf_private.excel_runs where workbook_id is not null;
    else
      delete from wlf_private.excel_runs where id=nullif(payload->>'id','')::uuid and workbook_id is not null;
    end if;
    get diagnostics removed = row_count;
    return jsonb_build_object('deleted',removed);
  end if;
  run_id=(payload->>'id')::uuid;
  if run_id is null then raise exception 'Missing Excel backup ID'; end if;

  if action='prepare' then
    period_from=nullif(payload->>'from','')::date; period_to=nullif(payload->>'to','')::date;
    clear_mode=coalesce((payload->>'withClear')::boolean,false);
    if coalesce(workbook_kind,'') not in ('support','activity','project','qms','damage','claim') or (period_from is null)<>(period_to is null)
      or period_from>period_to then raise exception 'Choose a valid module and date range'; end if;
    insert into wlf_private.excel_runs(id,actor,kind,date_from,date_to,with_clear)
      values(run_id,actor,workbook_kind,period_from,period_to,clear_mode) on conflict(id) do nothing;
  end if;
  select * into run_row from wlf_private.excel_runs where id=run_id for update;
  if not found then raise exception 'Excel backup not found'; end if;

  if action='read' then
    if run_row.workbook_id is null then raise exception 'Verified Excel backup not found'; end if;
    return wlf_private.excel_receipt(run_row);
  end if;
  if action in ('prepare','verify','release','clear') and run_row.actor<>actor then
    raise exception 'Only the Super Admin who started this backup can complete it';
  end if;

  if action='prepare' then
    if run_row.kind<>workbook_kind or run_row.with_clear<>clear_mode or run_row.date_from is distinct from period_from
      or run_row.date_to is distinct from period_to then raise exception 'Backup ID reused with different settings'; end if;
    if run_row.workbook_id is not null then return jsonb_build_object('verified',true); end if;
    if run_row.lease_until>now() then raise exception 'This Excel backup is already in progress. Retry shortly.'; end if;
    categories='[]';

    if run_row.kind='support' then
      select jsonb_agg(jsonb_build_object('id',t.id,'name',t.title,'schema',f.schema) order by t.sort_order) into categories
      from wlf_private.support_teams() t join public.wlf_forms f on f.category=t.id;
      for source_row in
        select r, p.name author_name, a.name assignee_name, s.name solver_name
        from public.wlf_requests r join public.wlf_profiles p on p.id=r.created_by
        left join public.wlf_profiles a on a.id=r.assigned_to left join public.wlf_profiles s on s.id=r.solved_by
        where r.deleted_at is null
          and (period_from is null or (r.created_at at time zone 'Asia/Dhaka')::date between period_from and period_to)
        order by r.created_at,r.id limit 1001
      loop
        obj=wlf_private.backup_record(source_row.r);
        x=obj||jsonb_build_object('authorName',source_row.author_name,'assigneeName',source_row.assignee_name,
          'solverName',source_row.solver_name,'id',obj->'request'->>'id','fingerprint',encode(sha256(convert_to(obj::text,'UTF8')),'hex'),
          'eligible',obj->'request'->>'status'='Solved');
        row_count=row_count+1; total_bytes=total_bytes+octet_length(x::text);
        if row_count>1000 or total_bytes>4000000 then raise exception 'Excel backup is too large. Choose a shorter date range.'; end if;
        records=array_append(records,x);
      end loop;
    elsif run_row.kind='activity' then
      select coalesce(jsonb_agg(jsonb_build_object('id',c.id,'name',c.name,'schema',c.schema) order by c.position,c.name),'[]') into categories
      from public.wlf_ri_categories c where c.active or exists(
        select 1 from public.wlf_ri_entries e where e.category=c.id and e.deleted_at is null);
      for source_row in
        select e.* from public.wlf_ri_entries e where e.deleted_at is null
          and (period_from is null or (e.created_at at time zone 'Asia/Dhaka')::date between period_from and period_to)
        order by e.created_at,e.id limit 1001
      loop
        obj=to_jsonb(source_row);
        x=jsonb_build_object('entry',obj,'id',source_row.id,'fingerprint',encode(sha256(convert_to(obj::text,'UTF8')),'hex'),
          'eligible',source_row.status in ('Completed','Solved'));
        row_count=row_count+1; total_bytes=total_bytes+octet_length(x::text);
        if row_count>1000 or total_bytes>4000000 then raise exception 'Excel backup is too large. Choose a shorter date range.'; end if;
        records=array_append(records,x);
      end loop;
    elsif run_row.kind='project' then
      for source_row in
        select p.*, o.name owner_name from public.wlf_ri_projects p left join public.wlf_profiles o on o.id=p.owner
        where p.deleted_at is null
          and (period_from is null or (p.created_at at time zone 'Asia/Dhaka')::date between period_from and period_to)
        order by p.created_at,p.id limit 1001
      loop
        obj=to_jsonb(source_row)-'owner_name';
        x=jsonb_build_object('project',obj,'ownerName',source_row.owner_name,'id',source_row.id,
          'fingerprint',encode(sha256(convert_to(obj::text,'UTF8')),'hex'),'eligible',source_row.data->>'status'='Done');
        row_count=row_count+1; total_bytes=total_bytes+octet_length(x::text);
        if row_count>1000 or total_bytes>4000000 then raise exception 'Excel backup is too large. Choose a shorter date range.'; end if;
        records=array_append(records,x);
      end loop;
    elsif run_row.kind='qms' then
      for source_row in
        select q.* from wlf_private.qms_lifts q where q.deleted_at is null
          and (period_from is null or (q.created_at at time zone 'Asia/Dhaka')::date between period_from and period_to)
        order by q.created_at,q.id limit 1001
      loop
        obj=to_jsonb(source_row);
        x=jsonb_build_object('lift',obj||jsonb_build_object('parts',wlf_private.qms_parts_open(source_row.parts),
            'selection',wlf_private.qms_sel_open(source_row.selection)),
          'id',source_row.id,'fingerprint',encode(sha256(convert_to(obj::text,'UTF8')),'hex'),'eligible',true);
        row_count=row_count+1; total_bytes=total_bytes+octet_length(x::text);
        if row_count>1000 or total_bytes>4000000 then raise exception 'Excel backup is too large. Choose a shorter date range.'; end if;
        records=array_append(records,x);
      end loop;
    else  -- damage / claim: both are stored in the same demand record
      for source_row in
        select d.* from wlf_private.damage_demands d
        where (run_row.kind='damage' or d.claim_at is not null)
          and (period_from is null or (case when run_row.kind='claim' then d.claim_at else d.created_at end
               at time zone 'Asia/Dhaka')::date between period_from and period_to)
        order by d.demand_no limit 1001
      loop
        obj=to_jsonb(source_row);
        x=jsonb_build_object('demand',obj,'id',source_row.request_id,'fingerprint',encode(sha256(convert_to(obj::text,'UTF8')),'hex'),
          'eligible',wlf_private.excel_eligible(run_row.kind,jsonb_populate_record(null::wlf_private.damage_demands,obj)));
        row_count=row_count+1; total_bytes=total_bytes+octet_length(x::text);
        if row_count>1000 or total_bytes>4000000 then raise exception 'Excel backup is too large. Choose a shorter date range.'; end if;
        records=array_append(records,x);
      end loop;
    end if;
    update wlf_private.excel_runs set nonce=(payload->>'nonce')::uuid,lease_until=now()+interval '2 minutes',
      items=coalesce((select jsonb_agg(jsonb_build_object('id',item->'id','fingerprint',item->'fingerprint',
        'eligible',item->'eligible')) from unnest(records) item),'[]') where id=run_id;
    return jsonb_build_object('verified',false,'kind',run_row.kind,'total',row_count,'categories',categories,
      'records',to_jsonb(records));
  end if;

  if action='release' then
    update wlf_private.excel_runs set lease_until=null,nonce=null
      where id=run_id and workbook_id is null and nonce=(payload->>'nonce')::uuid;
    return 'true';
  elsif action='verify' then
    if run_row.workbook_id is not null or run_row.nonce is distinct from (payload->>'nonce')::uuid
       or coalesce(payload->>'workbookId','') !~ '^[-a-zA-Z0-9_]{5,200}$'
       or coalesce(payload->>'workbookHash','') !~ '^[a-f0-9]{64}$'
       or (run_row.with_clear and (coalesce(payload->>'recoveryId','') !~ '^[-a-zA-Z0-9_]{5,200}$'
          or coalesce(payload->>'recoveryHash','') !~ '^[a-f0-9]{64}$')) then
      raise exception 'Excel backup verification rejected';
    end if;
    update wlf_private.excel_runs set workbook_id=payload->>'workbookId',workbook_hash=payload->>'workbookHash',
      recovery_id=payload->>'recoveryId',recovery_hash=payload->>'recoveryHash',nonce=null,lease_until=null
      where id=run_id returning * into run_row;
    return wlf_private.excel_receipt(run_row);
  elsif action='clear' then
    if not run_row.with_clear or run_row.workbook_id is null or run_row.recovery_id is null then
      raise exception 'Verified workbook and recovery file required for Clear';
    end if;
    if run_row.clear_finished then return wlf_private.excel_receipt(run_row); end if;
    if run_row.kind='support' then
      perform r.id from public.wlf_requests r
        join jsonb_array_elements(run_row.items) i on r.id=(i->>'id')::uuid
        where (i->>'eligible')::boolean order by r.id for update of r;
      select array_agg(r.id) into ids from public.wlf_requests r
        join jsonb_array_elements(run_row.items) i on r.id=(i->>'id')::uuid
        where (i->>'eligible')::boolean and r.deleted_at is null and r.status='Solved'
          and encode(sha256(convert_to(wlf_private.backup_record(r)::text,'UTF8')),'hex')=i->>'fingerprint';
      if ids is not null then
        insert into wlf_private.archived_operations(actor,mutation_id,request_id)
          select o.actor,o.mutation_id,o.request_id from public.wlf_operations o where o.request_id=any(ids) on conflict do nothing;
        delete from public.wlf_operations where request_id=any(ids);
        delete from public.wlf_history where request_id=any(ids);
        delete from public.wlf_requests where id=any(ids);
      end if;
    elsif run_row.kind='activity' then
      perform e.id from public.wlf_ri_entries e
        join jsonb_array_elements(run_row.items) i on e.id=(i->>'id')::uuid
        where (i->>'eligible')::boolean order by e.id for update of e;
      select array_agg(e.id) into ids from public.wlf_ri_entries e
        join jsonb_array_elements(run_row.items) i on e.id=(i->>'id')::uuid
        where (i->>'eligible')::boolean and e.deleted_at is null and e.status in ('Completed','Solved')
          and encode(sha256(convert_to(to_jsonb(e)::text,'UTF8')),'hex')=i->>'fingerprint';
      if ids is not null then
        insert into wlf_private.ri_entry_archive(id) select unnest(ids) on conflict do nothing;
        delete from public.wlf_ri_entries where id=any(ids);
      end if;
    elsif run_row.kind='project' then
      perform e.id from public.wlf_ri_projects e
        join jsonb_array_elements(run_row.items) i on e.id=(i->>'id')::uuid
        where (i->>'eligible')::boolean order by e.id for update of e;
      select array_agg(e.id) into ids from public.wlf_ri_projects e
        join jsonb_array_elements(run_row.items) i on e.id=(i->>'id')::uuid
        where (i->>'eligible')::boolean and e.deleted_at is null and e.data->>'status'='Done'
          and encode(sha256(convert_to(to_jsonb(e)::text,'UTF8')),'hex')=i->>'fingerprint';
      if ids is not null then delete from public.wlf_ri_projects where id=any(ids); end if;
    elsif run_row.kind='qms' then
      perform e.id from wlf_private.qms_lifts e
        join jsonb_array_elements(run_row.items) i on e.id=(i->>'id')::uuid
        where (i->>'eligible')::boolean order by e.id for update of e;
      select array_agg(e.id) into ids from wlf_private.qms_lifts e
        join jsonb_array_elements(run_row.items) i on e.id=(i->>'id')::uuid
        where (i->>'eligible')::boolean and e.deleted_at is null
          and encode(sha256(convert_to(to_jsonb(e)::text,'UTF8')),'hex')=i->>'fingerprint';
      if ids is not null then
        delete from wlf_private.qms_lifts where id=any(ids);
        perform wlf_private.hw_snap_gc();
      end if;
    else
      perform e.request_id from wlf_private.damage_demands e
        join jsonb_array_elements(run_row.items) i on e.request_id=(i->>'id')::uuid
        where (i->>'eligible')::boolean order by e.request_id for update of e;
      select array_agg(e.request_id) into ids from wlf_private.damage_demands e
        join jsonb_array_elements(run_row.items) i on e.request_id=(i->>'id')::uuid
        where (i->>'eligible')::boolean and wlf_private.excel_eligible(run_row.kind,e)
          and encode(sha256(convert_to(to_jsonb(e)::text,'UTF8')),'hex')=i->>'fingerprint';
      if ids is not null then delete from wlf_private.damage_demands where request_id=any(ids); end if;
    end if;
    update wlf_private.excel_runs set clear_finished=true,cleared_ids=coalesce(ids,'{}')
      where id=run_id returning * into run_row;
    return wlf_private.excel_receipt(run_row);
  elsif action='restore' then
    archive=payload->'archive';
    if run_row.recovery_id is null or not run_row.clear_finished or run_row.restored_at is not null
      or archive->>'format' is distinct from 'WLF-EXCEL-RECOVERY-2.2'
      or archive->>'project' is distinct from payload->>'project' or archive->>'id' is distinct from run_id::text
      or archive->>'kind' is distinct from run_row.kind or jsonb_typeof(archive->'records') is distinct from 'array'
      or jsonb_array_length(archive->'records')>1000 then
      raise exception 'This recovery file cannot be applied';
    end if;
    if run_row.kind='support' then
      entries=array(select r-'id'-'fingerprint'-'eligible'-'authorName'-'assigneeName'-'solverName'
        from jsonb_array_elements(archive->'records') r where (r->'request'->>'id')::uuid=any(run_row.cleared_ids));
      for restore_offset in 1..coalesce(cardinality(entries),0) by 25 loop
        x=public.wlf_backup_admin('restore',actor,jsonb_build_object('project',payload->>'project','archive',
          jsonb_build_object('format','WLF-SUPPORT-2.1','project',payload->>'project','records',to_jsonb(entries[restore_offset:restore_offset+24]))));
        restored=restored+(x->>'restored')::int;
      end loop;
    elsif run_row.kind='activity' then
      insert into public.wlf_ri_entries
        select (jsonb_populate_record(null::public.wlf_ri_entries,r->'entry')).*
        from jsonb_array_elements(archive->'records') r
        where (r->'entry'->>'id')::uuid=any(run_row.cleared_ids)
        on conflict(id) do nothing;
      get diagnostics restored=row_count;
    elsif run_row.kind='project' then
      insert into public.wlf_ri_projects
        select (jsonb_populate_record(null::public.wlf_ri_projects,r->'project')).*
        from jsonb_array_elements(archive->'records') r
        where (r->'project'->>'id')::uuid=any(run_row.cleared_ids)
        on conflict do nothing;
      get diagnostics restored=row_count;
    elsif run_row.kind='qms' then
      for x in select r->'lift' from jsonb_array_elements(archive->'records') r
               where (r->'lift'->>'id')::uuid=any(run_row.cleared_ids) loop
        rec := jsonb_populate_record(null::wlf_private.qms_lifts, x);
        rec.parts := wlf_private.qms_parts_pack(rec.parts); rec.selection := wlf_private.qms_sel_pack(rec.selection);
        insert into wlf_private.qms_lifts select (rec).* on conflict do nothing;
        get diagnostics n = row_count; restored := restored+n;
      end loop;
    else
      insert into wlf_private.damage_demands overriding system value
        select (jsonb_populate_record(null::wlf_private.damage_demands,r->'demand')).*
        from jsonb_array_elements(archive->'records') r
        where (r->'demand'->>'request_id')::uuid=any(run_row.cleared_ids)
        on conflict do nothing;
      get diagnostics restored=row_count;
    end if;
    update wlf_private.excel_runs set restored_at=now() where id=run_id;
    return jsonb_build_object('restored',restored);
  end if;
  raise exception 'Unsupported Excel backup action';
end
$$;

revoke all on function public.wlf_excel_admin(text,uuid,jsonb) from public,anon,authenticated;
grant execute on function public.wlf_excel_admin(text,uuid,jsonb) to service_role;


-- ---------------------------------------------------------------- Support data backup history: delete
do $r$ begin
  if to_regprocedure('public.wlf_backup_admin_before_v262(text,uuid,jsonb)') is null then
    alter function public.wlf_backup_admin(text,uuid,jsonb) rename to wlf_backup_admin_before_v262;
  end if;
end $r$;

create or replace function public.wlf_backup_admin(action text,actor uuid,payload jsonb default '{}')
returns jsonb language plpgsql security definer set search_path='' as $$
declare removed integer;
begin
  if action<>'deleteBackupHistory' then
    return public.wlf_backup_admin_before_v262(action,actor,payload);
  end if;
  if not exists(select 1 from public.wlf_profiles p
    where p.id=actor and p.auth_user_id is not null and p.status='Approved' and p.role='Super Admin') then
    raise exception 'Super Admin only';
  end if;
  if coalesce((payload->>'all')::boolean,false) then
    if payload->>'confirm' is distinct from 'DELETE' then raise exception 'Type DELETE to delete all backup history.'; end if;
    delete from wlf_private.backup_runs;
  else
    delete from wlf_private.backup_runs where id=nullif(payload->>'id','')::uuid;
  end if;
  get diagnostics removed = row_count;
  return jsonb_build_object('deleted',removed);
end
$$;
revoke all on function public.wlf_backup_admin_before_v262(text,uuid,jsonb) from public,anon,authenticated;
revoke all on function public.wlf_backup_admin(text,uuid,jsonb) from public,anon,authenticated;
grant execute on function public.wlf_backup_admin(text,uuid,jsonb) to service_role;

-- ---------------------------------------------------------------- API wrapper
do $r$ begin
  if to_regprocedure('wlf_private.rpc_before_v262(text,jsonb)') is null then
    alter function wlf_private.rpc(text,jsonb) rename to rpc_before_v262;
  end if;
end $r$;

create or replace function wlf_private.rpc(a text, args jsonb) returns jsonb
language plpgsql security definer set search_path='' as $$
declare
  p jsonb := coalesce(args->0,'{}');
  result jsonb;
  lift wlf_private.qms_lifts;
begin
  if a='getDocuments' and not wlf_private.can('documents:view') then
    raise exception 'Documents Links access is not enabled for your account.';
  end if;
  if a in ('saveDocumentCategory','deleteDocumentCategory','saveDocument','deleteDocument','saveDocumentFolder','deleteDocumentFolder')
     and not exists(select 1 from public.wlf_profiles where id=auth.uid() and status='Approved' and role='Super Admin') then
    raise exception 'Permission denied: Super Admin only';
  end if;
  if a='deleteQmsLift' and wlf_private.hw_has('qms:delete') then
    select * into lift from wlf_private.qms_lifts where id=nullif(p->>'id','')::uuid and deleted_at is null;
    if found then
      perform wlf_private.bin_add('qms-lift',lift.id::text,lift.lift_id,'QMS lift · '||lift.project,null,auth.uid());
    end if;
  end if;
  result := wlf_private.rpc_before_v262(a,args);
  if a in ('getSession','getAppContext') and jsonb_typeof(result)='object' then
    result := result || jsonb_build_object('build','2.6.2');
  end if;
  return result;
end
$$;

revoke all on function wlf_private.rpc_before_v262(text,jsonb) from public, anon, authenticated;
revoke all on function wlf_private.rpc(text,jsonb) from public, anon;
grant execute on function wlf_private.rpc(text,jsonb) to authenticated;

commit;

select
  (select count(*) from jsonb_array_elements(wlf_private.catalog()) x where x->>'key'='documents:view')=1 as documents_permission_ready,
  (select count(*) from wlf_private.recycle_bin where kind='qms-lift') as qms_lifts_in_bin,
  (select count(*) from public.wlf_profiles where status='Approved' and role<>'Super Admin' and not ('documents:view'=any(permissions))) as users_without_documents,
  to_regprocedure('wlf_private.rpc_before_v262(text,jsonb)') is not null as v262_ready;
