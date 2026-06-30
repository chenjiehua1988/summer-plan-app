// ============================================================
// 鉴权（单一家庭密码版）
// - 创建家庭：设家庭名 + 共同密码 + 首个角色（妈妈/爸爸）→ 写入 families（密码 bcrypt 哈希）
// - 登录：输家庭名 + 密码 → 用 crypt 校验 → 命中则存本地 session
// - 切换角色：本地切换 妈妈/爸爸，无需重新登录
// 不使用 Supabase Auth。
// ============================================================
import { supabase, state, saveSession, loadSessionLocal, clearSession, toast } from './supabase.js';

// 用数据库的 crypt/cmp 校验密码：取回该家庭名的 password_hash，再用 RPC 比对
// 为避免暴露哈希到前端，用 SQL 函数 pw_match 校验
export async function loginWithPassword(familyName, password) {
  // 调 RPC：返回 family_id 或 null
  const { data, error } = await supabase.rpc('pw_match', {
    p_name: familyName.trim(), p_pw: password
  });
  if (error) throw error;
  if (!data) throw new Error('家庭名或密码不对');
  // data 是 family id（uuid 字符串）
  const { data: fam, error: fe } = await supabase
    .from('families').select('id, name').eq('id', data).single();
  if (fe) throw fe;
  state.family = fam;
  state.currentRole = '妈妈';
  saveSession(fam.id, state.currentRole);
  return fam;
}

// 创建家庭
export async function createFamily(familyName, password, role) {
  familyName = familyName.trim();
  if (!familyName) throw new Error('请填家庭名');
  if (!password || password.length < 4) throw new Error('密码至少 4 位');
  // 检查同名
  const { data: exist } = await supabase
    .from('families').select('id').eq('name', familyName).maybeSingle();
  if (exist) throw new Error('这个家庭名已存在，换一个或直接登录');
  // 哈希用 RPC 在数据库侧算（gen_salt('bf')），避免前端哈希库
  const { data: hash, error: he } = await supabase.rpc('pw_hash', { p_pw: password });
  if (he) throw he;
  const { data: fam, error: ie } = await supabase
    .from('families').insert({ name: familyName, password_hash: hash })
    .select('id, name').single();
  if (ie) throw ie;
  state.family = fam;
  state.currentRole = role || '妈妈';
  saveSession(fam.id, state.currentRole);
  toast('家庭已创建');
  return fam;
}

// 从本地 session 恢复（已登录过）
export async function restoreSession() {
  const s = loadSessionLocal();
  if (!s || !s.familyId) return null;
  const { data: fam, error } = await supabase
    .from('families').select('id, name').eq('id', s.familyId).maybeSingle();
  if (error || !fam) { clearSession(); return null; }
  state.family = fam;
  state.currentRole = s.role || '妈妈';
  state.currentPlanId = s.planId || null;
  return fam;
}

export function switchRole(role) {
  state.currentRole = role;
  const s = loadSessionLocal();
  if (s) saveSession(s.familyId, role, s.planId);
}

// 切换当前学习周期（持久化）
export function switchPlan(planId) {
  state.currentPlanId = planId;
  const s = loadSessionLocal();
  if (s) saveSession(s.familyId, s.role, planId);
}

export async function logout() {
  clearSession();
  state.family = null;
  state.currentRole = '妈妈';
  state.children = [];
  state.currentChildId = null;
  state.currentPlanId = null;
  state.plans = [];
  state.tags = [];
}
