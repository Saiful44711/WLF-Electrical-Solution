-- =====================================================================
-- WLF Electrical Solution v2.7.1 — Admin Panel: QMS and Supplier Claim dashboards
--   * QMS: projects and lifts per control system; project tracking by hardware category
--     (category -> model -> the projects and Lift IDs that use it)
--   * Supplier Claim: Pending / Received, every supplier's claims, the components claimed most
-- Read-only: nothing is stored, nothing is changed. Needs UPDATE_V270.sql (v2.7.0).
-- Safe to run more than once.
-- =====================================================================
begin;

do $pre$ begin
  if to_regprocedure('wlf_private.rpc_before_v270(text,jsonb)') is null then
    raise exception 'STOP: apply UPDATE_V270.sql (v2.7.0) first. Nothing was changed.';
  end if;
end $pre$;

-- ---------------------------------------------------------------- 1. dashboard data (Admin Panel permission)
create or replace function wlf_private.admin_insights(p jsonb) returns jsonb
language plpgsql stable security definer set search_path='' as $$
declare pr record; all_lifts boolean;
begin
  if not wlf_private.ri_enabled('workspace:dashboard') then raise exception 'Admin Panel access required'; end if;
  select * into pr from wlf_private.period(p);
  all_lifts := coalesce(p->>'qmsScope','')='all';
  return jsonb_build_object('from',pr.d_from,'to',pr.d_to,'qmsScope',case when all_lifts then 'all' else 'period' end,
    'qms',(
      with lifts as (
        select l.id, btrim(l.lift_id) lift_id, btrim(l.project) project, coalesce(nullif(btrim(l.system),''),'Not set') sys,
               coalesce(nullif(btrim(l.controller_model),''),'') controller, l.created_at, l.parts, l.selection
          from wlf_private.qms_lifts l
         where l.deleted_at is null and (all_lifts or (l.created_at>=pr.t_from and l.created_at<pr.t_to))),
      used as (
        -- one row per lift, category and model (an AVR model has many rows of its own: counted once)
        select distinct x.lift, x.lift_id, x.project, x.sys, x.at, x.category, x.model, x.code, x.brand from (
          select l.id lift, l.lift_id, l.project, l.sys, l.created_at at, 'Controller' category, l.controller model, '' code, l.sys brand
            from lifts l where l.controller<>''
          union all
          select l.id, l.lift_id, l.project, l.sys, l.created_at, 'Motor',
                 coalesce((select it->>'value' from jsonb_array_elements(coalesce(s.sel->'categories'->0->'items','[]'::jsonb)) it where it->>'label' ~* '^\s*motor model\s*$' limit 1),
                          (select it->>'value' from jsonb_array_elements(coalesce(s.sel->'categories'->0->'items','[]'::jsonb)) it where it->>'label' ~* 'model' limit 1),''),
                 '',
                 coalesce((select it->>'value' from jsonb_array_elements(coalesce(s.sel->'categories'->0->'items','[]'::jsonb)) it where it->>'label' ~* 'brand' limit 1),'')
            from lifts l cross join lateral (select wlf_private.qms_sel_open(l.selection) sel) s
           where jsonb_typeof(s.sel)='object'
          union all
          select l.id, l.lift_id, l.project, l.sys, l.created_at,
                 case when e->>'section'='avr' then 'AVR'
                      else coalesce(nullif(btrim(e->>'grp'),''), nullif(btrim(e->>'hardware'),''), initcap(coalesce(e->>'section','Other'))) end,
                 case when e->>'section'='avr' then coalesce(nullif(btrim(e->>'model'),''),'AVR')
                      else concat_ws(' · ', nullif(btrim(e->>'hardware'),''), nullif(btrim(e->>'spec'),''), nullif(btrim(e->>'name'),'')) end,
                 case when e->>'section'='avr' then '' else coalesce(e->>'code','') end,
                 case when e->>'section'='avr' then '' else coalesce(e->>'brand','') end
            from lifts l cross join lateral jsonb_array_elements(wlf_private.qms_parts_open(l.parts)) e
        ) x where coalesce(x.model,'')<>''),
      models as (
        select u.category, u.model, max(u.code) code, max(u.brand) brand,
               count(distinct u.lift) lifts, count(distinct lower(u.project)) projects,
               (select jsonb_agg(jsonb_build_object('liftId',s.lift_id,'project',s.project,'system',s.sys,'at',s.at) order by s.at desc, s.lift_id)
                  from (select * from used v where v.category=u.category and v.model=u.model order by v.at desc limit 300) s) sites
          from used u group by u.category, u.model)
      select jsonb_build_object(
        'lifts',(select count(*) from lifts),
        'projects',(select count(distinct lower(project)) from lifts),
        'allLifts',(select count(*) from wlf_private.qms_lifts where deleted_at is null),
        'systems',coalesce((select jsonb_agg(jsonb_build_object('system',s.sys,'projects',s.projects,'lifts',s.lifts,'controllers',s.controllers) order by s.lifts desc, s.sys)
          from (select l.sys, count(distinct lower(l.project)) projects, count(*) lifts,
                       (select jsonb_agg(jsonb_build_object('model',c.controller,'lifts',c.n) order by c.n desc, c.controller)
                          from (select controller, count(*) n from lifts z where z.sys=l.sys and z.controller<>'' group by controller) c) controllers
                  from lifts l group by l.sys) s),'[]'::jsonb),
        'categories',coalesce((select jsonb_agg(jsonb_build_object('category',c.category,'lifts',c.lifts,'projects',c.projects,'models',c.models) order by c.ord, c.category)
          from (select m.category,
                       (select count(distinct v.lift) from used v where v.category=m.category) lifts,
                       (select count(distinct lower(v.project)) from used v where v.category=m.category) projects,
                       case m.category when 'Controller' then 0 when 'Motor' then 1 when 'AVR' then 2 else 3 end ord,
                       jsonb_agg(jsonb_build_object('model',m.model,'code',m.code,'brand',m.brand,'lifts',m.lifts,'projects',m.projects,'sites',m.sites) order by m.lifts desc, m.model) models
                  from models m group by m.category) c),'[]'::jsonb))),
    'claims',(
      with c as (
        select d.demand_no, coalesce(nullif(btrim(d.claim_supplier),''), nullif(btrim(d.supplier),''), 'Not named') supplier,
               concat_ws(' · ', nullif(btrim(d.item_name),''), nullif(btrim(coalesce(d.component_model,'')),''), nullif(btrim(d.item_spec),'')) item,
               coalesce(d.quantity,0) qty, d.sc_received_at is not null received
          from wlf_private.damage_demands d
         where d.confirm_at is not null and d.confirm_at>=pr.t_from and d.confirm_at<pr.t_to)
      select jsonb_build_object(
        'claims',(select count(*) from c),
        'pending',(select count(*) from c where not received),
        'received',(select count(*) from c where received),
        'units',(select coalesce(sum(qty),0) from c),
        'waiting',(select count(*) from wlf_private.damage_demands d where d.claim_at is not null and d.confirm_at is null and d.claim_at>=pr.t_from and d.claim_at<pr.t_to),
        'pendingNow',(select count(*) from wlf_private.damage_demands d where d.confirm_at is not null and d.sc_received_at is null),
        'suppliers',coalesce((select jsonb_agg(jsonb_build_object('supplier',s.supplier,'claims',s.n,'pending',s.p,'received',s.r,'units',s.u,'topItem',s.top_item,'topUnits',s.top_units) order by s.n desc, s.u desc, s.supplier)
          from (select x.supplier, count(*) n, count(*) filter (where not x.received) p, count(*) filter (where x.received) r, coalesce(sum(x.qty),0) u,
                       (select t.item from c t where t.supplier=x.supplier group by t.item order by sum(t.qty) desc, count(*) desc, t.item limit 1) top_item,
                       (select sum(t.qty) from c t where t.supplier=x.supplier group by t.item order by sum(t.qty) desc, count(*) desc, t.item limit 1) top_units
                  from c x group by x.supplier) s),'[]'::jsonb),
        'components',coalesce((select jsonb_agg(jsonb_build_object('item',k.item,'supplier',k.supplier,'claims',k.n,'units',k.u,'pending',k.p) order by k.u desc, k.n desc, k.item)
          from (select x.item, x.supplier, count(*) n, coalesce(sum(x.qty),0) u, count(*) filter (where not x.received) p
                  from c x group by x.item, x.supplier order by u desc, n desc, x.item limit 20) k),'[]'::jsonb))));
end
$$;
revoke all on function wlf_private.admin_insights(jsonb) from public, anon, authenticated;

-- ---------------------------------------------------------------- 2. API wrapper + build number
do $r$ begin
  if to_regprocedure('wlf_private.rpc_before_v271(text,jsonb)') is null then
    alter function wlf_private.rpc(text,jsonb) rename to rpc_before_v271;
  end if;
end $r$;

create or replace function wlf_private.rpc(a text, args jsonb) returns jsonb
language plpgsql security definer set search_path='' as $$
declare result jsonb;
begin
  if a='getAdminInsights' then
    if not wlf_private.approved() then raise exception 'SESSION_EXPIRED: Account is pending approval or inactive'; end if;
    return wlf_private.admin_insights(coalesce(args->0,'{}'));
  end if;
  result := wlf_private.rpc_before_v271(a,args);
  if a in ('getSession','getAppContext') and jsonb_typeof(result)='object' then
    result := result || jsonb_build_object('build','2.7.1');
  end if;
  return result;
end
$$;
revoke all on function wlf_private.rpc_before_v271(text,jsonb) from public, anon, authenticated;
revoke all on function wlf_private.rpc(text,jsonb) from public, anon;
grant execute on function wlf_private.rpc(text,jsonb) to authenticated;

notify pgrst, 'reload schema';
commit;

select to_regprocedure('wlf_private.admin_insights(jsonb)') is not null
   and to_regprocedure('wlf_private.rpc_before_v271(text,jsonb)') is not null as v271_ready;
