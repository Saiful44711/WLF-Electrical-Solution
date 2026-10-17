# WLF 2.0 architecture and extension guide

Runtime: static HTML/CSS/JS on GitHub Pages; Supabase Auth, PostgreSQL and RLS; Supabase JS 2.118.0 bundled at build time. No CDN dependency at runtime. Node22+ build and lockfile included. No Apps Script deployment or Sheet required. The separate `wlf-admin` Edge Function handles only privileged password resets.

## Files and responsibilities

| Area | Files | Extension rule |
|---|---|---|
| Engineering formulas | shared/logic.js; shared/ui-helpers.js | Keep one formula implementation; preserve regression examples and unit validation |
| Role/option policy | shared/access-core.js plus supabase/schema.sql/api.sql | JS hides UI; PostgreSQL is authoritative; update both for new actions |
| Components | web/component-core.js; wlf_components/settings | Stable numeric IDs; JSON row values mapped to ordered headers; no spreadsheet row shifting |
| Troubleshooting | shared/troubleshooting-core.js; web/troubleshooting.js; wlf_troubleshooting | Dynamic procedure keys enter SA access catalog; preserve per-record revisions and seed provenance |
| Forms | wlf_forms; shared/support-forms.json; live-workspace.js | Future fields via SA form editor; historic request stores its own schema snapshot |
| Support workflow | api.sql RPC; wlf_requests/history/operations | PostgreSQL transaction, row lock, revision check and per-actor idempotency key |
| Realtime | web/pwa.js; live-workspace.js | RLS-scoped Postgres Changes; one channel per active app; small debounce; preserve drafts; fallback60s |
| Offline | web/sw.js; scoped localStorage | App shell only in SW; data cache owner/project scoped; 24h maximum downloaded offline access |
| Hosting | .github/workflows/pages.yml; scripts/build-pwa.mjs | Valid config → build → SQL/unit/edge/browser tests → Pages |

## Database security

- All ten tables have RLS. `anon` has no app data access. Authenticated users get SELECT only, scoped by RLS. No client can directly insert/update/delete, including Super Admin.
- Public `wlf_rpc` is SECURITY INVOKER. It calls a private SECURITY DEFINER implementation with explicit identity/status/role/option/ownership checks. The private schema is NOT exposed by Data API. The small granted helper set is required by RLS and RPC; all helpers examine only current `auth.uid()`.
- The private implementation needs elevated privileges to create pending/approved workflows, query scoped reports, join hidden profiles and commit request/history/operation atomically. It is not a generic bypass, dynamic SQL runner or unrestricted table gateway. Never expose `wlf_private`, grant private functions to `anon`, add unrestricted execute grants, or take permissions from editable user metadata.
- Every RPC rereads the approved profile, so status/permission changes do not wait for JWT role claims to expire. Client role state is presentation only.
- Pending profiles come from the Auth trigger. Self-signup metadata can set display name, not role/status/permissions.
- After remote DDL updates run Supabase Security/Performance Advisors; resolve findings according to the intended architecture. Local tests do not replace hosted platform advisors. This package was NOT applied to a hosted project, so no hosted-advisor result is claimed.
- Reset function verifies the bearer token using Supabase Auth and reads CURRENT Approved Super Admin profile before using its server service role key. Gateway JWT check is disabled only for this handler, which performs its own verification. Never place its private key in a GitHub workflow, client bundle or public config.

## Add a new module / calculator

1. Create isolated UI component/pane rather than rewriting existing calculations/support.
2. Add stable permission key to SQL catalog and corresponding AccessCore mapping. Default Normal User access stays off; Super Admin grants it deliberately.
3. Add validation and authenticated SQL RPC if server state is needed. Never rely only on `hidden` buttons.
4. For a calculator add local formula/input checks to shared logic; add UI labels/result formatting. Regression-test known independent examples and boundaries. Do not reuse an old action name for a new formula.
5. Add dashboard/report integration and server usage-action allowlist where relevant.
6. Add scoped realtime subscription only if data truly changes; do not subscribe once per list row.
7. Test every role, direct RPC attempts, own-record isolation, phone/desktop, dark/print, offline/grant changes.
8. Add a reviewed SQL migration if needed; do not rerun initial setup. Discover installed CLI commands with `npx supabase --help`; generate migration skeleton with `npx supabase migration new your_change_name` before writing migration content.
9. Increment package version and SW cache name; deploy DB backwards-compatible changes first, then frontend and affected Edge Function.

## Add a third support team

Current two teams are intentionally explicit. Extend the category check constraints, form seed, AccessCore categories, SQL catalog/summary, UI labels/reference prefix and tests together. Treat it as a schema migration. Adding only a new form row does not automatically authorize or display a third team.

## Search and performance

- Component filtering/detail bootstrap and error/subcode search run locally after download, eliminating per-keystroke server calls. Troubleshooting is fetched lazily, not during login.
- Support search is debounced300ms, executed on server against authorized records, paginated25 (max50) per request. It searches form values/reference/UUID/solution with literal case-insensitive substring semantics. It is not an external search service or an unbounded client download.
- Owner/team/status/assignment/solver/history/usage indexes are included. Substring support search can still scan matching authorized rows; test realistic data volumes. At larger scale add a tested pg_trgm index/migration or full-text search and reconsider report aggregation. This package does not promise constant-time search at unlimited rows.
- Login: Auth password exchange + small approved profile RPC. Components/context are background; manual reference is on-demand.
- Mutation receipt includes canonical ticket + scoped summary; no blocking list/detail round trips. SQL commits all mutation/history/idempotency data atomically. Unrelated requests use independent row locks instead of one global Sheet lock.
- Events invalidate/refetch only relevant data. Realtime reconnection uses small fallback refresh. No fixed latency/user capacity has been measured against a real hosted project.

## Offline and updates

App shell uses versioned cache-first assets with an explicit update/reload button so mixed release files do not silently replace an active draft. Change `CACHE` in web/sw.js for EACH frontend/config release. Data API/auth traffic is never SW-cached. localStorage contains Auth session and previously authorized reference data; use trusted devices, logout and OS/browser protections. Offline permission revocation is not immediate; maximum24-hour verified offline window.

Support submit/transition is online-only. Calculation/troubleshooting outboxes are Super Admin only. Revisions and mutation IDs reject stale/conflicting updates; do not discard that protection to hide errors. Export unsynced work before clearing app storage. PWA does not provide a native file-system/USB/Bluetooth bridge, background push or a Play Store release artifact.

## Initial data provenance

77 Components Selection records extracted from the user-supplied workbook. Only that sheet's header/value records are included; Users, password hashes, logs and old support records were not imported. If the working Google Sheet has later component edits, re-enter/review them through SA Components Data or request an explicit import of its latest export before launch. No source workbook credentials are in this repository.

Controller entries/procedures and form definitions are retained from v1.5.1. Existing engineering formulas are unchanged. A separate required Submitted date field (default Bangladesh today) drives TCS/TAS visible IDs; existing incident/site date questions remain. Stable internal UUID protects independent records with identical visible references.

## Reproduce tests

```
npm ci
npm run build
npm test
npx playwright install chromium
npm run test:e2e
```

SQL tests use real embedded PostgreSQL (PGlite) with a synthetic auth schema and actual RLS, grants, functions and triggers. Edge tests transpile the real TypeScript handler with mocked Auth/admin services. Browser tests load the actual Supabase SDK and real SQL through a local harness; Auth REST responses and websocket callbacks are mocked. Physical Android WebAPK install, hosted Auth/Realtime/Edge gateway behavior, actual GitHub Pages and production load remain setup acceptance checks. Test outputs/screenshots are not production data and are not distributed.
