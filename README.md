# WLF Electrical Solution v2.5.1

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
