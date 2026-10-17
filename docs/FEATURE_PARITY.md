# Feature coverage — v1.5.1 → 2.0.0

| Existing feature | Supabase/PWA version |
|---|---|
| Company logo/login/header/icon | Retained transparent company logo and lift-drive app icons; three-dot appearance menu left of logo |
| My Account | First navigation item; current approved identity; SA password-change UI retained |
| Component Selection | Original dropdown/report mapping,77 initial records, local filtering/details after download, print/PDF |
| Components Data | SA add/edit/delete; Admin/R&I read; normal User per selection grant |
| Travel time, Total Power, nominal speed/slip, motor power, energy bill, solar/battery | Same shared formulas and result names; generator formula unchanged; no suggested AVR in Total Power |
| AVR selection recommendation | Retained in component-selection report, as requested |
| MOT/NICE/General troubleshooting |167 imported error entries and6 controller submenu options; general subcategories can be added by SA |
| NICE code-only / code+subcode search | Local search; code-only returns all subcodes, optional subcode narrows solution |
| Future controller options/general procedure fields | SA add/edit/delete and multiple fields; dynamic permission catalog |
| Technical Support | Two form schemas retained; additional required Submitted date separates visible ID from incident date |
| Request reference | TCS/TAS + Lift ID + Submitted date; internal immutable UUID protects duplicates |
| User own request status | Only own accessible requests, no edit/delete/process; request creation User/SA only |
| R&I handling | Read all business options; receive, assigned solve/not solved/pending or forward to another approved R&I; no data CRUD |
| Admin reports | Full business read/dashboard/CSV/PDF/per-engineer performance; no request creation, workflow processing or User Management |
| Super Admin | Access/approval/config/data management, request creation, report; User Management visible/usable only here |
| Notification badge | Accessible unsolved requests, including Received/Forwarded/Not Solved; Solved reduces it; deleted excluded |
| Realtime | RLS-scoped Postgres Changes; list/count callback update, draft preserved;60s backup refresh |
| Usage dashboard | Original action topics/per-user totals from Supabase usage records |
| Calculation records/outbox | SA saves local validated records and syncs; owner-scoped remote retrieval/CSV |
| Offline troubleshooting edits | SA outbox retained; revisions/idempotent repeat and conflict messages |
| Dark/light and mobile | Retained responsive layout, corrected report/chip contrast, print uses its own palette |
| Browser/mobile installation | Same HTTPS link; installable PWA/WebAPK where browser supports; no separately signed native APK in this package |
| Update distribution | GitHub Pages frontend deploy + explicit cached-shell update; SQL/Edge updates separate |

## Deliberate differences / practical limits

- Fresh Supabase Auth accounts; old Apps Script hashes, users, logs and support data are not imported. Existing old APK does not switch backend automatically.
- Only original workbook's Components Selection data was extracted. If the working Sheet has later component edits, review/import a latest export before real launch.
- New user approval notification is in-app (SA pending badge). The former Apps Script MailApp admin email is not automatically sent. Auth confirmation email depends on SMTP/email settings; reset currently returns a temporary password to SA rather than emailing it.
- General Solution initially has no seeded general entry; this matches the retained baseline seed. Existing six controller submenu option records are preserved; their content can be maintained by SA.
- No closed-app push, SMS, native USB/Bluetooth or Play Store publishing. Future modules require code/SQL/permission/tests, not an arbitrary no-code tab builder.
- App installation and database latency are independent. Online login/support/report response depends on network, region, data volume and plan limits. No instant-response or unlimited-user guarantee.
- This package is configured by the owner before live use. All hosted Auth/Realtime/Edge/Pages acceptance checks remain necessary.
