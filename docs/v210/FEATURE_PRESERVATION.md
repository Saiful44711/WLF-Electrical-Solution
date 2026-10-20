# Preserved production behavior

- The original six calculators and formulas, including generator selection.
- Company logo, app name, header, light/dark appearance and mobile layout.
- Component selection, detailed reports, printing and relevant offline cache.
- All original MOT and NICE3000+ error/subcode searches and procedure options.
- Super Admin troubleshooting add/edit/delete, multiple solution fields and
  procedure fields. An empty General Solution can now be entered by Super Admin
  to add the first subcategory; no sample instructions are inserted.
- Both technical support forms and their editable schema support.
- Original role rules for request creation, receiving, forwarding and solving.
- Notifications count all unsolved requests; only solving removes that count.
- Form-derived TCS/TAS references, filtering, reports and exports.
- User approvals, role/option assignments, password reset and own password change.
- Record synchronization and PWA updates/offline engineering references.

Intentional changes requested in this update:
Components Data administration is Super Admin-only; User has no Usage Dashboard;
R&I Usage Dashboard is restricted to self, Admin/Super Admin see all. User
Management remains Super Admin-only with search and guarded rejected deletion.
Only Super Admin can access Storage & Backup or edit Documents Links.
The R&I recipient directory and shared support coordination remain available for
forwarding tasks; dashboard privacy does not disable support handling.

This is an incremental real-code release. The interactive demo is not included
as the production application. Live database rows cannot be inspected here;
compare your own before/after counts during deployment.
