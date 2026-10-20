# WLF v2.1.0 validation — 18 October 2026

Base: Saiful44711/WLF-Electrical-Solution commit
1398f2c9e63f549e8c6f19815ab4aa8b9bba307f.
No production SQL, repository write, deployment or Google account operation was performed.

## Passed

- `npm run build`: generated PC/mobile PWA assets and a new cache version.
- `npm test`: **41 passed, 0 failed**.
- `npm run test:e2e`: passed in Chromium headless against the actual bundled
  Supabase SDK with a real PGlite/PostgreSQL test database under `/wlf/`.
- Public config format check and `git diff --check`.
- Reapplying UPDATE_V210.sql does not reset existing data.
- Every public app table has RLS. Browser roles cannot call the service-only
  maintenance RPC or the retained legacy private RPC directly.
- All approved roles can read document links; only Super Admin can change them.
  Tests cover custom fields, unsafe URL rejection and revision conflicts.
- Only Super Admin can use Components Data administration. Existing component
  selection remains available to granted users.
- Users cannot query usage stats. R&I usage and dashboard support performance
  contain only the caller; Admin sees the full usage report.
- Auth metadata cannot grant privileges; inactive access is checked on actions.
- Rejected deletion protects linked identities and blocks concurrent promotion.
- Support backups include all history and operation entries, use inclusive date
  boundaries and require complete multipart verification before clear.
- Edge tests enforce token/current Super Admin, upload/download SHA-256 checks,
  failure preservation, and re-verification immediately before each clear.
- Clear preserves unsolved, new and changed requests, and is idempotent.
- Minimal operation tombstones block re-submission of archived mutation IDs.
- Same-project restore reinserts missing requests/history/operations and never
  overwrites existing request IDs. Repeat restore is a no-op.
- Browser: document category/field/document create and edit, read-only User view,
  name/email search, rejected deletion, period-filtered backup-only, download,
  reviewed clear and restore UI, R&I dashboard isolation, mobile no-overflow.
- Existing browser regression: all-role own password update, imported components,
  generator result 8.668 kVA, local NICE error/subcode search, support roles,
  receive/solve behavior, notifications, CSV, theme/header, realtime
  callback draft preservation and actual service-worker offline reload.
- Super Admin General Solution creation and existing MOT add-option/error/solution
  editor controls are reachable even if General is initially empty.

## Preservation evidence

Byte-identical to the production base: shared/logic.js (all engineering formulas),
web/app.js, web/transport.js, web/troubleshooting.js,
shared/troubleshooting-core.js, shared/support-forms.json,
data/component-source.json, existing logo/icons and original main CSS files.
The production workspace is extended through its existing shared policy and
RPC boundary, not replaced by the demonstration UI.

## Limits

Auth REST and realtime network delivery are mocked in browser tests. Google
endpoints are mocked; real consent/token refresh/upload and the actual hosted
Supabase Edge environment were not tested with customer credentials. There was
no hosted Supabase security advisor run, load test, native APK build or physical
Android device test. Local RLS/grant checks do not substitute for the production
acceptance checklist in the guide.

Support archives are per-record snapshots assembled in parts while the app
remains usable; they are not a single full-database point-in-time dump. Auth,
roles/passwords, project settings, engineering catalog, documents and original
Drive files are not included in this support archive. Those data are never
cleared by the support archive action. Backup metadata and small idempotency
records continue to consume space. Data deletion can leave reusable PostgreSQL
space rather than immediately lowering reported database size.

The Edge implementation caps each archive part at 8 MB and restored JSON at
10 MB; exceptionally large records require a developer-assisted export.
Backup is initiated by an online Super Admin with the app open; there is no
unattended daily schedule. A failed clear after earlier completed batches is
reported as partial, and can be safely resumed using the same verified backup.
