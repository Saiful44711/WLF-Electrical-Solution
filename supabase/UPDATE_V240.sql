-- =====================================================================
-- WLF Electrical Solution v2.4.1 : Document folders, task Assignee,
-- spelling corrections.
-- Run in Supabase > SQL Editor on the project that already has v2.3.0
-- (UPDATE_SECTIONS_V230.sql). Safe to run twice. Back up first.
-- v2.4.1: only the task error text says Assignee. If the v2.4.0 copy of this
-- file was already run, running this copy again is safe and updates that text.
--
--  * Documents Links: folders (and sub-folders, up to 6 levels) inside every
--    sub menu. Only Super Admin creates, renames, moves or deletes them.
--    A folder can be deleted only when it is empty.
--  * R&I Project Manager: a task must be assigned to the project lead or a
--    collaborator (checked on the server). People show as Name (ID).
--  * Spelling: "1. Asthetics" -> "1. Aesthetics" (Installation form) and
--    "runs in in up direction" -> "runs in up direction" (Troubleshooting).
-- =====================================================================
begin;

do $pre$ begin
  if to_regprocedure('wlf_private.rpc_before_sections(text,jsonb)') is null
     or to_regprocedure('wlf_private.person_label(uuid)') is null then
    raise exception 'STOP: apply UPDATE_SECTIONS_V230.sql (v2.3.0) first. Nothing was changed.';
  end if;
end $pre$;

-- ---------------------------------------------------------------- folders
create table if not exists public.wlf_document_folders(
  id uuid primary key default gen_random_uuid(),
  category uuid not null references public.wlf_document_categories(id) on delete cascade,
  parent uuid references public.wlf_document_folders(id) on delete cascade,
  name text not null check (length(btrim(name)) between 1 and 120),
  revision integer not null default 1,
  created_at timestamptz not null default now()
);
create unique index if not exists wlf_document_folders_sibling_name_idx
  on public.wlf_document_folders(category, coalesce(parent,'00000000-0000-0000-0000-000000000000'::uuid), lower(btrim(name)));
create index if not exists wlf_document_folders_parent_idx on public.wlf_document_folders(parent);
alter table public.wlf_documents add column if not exists folder uuid references public.wlf_document_folders(id) on delete set null;
create index if not exists wlf_documents_folder_idx on public.wlf_documents(folder);

alter table public.wlf_document_folders enable row level security;
drop policy if exists wlf_doc_folders_read on public.wlf_document_folders;
create policy wlf_doc_folders_read on public.wlf_document_folders for select to authenticated using ((select wlf_private.approved()));
revoke all on public.wlf_document_folders from public, anon, authenticated;
grant select on public.wlf_document_folders to authenticated;

-- Depth of a folder (1 = directly inside the sub menu)
create or replace function wlf_private.folder_depth(f uuid) returns integer
language sql stable security definer set search_path='' as $$
  with recursive up(id, parent, n) as (
    select id, parent, 1 from public.wlf_document_folders where id=f
    union all
    select x.id, x.parent, up.n+1 from public.wlf_document_folders x join up on x.id=up.parent where up.n<50)
  select coalesce(max(n),0) from up
$$;
-- True when "candidate" is f itself or one of its sub-folders (prevents loops on move)
create or replace function wlf_private.folder_within(candidate uuid, f uuid) returns boolean
language sql stable security definer set search_path='' as $$
  with recursive down(id, n) as (
    select id, 1 from public.wlf_document_folders where id=f
    union all
    select x.id, down.n+1 from public.wlf_document_folders x join down on x.parent=down.id where down.n<50)
  select exists(select 1 from down where id=candidate)
$$;
-- Height of the sub-tree under f (1 = no sub-folders)
create or replace function wlf_private.folder_height(f uuid) returns integer
language sql stable security definer set search_path='' as $$
  with recursive down(id, n) as (
    select id, 1 from public.wlf_document_folders where id=f
    union all
    select x.id, down.n+1 from public.wlf_document_folders x join down on x.parent=down.id where down.n<50)
  select coalesce(max(n),0) from down
$$;
-- Tasks: Assignee must be the project lead or a collaborator (or keep the earlier user)
CREATE OR REPLACE FUNCTION wlf_private.ri_project_data(data jsonb, previous jsonb)
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE
 SET search_path TO ''
AS $function$
declare
  proj_name text=btrim(coalesce(data->>'name','')); lead uuid; collaborator uuid; member_ids jsonb;
  old_members jsonb; task jsonb; old_task jsonb; tasks jsonb='[]'; task_id uuid; task_owner uuid;
  task_name text; task_progress integer; task_status text; start_date date; end_date date;
  task_start date; task_end date;
begin
  if jsonb_typeof(data) is distinct from 'object' or octet_length(data::text)>65000 or length(proj_name) not between 1 and 180
      or coalesce(data->>'impact','') not in ('Product Development','Process Improvement','Business Development')
      or coalesce(data->>'status','') not in ('In Progress','On Hold','Done','Cancelled') then
    raise exception 'Check the project name, impact type and status.';
  end if;
  start_date=nullif(data->>'start','')::date; end_date=nullif(data->>'end','')::date;
  if start_date is null or end_date is null or start_date>end_date then raise exception 'Select valid project dates'; end if;
  lead=nullif(data->>'lead','')::uuid;
  if lead is null or (not wlf_private.ri_person_allowed(lead) and lead::text is distinct from previous->>'lead') then
    raise exception 'Choose a project lead with access.';
  end if;
  member_ids=coalesce(data->'collaborators','[]'); old_members=coalesce(previous->'collaborators','[]');
  if jsonb_typeof(member_ids)<>'array' or jsonb_array_length(member_ids)>50
     or (select count(distinct value) from jsonb_array_elements_text(member_ids))<>jsonb_array_length(member_ids) then
    raise exception 'Choose up to 50 distinct collaborators.';
  end if;
  for collaborator in select value::uuid from jsonb_array_elements_text(member_ids) loop
    if collaborator is null or collaborator=lead or
      (not wlf_private.ri_person_allowed(collaborator) and not (old_members ? collaborator::text)) then
      raise exception 'Choose collaborators with project access who are different from the lead.';
    end if;
  end loop;
  if jsonb_typeof(data->'tasks') is distinct from 'array' or jsonb_array_length(data->'tasks')>150 then
    raise exception 'A project can contain up to 150 tasks.';
  end if;
  for task in select value from jsonb_array_elements(data->'tasks') loop
    task_id=(task->>'id')::uuid; task_name=btrim(coalesce(task->>'name',''));
    task_owner=nullif(task->>'owner','')::uuid;
    task_progress=(task->>'progress')::integer; task_status=task->>'status';
    task_start=nullif(task->>'start','')::date; task_end=nullif(task->>'end','')::date;
    select t into old_task from jsonb_array_elements(coalesce(previous->'tasks','[]')) t where t->>'id'=task_id::text;
    if task_id is null or tasks @> jsonb_build_array(jsonb_build_object('id',task_id))
      or length(task_name) not between 1 and 180 or task_start is null or task_end is null or task_start>task_end
      or task_progress is null or task_progress not between 0 and 100
      or coalesce(task_status,'') not in ('Pending','In Progress','On Hold','Done','Cancelled')
      or (task_owner is not null and not wlf_private.ri_person_allowed(task_owner)
          and task_owner::text is distinct from old_task->>'owner')
      or (task_owner is null and old_task is null)
      or (task_owner is not null and task_owner<>lead and not (member_ids ? task_owner::text)
          and task_owner::text is distinct from old_task->>'owner') then
      raise exception 'Check the task name, dates, progress, status and Assignee (project lead or a collaborator).';
    end if;
    tasks=tasks||jsonb_build_array(jsonb_build_object('id',task_id,'name',task_name,'owner',coalesce(task_owner::text,''),
      'start',task_start,'end',task_end,'status',task_status,'progress',task_progress));
  end loop;
  return jsonb_build_object('name',proj_name,'lead',lead,'collaborators',member_ids,'start',start_date,'end',end_date,
    'impact',data->>'impact','status',data->>'status','brief',left(coalesce(data->>'brief',''),4000),
    'financial',coalesce((data->>'financial')::boolean,false),'documentation',coalesce((data->>'documentation')::boolean,false),
    'tasks',tasks);
end
$function$;

-- Projects: people shown as Name (ID)
CREATE OR REPLACE FUNCTION wlf_private.ri_projects(action text, p jsonb)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare
  u public.wlf_profiles=wlf_private.me(); rec public.wlf_ri_projects;
  project_id uuid; op uuid; payload_hash text; vals jsonb; people jsonb; rows jsonb;
  after_at timestamptz; after_id uuid;
begin
  if not wlf_private.ri_enabled('ri:projects') then raise exception 'R&I Project Manager access required'; end if;
  if action='getRiProjects' then
    after_at=nullif(p->>'beforeAt','')::timestamptz; after_id=nullif(p->>'beforeId','')::uuid;
    select coalesce(jsonb_agg(to_jsonb(r)-'last_operation'-'last_payload_hash' order by created_at desc,id desc),'[]') into rows
    from (select r.*,wlf_private.person_label(profile.id) owner_name from public.wlf_ri_projects r
      join public.wlf_profiles profile on profile.id=r.owner where r.deleted_at is null
      and (coalesce(p->>'query','')='' or position(lower(left(p->>'query',200)) in lower(r.data->>'name'))>0)
      and (coalesce(p->>'lead','')='' or r.data->>'lead'=p->>'lead')
      and (coalesce(p->>'collaborator','')='' or r.data->'collaborators' ? (p->>'collaborator'))
      and (coalesce(p->>'impact','')='' or r.data->>'impact'=p->>'impact')
      and (coalesce(p->>'status','')='' or r.data->>'status'=p->>'status')
      and (after_at is null or (r.created_at,r.id)<(after_at,after_id))
      order by r.created_at desc,r.id desc limit 21) r;
    -- Include historic display names for returned projects even if access was subsequently removed.
    select coalesce(jsonb_agg(jsonb_build_object('id',p.id,'name',wlf_private.person_label(p.id),'eligible',wlf_private.ri_person_allowed(p.id)) order by p.name,p.id),'[]') into people
    from public.wlf_profiles p
    where (p.status='Approved' and (p.role='Super Admin' or 'ri:projects'=any(p.permissions))) or p.id::text in (
      select r->'data'->>'lead' from jsonb_array_elements(rows) r
      union select c from jsonb_array_elements(rows) r cross join lateral jsonb_array_elements_text(r->'data'->'collaborators') c
      union select t->>'owner' from jsonb_array_elements(rows) r cross join lateral jsonb_array_elements(r->'data'->'tasks') t
    );
    return jsonb_build_object('projects',case when jsonb_array_length(rows)>20 then rows-20 else rows end,
      'hasMore',jsonb_array_length(rows)>20,'people',people);
  end if;

  if action not in ('saveRiProject','deleteRiProject') then raise exception 'Unsupported project action'; end if;
  project_id=(p->>'id')::uuid; op=(p->>'operation')::uuid; payload_hash=md5(action||p::text);
  if project_id is null or op is null then raise exception 'Missing project or operation ID'; end if;
  perform pg_advisory_xact_lock(hashtextextended('wlf-ri-project:'||project_id,0));
  select * into rec from public.wlf_ri_projects where id=project_id for update;
  if found then
    if rec.owner<>u.id and u.role<>'Super Admin' then raise exception 'Only the project creator or Super Admin can change the project or its tasks'; end if;
    if rec.last_operation=op then
      if rec.last_payload_hash<>payload_hash then raise exception 'Operation ID reused with different data'; end if;
      return to_jsonb(rec)-'last_operation'-'last_payload_hash';
    end if;
    if rec.deleted_at is not null or rec.revision is distinct from (p->>'revision')::integer then
      raise exception 'CONFLICT: Project changed. Refresh and review.';
    end if;
    if action='deleteRiProject' then
      update public.wlf_ri_projects set deleted_at=now(),updated_at=now(),revision=revision+1,
        last_operation=op,last_payload_hash=payload_hash where id=project_id returning * into rec;
    else
      vals=wlf_private.ri_project_data(p->'data',rec.data);
      update public.wlf_ri_projects set data=vals,updated_at=now(),revision=revision+1,
        last_operation=op,last_payload_hash=payload_hash where id=project_id returning * into rec;
    end if;
  else
    if action<>'saveRiProject' or (p->>'revision')::integer is distinct from 0 then raise exception 'Project no longer available'; end if;
    vals=wlf_private.ri_project_data(p->'data','{}');
    insert into public.wlf_ri_projects(id,owner,data,last_operation,last_payload_hash) values(project_id,u.id,vals,op,payload_hash) returning * into rec;
    insert into public.wlf_usage(actor,action,details) values(u.id,'R&I Project Manager',vals->>'name');
  end if;
  return to_jsonb(rec)-'last_operation'-'last_payload_hash';
end
$function$;

-- ---------------------------------------------------------------- spelling
update public.wlf_forms set schema=replace(schema::text,'"1. Asthetics"','"1. Aesthetics"')::jsonb, revision=revision+1
 where schema::text like '%"1. Asthetics"%';
update public.wlf_troubleshooting set content=replace(content::text,'runs in in up direction','runs in up direction')::jsonb, revision=revision+1
 where content::text like '%runs in in up direction%';

-- ---------------------------------------------------------------- RPC layer
do $layer$ begin
  if to_regprocedure('wlf_private.rpc_before_v240(text,jsonb)') is null then
    alter function wlf_private.rpc(text,jsonb) rename to rpc_before_v240;
  end if;
end $layer$;

create or replace function wlf_private.rpc(a text, args jsonb) returns jsonb
language plpgsql security definer set search_path='' as $$
declare
  p jsonb := coalesce(args->0,'{}');
  u public.wlf_profiles;
  result jsonb;
  f public.wlf_document_folders;
  v_name text; v_parent uuid; v_category uuid; v_folder uuid;
begin
  u := wlf_private.me();
  if u.id is null or u.status is distinct from 'Approved' then
    raise exception 'SESSION_EXPIRED: Account is pending approval or inactive';
  end if;
  if octet_length(args::text)>100000 then raise exception 'Request too large'; end if;

  if a='saveDocumentFolder' then
    if u.role<>'Super Admin' then raise exception 'Permission denied: Super Admin only'; end if;
    v_name := btrim(coalesce(p->>'name',''));
    if length(v_name) not between 1 and 120 then raise exception 'Enter a folder name (1-120 characters).'; end if;
    v_parent := nullif(p->>'parent','')::uuid;
    if coalesce(p->>'id','')='' then
      v_category := nullif(p->>'category','')::uuid;
      if not exists(select 1 from public.wlf_document_categories where id=v_category) then raise exception 'Sub menu not found'; end if;
    else
      select * into f from public.wlf_document_folders where id=(p->>'id')::uuid for update;
      if not found then raise exception 'Folder not found. Refresh the list.'; end if;
      if f.revision is distinct from (p->>'revision')::integer then raise exception 'CONFLICT: Folder changed. Refresh the list.'; end if;
      v_category := f.category;
    end if;
    if v_parent is not null then
      if not exists(select 1 from public.wlf_document_folders where id=v_parent and category=v_category) then
        raise exception 'Choose a folder in the same sub menu.';
      end if;
      if f.id is not null and wlf_private.folder_within(v_parent, f.id) then
        raise exception 'A folder cannot be moved into itself or its own sub-folder.';
      end if;
    end if;
    if (coalesce(wlf_private.folder_depth(v_parent),0) + (case when f.id is null then 1 else wlf_private.folder_height(f.id) end)) > 6 then
      raise exception 'Folders can be nested up to 6 levels.';
    end if;
    begin
      if f.id is null then
        insert into public.wlf_document_folders(category,parent,name) values(v_category,v_parent,v_name) returning * into f;
      else
        update public.wlf_document_folders set name=v_name, parent=v_parent, revision=revision+1 where id=f.id returning * into f;
      end if;
    exception when unique_violation then
      raise exception 'A folder with this name already exists here.';
    end;
    return to_jsonb(f);

  elsif a='deleteDocumentFolder' then
    if u.role<>'Super Admin' then raise exception 'Permission denied: Super Admin only'; end if;
    select * into f from public.wlf_document_folders where id=nullif(p->>'id','')::uuid for update;
    if not found then raise exception 'Folder not found. Refresh the list.'; end if;
    if f.revision is distinct from (p->>'revision')::integer then raise exception 'CONFLICT: Folder changed. Refresh the list.'; end if;
    if exists(select 1 from public.wlf_document_folders where parent=f.id) or exists(select 1 from public.wlf_documents where folder=f.id) then
      raise exception 'This folder is not empty. Move or delete its folders and documents first.';
    end if;
    delete from public.wlf_document_folders where id=f.id;
    return 'true';

  elsif a='saveDocument' and p ? 'folder' then
    if u.role<>'Super Admin' then raise exception 'Permission denied: Super Admin only'; end if;
    v_folder := nullif(p->>'folder','')::uuid;
    if v_folder is not null and not exists(select 1 from public.wlf_document_folders
        where id=v_folder and category=nullif(p->>'category','')::uuid) then
      raise exception 'Choose a folder in the same sub menu.';
    end if;
    result := wlf_private.rpc_before_v240(a, jsonb_build_array(p-'folder')||(args-0));
    update public.wlf_documents set folder=v_folder where id=(result->>'id')::uuid;
    return (select to_jsonb(d) from public.wlf_documents d where d.id=(result->>'id')::uuid);
  end if;

  result := wlf_private.rpc_before_v240(a,args);

  if a='getDocuments' then
    result := result||jsonb_build_object('folders',coalesce((select jsonb_agg(to_jsonb(x) order by lower(x.name), x.id)
      from public.wlf_document_folders x),'[]'::jsonb));
  elsif a in ('getSession','getAppContext') then
    result := result||jsonb_build_object('build','2.4.1','documentFolders',true);
  end if;
  return result;
end
$$;

-- ---------------------------------------------------------------- grants
revoke all on function wlf_private.rpc_before_v240(text,jsonb) from public, anon, authenticated;
revoke all on function wlf_private.rpc(text,jsonb) from public, anon;
grant execute on function wlf_private.rpc(text,jsonb) to authenticated;
revoke all on function wlf_private.folder_depth(uuid) from public, anon, authenticated;
revoke all on function wlf_private.folder_within(uuid,uuid) from public, anon, authenticated;
revoke all on function wlf_private.folder_height(uuid) from public, anon, authenticated;

notify pgrst, 'reload schema';
commit;

-- ---------------------------------------------------------------- check
select
  to_regclass('public.wlf_document_folders') is not null as document_folders_ready,
  exists(select 1 from information_schema.columns where table_schema='public' and table_name='wlf_documents' and column_name='folder') as document_folder_column_ready,
  coalesce((select relrowsecurity from pg_class where oid='public.wlf_document_folders'::regclass),false) as folders_protected,
  not exists(select 1 from public.wlf_forms where schema::text like '%Asthetics%')
    and not exists(select 1 from public.wlf_troubleshooting where content::text like '%runs in in up%') as spelling_fixed,
  to_regprocedure('wlf_private.rpc_before_v240(text,jsonb)') is not null as task_and_folder_rules_ready;
