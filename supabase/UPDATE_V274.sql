-- =====================================================================
-- WLF Electrical Solution v2.7.4
--   * Hardware Catalogue page: Super Admin only. The old "Hardware Catalogue edit" permission is removed from everyone.
--   * Hardware Catalogue change log: who added, edited or deleted a catalogue row. The Super Admin chooses who may see it.
--   * Component change log moves to Components Data; the Super Admin chooses who may see it (no Usage Dashboard needed).
--   * Announcement: the Super Admin chooses who may create, edit and delete announcements.
-- Needs UPDATE_V273.sql (v2.7.3). Safe to run more than once.
-- =====================================================================
begin;

do $pre$ begin
  if to_regprocedure('wlf_private.rpc_before_v273(text,jsonb)') is null then
    raise exception 'STOP: apply UPDATE_V273.sql (v2.7.3) first. Nothing was changed.';
  end if;
end $pre$;

-- ---------------------------------------------------------------- 1. the list of permissions the Super Admin can give
do $c$ begin
  if to_regprocedure('wlf_private.catalog_before_v274()') is null then
    alter function wlf_private.catalog() rename to catalog_before_v274;
  end if;
end $c$;
create or replace function wlf_private.catalog() returns jsonb
language sql stable security definer set search_path='' as $$
  select coalesce((select jsonb_agg(case when x->>'key'='components:log'
        then x||'{"label":"Component change log (who added, edited or deleted components)","group":"Components Data"}'::jsonb else x end order by o)
      from jsonb_array_elements(wlf_private.catalog_before_v274()) with ordinality t(x,o)
      where x->>'key' <> 'catalogue:edit'),'[]'::jsonb)
  || jsonb_build_array(
    jsonb_build_object('key','catalogue:log','label','Hardware Catalogue change log (who added, edited or deleted catalogue rows)','group','Hardware Catalogue'),
    jsonb_build_object('key','announcements:manage','label','Announcement (create, edit and delete announcements)','group','Announcement'))
$$;
revoke all on function wlf_private.catalog_before_v274() from public, anon, authenticated;

-- ---------------------------------------------------------------- 2. nobody but the Super Admin edits the catalogue
update public.wlf_profiles set permissions = array_remove(permissions,'catalogue:edit') where 'catalogue:edit' = any(permissions);

-- ---------------------------------------------------------------- 3. Component change log: its own permission
create or replace function wlf_private.component_log_allowed_v256(u public.wlf_profiles) returns boolean
language sql stable set search_path='' as $$
  select u.status='Approved' and (u.role='Super Admin' or 'components:log'=any(u.permissions))
$$;

-- ---------------------------------------------------------------- 4. Announcement: Super Admin or a person the Super Admin chose
do $patch$
declare def text; fixed text; repl text;
begin
  def := pg_get_functiondef(to_regprocedure('wlf_private.announcement_api(text,jsonb,public.wlf_profiles)'));
  if def like '%announcements:manage%' then return; end if;   -- already patched
  repl := 'if not (u.status=''Approved'' and (u.role=''Super Admin'' or ''announcements:manage''=any(u.permissions))) then raise exception ''Permission denied: Announcement access required''; end if;\1if a=''getAnnouncementAdmin''';
  fixed := regexp_replace(def, 'if u\.role is distinct from ''Super Admin'' then raise exception ''Permission denied: Super Admin only''; end if;(\s*)if a=''getAnnouncementAdmin''', repl);
  if fixed = def then raise exception 'STOP: the announcement function was not recognised. Nothing was changed.'; end if;
  execute fixed;
end $patch$;

-- ---------------------------------------------------------------- 5. Hardware Catalogue change log
create table if not exists wlf_private.hw_catalogue_log(
  id bigint generated always as identity primary key,
  at timestamptz not null default now(),
  actor uuid,
  actor_name text not null default '',
  action text not null check (action in ('Added','Edited','Deleted','Restored')),
  row_id uuid,
  label text not null default '',
  changes jsonb not null default '[]'::jsonb
);
create index if not exists hw_catalogue_log_at on wlf_private.hw_catalogue_log(at desc);
alter table wlf_private.hw_catalogue_log enable row level security;
revoke all on wlf_private.hw_catalogue_log from public, anon, authenticated;

create or replace function wlf_private.hw_catalogue_log_trigger() returns trigger
language plpgsql security definer set search_path='' as $$
declare
  o jsonb := case when tg_op in ('UPDATE','DELETE') then to_jsonb(old) else '{}'::jsonb end;
  v jsonb := case when tg_op in ('INSERT','UPDATE') then to_jsonb(new) else '{}'::jsonb end;
  cur jsonb := case when tg_op='DELETE' then o else v end;
  who uuid := auth.uid();
  act text;
  ch jsonb;
begin
  if tg_op='INSERT' then act := 'Added';
  elsif tg_op='DELETE' then act := 'Deleted';
  elsif old.deleted_at is null and new.deleted_at is not null then act := 'Deleted';
  elsif old.deleted_at is not null and new.deleted_at is null then act := 'Restored';
  else act := 'Edited'; end if;
  select coalesce(jsonb_agg(jsonb_build_object('field',f.label,'old',coalesce(o->>f.k,''),'new',coalesce(v->>f.k,'')) order by f.ord),'[]'::jsonb) into ch
    from (values ('system','Control system',1),('model','Model',2),('grp','Group',3),('hardware','Hardware',4),('spec','Spec',5),
                 ('item_code','Item code',6),('item_name','Item name',7),('brand','Brand',8),('supplier','Supplier',9),('value','Price',10)) as f(k,label,ord)
   where case when act in ('Added','Deleted','Restored') then coalesce(cur->>f.k,'')<>'' else coalesce(o->>f.k,'') is distinct from coalesce(v->>f.k,'') end;
  if act='Edited' and jsonb_array_length(ch)=0 then return null; end if;   -- only the order or the revision changed
  insert into wlf_private.hw_catalogue_log(actor,actor_name,action,row_id,label,changes)
  values(who,
    coalesce((select coalesce(nullif(p.name,''),p.email) from public.wlf_profiles p where p.id=who),
             case when who is null then 'Database (SQL Editor)' else '' end),
    act, case when tg_op='DELETE' then old.id else new.id end,
    left(concat_ws(' · ',nullif(cur->>'system',''),nullif(cur->>'model',''),coalesce(nullif(cur->>'item_name',''),nullif(cur->>'hardware',''))),300),
    ch);
  return null;
end
$$;
revoke all on function wlf_private.hw_catalogue_log_trigger() from public, anon, authenticated;
drop trigger if exists wlf_hw_catalogue_log on wlf_private.hw_catalogue;
create trigger wlf_hw_catalogue_log after insert or update or delete on wlf_private.hw_catalogue
  for each row execute function wlf_private.hw_catalogue_log_trigger();

create or replace function wlf_private.hw_log_api(p jsonb, u public.wlf_profiles) returns jsonb
language plpgsql stable security definer set search_path='' as $$
declare pr record; q text := lower(btrim(coalesce(p->>'q','')));
begin
  if not (u.status='Approved' and (u.role='Super Admin' or 'catalogue:log'=any(u.permissions))) then
    raise exception 'Permission denied: Hardware Catalogue change log access required';
  end if;
  if coalesce(p->>'from','')='' then p := p || jsonb_build_object('from',((now() at time zone 'Asia/Dhaka')::date-29)::text); end if;
  select * into pr from wlf_private.period(p);
  return jsonb_build_object('from',pr.d_from,'to',pr.d_to,
    'total',(select count(*) from wlf_private.hw_catalogue_log l where l.at>=pr.t_from and l.at<pr.t_to
      and (q='' or lower(l.actor_name||' '||l.action||' '||l.label||' '||l.changes::text) like '%'||q||'%')),
    'rows',coalesce((select jsonb_agg(jsonb_build_object('id',l.id,'at',l.at,'who',l.actor_name,'action',l.action,
        'rowId',l.row_id,'label',l.label,'changes',l.changes) order by l.at desc,l.id desc)
      from (select * from wlf_private.hw_catalogue_log l where l.at>=pr.t_from and l.at<pr.t_to
        and (q='' or lower(l.actor_name||' '||l.action||' '||l.label||' '||l.changes::text) like '%'||q||'%')
        order by l.at desc,l.id desc limit 1000) l),'[]'::jsonb));
end
$$;
revoke all on function wlf_private.hw_log_api(jsonb,public.wlf_profiles) from public, anon, authenticated;

-- ---------------------------------------------------------------- 6. API wrapper: the new action + build number
do $r$ begin
  if to_regprocedure('wlf_private.rpc_before_v274(text,jsonb)') is null then
    alter function wlf_private.rpc(text,jsonb) rename to rpc_before_v274;
  end if;
end $r$;

create or replace function wlf_private.rpc(a text, args jsonb) returns jsonb
language plpgsql security definer set search_path='' as $$
declare result jsonb; p jsonb := coalesce(args->0,'{}'); me public.wlf_profiles;
begin
  if a='getCatalogueLog' then
    me := wlf_private.me();
    if me.id is null or me.status is distinct from 'Approved' then raise exception 'SESSION_EXPIRED: Account is pending approval or inactive'; end if;
    return wlf_private.hw_log_api(p,me);
  end if;
  result := wlf_private.rpc_before_v274(a,args);
  if a in ('getSession','getAppContext') and jsonb_typeof(result)='object' then
    result := result || jsonb_build_object('build','2.7.4');
  end if;
  return result;
end
$$;
revoke all on function wlf_private.rpc_before_v274(text,jsonb) from public, anon, authenticated;
revoke all on function wlf_private.rpc(text,jsonb) from public, anon;
grant execute on function wlf_private.rpc(text,jsonb) to authenticated;

notify pgrst, 'reload schema';
commit;

select to_regprocedure('wlf_private.rpc_before_v274(text,jsonb)') is not null
   and to_regclass('wlf_private.hw_catalogue_log') is not null
   and not exists(select 1 from public.wlf_profiles where 'catalogue:edit'=any(permissions)) as v274_ready;
