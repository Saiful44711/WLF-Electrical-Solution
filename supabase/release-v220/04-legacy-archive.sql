-- Keep the v2.1 JSON format and allow all installed support teams to be restored.
create or replace function public.wlf_backup_admin(action text,actor uuid,payload jsonb default '{}')returns jsonb language plpgsql security definer set search_path=''as $$
declare runrow wlf_private.backup_runs;runid uuid;part int;cnt int;gone int=0;x jsonb;out jsonb;raw jsonb;rec public.wlf_requests;target public.wlf_profiles;ids uuid[];begin
 if not exists(select 1 from public.wlf_profiles where id=actor and status='Approved'and role='Super Admin')then raise exception 'Super Admin only';end if;
 if action='status'then
 return jsonb_build_object('usedBytes',(select sum(pg_database_size(datname))from pg_database),'limitBytes',500000000,'tables',(select coalesce(jsonb_agg(jsonb_build_object('name',schemaname||'.'||relname,'bytes',pg_total_relation_size(relid))order by pg_total_relation_size(relid)desc),'[]')from pg_stat_user_tables),'backups',coalesce((select jsonb_agg(to_jsonb(b)order by created_at desc)from(select * from wlf_private.backup_runs order by created_at desc limit 30)b),'[]'));
 elsif action='reserveDeleteUser'then
 select * into target from public.wlf_profiles where email=lower(payload->>'email')for update;
 if not found or target.status<>'Rejected'or target.id=actor then raise exception 'Only rejected users can be deleted';end if;
 if exists(select 1 from public.wlf_requests where created_by=target.id or assigned_to=target.id or solved_by=target.id or not_solved_by=target.id)or exists(select 1 from public.wlf_history h where h.actor=target.id or h.to_user=target.id)or exists(select 1 from public.wlf_operations o where o.actor=target.id)or exists(select 1 from public.wlf_records where owner=target.id)or exists(select 1 from public.wlf_usage z where z.actor=target.id)or exists(select 1 from wlf_private.backup_runs b where b.actor=target.id)or exists(select 1 from wlf_private.archived_operations ao where ao.actor=target.id)
 or exists(select 1 from public.wlf_ri_entries where owner=target.id) or exists(select 1 from public.wlf_ri_projects where owner=target.id or data->>'lead'=target.id::text or data->'collaborators' ? target.id::text or exists(select 1 from jsonb_array_elements(data->'tasks') t where t->>'owner'=target.id::text))then raise exception 'Cannot delete: linked records exist. Keep account Rejected.';end if;
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
 if rec.id is null or not exists(select 1 from public.wlf_forms where category=rec.category)then raise exception 'Invalid request';end if;
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
