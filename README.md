# WLF Electrical Solution v2.7.0

## v2.7.0 Monthly reports to Google Drive; AVR item table off the QMS Input page (27 Nov 2026)

- **Monthly reports** (Storage & Backup → Monthly reports, Super Admin): three styled, print-ready Excel files per month, each in its own Google Drive folder:
  - `Technical Support Monthly Report`: Summary (overview, support by section with share, problems with share and the most frequent problem highlighted, error codes, the same problem on the same lift, support needed by requester, support given by R&I members), one sheet per section (section = the team form the requester used: Commissioning, After Sales, Production, Factory Maintenance, QC, Installation), and an *All requests* sheet.
  - `R&I Team Activity Monthly Report`: Summary (by sector, by R&I member, most used forms, time invested), one sheet per sector (Team R&I Activity, Supplier & SCM Communication, Reports, Sales Support), and an *All entries* sheet.
  - `Damage Demand Monthly Report`: Summary (most frequent problem, components failing most, damage by section, damage by user/requester, by controller), one sheet per section, and an *All demands* sheet.
  - Months follow Bangladesh time. Top values are highlighted only when there is one clear top value. A4 landscape, fit to page width, title rows repeat on every printed page.
- **Automatic**: `UPDATE_V270.sql` + *Turn on* schedules a pg_cron job (02:00 Bangladesh time every night) that calls `wlf-maintenance` with its own token (`x-wlf-cron`). Only the reports of the last complete month that are still missing are made, so the month is ready on the 1st and a failed night is retried the next night. **Make report now** makes any month by hand; making a month again replaces its file (the old file goes to the Drive bin).
- **Database**: the reports only read data. New: `wlf_private.monthly_reports` (one small row per report and month) and `wlf_private.report_settings` (one row). Excel files live in Google Drive only.
- **QMS Input**: the AVR model's item table ("AVR … · ALL ITEMS") is no longer opened on the input page; a one-line note shows how many items are saved. The output tables, Excel and backups show the AVR items exactly as before.
- Edge Function `wlf-maintenance` changed (paste `edge-function/wlf-maintenance/index.ts` as one file, Verify JWT OFF).

# WLF Electrical Solution v2.6.9

## v2.6.9 Layout PDF to QMS Input, serial Scan, QR label (26 Nov 2026)

- **QMS Input → Upload layout PDF**: a Walton lift specification/layout PDF is read **inside the browser** (pdf.js; the file is not uploaded or stored). Two Walton layouts are read: the "WALTON LIFT SPECIFICATION" sheet (labels with colons) and the "LIFT TECHNICAL SPECIFICATIONS" table of the production layout (label cell, value cell). A review table shows every value and what will happen. Nothing changes until **Apply**; nothing is saved until **Save lift record**. Filled: Lift ID, Project name, Address, Lift type (from "Usage": Passenger/Cargo), Capacity, Speed, motor Usage type (from "Lift Type": MR/MRL), Roping, Motor brand, Motor model, AVR model ("AVR … [15KVA]"). A value that is missing or not in the lists stays empty and is named in the message. Two close motor models are never guessed. Manual entry works as before.
- **Serial numbers**: each field has a **Scan** button (phone camera, barcode or QR code; Chrome on Android). Typing and pasting still work. A warning appears when the same number is entered in two fields. Text-only stickers (no barcode) are not read in this version.
- **QR label**: the link is removed from the QR text; under the QR code the Walton logo and "Walton Lift" replace the Lift ID; Paid feature names are added when the lift has them. Serial numbers are never in the QR code.
- No new SQL and no extra database space (PDF, scans and QR images are not stored).


## v2.6.8 Technical Support Excel table, Catalogue model import, QMS QR code (24 Nov 2026)
- **Technical Support Excel:** the Excel downloaded from the Technical Support menu (all six forms) is an Excel Table without the Request ID, Submitted by, Submitted at, Last updated, Assigned to and Solved by columns. The CSV download button is removed. Storage & Backup Excel files keep every column.
- **Hardware Catalogue import** ("Import model data"): every Control system + Model found in the Excel (.xlsx) or CSV file is **replaced completely**; other models are not touched; new models are added. A summary (rows now / rows in the file) is shown first and nothing changes until "Replace these models" is pressed. New action `replaceCatalogueTables` (UPDATE_V268.sql).
- **QMS QR code:** the QMS Data lift page shows a QR code (Lift ID, Project, Controller, Motor, COP display, LOP display, Transom display, AVR capacity and a link). Save QR (PNG) and Print label buttons. Serial numbers are never in the QR code. Scanning the link and signing in opens the lift. The encoder is `web/qr.js` (no outside library).

## v2.6.7 AVR in QMS, AVR / Battery serial numbers, Serial numbers permission, QMS Data Excel in backup format (24 Nov 2026)
- **AVR model** is now in "3 · Control system and serial numbers" (no AVR item dropdown). It is filled automatically from the selected motor and can be changed by hand. All items of the chosen AVR model are shown in their own table in the input, saved with the lift, and listed in the output as its own table **6 · AVR** before **7 · Other components**. Output tables are now numbered 1-9 (Paid feature = 8, Special note = 9).
- **Serial numbers:** new AVR SL (required when an AVR model is chosen) and Battery SL (optional, large box, up to 200 characters for up to 5 batteries). Both are in output table 4 and in Excel.
- **Address, Motor type and Lift type** are required (no default), checked on screen and on the server.
- **Serial numbers permission:** new User Management option "QMS / See and download the Serial numbers table". Without it a user sees no serial numbers on screen or in any Excel, but can still edit a lift (blank serial fields keep the stored values). Super Admin always has it. After the update nobody except the Super Admin has it until it is given.
- **QMS Data:** new Recorded from / to filter (day the lift record was created). "Download Excel (these results)" now gives the same workbook as the Excel backup (QMS Lifts with AVR model, QMS Components, QMS Serial numbers, QMS Output Tables). Download Excel on one lift is still the single print-ready sheet.
- **Hardware Catalogue:** AVR 15, 20, 30, 40, 60 and 100 KVA filled from "AVR Specification" (15 rows each). Other AVR sizes (for example 80 KVA) stay blank.
- Run UPDATE_V267.sql (needs V266), redeploy Edge Function `wlf-maintenance` (single index.ts), upload to GitHub.

## v2.6.6 Admin Panel redesign with curves on every dashboard; QMS Special note (23 Nov 2026)
- **Admin Panel:** the filter card has a Dashboard dropdown (R&I team activity, R&I Project Manager, Technical Support, Damage Demand, Supplier claim, QMS, Performance curves) and an R&I user dropdown (All R&I users to compare, or one user), plus From / To, Apply, Download Excel and Full screen. One dashboard is shown at a time. Per-user view shows that user's table and curve with the team average as a dashed line.
- **Curves** on every dashboard with a "Show" metric dropdown and a Range dropdown (1 / 3 / 6 / 12 months: daily / weekly / monthly / monthly; last point labelled "(to date)"), Together or One by one layout, hover / touch tooltip. Choosing 1 month switches to One by one.
- **QMS Special note** is now its own input "7 · Special note" and its own output "8 · SPECIAL NOTE" (optional, max 500 characters), no longer part of Paid feature. It is in the Excel report, flat sheet, QMS Lifts sheet and all backups. Existing notes entered in v2.6.5 become the Special note.
- Run UPDATE_V266.sql (needs V265), redeploy Edge Function `wlf-maintenance` (single index.ts), upload to GitHub.

## v2.6.5 QMS Paid feature information (23 Nov 2026)
- QMS Input has a new section "6 · Paid feature information". The chips follow the lift's control system (MOT or NICE3000+); data comes from the Hardware Catalogue model "Paid feature" (seeded from QMS_Paid_feature_information_input_output.xlsx, editable by the Super Admin).
- Choosing a chip outputs all rows of that category in new table "7 · Paid feature information". A category with several kW options (NICE3000+ Regenerative drive) asks for one kW.
- Optional special note (max 500 characters) is shown under table 7.
- Other components: "Select all" and "Clear all" buttons beside the one-by-one ticks.
- Table 7 and the note are in the lift Excel report, the flat QMS sheet, the QMS Lifts / Components sheets, the QMS JSON backup, the Excel backup and the full backup/restore.
- Run UPDATE_V265.sql, then redeploy the Edge Function `wlf-maintenance` (single index.ts), then upload to GitHub.

## v2.6.4 Admin Panel, one Backup card, QMS Excel in one sheet (23 Nov 2026)
- **Admin Panel** (the old "Dashboard" menu): wide layout with a Full screen button. At the top, one card per approved R&I user: activity by sector (Team Activity, SCM & Supplier communication, Sales Support, Reports) as Completed / Ongoing / Incomplete with the time invested, Technical Support received / solved / not solved / forwarded, Damage Demands and Supplier Claims raised, and a 12-month performance curve. The "Who handled them" table is gone from Technical Support. Who sees it is set per user in User Management (permission "Admin Panel").
- **Backup** (Storage & Backup): one card. Work data (Technical Support, R&I Team Activity, R&I Project Manager, QMS data, Damage Demand, Supplier Claim) with period and optional Clear; below it the settings and reference data backup (never cleared). The older Technical Support file backup is kept in a collapsed section.
- **QMS Excel:** Download Excel on a lift gives ONE print-ready sheet (A4 landscape) with all six output tables in screen order. The Excel backup of QMS data and "Download Excel (these results)" get a flat sheet "QMS Output Tables" (one row per table row, lift columns first) for Filter / Pivot with many projects.
- SQL: UPDATE_V264.sql (needs V263). Edge Function wlf-maintenance: replace with the new single file.

## v2.6.3 (22 Nov 2026)
- **Activity log (wlf_usage):** rows older than 7 days are saved as Excel to the Drive folder `WLF Activity backup — <project>`, verified, then deleted (runs from the Super Admin session, checked every 6 hours). Safety net: rows older than 30 days are deleted even without an archive. Manual download and delete tools stay.
- **Backup (new card):** users/access, settings, support forms, R&I categories, Troubleshooting, Components Data, Documents Links, Hardware Catalogue and announcements in one JSON file (`WLF-FULL-2.6.3`), saved and verified in `WLF Full Backup — <project>`; restore only adds missing rows, users are never restored. "Support data backup" is now "Technical Support backup (restorable parts)".
- **Calculations:** saving, Records/Outbox and CSV removed; only Print / Save as PDF. `saveEngineeringRecord` is refused by the server. Existing `wlf_records` rows are kept.
- **Removed:** My activity table (My Profile), R&I Team Activity / R&I Project Manager cards and Troubleshooting overview (Dashboard), five columns of the R&I Team Activity Excel.
- Needs `UPDATE_V263.sql` (after V262) and a single-file redeploy of the Edge Function `wlf-maintenance`.

## v2.6.2 Excel backup for R&I Project, QMS, Damage Demand and Supplier Claim; backup history delete; QMS lifts in the Recycle bin; Documents Links permission (21 November 2026)

- **Storage & Backup > Excel backup** now has six modules: Technical Support, R&I Team Activity, **R&I Project, QMS data, Damage Demand, Supplier Claim**. Each can be run as *Backup without Clear* (nothing removed) or *Backup with Clear*. Both save a verified copy on Google Drive and download the file to the PC. Clear removes a record only after the Excel file **and** a recovery file are saved and read back from Drive, and only if the record was not changed after the backup (fingerprint check). Eligible for Clear: Done projects, every QMS lift in the period, Received demands (and, when sent to the supplier, with the goods Received), Received supplier claims. *Restore recovery copy* puts cleared records back (QMS lifts are re-packed into the shared snapshot rows, demands keep their demand number).
- **Backup history can be deleted** (one entry or all, typed `DELETE`) for the Excel backups and for the Support data backup. Only the list entry is removed; files in Google Drive are never touched.
- **QMS:** a deleted lift goes to the **Recycle bin** (new type "QMS lift record"). *Restore* brings it back with all parts; *Delete permanently* removes it from the database and cleans shared snapshot rows nobody uses. Lifts deleted before this update are listed in the bin by the migration.
- **Documents Links:** new option *Documents Links / Open documents* in User Management. The migration gives it to every approved user who could open Documents Links before, so nothing changes until the Super Admin switches it off for someone. Add, edit and delete of documents, folders and sub menus stay Super Admin only (also enforced in the database).
- **Edge Function `wlf-maintenance` must be redeployed** (new modules). It can be pasted as ONE file: `supabase/functions/wlf-maintenance/index.single.ts` is generated by `node scripts/bundle-maintenance.mjs <file>`; the package contains it ready to paste. The three Google Drive secrets stay as they are.
- Run `supabase/UPDATE_V262.sql` after `UPDATE_V261.sql`. See `START_HERE_V262_BN.html`.

## v2.6.1 Phone fixes, shared QMS data, Storage & Backup for QMS and Hardware Catalogue (20 November 2026)

- QMS Input and QMS Data fit a phone screen; wide tables scroll sideways inside their own box. The 1 / 2 marks on the QMS buttons are removed. The phone Back button steps back through the pages instead of closing the app.
- **QMS lift records no longer hold a private copy of every part.** Each distinct catalogue row (as it was on the day a lift was saved) is stored once in `wlf_private.hw_snap`; a lift keeps short references. A lift still shows the data of its save day; a changed catalogue only affects lifts saved or edited later. Existing lifts are converted by `UPDATE_V261.sql`.
- **Storage & Backup** (Super Admin): "Database use by option", download backup files of the Hardware Catalogue and of the QMS lift records, and restore from such a file (adds missing rows only, never deletes). Components Data keeps its CSV download/import. These backups are files on your computer; they are not sent to Google Drive and need no Edge Function change.
- Run `supabase/UPDATE_V261.sql` after v2.6.0. See `START_HERE_V261_BN.html`.

## v2.6.0 Motor-first QMS, Controller Model on Support forms, Components CSV import (20 November 2026)

- **QMS input** order: Project information, Motor selection (same inputs as Component Selection), Control system and serial numbers, LOP/COP/Transom/cable, Other components. After a motor is chosen two controllers (MOT and NICE3000+) and an AVR are suggested from Component data; one click fills the controller model and AVR. SDB main breaker rating is stored in Other components. Control system and Controller model can still be chosen by hand; the long hardware table is not opened (only the Encoder Card is picked). Every serial number is required and shows as a separate SERIAL NUMBERS table. Output tables show Price (BDT). MOTCUBE is not a QMS controller.
- **Hardware Catalogue** order: controller models (small to big), COP, LOP, Transom, COP Faceplate, AVR, Other components. COP Faceplate models: Hairline, Silver Mirror, Golden Mirror, Black Mirror, Black Hairline, Rose Gold Mirror. Blank MOTCUBE 5.5 / 7.5 / 11 kW tables added. "Value" is now labelled Price (BDT).
- **Support forms**: choosing a Controller Brand now requires a Controller Model (MOT 6, NICE3000+ 7, MOTCUBE 3). Damage Demand starts from that model. Old requests keep an empty model.
- **Component Selection** tables show units in the parameter names: Controller Power (kW), Controller Current (A), UPS (VA), ARD (A) and so on.
- **Components Data**: Download CSV, Import CSV (replaces all rows, Super Admin only, preview before replacing). Sample file `Components-Data-SAMPLE-FORMAT.csv`.
- The red dot on the three-dot menu is removed.
- Run `supabase/UPDATE_V260.sql` after v2.5.9. See `START_HERE_V260_BN.html`.

## v2.5.9 Hardware Catalogue, QMS lift records, catalogue-driven Damage Demand (20 November 2026)

- **Hardware Catalogue** (new page, Super Admin or the tick "Hardware Catalogue / Add, edit, delete, import"): one database for QMS and Damage Demand. Filled once from the controller-wise workbook: MOT (6 models), NICE3000+ (7 models), LOP, COP, Transom, Other components, plus **AVR** with 8 sizes (15, 20, 30, 40, 60, 80, 100, 120 KVA) and 10 blank rows each. Add / edit / delete rows, add / rename / delete a model, copy a model, export Excel, import CSV, and edit the "Problem suggestions" (problem word -> hardware groups). Table `wlf_private.hw_catalogue`, soft delete.
- **Raise Damage Demand**: Component model and Supplier name first; the item code, name and spec come from the catalogue; parts are suggested from the request's Problem Category. One demand still holds one item (one demand per request, as before). "Not in the catalogue" allows typing. The server rejects a typed item unless that box was ticked. Damage Demand and Supplier Claim flows are unchanged.
- **QMS** is now one record per lift before delivery (`wlf_private.qms_lifts`, Lift ID unique, case and spaces ignored). Input form: project information, control system and serial numbers, motor (same inputs as Component Selection), LOP/COP/Transom/Travelling cable, other components with AVR. QMS Data: search by Lift ID, project or item code; five tables; Excel download (single lift or all results). Saved records keep a copy of code/name/spec/brand/value. New ticks: "QMS / Edit saved lift records", "QMS / Delete saved lift records". Changes are written to a history list.
- The old "Component Tracking" register is no longer shown; its rows stay in the database. The Management Dashboard QMS card counts lift records.
- Excel corrections: four NICE3000+ rows labelled "11 kW" at rows 196-199 are the 45 kW encoder cards; imported as 45 kW.
- Run `supabase/UPDATE_V259.sql` after v2.5.8. See `START_HERE_V259_BN.html`.

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
