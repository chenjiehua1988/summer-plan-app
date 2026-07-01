// Supabase Edge Function: push-checkin
// 由 DB webhook (checkins INSERT) 触发，给该孩子所在家庭的家长设备发 Web Push 通知。
// Deno 原生实现 Web Push（VAPID + aes128g2 加密），不依赖 Node web-push 库。
// 参考: https://www.negrel.dev/blog/deno-web-push-notifications/

import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

// VAPID 密钥（私钥配在环境变量，公钥前端用）
const VAPID_PRIVATE_KEY = Deno.env.get("VAPID_PRIVATE_KEY")!;
const VAPID_PUBLIC_KEY = Deno.env.get("VAPID_PUBLIC_KEY")!;
const VAPID_SUBJECT = "mailto:family@studyplan.app";

const SUPABASE_URL = Deno.env.get("SB_URL")!;
const SERVICE_ROLE_KEY = Deno.env.get("SB_SERVICE_ROLE_KEY")!;

// ---------- Base64 URL 工具 ----------
function base64UrlToBytes(b64url: string): Uint8Array {
  const b64 = b64url.replace(/-/g, "+").replace(/_/g, "/");
  const pad = "=".repeat((4 - b64.length % 4) % 4);
  const bin = atob(b64 + pad);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return bytes;
}
function bytesToBase64Url(bytes: Uint8Array): string {
  let bin = "";
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}
function base64UrlToBase64(b64url: string): string {
  return b64url.replace(/-/g, "+").replace(/_/g, "/") + "=".repeat((4 - b64url.length % 4) % 4);
}

// ---------- VAPID 签名（ES256 JWT）----------
async function vapidJwt(endpoint: string): Promise<string> {
  const origin = new URL(endpoint).origin;
  const header = { typ: "JWT", alg: "ES256" };
  const payload = { aud: origin, exp: Math.floor(Date.now() / 1000) + 12 * 3600, sub: VAPID_SUBJECT };
  const enc = (o: object) => bytesToBase64Url(new TextEncoder().encode(JSON.stringify(o)));
  const data = `${enc(header)}.${enc(payload)}`;

  // 导入 VAPID 私钥（P-256）：JWK 只传 d（私钥scalar），Deno 会派生公钥
  const privKeyRaw = base64UrlToBytes(VAPID_PRIVATE_KEY);
  console.log("privKeyRaw length:", privKeyRaw.length);
  const jwk = { kty: "EC", crv: "P-256", d: bytesToBase64Url(privKeyRaw), ext: true };
  const ecKey = await crypto.subtle.importKey("jwk", jwk, { name: "ECDSA", namedCurve: "P-256" }, false, ["sign"]);

  const sig = await crypto.subtle.sign({ name: "ECDSA", hash: "SHA-256" }, ecKey, new TextEncoder().encode(data));
  return `${data}.${bytesToBase64Url(new Uint8Array(sig))}`;
}

// ---------- aes128g2 加密 payload ----------
async function encryptPayload(payload: string, sub: { p256dh: string; auth: string }): Promise<Uint8Array> {
  const enc = new TextEncoder();
  // RFC8188 aes128g2
  const authSecret = base64UrlToBytes(sub.auth);
  const uaPub = base64UrlToBytes(sub.p256dh);

  // 生成临时 ECDH 密钥对
  const ecdhKey = await crypto.subtle.generateKey({ name: "ECDH", namedCurve: "P-256" }, true, ["deriveBits"]);
  const ecdhPub = await crypto.subtle.exportKey("raw", ecdhKey.publicKey);

  // 导入用户代理公钥
  const uaKey = await crypto.subtle.importKey("raw", uaPub, { name: "ECDH", namedCurve: "P-256" }, false, []);

  // 共享密钥
  const sharedSecret = new Uint8Array(await crypto.subtle.deriveBits({ name: "ECDH", public: uaKey }, ecdhKey.privateKey, 256));

  // IKM = HKDF-Extract(authSecret, sharedSecret)
  const ikm = await hkdfExtract(authSecret, sharedSecret);
  // key info + nonce info
  const keyInfo = enc.encode("Content-Encoding: aes128g2\x00");
  const nonceInfo = enc.encode("Content-Encoding: nonce\x00");
  const prk = await hkdfExtract(new Uint8Array(0), ikm);
  const cek = await hkdfExpand(prk, keyInfo, 16);
  const nonce = await hkdfExpand(prk, nonceInfo, 12);

  // 加密
  const iv = nonce;
  const plaintext = enc.encode(payload);
  const aesKey = await crypto.subtle.importKey("raw", cek, { name: "AES-GCM" }, false, ["encrypt"]);
  const ciphertext = new Uint8Array(await crypto.subtle.encrypt({ name: "AES-GCM", iv, tagLength: 128 }, aesKey, plaintext));

  // 组装 header: salt(16) + rs(4) + idlen(1) + keyid(变长) + ciphertext
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const rs = new Uint8Array(4); rs[3] = 4096 & 0xff; rs[2] = (4096 >> 8) & 0xff;
  const keyId = new Uint8Array(ecdhPub);
  const header = new Uint8Array(16 + 4 + 1 + keyId.length);
  header.set(salt, 0);
  header.set(rs, 16);
  header[20] = keyId.length;
  header.set(keyId, 21);
  const out = new Uint8Array(header.length + ciphertext.length);
  out.set(header, 0);
  out.set(ciphertext, header.length);
  return out;
}

async function hkdfExtract(salt: Uint8Array, ikm: Uint8Array): Promise<Uint8Array> {
  const key = await crypto.subtle.importKey("raw", salt, { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const sig = await crypto.subtle.sign("HMAC", key, ikm);
  return new Uint8Array(sig);
}
async function hkdfExpand(prk: Uint8Array, info: Uint8Array, length: number): Promise<Uint8Array> {
  const key = await crypto.subtle.importKey("raw", prk, { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  let t = new Uint8Array(0);
  const out: Uint8Array[] = [];
  let n = 0;
  let totalLen = 0;
  while (totalLen < length) {
    n++;
    const input = new Uint8Array(t.length + info.length + 1);
    input.set(t, 0); input.set(info, t.length); input[t.length + info.length] = n;
    t = new Uint8Array(await crypto.subtle.sign("HMAC", key, input));
    out.push(t);
    totalLen += t.length;
  }
  const all = new Uint8Array(totalLen);
  let off = 0;
  for (const chunk of out) { all.set(chunk, off); off += chunk.length; }
  return all.slice(0, length);
}

// ---------- 发送推送 ----------
async function sendPush(sub: { endpoint: string; p256dh: string; auth: string }, payload: string) {
  const jwt = await vapidJwt(sub.endpoint);
  const encrypted = await encryptPayload(payload, sub);
  const res = await fetch(sub.endpoint, {
    method: "POST",
    headers: {
      "TTL": "2419200",
      "Content-Encoding": "aes128g2",
      "Content-Type": "application/octet-stream",
      "Authorization": `vapid t=${jwt}, k=${VAPID_PUBLIC_KEY}`
    },
    body: encrypted
  });
  return res.status;
}

// ---------- 主函数 ----------
Deno.serve(async (req) => {
  console.log("push-checkin invoked");
  try {
    // 检查环境变量
    if (!VAPID_PRIVATE_KEY || !VAPID_PUBLIC_KEY || !SUPABASE_URL || !SERVICE_ROLE_KEY) {
      console.error("missing env vars", { hasPriv: !!VAPID_PRIVATE_KEY, hasPub: !!VAPID_PUBLIC_KEY, hasUrl: !!SUPABASE_URL, hasKey: !!SERVICE_ROLE_KEY });
      return new Response("missing env", { status: 500 });
    }
    const body = await req.json();
    console.log("webhook body:", JSON.stringify(body).slice(0, 500));
    // DB webhook 格式: { type, table, record, old_record }
    const rec = body.record || body;
    const childId = rec.child_id;
    const title = rec.title || "任务";
    if (!childId) { console.log("no child_id in", JSON.stringify(rec).slice(0,200)); return new Response("no child_id", { status: 400 }); }

    const sb = createClient(SUPABASE_URL, SERVICE_ROLE_KEY);
    // 查家庭
    const { data: child, error: ce } = await sb.from("children").select("family_id,name").eq("id", childId).single();
    if (ce) { console.error("child query error", ce.message); return new Response("child err", { status: 500 }); }
    if (!child) { console.log("no child"); return new Response("no child", { status: 404 }); }
    const familyId = child.family_id;
    const name = child.name || "孩子";
    console.log("child:", name, "family:", familyId);

    // 查该家庭所有家长订阅
    const { data: subs, error: se } = await sb.from("push_subscriptions").select("*").eq("family_id", familyId);
    if (se) { console.error("subs query error", se.message); return new Response("subs err", { status: 500 }); }
    console.log("subs count:", subs?.length || 0);
    if (!subs || !subs.length) return new Response("no subs", { status: 200 });

    const payload = JSON.stringify({ title: "学习计划", body: `${name}完成了「${title}」，等验收` });
    const results = [];
    for (const s of subs) {
      try {
        console.log("sending push to", s.endpoint.slice(0, 50));
        const code = await sendPush({ endpoint: s.endpoint, p256dh: s.p256dh, auth: s.auth }, payload);
        console.log("push result", code);
        results.push({ code, endpoint: s.endpoint });
        if (code === 410 || code === 404) {
          await sb.from("push_subscriptions").delete().eq("id", s.id);
        }
      } catch (e) {
        console.error("push error", String(e));
        results.push({ error: String(e) });
      }
    }
    return new Response(JSON.stringify({ ok: true, results }), { headers: { "Content-Type": "application/json" } });
  } catch (e) {
    console.error("top error", String(e), e?.stack);
    return new Response(JSON.stringify({ error: String(e) }), { status: 500 });
  }
});
