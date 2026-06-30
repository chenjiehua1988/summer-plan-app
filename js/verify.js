// ============================================================
// 父母验收视图：展示孩子已完成的任务，验收通过 / 打回
// ============================================================
import { state, todayStr, toast } from './supabase.js';
import * as db from './db.js';

export async function renderVerify(view) {
  const childId = state.currentChildId;
  if (!childId) { view.innerHTML = `<div class="empty">请先添加孩子。</div>`; return; }
  if (!state.currentPlanId) { view.innerHTML = `<div class="empty">请先选择一个学习周期。</div>`; return; }
  const date = todayStr();
  view.innerHTML = `<div class="loading">加载中…</div>`;
  let records = [];
  try { records = await db.ensureDailyRecords(childId, date, state.currentPlanId); }
  catch (e) { records = await db.getCachedRecords(childId, date); }

  const pending = records.filter(r => r.status === 'done');
  const verified = records.filter(r => r.status === 'verified');
  const rejected = records.filter(r => r.status === 'rejected');

  view.innerHTML = `
    <div class="page-head">
      <div><div class="date-label">${date} 验收</div>
      <div class="progress-label">待验收 ${pending.length} · 已验收 ${verified.length}</div></div>
      <button class="btn-ghost btn-sm" id="refreshVerify">刷新</button>
    </div>
    ${pending.length ? `<div class="section-title">待验收</div>
      <ul class="task-list">${pending.map(verifyRow).join('')}</ul>` : `<div class="empty">没有待验收的任务。</div>`}
    ${verified.length ? `<div class="section-title">今日已验收</div>
      <ul class="task-list">${verified.map(doneRow).join('')}</ul>` : ''}
    ${rejected.length ? `<div class="section-title">今日被打回</div>
      <ul class="task-list">${rejected.map(doneRow).join('')}</ul>` : ''}
  `;

  view.querySelector('#refreshVerify').onclick = () => renderVerify(view);
  view.querySelectorAll('[data-act]').forEach(b => {
    b.onclick = async () => {
      const id = b.dataset.id;
      const act = b.dataset.act;
      const noteEl = view.querySelector(`.vnote[data-for="${id}"]`);
      const note = noteEl ? noteEl.value.trim() : '';
      try {
        await db.verifyRecord(id, act === 'pass' ? 'verified' : 'rejected', note);
        toast(act === 'pass' ? '已验收并加分 ✓' : '已打回');
        renderVerify(view);
        if (window.refreshPointBadge) window.refreshPointBadge();
      } catch (e) { toast('操作失败：' + e.message); }
    };
  });
}

function verifyRow(r) {
  return `
    <li class="task-item" data-id="${r.id}">
      <div class="task-body" style="flex:1">
        <div class="task-title">${r.title}</div>
        <div class="task-meta">
          <span class="subj subj-${r.subject}">${r.subject}</span>
          <span class="note">+${r.points} 分</span>
        </div>
        <input class="vnote" data-for="${r.id}" type="text" placeholder="备注（可选）" />
      </div>
      <div class="verify-btns">
        <button class="btn-primary btn-sm" data-act="pass" data-id="${r.id}">通过</button>
        <button class="btn-ghost btn-sm" data-act="reject" data-id="${r.id}">打回</button>
      </div>
    </li>`;
}
function doneRow(r) {
  const cls = r.status === 'verified' ? 'badge-ok' : 'badge-no';
  const txt = r.status === 'verified' ? '已验收' : '已打回';
  return `
    <li class="task-item is-done">
      <div class="task-body" style="flex:1">
        <div class="task-title">${r.title}</div>
        <div class="task-meta">
          <span class="subj subj-${r.subject}">${r.subject}</span>
          <span class="badge ${cls}">${txt}</span>
          ${r.note ? `<span class="note">📝 ${r.note}</span>` : ''}
        </div>
      </div>
    </li>`;
}
