// ============================================================
// 数据访问层：CRUD + 离线缓存（IndexedDB）+ 断网打卡队列
// 设计：Supabase 为唯一权威源；IndexedDB 仅缓存近 14 天数据供离线浏览。
// 断网时打卡进入本地队列，联网后批量 upsert，带 updated_at 时间戳做 LWW。
// ============================================================
import { supabase, state, toast, actorName } from './supabase.js';

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

// ---------- 任务模板（绑「周期+孩子」） ----------
// fetchTemplates：取某周期某孩子的模板；带 tagIds
export async function fetchTemplates(planId, childId) {
  let q = supabase.from('task_templates').select('*').eq('family_id', state.family.id);
  if (planId) q = q.eq('plan_id', planId);
  if (childId) q = q.eq('child_id', childId);
  q = q.order('subject').order('created_at');
  const { data, error } = await q;
  if (error) throw error;
  // 附带 tagIds
  const list = data || [];
  if (list.length) {
    const { data: tt } = await supabase
      .from('task_tags').select('template_id, tag_id')
      .in('template_id', list.map(t => t.id));
    const map = {};
    (tt || []).forEach(r => (map[r.template_id] = map[r.template_id] || []).push(r.tag_id));
    list.forEach(t => t.tagIds = map[t.id] || []);
  }
  return list;
}
export async function addTemplate(t) {
  const row = { family_id: state.family.id, plan_id: t.plan_id, child_id: t.child_id,
    subject: t.subject, title: t.title, default_minutes: t.default_minutes ?? 30,
    points: t.points ?? 1, recurrence: t.recurrence ?? 'daily', active: t.active ?? true,
    start_date: t.start_date || null, end_date: t.end_date || null, weekdays: t.weekdays || [],
    instruction: t.instruction || null };
  const { data, error } = await supabase.from('task_templates').insert(row).select().single();
  if (error) throw error;
  // 关联标签
  if (t.tagIds && t.tagIds.length) {
    await supabase.from('task_tags').insert(t.tagIds.map(tid => ({ template_id: data.id, tag_id: tid })));
  }
  data.tagIds = t.tagIds || [];
  return data;
}
export async function deleteTemplate(id) {
  const { error } = await supabase.from('task_templates').delete().eq('id', id);
  if (error) throw error;
}
// 改任务：patch 含任务字段；tagIds 若提供则重置标签（tagIds 不是表字段，update 前剔除）
export async function updateTemplate(id, patch, tagIds) {
  const { tagIds: _omit, ...fields } = patch;  // 剔除 tagIds，不传给表
  const { data, error } = await supabase
    .from('task_templates').update(fields).eq('id', id).select().single();
  if (error) throw error;
  if (tagIds) {
    // 重置标签：先删全部，再加新的
    await supabase.from('task_tags').delete().eq('template_id', id);
    if (tagIds.length) {
      await supabase.from('task_tags').insert(tagIds.map(tid => ({ template_id: id, tag_id: tid })));
    }
    data.tagIds = tagIds;
  }
  return data;
}
// 复制某旧周期某孩子的模板到新周期（用于"从上周期复制"）
export async function copyTemplates(fromPlanId, toPlanId, childId) {
  const src = await fetchTemplates(fromPlanId, childId);
  if (!src.length) return 0;
  const rows = src.map(t => ({
    family_id: state.family.id, plan_id: toPlanId, child_id: childId,
    subject: t.subject, title: t.title, default_minutes: t.default_minutes,
    points: t.points, recurrence: t.recurrence, active: t.active
  }));
  const { data, error } = await supabase.from('task_templates').insert(rows).select();
  if (error) throw error;
  // 复制标签关联
  const ttRows = [];
  (data || []).forEach((nt, i) => {
    (src[i].tagIds || []).forEach(tid => ttRows.push({ template_id: nt.id, tag_id: tid }));
  });
  if (ttRows.length) await supabase.from('task_tags').insert(ttRows);
  return (data || []).length;
}

// ---------- 学习周期 ----------
export async function fetchPlans() {
  const { data, error } = await supabase
    .from('plans').select('*').eq('family_id', state.family.id).order('sort').order('created_at');
  if (error) throw error;
  return data || [];
}
export async function addPlan(p) {
  const row = { family_id: state.family.id, name: p.name, type: p.type || '日常',
    start_date: p.start_date || null, end_date: p.end_date || null,
    status: 'active', sort: p.sort ?? 0 };
  const { data, error } = await supabase.from('plans').insert(row).select().single();
  if (error) throw error;
  return data;
}
export async function updatePlan(id, patch) {
  const { data, error } = await supabase.from('plans').update(patch).eq('id', id).select().single();
  if (error) throw error;
  return data;
}
export async function deletePlan(id) {
  const { error } = await supabase.from('plans').delete().eq('id', id);
  if (error) throw error;
}

// ---------- 标签 ----------
export async function fetchTags() {
  const { data, error } = await supabase
    .from('tags').select('*').eq('family_id', state.family.id).order('sort').order('created_at');
  if (error) throw error;
  return data || [];
}
export async function addTag(name, color) {
  const { data, error } = await supabase.from('tags')
    .insert({ family_id: state.family.id, name, color: color || '#4f7cff' }).select().single();
  if (error) throw error;
  return data;
}
export async function updateTag(id, patch) {
  const { data, error } = await supabase.from('tags').update(patch).eq('id', id).select().single();
  if (error) throw error;
  return data;
}
export async function deleteTag(id) {
  const { error } = await supabase.from('tags').delete().eq('id', id);
  if (error) throw error;
}

// ---------- 每日记录 ----------
// 判断某模板在某天是否生效：起止范围内 且 周几匹配
function inSchedule(t, date, dow) {
  if (t.start_date && date < t.start_date) return false;
  if (t.end_date && date > t.end_date) return false;
  const wd = t.weekdays || [];
  if (wd.length && !wd.includes(dow)) return false;
  return true;
}
// 拉取某孩子某天的记录；若当天无记录，从「当前周期+孩子」active 模板自动生成
// 当天若是假期（day_off），生成的记录 status='skipped'
export async function ensureDailyRecords(childId, date, planId) {
  const pid = planId || state.currentPlanId;
  let q = supabase.from('daily_records').select('*').eq('child_id', childId).eq('date', date);
  if (pid) q = q.eq('plan_id', pid); else q = q.is('plan_id', null);
  const { data: existing, error } = await q;
  if (error) throw error;
  // 生成：必须有当前周期
  if (!pid) return existing || [];
  const templates = await fetchTemplates(pid, childId);
  const dow = new Date(date + 'T00:00:00').getDay();
  const active = templates.filter(t => t.active && inSchedule(t, date, dow));
  // 已有记录的 task_id 集合
  const existingTaskIds = new Set((existing || []).map(r => r.task_id));
  // 找出有模板但没记录的任务（新增的）
  const missing = active.filter(t => !existingTaskIds.has(t.id));
  if (existing && existing.length && !missing.length) {
    // 都有了，直接返回
    await cacheRecords(existing);
    return existing;
  }
  // 补生成缺失的（新增任务）
  const toGen = (existing && existing.length) ? missing : active;
  if (!toGen.length && !existing?.length) return [];
  // 是否假期
  let isDayOff = false;
  try {
    const { data: dof } = await supabase.from('day_off').select('id')
      .eq('plan_id', pid).eq('child_id', childId).eq('date', date).maybeSingle();
    isDayOff = !!dof;
  } catch (e) {}
  // 取标签名映射，写入 tags 快照
  const allTags = await fetchTags();
  const tagName = id => (allTags.find(tg => tg.id === id) || {}).name;
  const rows = toGen.map(t => ({
    family_id: state.family.id, plan_id: pid, child_id: childId, task_id: t.id, date,
    subject: t.subject, title: t.title, points: t.points,
    status: isDayOff ? 'skipped' : 'pending',
    instruction: t.instruction || null,
    tags: (t.tagIds || []).map(tagName).filter(Boolean)
  }));
  const { data: newRecs, error: ie } = await supabase.from('daily_records').insert(rows).select();
  if (ie) throw ie;
  const all = [...(existing || []), ...(newRecs || [])];
  await cacheRecords(all);
  return all;
}

// 拉取某孩子一段日期范围的记录（统计用）
export async function fetchRecordsRange(childId, fromDate, toDate) {
  let q = supabase.from('daily_records').select('*').eq('child_id', childId)
    .gte('date', fromDate).lte('date', toDate).order('date');
  const { data, error } = await q;
  if (error) throw error;
  return data || [];
}
// 拉取某周期某孩子全部记录（统计用）
export async function fetchRecordsByPlan(planId, childId) {
  const { data, error } = await supabase.from('daily_records').select('*')
    .eq('plan_id', planId).eq('child_id', childId).order('date');
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

// 验收：把记录置为 verified/rejected（仅父母），写一条验收操作流水
export async function verifyRecord(id, status, note) {
  const patch = { status, note: note ?? null,
    verified_at: new Date().toISOString(), verified_by: actorName() };
  const data = await updateRecord(id, patch);
  // 写验收操作流水
  try {
    await supabase.from('verify_logs').insert({
      family_id: state.family.id, record_id: id, child_id: data.child_id, title: data.title,
      action: status === 'verified' ? 'pass' : 'reject',
      note: note || null, operator: actorName()
    });
  } catch (e) { console.warn('verify_log failed', e.message); }
  return data;
}

// 撤销验收：verified → rejected（打回重写），删除该 record 的加分流水（净扣回分）
// 孩子看到"被打回"知道要重做；重做打卡后再验收，判重触发器看无流水会重新加
export async function revokeVerify(id) {
  // 查 child_id/title 用于写流水
  const { data: rec } = await supabase.from('daily_records').select('child_id,title').eq('id', id).single();
  // 删除该 record 的加分流水（delta>0）
  const { error: e1 } = await supabase.from('point_ledger')
    .delete().eq('source_record_id', id).gt('delta', 0);
  if (e1) throw e1;
  // 状态置 rejected（打回），清验收字段
  const patch = { status: 'rejected', verified_at: null, verified_by: null,
    updated_at: new Date().toISOString() };
  const data = await updateRecord(id, patch);
  // 写撤销流水
  try {
    await supabase.from('verify_logs').insert({
      family_id: state.family.id, record_id: id, child_id: rec?.child_id || data.child_id, title: rec?.title || data.title,
      action: 'revoke', note: '撤销验收，打回重写', operator: actorName()
    });
  } catch (e) { console.warn('verify_log failed', e.message); }
  return data;
}

// ---------- 生活项 ----------
export async function fetchLifeLogs(childId, fromDate, toDate) {
  const { data, error } = await supabase.from('life_logs').select('*')
    .eq('child_id', childId).gte('date', fromDate).lte('date', toDate).order('date');
  if (error) throw error;
  return data || [];
}
export async function addLifeLog(row) {
  const payload = { ...row, family_id: state.family.id, created_by: actorName() };
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
// 按日期范围查积分流水（用于积分明细，避免一次查全部）
export async function fetchLedgerRange(childId, fromDate, toDate) {
  let q = supabase.from('point_ledger').select('*').eq('child_id', childId)
    .order('created_at', { ascending: false });
  if (fromDate) q = q.gte('created_at', fromDate + 'T00:00:00');
  if (toDate) q = q.lte('created_at', toDate + 'T23:59:59');
  const { data, error } = await q;
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
export async function redeemReward(childId, shopItem) {
  // shopItem: { id, name, cost_points }
  // 扣减积分：写一条负数流水 + 一条奖励记录
  const { error: e1 } = await supabase.from('point_ledger').insert({
    family_id: state.family.id, child_id: childId,
    delta: -shopItem.cost_points, reason: '兑换奖励：' + shopItem.name, created_by: actorName()
  });
  if (e1) throw e1;
  const { data, error: e2 } = await supabase.from('rewards').insert({
    family_id: state.family.id, child_id: childId, shop_id: shopItem.id || null,
    name: shopItem.name, cost_points: shopItem.cost_points, redeemed_by: actorName()
  }).select().single();
  if (e2) throw e2;
  return data;
}

// ---------- 兑换商店目录 ----------
export async function fetchShop() {
  const { data, error } = await supabase.from('reward_shop').select('*')
    .eq('family_id', state.family.id).order('sort').order('created_at');
  if (error) throw error;
  return data || [];
}
export async function addShopItem(item) {
  const row = { family_id: state.family.id, name: item.name,
    cost_points: item.cost_points, icon: item.icon || '🎁',
    active: item.active ?? true, sort: item.sort ?? 0,
    custom_points: item.custom_points ?? false };
  const { data, error } = await supabase.from('reward_shop').insert(row).select().single();
  if (error) throw error;
  return data;
}
export async function updateShopItem(id, patch) {
  const { data, error } = await supabase.from('reward_shop').update(patch).eq('id', id).select().single();
  if (error) throw error;
  return data;
}
export async function deleteShopItem(id) {
  const { error } = await supabase.from('reward_shop').delete().eq('id', id);
  if (error) throw error;
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
    .on('postgres_changes',
      { event: '*', schema: 'public', table: 'day_off', filter: 'child_id=eq.' + childId },
      () => onChange && onChange())
    .subscribe();
}

// ---------- 周期类型 ----------
export async function fetchPlanTypes() {
  const { data, error } = await supabase
    .from('plan_types').select('*').eq('family_id', state.family.id).order('sort').order('created_at');
  if (error) throw error;
  return data || [];
}
export async function addPlanType(name) {
  const { data, error } = await supabase.from('plan_types')
    .insert({ family_id: state.family.id, name }).select().single();
  if (error) throw error;
  return data;
}
export async function deletePlanType(id) {
  const { error } = await supabase.from('plan_types').delete().eq('id', id);
  if (error) throw error;
}

// ---------- 假期/请假 ----------
export async function fetchDayOffs(planId, childId) {
  const { data, error } = await supabase.from('day_off').select('*')
    .eq('plan_id', planId).eq('child_id', childId);
  if (error) throw error;
  return data || [];
}
export async function markDayOff(planId, childId, date, reason) {
  // upsert（unique plan_id+child_id+date）
  const { data, error } = await supabase.from('day_off').upsert(
    { family_id: state.family.id, plan_id: planId, child_id: childId, date, reason: reason || null },
    { onConflict: 'plan_id,child_id,date' }
  ).select().single();
  if (error) throw error;
  // 当天已生成任务转 skipped
  await supabase.from('daily_records').update({ status: 'skipped' })
    .eq('plan_id', planId).eq('child_id', childId).eq('date', date);
  return data;
}
export async function unmarkDayOff(planId, childId, date) {
  const { error } = await supabase.from('day_off').delete()
    .eq('plan_id', planId).eq('child_id', childId).eq('date', date);
  if (error) throw error;
  // skipped 任务恢复 pending
  await supabase.from('daily_records').update({ status: 'pending' })
    .eq('plan_id', planId).eq('child_id', childId).eq('date', date).eq('status', 'skipped');
}
// 批量标记一段日期为假期（含首尾）
export async function markDayOffRange(planId, childId, fromDate, toDate, reason) {
  const dates = [];
  const d = new Date(fromDate);
  const end = new Date(toDate);
  for (; d <= end; d.setDate(d.getDate() + 1)) {
    const y = d.getFullYear();
    const m = String(d.getMonth() + 1).padStart(2, '0');
    const day = String(d.getDate()).padStart(2, '0');
    dates.push(`${y}-${m}-${day}`);
  }
  const rows = dates.map(dt => ({
    family_id: state.family.id, plan_id: planId, child_id: childId, date: dt, reason: reason || null
  }));
  const { error } = await supabase.from('day_off').upsert(rows, { onConflict: 'plan_id,child_id,date' });
  if (error) throw error;
  // 这些天已生成任务转 skipped
  if (dates.length) {
    await supabase.from('daily_records').update({ status: 'skipped' })
      .eq('plan_id', planId).eq('child_id', childId).in('date', dates);
  }
  return dates.length;
}

// ---------- 照片上传（前端压缩 + Storage） ----------
// 压缩图片：长边 1280，JPEG 0.7
async function compressImage(file, maxSide = 1280, quality = 0.7) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    const url = URL.createObjectURL(file);
    img.onload = () => {
      let { width, height } = img;
      if (width > maxSide || height > maxSide) {
        if (width >= height) { height = Math.round(height * maxSide / width); width = maxSide; }
        else { width = Math.round(width * maxSide / height); height = maxSide; }
      }
      const canvas = document.createElement('canvas');
      canvas.width = width; canvas.height = height;
      const ctx = canvas.getContext('2d');
      ctx.drawImage(img, 0, 0, width, height);
      URL.revokeObjectURL(url);
      canvas.toBlob(b => b ? resolve(b) : reject(new Error('压缩失败')), 'image/jpeg', quality);
    };
    img.onerror = () => { URL.revokeObjectURL(url); reject(new Error('图片加载失败')); };
    img.src = url;
  });
}

// 上传一张照片，返回 public URL
export async function uploadPhoto(recordId, file) {
  const blob = await compressImage(file);
  const fam = state.family.id;
  const ts = Date.now();
  const path = `${fam}/${recordId}/${ts}_${Math.random().toString(36).slice(2, 6)}.jpg`;
  const { error } = await supabase.storage.from('verify-photos').upload(path, blob, {
    contentType: 'image/jpeg', upsert: false
  });
  if (error) throw error;
  const { data: pub } = supabase.storage.from('verify-photos').getPublicUrl(path);
  return pub.publicUrl;
}

// 给记录追加照片路径（不覆盖已有）
export async function appendPhotos(recordId, newUrls) {
  const { data: rec, error: e1 } = await supabase
    .from('daily_records').select('photos').eq('id', recordId).single();
  if (e1) throw e1;
  const existing = rec.photos || [];
  const merged = [...existing, ...newUrls];
  const { data, error } = await supabase
    .from('daily_records').update({ photos: merged, updated_at: new Date().toISOString() })
    .eq('id', recordId).select().single();
  if (error) throw error;
  await cacheRecords([data]);
  return data;
}

// ---------- 录音上传 ----------
// 上传一段音频 blob，返回 public URL。ext: mp4/webm/ogg 等
export async function uploadAudio(recordId, blob, ext) {
  const fam = state.family.id;
  const ts = Date.now();
  const path = `audio/${fam}/${recordId}/${ts}_${Math.random().toString(36).slice(2, 6)}.${ext}`;
  const { error } = await supabase.storage.from('verify-photos').upload(path, blob, {
    contentType: blob.type || `audio/${ext}`, upsert: false
  });
  if (error) throw error;
  const { data: pub } = supabase.storage.from('verify-photos').getPublicUrl(path);
  return pub.publicUrl;
}
// 给记录追加音频路径
export async function appendAudios(recordId, newUrls) {
  const { data: rec, error: e1 } = await supabase
    .from('daily_records').select('audios').eq('id', recordId).single();
  if (e1) throw e1;
  const existing = rec.audios || [];
  const merged = [...existing, ...newUrls];
  const { data, error } = await supabase
    .from('daily_records').update({ audios: merged, updated_at: new Date().toISOString() })
    .eq('id', recordId).select().single();
  if (error) throw error;
  await cacheRecords([data]);
  return data;
}

// ---------- 打卡流水（checkins，1对多） ----------
// 新增一条打卡记录（含备注/照片/录音），同时更新 daily_records 最近快照
export async function addCheckin(rec, payload) {
  // rec: daily_records 行；payload: {note, photos[], audios[], title}
  // 只写一条 checkins 流水（本次打卡内容）。daily_records 快照由调用方更新（避免覆盖/重复）。
  const row = {
    family_id: state.family.id, record_id: rec.id, child_id: rec.child_id,
    plan_id: rec.plan_id || state.currentPlanId, task_id: rec.task_id || null,
    date: rec.date, title: payload.title || rec.title,
    note: payload.note || null, photos: payload.photos || [], audios: payload.audios || [],
    created_by: actorName()
  };
  const { data, error } = await supabase.from('checkins').insert(row).select().single();
  if (error) throw error;
  return data;
}
// 取某任务（record）当天所有打卡记录，倒序
export async function fetchCheckins(recordId) {
  const { data, error } = await supabase.from('checkins').select('*')
    .eq('record_id', recordId).order('created_at', { ascending: false });
  if (error) throw error;
  return data || [];
}
// 取某孩子某天所有打卡记录（按孩子+日期）
export async function fetchCheckinsByDate(childId, date) {
  const { data, error } = await supabase.from('checkins').select('*')
    .eq('child_id', childId).eq('date', date).order('created_at', { ascending: false });
  if (error) throw error;
  return data || [];
}

// ---------- 奖惩结算 ----------
// 结算当天：未verified任务扣分，全完成计连续天数+奖励
export async function settleDay(childId, date) {
  const fam = state.family;
  // 查当天所有非skipped记录
  const { data: recs } = await supabase.from('daily_records').select('*')
    .eq('child_id', childId).eq('date', date).neq('status', 'skipped');
  const tasks = recs || [];
  if (!tasks.length) return { err: '当天没有任务' };

  // 未verified的扣分
  const unfinished = tasks.filter(r => r.status !== 'verified');
  let deducted = 0;
  const dateShort = date.slice(5); // MM-DD
  for (const r of unfinished) {
    await supabase.from('point_ledger').insert({
      family_id: fam.id, child_id: childId, delta: -r.points,
      reason: `${dateShort}未完成：${r.title}`, created_by: actorName()
    });
    deducted += r.points;
  }

  // 全完成则计连续天数
  let streak = 0;
  let bonus = 0;
  if (!unfinished.length) {
    // 往前数连续全verified的天数（含今天）
    streak = 1;
    const d = new Date(date + 'T00:00:00');
    for (;;) {
      d.setDate(d.getDate() - 1);
      const ds = d.getFullYear() + '-' + String(d.getMonth()+1).padStart(2,'0') + '-' + String(d.getDate()).padStart(2,'0');
      const { data: prev } = await supabase.from('daily_records').select('status')
        .eq('child_id', childId).eq('date', ds).neq('status', 'skipped');
      if (!prev || !prev.length) break; // 没任务不算
      if (prev.every(r => r.status === 'verified')) streak++;
      else break;
    }
    // 达标奖励
    const streakDays = fam.streak_days || 5;
    const streakBonus = fam.streak_bonus || 50;
    if (streak >= streakDays && streak % streakDays === 0) {
      // 每 streakDays 天奖励一次（第5天、第10天...）
      await supabase.from('point_ledger').insert({
        family_id: fam.id, child_id: childId, delta: streakBonus,
        reason: `${dateShort}连续${streakDays}天全部完成奖励`, created_by: '系统'
      });
      bonus = streakBonus;
    }
  }

  // 记录结算日期（防重复）
  await supabase.from('families').update({ last_settle_date: date }).eq('id', fam.id);

  return { deducted, streak, bonus, unfinished: unfinished.length };
}

// ---------- 验收操作流水 ----------
// 取某孩子某天所有验收操作（按时间倒序）
export async function fetchVerifyLogsByDate(childId, date) {
  const { data, error } = await supabase.from('verify_logs').select('*')
    .eq('child_id', childId)
    .gte('created_at', date + 'T00:00:00')
    .lte('created_at', date + 'T23:59:59')
    .order('created_at', { ascending: false });
  if (error) throw error;
  return data || [];
}

// ---------- 兑换申请 ----------

// 孩子发起申请
export async function addRedeemRequest(childId, shopItem) {
  const row = { family_id: state.family.id, child_id: childId,
    shop_id: shopItem.id || null, name: shopItem.name, cost_points: shopItem.cost_points,
    status: 'pending' };
  const { data, error } = await supabase.from('redeem_requests').insert(row).select().single();
  if (error) throw error;
  return data;
}
// 取某孩子的申请（孩子端看）
export async function fetchRedeemRequestsByChild(childId) {
  const { data, error } = await supabase.from('redeem_requests').select('*')
    .eq('child_id', childId).order('created_at', { ascending: false });
  if (error) throw error;
  return data || [];
}
// 取全家庭 pending 申请（家长端审批）
export async function fetchPendingRequests() {
  const { data, error } = await supabase.from('redeem_requests').select('*')
    .eq('family_id', state.family.id).eq('status', 'pending')
    .order('created_at', { ascending: false });
  if (error) throw error;
  return data || [];
}

// 家长审批：approve → 扣分 + 写 rewards + 置 approved；reject → 置 rejected
export async function decideRedeemRequest(req, approve) {
  if (approve) {
    // 校验余额
    const bal = await fetchPointBalance(req.child_id);
    if (req.cost_points > bal) throw new Error('孩子积分不足（当前 ' + bal + ' 分）');
    // 扣分流水
    const { error: e1 } = await supabase.from('point_ledger').insert({
      family_id: state.family.id, child_id: req.child_id,
      delta: -req.cost_points, reason: '兑换奖励：' + req.name, created_by: actorName()
    });
    if (e1) throw e1;
    // rewards 记录
    const { error: e2 } = await supabase.from('rewards').insert({
      family_id: state.family.id, child_id: req.child_id, shop_id: req.shop_id || null,
      name: req.name, cost_points: req.cost_points, redeemed_by: actorName()
    });
    if (e2) throw e2;
  }
  // 置状态
  const { data, error } = await supabase.from('redeem_requests').update({
    status: approve ? 'approved' : 'rejected',
    decided_by: actorName(), decided_at: new Date().toISOString()
  }).eq('id', req.id).select().single();
  if (error) throw error;
  return data;
}
