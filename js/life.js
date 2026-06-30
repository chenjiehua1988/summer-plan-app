// ============================================================
// 生活项记录：运动 / 阅读 / 家务 / 屏幕时间
// ============================================================
import { state, todayStr, toast } from './supabase.js';
import * as db from './db.js';

const TYPES = ['运动', '阅读', '家务', '屏幕时间'];

export async function renderLife(view) {
  const childId = state.currentChildId;
  if (!childId) { view.innerHTML = `<div class="empty">请先添加孩子。</div>`; return; }
  const date = todayStr();
  view.innerHTML = `<div class="loading">加载中…</div>`;

  // 最近 7 天
  const to = new Date();
  const from = new Date(); from.setDate(to.getDate() - 6);
  const fromStr = fmt(from), toStr = fmt(to);
  let logs = [];
  try { logs = await db.fetchLifeLogs(childId, fromStr, toStr); }
  catch (e) { logs = []; }

  const todayLogs = logs.filter(l => l.date === date);

  view.innerHTML = `
    <div class="page-head">
      <div><div class="date-label">${date} 生活记录</div></div>
      <button class="btn-ghost btn-sm" id="refreshLife">刷新</button>
    </div>
    <div class="life-add">
      <select id="lType">${TYPES.map(t=>`<option>${t}</option>`).join('')}</select>
      <input id="lValue" type="text" placeholder="内容（如 跳绳200个 / 阅读30分钟）" />
      <button class="btn-primary btn-sm" id="lAdd">记录</button>
    </div>
    <div class="section-title">今日</div>
    ${todayLogs.length ? `<ul class="task-list">
      ${todayLogs.map(lifeRow).join('')}
    </ul>` : `<div class="empty">今日还没有记录。</div>`}
    <div class="section-title">最近 7 天</div>
    ${logs.length ? `<ul class="task-list">
      ${logs.map(lifeRow).join('')}
    </ul>` : `<div class="empty">最近 7 天没有记录。</div>`}
  `;

  view.querySelector('#refreshLife').onclick = () => renderLife(view);
  view.querySelector('#lAdd').onclick = async () => {
    const type = view.querySelector('#lType').value;
    const value = view.querySelector('#lValue').value.trim();
    if (!value) { toast('请输入内容'); return; }
    try {
      await db.addLifeLog({ child_id: childId, date, type, value });
      toast('已记录');
      renderLife(view);
    } catch (e) { toast('记录失败：' + e.message); }
  };
}

function lifeRow(l) {
  const icon = { '运动':'🏃', '阅读':'📖', '家务':'🧹', '屏幕时间':'📱' }[l.type] || '·';
  return `
    <li class="task-item">
      <div class="life-icon">${icon}</div>
      <div class="task-body" style="flex:1">
        <div class="task-title">${l.value}</div>
        <div class="task-meta">
          <span class="subj subj-生活">${l.type}</span>
          <small>${l.date}</small>
          ${l.note ? `<span class="note">${l.note}</span>` : ''}
        </div>
      </div>
    </li>`;
}

function fmt(d) {
  const y = d.getFullYear();
  const m = String(d.getMonth()+1).padStart(2,'0');
  const day = String(d.getDate()).padStart(2,'0');
  return `${y}-${m}-${day}`;
}
