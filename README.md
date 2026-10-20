# WLF Electrical Solution — v2.1.0 update

Existing project: read `docs/v210/UPDATE_GUIDE_BN.html` first. Run only
`supabase/UPDATE_V210.sql`, deploy the new `wlf-maintenance` function, configure
Google Drive server secrets, then upload the frontend update. Never rerun the
initial setup/seed against the live project.

This update adds server-checked support archives/clear/restore, document links,
role-specific usage dashboards and user search. It preserves existing
engineering formulas, imported component records, troubleshooting editors and
support workflow. Support archives are **not** full Auth/schema/project backups.

The original baseline instructions below describe initial installation; new
projects require the v2.1 update after initial setup.

---

# WLF Electrical Solution 2.0.0

Supabase + GitHub Pages + installable PWA. Open the outer package's **START_HERE.html** for the complete Bengali beginner guide; its text is also in docs/SETUP_BN.md.

This is a fresh backend, not an in-place APK update. No Google Apps Script/Sheet is required. No old users, passwords or support history are migrated. Initial data includes 77 user-supplied component records, 167 MOT/NICE error entries, six controller menu options and two original support forms with a dedicated Submitted date field.

1. Create a NEW Supabase project.
2. Run supabase/01_SETUP.sql once in SQL Editor.
3. Create first app account in Supabase Auth, then edit/run 02_FIRST_SUPER_ADMIN.sql with its email.
4. Set web/config.js to the real project URL + sb_publishable_ key (never a private key).
5. Upload this folder's contents to a new GitHub repository root, including .github/workflows/pages.yml.
6. Settings → Pages → GitHub Actions; run Deploy WLF PWA to GitHub Pages.
7. Deploy supabase/functions/wlf-admin/index.ts as wlf-admin for Super Admin password resets; read the guide's JWT verification instructions.
8. Validate all roles/workflows on real devices before launch. Android Chrome → Install app.

```
npm ci
npm run build
npm test
npx playwright install chromium
npm run test:e2e
npm run preview
```

Local tools require Node22+. SQL tests run real PostgreSQL in PGlite; Auth, websocket delivery and Edge Auth/admin calls are mocked. No hosted-project provisioning, GitHub push/deployment, physical-device test or capacity certification is claimed. Public config is intentionally placeholder until the owner supplies their project details. Offline calculations/downloaded references work within24h of verification; online support operations remain online-only.

Core formula code and current design retained. All four role permissions enforced in SQL; User Management is Super Admin-only. Request IDs have separate immutable UUIDs and form-derived visible references. Realtime callback updates preserve active drafts;60s fallback reconciles missed events. No background push in this release.

See docs/DEVELOPER_GUIDE.md for extension/security/performance, docs/BACKUP_AND_RESTORE.md for private data backup and docs/FEATURE_PARITY.md for coverage and limits.
