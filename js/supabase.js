// ============================================================
// Supabase 客户端初始化
// 把下面的 URL 和 anon key 替换为你自己 Supabase 项目的值
// 位置：Supabase Dashboard → Project Settings → API
// ============================================================
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';

// 已配置：从 Supabase Dashboard → Connect 对话框获取
const SUPABASE_URL = 'https://dnmgosoqcqmdfpptawbw.supabase.co';
const SUPABASE_ANON_KEY = 'sb_publishable_1_AlE8lgLeCk1pVeajJ9Qg_6b_cu0jB';

export const supabase = createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
  realtime: { params: { eventsPerSecond: 5 } }
});

// 全局当前状态（在 app.js / 各模块间共享）
// 登录态 = 本地存的 familyId + mode(parent/child) + role(妈妈/爸爸) + childId(孩子模式) + 当前周期
export const state = {
  family: null,         // families 行（含 id, name）
  mode: 'parent',       // 'parent' | 'child'
  role: '妈妈',          // 家长角色（登录时固定，不可改）
  children: [],         // 孩子列表
  currentChildId: null, // 当前选中的孩子（child 模式下固定为登录孩子）
  currentPlanId: null,  // 当前学习周期
  plans: [],            // 周期列表
  planTypes: [],        // 周期类型列表
  tags: [],             // 家庭标签库
  dayOffs: [],          // 当前周期+孩子的假期日期
  pendingTab: 'today'
};

// 操作人名：parent 模式=角色(妈妈/爸爸)，child 模式=当前孩子名
export function actorName() {
  if (state.mode === 'child') {
    const c = state.children.find(x => x.id === state.currentChildId);
    return c ? c.name : '孩子';
  }
  return state.role;
}

// 本地持久化登录态，localStorage
const LS_KEY = 'summer-plan-session';
export function saveSession(s) {
  localStorage.setItem(LS_KEY, JSON.stringify(s));
}
export function loadSessionLocal() {
  try { return JSON.parse(localStorage.getItem(LS_KEY) || 'null'); }
  catch { return null; }
}
export function clearSession() { localStorage.removeItem(LS_KEY); }

// 工具：toast 提示
export function toast(msg, ms = 2000) {
  const el = document.getElementById('toast');
  if (!el) return;
  el.textContent = msg;
  el.classList.add('show');
  clearTimeout(toast._t);
  toast._t = setTimeout(() => el.classList.remove('show'), ms);
}

// 工具：今天日期 YYYY-MM-DD（本地时区）
export function todayStr(d = new Date()) {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}
