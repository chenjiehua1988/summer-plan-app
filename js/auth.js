// ============================================================
// 鉴权（家长/孩子模式）
// - 家长登录：家庭名 + 密码 + 选妈妈/爸爸 → 角色 fixed
// - 孩子登录：家庭名 + 选自己 → 孩子模式（不验密码）
// - 创建家庭：家庭名 + 密码 + 角色
// 不使用 Supabase Auth。角色登录后不可改。
// ============================================================
import { supabase, state, saveSession, loadSessionLocal, clearSession, toast } from './supabase.js';

function persist() {
  saveSession({
    familyId: state.family?.id, mode: state.mode, role: state.role,
    childId: state.currentChildId, planId: state.currentPlanId
  });
}

// 家长登录（含角色）
export async function loginAsParent(familyName, password, role) {
  const { data, error } = await supabase.rpc('pw_match', {
    p_name: familyName.trim(), p_pw: password
  });
  if (error) throw error;
  if (!data) throw new Error('家庭名或密码不对');
  const { data: fam, error: fe } = await supabase
    .from('families').select('*').eq('id', data).single();
  if (fe) throw fe;
  state.family = fam;
  state.mode = 'parent';
  state.role = role || '妈妈';
  persist();
  return fam;
}

// 兼容旧调用
export const loginWithPassword = (f, p) => loginAsParent(f, p, '妈妈');

// 孩子登录：家庭名 + childId
export async function loginAsChild(familyName, childId) {
  const { data: fam, error } = await supabase
    .from('families').select('*').eq('name', familyName.trim()).maybeSingle();
  if (error) throw error;
  if (!fam) throw new Error('家庭名不存在');
  state.family = fam;
  state.mode = 'child';
  state.currentChildId = childId;
  persist();
  return fam;
}

// 拉某家庭的孩子列表（孩子登录时选自己用）
export async function fetchChildrenOf(familyName) {
  const { data: fam, error } = await supabase
    .from('families').select('id').eq('name', familyName.trim()).maybeSingle();
  if (error || !fam) return [];
  const { data: kids } = await supabase
    .from('children').select('id,name,grade_target').eq('family_id', fam.id).order('created_at');
  return kids || [];
}

// 创建家庭
export async function createFamily(familyName, password, role) {
  familyName = familyName.trim();
  if (!familyName) throw new Error('请填家庭名');
  if (!password || password.length < 4) throw new Error('密码至少 4 位');
  const { data: exist } = await supabase
    .from('families').select('id').eq('name', familyName).maybeSingle();
  if (exist) throw new Error('这个家庭名已存在，换一个或直接登录');
  const { data: hash, error: he } = await supabase.rpc('pw_hash', { p_pw: password });
  if (he) throw he;
  const { data: fam, error: ie } = await supabase
    .from('families').insert({ name: familyName, password_hash: hash })
    .select('*').single();
  if (ie) throw ie;
  state.family = fam;
  state.mode = 'parent';
  state.role = role || '妈妈';
  persist();
  toast('家庭已创建');
  return fam;
}

// 从本地 session 恢复
export async function restoreSession() {
  const s = loadSessionLocal();
  if (!s || !s.familyId) return null;
  const { data: fam, error } = await supabase
    .from('families').select('*').eq('id', s.familyId).maybeSingle();
  if (error || !fam) { clearSession(); return null; }
  state.family = fam;
  state.mode = s.mode || 'parent';
  state.role = s.role || '妈妈';
  state.currentChildId = s.childId || null;
  state.currentPlanId = s.planId || null;
  return fam;
}

// 切换当前学习周期（持久化）
export function switchPlan(planId) {
  state.currentPlanId = planId;
  persist();
}

export async function logout() {
  clearSession();
  state.family = null;
  state.mode = 'parent';
  state.role = '妈妈';
  state.children = [];
  state.currentChildId = null;
  state.currentPlanId = null;
  state.plans = [];
  state.tags = [];
  state.planTypes = [];
}
