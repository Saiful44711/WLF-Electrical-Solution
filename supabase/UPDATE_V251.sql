-- =====================================================================
-- WLF Electrical Solution v2.5.1
--  * Troubleshooting: Bangla text can be edited; each Bangla part remembers
--    which English text it was written for (bn.src). If the English changes
--    and the Bangla does not, the Bangla view shows English for that part.
--  * Forms: an "Other" choice can carry a name, saved as "Other: <name>".
--  * Team Activity: "Project / Task Name" removed (Task Name stays).
--    Old entries keep their own saved form, so their data still shows.
--  * Sales Support: optional Task Start Date and Task Complete Date.
-- Run in Supabase > SQL Editor after v2.5.0 (UPDATE_V250.sql). Safe to run
-- twice. Back up first. If an RLS warning appears, choose "Run without RLS".
-- =====================================================================
begin;

do $pre$ begin
  if to_regprocedure('wlf_private.rpc_before_v250(text,jsonb)') is null then
    raise exception 'STOP: apply UPDATE_V250.sql (v2.5.0) first. Nothing was changed.';
  end if;
end $pre$;

-- ---------------------------------------------------------------- "Other: <name>"
create or replace function wlf_private.other_choice(choices jsonb, a jsonb) returns boolean
language sql immutable set search_path='' as $$
  select jsonb_typeof(a)='string' and exists(
    select 1 from jsonb_array_elements_text(choices) o,
      lateral (select btrim(regexp_replace(btrim(o),':+$','')) as base) b
    where lower(b.base) in ('other','others')
      and left(a#>>'{}',length(b.base)+2)=b.base||': '
      and length(btrim(substr(a#>>'{}',length(b.base)+3))) between 1 and 300)
$$;
revoke all on function wlf_private.other_choice(jsonb,jsonb) from public, anon, authenticated;

CREATE OR REPLACE FUNCTION wlf_private.form_values(form jsonb, vals jsonb, identity_name text, submitted_on date, previous jsonb DEFAULT '{}'::jsonb)
 RETURNS jsonb
 LANGUAGE plpgsql
 IMMUTABLE
 SET search_path TO ''
AS $function$
declare f jsonb; x jsonb; txt text; field_id text; kind text; auto_fill text; choices jsonb; result jsonb='{}';
begin
  if jsonb_typeof(vals) is distinct from 'object' or octet_length(vals::text)>64000 then
    raise exception 'Invalid or oversized submission.';
  end if;
  for f in select value from jsonb_array_elements(form->'fields') loop
    field_id=f->>'id'; kind=f->>'type'; choices=coalesce(f->'options','[]');
    auto_fill=coalesce(f->>'autoFill','');
    if auto_fill='name' and kind in ('text','textarea') then
      x=coalesce(previous->field_id,to_jsonb(split_part(coalesce(identity_name,''),chr(31),1)));
    elsif auto_fill='empid' and kind in ('text','textarea') then
      x=coalesce(previous->field_id,to_jsonb(split_part(coalesce(identity_name,''),chr(31),2)));
    elsif (auto_fill='identity' or (auto_fill='' and wlf_private.field_role(f)='identity'))
        and kind in ('text','textarea') then
      x=coalesce(previous->field_id,to_jsonb(case when position(chr(31) in coalesce(identity_name,''))>0
        then split_part(identity_name,chr(31),1)||case when split_part(identity_name,chr(31),2)<>'' then ' - '||split_part(identity_name,chr(31),2) else '' end
        else identity_name end));
    elsif (auto_fill='today' or (auto_fill='' and field_id='submitted_date')) and kind='date' then
      x=coalesce(previous->field_id,to_jsonb(to_char(submitted_on,'YYYY-MM-DD')));
    elsif kind='multi' or (kind='checkbox' and jsonb_array_length(choices)>0) then
      x=coalesce(vals->field_id,'[]');
      if jsonb_typeof(x)<>'array' or jsonb_array_length(x)>100 then
        raise exception 'Invalid multiple choice: %.', f->>'label';
      end if;
    elsif kind='checkbox' then
      x=coalesce(vals->field_id,'false');
      if jsonb_typeof(x)<>'boolean' then raise exception 'Invalid checkbox: %.', f->>'label'; end if;
    else
      x=coalesce(vals->field_id,'""');
      if jsonb_typeof(x) not in ('string','number') then raise exception 'Invalid field: %.',f->>'label'; end if;
      txt=btrim(x#>>'{}');
      if length(txt)>4000 then raise exception 'Field text too long: %.', f->>'label'; end if;
      if txt<>'' and kind='number' and txt !~ '^[-+]?[0-9]+([.][0-9]+)?$' then
        raise exception 'Enter a number for %.', f->>'label';
      end if;
      if txt<>'' and kind='date' and (txt !~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}$' or to_char(txt::date,'YYYY-MM-DD')<>txt) then
        raise exception 'Invalid date: %.', f->>'label';
      end if;
      x=to_jsonb(txt);
    end if;
    if coalesce((f->>'required')::boolean,false) and (x is null or x in ('""','[]','false','null')) then
      raise exception 'Required: %.',f->>'label';
    end if;
    if jsonb_array_length(choices)>0 and exists(
        select 1 from jsonb_array_elements(case when jsonb_typeof(x)='array' then x else jsonb_build_array(x) end) a
        where a<>'""' and not(choices @> jsonb_build_array(a)) and not wlf_private.other_choice(choices,a)) then
      raise exception 'Invalid choice: %.',f->>'label';
    end if;
    result=result||jsonb_build_object(field_id,x);
  end loop;
  return result;
end
$function$;

-- ---------------------------------------------------------------- R&I forms
do $forms$
declare f jsonb; dates jsonb := '[{"id":"start_date","label":"Task Start Date","type":"date","required":false,"options":[]},{"id":"end_date","label":"Task Complete Date","type":"date","required":false,"options":[]}]';
  pos integer;
begin
  -- Team Activity: keep only Task Name
  select schema->'fields' into f from public.wlf_ri_categories where id='wb-team';
  if f is not null and exists(select 1 from jsonb_array_elements(f) x where x->>'id'='project') then
    f := (select jsonb_agg(x order by o) from jsonb_array_elements(f) with ordinality t(x,o) where x->>'id'<>'project');
    perform wlf_private.form_fields(f);
    update public.wlf_ri_categories set schema=jsonb_set(schema,'{fields}',f), revision=revision+1 where id='wb-team';
  end if;
  -- Sales Support: optional start / complete dates after Task Details
  select schema->'fields' into f from public.wlf_ri_categories where id='wb-sales';
  if f is not null and not exists(select 1 from jsonb_array_elements(f) x where x->>'id' in ('start_date','end_date')) then
    select o::integer into pos from jsonb_array_elements(f) with ordinality t(x,o) where x->>'id'='problem' order by o limit 1;
    pos := coalesce(pos, jsonb_array_length(f));
    f := (select jsonb_agg(x order by k) from (
            select x, o::numeric k from jsonb_array_elements(f) with ordinality t(x,o)
            union all select d, pos + o::numeric/10 from jsonb_array_elements(dates) with ordinality u(d,o)) z);
    perform wlf_private.form_fields(f);
    update public.wlf_ri_categories set schema=jsonb_set(schema,'{fields}',f), revision=revision+1 where id='wb-sales';
  end if;
end $forms$;

-- ---------------------------------------------------------------- Troubleshooting Bangla fingerprints
create temp table wlf_tb_src(id text primary key, src jsonb not null) on commit drop;
insert into wlf_tb_src(id,src) values
('mot-er01','{"d":"7f8a26b3","c":"20381021","s":"65047644"}'::jsonb),
('mot-er02','{"d":"de8f3c9d","c":"20381021","s":"65047644"}'::jsonb),
('mot-er03','{"d":"ca00e4fa","c":"40e99640","s":"8a5d123b"}'::jsonb),
('mot-er04','{"d":"637767f5","c":"3f5706d0","s":"32ac977f"}'::jsonb),
('mot-er05','{"d":"414a1638","c":"20381021","s":"65047644"}'::jsonb),
('mot-er06','{"d":"3104ff48","c":"42783908","s":"ba5e27e1"}'::jsonb),
('mot-er07','{"d":"3a35cf24","c":"afa2ec16","s":"442ec4bf"}'::jsonb),
('mot-er08','{"d":"f662c790","c":"e694bcd6","s":"23f91e47"}'::jsonb),
('mot-er09','{"d":"bf7e9b17","c":"94459e51","s":"0481e7fa"}'::jsonb),
('mot-er10','{"d":"b6ca57a1","c":"23d04944","s":"9cbf72d4"}'::jsonb),
('mot-er11','{"d":"2c9d8865","c":"48f6203a","s":"bc205c45"}'::jsonb),
('mot-er12','{"d":"7dd55828","c":"06e50ae5","s":"8feb6226"}'::jsonb),
('mot-er13','{"d":"5748e0ae","c":"772987bb","s":"741638a5"}'::jsonb),
('mot-er14','{"d":"5b2524cf","c":"646a985f","s":"b7df0fe1"}'::jsonb),
('mot-er15','{"d":"5c901e03","c":"0549783e","s":"fa6ca9b1"}'::jsonb),
('mot-er16','{"d":"51ea65ab","c":"e91702f9","s":"fd46f853"}'::jsonb),
('mot-er17','{"d":"ae9ff0a9","c":"9c38aaf7","s":"c1c1d209"}'::jsonb),
('mot-er18','{"d":"3ccd9233","c":"ad264128","s":"5018d71b"}'::jsonb),
('mot-er19','{"d":"35209106","c":"8698aaec","s":"1eaa768b"}'::jsonb),
('mot-er20','{"d":"74e07bd9","c":"a87693c9","s":"be99bb7b"}'::jsonb),
('mot-er21','{"d":"3442fbae","c":"ce0b6874","s":"08079b64"}'::jsonb),
('mot-er22','{"d":"c6b89c2a","c":"a7ac5035","s":"55381a7e"}'::jsonb),
('mot-er23','{"d":"9243b93c","c":"a8f488ae","s":"71c046a9"}'::jsonb),
('mot-er24','{"d":"7efbd38d","c":"5d24981f","s":"e701fde4"}'::jsonb),
('mot-er25','{"d":"5d4e39c4","c":"79800d8a","s":"deb8d7dd"}'::jsonb),
('mot-er26','{"d":"0572e487","c":"4db62c65","s":"a8f06700"}'::jsonb),
('mot-er27','{"d":"abc2aa2e","c":"40f54191","s":"b3a40b5d"}'::jsonb),
('mot-er28','{"d":"9b078bb3","c":"63d850d3","s":"3745f4b9"}'::jsonb),
('mot-er29','{"d":"d64124c3","c":"c251e1f0","s":"89ac0ddd"}'::jsonb),
('mot-er30','{"d":"b44cab79","c":"4557b24f","s":"ddb284ea"}'::jsonb),
('mot-er31','{"d":"d0c6adcb","c":"68149f8c","s":"1cebb4ae"}'::jsonb),
('mot-er32','{"d":"238e3499","c":"daf38713","s":"cd4ab923"}'::jsonb),
('mot-er33','{"d":"c7a1615a","c":"3bf394d0","s":"741638a5"}'::jsonb),
('mot-er34','{"d":"3700eebd","c":"81475400","s":"66a2f941"}'::jsonb),
('mot-er35','{"d":"f093eeca","c":"98891f0c","s":"0e1f36ea"}'::jsonb),
('mot-er36','{"d":"e7f62e5f","c":"78c1c791","s":"741bef80"}'::jsonb),
('mot-er37','{"d":"135f2a65","c":"b47fa952","s":"b7573c30"}'::jsonb),
('mot-er38','{"d":"e73706b6","c":"dc45eae4","s":"9016b681"}'::jsonb),
('mot-er39','{"d":"774ee2e9","c":"7afac6d2","s":"ff106245"}'::jsonb),
('mot-er40','{"d":"44e31b91","c":"c2fdbe0f","s":"4f07a09b"}'::jsonb),
('mot-er41','{"d":"25ceb6e8","c":"9f5bdb28","s":"28d12331"}'::jsonb),
('mot-er42','{"d":"5c785eaa","c":"c11123e8","s":"68a9d33d"}'::jsonb),
('mot-er43','{"d":"011de80d","c":"4786e8a2","s":"b8eda3da"}'::jsonb),
('mot-er44','{"d":"7f0c14d9","c":"39584fca","s":"df7f3c94"}'::jsonb),
('mot-er45','{"d":"338997dd","c":"add88037","s":"48d3bf89"}'::jsonb),
('mot-er47','{"d":"3d25b7d4","c":"db407924","s":"4c984d89"}'::jsonb),
('mot-er48','{"d":"3a51a54d","c":"ef7a48ff","s":"52a22294"}'::jsonb),
('mot-er49','{"d":"80266c70","c":"7696d7f7","s":"945bc2d7"}'::jsonb),
('mot-er50','{"d":"f78aebd9","c":"332f4647","s":"83942372"}'::jsonb),
('mot-er51','{"d":"c11225ea","c":"1470818c","s":"098cb525"}'::jsonb),
('mot-er52','{"d":"ffeb21e9","c":"d4657bf8","s":"bc764e10"}'::jsonb),
('mot-er53','{"d":"93af123f","c":"b3b0eef3","s":"f935aa94"}'::jsonb),
('mot-er54','{"d":"c0ea84eb","c":"eccd2643","s":"e5f3e22d"}'::jsonb),
('mot-er55','{"d":"ac972850","c":"9e37451c","s":"d5932b64"}'::jsonb),
('mot-er56','{"d":"597ee74d","c":"7c908cdb","s":"2e3aca05"}'::jsonb),
('mot-er57','{"d":"80562ace","c":"5e4a1212","s":"ceedd518"}'::jsonb),
('mot-er58','{"d":"948f435f","c":"d2427089","s":"add56e4e"}'::jsonb),
('mot-er59','{"d":"d68cae7e","c":"471b1ae8","s":"1b900f7a"}'::jsonb),
('mot-er60','{"d":"0c343cbb","c":"ca5e15ce","s":"eede6f7f"}'::jsonb),
('mot-er61','{"d":"d40e9556","c":"d37c473f","s":"65047644"}'::jsonb),
('mot-er62','{"d":"00fa1c52","c":"d37c473f","s":"65047644"}'::jsonb),
('mot-er63','{"d":"6cb9655d","c":"d37c473f","s":"65047644"}'::jsonb),
('mot-er65','{"d":"41efd91e","c":"9fe209af","s":"bbc74d77"}'::jsonb),
('mot-er66','{"d":"2dc9472e","c":"7054bfc7","s":"1373018a"}'::jsonb),
('mot-er71','{"d":"718ff848","c":"b4b5b28f","s":"5ddcd660"}'::jsonb),
('mot-er72','{"d":"1865268f","c":"72390b1c","s":"03acd96a"}'::jsonb),
('mot-er73','{"d":"19e2fd49","c":"69370494","s":"d514c3e6"}'::jsonb),
('mot-er74','{"d":"62defd09","c":"6d436a46","s":"54159065"}'::jsonb),
('mot-er75','{"d":"e55262e4","c":"e7d35d17","s":"6942c7e4"}'::jsonb),
('mot-er76','{"d":"e72f0610","c":"ae45f4b1","s":"83c088c6"}'::jsonb),
('mot-er79','{"d":"9e59fe61","c":"0a5dfafa","s":"51a39c63"}'::jsonb),
('mot-er80','{"d":"cd14693f","c":"e4875c23","s":"51a39c63"}'::jsonb),
('mot-er81','{"d":"d33cccd6","c":"2d874a27","s":"77fc0f79"}'::jsonb),
('mot-er82','{"d":"6a1fb549","c":"999a95a0","s":"b1bc06d3"}'::jsonb),
('mot-er83','{"d":"1db13f43","c":"b665aae1","s":"4cedd1c4"}'::jsonb),
('mot-er84','{"d":"44075864","c":"c0e7ab2e","s":"4cedd1c4"}'::jsonb),
('mot-er85','{"d":"4bfd5818","c":"07808772","s":"7aa5984f"}'::jsonb),
('mot-er86','{"d":"f1244e5a","c":"7ea66171","s":"881e9d51"}'::jsonb),
('mot-er87','{"d":"96854620","c":"cda1812f","s":"5ec61292"}'::jsonb),
('mot-er89','{"d":"5df65dd9","c":"c9b949a3","s":"f4c1d357"}'::jsonb),
('mot-er90','{"d":"064c909f","c":"b759ad41","s":"056cef45"}'::jsonb),
('mot-er91','{"d":"a640d28f","c":"dfd36252","s":"15700865"}'::jsonb),
('mot-er92','{"d":"eebb0781","c":"eab42a11","s":"2578447d"}'::jsonb),
('mot-er93','{"d":"ee9cd766","c":"5319f737","s":"3a093aa6"}'::jsonb),
('mot-er94','{"d":"2ea3d790","c":"a7228cbc","s":"ae35558a"}'::jsonb),
('mot-er95','{"d":"8cb65e08","c":"0dd267e0","s":"9324e566"}'::jsonb),
('mot-er96','{"d":"4189cb45","c":"b03ec682","s":"e9ecc3be"}'::jsonb),
('mot-er97','{"d":"c82333bb","c":"667d9d90","s":"9e40938a"}'::jsonb),
('mot-er98','{"d":"e55c2e29","c":"45ed505b","s":"53ea9ed2"}'::jsonb),
('mot-er99','{"d":"2fc2aa19","c":"98ad248a","s":"7736a9e7"}'::jsonb),
('mot-er100','{"d":"43934bcf","c":"96c1bde8","s":"6638971d"}'::jsonb),
('mot-er101','{"d":"b3509b32","c":"e91e10dd","s":"01ec57a4"}'::jsonb),
('mot-er102','{"d":"43b57793","c":"0a332bde","s":"21d0a4e9"}'::jsonb),
('mot-er104','{"d":"33058302","c":"1fd79ecf","s":"b6d207f1"}'::jsonb),
('mot-er108','{"d":"eec73b48","c":"a78abc71","s":"5e06f70b"}'::jsonb),
('mot-er110','{"d":"700b79bb","c":"01598723","s":"a41b321c"}'::jsonb),
('mot-er111','{"d":"4b64f105","c":"26358b43","s":"a37f0778"}'::jsonb),
('mot-er112','{"d":"54d1769a","c":"bfb22f72","s":"0b14aa54"}'::jsonb),
('mot-er113','{"d":"f0b3c4ff","c":"efaf64fe","s":"605632be"}'::jsonb),
('mot-er114','{"d":"73fba31c","c":"03ed4e8b","s":"48837acb"}'::jsonb),
('nice-err02','{"d":"0beb4833","s":"c3601a2a"}'::jsonb),
('nice-err03','{"d":"a2a1221e","s":"c12e0b2d"}'::jsonb),
('nice-err04','{"d":"a57076ca","s":"1b770360"}'::jsonb),
('nice-err05','{"d":"669340a2","s":"b4269c7c"}'::jsonb),
('nice-err06','{"d":"40d2b9db","s":"5372b28a"}'::jsonb),
('nice-err07','{"d":"2bec4a8f","s":"ca276087"}'::jsonb),
('nice-err08','{"d":"01cf1904","s":"e95e8c03"}'::jsonb),
('nice-err09','{"d":"78278b2d","s":"bc00ab46"}'::jsonb),
('nice-err10','{"d":"d4d84f3d","s":"f2f1f3f9"}'::jsonb),
('nice-err11','{"d":"44657ab6","s":"4c45d746"}'::jsonb),
('nice-err12','{"d":"dd26fed5","s":"46a237d4"}'::jsonb),
('nice-err13','{"d":"513c6c53","s":"19869089"}'::jsonb),
('nice-err14','{"d":"7f91ef4d","s":"67ff0404"}'::jsonb),
('nice-err15','{"d":"7480148e","sub":{"1":"e8bf7bb9","2":"70fe074b"}}'::jsonb),
('nice-err16','{"d":"c87aa2eb","sub":{"1":"62cfb042","2":"d7123e98","3":"208d39ca"}}'::jsonb),
('nice-err17','{"d":"ee7983a2","sub":{"1":"aa6d8b2b","2":"71b8c311","3":"ecdfa5ef"}}'::jsonb),
('nice-err18','{"d":"bee3552d","s":"abcc43dd"}'::jsonb),
('nice-err19','{"d":"c5358949","sub":{"1":"dfc5a6a6","5":"ebdca22f","8":"dacd851c","9":"07c5501d","12":"3e244003"}}'::jsonb),
('nice-err20','{"d":"8a2ecc7a","sub":{"1":"083379db","4":"6447d762","5":"76b8f61f","7":"d4399e59","14":"85432236","2":"e8988c4d","8":"e8988c4d","3":"cebb61bc","15":"cebb61bc","9":"cf0305c9","12":"5ff79c6a","13":"fe98860f","19":"fac64bb3","55":"4657d3d1"}}'::jsonb),
('nice-err21','{"d":"8e60f15f","sub":{"2":"1b3d1bc8","3":"9c95885e"}}'::jsonb),
('nice-err22','{"d":"161d70ab","sub":{"101":"8683fc3f","102":"fb003a0f","103":"d6ee5b22"}}'::jsonb),
('nice-err23','{"d":"e6aaa214","sub":{"1":"6260f917","2":"6260f917","3":"6260f917","4":"e98a4153"}}'::jsonb),
('nice-err24','{"d":"ae1bbd64","sub":{"101":"69caaf98"}}'::jsonb),
('nice-err25','{"d":"0c81d2f0","sub":{"101":"7bd4202d","102":"7bd4202d","103":"7bd4202d"}}'::jsonb),
('nice-err26','{"d":"8c5f75a2","sub":{"101":"25a407f7"}}'::jsonb),
('nice-err27','{"d":"d9a8062d","s":"3722cad9"}'::jsonb),
('nice-err28','{"d":"cac34e42","s":"df7fe43c"}'::jsonb),
('nice-err29','{"d":"6756566d","sub":{"101":"029620a9","102":"27345b53"}}'::jsonb),
('nice-err30','{"d":"30c58568","sub":{"101":"1d9d92ff","102":"1d9d92ff"}}'::jsonb),
('nice-err31','{"d":"30fe4fc4","s":"aa467523"}'::jsonb),
('nice-err32','{"d":"80405e3a","s":"36de72fc"}'::jsonb),
('nice-err33','{"d":"f68fd71a","sub":{"101":"a473450d","102":"5fb296c3","103":"47553de6","104":"32030bea","105":"32030bea","106":"7f5557fb"}}'::jsonb),
('nice-err34','{"d":"12dc5455","s":"d035f6de"}'::jsonb),
('nice-err35','{"d":"3adb8302","sub":{"101":"de369df5","102":"ae0e909d","103":"fb0a9727","104":"aeb5b497","113":"aeb5b497","114":"aeb5b497","105":"e9b71cff","106":"3392a39c","107":"3392a39c","109":"3392a39c","108":"6a46efe7","110":"6a46efe7","111":"dfa4cc6e","115":"dfa4cc6e","112":"7eb5b89f"}}'::jsonb),
('nice-err36','{"d":"55ad7c54","sub":{"101":"73e5a5ed","102":"da673369","104":"b0fb75bd","105":"4323635c","103":"5be31f0a"}}'::jsonb),
('nice-err37','{"d":"55ad7c54","sub":{"101":"3ec18aea","102":"9eea5d39","103":"068e547c","106":"0f67c177","105":"4bf75a1d","104":"db04ce70","107":"a2bb1d56","108":"fd904469","109":"c7673cc8"}}'::jsonb),
('nice-err38','{"d":"04554c17","sub":{"101":"87a0c051","102":"9b997b6b","103":"0747db5c","104":"dfe409eb","105":"35fd8277","106":"6e2f3ee1","107":"75d24593"}}'::jsonb),
('nice-err39','{"d":"fb4bc7f4","sub":{"101":"a215d632"}}'::jsonb),
('nice-err40','{"d":"e1073e4d","s":"3722cad9"}'::jsonb),
('nice-err41','{"d":"523b6caf","sub":{"101":"d2d1d314"}}'::jsonb),
('nice-err42','{"d":"6333ab3f","sub":{"101":"b8c89e09","102":"b8c89e09"}}'::jsonb),
('nice-err43','{"d":"9a62a32b","sub":{"101":"1f653169"}}'::jsonb),
('nice-err44','{"d":"50eaf994","sub":{"101":"4753a7d3"}}'::jsonb),
('nice-err45','{"d":"a8093b13","sub":{"101":"de5752db","102":"f4e504a0","103":"211eb7b7","106":"3354aaa9"}}'::jsonb),
('nice-err46','{"d":"7eb80ac7","sub":{"101":"9657a2c1","102":"0434b691"}}'::jsonb),
('nice-err47','{"d":"af22933c","sub":{"101":"b14aee30","102":"ccea848f","106":"09a5c7d0","103":"89dcfa9a"}}'::jsonb),
('nice-err48','{"d":"df0dc577","sub":{"101":"27ffa2c6"}}'::jsonb),
('nice-err49','{"d":"60158d75","sub":{"101":"121d6f92"}}'::jsonb),
('nice-err50','{"d":"e3515213","sub":{"101":"6bc9274e","102":"faad1a8f"}}'::jsonb),
('nice-err51','{"d":"fbc17457","sub":{"101":"ea25ddbb"}}'::jsonb),
('nice-err52','{"d":"7a3a5acc","sub":{"101":"b032f564"}}'::jsonb),
('nice-err53','{"d":"b39d2d7e","sub":{"101":"b3ecae9d","102":"0b17457e","105":"aef680e8","106":"9d3facab","104":"26625cfd","107":"059928be"}}'::jsonb),
('nice-err54','{"d":"e40247da","sub":{"102":"cfaa3585"}}'::jsonb),
('nice-err55','{"d":"f21cf516","sub":{"101":"832ef25f"}}'::jsonb),
('nice-err56','{"d":"3e19bfb2","sub":{"101":"16f18d10","102":"b82acc82","103":"9dc6241c","104":"d74e4c07"}}'::jsonb),
('nice-err57','{"d":"24d482cf","sub":{"101":"588f4373","102":"588f4373","103":"1a160da7"}}'::jsonb),
('nice-err58','{"d":"b763cc14","sub":{"101":"7628ccc1","102":"c09d212d"}}'::jsonb),
('nice-err59','{"d":"e1073e4d","s":"3722cad9"}'::jsonb),
('nice-err60','{"d":"e1073e4d","s":"3722cad9"}'::jsonb),
('nice-err61','{"d":"e1073e4d","s":"3722cad9"}'::jsonb),
('nice-err62','{"d":"82904add","sub":{"101":"525755fa"}}'::jsonb),
('nice-err63','{"d":"b1aa6552","s":"6fe7b3cc"}'::jsonb),
('nice-err64','{"d":"7685cf80","sub":{"101":"50f39e37"}}'::jsonb),
('nice-err65','{"d":"bb8e2d21","s":"8f00bbed"}'::jsonb),
('nice-err66','{"d":"8ee02655","s":"cc7dfa5a"}'::jsonb),
('nice-err74','{"d":"d9d1ad37","sub":{"1":"3636864b"}}'::jsonb);

update public.wlf_troubleshooting t
   set content=jsonb_set(jsonb_set(t.content,'{bn,src}',s.src),'{revision}',to_jsonb(t.revision+1)),
       revision=t.revision+1
  from wlf_tb_src s
 where t.id=s.id and t.content ? 'bn' and t.content #> '{bn,src}' is null;

-- ---------------------------------------------------------------- RPC layer (build number)
do $layer$ begin
  if to_regprocedure('wlf_private.rpc_before_v251(text,jsonb)') is null then
    alter function wlf_private.rpc(text,jsonb) rename to rpc_before_v251;
  end if;
end $layer$;

create or replace function wlf_private.rpc(a text, args jsonb) returns jsonb
language plpgsql security definer set search_path='' as $$
declare result jsonb;
begin
  result := wlf_private.rpc_before_v251(a,args);
  if a in ('getSession','getAppContext') then
    result := result||jsonb_build_object('build','2.5.1','otherChoices',true,'troubleshootingBanglaEdit',true);
  end if;
  return result;
end
$$;

revoke all on function wlf_private.rpc_before_v251(text,jsonb) from public, anon, authenticated;
revoke all on function wlf_private.rpc(text,jsonb) from public, anon;
grant execute on function wlf_private.rpc(text,jsonb) to authenticated;

notify pgrst, 'reload schema';
commit;

-- ---------------------------------------------------------------- check
select
  wlf_private.other_choice('["A","Other:"]','"Other: Hall button"') and not wlf_private.other_choice('["A","Other:"]','"Other: "') as other_name_ready,
  not exists(select 1 from public.wlf_ri_categories c, jsonb_array_elements(c.schema->'fields') x where c.id='wb-team' and x->>'id'='project') as team_task_name_only,
  (select count(*) from public.wlf_ri_categories c, jsonb_array_elements(c.schema->'fields') x where c.id='wb-sales' and x->>'id' in ('start_date','end_date'))=2 as sales_dates_ready,
  (select count(*) from public.wlf_troubleshooting where content ? 'bn' and content #> '{bn,src}' is null)=0 as bangla_tracking_ready,
  to_regprocedure('wlf_private.rpc_before_v251(text,jsonb)') is not null as v251_ready;
