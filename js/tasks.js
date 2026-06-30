// ============================================================
// 任务模板管理 + 每日打卡视图
// ============================================================
import { state, todayStr, toast } from './supabase.js';
import * as db from './db.js';

// 今日打卡视图：渲染当天的 daily_records，孩子侧勾选完成
export async function renderToday(view) {
  const childId = state.currentChildId;
  if (!childId) {
    view.innerHTML = `<div class="empty">请先在「设置」里添加孩子。</div>`;
    return;
  }
  const date = todayStr();
  view.innerHTML = `<div class="loading">加载中…</div>`;
  let records = [];
  try {
    records = await db.ensureDailyRecords(childId, date);
  } catch (e) {
    // 离线兜底
    records = await db.getCachedRecords(childId, date);
  }

  const doneCount = records.filter(r => r.status === 'done' || r.status === 'verified').length;
  const html = `
    <div class="page-head">
      <div>
        <div class="date-label">${date}</div>
        <div class="progress-label">已完成 ${doneCount}/${records.length}</div>
      </div>
      <button class="btn-ghost btn-sm" id="refreshToday">刷新</button>
    </div>
    ${records.length === 0 ? `<div class="empty">今天还没有任务。去「设置」添加任务模板吧。</div>` : ''}
    <ul class="task-list">
      ${records.map(r => taskRow(r)).join('')}
    </ul>
  `;
  view.innerHTML = html;

  view.querySelector('#refreshToday').onclick = () => renderToday(view);
  view.querySelectorAll('.task-item').forEach(el => {
    const id = el.dataset.id;
    const check = el.querySelector('.check');
    check.onclick = () => onToggle(id, el, records);
  });
}

function taskRow(r) {
  const done = r.status === 'done' || r.status === 'verified';
  const verified = r.status === 'verified';
  const rejected = r.status === 'rejected';
  const tag = verified ? `<span class="badge badge-ok">已验收</span>`
            : rejected ? `<span class="badge badge-no">被打回</span>`
            : done ? `<span class="badge badge-mid">待验收</span>`
            : ``;
  return `
    <li class="task-item ${done ? 'is-done' : ''}" data-id="${r.id}">
      <button class="check ${done ? 'checked' : ''}" aria-label="完成">${done ? '✓' : ''}</button>
      <div class="task-body">
        <div class="task-title">${r.title}</div>
        <div class="task-meta">
          <span class="subj subj-${r.subject}">${r.subject}</span>
          ${tag}
          ${r.note ? `<span class="note">📝 ${r.note}</span>` : ''}
        </div>
      </div>
      <div class="task-pts">+${r.points}</div>
    </li>`;
}

async function onToggle(id, el, records) {
  const r = records.find(x => x.id === id);
  if (!r) return;
  if (r.status === 'verified') { toast('已验收，不能取消'); return; }
  const willDone = !(r.status === 'done');
  const patch = willDone
    ? { status: 'done', completed_at: new Date().toISOString(), completed_by: state.currentRole }
    : { status: 'pending', completed_at: null, completed_by: null };
  try {
    await db.updateRecord(id, patch);
    Object.assign(r, patch);
    // 局部刷新这一行
    el.outerHTML = taskRow(r);
    const newEl = document.querySelector(`.task-item[data-id="${id}"]`);
    if (newEl) newEl.querySelector('.check').onclick = () => onToggle(id, newEl, records);
    // 更新进度
    const doneCount = records.filter(x => x.status === 'done' || x.status === 'verified').length;
    const pl = document.querySelector('.progress-label');
    if (pl) pl.textContent = `已完成 ${doneCount}/${records.length}`;
  } catch (e) {
    toast('操作失败：' + e.message);
  }
}

// ---------- 任务模板管理（设置页内嵌） ----------
export async function renderTemplates(container, childId) {
  container.innerHTML = `<div class="loading">加载中…</div>`;
  const templates = await db.fetchTemplates(childId);
  const bySubject = { '语文': [], '数学': [], '英语': [], '生活': [] };
  templates.forEach(t => (bySubject[t.subject] || (bySubject[t.subject] = [])).push(t));

  container.innerHTML = `
    <div class="tmpl-add">
      <input id="tTitle" type="text" placeholder="任务名（如：口算100题）" />
      <select id="tSubject">
        <option>语文</option><option>数学</option><option>英语</option><option>生活</option>
      </select>
      <input id="tMin" type="number" placeholder="分钟" value="30" style="width:64px" />
      <input id="tPts" type="number" placeholder="积分" value="1" style="width:56px" />
      <button class="btn-primary btn-sm" id="tAdd">添加</button>
    </div>
    ${Object.entries(bySubject).map(([subj, arr]) => arr.length ? `
      <div class="tmpl-group">
        <div class="tmpl-group-head"><span class="subj subj-${subj}">${subj}</span></div>
        ${arr.map(t => `
          <div class="tmpl-row">
            <div class="tmpl-name">${t.title} <small>${t.default_minutes}分·${t.points}分</small></div>
            <button class="btn-ghost btn-sm" data-del="${t.id}">删除</button>
          </div>`).join('')}
      </div>` : '').join('')}
    ${templates.length === 0 ? `<div class="empty">还没有任务模板，添加第一个吧。</div>` : ''}
  `;

  container.querySelector('#tAdd').onclick = async () => {
    const title = container.querySelector('#tTitle').value.trim();
    if (!title) { toast('请输入任务名'); return; }
    try {
      await db.addTemplate({
        child_id: childId, subject: container.querySelector('#tSubject').value,
        title, default_minutes: +container.querySelector('#tMin').value,
        points: +container.querySelector('#tPts').value
      });
      toast('已添加');
      renderTemplates(container, childId);
    } catch (e) { toast('添加失败：' + e.message); }
  };
  container.querySelectorAll('[data-del]').forEach(b => {
    b.onclick = async () => {
      try { await db.deleteTemplate(b.dataset.del); toast('已删除'); renderTemplates(container, childId); }
      catch (e) { toast('删除失败：' + e.message); }
    };
  });
}
