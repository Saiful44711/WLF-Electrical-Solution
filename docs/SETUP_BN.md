# WLF Electrical Solution 2.0.0 — Supabase + GitHub PWA

আপনার জন্য সম্পূর্ণ নতুন backend package। Google Apps Script বা Google Sheet লাগবে না। একই link দিয়ে PC ও Android ব্যবহার করা যাবে। Android Chrome থেকে Install app করা যাবে; এই package-এ আলাদা native APK নেই। পুরোনো v1.5.x APK নতুন Supabase-এ নিজে থেকে connect করবে না। পুরোনো software/backup মুছবেন না।

## শুরু করার আগে

- একটি নতুন Supabase project ও নতুন GitHub repository ব্যবহার করুন। অন্য app-এর Supabase project-এ SQL চালাবেন না।
- পুরোনো user/password/support history import করা হয়নি, আপনার নির্দেশ অনুযায়ী fresh start।
- নিজের Supabase/GitHub login, database password নিজের কাছে রাখবেন। এখানে বা GitHub code-এ password/secret key দেবেন না।
- Package পরীক্ষা করা হয়েছে; আপনার actual Supabase account-এ এখনো deploy করা হয়নি। প্রথমে test account দিয়ে নিচের acceptance test করুন।

## ১ — Supabase account ও project

1. https://supabase.com/dashboard খুলে Sign up / Sign in করুন। GitHub দিয়ে sign in করলেও চলবে।
2. প্রয়োজন হলে একটি Organization তৈরি করুন, Free plan নির্বাচন করুন।
3. New project নির্বাচন করুন। Project name দিন `wlf-electrical-solution`।
4. একটি শক্ত Database password দিন এবং private জায়গায় সংরক্ষণ করুন। এটি app login password নয়।
5. Bangladesh-এর কাছাকাছি উপলব্ধ region বেছে নিন, যেমন Singapore। আপনার project-এ যে region দেখায় সেটিই ব্যবহার করবেন।
6. Create project দিয়ে provisioning শেষ হওয়া পর্যন্ত অপেক্ষা করুন।

## ২ — Database একবার তৈরি করুন

1. Project-এর বাম menu → SQL Editor → New query।
2. Package-এর `source/supabase/01_SETUP.sql` Notepad/VS Code দিয়ে খুলুন। সম্পূর্ণ text copy করে SQL Editor-এ paste করুন। Run চাপুন।
3. এটি tables, permission/RLS, API functions, realtime publication এবং initial data তৈরি করবে। Expected: 77 component records, 167 controller error entries, 6টি controller submenu এবং দুই support form। General Solution শুরুতে empty; Super Admin subcategory যোগ করবেন।
4. এই file নতুন project-এর জন্য। একই project-এ পুরো setup বারবার চালাবেন না। `already exists` এলে থামুন; tables delete/reset করে data হারাবেন না। Partial setup error হলে error text সংরক্ষণ করুন; `schema.sql`, `api.sql`, `seed.sql` পৃথক অংশ হিসেবে আছে।
5. `source/supabase/03_VERIFY_SETUP.sql` নতুন query-তে Run করুন। সব 10টি wlf table-এ RLS true; authenticated-এর direct table grant SELECT; anon-এর data access থাকবে না।
6. Realtime/Database → Publications-এ `supabase_realtime` খুলে `wlf_requests`, `wlf_profiles`, `wlf_components`, `wlf_troubleshooting`, `wlf_forms` enabled আছে কি দেখুন। Setup script এগুলো যোগ করে। Dashboard-এর label বদলালে Search ব্যবহার করুন।
7. Data API settings-এ public schema exposed রাখুন। `wlf_private` expose করবেন না। Default Supabase Auth, public API এবং RLS বন্ধ করবেন না।

## ৩ — প্রথম Super Admin তৈরি করুন

এটি শুধু প্রথম account-এর জন্য; পরে app-এর User Management ব্যবহার করবেন।

1. Supabase → Authentication → Users → Add user / Create new user। নিজের email ও একটি শক্ত password দিন। প্রথম owner account-এর জন্য Auto confirm user option থাকলে চালু করুন; invitation email পাঠানোর প্রয়োজন নেই।
2. Trigger নিজে থেকে `wlf_profiles`-এ Pending User তৈরি করবে।
3. `source/supabase/02_FIRST_SUPER_ADMIN.sql` খুলুন। `REPLACE_WITH_YOUR_EMAIL`-এর জায়গায় ঠিক সেই email লিখুন, অন্য SQL অপরিবর্তিত রাখুন।
4. SQL Editor → New query → paste → Run। Account এখন Approved Super Admin হবে।
5. Supabase dashboard-এর login এবং এই app-এর email/password আলাদা account। App-এ ধাপ ১-এর dashboard password নয়, ধাপ ৩-এর app password দেবেন।
6. বিকল্প: website deploy হওয়ার পরে app-এর Request access দিয়ে account তৈরি করে একই SQL চালাতে পারেন। আগে account তৈরি না হলে Account not found আসবে।

## ৪ — Login/registration settings

1. Authentication settings-এর Email provider enabled রাখুন। Allow new users to sign up চালু থাকলে app-এর Request access কাজ করবে।
2. ছোট internal pilot-এ SMTP প্রস্তুত না থাকলে Confirm email বন্ধ রাখা যায়। তবুও নতুন app user Pending থাকবেন; Super Admin যাচাই করে approve না করা পর্যন্ত কোনো business data পাবেন না। Email ownership নিজে যাচাই করে access দিন।
3. Confirm email চালু রাখলে signup email confirm করার পাশাপাশি Super Admin approval-ও লাগবে। Real users-এর email delivery-এর জন্য নিজের SMTP ও provider limits ঠিক করতে হবে; built-in mail service-এর ওপর production delivery নির্ভর করবেন না।
4. App website link পাওয়ার পরে Authentication → URL Configuration-এ Site URL ও allowed Redirect URL-এ repository-সহ সম্পূর্ণ link দিন, যেমন `https://YOUR_USERNAME.github.io/wlf-electrical/`।
5. New registration-এর Pending badge Super Admin-এর app-এ realtime/refresh-এ দেখা যায়। পুরোনো Apps Script MailApp-এর admin email notification এখানে automatic নয়; এই version-এর approval notification in-app।

## ৫ — Supabase URL ও PUBLIC key বসান

1. Supabase project-এর Connect dialog বা Settings/Data API-তে Project URL খুঁজুন: `https://PROJECT_REF.supabase.co`।
2. Settings → API Keys → Publishable key copy করুন। এটি `sb_publishable_` দিয়ে শুরু হয়। এই package নতুন publishable key ব্যবহার করে, legacy anon key নয়।
3. `source/web/config.js` খুলে দুই placeholder বদলান:

```js
window.WLF_CONFIG={
  supabaseUrl:'https://YOUR_REAL_PROJECT_REF.supabase.co',
  supabasePublishableKey:'sb_publishable_YOUR_REAL_PUBLIC_KEY',
  offlineHours:24
};
```

4. URL-এর শেষে slash দেবেন না। Quote/comma ঠিক রেখে save করুন। `offlineHours` সর্বোচ্চ 24।
5. এই public URL/key GitHub-এ থাকা স্বাভাবিক। Access database RLS ও verified user identity নিয়ন্ত্রণ করে। `sb_secret_`, `service_role`, database password, JWT secret, ব্যক্তিগত access token কখনো এখানে বসাবেন না।
6. শুধু `source/web/config.js` edit করুন। GitHub Actions নতুন `dist` তৈরি করবে। Manual hosting করলে নিচের Local build নির্দেশনা অনুযায়ী rebuild করতে হবে।

## ৬ — GitHub repository ও PC website

1. https://github.com → New repository। নাম দিন `wlf-electrical`। Free GitHub Pages ব্যবহারের সহজ পথ Public repository। Source/reference data public থাকবে; user/password/support database public হবে না। Component/manual source-ও private রাখতে চাইলে public repository ব্যবহার করার আগে আপনার company policy অনুযায়ী hosting বেছে নিন।
2. ZIP extract করুন। `source` folder-এর ভেতরের contents repository root-এ upload করুন। বাইরের package folder বা শুধু `dist` upload নয়।
3. Root-এ `package.json`, `package-lock.json`, `web`, `shared`, `scripts`, `tests`, `supabase`, `data`, `.github/workflows/pages.yml`, `.gitignore` থাকতে হবে।
4. Windows Explorer → View → Hidden items চালু করুন। Browser upload `.github` folder বাদ দিলে GitHub → Add file → Create new file → নাম `.github/workflows/pages.yml` দিন এবং package-এর exact file content paste করে commit করুন। অন্য কোনো পুরোনো Android workflow রাখবেন না।
5. Branch `main` রাখুন। Repository → Settings → Pages → Source = GitHub Actions নির্বাচন করুন।
6. Actions → Deploy WLF PWA to GitHub Pages → Run workflow। প্রথমবার automatic run fail হলে Pages setting ঠিক করে আবার Run করুন।
7. Build public configuration check, unit/database/edge tests ও browser tests চালাবে; তারপর deploy হবে। Green হওয়ার আগে failed test skip করবেন না।
8. Successful deployment → Settings → Pages → Visit site। Link হবে `https://YOUR_USERNAME.github.io/wlf-electrical/`। এটি উদাহরণ; আপনার actual username/repository অনুযায়ী link পাবেন।
9. PC Chrome/Edge-এ link খুলে প্রথম Super Admin email/password দিয়ে login করুন। `Live data synchronized` ও তিন-dot menu-র ভিতরে `Realtime connected` দেখুন।
10. Source পরে edit/commit করলে Actions আবার build/deploy করবে। Supabase database data code deploy-এর কারণে reset হবে না।

## ৭ — Password reset function deploy করুন

Core login, support ও calculation-এর জন্য আলাদা Edge Function round trip নেই। User Management-এর Reset password কাজটির জন্য নিচের function প্রয়োজন।

সহজ Dashboard পদ্ধতি:

1. Supabase → Edge Functions → Deploy a new function → Via Editor।
2. Function name ঠিক `wlf-admin` দিন।
3. Default code মুছে `source/supabase/functions/wlf-admin/index.ts`-এর সম্পূর্ণ code paste করুন। Deploy করুন।
4. Function-এর JWT verification setting-এ gateway-এর `Verify JWT` বন্ধ রাখুন, এই function-এর জন্য। Function নিজেই প্রতিবার `auth.getUser(token)` দিয়ে user verify করে এবং database থেকে বর্তমান Approved Super Admin role পরীক্ষা করে। JWT verification বন্ধ মানে handler authentication বন্ধ নয়।
5. `SUPABASE_URL` ও `SUPABASE_SECRET_KEYS` hosted function-এর server environment-এ Supabase সরবরাহ করে। Function নতুন secret-key dictionary ব্যবহার করে; প্রয়োজনে legacy `SUPABASE_SERVICE_ROLE_KEY` fallback আছে। এগুলো web/config.js-এ copy করবেন না। Default secret অনুপস্থিত/disabled হলে project settings ও function logs দেখে ঠিক করুন।
6. Test User account দিয়ে app-এ SA → User Management → Reset password দিন। নতুন temporary password শুধু SA-এর screen-এ আসবে; নিরাপদে সংশ্লিষ্ট ব্যক্তিকে দিন। এই কাজ নিজে থেকে email পাঠায় না।
7. Ordinary User, R&I বা Admin-এর reset access নেই। নতুন password দিয়ে login পরীক্ষা করুন।

CLI বিকল্প — Node.js 22+ install করে source folder-এ terminal খুলুন:

```sh
npm ci
npx supabase login
npx supabase functions deploy wlf-admin --project-ref YOUR_PROJECT_REF --use-api --no-verify-jwt
```

`YOUR_PROJECT_REF` শুধু project ID, পুরো URL নয়। CLI login/token terminal-এ নিজের কাছে রাখবেন। Docker ছাড়া `--use-api` server-side bundle ব্যবহার করে। Function update হলেও core app data reset নয়।

## ৮ — Normal User, R&I ও Admin access

1. প্রত্যেকে website → Request access → name/email/password দিয়ে register করবেন।
2. Super Admin → User Management → ওই account expand করুন।
3. Normal user: Role `User`, Status `Approved`, প্রয়োজনীয় option checkbox tick করে Save role & access।
4. R&I: Role `R&I`, Approved। সব business option read করতে পারবেন; শুধু R&I pending task receive ও assigned task solve/forward/not solved/pending করতে পারবেন।
5. Admin: Role `Admin`, Approved। সব support record, dashboard ও report read/download; নতুন request, task processing, CRUD বা User Management নেই।
6. Super Admin: Role `Super Admin`, Approved। Data/form fields/access add/edit/delete, request তৈরি ও reports। Support processing-এর assigned R&I workflow আলাদা রাখা হয়েছে।
7. User Management menu/API কেবল Super Admin। Admin/R&I/User সরাসরি API call করলেও full user list/access change পাবেন না।
8. Role/status/grant change server-এ পরের action থেকেই কার্যকর। Online client realtime/backup refresh-এ menu পরিবর্তন ধরবে; নিরাপদে re-login করতে বলা হতে পারে। Offline cached reference সঙ্গে সঙ্গে remote revoke করা যায় না; সর্বোচ্চ 24-hour offline window।

## ৯ — Technical Support ব্যবহার

- My Account → Component Selection → Calculations → Troubleshooting → Technical Support; বাকি administration options role অনুযায়ী নিচে।
- Technical Support-এর দুই category আগের মতো Commissioning ও After Sales। Normal User নিজের granted form submit ও নিজের request-এর status দেখবেন; submitted data edit/delete নয়।
- R&I request খুলে Receive → solution লিখে Solved; সমাধান না হলে comment দিয়ে অন্য approved R&I-কে Forward; assigned R&I Receive করে Pending / Not Solved / Solved রাখতে পারবেন।
- Badge সব unsolved record গুনবে: Pending, Received, Forwarded, Not Solved। শুধু Solved হলে কমবে; SA soft-delete করলে removed record গণনা থেকে বাদ যায়। User badge নিজের accessible requests; team roles-এর সব accessible requests।
- Realtime online অবস্থায় event পেলেই list/counter update করে; 60-second fallback ও foreground/online resync আছে। Background/closed-app push notification এই version-এ নেই।
- Original form questions রাখা হয়েছে। আলাদা `Submitted date` field যোগ হয়েছে; Bangladesh-এর আজকের date default। Original Date / Date of Incident-এর সঙ্গে এটি আলাদা।
- Visible ID: `TCS-LIFTID-YYYYMMDD` / `TAS-LIFTID-YYYYMMDD`, form-এর Lift ID ও Submitted date থেকে। Example `TCS-WLF123-20261017`।
- একই Lift/date-এ একাধিক request হলে visible ID একই হতে পারে। Database-এর immutable UUID আলাদা; request/history কখনো merge হয় না।
- Team/status/assignee/engineer/date/search filter দিয়ে CSV, R&I performance report, Print / Save PDF পাওয়া যাবে। Request list 25/page; export cap 5000 records, বড় হলে date filter ছোট করুন।

## ১০ — Search, calculation ও offline

- Component dropdown ও report-এর downloaded snapshot থেকে local selection; প্রতিবার click-এ server call লাগে না। SA component update করলে online clients realtime event-এর পরে নতুন snapshot নেয়।
- MOT/NICE error data first open-এ download হয়। এরপর error/subcode search browser-এর ভিতরে চলে। NICE-এ শুধু error code দিলে সব subcode; optional subcode দিলে সংশ্লিষ্ট solution।
- Six calculation formula আগের v1.5.1-এর মতো। Total Power-এর suggested generator formula পরিবর্তন করা হয়নি। Company logo transparent রাখা হয়েছে।
- একবার online login করে Component Selection ও Troubleshooting খুলুন। এরপর downloaded reference ও local calculations offline চলে, configured window-এর ভিতরে। প্রথম-ever login/registration, support submit/status/forward/report ও permission changes-এ internet লাগবে।
- SA calculation record ও troubleshooting edit offline outbox-এ রাখতে পারেন; reconnect-এ sync। Conflict হলে latest data দেখে সমাধান করতে হবে। Support request mutation offline queue করা হয়নি; live submit confirm হওয়ার আগে submitted ধরে নেবেন না।
- Logout বা browser/app data clear করলে local reference/cache হারাতে পারে। Unsynced কাজ আগে sync/export করুন। অন্য user-এর account দিয়ে offline reference access অনুমোদিত নয়।

## ১১ — Android-এ app install

1. Android Chrome-এ actual HTTPS website link খুলুন।
2. Chrome ⋮ → Install app / Add to Home screen নির্বাচন করুন। Supported Chrome/device-এ app হিসেবে install হবে; menu label device অনুযায়ী বদলাতে পারে। App-এর three-dot menu-তেও browser install prompt পাওয়া গেলে Install app দেখাবে।
3. নাম হবে WLF Electrical Solution; home-screen icon থেকে খুলে login করুন।
4. PC Chrome/Edge-এও browser install option থাকলে app হিসেবে install করা যাবে। শুধু browser link দিয়েও সব কাজ হবে।
5. আলাদা APK file বানানো/পাঠানো বা signing key নিয়ে এই PWA installation-এ কাজ করতে হবে না। এটি আগের native APK-এর in-place update নয়; আলাদা web app installation।
6. Software update পেলে three-dot menu-তে Update available → draft save করে reload করুন। App shell versioned cache ব্যবহার করে; প্রথম installation নিজে থেকে login page reload করে না। Config/asset update-এ next release-এর cache version বাড়াতে হবে।
7. Chrome/Android-এর API সমর্থনের পার্থক্য থাকতে পারে। Closed app push, Bluetooth/USB device integration বা Play Store publishing এই package-এর scope নয়।

## ১২ — চালু করার আগে ৪-role test

1. Super Admin ছাড়াও User A, User B, R&I A, R&I B, Admin—পৃথক test account তৈরি/approve করুন।
2. User A request submit → R&I A-তে open counter বাড়ে কি দেখুন। User B ওই request দেখতে পারবেন না।
3. R&I A Receive → badge থাকবে। Comment দিয়ে R&I B-তে Forward → badge থাকবে। B Receive/Not Solved/Pending → badge থাকবে। B final Solved → badge কমবে।
4. Admin নতুন request/Receive/Edit/Delete/User Management দেখবেন না; report ও R&I solved count ঠিক থাকবে।
5. Super Admin form field যোগ/পরিবর্তন, troubleshooting option add/delete, component edit, user approval test করুন। পুরোনো request তার form snapshot ধরে রাখবে।
6. দুই PC/phone-এ একইসঙ্গে খোলা রেখে realtime list/count update দেখুন। Solution লিখতে থাকা অবস্থায় অন্য event এলে draft থাকে কি পরীক্ষা করুন।
7. পরিচিত calculation ও component report-এর সঙ্গে আগের result মিলিয়ে নিন। তারপর airplane mode-এ downloaded reference/calculation এবং online ফিরে sync পরীক্ষা করুন।
8. সামান্য user দিয়ে actual login/submit/receive latency মাপুন। এখানে কোনো real Supabase/Google production load test বা নির্দিষ্ট concurrent user capacity certify করা হয়নি।

## ১৩ — সমস্যা হলে

| যা দেখবেন | কী পরীক্ষা করবেন |
|---|---|
| Setup incomplete / GitHub config check fail | `source/web/config.js`-এর real project URL ও `sb_publishable_` key; rebuild/deploy |
| Invalid login credentials | App account/email/password; Supabase dashboard login আলাদা; email confirmed কি না |
| Account pending/inactive | Super Admin approval অথবা প্রথম account-এর 02 SQL step |
| wlf_rpc not found | 01_SETUP.sql-এর API অংশ, public Data API schema; function creation error |
| Permission denied | role/status/option grant ঠিক করুন; RLS বন্ধ করে workaround করবেন না |
| Realtime reconnecting | project paused কি না; network/WebSocket, publication five tables; foreground করে refresh |
| Reset password failed | wlf-admin function name/code/deployment, gateway JWT setting, function logs, current SA status |
| Page 404 | Pages source GitHub Actions, workflow green, repo name/subpath ও site URL |
| Old screen after update | three-dot Update available; cache version bumped কি না; unsynced কাজ বাঁচিয়ে পরে browser site cache পরিষ্কার |
| Install app নেই | HTTPS, manifest, Android Chrome সমর্থন, আগে install হয়েছে কি না; browser link দিয়ে ব্যবহার চালানো যাবে |
| CSV/PDF blank / popup blocked | CSV download permission; Print-এর popup allow; browser Print → Save PDF |

## ১৪ — Backup, free limits ও future changes

- GitHub source/ZIP software backup। Supabase live database/Auth data backup আলাদা। Code rollback পুরোনো data ফিরিয়ে দেয় না।
- Full database dump-এর জন্য `docs/BACKUP_AND_RESTORE.md` দেখুন। শুধু filtered support CSV পূর্ণ backup নয়; UUID relationships, histories, profiles/Auth users, forms ও permissions লাগে।
- Free plan quota আছে: বর্তমান 500 MB DB, 50,000 monthly active Auth users, 200 peak realtime connections। এগুলো app capacity guarantee নয়। Realtime messages/egress limits-ও প্রযোজ্য; dashboard Usage দেখুন। Free project inactive হলে pause হতে পারে। Always-on/SLA/automatic backup দরকার হলে paid plan বিবেচনা করতে হবে।
- Real network/database response শূন্য হবে না। First login/download/report এখনও internet নির্ভর। Server region, data size, workload ও quota অনুযায়ী গতি বদলাবে।
- নতুন troubleshooting subcategory/controller procedure এবং support form fields SA app থেকেই add/edit/delete করতে পারবেন। User Management catalog dynamic procedure options পায়।
- সম্পূর্ণ নতুন module/calculator/support team-এর জন্য `docs/DEVELOPER_GUIDE.md` অনুযায়ী UI + permission + SQL + tests যোগ করতে হবে। এটি arbitrary নতুন tab no-code builder নয়।
- App UI update-এ GitHub deploy; SQL/API change-এ আলাদা reviewed migration; Edge Function change-এ redeploy। Production-এ 01 setup আবার চালাবেন না।

## ১৫ — Local preview / developer test

Node.js 22+ install করুন। `source` folder-এর address bar-এ `powershell` লিখে Enter দিন:

```sh
npm ci
npm run build
npm test
npx playwright install chromium
npm run test:e2e
npm run preview
```

শেষ command চললে `http://localhost:4173` খুলুন। Actual Supabase URL/key configure না করলে UI Setup required দেখাবে। Preview server বন্ধ করতে Ctrl+C। `dist/index.html` double-click করে file:// থেকে login/install পরীক্ষা করবেন না।

এই build-এ local PostgreSQL/PGlite RLS/RPC tests ও browser tests পাস হয়েছে। Auth REST এবং realtime event delivery test harness-এ simulated; Supabase hosted project, real email/password-reset integration, GitHub deployment ও physical Android device test আপনার account setup-এর পরে করতে হবে।

## Official help

- Supabase: https://supabase.com/dashboard
- Public API keys: https://supabase.com/docs/guides/getting-started/api-keys
- Auth password login: https://supabase.com/docs/reference/javascript/auth-signinwithpassword
- RLS: https://supabase.com/docs/guides/database/postgres/row-level-security
- Realtime setup: https://supabase.com/docs/guides/realtime/postgres-changes
- Dashboard Edge Function: https://supabase.com/docs/guides/functions/quickstart-dashboard
- Function environment: https://supabase.com/docs/guides/functions/secrets
- Backup: https://supabase.com/docs/guides/platform/backups
- Current free plan: https://supabase.com/pricing
- GitHub Pages setup: https://docs.github.com/en/pages/getting-started-with-github-pages/configuring-a-publishing-source-for-your-github-pages-site
- PWA install: https://web.dev/learn/pwa/installation
