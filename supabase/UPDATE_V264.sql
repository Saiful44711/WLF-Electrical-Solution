-- WLF v2.6.4 · Admin Panel (per R&I user activity) and the Admin Panel permission name
-- Requires UPDATE_V263.sql (v2.6.3). Safe to run again.
begin;

do $c$ begin
  if to_regprocedure('wlf_private.rpc_before_v263(text,jsonb)') is null and to_regprocedure('wlf_private.rpc_before_v264(text,jsonb)') is null then
    raise exception 'Run UPDATE_V263.sql first (v2.6.3 is not installed).';
  end if;
end $c$;

-- ---------------------------------------------------------------- 1. minutes recorded in an R&I activity entry
create or replace function wlf_private.entry_minutes(vals jsonb) returns numeric
language sql immutable set search_path='' as $$
  select coalesce(sum(case when v ~ '^\s*[0-9]+(\.[0-9]+)?\s*$' then v::numeric end),0)
  from (select vals->>k v from unnest(array['duration_minute','duration_min','duration']) k) z
$$;

-- ---------------------------------------------------------------- 2. Admin Panel data: one block per approved R&I user
create or replace function wlf_private.admin_panel(p jsonb) returns jsonb
language plpgsql stable security definer set search_path='' as $$
declare pr record;
begin
  if not wlf_private.ri_enabled('workspace:dashboard') then raise exception 'Admin Panel access required'; end if;
  select * into pr from wlf_private.period(p);
  return jsonb_build_object('from',pr.d_from,'to',pr.d_to,
    'months',(select jsonb_agg(label order by i) from wlf_private.last_months()),
    'users',coalesce((select jsonb_agg(jsonb_build_object(
      'id',u.id,'name',wlf_private.person_label(u.id),
      'sectors',(select jsonb_agg(jsonb_build_object('section',s.k,'entries',x.n,'completed',x.c,'ongoing',x.o,'incomplete',x.i,'minutes',x.m) order by s.o)
        from (values ('team',1),('scm',2),('sales',3),('reports',4)) s(k,o)
        cross join lateral (
          select count(e.id) n,
            count(*) filter (where lower(e.status) in ('completed','solved','done')) c,
            count(*) filter (where lower(e.status) in ('ongoing','in progress')) o,
            count(*) filter (where lower(e.status) not in ('completed','solved','done','ongoing','in progress')) i,
            coalesce(sum(wlf_private.entry_minutes(e.values)),0) m
          from public.wlf_ri_entries e join public.wlf_ri_categories c on c.id=e.category
          where e.owner=u.id and c.section=s.k and e.deleted_at is null and e.created_at>=pr.t_from and e.created_at<pr.t_to) x),
      'support',(select jsonb_build_object('received',count(*) filter(where h.action='receive'),'solved',count(*) filter(where h.action='solve'),
          'notSolved',count(*) filter(where h.action='notSolved'),'forwarded',count(*) filter(where h.action='forward'))
        from public.wlf_history h join public.wlf_requests r on r.id=h.request_id and r.deleted_at is null
        where h.actor=u.id and h.at>=pr.t_from and h.at<pr.t_to and h.action in ('receive','forward','solve','notSolved')),
      'damage',(select count(*) from wlf_private.damage_demands d where d.confirmed_by=u.id and d.created_at>=pr.t_from and d.created_at<pr.t_to),
      'claims',(select count(*) from wlf_private.damage_demands d where d.claim_by=u.id and d.claim_at>=pr.t_from and d.claim_at<pr.t_to),
      'curve',jsonb_build_object(
        'Activity entries',(select jsonb_agg(coalesce((select count(*) from public.wlf_ri_entries e where e.owner=u.id and e.deleted_at is null
            and date_trunc('month',e.created_at at time zone 'Asia/Dhaka')=m.mon),0) order by m.i) from wlf_private.last_months() m),
        'Support solved',(select jsonb_agg(coalesce((select count(*) from public.wlf_history h join public.wlf_requests r on r.id=h.request_id and r.deleted_at is null
            where h.actor=u.id and h.action='solve' and date_trunc('month',h.at at time zone 'Asia/Dhaka')=m.mon),0) order by m.i) from wlf_private.last_months() m))
      ) order by wlf_private.person_label(u.id))
      from public.wlf_profiles u where u.role='R&I' and u.status='Approved'),'[]'::jsonb));
end
$$;
revoke all on function wlf_private.entry_minutes(jsonb), wlf_private.admin_panel(jsonb) from public, anon, authenticated;

-- ---------------------------------------------------------------- 3. permission wording: Dashboard becomes Admin Panel
do $c$ begin
  if to_regprocedure('wlf_private.catalog_before_v264()') is null then
    alter function wlf_private.catalog() rename to catalog_before_v264;
  end if;
end $c$;
create or replace function wlf_private.catalog() returns jsonb
language sql stable security definer set search_path='' as $$
  select coalesce(jsonb_agg(case when e->>'key'='workspace:dashboard'
      then e || jsonb_build_object('label','Admin Panel / View team performance and export','group','Admin Panel') else e end order by o),'[]'::jsonb)
  from jsonb_array_elements(wlf_private.catalog_before_v264()) with ordinality t(e,o)
$$;
revoke all on function wlf_private.catalog_before_v264() from public, anon, authenticated;

-- ---------------------------------------------------------------- 4. API wrapper
do $r$ begin
  if to_regprocedure('wlf_private.rpc_before_v264(text,jsonb)') is null then
    alter function wlf_private.rpc(text,jsonb) rename to rpc_before_v264;
  end if;
end $r$;

create or replace function wlf_private.rpc(a text, args jsonb) returns jsonb
language plpgsql security definer set search_path='' as $$
declare result jsonb;
begin
  if a='getAdminPanel' then
    if not wlf_private.approved() then raise exception 'SESSION_EXPIRED: Account is pending approval or inactive'; end if;
    return wlf_private.admin_panel(coalesce(args->0,'{}'));
  end if;
  result := wlf_private.rpc_before_v264(a,args);
  if a in ('getSession','getAppContext') and jsonb_typeof(result)='object' then
    result := result || jsonb_build_object('build','2.6.4');
  end if;
  return result;
end
$$;
revoke all on function wlf_private.rpc_before_v264(text,jsonb) from public, anon, authenticated;
revoke all on function wlf_private.rpc(text,jsonb) from public, anon;
grant execute on function wlf_private.rpc(text,jsonb) to authenticated;

notify pgrst, 'reload schema';
commit;

select
  to_regprocedure('wlf_private.admin_panel(jsonb)') is not null as admin_panel_ready,
  (select e->>'label' from jsonb_array_elements(wlf_private.catalog()) e where e->>'key'='workspace:dashboard') as permission_label,
  to_regprocedure('wlf_private.rpc_before_v264(text,jsonb)') is not null as v264_ready;
