// Server only. No secret belongs in web/config.js or GitHub.
import {createClient} from 'npm:@supabase/supabase-js@2.118.0';
const headers={'Access-Control-Allow-Origin':'*','Access-Control-Allow-Headers':'authorization,x-client-info,apikey,content-type','Access-Control-Allow-Methods':'POST,OPTIONS','Content-Type':'application/json','Cache-Control':'no-store'};
const digest=async(text:string)=>Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',new TextEncoder().encode(text)))).map(x=>x.toString(16).padStart(2,'0')).join('');
Deno.serve(async(req)=>{
 if(req.method==='OPTIONS')return new Response('ok',{headers});
 let status=400;
 try{
 if(req.method!=='POST')throw Error('POST required');
 const url=Deno.env.get('SUPABASE_URL')!,keys=JSON.parse(Deno.env.get('SUPABASE_SECRET_KEYS')||'{}'),key=keys.default||Deno.env.get('SUPABASE_SERVICE_ROLE_KEY');
 if(!url||!key)throw Error('Server configuration missing');
 const admin=createClient(url,key,{auth:{persistSession:false,autoRefreshToken:false}});
 const token=(req.headers.get('Authorization')||'').replace(/^Bearer\s+/i,'');
 const {data:auth,error:authError}=await admin.auth.getUser(token);if(authError||!auth.user){status=401;throw Error('Sign in required');}
 const {data:me,error:meError}=await admin.from('wlf_profiles').select('id,role,status').eq('id',auth.user.id).single();
 if(meError||me?.role!=='Super Admin'||me?.status!=='Approved'){status=403;throw Error('Super Admin only');}
 if(Number(req.headers.get('content-length')||0)>12000000)throw Error('Request too large');
 const body=await req.json(),action=body.action,p=body.payload||{};
 const project=new URL(url).hostname.split('.')[0];
 async function sql(action:string,payload:any={}){const r=await admin.rpc('wlf_backup_admin',{action,actor:auth.user.id,payload});if(r.error)throw Error(r.error.message);return r.data;}
 const clientId=Deno.env.get('WLF_GOOGLE_CLIENT_ID'),clientSecret=Deno.env.get('WLF_GOOGLE_CLIENT_SECRET'),refreshToken=Deno.env.get('WLF_GOOGLE_REFRESH_TOKEN');
 const configured=!!(clientId&&clientSecret&&refreshToken);
 if(action==='status')return new Response(JSON.stringify({...await sql('status'),driveConfigured:configured}),{headers});
 if(action==='deleteRejectedUser'){
 const target=await sql('reserveDeleteUser',{email:p.email});try{const {error}=await admin.auth.admin.deleteUser(target.id);if(error)throw error;}finally{await sql('releaseDeleteUser',{id:target.id});}
 return new Response(JSON.stringify({deleted:true}),{headers});
 }
 if(action==='start')return new Response(JSON.stringify(await sql('start',p)),{headers});
 if(action==='restore'){
 if(JSON.stringify(p.archive||{}).length>10000000)throw Error('Archive part too large');
 return new Response(JSON.stringify(await sql('restore',{archive:p.archive,project})),{headers});}
 if(action==='files')return new Response(JSON.stringify(await sql('files',p)),{headers});
 if(action==='abandon')return new Response(JSON.stringify(await sql('abandon',p)),{headers});
 if(!['backupPart','downloadPart','clearPart'].includes(action))throw Error('Unsupported action');
 if(!configured)throw Error('Google Drive setup required. Read GOOGLE_DRIVE_SETUP_BN.html in the update package.');
 const tr=await fetch('https://oauth2.googleapis.com/token',{method:'POST',headers:{'Content-Type':'application/x-www-form-urlencoded'},body:new URLSearchParams({client_id:clientId!,client_secret:clientSecret!,refresh_token:refreshToken!,grant_type:'refresh_token'})});
 const t=await tr.json();if(!tr.ok||!t.access_token)throw Error('Google Drive authorization expired or invalid. Reconnect using the setup guide.');
 async function drive(path:string,init:any={}){const r=await fetch('https://www.googleapis.com/'+path,{...init,headers:{Authorization:'Bearer '+t.access_token,...(init.headers||{})}});if(!r.ok)throw Error('Google Drive request failed ('+r.status+'). Nothing was cleared.');return r;}
 async function verifiedFile(){const f=await sql('download',p);if(!f?.verified||!f.file_id)throw Error('Verified archive part not found');const r=await drive('drive/v3/files/'+encodeURIComponent(f.file_id)+'?alt=media');const text=await r.text();if(await digest(text)!==f.sha256)throw Error('Backup integrity mismatch. Clear blocked.');const data=JSON.parse(text);if(data.project!==project||data.run!==p.id||data.batch!==p.batch)throw Error('Backup identity mismatch. Clear blocked.');return {text,data};}
 if(action==='downloadPart'){const f=await verifiedFile();return new Response(f.text,{headers});}
 if(action==='clearPart'){await verifiedFile();return new Response(JSON.stringify(await sql('clear',p)),{headers});}
 const nonce=crypto.randomUUID(),archive=await sql('prepare',{...p,project,nonce});
 if(archive.alreadyVerified)return new Response(JSON.stringify({alreadyVerified:true}),{headers});
 const text=JSON.stringify(archive),bytes=new TextEncoder().encode(text);if(bytes.length>8000000)throw Error('Archive part exceeds safe server memory limit. Nothing was cleared.');
 const q="mimeType='application/vnd.google-apps.folder' and trashed=false and appProperties has { key='wlfProject' and value='"+project+"' }";
 let folders=await(await drive('drive/v3/files?q='+encodeURIComponent(q)+'&fields=files(id)&pageSize=1')).json();let folder=folders.files?.[0]?.id;
 if(!folder){const r=await drive('drive/v3/files?fields=id',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({name:'WLF Backups — '+project,mimeType:'application/vnd.google-apps.folder',appProperties:{wlfProject:project}})});folder=(await r.json()).id;}
 const boundary='wlf_'+crypto.randomUUID(),meta={name:'WLF-Support-'+archive.run+'-part-'+p.batch+'.json',parents:[folder],mimeType:'application/json'};
 const multipart='--'+boundary+'\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n'+JSON.stringify(meta)+'\r\n--'+boundary+'\r\nContent-Type: application/json\r\n\r\n'+text+'\r\n--'+boundary+'--';
 const upload=await drive('upload/drive/v3/files?uploadType=multipart&fields=id',{method:'POST',headers:{'Content-Type':'multipart/related; boundary='+boundary},body:multipart});
 const file=await upload.json();if(!/^[a-zA-Z0-9_-]+$/.test(file.id||''))throw Error('Drive did not return an archive ID');
 const saved=await(await drive('drive/v3/files/'+file.id+'?alt=media')).text(),sha256=await digest(text);
 if(await digest(saved)!==sha256)throw Error('Uploaded backup failed integrity verification. Nothing was cleared.');
 await sql('verify',{...p,nonce,fileId:file.id,sha256});
 return new Response(JSON.stringify({verified:true,fileId:file.id,sha256,records:archive.records.length}),{headers});
 }catch(e){return new Response(JSON.stringify({error:(e as Error).message}),{status,headers});}
});
