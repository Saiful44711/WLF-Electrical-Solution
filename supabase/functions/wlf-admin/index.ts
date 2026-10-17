// Deploy ONLY on Supabase. Its service role key is a server environment variable.
import {createClient} from 'npm:@supabase/supabase-js@2.118.0';
const headers={'Access-Control-Allow-Origin':'*','Access-Control-Allow-Headers':'authorization,x-client-info,apikey,content-type','Access-Control-Allow-Methods':'POST,OPTIONS','Content-Type':'application/json'};
Deno.serve(async(req)=>{
 if(req.method==='OPTIONS')return new Response('ok',{headers});
 try{
 if(req.method!=='POST')throw Error('POST required');
 const url=Deno.env.get('SUPABASE_URL')!;
 const secretKeys=JSON.parse(Deno.env.get('SUPABASE_SECRET_KEYS')||'{}');
 const key=secretKeys.default||Deno.env.get('SUPABASE_SERVICE_ROLE_KEY');
 if(!url||!key)throw Error('Server admin key missing. Check Edge Function environment.');
 const admin=createClient(url,key,{auth:{persistSession:false,autoRefreshToken:false}});
 const token=(req.headers.get('Authorization')||'').replace(/^Bearer\s+/i,'');
 const {data:auth,error:authErr}=await admin.auth.getUser(token);if(authErr||!auth.user)throw Error('Sign in required');
 const {data:me,error:meErr}=await admin.from('wlf_profiles').select('id,role,status').eq('id',auth.user.id).single();
 if(meErr||me?.role!=='Super Admin'||me?.status!=='Approved')return new Response(JSON.stringify({error:'Super Admin only'}),{status:403,headers});
 const body=await req.json();if(body.action!=='resetPassword')throw Error('Unsupported admin action');
 const {data:target,error:targetErr}=await admin.from('wlf_profiles').select('id,email').eq('email',String(body.email).trim().toLowerCase()).single();if(targetErr||!target)throw Error('User not found');
 const bytes=crypto.getRandomValues(new Uint8Array(24));const password=Array.from(bytes,b=>b.toString(16).padStart(2,'0')).join('')+'Aa!9';
 const {error}=await admin.auth.admin.updateUserById(target.id,{password});if(error)throw error;
 return new Response(JSON.stringify({email:target.email,tempPassword:password}),{headers});
 }catch(e){return new Response(JSON.stringify({error:(e as Error).message}),{status:400,headers});}
});
