# WLF Electrical Solution v2.5.8

## v2.5.8 MOTCUBE drive error in support forms, readable history labels (19 November 2026)

- Support forms: Problem Category gets **MOTCUBE drive error** directly below *NICE3000+ drive error*; choosing it requires one code from the Problem Sub-Category list (H1 to H62, no H20 in the manual: 61 codes). Applied to every form that has both the Problem Category and Problem Sub-Category fields (five teams). Installation (Mechanical / Electrical only) and forms where Super Admin changed or removed the fields are left alone; submitted requests keep their own form.
- Request history shows Submitted / Received / Forwarded / Solved / Not Solved / Kept Pending (`AccessCore.historyLabel`); the arrow shows only on Forwarded; the report column "Activity history" is readable text instead of JSON.
- Run `supabase/UPDATE_V258.sql` after v2.5.7. See `START_HERE_V258_BN.html`.

## v2.5.7 Technical Support split screen, requester red mark and push, activity-log auto-delete (19 November 2026)

- Technical Support: full-width split screen (`.support-split`, `web/support-layout.css`). Left: collapsible Filters + request list; right: request detail, or the New request form while it is open. Compact form fields (two columns, small textareas that grow). On a phone everything stacks, the form first, Filters closed.
- Red mark: `getSupportSummary` now returns `mine` / `mineByTeam` (own requests that are not Solved). Shown on My Profile and the top menu.
- Push to the request's author when it is Solved, Not Solved or Forwarded (`wlf_push_support_result`) and when its Damage Demand is Received (`wlf_push_demand_received`); uses the v2.5.0 `wlf-push` queue, no new Edge Function.
- Activity log: rows older than 7 days are deleted automatically, checked at most once an hour on insert (`wlf_usage_autopurge`, logged in `purge_log`).
- Run `supabase/UPDATE_V257.sql` after v2.5.6. See `START_HERE_V257_BN.html`.

## v2.5.6 Usage Dashboard access, 7-day activity log, component change log (19 November 2026)

- My Profile: **My Activity** removed (the server function `my_activity` is dropped).
- Usage Dashboard: shows the last **7 days**; older rows stay until the Super Admin downloads/deletes them, or deletes any **From–To** period (`countUsageRange`, `purgeUsageRange`, typed DELETE, recorded in the Recycle Bin purge log). Technical Support removed from this page.
- New permissions (group *Usage Dashboard*): `usage:dashboard` and `components:log`. Only the Super Admin sees the Usage Dashboard until people are ticked; holders see every user.
- Component change log: a trigger on `public.wlf_components` records add / edit / delete with old and new values (also changes made in the SQL Editor). Shown in the Usage Dashboard (`getComponentLog`) with dates, search and Excel.
- Dashboard: Technical Support lists all six teams and Damage Demand all four teams, also with zero requests.
- Components Data: search over all columns; key columns and Edit/Delete stay on screen while scrolling.
- Run `supabase/UPDATE_V256.sql` after v2.5.5. See `START_HERE_V256_BN.html`.

## v2.5.5 Supplier Claim reference/undo, MOTCUBE Error Solution, light-theme chip fix (19 November 2026)

- Supplier Claim page: the DD number opens the demand (Pending and Received). Labels: **Supplier Claimed**, **Supplier Confirmed**; buttons **Claim Sent to Supplier**, **Supplier Accepted Claim**, Super Admin **Undo Claimed** / **Undo Confirmed** / **Undo Received** (`undoSupplierReceive`, records who/when).
- Optional claim reference (max 60 chars) at the confirm step, editable until Received (`saveSupplierReference`); shown in the demand, the Supplier table and Excel (`Supplier Claim Ref`).
- Troubleshooting: new controller **MOTCUBE** with Error Solution (61 codes, English + Bangla), permanent / contact R&I tags, parameters, and the **Permanent Error Clearing** sub option. Super Admin edits/adds/deletes; permission `tb:MOTCUBE:error` (every non-Super-Admin account needs the tick).
- Fix: in the Light theme with a dark OS, Component Selection motor chips had white text on white.
- Run `supabase/UPDATE_V255.sql` after v2.5.4. See `START_HERE_V255_BN.html`.

## v2.5.4 Component Selection Reset, R&I Electrical support notification, Supplier Claim (19 November 2026)

- Component Selection: **Reset** clears the six selection fields, the motor list and the report (not Calculations).
- Technical Support: `wlf_push_new_support_request` trigger on `public.wlf_requests` queues a push for every approved user whose section is **R&I Electrical** when a new request is submitted (not for the submitter).
- Damage Demand: two Yes/No acknowledgements, **Supplier Claim** (`markSupplierClaim`) then **Supplier Confirmed** (`confirmSupplierClaim`), independent of the demand's Pending/Received. Super Admin can undo (`cancelSupplierClaim`) until goods are Received.
- New menu **Supplier Claim** (`getSupplierClaims`, `receiveSupplierClaim`): confirmed items wait as Pending until the goods arrive, then Received. Red count via `getNavBadges.supplierPending`.
- Permissions `supplier:view`, `supplier:claim`, `supplier:confirm`, `supplier:receive` are assigned per user by the Super Admin. Nobody has them by default.
- Run `supabase/UPDATE_V254.sql` after v2.5.3. See `START_HERE_V254_BN.html`.

## v2.5.3 Recycle bin, Announcement, Management Dashboard, My Profile first (17 November 2026)

Open START_HERE_V253_BN.html. Order: backup kit -> supabase/UPDATE_V253.sql (check row: all true) -> upload changed files.

- Recycle bin (Super Admin; `wlf_private.recycle_bin`, `getRecycleBin` / `restoreRecycleItem` / `purgeRecycleItems`): every delete lands here — support request, R&I entry, project, project task, troubleshooting entry, document link, document sub menu (with its folders and links), folder, announcement. Restore, Delete permanently (confirm with count) or Empty bin (type DELETE). No automatic purge. `wlf_private.purge_log` keeps only who/when/type/count. Soft-deleted rows from before v2.5.3 are added to the bin by the migration.
- Announcement (Super Admin; `wlf_private.announcements` + `announcement_reads`): title, message, sections (or all), optional end date. Shown as a My Profile card, counted in the My Profile red badge, push on publish (or "send again"). Read receipts per announcement.
- Menu red counts (`getNavBadges`): My Profile = forwarded-to-me + unread announcements; Damage Demand = pending demands. Demand/Dashboard sub-items removed from the menu (the in-page buttons stay).
- Usage Dashboard: counts and the activity log cover the last 30 days (`usage_stats`, `getUsageLog` with user filter). Older rows: Super Admin downloads them as Excel (`exportOldUsageLog`), then deletes them by typing DELETE (`purgeUsageLog`). Nothing automatic.
- Dashboard (workspace:dashboard) is now the Management Dashboard (`getManagementDashboard`): R&I Team Activity per form and person, projects by lead/status, Technical Support per team/person + 12-month curve, Damage Demand per team + top-10 components + 12-month curve, QMS, Supplier claim placeholder. This month by default; Excel download.
- The app opens on My Profile. My Profile adds "My work breakdown" (`getMyActivity`, own work only, this month by default).

## v2.5.2 Problem sub-category, team badges, damage receive by team (17 November 2026)

Open START_HERE_V252_BN.html. Order: backup kit -> supabase/UPDATE_V252.sql (four columns true) -> upload changed files.

- Support forms (commissioning, aftersales, production, qc, maintenance): 36 problem categories; `problem_sub` is a dependent select (`dependsOn` + `optionMap`) chosen in a searchable popup and required when its list is not empty. `form_fields`/`form_values` validate it; Super Admin edits the lists in Manage form fields.
- Team cards show the unsolved badge; My Profile lists requests forwarded to me and not yet received (`getMyForwarded`).
- Damage Demand: `damage:receive:<team>` replaces `damage:receive` (holders migrated); demand list has team tabs with pending counts (`teamPending`).
- Request access: every field required in the form and in `wlf_private.new_user` for app sign-ups; duplicate IDs allowed.
- Component report title: Recommended MOT Control System.

## v2.5.1 Form cleanup, Other name, Bangla edit, submit confirmation (16 November 2026)

Open START_HERE_V251_BN.html. Order: backup kit -> supabase/UPDATE_V251.sql (five columns true) -> upload changed files.

- Confirmation popup after a server-confirmed submit (R&I Team Activity, Technical Support).
- Auto-fill fields (Name, ID, today's date) are hidden in R&I activity and support forms; the server fills them (date = submission day, kept on edit).
- "Other" choices ask for a name; saved as `Other: <name>` (`wlf_private.other_choice` accepts it in `form_values`).
- Team Activity: "Project / Task Name" removed (old entries keep their saved form). Sales Support: optional Task Start / Complete Date.
- Recent entries list is one compact row per entry. Large text fields are full width. Date boxes open the calendar on click.
- Troubleshooting Bangla can be edited; `content.bn.src` stores FNV-1a fingerprints of the English parts so stale Bangla falls back to English.

## v2.5.0 Notifications, change history, Bangla troubleshooting, speed (15 November 2026)

Open START_HERE_V250_BN.html for the rollout guide.

| Order | Place | File or action |
| --- | --- | --- |
| 1 | Supabase SQL Editor | Backup kit (01 and 02), check both CSVs |
| 2 | Supabase SQL Editor | supabase/UPDATE_V250.sql (bangla_entries = 166, all other columns true) |
| 3 | Supabase Edge Functions | Deploy `wlf-push` (supabase/functions/wlf-push/index.ts) with Verify JWT OFF |
| 4 | GitHub repository | Upload the changed files to main; wait for the Pages workflow |

- User Management: copy access from another user, red Duplicate ID mark, change history (Super Admin only; `getUserAccessLog`).
- Push notifications (standard Web Push, VAPID keys created by the function and kept in `wlf_private.push_keys`): new access request -> approved Super Admins; forwarded support request -> receiver. Opt in per device in My Profile.
- Technical Support: requests not Solved turn yellow after 2 days and red after 3 (Super Admin can change; `saveSupportAging`).
- Troubleshooting: English / বাংলা toggle; `content.bn` for 166 MOT and NICE3000+ entries (missing parts fall back to English).
- R&I Activity: "Canceled" -> "Cancelled"; one grouped category list; form left and recent entries right on wide screens.
- Speed: startup reads run in parallel with getSession; the Excel/PowerPoint bundle loads on first download (`wlf-exports-lite.js`); app JS/CSS minified (shared modules stay byte-identical).

## v2.4.1 (15 November 2026)

The task field label is back to the correct word **Assignee** (behaviour unchanged: project lead or a collaborator, no auto-fill, Add user). UPDATE_V240.sql is safe to run again and only updates the task error text.

## v2.4.0 Document folders, task Assignee, spelling (15 November 2026)

Open START_HERE_V241_BN.html for the rollout guide.

| Order | Place | File or action |
| --- | --- | --- |
| 1 | Supabase SQL Editor | Backup kit (01 and 02), check both CSVs |
| 2 | Supabase SQL Editor | supabase/UPDATE_V240.sql (all five result columns must be true) |
| 3 | GitHub repository | Upload the changed files to main; wait for the Pages workflow |

- Documents Links: folders and sub-folders (up to 6 levels) inside each sub menu,
  breadcrumb navigation, search across folder and document names with the folder
  path, folder choice in Add/Edit document. Super Admin only manages folders;
  only empty folders can be deleted.
- R&I Project Manager: the task field is Assignee, no auto-fill, a choice of the
  project lead and collaborators (Name (ID)); "Add user" adds a collaborator in the
  same save. The server rejects users outside the project.
- Spelling: Installation option "1. Aesthetics"; NICE3000+ Err38 text "runs in up direction".
- Backup kit: 01_STRUCTURE_BACKUP.sql no longer triggers Supabase's false RLS warning.

New staging databases apply UPDATE_V240.sql after UPDATE_SECTIONS_V230.sql.


## v2.3.0 Sections, Name & ID update (15 November 2026)

Open START_HERE_V230_BN.html for the click-by-click rollout guide.

| Order | Place | File or action |
| --- | --- | --- |
| 1 | Supabase SQL Editor | Backup kit: 01_STRUCTURE_BACKUP.sql and 02_DATA_BACKUP.sql, check both CSVs with 03_RESTORE_TOOL.html |
| 2 | Supabase SQL Editor | supabase/UPDATE_SECTIONS_V230.sql (all five result columns must be true) |
| 3 | GitHub repository | Upload the changed files to main; wait for the Pages workflow to finish green |
| 4 | Live app | Activate the update, log in as Super Admin, check My Profile |
| 5 | Supabase SQL Editor (optional) | supabase/CLEANUP_KEEP_SUPER_ADMIN_V230.sql after a fresh backup |

- Request access asks for Name, ID, Section (13 sections), Email and Password.
- User types: Super Admin; R&I user (Section R&I Electrical or R&I Mechanical,
  processes support for the ticked teams); section user. The Admin role and its
  automatic read-all access are removed. Every option except Super Admin's is granted
  per user.
- Support and R&I activity forms: the single Name & ID field becomes locked Name and
  ID fields (auto-fill name / empid), filled from the login profile on the server.
- Support cards, details and activity history show Name (ID) instead of e-mail.
- The ASSIGNED TO filter is now SUPPORT USER: requesters of the team's section
  (Commissioning, After Sales, Installation, Production, QC = QM,
  Factory Maintenance).
- Forwarding requires the receiving R&I user to have access to that team.
- Field order: the existing up/down buttons in Manage form fields.

New staging databases apply UPDATE_SECTIONS_V230.sql after UPDATE_WORKSPACE_20261107.sql.
Tests: tests/sections-update.test.cjs and the updated browser test.


Production upgrade for the existing WLF v2.1 Supabase project and GitHub Pages PWA.
Open START_HERE_BN.html in the release ZIP for the rollout guide.

The 7 November 2026 Technical Support field update uses the supplied
Technical support form.xlsx. Existing v2.2 projects apply
supabase/UPDATE_SUPPORT_FORMS_20261107.sql in the Supabase SQL Editor.
New staging databases apply it after UPDATE_V220.sql. The six field definitions
and source checksum are in data/technical-support-forms-20261107.json.
The previous definitions are stored in wlf_private.support_form_updates.

## Damage Demand update

On the current v2.2 project, run supabase/UPDATE_DAMAGE_DEMAND_20261107.sql
in SQL Editor. Upload the matching web package to the existing GitHub Pages
repository. The update requires the six Technical Support teams.

An assigned R&I handler can record duration and Hardware Issue on a received
support request. Commissioning, After Sales, Installation and Factory
Maintenance can raise one replacement demand per request. A demand stores the
support form snapshot and solution statement at submission.

In User Management, Super Admin can grant Demand and Dashboard separately.
Dispatch needs both Demand and Receive. The request submitter sees the demand
status in the original Technical Support request. Report dates use Dhaka time.
The component chart uses each item's quantity divided by the total quantity
in the filtered demands.

## Original v2.2 release

| Order | Place | File or action |
| --- | --- | --- |
| 1 | Supabase SQL Editor | supabase/PRECHECK_V220.sql |
| 2 | Supabase SQL Editor | supabase/UPDATE_V220.sql, then supabase/VERIFY_V220.sql |
| 3 | Supabase CLI | Deploy wlf-maintenance with supabase/functions/_shared/ present |
| 4 | Current GitHub repository | Apply this folder at the repository root and deploy the Pages workflow |
| 5 | Live app | Grant R&I module access, smoke-test with existing accounts and activate the PWA update |

The upgrade uses existing Auth identities. New activity and project data, editable form
definitions and component data persist in Supabase. Historic submissions retain their
form snapshots. The workbook upgrade uses the exact v2.1 reference rows as its baseline
and records preserved customizations in wlf_private.v220_import_audit.

## Local build and tests

Use Node 22 or newer. The checked-in package-lock.json pins the dependencies.

    npm ci
    node scripts/check-config.mjs
    npm run build
    npm test
    npx playwright install chromium
    npm run test:e2e
    npm run preview

npm run build:upgrade rebuilds the combined SQL migration from supabase/release-v220/.
The compiled web files are in dist/. Keep web/config.js pointed at the same Supabase
project. Only the publishable key belongs in the frontend.

For a new staging database the sequence is 01_SETUP.sql, UPDATE_V210.sql and
UPDATE_V220.sql, followed by creating and approving staging users. Those first two SQL
files are historical setup files. The live v2.1 project uses only the v2.2 migration.

Release evidence is in docs/v220/VALIDATION.md. See THIRD_PARTY_NOTICES.md for license
notices and docs/v210/GOOGLE_DRIVE_SETUP_BN.html for OAuth setup.
