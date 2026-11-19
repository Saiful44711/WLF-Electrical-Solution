-- =====================================================================
-- WLF Electrical Solution v2.5.7
--  * The person who submitted a support request gets a push notification
--    when an R&I user marks it Solved, Not Solved or Forwards it.
--  * The same person gets a push notification when the Damage Demand
--    raised for their request is marked Received.
--  * "My unsolved requests" count (red mark on My Profile and the top menu)
--    is calculated here: every own request that is not Solved yet.
--  * Activity log (wlf_usage): rows older than 7 days are deleted
--    automatically (checked at most once an hour, when someone uses the app).
-- Run in Supabase > SQL Editor after v2.5.6 (UPDATE_V256.sql). Safe to run
-- twice. Back up first. If an RLS warning appears, choose "Run without RLS".
-- =====================================================================
begin;

do $pre$ begin
  if to_regprocedure('wlf_private.rpc_before_v256(text,jsonb)') is null then
    raise exception 'STOP: apply UPDATE_V256.sql (v2.5.6) first. Nothing was changed.';
  end if;
end $pre$;

-- ---------------------------------------------------------------- push: request result -> requester
create or replace function wlf_private.push_support_result() returns trigger
language plpgsql security definer set search_path='' as $$
declare
  actor uuid := auth.uid();
  who text;
  info text;
begin
  if new.deleted_at is not null or new.status is not distinct from old.status then return new; end if;
  if new.status not in ('Solved','Not Solved','Forwarded') then return new; end if;
  if actor is not distinct from new.created_by then return new; end if;
  select coalesce(nullif(p.name,''),p.email) into who from public.wlf_profiles p
    where p.id = case when new.status='Forwarded' then new.assigned_to else actor end;
  info := coalesce(new.reference,'')
    ||case when coalesce(new.values->>'project','')<>'' then ' · '||(new.values->>'project') else '' end
    ||case when who is not null then (case when new.status='Forwarded' then ' · forwarded to ' else ' · by ' end)||who else '' end;
  perform wlf_private.push_enqueue(new.created_by,
    case new.status when 'Solved' then 'Your support request was solved'
                    when 'Not Solved' then 'Your support request was marked not solved'
                    else 'Your support request was forwarded' end,
    info, './');
  return new;
end
$$;
drop trigger if exists wlf_push_support_result on public.wlf_requests;
create trigger wlf_push_support_result after update of status on public.wlf_requests
  for each row execute function wlf_private.push_support_result();

-- ---------------------------------------------------------------- push: demand received -> requester
create or replace function wlf_private.push_demand_received() returns trigger
language plpgsql security definer set search_path='' as $$
begin
  if old.received_at is null and new.received_at is not null
     and new.requester_id is distinct from new.received_by then
    perform wlf_private.push_enqueue(new.requester_id,
      'Your Damage Demand was received',
      'Demand #'||new.demand_no||' · '||coalesce(new.request_reference,'')||' · '||coalesce(new.item_name,'')||' × '||new.quantity,
      './');
  end if;
  return new;
end
$$;
drop trigger if exists wlf_push_demand_received on wlf_private.damage_demands;
create trigger wlf_push_demand_received after update of received_at on wlf_private.damage_demands
  for each row execute function wlf_private.push_demand_received();

-- ---------------------------------------------------------------- own unsolved requests (red mark)
create or replace function wlf_private.summary()
returns jsonb language sql stable security definer set search_path='' as $$
  with grouped as (
    select category,status,count(*) n from public.wlf_requests r
    where deleted_at is null and wlf_private.visible(r.category,r.created_by)
    group by category,status
  ), counts as (
    select c.id,
      coalesce(sum(g.n) filter(where g.status='Pending'),0) pending,
      coalesce(sum(g.n) filter(where g.status<>'Solved'),0) open,
      coalesce(jsonb_object_agg(g.status,g.n) filter(where g.status is not null),'{}') statuses
    from wlf_private.support_teams() c left join grouped g on c.id=g.category group by c.id
  ), own as (
    select category,count(*) n from public.wlf_requests
    where created_by=(wlf_private.me()).id and deleted_at is null and status<>'Solved'
    group by category
  )
  select jsonb_build_object('pending',jsonb_object_agg(id,pending),'open',jsonb_object_agg(id,open),
    'statuses',jsonb_object_agg(id,statuses),'version',clock_timestamp(),'user',wlf_private.safe_user(wlf_private.me()),
    'mine',coalesce((select sum(n) from own),0)::int,
    'mineByTeam',coalesce((select jsonb_object_agg(category,n) from own),'{}'::jsonb))
  from counts
$$;

-- ---------------------------------------------------------------- activity log: automatic 7-day clean-up
create table if not exists wlf_private.usage_housekeeping(
  id integer primary key check (id=1),
  last_run timestamptz not null
);
insert into wlf_private.usage_housekeeping(id,last_run) values (1, now()-interval '2 hours') on conflict (id) do nothing;
alter table wlf_private.usage_housekeeping enable row level security;
revoke all on wlf_private.usage_housekeeping from public, anon, authenticated;

create or replace function wlf_private.usage_autopurge() returns trigger
language plpgsql security definer set search_path='' as $$
declare due integer; gone bigint;
begin
  update wlf_private.usage_housekeeping set last_run=now()
    where id=1 and last_run<now()-interval '1 hour' returning 1 into due;
  if due is not null then
    delete from public.wlf_usage where at<now()-interval '7 days';
    get diagnostics gone = row_count;
    if gone>0 then
      insert into wlf_private.purge_log(actor,what,counts)
        values (null,'Usage log older than 7 days (automatic)',jsonb_build_object('usage-log',gone));
    end if;
  end if;
  return null;
end
$$;
drop trigger if exists wlf_usage_autopurge on public.wlf_usage;
create trigger wlf_usage_autopurge after insert on public.wlf_usage
  for each statement execute function wlf_private.usage_autopurge();

-- ---------------------------------------------------------------- rpc layer (build number only)
do $r$ begin
  if to_regprocedure('wlf_private.rpc_before_v257(text,jsonb)') is null then
    alter function wlf_private.rpc(text,jsonb) rename to rpc_before_v257;
  end if;
end $r$;
create or replace function wlf_private.rpc(a text, args jsonb) returns jsonb
language plpgsql security definer set search_path='' as $$
declare result jsonb;
begin
  result := wlf_private.rpc_before_v257(a,args);
  if a in ('getSession','getAppContext') and jsonb_typeof(result)='object' then
    result := result || jsonb_build_object('build','2.5.7');
  end if;
  return result;
end
$$;

revoke all on function wlf_private.rpc_before_v257(text,jsonb) from public, anon, authenticated;
revoke all on function wlf_private.rpc(text,jsonb) from public, anon;
grant execute on function wlf_private.rpc(text,jsonb) to authenticated;
revoke all on function wlf_private.push_support_result() from public, anon, authenticated;
revoke all on function wlf_private.push_demand_received() from public, anon, authenticated;
revoke all on function wlf_private.usage_autopurge() from public, anon, authenticated;

commit;

select
  exists(select 1 from pg_trigger where tgname='wlf_push_support_result' and not tgisinternal) as support_result_push_ready,
  exists(select 1 from pg_trigger where tgname='wlf_push_demand_received' and not tgisinternal) as demand_received_push_ready,
  exists(select 1 from pg_trigger where tgname='wlf_usage_autopurge' and not tgisinternal) as usage_autopurge_ready,
  to_regprocedure('wlf_private.rpc_before_v257(text,jsonb)') is not null as v257_ready;
