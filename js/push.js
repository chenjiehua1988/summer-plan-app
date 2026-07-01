// ============================================================
// Web Push 订阅管理：家长开启/关闭通知
// ============================================================
import { supabase, state, toast } from './supabase.js';

// VAPID 公钥（前端用，私钥在 Edge Function）
const VAPID_PUBLIC_KEY = 'BLcNOVqCu_yP_DR5rvxrNWhIvpf79AZHJi0i11neJha3u-11PMNuaFooL_R8SWACKH-UEoeLDi5opzuk1jdTP-E';

function urlBase64ToUint8Array(base64String) {
  const padding = '='.repeat((4 - base64String.length % 4) % 4);
  const base64 = (base64String + padding).replace(/-/g, '+').replace(/_/g, '/');
  const raw = atob(base64);
  const arr = new Uint8Array(raw.length);
  for (let i = 0; i < raw.length; i++) arr[i] = raw.charCodeAt(i);
  return arr;
}

// 当前设备的订阅（去 Supabase 查是否存在）
export async function isPushEnabled() {
  if (!('serviceWorker' in navigator) || !('PushManager' in window)) return false;
  try {
    const reg = await navigator.serviceWorker.ready;
    const sub = await reg.pushManager.getSubscription();
    return !!sub;
  } catch { return false; }
}

// 开启通知
export async function enablePush() {
  if (!('serviceWorker' in navigator) || !('PushManager' in window)) {
    toast('此设备不支持通知'); return false;
  }
  // 请求通知权限
  const perm = await Notification.requestPermission();
  if (perm !== 'granted') { toast('未授权通知权限'); return false; }
  try {
    const reg = await navigator.serviceWorker.ready;
    const sub = await reg.pushManager.subscribe({
      userVisibleOnly: true,
      applicationServerKey: urlBase64ToUint8Array(VAPID_PUBLIC_KEY)
    });
    // 存入 push_subscriptions
    const subJson = sub.toJSON();
    const { error } = await supabase.from('push_subscriptions').upsert({
      family_id: state.family.id,
      user_role: state.role,
      endpoint: subJson.endpoint,
      p256dh: subJson.keys.p256dh,
      auth: subJson.keys.auth
    }, { onConflict: 'endpoint' });
    if (error) throw error;
    toast('通知已开启 ✓');
    return true;
  } catch (e) {
    toast('开启失败：' + e.message);
    return false;
  }
}

// 关闭通知
export async function disablePush() {
  try {
    const reg = await navigator.serviceWorker.ready;
    const sub = await reg.pushManager.getSubscription();
    if (sub) {
      const subJson = sub.toJSON();
      await sub.unsubscribe();
      await supabase.from('push_subscriptions').delete().eq('endpoint', subJson.endpoint);
    }
    toast('通知已关闭');
    return true;
  } catch (e) {
    toast('关闭失败：' + e.message);
    return false;
  }
}
