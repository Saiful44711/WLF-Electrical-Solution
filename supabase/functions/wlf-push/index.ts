// WLF push sender (v2.5.0). Deploy ONLY on Supabase, with "Verify JWT" OFF.
// It sends only what the database already queued in wlf_private.push_outbox
// (new access request -> Super Admins, forwarded support request -> receiver),
// so calling it cannot send anything else. Keys (VAPID) are created on the first
// run and kept in the database; nothing needs to be typed in by hand.
// Standard Web Push (RFC 8291 aes128gcm + RFC 8292 VAPID) with WebCrypto only.
import {createClient} from 'npm:@supabase/supabase-js@2.118.0';

const headers = {'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Headers': 'authorization,x-client-info,apikey,content-type',
  'Access-Control-Allow-Methods': 'POST,OPTIONS', 'Content-Type': 'application/json'};
const te = new TextEncoder();

export function b64url(bytes: Uint8Array): string {
  let s = '';
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}
export function unb64url(text: string): Uint8Array {
  const s = atob(String(text).replace(/-/g, '+').replace(/_/g, '/') + '='.repeat((4 - String(text).length % 4) % 4));
  return Uint8Array.from(s, c => c.charCodeAt(0));
}
function concat(...parts: Uint8Array[]): Uint8Array {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let i = 0;
  for (const p of parts) { out.set(p, i); i += p.length; }
  return out;
}
async function hmac(key: Uint8Array, data: Uint8Array): Promise<Uint8Array> {
  const k = await crypto.subtle.importKey('raw', key, {name: 'HMAC', hash: 'SHA-256'}, false, ['sign']);
  return new Uint8Array(await crypto.subtle.sign('HMAC', k, data));
}

export async function createKeys(): Promise<{publicKey: string, privateKey: string}> {
  const pair = await crypto.subtle.generateKey({name: 'ECDSA', namedCurve: 'P-256'}, true, ['sign', 'verify']) as CryptoKeyPair;
  const pub = new Uint8Array(await crypto.subtle.exportKey('raw', pair.publicKey));
  const jwk = await crypto.subtle.exportKey('jwk', pair.privateKey);
  return {publicKey: b64url(pub), privateKey: JSON.stringify({kty: jwk.kty, crv: jwk.crv, x: jwk.x, y: jwk.y, d: jwk.d})};
}

export async function vapidHeader(endpoint: string, keys: {publicKey: string, privateKey: string}, subject: string, now = Date.now()): Promise<string> {
  const aud = new URL(endpoint).origin;
  const enc = (o: unknown) => b64url(te.encode(JSON.stringify(o)));
  const unsigned = enc({typ: 'JWT', alg: 'ES256'}) + '.' + enc({aud, exp: Math.floor(now / 1000) + 12 * 3600, sub: subject});
  const key = await crypto.subtle.importKey('jwk', {...JSON.parse(keys.privateKey), ext: true}, {name: 'ECDSA', namedCurve: 'P-256'}, false, ['sign']);
  const sig = new Uint8Array(await crypto.subtle.sign({name: 'ECDSA', hash: 'SHA-256'}, key, te.encode(unsigned)));
  return 'vapid t=' + unsigned + '.' + b64url(sig) + ', k=' + keys.publicKey;
}

// RFC 8291: one aes128gcm record.
export async function encrypt(payload: Uint8Array, p256dh: string, authSecret: string,
    salt = crypto.getRandomValues(new Uint8Array(16))): Promise<Uint8Array> {
  const uaPublic = unb64url(p256dh), auth = unb64url(authSecret);
  const local = await crypto.subtle.generateKey({name: 'ECDH', namedCurve: 'P-256'}, true, ['deriveBits']) as CryptoKeyPair;
  const asPublic = new Uint8Array(await crypto.subtle.exportKey('raw', local.publicKey));
  const uaKey = await crypto.subtle.importKey('raw', uaPublic, {name: 'ECDH', namedCurve: 'P-256'}, false, []);
  const shared = new Uint8Array(await crypto.subtle.deriveBits({name: 'ECDH', public: uaKey}, local.privateKey, 256));
  const prkKey = await hmac(auth, shared);
  const ikm = await hmac(prkKey, concat(te.encode('WebPush: info\0'), uaPublic, asPublic, new Uint8Array([1])));
  const prk = await hmac(salt, ikm);
  const cek = (await hmac(prk, te.encode('Content-Encoding: aes128gcm\0\x01'))).slice(0, 16);
  const nonce = (await hmac(prk, te.encode('Content-Encoding: nonce\0\x01'))).slice(0, 12);
  const aes = await crypto.subtle.importKey('raw', cek, 'AES-GCM', false, ['encrypt']);
  const cipher = new Uint8Array(await crypto.subtle.encrypt({name: 'AES-GCM', iv: nonce}, aes, concat(payload, new Uint8Array([2]))));
  const head = new Uint8Array(21);
  head.set(salt, 0);
  new DataView(head.buffer).setUint32(16, 4096);
  head[20] = asPublic.length;
  return concat(head, asPublic, cipher);
}

export async function send(sub: {endpoint: string, p256dh: string, auth: string}, message: unknown,
    keys: {publicKey: string, privateKey: string}, subject: string, fetcher = fetch): Promise<number> {
  const body = await encrypt(te.encode(JSON.stringify(message)), sub.p256dh, sub.auth);
  const res = await fetcher(sub.endpoint, {method: 'POST', body, headers: {
    'Content-Encoding': 'aes128gcm', 'Content-Type': 'application/octet-stream', TTL: '86400', Urgency: 'high',
    Authorization: await vapidHeader(sub.endpoint, keys, subject)}});
  try { await res.arrayBuffer(); } catch { /* ignore */ }
  return res.status;
}

if (typeof Deno !== 'undefined' && Deno.serve) Deno.serve(async req => {
  if (req.method === 'OPTIONS') return new Response('ok', {headers});
  try {
    const url = Deno.env.get('SUPABASE_URL')!;
    const secretKeys = JSON.parse(Deno.env.get('SUPABASE_SECRET_KEYS') || '{}');
    const key = secretKeys.default || Deno.env.get('SUPABASE_SERVICE_ROLE_KEY');
    if (!url || !key) throw Error('Server key missing. Check Edge Function environment.');
    const db = createClient(url, key, {auth: {persistSession: false, autoRefreshToken: false}});
    const call = async (action: string, payload: unknown = {}) => {
      const {data, error} = await db.rpc('wlf_push_service', {action, payload});
      if (error) throw Error(error.message);
      return data;
    };
    let keys = await call('keys');
    if (!keys) keys = await call('keys', await createKeys());
    const subject = Deno.env.get('PUSH_SUBJECT') || url;
    const rows = await call('claim') as {id: number, title: string, body: string, url: string, subscriptions: {endpoint: string, p256dh: string, auth: string}[]}[];
    const done: number[] = [], gone: string[] = [];
    let sent = 0;
    for (const row of rows || []) {
      let finished = row.subscriptions.length === 0;
      for (const sub of row.subscriptions) {
        try {
          const status = await send(sub, {title: row.title, body: row.body, url: row.url, tag: 'wlf-' + row.id}, keys, subject);
          if (status >= 200 && status < 300) { sent++; finished = true; }
          else if (status === 404 || status === 410) { gone.push(sub.endpoint); finished = true; }
          else if (status >= 400 && status < 500 && status !== 429) finished = true;
        } catch (e) { console.error('push failed', (e as Error).message); }
      }
      if (finished) done.push(row.id);
    }
    if (done.length) await call('done', {ids: done});
    if (gone.length) await call('gone', {endpoints: gone});
    return new Response(JSON.stringify({ok: true, publicKey: keys.publicKey, queued: (rows || []).length, sent}), {headers});
  } catch (e) {
    return new Response(JSON.stringify({error: (e as Error).message}), {status: 400, headers});
  }
});
