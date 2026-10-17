-- First create your account using the app's Request access form.
-- Replace ONLY the email below, then Run in Supabase SQL Editor.
-- This is an OWNER-only setup action. Do not put a password in SQL/source.
do $$
declare chosen text='liftrndelectrical@gmail.com'; n integer;
begin
 if chosen='REPLACE_WITH_YOUR_EMAIL' then raise exception 'Replace email first';end if;
 if exists(select 1 from public.wlf_profiles where role='Super Admin' and status='Approved' and email<>lower(chosen))then raise exception 'A Super Admin already exists; use User Management instead';end if;
 update public.wlf_profiles set role='Super Admin',status='Approved',access_revision=access_revision+1 where email=lower(btrim(chosen));
 get diagnostics n=row_count;if n<>1 then raise exception 'Account not found. Register through the app first';end if;
end$$;
