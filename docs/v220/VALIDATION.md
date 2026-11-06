# WLF v2.2.0 verification

- v2.1 baseline, V220 migration, verification query and optional form-template script checked in local PostgreSQL through PGlite. Rerunning the upgrade retained the saved custom form and component edits.
- npm test passed 51 tests. Coverage includes historic support, all six new-form submissions, unique references and safe retry, identity, both filters, configurable fields, R&I permissions and ownership, Excel period boundaries, binary Drive verification using a mock, Clear and restoration.
- The production app build loaded in Chromium against an isolated database. Verified FULL NAME-ID, six support teams, Controller and Sub Category filters, Checkbox in the editor, three report forms, a persisted Solved activity, a saved project and task with a Gantt chart, and both JSON and Excel backup controls.
- Opened the generated six-sheet support workbook with openpyxl. Each worksheet contains an Excel table. Formula-looking input was stored as text.
- Opened a generated PowerPoint with python-pptx and verified the task slide.
- The maintenance function bundles with esbuild when Supabase npm imports are external. A local Chromium restriction prevented running the full Playwright suite here. The targeted browser check used a test identity and mocked connections.
- Deploy and verify on the actual Supabase project, GitHub Pages URL and Google Drive OAuth connection using START_HERE_BN.html. The release contains source, built assets and tests.
