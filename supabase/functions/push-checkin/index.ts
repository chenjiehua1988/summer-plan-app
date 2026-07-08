// Supabase Edge Function: push-checkin
// 由 DB webhook (checkins INSERT) 触发，给该孩子所在家庭的家长设备发 Web Push 通知。
// 用 @negrel/webpush 库（Deno 原生 Web Push），不手搓加密。

import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import * as webpush from "jsr:@negrel/webpush@^0.5.0";

const VAPID_PRIVATE_KEY = Deno.env.get("VAPID_PRIVATE_KEY")!; // base64url 32字节
const VAPID_PUBLIC_KEY = Deno.env.get("VAPID_PUBLIC_KEY")!;   // base64url 65字节(04+X+Y)
const VAPID_SUBJECT = "mailto:family@studyplan.app";
const SUPABASE_URL = Deno.env.get("SB_URL")!;
const SERVICE_ROLE_KEY = Deno.env.get("SB_SERVICE_ROLE_KEY")!;

function b64urlToBytes(s: string): Uint8Array {
  const b64 = s.replace(/-/g, "+").replace(/_/g, "/");
  const pad = "=".repeat((4 - b64.length % 4) % 4);
  const bin = atob(b64 + pad);
  const arr = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) arr[i] = bin.charCodeAt(i);
  return arr;
}
function bytesToB64url(bytes: Uint8Array): string {
  let bin = "";
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

// 构造 VAPID 密钥对（供 @negrel/webpush 用，需 {publicKey, privateKey} 两个 JWK）
async function buildAppServer() {
  const pub = b64urlToBytes(VAPID_PUBLIC_KEY); // 65字节: 04 + X(32) + Y(32)
  const x = bytesToB64url(pub.slice(1, 33));
  const y = bytesToB64url(pub.slice(33, 65));
  const d = VAPID_PRIVATE_KEY; // base64url 32字节
  const publicKey = { kty: "EC", crv: "P-256", x, y, key_ops: ["verify"], ext: true };
  const privateKey = { kty: "EC", crv: "P-256", x, y, d, key_ops: ["sign"], ext: true };
  const vapidKeys = await webpush.importVapidKeys({ publicKey, privateKey } as any, { extractable: false });
  return await webpush.ApplicationServer.new({
    contactInformation: VAPID_SUBJECT,
    vapidKeys,
  });
}

Deno.serve(async (req) => {
  console.log("push-checkin invoked");
  // CORS 预检
  if (req.method === 'OPTIONS') {
    return new Response('ok', { headers: {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'POST, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type, Authorization, apikey'
    }});
  }
  const corsHeaders = { 'Access-Control-Allow-Origin': '*' };
  try {
    if (!VAPID_PRIVATE_KEY || !VAPID_PUBLIC_KEY || !SUPABASE_URL || !SERVICE_ROLE_KEY) {
      console.error("missing env");
      return new Response("missing env", { status: 500 });
    }
    const rawBody = await req.text();
    if (!rawBody) { console.log("empty body"); return new Response("empty", { status: 200 }); }
    const body = JSON.parse(rawBody);
    // 自定义推送（兑换申请/审批等，直接带 subs 和 title/body）
    if (body.type === 'custom' && body.subs) {
      const appServer = await buildAppServer();
      const payload = JSON.stringify({ title: body.title, body: body.body });
      const results = [];
      for (const s of body.subs) {
        try {
          const subscriber = appServer.subscribe({ endpoint: s.endpoint, keys: { p256dh: s.p256dh, auth: s.auth } });
          await subscriber.pushTextMessage(payload, {});
          results.push({ ok: true });
        } catch (e) { results.push({ error: String(e) }); }
      }
      return new Response(JSON.stringify({ ok: true, results }), { headers: { "Content-Type": "application/json", ...corsHeaders } });
    }
    const rec = body.record || body;
    const childId = rec.child_id;
    const title = rec.title || "任务";
    if (!childId) return new Response("no child_id", { status: 400 });

    const sb = createClient(SUPABASE_URL, SERVICE_ROLE_KEY);
    const { data: child, error: ce } = await sb.from("children").select("family_id,name").eq("id", childId).single();
    if (ce || !child) { console.error("child err", ce?.message); return new Response("child err", { status: 500 }); }
    const familyId = child.family_id;
    const name = child.name || "孩子";
    console.log("child:", name, "family:", familyId);

    const { data: allSubs } = await sb.from("push_subscriptions").select("*").eq("family_id", familyId);
    // 打卡通知只推给家长（user_role=妈妈/爸爸），不推给孩子
    const subs = (allSubs || []).filter(s => s.user_role === "妈妈" || s.user_role === "爸爸");
    console.log("parent subs count:", subs.length);
    if (!subs.length) return new Response("no parent subs", { status: 200 });

    const appServer = await buildAppServer();
    const payload = JSON.stringify({ title: "宝贝打卡了", body: `${name}完成了「${title}」，请验收` });

    const results = [];
    for (const s of subs) {
      try {
        const subscriber = appServer.subscribe({
          endpoint: s.endpoint,
          keys: { p256dh: s.p256dh, auth: s.auth },
        });
        await subscriber.pushTextMessage(payload, {});
        console.log("push ok", s.endpoint.slice(0, 40));
        results.push({ ok: true });
      } catch (e) {
        console.error("push error", String(e));
        // 失效订阅清理
        const msg = String(e);
        if (msg.includes("410") || msg.includes("404")) {
          await sb.from("push_subscriptions").delete().eq("id", s.id);
        }
        results.push({ error: msg });
      }
    }
    return new Response(JSON.stringify({ ok: true, results }), { headers: { "Content-Type": "application/json", ...corsHeaders } });
  } catch (e) {
    console.error("top error", String(e));
    return new Response(JSON.stringify({ error: String(e) }), { status: 500, headers: corsHeaders });
  }
});
