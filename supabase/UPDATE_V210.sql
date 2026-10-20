-- WLF 2.1.0 additive update. Existing project ONLY. No seed/reset/drop of app data.
begin;
create table if not exists public.wlf_document_categories(id uuid primary key default gen_random_uuid(),name text not null unique check(length(name) between 1 and 100),fields jsonb not null default '[]',revision int not null default 1);
create table if not exists public.wlf_documents(id uuid primary key default gen_random_uuid(),category uuid not null references public.wlf_document_categories(id) on delete cascade,name text not null check(length(name) between 1 and 200),url text not null,extra jsonb not null default '{}',revision int not null default 1);
create index if not exists wlf_documents_category_idx on public.wlf_documents(category);
alter table public.wlf_document_categories enable row level security;
alter table public.wlf_documents enable row level security;
drop policy if exists wlf_doc_categories_read on public.wlf_document_categories;
create policy wlf_doc_categories_read on public.wlf_document_categories for select to authenticated using((select wlf_private.approved()));
drop policy if exists wlf_documents_read on public.wlf_documents;
create policy wlf_documents_read on public.wlf_documents for select to authenticated using((select wlf_private.approved()));
revoke all on public.wlf_document_categories,public.wlf_documents from public,anon,authenticated;
grant select on public.wlf_document_categories,public.wlf_documents to authenticated;
insert into public.wlf_document_categories(name) values('Manual'),('SOP'),('Standard'),('Diagram'),('BOM') on conflict(name) do nothing;
create index if not exists wlf_operations_request_idx on public.wlf_operations(request_id);
-- Legacy default table grants are not sufficient for the Edge Function admin client.
grant select on public.wlf_profiles to service_role;
create table if not exists wlf_private.backup_runs(id uuid primary key,actor uuid not null references public.wlf_profiles(id),created_at timestamptz not null default now(),date_from date,date_to date,total int not null default 0,cleared int not null default 0,state text not null default 'Preparing');
create table if not exists wlf_private.backup_items(run uuid not null references wlf_private.backup_runs(id) on delete cascade,seq int not null,request_id uuid not null,fingerprint text,cleared boolean not null default false,primary key(run,seq),unique(run,request_id));
create table if not exists wlf_private.backup_chunks(run uuid not null references wlf_private.backup_runs(id) on delete cascade,batch int not null,file_id text,sha256 text,nonce uuid,verified boolean not null default false,primary key(run,batch));
create table if not exists wlf_private.archived_operations(actor uuid not null,mutation_id text not null,request_id uuid not null,primary key(actor,mutation_id));
create table if not exists wlf_private.deleting_users(id uuid primary key);
alter table wlf_private.backup_runs enable row level security;
alter table wlf_private.backup_items enable row level security;
alter table wlf_private.backup_chunks enable row level security;
alter table wlf_private.archived_operations enable row level security;
alter table wlf_private.deleting_users enable row level security;
revoke all on all tables in schema wlf_private from public,anon,authenticated;
-- Reject concurrent promotion while an Auth deletion is in progress.
create or replace function wlf_private.deletion_guard() returns trigger language plpgsql security definer set search_path='' as $$begin
 if exists(select 1 from wlf_private.deleting_users where id=old.id) then raise exception 'Account deletion in progress';end if;return new;end$$;
drop trigger if exists wlf_deletion_guard on public.wlf_profiles;
create trigger wlf_deletion_guard before update on public.wlf_profiles for each row execute function wlf_private.deletion_guard();
-- Preserve the mature RPC implementation; intercept only this update's actions.
do $$begin if to_regprocedure('wlf_private.rpc_v200(text,jsonb)')is null then alter function wlf_private.rpc(text,jsonb)rename to rpc_v200;end if;end$$;
create or replace function wlf_private.rpc(a text,args jsonb)returns jsonb language plpgsql security definer set search_path='' as $$
declare u public.wlf_profiles;v jsonb=coalesce(args->0,'{}');d public.wlf_documents;c public.wlf_document_categories;out jsonb;x jsonb;key text;begin
 u=wlf_private.me();if u.status is distinct from 'Approved' then raise exception 'SESSION_EXPIRED: Account is pending approval or inactive';end if;
 if a in('createSupportRequest','transitionSupportRequest','editSupportRequest','deleteSupportRequest')and exists(select 1 from wlf_private.archived_operations o where o.actor=u.id and o.mutation_id=v->>'mutationId')then raise exception 'This operation belongs to an archived support record';end if;
 if a='adminGetComponents'and u.role<>'Super Admin' then raise exception 'Permission denied: Super Admin only';end if;
 if a='adminStats'and u.role='User' then raise exception 'Permission denied';end if;
 if a='getSupportReport'and u.role='R&I'then
 out=wlf_private.rpc_v200(a,jsonb_build_array(v||jsonb_build_object('engineer',u.email)));
 return out||jsonb_build_object('users',jsonb_build_array(wlf_private.safe_user(u)),'performance',coalesce((select jsonb_agg(elt.value)from jsonb_array_elements(out->'performance')elt(value)where elt.value->>'email'=u.email),'[]'));
 end if;
 if a='getDashboardSupport' then
 if u.role not in('Super Admin','Admin','R&I')then raise exception 'Permission denied';end if;
 if u.role<>'R&I'then return wlf_private.rpc_v200('getSupportReport',args);end if;
 select coalesce(jsonb_object_agg(category,counts),'{}')into out from(select category,jsonb_object_agg(status,n)counts from(select category,status,count(*)n from public.wlf_requests r where deleted_at is null and(assigned_to=u.id or solved_by=u.id or exists(select 1 from public.wlf_history h where h.request_id=r.id and h.actor=u.id))group by category,status)x group by category)y;
 return jsonb_build_object('totals',out,'performance',jsonb_build_array(jsonb_build_object('email',u.email,'name',u.name,'received',(select count(distinct request_id)from public.wlf_history where actor=u.id and action='receive'),'forwarded',(select count(distinct request_id)from public.wlf_history where actor=u.id and action='forward'),'solved',(select count(*)from public.wlf_requests where deleted_at is null and status='Solved'and solved_by=u.id),'pending',(select count(*)from public.wlf_requests where deleted_at is null and status='Pending'and assigned_to=u.id),'inProgress',(select count(*)from public.wlf_requests where deleted_at is null and status='Received'and assigned_to=u.id),'notSolved',(select count(*)from public.wlf_requests where deleted_at is null and status='Not Solved'and not_solved_by=u.id))));
 elsif a='getDocuments' then return jsonb_build_object('categories',coalesce((select jsonb_agg(to_jsonb(t)order by name)from public.wlf_document_categories t),'[]'),'documents',coalesce((select jsonb_agg(to_jsonb(t)order by name)from public.wlf_documents t),'[]'));
 elsif a in('saveDocumentCategory','deleteDocumentCategory','saveDocument','deleteDocument')then
 if u.role<>'Super Admin'then raise exception 'Permission denied: Super Admin only';end if;
 if length(v::text)>30000 then raise exception 'Request too large';end if;
 if a='saveDocumentCategory'then
 if coalesce(btrim(v->>'name'),'')='' or jsonb_typeof(v->'fields')<>'array' or jsonb_array_length(v->'fields')>20 or exists(select 1 from jsonb_array_elements(v->'fields')f where jsonb_typeof(f)<>'string'or length(f#>>'{}')not between 1 and 100)then raise exception 'Invalid category or fields';end if;
 if coalesce(v->>'id','')=''then insert into public.wlf_document_categories(name,fields)values(btrim(v->>'name'),v->'fields')returning * into c;else update public.wlf_document_categories set name=btrim(v->>'name'),fields=v->'fields',revision=revision+1 where id=(v->>'id')::uuid and revision=(v->>'revision')::int returning * into c;if not found then raise exception 'CONFLICT: Category changed';end if;end if;return to_jsonb(c);
 elsif a='deleteDocumentCategory'then delete from public.wlf_document_categories where id=(v->>'id')::uuid and revision=(v->>'revision')::int;if not found then raise exception 'CONFLICT: Category changed';end if;return 'true';
 elsif a='saveDocument'then
 if coalesce(btrim(v->>'name'),'')='' or coalesce(v->>'url','')!~'^https://(drive|docs)\.google\.com/'or jsonb_typeof(v->'extra')<>'object'or length((v->'extra')::text)>12000 then raise exception 'Valid document name, Google Drive link and fields required';end if;
 select * into c from public.wlf_document_categories where id=(v->>'category')::uuid;if not found then raise exception 'Category not found';end if;
 if exists(select 1 from jsonb_each(v->'extra')e where not(c.fields ? e.key)or jsonb_typeof(e.value)<>'string'or length(e.value#>>'{}')>2000)then raise exception 'Unknown or oversized field';end if;
 if coalesce(v->>'id','')=''then insert into public.wlf_documents(category,name,url,extra)values(c.id,btrim(v->>'name'),v->>'url',v->'extra')returning * into d;else update public.wlf_documents set category=c.id,name=btrim(v->>'name'),url=v->>'url',extra=v->'extra',revision=revision+1 where id=(v->>'id')::uuid and revision=(v->>'revision')::int returning * into d;if not found then raise exception 'CONFLICT: Document changed';end if;end if;return to_jsonb(d);
 else delete from public.wlf_documents where id=(v->>'id')::uuid and revision=(v->>'revision')::int;if not found then raise exception 'CONFLICT: Document changed';end if;return 'true';end if;
 end if;
 out=wlf_private.rpc_v200(a,args);if a in('getSession','getAppContext')then out=out||jsonb_build_object('isAdmin',u.role in('Super Admin','Admin','R&I'),'build','2.1.0');end if;return out;
end$$;
-- Aggregate only the caller's usage for R&I; User never receives any usage dashboard.
create or replace function wlf_private.usage_stats()returns jsonb language plpgsql stable security definer set search_path=''as $$
declare u public.wlf_profiles;topics text[];out jsonb;base text[]=array['Login','Component Selection','Travel Time Calculation','Power Calculation','Speed & Slip Calculation','Motor Power Justification','Energy Bill Calculation','Solar Sizing Calculation'];begin
 u=wlf_private.me();if u.status is distinct from 'Approved' or u.role not in('Super Admin','Admin','R&I')then raise exception 'Permission denied';end if;
 topics=base||coalesce((select array_agg(action order by action)from(select distinct action from public.wlf_usage where(u.role in('Super Admin','Admin')or actor=u.id)and not(action=any(base)))x),'{}'::text[]);
 with grouped as materialized(select actor,action,count(*)n,max(at)last_at from public.wlf_usage where u.role in('Super Admin','Admin')or actor=u.id group by actor,action),
 people as(select p.id,p.email,p.name,p.role from public.wlf_profiles p where(u.role in('Super Admin','Admin')or p.id=u.id)and(p.status='Approved'or exists(select 1 from grouped g where g.actor=p.id))),
 rows as(select p.email,p.name,p.role,coalesce((select sum(g.n)from grouped g where g.actor=p.id),0)total,
 coalesce((select max(g.last_at)::text from grouped g where g.actor=p.id),'-')last_active,
 (select jsonb_agg(coalesce(g.n,0)order by t.ord)from unnest(topics)with ordinality t(action,ord)left join grouped g on g.action=t.action and g.actor=p.id)counts from people p)
 select jsonb_build_object('topics',topics,'rows',coalesce((select jsonb_agg(jsonb_build_object('email',email,'name',name,'role',role,'total',total,'lastActive',last_active,'counts',counts)order by total desc)from rows),'[]'),'totals',(select jsonb_agg(n order by ord)from(select t.ord,coalesce(sum(g.n),0)n from unnest(topics)with ordinality t(action,ord)left join grouped g on g.action=t.action group by t.ord)x),'totalEvents',coalesce((select sum(n)from grouped),0))into out;return out;
end$$;
drop policy if exists wlf_usage_read on public.wlf_usage;
create policy wlf_usage_read on public.wlf_usage for select to authenticated using((select wlf_private.approved())and((wlf_private.me()).role in('Super Admin','Admin')or((wlf_private.me()).role='R&I'and actor=(select auth.uid()))));
create or replace function wlf_private.backup_record(r public.wlf_requests)returns jsonb language sql stable security definer set search_path=''as $$select jsonb_build_object('request',to_jsonb(r),'history',coalesce((select jsonb_agg(to_jsonb(h)order by h.id)from public.wlf_history h where request_id=r.id),'[]'),'operations',coalesce((select jsonb_agg(to_jsonb(o)order by o.actor,o.mutation_id)from public.wlf_operations o where request_id=r.id),'[]'))$$;
-- This function is NOT callable by browser roles. Edge validates Auth and supplies actor.
create or replace function public.wlf_backup_admin(action text,actor uuid,payload jsonb default '{}')returns jsonb language plpgsql security definer set search_path=''as $$
declare runrow wlf_private.backup_runs;runid uuid;part int;cnt int;gone int=0;x jsonb;out jsonb;raw jsonb;rec public.wlf_requests;target public.wlf_profiles;ids uuid[];begin
 if not exists(select 1 from public.wlf_profiles where id=actor and status='Approved'and role='Super Admin')then raise exception 'Super Admin only';end if;
 if action='status'then
 return jsonb_build_object('usedBytes',(select sum(pg_database_size(datname))from pg_database),'limitBytes',500000000,'tables',(select coalesce(jsonb_agg(jsonb_build_object('name',schemaname||'.'||relname,'bytes',pg_total_relation_size(relid))order by pg_total_relation_size(relid)desc),'[]')from pg_stat_user_tables),'backups',coalesce((select jsonb_agg(to_jsonb(b)order by created_at desc)from(select * from wlf_private.backup_runs order by created_at desc limit 30)b),'[]'));
 elsif action='reserveDeleteUser'then
 select * into target from public.wlf_profiles where email=lower(payload->>'email')for update;
 if not found or target.status<>'Rejected'or target.id=actor then raise exception 'Only rejected users can be deleted';end if;
 if exists(select 1 from public.wlf_requests where created_by=target.id or assigned_to=target.id or solved_by=target.id or not_solved_by=target.id)or exists(select 1 from public.wlf_history h where h.actor=target.id or h.to_user=target.id)or exists(select 1 from public.wlf_operations o where o.actor=target.id)or exists(select 1 from public.wlf_records where owner=target.id)or exists(select 1 from public.wlf_usage z where z.actor=target.id)or exists(select 1 from wlf_private.backup_runs b where b.actor=target.id)or exists(select 1 from wlf_private.archived_operations ao where ao.actor=target.id)then raise exception 'Cannot delete: linked records exist. Keep account Rejected.';end if;
 insert into wlf_private.deleting_users values(target.id)on conflict do nothing;return jsonb_build_object('id',target.id);
 elsif action='releaseDeleteUser'then delete from wlf_private.deleting_users where id=(payload->>'id')::uuid;return 'true';
 elsif action='start'then
 if nullif(payload->>'from','')::date>nullif(payload->>'to','')::date then raise exception 'Invalid date range';end if;
 runid=(payload->>'id')::uuid;
 insert into wlf_private.backup_runs(id,actor,date_from,date_to)values(runid,actor,nullif(payload->>'from','')::date,nullif(payload->>'to','')::date)on conflict do nothing;
 select * into runrow from wlf_private.backup_runs where id=runid for update;
 if runrow.actor<>actor or runrow.date_from is distinct from nullif(payload->>'from','')::date or runrow.date_to is distinct from nullif(payload->>'to','')::date then raise exception 'Backup ID reused';end if;
 if runrow.total=0 then
 insert into wlf_private.backup_items(run,seq,request_id)select runid,row_number()over(order by r.id)::int,r.id from public.wlf_requests r where(runrow.date_from is null or coalesce(nullif(r.values->>'submitted_date','')::date,(r.created_at at time zone'Asia/Dhaka')::date)>=runrow.date_from)and(runrow.date_to is null or coalesce(nullif(r.values->>'submitted_date','')::date,(r.created_at at time zone'Asia/Dhaka')::date)<=runrow.date_to)on conflict do nothing;
 update wlf_private.backup_runs set total=(select count(*)from wlf_private.backup_items where run=runid)where id=runid returning * into runrow;end if;
 return to_jsonb(runrow)||jsonb_build_object('batches',ceil(runrow.total/25.0));
 elsif action in('prepare','verify','clear','files','download','restore','abandon')then
 if action='restore'then
 raw=payload->'archive';if raw->>'format'<>'WLF-SUPPORT-2.1'or raw->>'project'<>payload->>'project'or jsonb_typeof(raw->'records')<>'array'or jsonb_array_length(raw->'records')>25 then raise exception 'Wrong project, format or oversized archive';end if;
 for x in select * from jsonb_array_elements(raw->'records')loop
 rec=jsonb_populate_record(null::public.wlf_requests,x->'request');
 if rec.id is null or rec.category not in('commissioning','aftersales')then raise exception 'Invalid request';end if;
 if exists(select 1 from public.wlf_requests where id=rec.id)then continue;end if;
 delete from wlf_private.archived_operations where request_id=rec.id;
 insert into public.wlf_requests select rec.*;gone=gone+1;
 insert into public.wlf_history(request_id,actor,action,comment,to_user,at)select rec.id,(h->>'actor')::uuid,h->>'action',coalesce(h->>'comment',''),nullif(h->>'to_user','')::uuid,(h->>'at')::timestamptz from jsonb_array_elements(x->'history')h;
 insert into public.wlf_operations(actor,mutation_id,action,request_id,payload)select(o->>'actor')::uuid,o->>'mutation_id',o->>'action',rec.id,o->'payload'from jsonb_array_elements(x->'operations')o on conflict do nothing;
 end loop;return jsonb_build_object('restored',gone);
 end if;
 runid=(payload->>'id')::uuid;part=coalesce((payload->>'batch')::int,0);
 select * into runrow from wlf_private.backup_runs where id=runid for update;
 if not found or runrow.actor<>actor then raise exception 'Backup not found for this Super Admin';end if;
 if action='files'then return coalesce((select jsonb_agg(to_jsonb(c)order by batch)from wlf_private.backup_chunks c where run=runid),'[]');end if;
 if action='abandon'then if exists(select 1 from wlf_private.backup_chunks where run=runid and verified)then raise exception 'Verified backups cannot be abandoned';end if;delete from wlf_private.backup_runs where id=runid;return 'true';end if;
 if part<0 or part>=ceil(runrow.total/25.0)then raise exception 'Invalid batch';end if;
 if action='download'then return(select to_jsonb(c)from wlf_private.backup_chunks c where run=runid and batch=part and verified);end if;
 if action='prepare'then
 if exists(select 1 from wlf_private.backup_chunks where run=runid and batch=part and verified)then return jsonb_build_object('alreadyVerified',true);end if;
 with snapshot as materialized(select i.seq,wlf_private.backup_record(r)content from wlf_private.backup_items i join public.wlf_requests r on r.id=i.request_id where i.run=runid and i.seq>part*25 and i.seq<=(part+1)*25),updated as(update wlf_private.backup_items i set fingerprint=md5(s.content::text)from snapshot s where i.run=runid and i.seq=s.seq returning s.content,i.seq)
 select coalesce(jsonb_agg(content order by seq),'[]')into out from updated;
 insert into wlf_private.backup_chunks(run,batch,nonce)values(runid,part,(payload->>'nonce')::uuid)on conflict(run,batch)do update set verified=false,sha256=null,file_id=null,nonce=excluded.nonce;
 return jsonb_build_object('format','WLF-SUPPORT-2.1','project',payload->>'project','run',runid,'batch',part,'dateFrom',runrow.date_from,'dateTo',runrow.date_to,'createdAt',runrow.created_at,'records',out);
 elsif action='verify'then
 if coalesce(payload->>'sha256','')!~'^[a-f0-9]{64}$'or coalesce(payload->>'fileId','')!~'^[a-zA-Z0-9_-]{5,200}$'then raise exception 'Invalid verified archive';end if;
 update wlf_private.backup_chunks set file_id=payload->>'fileId',sha256=payload->>'sha256',verified=true where run=runid and batch=part and nonce=(payload->>'nonce')::uuid and not verified;if not found then raise exception 'Backup changed: retry this part';end if;
 if(select count(*)from wlf_private.backup_chunks where run=runid and verified)=ceil(runrow.total/25.0)then update wlf_private.backup_runs set state='Verified on Drive'where id=runid;end if;return 'true';
 else
 if runrow.state not in('Verified on Drive','Partly cleared','Cleared')or not exists(select 1 from wlf_private.backup_chunks where run=runid and batch=part and verified)then raise exception 'Complete and verify all backup parts before clearing';end if;
 -- Row locks serialize with live request transitions; dependent events are in the fingerprint.
 perform r.id from public.wlf_requests r join wlf_private.backup_items i on i.request_id=r.id where i.run=runid and i.seq>part*25 and i.seq<=(part+1)*25 order by r.id for update of r;
 select array_agg(r.id)into ids from public.wlf_requests r join wlf_private.backup_items i on i.request_id=r.id where i.run=runid and not i.cleared and i.seq>part*25 and i.seq<=(part+1)*25 and r.status='Solved'and md5(wlf_private.backup_record(r)::text)=i.fingerprint;
 if ids is not null then
 insert into wlf_private.archived_operations select o.actor,o.mutation_id,o.request_id from public.wlf_operations o where o.request_id=any(ids)on conflict do nothing;
 delete from public.wlf_operations where request_id=any(ids);delete from public.wlf_history where request_id=any(ids);delete from public.wlf_requests where id=any(ids);get diagnostics gone=row_count;
 update wlf_private.backup_items set cleared=true where run=runid and request_id=any(ids);
 update wlf_private.backup_runs set cleared=cleared+gone,state=case when cleared+gone>=total then 'Cleared'else 'Partly cleared'end where id=runid;
 end if;select count(*)into cnt from wlf_private.backup_items where run=runid and seq>part*25 and seq<=(part+1)*25;return jsonb_build_object('cleared',gone,'skipped',cnt-gone);
 end if;
 end if;raise exception 'Unsupported maintenance action';
end$$;
revoke all on function public.wlf_backup_admin(text,uuid,jsonb)from public,anon,authenticated;
grant execute on function public.wlf_backup_admin(text,uuid,jsonb)to service_role;
revoke all on all functions in schema wlf_private from public,anon;
-- Never expose wlf_private through the Data API. Internal helpers retain existing approved-user call paths.
revoke all on function wlf_private.rpc_v200(text,jsonb)from authenticated;
grant execute on function wlf_private.rpc(text,jsonb)to authenticated;
-- public.wlf_rpc calls the new wrapper; all its branches enforce the current approved identity.
notify pgrst,'reload schema';
commit;
