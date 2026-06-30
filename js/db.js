// ============================================================
// 数据访问层：CRUD + 离线缓存（IndexedDB）+ 断网打卡队列
// 设计：Supabase 为唯一权威源；IndexedDB 仅缓存近 14 天数据供离线浏览。
// 断网时打卡进入本地队列，联网后批量 upsert，带 updated_at 时间戳做 LWW。
// ============================================================
import { supabase, state, toast } from './supabase.js';

const DB_NAME = 'summer-plan-cache';
const DB_VERSION = 1;
const STORE_CACHE = 'records';   // 缓存 daily_records
const STORE_QUEUE = 'queue';     // 离线待同步队列

let _db = null;
function db() {
  if (_db) return Promise.resolve(_db);
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const d = req.result;
      if (!d.objectStoreNames.contains(STORE_CACHE))
        d.createObjectStore(STORE_CACHE, { keyPath: 'id' });
      if (!d.objectStoreNames.contains(STORE_QUEUE))
        d.createObjectStore(STORE_QUEUE, { keyPath: 'qid', autoIncrement: true });
    };
    req.onsuccess = () => { _db = req.result; resolve(_db); };
    req.onerror = () => reject(req.error);
  });
}

function idbAll(store) {
  return db().then(d => new Promise((res, rej) => {
    const tx = d.transaction(store, 'readonly');
    const r = tx.objectStore(store).getAll();
    r.onsuccess = () => res(r.result || []);
    r.onerror = () => rej(r.error);
  }));
}
function idbPut(store, val) {
  return db().then(d => new Promise((res, rej) => {
    const tx = d.transaction(store, 'readwrite');
    tx.objectStore(store).put(val);
    tx.oncomplete = () => res();
    tx.onerror = () => rej(tx.error);
  }));
}
function idbDel(store, key) {
  return db().then(d => new Promise((res, rej) => {
    const tx = d.transaction(store, 'readwrite');
    tx.objectStore(store).delete(key);
    tx.oncomplete = () => res();
    tx.onerror = () => rej(tx.error);
  }));
}

export function isOnline() { return navigator.onLine; }

// ---------- 缓存：写入/读取 daily_records ----------
export async function cacheRecords(rows) {
  for (const r of rows) await idbPut(STORE_CACHE, r);
}
export async function getCachedRecords(childId, date) {
  const all = await idbAll(STORE_CACHE);
  return all.filter(r => r.child_id === childId && r.date === date);
}

// ---------- 离线队列 ----------
async function enqueue(op) {
  await idbPut(STORE_QUEUE, { ...op, qid: Date.now() + Math.random() });
}
async function getQueue() { return idbAll(STORE_QUEUE); }
async function clearQueueItem(qid) { return idbDel(STORE_QUEUE, qid); }

// ---------- 孩子档案 ----------
export async function fetchChildren() {
  if (!state.family?.id) return [];
  const { data, error } = await supabase
    .from('children').select('*').eq('family_id', state.family.id).order('created_at');
  if (error) throw error;
  state.children = data || [];
  return state.children;
}
export async function addChild(name, gradeTarget) {
  const row = { family_id: state.family.id, name, grade_target: gradeTarget };
  const { data, error } = await supabase.from('children').insert(row).select().single();
  if (error) throw error;
  state.children.push(data);
  return data;
}
export async function removeChild(id) {
  const { error } = await supabase.from('children').delete().eq('id', id);
  if (error) throw error;
  state.children = state.children.filter(c => c.id !== id);
}

// ---------- 任务模板 ----------
export async function fetchTemplates(childId) {
  let q = supabase.from('task_templates').select('*').eq('family_id', state.family.id);
  if (childId) q = q.eq('child_id', childId);
  q = q.order('subject').order('created_at');
  const { data, error } = await q;
  if (error) throw error;
  return data || [];
}
export async function addTemplate(t) {
  const row = { family_id: state.family.id, child_id: t.child_id, subject: t.subject,
    title: t.title, default_minutes: t.default_minutes ?? 30, points: t.points ?? 1,
    recurrence: t.recurrence ?? 'daily', active: t.active ?? true };
  const { data, error } = await supabase.from('task_templates').insert(row).select().single();
  if (error) throw error;
  return data;
}
export async function deleteTemplate(id) {
  const { error } = await supabase.from('task_templates').delete().eq('id', id);
  if (error) throw error;
}

// ---------- 每日记录 ----------
// 拉取某孩子某天的记录；若当天无记录，从 active 模板自动生成
export async function ensureDailyRecords(childId, date) {
  const { data: existing, error } = await supabase
    .from('daily_records').select('*')
    .eq('child_id', childId).eq('date', date);
  if (error) throw error;
  if (existing && existing.length) {
    await cacheRecords(existing);
    return existing;
  }
  // 生成
  const templates = await fetchTemplates(childId);
  const active = templates.filter(t => t.active);
  if (!active.length) return [];
  const rows = active.map(t => ({
    family_id: state.family.id, child_id: childId, task_id: t.id, date,
    subject: t.subject, title: t.title, points: t.points, status: 'pending'
  }));
  const { data, error: ie } = await supabase.from('daily_records').insert(rows).select();
  if (ie) throw ie;
  await cacheRecords(data || []);
  return data || [];
}

// 拉取某孩子一段日期范围的记录（统计用）
export async function fetchRecordsRange(childId, fromDate, toDate) {
  let q = supabase.from('daily_records').select('*').eq('child_id', childId)
    .gte('date', fromDate).lte('date', toDate).order('date');
  const { data, error } = await q;
  if (error) throw error;
  return data || [];
}

// 更新单条记录（打卡完成/取消完成）
export async function updateRecord(id, patch) {
  if (isOnline()) {
    const { data, error } = await supabase
      .from('daily_records').update({ ...patch, updated_at: new Date().toISOString() })
      .eq('id', id).select().single();
    if (error) throw error;
    await cacheRecords([data]);
    return data;
  } else {
    // 离线：入队
    await enqueue({ kind: 'updateRecord', id, patch: { ...patch, updated_at: new Date().toISOString() } });
    // 本地缓存也更新（乐观）
    const cached = await getCachedRecordsById(id);
    if (cached) { Object.assign(cached, patch); await idbPut(STORE_CACHE, cached); }
    toast('离线已暂存，联网后同步');
    return { ...cached, ...patch };
  }
}

async function getCachedRecordsById(id) {
  const all = await idbAll(STORE_CACHE);
  return all.find(r => r.id === id);
}

// 验收：把记录置为 verified/rejected（仅父母）
export async function verifyRecord(id, status, note) {
  const patch = { status, note: note ?? null,
    verified_at: new Date().toISOString(), verified_by: state.currentRole };
  return updateRecord(id, patch); // 复用在线/离线逻辑；verified 触发器在服务端自动加分
}

// ---------- 生活项 ----------
export async function fetchLifeLogs(childId, fromDate, toDate) {
  const { data, error } = await supabase.from('life_logs').select('*')
    .eq('child_id', childId).gte('date', fromDate).lte('date', toDate).order('date');
  if (error) throw error;
  return data || [];
}
export async function addLifeLog(row) {
  const payload = { ...row, family_id: state.family.id, created_by: state.currentRole };
  const { data, error } = await supabase.from('life_logs').insert(payload).select().single();
  if (error) throw error;
  return data;
}

// ---------- 积分 ----------
export async function fetchLedger(childId) {
  const { data, error } = await supabase.from('point_ledger').select('*')
    .eq('child_id', childId).order('created_at', { ascending: false });
  if (error) throw error;
  return data || [];
}
export async function fetchPointBalance(childId) {
  const rows = await fetchLedger(childId);
  return rows.reduce((s, r) => s + (r.delta || 0), 0);
}

// ---------- 奖励 ----------
export async function fetchRewards(childId) {
  const { data, error } = await supabase.from('rewards').select('*')
    .eq('child_id', childId).order('redeemed_at', { ascending: false });
  if (error) throw error;
  return data || [];
}
export async function redeemReward(childId, name, costPoints) {
  // 扣减积分：写一条负数流水 + 一条奖励记录
  const { error: e1 } = await supabase.from('point_ledger').insert({
    family_id: state.family.id, child_id: childId,
    delta: -costPoints, reason: '兑换奖励：' + name, created_by: state.currentRole
  });
  if (e1) throw e1;
  const { data, error: e2 } = await supabase.from('rewards').insert({
    family_id: state.family.id, child_id: childId,
    name, cost_points: costPoints, redeemed_by: state.currentRole
  }).select().single();
  if (e2) throw e2;
  return data;
}

// ---------- 离线队列回放 ----------
export async function flushQueue() {
  if (!isOnline()) return;
  const items = await getQueue();
  for (const it of items) {
    try {
      if (it.kind === 'updateRecord') {
        await supabase.from('daily_records').update(it.patch).eq('id', it.id);
      }
      await clearQueueItem(it.qid);
    } catch (e) {
      console.warn('flushQueue item failed', e);
      break; // 失败则保留，下次再试
    }
  }
}

// ---------- Realtime 订阅 ----------
export function subscribeRecords(childId, onChange) {
  return supabase.channel('records-ch-' + childId)
    .on('postgres_changes',
      { event: '*', schema: 'public', table: 'daily_records', filter: 'child_id=eq.' + childId },
      () => onChange && onChange())
    .on('postgres_changes',
      { event: '*', schema: 'public', table: 'point_ledger', filter: 'child_id=eq.' + childId },
      () => onChange && onChange())
    .subscribe();
}
