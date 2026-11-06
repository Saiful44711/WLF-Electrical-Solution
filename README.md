# WLF Electrical Solution v2.2.0

Production upgrade for the existing WLF v2.1 Supabase project and GitHub Pages PWA.
Open START_HERE_BN.html in the release ZIP for the rollout guide.

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
