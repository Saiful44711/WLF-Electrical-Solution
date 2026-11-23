-- WLF v2.6.3 — Usage log archive to Google Drive, Backup of all other data, calculations no longer saved.
-- Needs UPDATE_V262.sql first. Safe to run twice. Run in Supabase SQL Editor.
begin;

do $c$ begin
  if to_regprocedure('wlf_private.rpc_before_v262(text,jsonb)') is null and to_regprocedure('wlf_private.rpc_before_v263(text,jsonb)') is null then
    raise exception 'Run UPDATE_V262.sql first (v2.6.2 is not installed).';
  end if;
end $c$;

-- ---------------------------------------------------------------- 1. Usage log: Drive archive before delete
create table if not exists wlf_private.usage_archives(
  id uuid primary key default gen_random_uuid(),
  created_at timestamptz not null default now(),
  actor uuid,
  rows_count integer not null,
  from_at timestamptz,
  to_at timestamptz,
  file_id text not null,
  sha256 text not null
);
alter table wlf_private.usage_archives enable row level security;
revoke all on wlf_private.usage_archives from public, anon, authenticated;

create or replace function public.wlf_usage_admin(action text, actor uuid, payload jsonb default '{}')
returns jsonb language plpgsql security definer set search_path='' as $$
declare
  cutoff timestamptz := now()-interval '7 days';
  max_id bigint; cnt integer; gone integer; stamp timestamptz; first_at timestamptz; last_at timestamptz; rows_json jsonb;
begin
  if not exists(select 1 from public.wlf_profiles where id=actor and status='Approved' and role='Super Admin') then
    raise exception 'Super Admin only';
  end if;
  if action='prepare' then
    select coalesce(jsonb_agg(jsonb_build_object('id',l.id,'at',l.at,'who',coalesce(wlf_private.person_label(l.actor),''),
        'action',l.action,'details',coalesce(l.details,'')) order by l.id),'[]'),count(*),max(l.id),min(l.at),max(l.at)
      into rows_json,cnt,max_id,first_at,last_at
      from (select * from public.wlf_usage where at<cutoff order by id limit 20000) l;
    return jsonb_build_object('count',cnt,'maxId',max_id,'cutoff',cutoff,'from',first_at,'to',last_at,
      'remaining',(select count(*) from public.wlf_usage where at<cutoff)-cnt,'rows',rows_json);
  elsif action='finish' then
    if coalesce(payload->>'fileId','')!~'^[-a-zA-Z0-9_]{5,200}$' or coalesce(payload->>'sha256','')!~'^[0-9a-f]{64}$' then
      raise exception 'The verified Drive file is missing. Nothing was deleted.';
    end if;
    max_id := (payload->>'maxId')::bigint; cnt := (payload->>'count')::integer; stamp := (payload->>'cutoff')::timestamptz;
    if stamp>now()-interval '7 days' then raise exception 'Only rows older than 7 days can be deleted.'; end if;
    select min(at),max(at) into first_at,last_at from public.wlf_usage where id<=max_id and at<stamp;
    delete from public.wlf_usage where id<=max_id and at<stamp;
    get diagnostics gone = row_count;
    if gone>cnt then raise exception 'The log changed after the backup. Nothing was deleted.'; end if;
    insert into wlf_private.usage_archives(actor,rows_count,from_at,to_at,file_id,sha256)
      values(actor,gone,first_at,last_at,payload->>'fileId',payload->>'sha256');
    insert into wlf_private.purge_log(actor,what,counts)
      values(actor,'Activity log saved to Google Drive, then deleted (older than 7 days)',jsonb_build_object('usage-log',gone));
    return jsonb_build_object('deleted',gone);
  elsif action='history' then
    return (select coalesce(jsonb_agg(jsonb_build_object('id',a.id,'created_at',a.created_at,'rows',a.rows_count,'from',a.from_at,'to',a.to_at) order by a.created_at desc),'[]')
      from (select * from wlf_private.usage_archives order by created_at desc limit 30) a);
  end if;
  raise exception 'Unsupported usage archive action';
end
$$;
revoke all on function public.wlf_usage_admin(text,uuid,jsonb) from public,anon,authenticated;
grant execute on function public.wlf_usage_admin(text,uuid,jsonb) to service_role;

-- Safety net only: the Drive archive runs from the Super Admin session. Rows are deleted without an archive
-- only when they are older than 30 days, so the database can never fill up even if nobody opens the app.
create or replace function wlf_private.usage_autopurge() returns trigger
language plpgsql security definer set search_path='' as $$
declare due integer; gone bigint;
begin
  update wlf_private.usage_housekeeping set last_run=now()
    where id=1 and last_run<now()-interval '1 hour' returning 1 into due;
  if due is not null then
    delete from public.wlf_usage where at<now()-interval '30 days';
    get diagnostics gone = row_count;
    if gone>0 then
      insert into wlf_private.purge_log(actor,what,counts)
        values (null,'Usage log older than 30 days (automatic safety net, not archived)',jsonb_build_object('usage-log',gone));
    end if;
  end if;
  return null;
end
$$;

-- ---------------------------------------------------------------- 2. Backup of all other data
create table if not exists wlf_private.full_backups(
  id uuid primary key,
  created_at timestamptz not null default now(),
  actor uuid,
  counts jsonb not null,
  bytes integer not null,
  file_id text not null,
  sha256 text not null
);
alter table wlf_private.full_backups enable row level security;
revoke all on wlf_private.full_backups from public, anon, authenticated;

create or replace function public.wlf_full_admin(action text, actor uuid, payload jsonb default '{}')
returns jsonb language plpgsql security definer set search_path='' as $$
declare
  spec text[][] := array[
    ['public.wlf_profiles','users'],['public.wlf_settings','settings'],['public.wlf_forms','support-forms'],
    ['public.wlf_ri_categories','ri-categories'],['public.wlf_troubleshooting','troubleshooting'],['public.wlf_components','components'],
    ['public.wlf_document_categories','document-categories'],['public.wlf_document_folders','document-folders'],['public.wlf_documents','documents'],
    ['wlf_private.hw_catalogue','hardware-catalogue'],['wlf_private.hw_suggest','hardware-suggest'],['wlf_private.announcements','announcements']];
  i integer; tbl text; key text; rows_json jsonb; tables jsonb := '{}'; counts jsonb := '{}'; n integer; archive jsonb; restored jsonb := '{}';
  run wlf_private.full_backups;
begin
  if not exists(select 1 from public.wlf_profiles where id=actor and status='Approved' and role='Super Admin') then
    raise exception 'Super Admin only';
  end if;
  if action='history' then
    return (select coalesce(jsonb_agg(jsonb_build_object('id',r.id,'created_at',r.created_at,'counts',r.counts,'bytes',r.bytes) order by r.created_at desc),'[]')
      from (select * from wlf_private.full_backups order by created_at desc limit 100) r);
  elsif action='deleteHistory' then
    if coalesce((payload->>'all')::boolean,false) then
      if payload->>'confirm' is distinct from 'DELETE' then raise exception 'Type DELETE to delete all backup history.'; end if;
      delete from wlf_private.full_backups;
    else
      delete from wlf_private.full_backups where id=nullif(payload->>'id','')::uuid;
    end if;
    get diagnostics n = row_count;
    return jsonb_build_object('deleted',n);
  elsif action='export' then
    for i in 1..array_length(spec,1) loop
      execute format('select coalesce(jsonb_agg(to_jsonb(x)),''[]''::jsonb) from %s x',spec[i][1]) into rows_json;
      tables := tables || jsonb_build_object(spec[i][2],rows_json);
      counts := counts || jsonb_build_object(spec[i][2],jsonb_array_length(rows_json));
    end loop;
    if octet_length(tables::text)>7000000 then raise exception 'The data is too large for one backup file.'; end if;
    return jsonb_build_object('id',gen_random_uuid(),'counts',counts,'tables',tables);
  elsif action='record' then
    if coalesce(payload->>'fileId','')!~'^[-a-zA-Z0-9_]{5,200}$' or coalesce(payload->>'sha256','')!~'^[0-9a-f]{64}$' then
      raise exception 'The verified Drive file is missing.';
    end if;
    insert into wlf_private.full_backups(id,actor,counts,bytes,file_id,sha256)
      values((payload->>'id')::uuid,actor,coalesce(payload->'counts','{}'),coalesce((payload->>'bytes')::integer,0),payload->>'fileId',payload->>'sha256')
      on conflict(id) do nothing;
    return jsonb_build_object('id',payload->>'id');
  elsif action='read' then
    select * into run from wlf_private.full_backups where id=nullif(payload->>'id','')::uuid;
    if not found then raise exception 'Backup not found. It may have been deleted from the history.'; end if;
    return jsonb_build_object('id',run.id,'created_at',run.created_at,'counts',run.counts,'bytes',run.bytes,'file_id',run.file_id,'sha256',run.sha256);
  elsif action='restore' then
    archive := payload->'archive';
    if archive->>'format' is distinct from 'WLF-FULL-2.6.3' or jsonb_typeof(archive->'tables')<>'object' then raise exception 'Invalid backup file.'; end if;
    -- users are only kept in the file for reference: they belong to Supabase Auth and are never restored from here
    for i in 1..array_length(spec,1) loop
      continue when spec[i][2]='users';
      rows_json := archive->'tables'->spec[i][2];
      continue when rows_json is null or jsonb_typeof(rows_json)<>'array' or jsonb_array_length(rows_json)=0;
      execute format('insert into %s overriding system value select * from jsonb_populate_recordset(null::%s,$1) on conflict do nothing',spec[i][1],spec[i][1]) using rows_json;
      get diagnostics n = row_count;
      restored := restored || jsonb_build_object(spec[i][2],n);
    end loop;
    return jsonb_build_object('restored',restored);
  end if;
  raise exception 'Unsupported backup action';
end
$$;
revoke all on function public.wlf_full_admin(text,uuid,jsonb) from public,anon,authenticated;
grant execute on function public.wlf_full_admin(text,uuid,jsonb) to service_role;

-- ---------------------------------------------------------------- 3. API wrapper: calculations are no longer saved
do $r$ begin
  if to_regprocedure('wlf_private.rpc_before_v263(text,jsonb)') is null then
    alter function wlf_private.rpc(text,jsonb) rename to rpc_before_v263;
  end if;
end $r$;

create or replace function wlf_private.rpc(a text, args jsonb) returns jsonb
language plpgsql security definer set search_path='' as $$
declare result jsonb;
begin
  if a='saveEngineeringRecord' then
    raise exception 'Saving calculations has been removed. Use Print / Save as PDF.';
  end if;
  result := wlf_private.rpc_before_v263(a,args);
  if a in ('getSession','getAppContext') and jsonb_typeof(result)='object' then
    result := result || jsonb_build_object('build','2.6.3');
  end if;
  return result;
end
$$;
revoke all on function wlf_private.rpc_before_v263(text,jsonb) from public, anon, authenticated;
revoke all on function wlf_private.rpc(text,jsonb) from public, anon;
grant execute on function wlf_private.rpc(text,jsonb) to authenticated;

commit;

select
  to_regprocedure('public.wlf_usage_admin(text,uuid,jsonb)') is not null as usage_archive_ready,
  to_regprocedure('public.wlf_full_admin(text,uuid,jsonb)') is not null as full_backup_ready,
  (select count(*) from public.wlf_records) as saved_calculations_left,
  to_regprocedure('wlf_private.rpc_before_v263(text,jsonb)') is not null as v263_ready;
