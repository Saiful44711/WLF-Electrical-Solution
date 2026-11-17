-- =====================================================================
-- WLF Electrical Solution v2.5.3
--  * Recycle bin (Super Admin): everything deleted in the app can be
--    restored or deleted permanently; "Empty bin" removes all of it.
--  * Announcements (Super Admin -> chosen sections): My Profile card,
--    red count and push notification; read receipts.
--  * Usage Dashboard: last 30 days of the user activity log; Super Admin
--    deletes older log rows after downloading them (nothing automatic).
--  * Management Dashboard and "My activity" in My Profile.
-- Run in Supabase > SQL Editor after v2.5.2 (UPDATE_V252.sql). Safe to run
-- twice. Back up first. If an RLS warning appears, choose "Run without RLS".
-- =====================================================================
begin;

do $pre$ begin
  if to_regprocedure('wlf_private.rpc_before_v252(text,jsonb)') is null then
    raise exception 'STOP: apply UPDATE_V252.sql (v2.5.2) first. Nothing was changed.';
  end if;
end $pre$;

-- ---------------------------------------------------------------- recycle bin
create table if not exists wlf_private.recycle_bin(
  id bigint generated always as identity primary key,
  kind text not null check (kind in ('request','ri-entry','project','task','troubleshooting','document','doc-category','doc-folder','announcement')),
  ref text not null,
  label text not null default '',
  detail text not null default '',
  payload jsonb,
  deleted_by uuid,
  deleted_at timestamptz not null default now()
);
create unique index if not exists recycle_bin_kind_ref on wlf_private.recycle_bin(kind,ref);
create table if not exists wlf_private.purge_log(
  id bigint generated always as identity primary key,
  at timestamptz not null default now(),
  actor uuid,
  what text not null,
  counts jsonb not null default '{}'
);
alter table wlf_private.recycle_bin enable row level security;
alter table wlf_private.purge_log enable row level security;
revoke all on wlf_private.recycle_bin, wlf_private.purge_log from public, anon, authenticated;

create or replace function wlf_private.bin_add(p_kind text, p_ref text, p_label text, p_detail text, p_payload jsonb, p_actor uuid)
returns void language sql security definer set search_path='' as $$
  insert into wlf_private.recycle_bin(kind,ref,label,detail,payload,deleted_by)
  values(p_kind,p_ref,left(coalesce(p_label,''),300),left(coalesce(p_detail,''),300),p_payload,p_actor)
  on conflict (kind,ref) do update set label=excluded.label,detail=excluded.detail,payload=excluded.payload,
    deleted_by=excluded.deleted_by,deleted_at=now()
$$;

create or replace function wlf_private.ri_entry_title(e public.wlf_ri_entries) returns text
language sql stable security definer set search_path='' as $$
  select coalesce(nullif(btrim(coalesce(e.values->>'subject',e.values->>'problem',e.values->>'project','')),''),'Entry')
$$;

-- items that were already deleted before v2.5.3 (who deleted them is not known)
insert into wlf_private.recycle_bin(kind,ref,label,detail,deleted_by,deleted_at)
select 'request',r.id::text,r.reference,initcap(replace(r.category,'-',' '))||coalesce(' · '||nullif(r.values->>'project',''),''),
  (select h.actor from public.wlf_history h where h.request_id=r.id and h.action='delete' order by h.at desc limit 1), r.deleted_at
from public.wlf_requests r where r.deleted_at is not null
on conflict (kind,ref) do nothing;
insert into wlf_private.recycle_bin(kind,ref,label,detail,deleted_at)
select 'ri-entry',e.id::text,left(wlf_private.ri_entry_title(e),200),coalesce(c.name,e.category)||' · '||e.author_name,e.deleted_at
from public.wlf_ri_entries e left join public.wlf_ri_categories c on c.id=e.category where e.deleted_at is not null
on conflict (kind,ref) do nothing;
insert into wlf_private.recycle_bin(kind,ref,label,detail,deleted_at)
select 'project',p.id::text,coalesce(p.data->>'name','Project'),coalesce(p.data->>'status',''),p.deleted_at
from public.wlf_ri_projects p where p.deleted_at is not null
on conflict (kind,ref) do nothing;
insert into wlf_private.recycle_bin(kind,ref,label,detail)
select 'troubleshooting',t.id,coalesce(nullif(t.content->>'code',''),t.content->>'category',t.id),t.controller
from public.wlf_troubleshooting t where t.deleted
on conflict (kind,ref) do nothing;

-- ---------------------------------------------------------------- announcements
create table if not exists wlf_private.announcements(
  id uuid primary key default gen_random_uuid(),
  title text not null check (length(btrim(title)) between 1 and 150),
  body text not null default '' check (length(body)<=4000),
  sections text[] not null default '{}',
  expires_on date,
  created_by uuid,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  revision integer not null default 1
);
create table if not exists wlf_private.announcement_reads(
  announcement uuid not null references wlf_private.announcements(id) on delete cascade,
  profile uuid not null references public.wlf_profiles(id) on delete cascade,
  read_at timestamptz not null default now(),
  primary key(announcement,profile)
);
alter table wlf_private.announcements enable row level security;
alter table wlf_private.announcement_reads enable row level security;
revoke all on wlf_private.announcements, wlf_private.announcement_reads from public, anon, authenticated;

create or replace function wlf_private.announcement_for(a wlf_private.announcements, u public.wlf_profiles) returns boolean
language sql stable security definer set search_path='' as $$
  select (cardinality(a.sections)=0 or coalesce(u.section,'')=any(a.sections) )
     and (a.expires_on is null or a.expires_on>=(now() at time zone 'Asia/Dhaka')::date)
$$;

-- ---------------------------------------------------------------- usage statistics: last 30 days
-- (counts and the Usage Dashboard show the last 30 days only)
create or replace function wlf_private.usage_stats()returns jsonb language plpgsql stable security definer set search_path=''as $$
declare u public.wlf_profiles;topics text[];out jsonb;base text[]=array['Login','Component Selection','Travel Time Calculation','Power Calculation','Speed & Slip Calculation','Motor Power Justification','Energy Bill Calculation','Solar Sizing Calculation'];begin
 u=wlf_private.me();if u.status is distinct from 'Approved' or u.role not in('Super Admin','Admin','R&I')then raise exception 'Permission denied';end if;
 topics=base||coalesce((select array_agg(action order by action)from(select distinct action from public.wlf_usage where at>=now()-interval '30 days' and(u.role in('Super Admin','Admin')or actor=u.id)and not(action=any(base)))x),'{}'::text[]);
 with grouped as materialized(select actor,action,count(*)n,max(at)last_at from public.wlf_usage where at>=now()-interval '30 days' and(u.role in('Super Admin','Admin')or actor=u.id) group by actor,action),
 people as(select p.id,p.email,p.name,p.role from public.wlf_profiles p where(u.role in('Super Admin','Admin')or p.id=u.id)and(p.status='Approved'or exists(select 1 from grouped g where g.actor=p.id))),
 rows as(select p.email,p.name,p.role,coalesce((select sum(g.n)from grouped g where g.actor=p.id),0)total,
 coalesce((select max(g.last_at)::text from grouped g where g.actor=p.id),'-')last_active,
 (select jsonb_agg(coalesce(g.n,0)order by t.ord)from unnest(topics)with ordinality t(action,ord)left join grouped g on g.action=t.action and g.actor=p.id)counts from people p)
 select jsonb_build_object('topics',topics,'rows',coalesce((select jsonb_agg(jsonb_build_object('email',email,'name',name,'role',role,'total',total,'lastActive',last_active,'counts',counts)order by total desc)from rows),'[]'),'totals',(select jsonb_agg(n order by ord)from(select t.ord,coalesce(sum(g.n),0)n from unnest(topics)with ordinality t(action,ord)left join grouped g on g.action=t.action group by t.ord)x),'totalEvents',coalesce((select sum(n)from grouped),0))into out;return out;
end$$;

-- ---------------------------------------------------------------- shared date range (Dhaka days)
create or replace function wlf_private.period(p jsonb, out d_from date, out d_to date, out t_from timestamptz, out t_to timestamptz)
language plpgsql stable set search_path='' as $$
begin
  d_from := coalesce(nullif(p->>'from','')::date, date_trunc('month', now() at time zone 'Asia/Dhaka')::date);
  d_to := coalesce(nullif(p->>'to','')::date, (now() at time zone 'Asia/Dhaka')::date);
  if d_from>d_to then raise exception 'From date must be on or before To date.'; end if;
  if d_to-d_from>3660 then raise exception 'Choose a date range of up to 10 years.'; end if;
  t_from := d_from::timestamp at time zone 'Asia/Dhaka';
  t_to := (d_to+1)::timestamp at time zone 'Asia/Dhaka';
end
$$;

-- month keys of the last 12 months (oldest first), Dhaka time
create or replace function wlf_private.last_months() returns table(i integer, mon timestamp, label text)
language sql stable set search_path='' as $$
  select g, date_trunc('month', now() at time zone 'Asia/Dhaka') - make_interval(months=>11-g),
    to_char(date_trunc('month', now() at time zone 'Asia/Dhaka') - make_interval(months=>11-g),'Mon YY')
  from generate_series(0,11) g
$$;

-- ---------------------------------------------------------------- recycle bin actions (Super Admin)
create or replace function wlf_private.recycle_api(a text, p jsonb, u public.wlf_profiles) returns jsonb
language plpgsql security definer set search_path='' as $$
declare
  b wlf_private.recycle_bin;
  x jsonb;
  ids bigint[];
  counts jsonb := '{}';
  n integer;
  proj public.wlf_ri_projects;
  everything boolean := coalesce(p->>'all','')='true';
begin
  if u.role is distinct from 'Super Admin' then raise exception 'Permission denied: Super Admin only'; end if;
  -- forget rows whose item is gone or was brought back some other way
  delete from wlf_private.recycle_bin r where
       (r.kind='request' and not exists(select 1 from public.wlf_requests q where q.id::text=r.ref and q.deleted_at is not null))
    or (r.kind='ri-entry' and not exists(select 1 from public.wlf_ri_entries q where q.id::text=r.ref and q.deleted_at is not null))
    or (r.kind='project' and not exists(select 1 from public.wlf_ri_projects q where q.id::text=r.ref and q.deleted_at is not null))
    or (r.kind='troubleshooting' and not exists(select 1 from public.wlf_troubleshooting q where q.id=r.ref and q.deleted));

  if a='getRecycleBin' then
    return jsonb_build_object(
      'items',coalesce((select jsonb_agg(jsonb_build_object('id',r.id,'kind',r.kind,'label',r.label,'detail',r.detail,
          'deletedBy',coalesce(wlf_private.person_label(r.deleted_by),''),'deletedAt',r.deleted_at) order by r.deleted_at desc, r.id desc)
        from wlf_private.recycle_bin r),'[]'::jsonb),
      'purges',coalesce((select jsonb_agg(jsonb_build_object('at',l.at,'by',coalesce(wlf_private.person_label(l.actor),''),
          'what',l.what,'counts',l.counts) order by l.at desc, l.id desc)
        from (select * from wlf_private.purge_log order by at desc, id desc limit 30) l),'[]'::jsonb));

  elsif a='restoreRecycleItem' then
    select * into b from wlf_private.recycle_bin where id=nullif(p->>'id','')::bigint for update;
    if not found then raise exception 'This item is no longer in the recycle bin. Refresh the list.'; end if;
    x := b.payload;
    begin
      if b.kind='request' then
        update public.wlf_requests set deleted_at=null, revision=revision+1, updated_at=now() where id=b.ref::uuid;
        insert into public.wlf_history(request_id,actor,action,comment) values(b.ref::uuid,u.id,'restore','Restored from the recycle bin');
      elsif b.kind='ri-entry' then
        update public.wlf_ri_entries set deleted_at=null, revision=revision+1, updated_at=now() where id=b.ref::uuid;
      elsif b.kind='project' then
        update public.wlf_ri_projects set deleted_at=null, revision=revision+1, updated_at=now() where id=b.ref::uuid;
      elsif b.kind='task' then
        select * into proj from public.wlf_ri_projects where id=(x->>'project')::uuid for update;
        if not found then raise exception 'The project of this task no longer exists. Delete the task permanently instead.'; end if;
        if proj.deleted_at is not null then raise exception 'Restore the project "%" first.', proj.data->>'name'; end if;
        if not exists(select 1 from jsonb_array_elements(proj.data->'tasks') t where t->>'id'=x->'task'->>'id') then
          if jsonb_array_length(proj.data->'tasks')>=150 then raise exception 'This project already has 150 tasks.'; end if;
          update public.wlf_ri_projects set data=jsonb_set(data,'{tasks}',(data->'tasks')||jsonb_build_array(x->'task')),
            revision=revision+1, updated_at=now() where id=proj.id;
        end if;
      elsif b.kind='troubleshooting' then
        update public.wlf_troubleshooting set deleted=false, revision=revision+1,
          content=jsonb_set(content,'{revision}',to_jsonb(revision+1)) where id=b.ref;
      elsif b.kind='document' then
        if not exists(select 1 from public.wlf_document_categories where id=(x->>'category')::uuid) then
          raise exception 'Its sub menu was deleted. Restore the sub menu first.';
        end if;
        if not exists(select 1 from public.wlf_document_folders where id=nullif(x->>'folder','')::uuid) then
          x := x||jsonb_build_object('folder',null);
        end if;
        insert into public.wlf_documents select * from jsonb_populate_record(null::public.wlf_documents,x) on conflict (id) do nothing;
      elsif b.kind='doc-folder' then
        if not exists(select 1 from public.wlf_document_categories where id=(x->>'category')::uuid) then
          raise exception 'Its sub menu was deleted. Restore the sub menu first.';
        end if;
        if not exists(select 1 from public.wlf_document_folders where id=nullif(x->>'parent','')::uuid) then
          x := x||jsonb_build_object('parent',null);
        end if;
        insert into public.wlf_document_folders select * from jsonb_populate_record(null::public.wlf_document_folders,x) on conflict (id) do nothing;
      elsif b.kind='doc-category' then
        insert into public.wlf_document_categories select * from jsonb_populate_record(null::public.wlf_document_categories,x->'category') on conflict (id) do nothing;
        loop  -- parents first
          insert into public.wlf_document_folders
          select r.* from jsonb_populate_recordset(null::public.wlf_document_folders,coalesce(x->'folders','[]')) r
          where not exists(select 1 from public.wlf_document_folders z where z.id=r.id)
            and (r.parent is null or exists(select 1 from public.wlf_document_folders z where z.id=r.parent));
          get diagnostics n = row_count;
          exit when n=0;
        end loop;
        insert into public.wlf_documents select r.* from jsonb_populate_recordset(null::public.wlf_documents,coalesce(x->'documents','[]')) r
          on conflict (id) do nothing;
      elsif b.kind='announcement' then
        insert into wlf_private.announcements select * from jsonb_populate_record(null::wlf_private.announcements,x) on conflict (id) do nothing;
      end if;
    exception when unique_violation then
      raise exception 'Cannot restore "%": another item with the same name or code exists now. Rename or delete that one first.', b.label;
    end;
    delete from wlf_private.recycle_bin where id=b.id;
    return jsonb_build_object('restored',b.kind,'label',b.label);

  elsif a='purgeRecycleItems' then
    if everything then
      if p->>'confirm' is distinct from 'DELETE' then raise exception 'Type DELETE to empty the recycle bin.'; end if;
      select array_agg(id) into ids from wlf_private.recycle_bin;
    else
      if jsonb_typeof(p->'ids') is distinct from 'array' or jsonb_array_length(p->'ids') not between 1 and 1000 then
        raise exception 'Select the items to delete.';
      end if;
      select array_agg(r.id) into ids from wlf_private.recycle_bin r
        where r.id::text in (select jsonb_array_elements_text(p->'ids'));
    end if;
    if ids is null then raise exception 'Nothing to delete. Refresh the list.'; end if;
    for b in select * from wlf_private.recycle_bin where id=any(ids) order by id for update loop
      if b.kind='request' then
        if exists(select 1 from public.wlf_requests where id=b.ref::uuid and deleted_at is not null) then
          insert into wlf_private.archived_operations select o.actor,o.mutation_id,o.request_id
            from public.wlf_operations o where o.request_id=b.ref::uuid on conflict do nothing;
          delete from public.wlf_operations where request_id=b.ref::uuid;
          delete from public.wlf_history where request_id=b.ref::uuid;
          delete from wlf_private.damage_demands where request_id=b.ref::uuid;
          delete from public.wlf_requests where id=b.ref::uuid;
        end if;
      elsif b.kind='ri-entry' then
        if exists(select 1 from public.wlf_ri_entries where id=b.ref::uuid and deleted_at is not null) then
          insert into wlf_private.ri_entry_archive(id) values(b.ref::uuid) on conflict do nothing;
          delete from public.wlf_ri_entries where id=b.ref::uuid;
        end if;
      elsif b.kind='project' then
        delete from public.wlf_ri_projects where id=b.ref::uuid and deleted_at is not null;
      elsif b.kind='troubleshooting' then
        delete from public.wlf_troubleshooting where id=b.ref and deleted;
      end if;  -- tasks, documents, sub menus, folders, announcements live only in the bin row
      counts := counts||jsonb_build_object(b.kind,coalesce((counts->>b.kind)::integer,0)+1);
    end loop;
    delete from wlf_private.recycle_bin where id=any(ids);
    insert into wlf_private.purge_log(actor,what,counts)
      values(u.id,case when everything then 'Empty bin' else 'Delete permanently' end,counts);
    return jsonb_build_object('deleted',cardinality(ids),'counts',counts);
  end if;
  raise exception 'Unsupported recycle bin action';
end
$$;

-- ---------------------------------------------------------------- announcements
create or replace function wlf_private.announcement_targets(a wlf_private.announcements) returns setof uuid
language sql stable security definer set search_path='' as $$
  select p.id from public.wlf_profiles p
  where p.status='Approved' and p.auth_user_id is not null and wlf_private.announcement_for(a,p)
$$;

create or replace function wlf_private.announcement_api(a text, p jsonb, u public.wlf_profiles) returns jsonb
language plpgsql security definer set search_path='' as $$
declare
  x wlf_private.announcements;
  v_title text := btrim(coalesce(p->>'title',''));
  v_body text := btrim(coalesce(p->>'body',''));
  v_sections text[];
  v_exp date;
  v_target uuid;
  fresh boolean := false;
begin
  if a='getAnnouncements' then
    return jsonb_build_object('items',coalesce((select jsonb_agg(jsonb_build_object('id',z.id,'title',z.title,'body',z.body,
        'at',z.created_at,'updatedAt',z.updated_at,'expiresOn',z.expires_on,'by',coalesce(wlf_private.person_label(z.created_by),''),
        'read',r.read_at is not null) order by (r.read_at is null) desc, z.created_at desc)
      from wlf_private.announcements z
      left join wlf_private.announcement_reads r on r.announcement=z.id and r.profile=u.id
      where wlf_private.announcement_for(z,u)),'[]'::jsonb));

  elsif a='markAnnouncementRead' then
    select * into x from wlf_private.announcements where id=nullif(p->>'id','')::uuid;
    if found and wlf_private.announcement_for(x,u) then
      insert into wlf_private.announcement_reads(announcement,profile) values(x.id,u.id) on conflict do nothing;
    end if;
    return jsonb_build_object('unread',(select count(*) from wlf_private.announcements z where wlf_private.announcement_for(z,u)
      and not exists(select 1 from wlf_private.announcement_reads r where r.announcement=z.id and r.profile=u.id)));
  end if;

  if u.role is distinct from 'Super Admin' then raise exception 'Permission denied: Super Admin only'; end if;

  if a='getAnnouncementAdmin' then
    return jsonb_build_object('sections',to_jsonb(wlf_private.sections()),
      'items',coalesce((select jsonb_agg(jsonb_build_object('id',z.id,'title',z.title,'body',z.body,'sections',to_jsonb(z.sections),
        'expiresOn',z.expires_on,'at',z.created_at,'updatedAt',z.updated_at,'revision',z.revision,
        'by',coalesce(wlf_private.person_label(z.created_by),''),
        'active',z.expires_on is null or z.expires_on>=(now() at time zone 'Asia/Dhaka')::date,
        'targets',(select count(*) from wlf_private.announcement_targets(z) g where g is distinct from z.created_by),
        'reads',(select count(*) from wlf_private.announcement_reads r where r.announcement=z.id and r.profile is distinct from z.created_by
                   and r.profile in (select wlf_private.announcement_targets(z))),
        'readers',coalesce((select jsonb_agg(wlf_private.person_label(r.profile) order by r.read_at desc)
                   from wlf_private.announcement_reads r where r.announcement=z.id and r.profile is distinct from z.created_by
                   and r.profile in (select wlf_private.announcement_targets(z))),'[]'::jsonb))
        order by z.created_at desc)
      from wlf_private.announcements z),'[]'::jsonb));

  elsif a='saveAnnouncement' then
    if length(v_title) not between 1 and 150 then raise exception 'Enter a title (1-150 characters).'; end if;
    if length(v_body)>4000 then raise exception 'The message can be up to 4000 characters.'; end if;
    if jsonb_typeof(coalesce(p->'sections','[]')) is distinct from 'array' then raise exception 'Choose the sections.'; end if;
    select coalesce(array_agg(distinct s order by s),'{}') into v_sections from jsonb_array_elements_text(coalesce(p->'sections','[]')) s;
    if not (v_sections <@ wlf_private.sections()) then raise exception 'Unknown section in the list.'; end if;
    if coalesce((p->>'allSections')::boolean,false) then v_sections := '{}';
    elsif cardinality(v_sections)=0 then raise exception 'Tick at least one section, or All sections.'; end if;
    v_exp := nullif(p->>'expiresOn','')::date;
    if coalesce(p->>'id','')='' then
      if v_exp<(now() at time zone 'Asia/Dhaka')::date then raise exception 'The end date has already passed.'; end if;
      insert into wlf_private.announcements(title,body,sections,expires_on,created_by)
        values(v_title,v_body,v_sections,v_exp,u.id) returning * into x;
      fresh := true;
    else
      select * into x from wlf_private.announcements where id=(p->>'id')::uuid for update;
      if not found then raise exception 'Announcement not found. Refresh the list.'; end if;
      if x.revision is distinct from (p->>'revision')::integer then raise exception 'CONFLICT: Announcement changed. Refresh the list.'; end if;
      update wlf_private.announcements set title=v_title,body=v_body,sections=v_sections,expires_on=v_exp,
        updated_at=now(),revision=revision+1 where id=x.id returning * into x;
      if coalesce((p->>'resend')::boolean,false) then
        delete from wlf_private.announcement_reads where announcement=x.id;
        fresh := true;
      end if;
    end if;
    if fresh then
      insert into wlf_private.announcement_reads(announcement,profile) values(x.id,u.id) on conflict do nothing;
      for v_target in select * from wlf_private.announcement_targets(x) loop
        if v_target<>u.id then
          perform wlf_private.push_enqueue(v_target,'Announcement: '||x.title,coalesce(nullif(left(x.body,200),''),'Open My Profile to read it.'),'./#account');
        end if;
      end loop;
    end if;
    return to_jsonb(x);

  elsif a='deleteAnnouncement' then
    select * into x from wlf_private.announcements where id=nullif(p->>'id','')::uuid for update;
    if not found then raise exception 'Announcement not found. Refresh the list.'; end if;
    perform wlf_private.bin_add('announcement',x.id::text,x.title,
      case when cardinality(x.sections)=0 then 'All sections' else array_to_string(x.sections,', ') end,to_jsonb(x),u.id);
    delete from wlf_private.announcements where id=x.id;
    return jsonb_build_object('deleted',true);
  end if;
  raise exception 'Unsupported announcement action';
end
$$;

-- ---------------------------------------------------------------- usage log (Usage Dashboard)
create or replace function wlf_private.usage_log_api(a text, p jsonb, u public.wlf_profiles) returns jsonb
language plpgsql security definer set search_path='' as $$
declare
  cutoff timestamptz := now()-interval '30 days';
  member uuid;
  off integer := greatest(0,coalesce(nullif(p->>'offset','')::integer,0));
  before_at timestamptz;
  n bigint;
begin
  if u.role not in ('Super Admin','Admin','R&I') then raise exception 'Permission denied'; end if;
  if a='getUsageLog' then
    member := case when u.role in ('Super Admin','Admin') then nullif(p->>'member','')::uuid else u.id end;
    return jsonb_build_object(
      'since',cutoff,
      'total',(select count(*) from public.wlf_usage l where l.at>=cutoff and (member is null or l.actor=member)),
      'rows',coalesce((select jsonb_agg(jsonb_build_object('id',l.id,'at',l.at,'who',coalesce(wlf_private.person_label(l.actor),''),
          'action',l.action,'details',coalesce(l.details,'')) order by l.at desc, l.id desc)
        from (select * from public.wlf_usage l where l.at>=cutoff and (member is null or l.actor=member)
              order by l.at desc, l.id desc limit 200 offset off) l),'[]'::jsonb),
      'people',case when u.role in ('Super Admin','Admin') then coalesce((select jsonb_agg(jsonb_build_object('id',x.actor,'name',x.name) order by x.name)
          from (select distinct l.actor, wlf_private.person_label(l.actor) name from public.wlf_usage l where l.at>=cutoff) x),'[]'::jsonb) end,
      'old',case when u.role='Super Admin' then (select jsonb_build_object('count',count(*),'oldest',min(l.at))
          from public.wlf_usage l where l.at<cutoff) end);
  end if;
  if u.role is distinct from 'Super Admin' then raise exception 'Permission denied: Super Admin only'; end if;
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
    insert into wlf_private.purge_log(actor,what,counts) values(u.id,'Usage log older than 30 days',jsonb_build_object('usage-log',n));
    return jsonb_build_object('deleted',n);
  end if;
  raise exception 'Unsupported usage log action';
end
$$;

-- ---------------------------------------------------------------- My Profile > My activity (own work only)
create or replace function wlf_private.my_activity(p jsonb, u public.wlf_profiles) returns jsonb
language plpgsql stable security definer set search_path='' as $$
declare pr record;
begin
  select * into pr from wlf_private.period(p);
  return jsonb_build_object('from',pr.d_from,'to',pr.d_to,
    'supportCreated',coalesce((select jsonb_agg(jsonb_build_object('team',z.category,'total',z.n,'solved',z.solved,'open',z.open) order by z.category)
      from (select r.category,count(*) n,count(*) filter(where r.status='Solved') solved,
              count(*) filter(where r.status in ('Pending','Received','Forwarded')) open
            from public.wlf_requests r where r.created_by=u.id and r.deleted_at is null
              and r.created_at>=pr.t_from and r.created_at<pr.t_to group by r.category) z),'[]'::jsonb),
    'supportWork',coalesce((select jsonb_agg(jsonb_build_object('team',z.category,'received',z.rec,'forwarded',z.fwd,
          'solved',z.sol,'notSolved',z.ns) order by z.category)
      from (select r.category,count(*) filter(where h.action='receive') rec,count(*) filter(where h.action='forward') fwd,
              count(*) filter(where h.action='solve') sol,count(*) filter(where h.action='notSolved') ns
            from public.wlf_history h join public.wlf_requests r on r.id=h.request_id and r.deleted_at is null
            where h.actor=u.id and h.at>=pr.t_from and h.at<pr.t_to and h.action in ('receive','forward','solve','notSolved')
            group by r.category) z),'[]'::jsonb),
    'ri',coalesce((select jsonb_agg(jsonb_build_object('form',z.name,'section',z.section,'total',z.n) order by z.section,z.position,z.name)
      from (select c.name,c.section,c.position,count(*) n from public.wlf_ri_entries e join public.wlf_ri_categories c on c.id=e.category
            where e.owner=u.id and e.deleted_at is null and e.created_at>=pr.t_from and e.created_at<pr.t_to
            group by c.id,c.name,c.section,c.position) z),'[]'::jsonb),
    'projects',(select jsonb_build_object(
        'led',count(*) filter(where q.data->>'lead'=u.id::text),
        'collaborating',count(*) filter(where q.data->'collaborators' ? u.id::text))
      from public.wlf_ri_projects q where q.deleted_at is null),
    'tasks',(select coalesce(jsonb_object_agg(z.status,z.n),'{}'::jsonb) from (
      select t->>'status' status,count(*) n from public.wlf_ri_projects q cross join jsonb_array_elements(q.data->'tasks') t
      where q.deleted_at is null and t->>'owner'=u.id::text group by 1) z),
    'damage',jsonb_build_object(
      'confirmed',(select count(*) from wlf_private.damage_demands d where d.confirmed_by=u.id and d.created_at>=pr.t_from and d.created_at<pr.t_to),
      'received',(select count(*) from wlf_private.damage_demands d where d.received_by=u.id and d.received_at>=pr.t_from and d.received_at<pr.t_to)),
    'qms',(select coalesce(jsonb_object_agg(z.status,z.n),'{}'::jsonb) from (
      select q.status,count(*) n from wlf_private.qms_components q where q.owner=u.id
        and q.created_at>=pr.t_from and q.created_at<pr.t_to group by 1) z),
    'tools',coalesce((select jsonb_agg(jsonb_build_object('action',z.action,'n',z.n) order by z.n desc,z.action)
      from (select l.action,count(*) n from public.wlf_usage l where l.actor=u.id and l.at>=pr.t_from and l.at<pr.t_to
            group by l.action order by 2 desc limit 25) z),'[]'::jsonb));
end
$$;

-- ---------------------------------------------------------------- Management Dashboard
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
      'teams',coalesce((select jsonb_agg(jsonb_build_object('team',z.category,'total',z.n,'solved',z.sol,'notSolved',z.ns,'open',z.op) order by z.category)
        from (select category,count(*) n,count(*) filter(where status='Solved') sol,count(*) filter(where status='Not Solved') ns,
                count(*) filter(where status in ('Pending','Received','Forwarded')) op
              from public.wlf_requests where deleted_at is null and created_at>=pr.t_from and created_at<pr.t_to group by category) z),'[]'::jsonb),
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
        from (select distinct category from public.wlf_requests where deleted_at is null and created_at>=m0) c),'{}'::jsonb)),
    -- 4. Damage Demand
    'damage',jsonb_build_object(
      'teams',coalesce((select jsonb_agg(jsonb_build_object('team',z.category,'total',z.n,'pending',z.pen,'received',z.rec,'quantity',z.qty) order by z.category)
        from (select category,count(*) n,count(*) filter(where received_at is null) pen,count(*) filter(where received_at is not null) rec,sum(quantity) qty
              from wlf_private.damage_demands where created_at>=pr.t_from and created_at<pr.t_to group by category) z),'[]'::jsonb),
      'top',coalesce((select jsonb_agg(jsonb_build_object('item',z.item,'quantity',z.qty,'demands',z.n) order by z.qty desc,z.item)
        from (select item_name item,sum(quantity) qty,count(*) n from wlf_private.damage_demands
              where created_at>=pr.t_from and created_at<pr.t_to group by item_name order by 2 desc,1 limit 10) z),'[]'::jsonb),
      'curve',coalesce((select jsonb_object_agg(c.category,(select jsonb_agg(coalesce((select count(*) from wlf_private.damage_demands d
            where d.category=c.category and date_trunc('month',d.created_at at time zone 'Asia/Dhaka')=m.mon),0) order by m.i)
          from wlf_private.last_months() m))
        from (select distinct category from wlf_private.damage_demands where created_at>=m0) c),'{}'::jsonb)),
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

-- ---------------------------------------------------------------- RPC layer
do $layer$ begin
  if to_regprocedure('wlf_private.rpc_before_v253(text,jsonb)') is null then
    alter function wlf_private.rpc(text,jsonb) rename to rpc_before_v253;
  end if;
end $layer$;

create or replace function wlf_private.rpc(a text, args jsonb) returns jsonb
language plpgsql security definer set search_path='' as $$
declare
  p jsonb := coalesce(args->0,'{}');
  u public.wlf_profiles;
  result jsonb;
  x jsonb;
  old_tasks jsonb;
  proj public.wlf_ri_projects;
  req public.wlf_requests;
  ent public.wlf_ri_entries;
  tb public.wlf_troubleshooting;
  doc public.wlf_documents;
  cat public.wlf_document_categories;
  fol public.wlf_document_folders;
  v_payload jsonb;
begin
  u := wlf_private.me();
  if u.id is null or u.status is distinct from 'Approved' then
    raise exception 'SESSION_EXPIRED: Account is pending approval or inactive';
  end if;
  if octet_length(args::text)>100000 then raise exception 'Request too large'; end if;

  if a in ('getRecycleBin','restoreRecycleItem','purgeRecycleItems') then
    return wlf_private.recycle_api(a,p,u);
  elsif a in ('getAnnouncements','markAnnouncementRead','getAnnouncementAdmin','saveAnnouncement','deleteAnnouncement') then
    return wlf_private.announcement_api(a,p,u);
  elsif a in ('getUsageLog','exportOldUsageLog','purgeUsageLog') then
    return wlf_private.usage_log_api(a,p,u);
  elsif a='getMyActivity' then
    return wlf_private.my_activity(p,u);
  elsif a='getManagementDashboard' then
    return wlf_private.management_dashboard(p);
  elsif a='getNavBadges' then
    return jsonb_build_object(
      'forwarded',case when u.role in ('R&I','Super Admin') then (select count(*) from public.wlf_requests r
        where r.assigned_to=u.id and r.status='Forwarded' and r.deleted_at is null) else 0 end,
      'announcements',(select count(*) from wlf_private.announcements z where wlf_private.announcement_for(z,u)
        and not exists(select 1 from wlf_private.announcement_reads r where r.announcement=z.id and r.profile=u.id)),
      'damagePending',case when u.role='Super Admin' or 'damage:demand'=any(u.permissions) then
        (select count(*) from wlf_private.damage_demands where received_at is null) end);

  -- capture what is about to be deleted, so it can go to the recycle bin
  elsif a='saveRiProject' then
    select * into proj from public.wlf_ri_projects where id=nullif(p->>'id','')::uuid;
    old_tasks := coalesce(proj.data->'tasks','[]');
  elsif a='deleteDocument' then
    select * into doc from public.wlf_documents where id=nullif(p->>'id','')::uuid;
  elsif a='deleteDocumentFolder' then
    select * into fol from public.wlf_document_folders where id=nullif(p->>'id','')::uuid;
  elsif a='deleteDocumentCategory' then
    select * into cat from public.wlf_document_categories where id=nullif(p->>'id','')::uuid;
    v_payload := jsonb_build_object('category',to_jsonb(cat),
      'folders',coalesce((select jsonb_agg(to_jsonb(f)) from public.wlf_document_folders f where f.category=cat.id),'[]'::jsonb),
      'documents',coalesce((select jsonb_agg(to_jsonb(d)) from public.wlf_documents d where d.category=cat.id),'[]'::jsonb));
  end if;

  result := wlf_private.rpc_before_v253(a,args);

  if a='saveRiProject' and proj.id is not null then
    for x in select t from jsonb_array_elements(old_tasks) t
      where not exists(select 1 from public.wlf_ri_projects q cross join jsonb_array_elements(q.data->'tasks') n
                        where q.id=proj.id and n->>'id'=t->>'id') loop
      perform wlf_private.bin_add('task',x->>'id',x->>'name','Task of project: '||coalesce(proj.data->>'name',''),
        jsonb_build_object('project',proj.id,'task',x),u.id);
    end loop;
  elsif a='deleteRiProject' then
    select * into proj from public.wlf_ri_projects where id=nullif(p->>'id','')::uuid and deleted_at is not null;
    if found then
      perform wlf_private.bin_add('project',proj.id::text,coalesce(proj.data->>'name','Project'),
        coalesce(proj.data->>'status','')||' · Lead: '||coalesce(wlf_private.person_label(nullif(proj.data->>'lead','')::uuid),''),null,u.id);
    end if;
  elsif a='deleteSupportRequest' then
    select * into req from public.wlf_requests where id=nullif(p->>'id','')::uuid and deleted_at is not null;
    if found then
      perform wlf_private.bin_add('request',req.id::text,req.reference,
        initcap(replace(req.category,'-',' '))||' support'||coalesce(' · '||nullif(req.values->>'project',''),'')
          ||' · '||req.status||' · by '||coalesce(wlf_private.person_label(req.created_by),''),null,u.id);
    end if;
  elsif a='deleteRiEntry' then
    select * into ent from public.wlf_ri_entries where id=nullif(p->>'id','')::uuid and deleted_at is not null;
    if found then
      perform wlf_private.bin_add('ri-entry',ent.id::text,wlf_private.ri_entry_title(ent),
        coalesce((select name from public.wlf_ri_categories where id=ent.category),ent.category)||' · '||ent.author_name,null,u.id);
    end if;
  elsif a='deleteTroubleshootingEntry' then
    select * into tb from public.wlf_troubleshooting where id=args->>0 and deleted;
    if found then
      perform wlf_private.bin_add('troubleshooting',tb.id,coalesce(nullif(tb.content->>'code',''),tb.content->>'category',tb.id),
        'Troubleshooting · '||tb.controller,null,u.id);
    end if;
  elsif a='deleteDocument' and doc.id is not null then
    perform wlf_private.bin_add('document',doc.id::text,doc.name,
      'Document link · '||coalesce((select name from public.wlf_document_categories where id=doc.category),''),to_jsonb(doc),u.id);
  elsif a='deleteDocumentFolder' and fol.id is not null then
    perform wlf_private.bin_add('doc-folder',fol.id::text,fol.name,
      'Folder · '||coalesce((select name from public.wlf_document_categories where id=fol.category),''),to_jsonb(fol),u.id);
  elsif a='deleteDocumentCategory' and cat.id is not null then
    perform wlf_private.bin_add('doc-category',cat.id::text,cat.name,
      'Document sub menu · '||jsonb_array_length(v_payload->'documents')||' links, '||jsonb_array_length(v_payload->'folders')||' folders',
      v_payload,u.id);
  elsif a in ('getSession','getAppContext') then
    result := result||jsonb_build_object('build','2.5.3','recycleBin',true,'announcements',true,'managementDashboard',true);
  end if;
  return result;
end
$$;

-- ---------------------------------------------------------------- grants
revoke all on function wlf_private.rpc_before_v253(text,jsonb) from public, anon, authenticated;
revoke all on function wlf_private.rpc(text,jsonb) from public, anon;
grant execute on function wlf_private.rpc(text,jsonb) to authenticated;
revoke all on function wlf_private.bin_add(text,text,text,text,jsonb,uuid) from public, anon, authenticated;
revoke all on function wlf_private.ri_entry_title(public.wlf_ri_entries) from public, anon, authenticated;
revoke all on function wlf_private.announcement_for(wlf_private.announcements,public.wlf_profiles) from public, anon, authenticated;
revoke all on function wlf_private.announcement_targets(wlf_private.announcements) from public, anon, authenticated;
revoke all on function wlf_private.period(jsonb) from public, anon, authenticated;
revoke all on function wlf_private.last_months() from public, anon, authenticated;
revoke all on function wlf_private.recycle_api(text,jsonb,public.wlf_profiles) from public, anon, authenticated;
revoke all on function wlf_private.announcement_api(text,jsonb,public.wlf_profiles) from public, anon, authenticated;
revoke all on function wlf_private.usage_log_api(text,jsonb,public.wlf_profiles) from public, anon, authenticated;
revoke all on function wlf_private.my_activity(jsonb,public.wlf_profiles) from public, anon, authenticated;
revoke all on function wlf_private.management_dashboard(jsonb) from public, anon, authenticated;

notify pgrst, 'reload schema';
commit;

-- ---------------------------------------------------------------- check
select
  to_regclass('wlf_private.recycle_bin') is not null and to_regclass('wlf_private.purge_log') is not null as recycle_bin_ready,
  (select count(*) from wlf_private.recycle_bin) as items_in_recycle_bin,
  to_regclass('wlf_private.announcements') is not null as announcements_ready,
  to_regprocedure('wlf_private.management_dashboard(jsonb)') is not null as management_dashboard_ready,
  to_regprocedure('wlf_private.rpc_before_v253(text,jsonb)') is not null as v253_ready;
