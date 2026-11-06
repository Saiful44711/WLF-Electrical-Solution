create table if not exists wlf_private.excel_runs (
  id uuid primary key,
  actor uuid not null references public.wlf_profiles(id),
  kind text not null check(kind in ('support','activity')),
  date_from date,
  date_to date,
  with_clear boolean not null,
  created_at timestamptz not null default now(),
  nonce uuid,
  lease_until timestamptz,
  workbook_id text,
  workbook_hash text,
  recovery_id text,
  recovery_hash text,
  items jsonb not null default '[]',
  cleared_ids uuid[] not null default '{}',
  clear_finished boolean not null default false,
  restored_at timestamptz
);
alter table wlf_private.excel_runs enable row level security;
revoke all on wlf_private.excel_runs from public,anon,authenticated;
create index if not exists wlf_excel_runs_history_idx on wlf_private.excel_runs(created_at desc);

create or replace function wlf_private.excel_receipt(r wlf_private.excel_runs)
returns jsonb language sql stable security definer set search_path='' as $$
  select (to_jsonb(r)-'items'-'nonce'-'lease_until'-'cleared_ids')
    ||jsonb_build_object('total',jsonb_array_length(r.items),'cleared',cardinality(r.cleared_ids))
$$;

create or replace function public.wlf_excel_admin(action text, actor uuid, payload jsonb default '{}')
returns jsonb language plpgsql security definer set search_path='' as $$
declare
  run_id uuid; run_row wlf_private.excel_runs; workbook_kind text=payload->>'kind';
  period_from date; period_to date; clear_mode boolean;
  x jsonb; obj jsonb; source_row record; records jsonb[]='{}'; row_count int=0; total_bytes int=0;
  categories jsonb; ids uuid[]; archive jsonb; restored int=0; restore_offset integer; entries jsonb[];
begin
  if not exists(select 1 from public.wlf_profiles where id=actor and status='Approved' and role='Super Admin') then
    raise exception 'Super Admin only';
  end if;
  if action='history' then
    return (select coalesce(jsonb_agg(wlf_private.excel_receipt(r) order by created_at desc,id),'[]')
      from (select * from wlf_private.excel_runs where workbook_id is not null order by created_at desc,id limit 100) r);
  end if;
  run_id=(payload->>'id')::uuid;
  if run_id is null then raise exception 'Missing Excel backup ID'; end if;

  if action='prepare' then
    period_from=nullif(payload->>'from','')::date; period_to=nullif(payload->>'to','')::date;
    clear_mode=coalesce((payload->>'withClear')::boolean,false);
    if coalesce(workbook_kind,'') not in ('support','activity') or (period_from is null)<>(period_to is null)
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
    else
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
    else
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
    else
      insert into public.wlf_ri_entries
        select (jsonb_populate_record(null::public.wlf_ri_entries,r->'entry')).*
        from jsonb_array_elements(archive->'records') r
        where (r->'entry'->>'id')::uuid=any(run_row.cleared_ids)
        on conflict(id) do nothing;
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
revoke all on all functions in schema wlf_private from public,anon;
revoke all on function wlf_private.rpc_v210(text,jsonb) from authenticated;
grant execute on function wlf_private.rpc(text,jsonb) to authenticated;
notify pgrst,'reload schema';
