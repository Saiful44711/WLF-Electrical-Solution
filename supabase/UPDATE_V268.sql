-- WLF v2.6.8 · Hardware Catalogue import replaces whole model tables (by Control system + Model), preview before change.
-- Requires UPDATE_V267.sql (v2.6.7). Safe to run again. Back up first.
begin;

do $c$ begin
  if to_regprocedure('wlf_private.rpc_before_v267(text,jsonb)') is null then
    raise exception 'Run UPDATE_V267.sql first (v2.6.7 is not installed).';
  end if;
end $c$;

do $r$ begin
  if to_regprocedure('wlf_private.rpc_before_v268(text,jsonb)') is null then
    alter function wlf_private.rpc(text,jsonb) rename to rpc_before_v268;
  end if;
end $r$;

create or replace function wlf_private.rpc(a text, args jsonb) returns jsonb
language plpgsql security definer set search_path='' as $$
declare
  result jsonb; p jsonb; u public.wlf_profiles; it jsonb;
  total integer := 0; dry boolean; sys text; mdl text; tbl jsonb := '[]'; t record; old_n integer; new_n integer; n integer;
begin
  if a='replaceCatalogueTables' then
    u := wlf_private.me();
    if u.id is null or u.status<>'Approved' then raise exception 'SESSION_EXPIRED: Account is pending approval or inactive'; end if;
    if not wlf_private.hw_has('catalogue:edit') then raise exception 'Hardware Catalogue edit permission required.'; end if;
    p := args->0;
    if jsonb_typeof(p->'rows')<>'array' or jsonb_array_length(p->'rows')=0 then raise exception 'No rows to import.'; end if;
    if jsonb_array_length(p->'rows')>2000 then raise exception 'Import at most 2000 rows at a time.'; end if;
    dry := coalesce((p->>'dryRun')::boolean,false);
    -- clean every row once; rows without a control system or model are skipped
    create temp table if not exists wlf_imp(ord integer, system text, model text, grp text, hardware text, spec text, item_code text, item_name text, brand text, supplier text, value numeric) on commit drop;
    delete from wlf_imp;
    n := 0;
    for it in select * from jsonb_array_elements(p->'rows') loop
      sys := wlf_private.hw_clean(it->>'system',60,'Control system'); mdl := wlf_private.hw_clean(it->>'model',80,'Model');
      if sys='' or mdl='' then continue; end if;
      n := n+1;
      insert into wlf_imp values(n,sys,mdl,wlf_private.hw_clean(it->>'grp',80,'Group'),wlf_private.hw_clean(it->>'hardware',160,'Hardware'),
        wlf_private.hw_clean(it->>'spec',240,'Spec'),wlf_private.hw_clean(it->>'itemCode',60,'Item code'),wlf_private.hw_clean(it->>'itemName',240,'Item name'),
        wlf_private.hw_clean(it->>'brand',80,'Brand'),wlf_private.hw_clean(it->>'supplier',80,'Supplier'),
        case when coalesce(it->>'value','') ~ '^[0-9]{1,12}([.][0-9]{1,2})?$' then (it->>'value')::numeric end);
    end loop;
    if n=0 then raise exception 'No usable rows: every row needs a Control system and a Model.'; end if;
    for t in select lower(system) ls, lower(model) lm, min(system) fs, min(model) fm, count(*) c from wlf_imp group by 1,2 order by 1,2 loop
      select count(*), min(x.system), min(x.model) into old_n, sys, mdl from wlf_private.hw_catalogue x
        where lower(x.system)=t.ls and lower(x.model)=t.lm and x.deleted_at is null;
      new_n := t.c;
      if not dry then
        update wlf_private.hw_catalogue set deleted_at=now(),updated_at=now(),updated_by=u.id,revision=revision+1
          where lower(system)=t.ls and lower(model)=t.lm and deleted_at is null;
        insert into wlf_private.hw_catalogue(system,model,grp,hardware,spec,item_code,item_name,brand,supplier,value,sort,updated_by)
          select coalesce(sys,t.fs),coalesce(mdl,t.fm),i.grp,i.hardware,i.spec,i.item_code,i.item_name,i.brand,i.supplier,i.value,
                 row_number() over(order by i.ord),u.id
          from wlf_imp i where lower(i.system)=t.ls and lower(i.model)=t.lm;
      end if;
      tbl := tbl || jsonb_build_array(jsonb_build_object('system',coalesce(sys,t.fs),'model',coalesce(mdl,t.fm),'oldRows',old_n,'newRows',new_n,'isNew',old_n=0));
      total := total+new_n;
    end loop;
    return jsonb_build_object('ok',true,'dryRun',dry,'tables',tbl,'rows',total);
  end if;
  result := wlf_private.rpc_before_v268(a,args);
  if a in ('getSession','getAppContext') and jsonb_typeof(result)='object' then
    result := result || jsonb_build_object('build','2.6.8');
  end if;
  return result;
end
$$;
revoke all on function wlf_private.rpc_before_v268(text,jsonb) from public, anon, authenticated;
revoke all on function wlf_private.rpc(text,jsonb) from public, anon;
grant execute on function wlf_private.rpc(text,jsonb) to authenticated;

notify pgrst, 'reload schema';
commit;

select to_regprocedure('wlf_private.rpc_before_v268(text,jsonb)') is not null as v268_ready;
