# Backup and restore

GitHub/ZIP backs up source, not live Supabase/Auth data. A support CSV report is for reporting and is not a relational recovery backup. Keep private backups outside the public repository. Free plans do not provide the same backup/restore features as paid plans; verify current project settings and [Supabase backup documentation](https://supabase.com/docs/guides/platform/backups).

## Minimum records

Record project reference/region, website URL, deployment Git commit, schema/API release, Auth settings/SMTP settings, function code, public config and database access details in a private password manager/folder. Keep database dump containing application data, auth identity relationships, forms, history and idempotency records, not just requests. Preserve original user IDs if restoring old requests.

## Recommended full dump

Use Supabase's documented database-backup process with a compatible PostgreSQL `pg_dump` or Supabase CLI, private database credentials, and a locally installed Docker engine if required by your CLI. Check the installed version's `db dump --help` before running it. CLI defaults may exclude managed schemas such as Auth; `public,wlf_private` alone is NOT a complete identity backup.

Example for a PRIVATE local directory, not inside this repository:

```
npx supabase login
npx supabase link --project-ref YOUR_PROJECT_REF
npx supabase db dump --linked --schema public,wlf_private --file app-schema.sql
npx supabase db dump --linked --schema public,wlf_private --data-only --use-copy --file app-data.sql
```

These two example files cover application schema/data only, NOT a complete Auth backup. Use the official guide for Auth schema/data/roles, extensions and managed-object restore order for your actual Supabase release; preserve auth.users IDs linked by wlf_profiles. Do not paste database URLs/passwords in shared chat, screenshots or shell history. Never upload dumps/token files to public GitHub. Store at least one second private copy and test recovery in a separate disposable project. Without a restore test, completeness is not established.

## A recoverable launch backup

Before real users start, export the project's database using the official process and verify that the dump inventory includes the required Auth users/identities, wlf_profiles, wlf_requests, wlf_history, wlf_operations, wlf_forms, wlf_troubleshooting, wlf_components/settings, wlf_usage and records. Source SQL plus the initial seed can recover a FRESH empty app, but cannot recover later user passwords/support work. Capture Edge Functions and settings separately; file Storage is not used by this version. If future uploads are added, back up Storage objects separately too.

## Restore sequence

1. Stop new writes and take a new private backup of current state.
2. Restore into an isolated test project first. Follow the official managed-Supabase restore guide rather than dropping schemas or replaying 01_SETUP.sql over live data.
3. Preserve Auth user UUID/profile/request relationships, identity/credentials and schema-compatible policies. Do not import only requests or reset Auth users while keeping their old UUID foreign keys.
4. Deploy matching Edge Function and configure Auth URLs/email settings. A new Supabase project gets a new URL/key; update web/config.js, bump SW cache version and redeploy PWA.
5. Verify all four roles, known support counts/reports, workflow history, login, idempotency, offline/realtime behavior before switching real users.
6. Re-login clients after cutover. Existing old PWA assets can point to an old project until updated. Do not delete that project until cutover and rollback are reviewed.

## Rollback

Redeploying an old frontend Git commit does NOT roll database data back. Prefer backward-compatible SQL updates and keep the previous frontend build. The old Apps Script/APK package remains independent; it will not sync Supabase requests automatically. Switching back would need deliberate data reconciliation, not just changing a link.
