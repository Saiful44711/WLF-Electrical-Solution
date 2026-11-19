-- =====================================================================
-- WLF Electrical Solution v2.5.4
--  * Technical support: when any team submits a new support request, the
--    approved users of section "R&I Electrical" get a push notification
--    (same mechanism as the new access request message for Super Admin).
--  * Supplier Claim: two Yes/No fields on every Damage Demand
--    ("Supplier Claim" and "Supplier Confirmed"). They have NO effect on the
--    demand's own Pending/Received status. When Supplier Confirmed = Yes
--    the item appears in the new "Supplier Claim" menu as Pending, and
--    becomes Received when the goods physically arrive.
--  * Four new permissions, given user by user by the Super Admin:
--    supplier:view, supplier:claim, supplier:confirm, supplier:receive.
-- Run in Supabase > SQL Editor after v2.5.3 (UPDATE_V253.sql). Safe to run
-- twice. Back up first. If an RLS warning appears, choose "Run without RLS".
-- =====================================================================
begin;

do $pre$ begin
  if to_regprocedure('wlf_private.rpc_before_v253(text,jsonb)') is null then
    raise exception 'STOP: apply UPDATE_V253.sql (v2.5.3) first. Nothing was changed.';
  end if;
end $pre$;

-- ---------------------------------------------------------------- columns
alter table wlf_private.damage_demands
  add column if not exists claim_at timestamptz,
  add column if not exists claim_by uuid,
  add column if not exists claim_name text,
  add column if not exists claim_supplier text,
  add column if not exists claim_date date,
  add column if not exists claim_note text,
  add column if not exists confirm_at timestamptz,
  add column if not exists confirm_by uuid,
  add column if not exists confirm_name text,
  add column if not exists sc_received_at timestamptz,
  add column if not exists sc_received_by uuid,
  add column if not exists sc_received_name text;
create index if not exists damage_demands_supplier_idx on wlf_private.damage_demands(confirm_at desc)
  where confirm_at is not null;

-- ---------------------------------------------------------------- permissions in the access screen
do $cat$ begin
  if to_regprocedure('wlf_private.catalog_before_v254()') is null then
    alter function wlf_private.catalog() rename to catalog_before_v254;
  end if;
end $cat$;
create or replace function wlf_private.catalog() returns jsonb
language sql stable security definer set search_path='' as $$
  select wlf_private.catalog_before_v254() || jsonb_build_array(
    jsonb_build_object('key','supplier:view','label','See the Supplier Claim menu','group','Supplier Claim'),
    jsonb_build_object('key','supplier:claim','label','Set "Supplier Claim" = Yes on a Damage Demand','group','Supplier Claim'),
    jsonb_build_object('key','supplier:confirm','label','Set "Supplier Confirmed" = Yes on a Damage Demand','group','Supplier Claim'),
    jsonb_build_object('key','supplier:receive','label','Mark Supplier Claim goods as Received','group','Supplier Claim'))
$$;

-- ---------------------------------------------------------------- demand rows carry the two Yes/No fields
create or replace function wlf_private.damage_demand_row(d wlf_private.damage_demands)
returns jsonb language sql stable set search_path='' as $$
  select jsonb_build_object(
    'id',d.request_id,'number',d.demand_no,'reference','DD-'||d.demand_no,
    'category',d.category,'requestReference',d.request_reference,'requesterName',d.requester_name,
    'project',d.project,'lift',d.lift_id,'controllers',d.controllers,'problemCategories',d.problem_categories,
    'itemName',d.item_name,'itemCode',d.item_code,'itemSpec',d.item_spec,'quantity',d.quantity,
    'status',case when d.received_at is null then 'Pending' else 'Received' end,
    'createdAt',d.created_at,'receivedAt',d.received_at,'receivedBy',d.received_name,
    'confirmedBy',d.confirmed_name,'durationMinutes',d.duration_minutes,
    'supplierClaim',d.claim_at is not null,
    'supplierConfirmed',d.confirm_at is not null,
    'supplier',jsonb_build_object('name',coalesce(d.claim_supplier,''),'date',d.claim_date,'note',coalesce(d.claim_note,''),
      'claimAt',d.claim_at,'claimBy',d.claim_name,'confirmAt',d.confirm_at,'confirmBy',d.confirm_name,
      'receivedAt',d.sc_received_at,'receivedBy',d.sc_received_name,
      'status',case when d.confirm_at is null then null when d.sc_received_at is null then 'Pending' else 'Received' end)
  )
$$;

-- ---------------------------------------------------------------- push: new support request -> R&I Electrical
create or replace function wlf_private.push_new_support_request() returns trigger
language plpgsql security definer set search_path='' as $$
begin
  -- only freshly submitted requests (a request restored from the recycle bin keeps its old created_at)
  if new.status='Pending' and new.deleted_at is null and new.created_at>now()-interval '2 minutes' then
    perform wlf_private.push_enqueue(p.id,'New technical support request',
      coalesce(new.reference,'')
        ||case when coalesce(new.values->>'project','')<>'' then ' · '||(new.values->>'project') else '' end
        ||' · '||initcap(replace(coalesce(new.category,''),'-',' ')),
      './')
    from public.wlf_profiles p
    where p.section='R&I Electrical' and p.status='Approved' and p.auth_user_id is not null
      and p.id<>new.created_by;
  end if;
  return new;
end
$$;
drop trigger if exists wlf_push_new_support_request on public.wlf_requests;
create trigger wlf_push_new_support_request after insert on public.wlf_requests
  for each row execute function wlf_private.push_new_support_request();

-- ---------------------------------------------------------------- RPC layer
do $layer$ begin
  if to_regprocedure('wlf_private.rpc_before_v254(text,jsonb)') is null then
    alter function wlf_private.rpc(text,jsonb) rename to rpc_before_v254;
  end if;
end $layer$;

create or replace function wlf_private.rpc(a text, args jsonb) returns jsonb
language plpgsql security definer set search_path='' as $$
declare
  p jsonb := coalesce(args->0,'{}');
  u public.wlf_profiles;
  d wlf_private.damage_demands;
  sup text;
  st text;
  lim integer;
  result jsonb;
begin
  u := wlf_private.me();
  if u.id is null or u.status is distinct from 'Approved' then
    raise exception 'SESSION_EXPIRED: Account is pending approval or inactive';
  end if;

  if a='markSupplierClaim' then
    if not (u.role='Super Admin' or 'supplier:claim'=any(u.permissions)) then
      raise exception 'You do not have Supplier Claim access.';
    end if;
    sup := btrim(coalesce(p->>'supplier',''));
    if length(sup) not between 1 and 120 then raise exception 'Enter the supplier name (up to 120 characters).'; end if;
    if length(coalesce(p->>'note',''))>500 then raise exception 'Note is too long (500 characters at most).'; end if;
    select * into d from wlf_private.damage_demands where request_id=nullif(p->>'id','')::uuid for update;
    if not found then raise exception 'Damage demand not found.'; end if;
    if d.claim_at is not null then raise exception 'Supplier Claim is already Yes for this demand. Refresh the list.'; end if;
    update wlf_private.damage_demands set claim_at=now(),claim_by=u.id,claim_name=u.name,claim_supplier=sup,
        claim_date=coalesce(nullif(p->>'date','')::date,(now() at time zone 'Asia/Dhaka')::date),
        claim_note=btrim(coalesce(p->>'note',''))
      where request_id=d.request_id returning * into d;
    return wlf_private.damage_demand_detail(d);

  elsif a='confirmSupplierClaim' then
    if not (u.role='Super Admin' or 'supplier:confirm'=any(u.permissions)) then
      raise exception 'You do not have Supplier Confirmed access.';
    end if;
    select * into d from wlf_private.damage_demands where request_id=nullif(p->>'id','')::uuid for update;
    if not found then raise exception 'Damage demand not found.'; end if;
    if d.claim_at is null then raise exception 'Set Supplier Claim = Yes first.'; end if;
    if d.confirm_at is not null then raise exception 'Supplier Confirmed is already Yes. Refresh the list.'; end if;
    update wlf_private.damage_demands set confirm_at=now(),confirm_by=u.id,confirm_name=u.name
      where request_id=d.request_id returning * into d;
    return wlf_private.damage_demand_detail(d);

  elsif a='cancelSupplierClaim' then
    -- Super Admin only: undo a wrong Yes. Not possible once the goods are Received.
    if u.role<>'Super Admin' then raise exception 'Only the Super Admin can cancel a Supplier Claim.'; end if;
    st := coalesce(p->>'step','');
    if st not in ('claim','confirm') then raise exception 'Choose which step to cancel.'; end if;
    select * into d from wlf_private.damage_demands where request_id=nullif(p->>'id','')::uuid for update;
    if not found then raise exception 'Damage demand not found.'; end if;
    if d.sc_received_at is not null then raise exception 'Goods are already Received. This can no longer be cancelled.'; end if;
    if st='confirm' then
      update wlf_private.damage_demands set confirm_at=null,confirm_by=null,confirm_name=null
        where request_id=d.request_id returning * into d;
    else
      update wlf_private.damage_demands set claim_at=null,claim_by=null,claim_name=null,claim_supplier=null,claim_date=null,claim_note=null,
          confirm_at=null,confirm_by=null,confirm_name=null
        where request_id=d.request_id returning * into d;
    end if;
    return wlf_private.damage_demand_detail(d);

  elsif a='receiveSupplierClaim' then
    if not (u.role='Super Admin' or 'supplier:receive'=any(u.permissions)) then
      raise exception 'You do not have Supplier Claim Receive access.';
    end if;
    select * into d from wlf_private.damage_demands where request_id=nullif(p->>'id','')::uuid for update;
    if not found then raise exception 'Damage demand not found.'; end if;
    if d.confirm_at is null then raise exception 'Supplier Confirmed is not Yes for this demand.'; end if;
    if d.sc_received_at is not null then raise exception 'Already received. Refresh the list.'; end if;
    update wlf_private.damage_demands set sc_received_at=now(),sc_received_by=u.id,sc_received_name=u.name
      where request_id=d.request_id returning * into d;
    return wlf_private.damage_demand_detail(d);

  elsif a='getSupplierClaims' then
    if not (u.role='Super Admin' or 'supplier:view'=any(u.permissions) or 'supplier:receive'=any(u.permissions)) then
      raise exception 'You do not have access to the Supplier Claim menu.';
    end if;
    st := coalesce(nullif(p->>'status',''),'Pending');
    if st not in ('Pending','Received','All') then raise exception 'Unknown status filter.'; end if;
    lim := least(greatest(coalesce(nullif(p->>'limit','')::integer,200),1),500);
    return jsonb_build_object(
      'pending',(select count(*) from wlf_private.damage_demands x where x.confirm_at is not null and x.sc_received_at is null),
      'received',(select count(*) from wlf_private.damage_demands x where x.sc_received_at is not null),
      'canReceive',(u.role='Super Admin' or 'supplier:receive'=any(u.permissions)),
      'canCancel',(u.role='Super Admin'),
      'items',coalesce((select jsonb_agg(wlf_private.damage_demand_detail(z) order by z.confirm_at desc) from (
          select * from wlf_private.damage_demands x
           where x.confirm_at is not null
             and (st='All' or (st='Pending' and x.sc_received_at is null) or (st='Received' and x.sc_received_at is not null))
           order by x.confirm_at desc limit lim) z),'[]'::jsonb));
  end if;

  result := wlf_private.rpc_before_v254(a,args);

  if a='getNavBadges' and jsonb_typeof(result)='object' then
    result := result||jsonb_build_object('supplierPending',
      case when u.role='Super Admin' or 'supplier:view'=any(u.permissions) or 'supplier:receive'=any(u.permissions) then
        (select count(*) from wlf_private.damage_demands x where x.confirm_at is not null and x.sc_received_at is null) end);
  elsif a in ('getSession','getAppContext') and jsonb_typeof(result)='object' then
    result := result||jsonb_build_object('build','2.5.4','supplierClaim',true);
  end if;
  return result;
end
$$;

revoke all on function wlf_private.rpc_before_v254(text,jsonb) from public, anon, authenticated;
revoke all on function wlf_private.catalog_before_v254() from public, anon, authenticated;
revoke all on function wlf_private.push_new_support_request() from public, anon, authenticated;
revoke all on function wlf_private.rpc(text,jsonb) from public, anon;
grant execute on function wlf_private.rpc(text,jsonb) to authenticated;

notify pgrst, 'reload schema';
commit;

-- ---------------------------------------------------------------- check
select
  (select count(*) from jsonb_array_elements(wlf_private.catalog()) x where x->>'key' like 'supplier:%')=4 as supplier_permissions_ready,
  (select count(*) from information_schema.columns where table_schema='wlf_private' and table_name='damage_demands'
     and column_name in ('claim_at','confirm_at','sc_received_at'))=3 as supplier_columns_ready,
  exists(select 1 from pg_trigger where tgname='wlf_push_new_support_request') as support_push_ready,
  to_regprocedure('wlf_private.rpc_before_v254(text,jsonb)') is not null as v254_ready;
