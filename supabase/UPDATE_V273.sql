-- =====================================================================
-- WLF Electrical Solution v2.7.3
--   * R&I Project Manager: the person who created a project (and the Super Admin) can HIDE it.
--     A hidden project is not shown to anyone else: not in the project list, not in the dashboards, not in My work.
--     Nothing is deleted: the project can be shown again at any time.
-- Needs UPDATE_V272.sql (v2.7.2). Safe to run more than once.
-- =====================================================================
begin;

do $pre$ begin
  if to_regprocedure('wlf_private.rpc_before_v272(text,jsonb)') is null then
    raise exception 'STOP: apply UPDATE_V272.sql (v2.7.2) first. Nothing was changed.';
  end if;
end $pre$;

-- ---------------------------------------------------------------- 1. the flag (empty = not hidden, so old backups still restore)
alter table public.wlf_ri_projects add column if not exists hidden boolean default false;

-- the projects a signed-in person may see: not hidden, or created by them, or they are Super Admin
create or replace view wlf_private.ri_projects_visible as
  select p.id, p.owner, p.created_at, p.updated_at, p.data, p.revision, p.last_operation, p.last_payload_hash, p.deleted_at, p.hidden
    from public.wlf_ri_projects p
   where not coalesce(p.hidden,false)
      or p.owner = auth.uid()
      or exists(select 1 from public.wlf_profiles me where me.id = auth.uid() and me.status = 'Approved' and me.role = 'Super Admin');
revoke all on wlf_private.ri_projects_visible from public, anon, authenticated;

-- ---------------------------------------------------------------- 2. every screen that lists or counts projects reads the visible ones
do $patch$
declare
  f record; def text; fixed text;
begin
  for f in
    select * from (values
      ('wlf_private.management_dashboard(jsonb)'::text, 'public\.wlf_ri_projects'::text),
      ('wlf_private.ri_dashboard()', 'public\.wlf_ri_projects'),
      ('wlf_private.workspace_activity(boolean,timestamp with time zone,timestamp with time zone)', 'public\.wlf_ri_projects'),
      ('wlf_private.workspace_insights(text,jsonb)', 'public\.wlf_ri_projects'),
      ('wlf_private.ri_projects(text,jsonb)', 'public\.wlf_ri_projects r\s+join public\.wlf_profiles profile')
    ) as t(fn, pattern)
  loop
    def := pg_get_functiondef(to_regprocedure(f.fn));
    if def like '%ri_projects_visible%' then continue; end if;   -- already patched
    if f.fn like 'wlf_private.ri_projects(%' then
      fixed := regexp_replace(def, f.pattern, 'wlf_private.ri_projects_visible r join public.wlf_profiles profile');
    else
      fixed := regexp_replace(def, f.pattern, 'wlf_private.ri_projects_visible', 'g');
    end if;
    if fixed = def then raise exception 'STOP: % was not recognised. Nothing was changed.', f.fn; end if;
    execute fixed;
  end loop;
end $patch$;

-- ---------------------------------------------------------------- 3. API wrapper: hide / show + build number
do $r$ begin
  if to_regprocedure('wlf_private.rpc_before_v273(text,jsonb)') is null then
    alter function wlf_private.rpc(text,jsonb) rename to rpc_before_v273;
  end if;
end $r$;

create or replace function wlf_private.rpc(a text, args jsonb) returns jsonb
language plpgsql security definer set search_path='' as $$
declare result jsonb; p jsonb := coalesce(args->0,'{}'); me public.wlf_profiles; rec public.wlf_ri_projects;
begin
  if a='setRiProjectHidden' then
    if not wlf_private.approved() then raise exception 'SESSION_EXPIRED: Account is pending approval or inactive'; end if;
    if not wlf_private.ri_enabled('ri:projects') then raise exception 'R&I Project Manager access required'; end if;
    select * into me from public.wlf_profiles where id=auth.uid();
    select * into rec from public.wlf_ri_projects where id=nullif(p->>'id','')::uuid and deleted_at is null for update;
    if rec.id is null then raise exception 'Project no longer available'; end if;
    if rec.owner<>me.id and me.role<>'Super Admin' then
      raise exception 'Only the person who created the project or the Super Admin can hide or show it';
    end if;
    -- the revision is not changed: a person who is editing the project is not interrupted
    update public.wlf_ri_projects set hidden=coalesce((p->>'hidden')::boolean,false) where id=rec.id returning * into rec;
    return to_jsonb(rec)-'last_operation'-'last_payload_hash';
  end if;
  result := wlf_private.rpc_before_v273(a,args);
  if a in ('getSession','getAppContext') and jsonb_typeof(result)='object' then
    result := result || jsonb_build_object('build','2.7.3');
  end if;
  return result;
end
$$;
revoke all on function wlf_private.rpc_before_v273(text,jsonb) from public, anon, authenticated;
revoke all on function wlf_private.rpc(text,jsonb) from public, anon;
grant execute on function wlf_private.rpc(text,jsonb) to authenticated;

notify pgrst, 'reload schema';
commit;

select to_regprocedure('wlf_private.rpc_before_v273(text,jsonb)') is not null
   and to_regclass('wlf_private.ri_projects_visible') is not null as v273_ready;
