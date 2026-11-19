-- =====================================================================
-- WLF Electrical Solution v2.5.6
--  * My Profile: "My Activity" removed (server function dropped).
--  * Usage Dashboard: shows the last 7 days (older rows stay until the
--    Super Admin deletes them). Super Admin can delete the activity log for
--    any From-To date range. New permission "Usage Dashboard": only the
--    Super Admin sees it until people are ticked (Admin / R&I no longer
--    see it automatically). Technical Support removed from it.
--  * Component change log: every add / edit / delete of Components Data is
--    recorded (who, when, old and new value). Shown in the Usage Dashboard
--    to people with the "Component change log" tick.
--  * Dashboard: Technical Support and Damage Demand list every team, also
--    teams with no request in the chosen period.
-- Run in Supabase > SQL Editor after v2.5.5 (UPDATE_V255.sql). Safe to run
-- twice. Back up first. If an RLS warning appears, choose "Run without RLS".
-- =====================================================================
begin;

do $pre$ begin
  if to_regprocedure('wlf_private.rpc_before_v255(text,jsonb)') is null then
    raise exception 'STOP: apply UPDATE_V255.sql (v2.5.5) first. Nothing was changed.';
  end if;
end $pre$;

-- ---------------------------------------------------------------- permissions
do $c$ begin
  if to_regprocedure('wlf_private.catalog_before_v256()') is null then
    alter function wlf_private.catalog() rename to catalog_before_v256;
  end if;
end $c$;
create or replace function wlf_private.catalog() returns jsonb
language sql stable security definer set search_path='' as $$
  select coalesce((select jsonb_agg(case x->>'key'
      when 'supplier:claim' then x||'{"label":"Mark \"Claim Sent to Supplier\" on a Damage Demand"}'::jsonb
      when 'supplier:confirm' then x||'{"label":"Mark \"Supplier Accepted Claim\" (and the claim reference)"}'::jsonb
      else x end order by o)
    from jsonb_array_elements(wlf_private.catalog_before_v256()) with ordinality t(x,o)),'[]'::jsonb)
  || jsonb_build_array(
    jsonb_build_object('key','usage:dashboard','label','Usage Dashboard (usage of every user and the activity log)','group','Usage Dashboard'),
    jsonb_build_object('key','components:log','label','Component change log (who added, edited or deleted components)','group','Usage Dashboard'))
$$;

create or replace function wlf_private.usage_allowed_v256(u public.wlf_profiles) returns boolean
language sql stable set search_path='' as $$
  select u.status='Approved' and (u.role='Super Admin' or 'usage:dashboard'=any(u.permissions))
$$;
create or replace function wlf_private.component_log_allowed_v256(u public.wlf_profiles) returns boolean
language sql stable set search_path='' as $$
  select u.status='Approved' and (u.role='Super Admin' or ('usage:dashboard'=any(u.permissions) and 'components:log'=any(u.permissions)))
$$;

-- ---------------------------------------------------------------- My Activity removed
drop function if exists wlf_private.my_activity(jsonb, public.wlf_profiles);

-- ---------------------------------------------------------------- usage statistics: last 7 days
create or replace function wlf_private.usage_stats()returns jsonb language plpgsql stable security definer set search_path=''as $$
declare u public.wlf_profiles;topics text[];out jsonb;base text[]=array['Login','Component Selection','Travel Time Calculation','Power Calculation','Speed & Slip Calculation','Motor Power Justification','Energy Bill Calculation','Solar Sizing Calculation'];begin
 u=wlf_private.me();if not wlf_private.usage_allowed_v256(u) then raise exception 'Permission denied: Usage Dashboard access required';end if;
 topics=base||coalesce((select array_agg(action order by action)from(select distinct action from public.wlf_usage where at>=now()-interval '7 days' and(true or  actor=u.id)and not(action=any(base)))x),'{}'::text[]);
 with grouped as materialized(select actor,action,count(*)n,max(at)last_at from public.wlf_usage where at>=now()-interval '7 days' and(true or  actor=u.id) group by actor,action),
 people as(select p.id,p.email,p.name,p.role from public.wlf_profiles p where(true or  p.id=u.id)and(p.status='Approved'or exists(select 1 from grouped g where g.actor=p.id))),
 rows as(select p.email,p.name,p.role,coalesce((select sum(g.n)from grouped g where g.actor=p.id),0)total,
 coalesce((select max(g.last_at)::text from grouped g where g.actor=p.id),'-')last_active,
 (select jsonb_agg(coalesce(g.n,0)order by t.ord)from unnest(topics)with ordinality t(action,ord)left join grouped g on g.action=t.action and g.actor=p.id)counts from people p)
 select jsonb_build_object('topics',topics,'rows',coalesce((select jsonb_agg(jsonb_build_object('email',email,'name',name,'role',role,'total',total,'lastActive',last_active,'counts',counts)order by total desc)from rows),'[]'),'totals',(select jsonb_agg(n order by ord)from(select t.ord,coalesce(sum(g.n),0)n from unnest(topics)with ordinality t(action,ord)left join grouped g on g.action=t.action group by t.ord)x),'totalEvents',coalesce((select sum(n)from grouped),0))into out;return out;
end$$;

-- ---------------------------------------------------------------- usage log: 7 days, From-To delete
create or replace function wlf_private.usage_log_api(a text, p jsonb, u public.wlf_profiles) returns jsonb
language plpgsql security definer set search_path='' as $$
declare
  cutoff timestamptz := now()-interval '7 days';
  member uuid;
  off integer := greatest(0,coalesce(nullif(p->>'offset','')::integer,0));
  before_at timestamptz;
  pr record;
  n bigint;
begin
  if not wlf_private.usage_allowed_v256(u) then raise exception 'Permission denied: Usage Dashboard access required'; end if;
  if a='getUsageLog' then
    member := nullif(p->>'member','')::uuid;
    return jsonb_build_object(
      'since',cutoff,'days',7,
      'total',(select count(*) from public.wlf_usage l where l.at>=cutoff and (member is null or l.actor=member)),
      'rows',coalesce((select jsonb_agg(jsonb_build_object('id',l.id,'at',l.at,'who',coalesce(wlf_private.person_label(l.actor),''),
          'action',l.action,'details',coalesce(l.details,'')) order by l.at desc, l.id desc)
        from (select * from public.wlf_usage l where l.at>=cutoff and (member is null or l.actor=member)
              order by l.at desc, l.id desc limit 200 offset off) l),'[]'::jsonb),
      'people',coalesce((select jsonb_agg(jsonb_build_object('id',x.actor,'name',x.name) order by x.name)
          from (select distinct l.actor, wlf_private.person_label(l.actor) name from public.wlf_usage l where l.at>=cutoff) x),'[]'::jsonb),
      'old',case when u.role='Super Admin' then (select jsonb_build_object('count',count(*),'oldest',min(l.at))
          from public.wlf_usage l where l.at<cutoff) end,
      'all',case when u.role='Super Admin' then (select jsonb_build_object('count',count(*),'oldest',min(l.at),'newest',max(l.at))
          from public.wlf_usage l) end);
  end if;
  if u.role is distinct from 'Super Admin' then raise exception 'Permission denied: Super Admin only'; end if;
  if a in ('countUsageRange','purgeUsageRange') then
    if coalesce(p->>'from','')='' or coalesce(p->>'to','')='' then raise exception 'Choose both From and To dates.'; end if;
    select * into pr from wlf_private.period(p);
    select count(*) into n from public.wlf_usage where at>=pr.t_from and at<pr.t_to;
    if a='countUsageRange' then return jsonb_build_object('from',pr.d_from,'to',pr.d_to,'count',n); end if;
    if p->>'confirm' is distinct from 'DELETE' then raise exception 'Type DELETE to remove the activity log of this period.'; end if;
    delete from public.wlf_usage where at>=pr.t_from and at<pr.t_to;
    get diagnostics n = row_count;
    insert into wlf_private.purge_log(actor,what,counts)
      values(u.id,'Activity log '||pr.d_from||' to '||pr.d_to,jsonb_build_object('usage-log',n));
    return jsonb_build_object('from',pr.d_from,'to',pr.d_to,'deleted',n);
  end if;
  before_at := least(coalesce(nullif(p->>'before','')::timestamptz,cutoff),cutoff);
  if a='exportOldUsageLog' then
    return jsonb_build_object('before',before_at,'rows',coalesce((select jsonb_agg(jsonb_build_object('id',l.id,'at',l.at,
        'who',coalesce(wlf_private.person_label(l.actor),''),'action',l.action,'details',coalesce(l.details,'')) order by l.id)
      from (select * from public.wlf_usage l where l.at<before_at and l.id>coalesce(nullif(p->>'afterId','')::bigint,0)
            order by l.id limit 5000) l),'[]'::jsonb));
  elsif a='purgeUsageLog' then
    if p->>'confirm' is distinct from 'DELETE' then raise exception 'Type DELETE to remove the old log.'; end if;
    delete from public.wlf_usage where at<before_at;
    get diagnostics n = row_count;
    insert into wlf_private.purge_log(actor,what,counts) values(u.id,'Usage log older than 7 days',jsonb_build_object('usage-log',n));
    return jsonb_build_object('deleted',n);
  end if;
  raise exception 'Unsupported usage log action';
end
$$;

-- ---------------------------------------------------------------- component change log
create table if not exists wlf_private.component_log(
  id bigint generated always as identity primary key,
  at timestamptz not null default now(),
  actor uuid,
  actor_name text not null default '',
  action text not null check (action in ('Added','Edited','Deleted')),
  component_id bigint not null,
  label text not null default '',
  changes jsonb not null default '[]'::jsonb
);
create index if not exists component_log_at on wlf_private.component_log(at desc);
alter table wlf_private.component_log enable row level security;
revoke all on wlf_private.component_log from public, anon, authenticated;

create or replace function wlf_private.component_log_trigger() returns trigger
language plpgsql security definer set search_path='' as $$
declare
  hdr jsonb := coalesce((select value from public.wlf_settings where key='component_headers'),'[]'::jsonb);
  o jsonb := case when tg_op in ('UPDATE','DELETE') then old.values else '[]'::jsonb end;
  v jsonb := case when tg_op in ('INSERT','UPDATE') then new.values else '[]'::jsonb end;
  cur jsonb := case when tg_op='DELETE' then o else v end;
  who uuid := auth.uid();
  ch jsonb;
begin
  select coalesce(jsonb_agg(jsonb_build_object('field',coalesce(hdr->>i,'Column '||(i+1)),
      'old',coalesce(o->>i,''),'new',coalesce(v->>i,'')) order by i),'[]'::jsonb) into ch
    from generate_series(0,greatest(jsonb_array_length(o),jsonb_array_length(v))-1) i
    where coalesce(o->>i,'') is distinct from coalesce(v->>i,'');
  if tg_op='UPDATE' and jsonb_array_length(ch)=0 then return null; end if;
  insert into wlf_private.component_log(actor,actor_name,action,component_id,label,changes)
  values(who,
    coalesce((select coalesce(nullif(p.name,''),p.email) from public.wlf_profiles p where p.id=who),
             case when who is null then 'Database (SQL Editor)' else '' end),
    case tg_op when 'INSERT' then 'Added' when 'UPDATE' then 'Edited' else 'Deleted' end,
    case when tg_op='DELETE' then old.id else new.id end,
    left(concat_ws(' · ',nullif(cur->>0,'')||' KG',nullif(cur->>1,'')||' m/s',nullif(cur->>2,''),nullif(cur->>3,''),nullif(cur->>5,'')),300),
    ch);
  return null;
end
$$;
revoke all on function wlf_private.component_log_trigger() from public, anon, authenticated;
drop trigger if exists wlf_component_log on public.wlf_components;
create trigger wlf_component_log after insert or update or delete on public.wlf_components
  for each row execute function wlf_private.component_log_trigger();

create or replace function wlf_private.component_log_api(p jsonb, u public.wlf_profiles) returns jsonb
language plpgsql stable security definer set search_path='' as $$
declare pr record; q text := lower(btrim(coalesce(p->>'q','')));
begin
  if not wlf_private.component_log_allowed_v256(u) then raise exception 'Permission denied: Component change log access required'; end if;
  if coalesce(p->>'from','')='' then p := p || jsonb_build_object('from',((now() at time zone 'Asia/Dhaka')::date-29)::text); end if;
  select * into pr from wlf_private.period(p);
  return jsonb_build_object('from',pr.d_from,'to',pr.d_to,
    'total',(select count(*) from wlf_private.component_log l where l.at>=pr.t_from and l.at<pr.t_to
      and (q='' or lower(l.actor_name||' '||l.action||' '||l.label||' '||l.changes::text) like '%'||q||'%')),
    'rows',coalesce((select jsonb_agg(jsonb_build_object('id',l.id,'at',l.at,'who',l.actor_name,'action',l.action,
        'componentId',l.component_id,'label',l.label,'changes',l.changes) order by l.at desc,l.id desc)
      from (select * from wlf_private.component_log l where l.at>=pr.t_from and l.at<pr.t_to
        and (q='' or lower(l.actor_name||' '||l.action||' '||l.label||' '||l.changes::text) like '%'||q||'%')
        order by l.at desc,l.id desc limit 1000) l),'[]'::jsonb));
end
$$;

-- ---------------------------------------------------------------- dashboard: every team is listed
create or replace function wlf_private.damage_teams_v256() returns table(k text, s integer)
language sql immutable set search_path='' as $$
  values ('commissioning',1),('aftersales',2),('installation',3),('maintenance',4)
$$;
create or replace function wlf_private.management_dashboard(p jsonb) returns jsonb
language plpgsql stable security definer set search_path='' as $$
declare pr record; m0 timestamptz;
begin
  if not wlf_private.ri_enabled('workspace:dashboard') then raise exception 'Dashboard access required'; end if;
  select * into pr from wlf_private.period(p);
  m0 := (select min(mon) from wlf_private.last_months()) at time zone 'Asia/Dhaka';
  return jsonb_build_object('from',pr.d_from,'to',pr.d_to,
    'months',(select jsonb_agg(label order by i) from wlf_private.last_months()),
    -- 1. R&I Team Activity: each form, who did how many
    'ri',coalesce((select jsonb_agg(jsonb_build_object('id',c.id,'form',c.name,'section',c.section,'total',x.total,'people',x.people)
        order by c.section,c.position,c.name)
      from public.wlf_ri_categories c
      cross join lateral (select count(*) total,
          coalesce((select jsonb_agg(jsonb_build_object('name',y.name,'n',y.n) order by y.n desc,y.name)
            from (select wlf_private.person_label(e.owner) name,count(*) n from public.wlf_ri_entries e
                  where e.category=c.id and e.deleted_at is null and e.created_at>=pr.t_from and e.created_at<pr.t_to
                  group by e.owner) y),'[]'::jsonb) people
        from public.wlf_ri_entries e where e.category=c.id and e.deleted_at is null
          and e.created_at>=pr.t_from and e.created_at<pr.t_to) x
      where c.active or x.total>0),'[]'::jsonb),
    -- 2. R&I Project Manager: all current projects
    'projects',jsonb_build_object(
      'statuses',(select coalesce(jsonb_object_agg(s,n),'{}'::jsonb) from (select data->>'status' s,count(*) n
        from public.wlf_ri_projects where deleted_at is null group by 1) z),
      'tasks',(select coalesce(jsonb_object_agg(s,n),'{}'::jsonb) from (select t->>'status' s,count(*) n
        from public.wlf_ri_projects q cross join jsonb_array_elements(q.data->'tasks') t where q.deleted_at is null group by 1) z),
      'startedInPeriod',(select count(*) from public.wlf_ri_projects where deleted_at is null
        and nullif(data->>'start','')::date between pr.d_from and pr.d_to),
      'leads',coalesce((select jsonb_agg(jsonb_build_object('name',l.name,'total',l.total,'statuses',l.st) order by l.total desc,l.name)
        from (select wlf_private.person_label(lead) name,sum(n) total,jsonb_object_agg(status,n) st
              from (select nullif(data->>'lead','')::uuid lead,data->>'status' status,count(*) n
                    from public.wlf_ri_projects where deleted_at is null group by 1,2) a group by lead) l),'[]'::jsonb),
      'list',coalesce((select jsonb_agg(jsonb_build_object('name',q.data->>'name','lead',wlf_private.person_label(nullif(q.data->>'lead','')::uuid),
          'status',q.data->>'status','end',q.data->>'end','tasks',jsonb_array_length(q.data->'tasks'),
          'progress',(select round(avg((t->>'progress')::numeric)) from jsonb_array_elements(q.data->'tasks') t))
          order by q.data->>'status', q.data->>'end')
        from (select * from public.wlf_ri_projects where deleted_at is null order by updated_at desc limit 300) q),'[]'::jsonb)),
    -- 3. Technical Support
    'support',jsonb_build_object(
      'teams',coalesce((select jsonb_agg(jsonb_build_object('team',z.category,'total',z.n,'solved',z.sol,'notSolved',z.ns,'open',z.op) order by z.sort_order)
        from (select t.id category,t.sort_order,count(r.id) n,count(r.id) filter(where r.status='Solved') sol,count(r.id) filter(where r.status='Not Solved') ns,
                count(r.id) filter(where r.status in ('Pending','Received','Forwarded')) op
              from wlf_private.support_teams() t left join public.wlf_requests r on r.category=t.id and r.deleted_at is null
                and r.created_at>=pr.t_from and r.created_at<pr.t_to group by t.id,t.sort_order) z),'[]'::jsonb),
      'people',coalesce((select jsonb_agg(jsonb_build_object('name',wlf_private.person_label(z.actor),'received',z.rec,'forwarded',z.fwd,
          'solved',z.sol,'notSolved',z.ns) order by z.sol desc,z.rec desc)
        from (select h.actor,count(*) filter(where h.action='receive') rec,count(*) filter(where h.action='forward') fwd,
                count(*) filter(where h.action='solve') sol,count(*) filter(where h.action='notSolved') ns
              from public.wlf_history h join public.wlf_requests r on r.id=h.request_id and r.deleted_at is null
              where h.at>=pr.t_from and h.at<pr.t_to and h.action in ('receive','forward','solve','notSolved') group by h.actor) z),'[]'::jsonb),
      'curve',coalesce((select jsonb_object_agg(c.category,(select jsonb_agg(coalesce((select count(*) from public.wlf_requests r
            where r.category=c.category and r.deleted_at is null
              and date_trunc('month',r.created_at at time zone 'Asia/Dhaka')=m.mon),0) order by m.i)
          from wlf_private.last_months() m))
        from (select t.id category from wlf_private.support_teams() t) c),'{}'::jsonb)),
    -- 4. Damage Demand
    'damage',jsonb_build_object(
      'teams',coalesce((select jsonb_agg(jsonb_build_object('team',z.category,'total',z.n,'pending',z.pen,'received',z.rec,'quantity',z.qty) order by z.s)
        from (select t.k category,t.s,count(d.request_id) n,count(d.request_id) filter(where d.received_at is null) pen,
                count(d.request_id) filter(where d.received_at is not null) rec,coalesce(sum(d.quantity),0) qty
              from wlf_private.damage_teams_v256() t left join wlf_private.damage_demands d on d.category=t.k
                and d.created_at>=pr.t_from and d.created_at<pr.t_to group by t.k,t.s) z),'[]'::jsonb),
      'top',coalesce((select jsonb_agg(jsonb_build_object('item',z.item,'quantity',z.qty,'demands',z.n) order by z.qty desc,z.item)
        from (select item_name item,sum(quantity) qty,count(*) n from wlf_private.damage_demands
              where created_at>=pr.t_from and created_at<pr.t_to group by item_name order by 2 desc,1 limit 10) z),'[]'::jsonb),
      'curve',coalesce((select jsonb_object_agg(c.category,(select jsonb_agg(coalesce((select count(*) from wlf_private.damage_demands d
            where d.category=c.category and date_trunc('month',d.created_at at time zone 'Asia/Dhaka')=m.mon),0) order by m.i)
          from wlf_private.last_months() m))
        from (select t.k category from wlf_private.damage_teams_v256() t) c),'{}'::jsonb)),
    -- 5. QMS
    'qms',jsonb_build_object(
      'statuses',(select coalesce(jsonb_object_agg(status,n),'{}'::jsonb) from (select status,count(*) n from wlf_private.qms_components
        where created_at>=pr.t_from and created_at<pr.t_to group by 1) z),
      'quantity',(select coalesce(sum(quantity),0) from wlf_private.qms_components where created_at>=pr.t_from and created_at<pr.t_to),
      'people',coalesce((select jsonb_agg(jsonb_build_object('name',wlf_private.person_label(z.owner),'n',z.n) order by z.n desc)
        from (select owner,count(*) n from wlf_private.qms_components where created_at>=pr.t_from and created_at<pr.t_to group by 1) z),'[]'::jsonb)),
    -- 6. Supplier claim
    'supplier',jsonb_build_object('comingSoon',true));
end
$$;

-- ---------------------------------------------------------------- rpc layer
do $r$ begin
  if to_regprocedure('wlf_private.rpc_before_v256(text,jsonb)') is null then
    alter function wlf_private.rpc(text,jsonb) rename to rpc_before_v256;
  end if;
end $r$;
create or replace function wlf_private.rpc(a text, args jsonb) returns jsonb
language plpgsql security definer set search_path='' as $$
declare
  u public.wlf_profiles;
  p jsonb := coalesce(args->0,'{}'::jsonb);
  result jsonb;
begin
  if a in ('getMyActivity','countUsageRange','purgeUsageRange','getComponentLog','adminStats') then
    u := wlf_private.me();
    if u.id is null or u.status is distinct from 'Approved' then
      raise exception 'SESSION_EXPIRED: Account is pending approval or inactive';
    end if;
    if a='getMyActivity' then raise exception 'My Activity was removed in v2.5.6.'; end if;
    if a='getComponentLog' then return wlf_private.component_log_api(p,u); end if;
    if a='adminStats' then return wlf_private.usage_stats(); end if;
    return wlf_private.usage_log_api(a,p,u);
  end if;
  result := wlf_private.rpc_before_v256(a,args);
  if a in ('getSession','getAppContext') and jsonb_typeof(result)='object' then
    result := result || jsonb_build_object('build','2.5.6');
  end if;
  return result;
end
$$;

revoke all on function wlf_private.rpc_before_v256(text,jsonb) from public, anon, authenticated;
revoke all on function wlf_private.rpc(text,jsonb) from public, anon;
grant execute on function wlf_private.rpc(text,jsonb) to authenticated;
revoke all on function wlf_private.catalog_before_v256() from public, anon, authenticated;
revoke all on function wlf_private.usage_log_api(text,jsonb,public.wlf_profiles) from public, anon, authenticated;
revoke all on function wlf_private.component_log_api(jsonb,public.wlf_profiles) from public, anon, authenticated;
revoke all on function wlf_private.management_dashboard(jsonb) from public, anon, authenticated;
revoke all on function wlf_private.usage_stats() from public, anon, authenticated;

commit;

select
  to_regprocedure('wlf_private.my_activity(jsonb,public.wlf_profiles)') is null as my_activity_removed,
  (select count(*) from jsonb_array_elements(wlf_private.catalog()) x where x->>'key' in ('usage:dashboard','components:log'))=2 as usage_permissions_ready,
  exists(select 1 from pg_trigger where tgname='wlf_component_log' and not tgisinternal) as component_log_ready,
  to_regprocedure('wlf_private.rpc_before_v256(text,jsonb)') is not null as v256_ready;
