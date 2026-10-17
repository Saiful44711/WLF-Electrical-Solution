import fs from'node:fs';import vm from'node:vm';const c={window:{}};vm.runInNewContext(fs.readFileSync('web/config.js','utf8'),c);const x=c.window.WLF_CONFIG;
if(!x||!/^https:\/\/[a-z0-9-]+\.supabase\.co$/.test(x.supabaseUrl)||x.supabaseUrl.includes('YOUR_')||!/^sb_publishable_/.test(x.supabasePublishableKey))throw Error('Set web/config.js Project URL and sb_publishable_ key before deploying. NEVER use sb_secret_/service_role.');
if(/sb_secret_|service_role/.test(x.supabasePublishableKey))throw Error('Private key forbidden');console.log('Public Supabase configuration format valid.');
