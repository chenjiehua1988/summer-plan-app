// ============================================================
// 任务模板管理 + 每日打卡视图（按周期 + 标签）
// ============================================================
import { state, todayStr, toast } from './supabase.js';
import * as db from './db.js';

// 今日打卡视图：渲染当天 daily_records，按标签分组
export async function renderToday(view) {
  const childId = state.currentChildId;
  if (!childId) { view.innerHTML = `<div class="empty">请先在「设置」里添加孩子。</div>`; return; }
  if (!state.currentPlanId) {
    view.innerHTML = `<div class="empty">请先在顶栏选择或去「设置」创建一个学习周期。</div>`;
    return;
  }
  const date = todayStr();
  view.innerHTML = `<div class="loading">加载中…</div>`;
  let records = [];
  try { records = await db.ensureDailyRecords(childId, date, state.currentPlanId); }
  catch (e) { records = await db.getCachedRecords(childId, date); }

  const doneCount = records.filter(r => r.status === 'done' || r.status === 'verified').length;
  // 按标签分组（无标签归"其他"）
  const groups = {};
  records.forEach(r => {
    const tags = (r.tags && r.tags.length) ? r.tags : ['其他'];
    tags.forEach(tg => { (groups[tg] = groups[tg] || []).push(r); });
  });
  // 去重：一条记录可能出现在多个标签组
  const groupKeys = Object.keys(groups);

  view.innerHTML = `
    <div class="page-head">
      <div>
        <div class="date-label">${date}</div>
        <div class="progress-label">已完成 ${doneCount}/${records.length}</div>
      </div>
      <button class="btn-ghost btn-sm" id="refreshToday">刷新</button>
    </div>
    ${records.length === 0 ? `<div class="empty">今天还没有任务。去「设置」给当前周期/孩子添加任务清单。</div>` : ''}
    ${groupKeys.map(g => `
      <div class="task-group-head">${g}</div>
      <ul class="task-list">${groups[g].map(r => taskRow(r)).join('')}</ul>
    `).join('')}
  `;

  view.querySelector('#refreshToday').onclick = () => renderToday(view);
  view.querySelectorAll('.task-item').forEach(el => {
    const id = el.dataset.id;
    el.querySelector('.check').onclick = () => onToggle(id, el, records);
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
  // 标签小点（用家庭标签颜色，找不到用灰）
  const tagsHtml = (r.tags || []).map(tn => {
    const tg = state.tags.find(x => x.name === tn);
    const c = tg ? tg.color : '#aaa';
    return `<span class="tag-chip" style="background:${c}">${tn}</span>`;
  }).join('');
  return `
    <li class="task-item ${done ? 'is-done' : ''}" data-id="${r.id}">
      <button class="check ${done ? 'checked' : ''}" aria-label="完成">${done ? '✓' : ''}</button>
      <div class="task-body">
        <div class="task-title">${r.title}</div>
        <div class="task-meta">
          <span class="subj subj-${r.subject}">${r.subject}</span>
          ${tagsHtml}
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
    el.outerHTML = taskRow(r);
    const newEl = document.querySelector(`.task-item[data-id="${id}"]`);
    if (newEl) newEl.querySelector('.check').onclick = () => onToggle(id, newEl, records);
    const doneCount = records.filter(x => x.status === 'done' || x.status === 'verified').length;
    const pl = document.querySelector('.progress-label');
    if (pl) pl.textContent = `已完成 ${doneCount}/${records.length}`;
  } catch (e) { toast('操作失败：' + e.message); }
}

// ---------- 任务清单管理（设置页内嵌，绑「当前周期+孩子」+ 标签） ----------
export async function renderTemplates(container, childId) {
  if (!state.currentPlanId) {
    container.innerHTML = `<div class="empty">请先选择或创建一个学习周期。</div>`;
    return;
  }
  container.innerHTML = `<div class="loading">加载中…</div>`;
  const templates = await db.fetchTemplates(state.currentPlanId, childId);
  const tags = state.tags;

  container.innerHTML = `
    <div class="tmpl-add">
      <input id="tTitle" type="text" placeholder="任务名（如：口算100题）" class="grow" />
      <select id="tSubject">
        <option>语文</option><option>数学</option><option>英语</option><option>生活</option>
      </select>
      <input id="tMin" type="number" placeholder="分钟" value="30" style="width:60px" />
      <input id="tPts" type="number" placeholder="积分" value="1" style="width:54px" />
      <button class="btn-primary btn-sm" id="tAdd">添加</button>
    </div>
    ${tags.length ? `<div class="tag-pick" id="tagPick">
      ${tags.map(t => `<label data-tid="${t.id}"><input type="checkbox" value="${t.id}">${t.name}</label>`).join('')}
    </div>` : ''}
    ${templates.length ? templates.map(t => tmplRow(t, tags)).join('') : `<div class="empty">还没有任务，添加第一个吧。</div>`}
  `;

  // 标签选中样式
  container.querySelectorAll('#tagPick label').forEach(lb => {
    const cb = lb.querySelector('input');
    const sync = () => {
      lb.classList.toggle('on', cb.checked);
      const tg = tags.find(x => x.id === cb.value);
      if (cb.checked && tg) lb.style.background = tg.color;
      else lb.style.background = '';
    };
    cb.onchange = sync; sync();
  });

  container.querySelector('#tAdd').onclick = async () => {
    const title = container.querySelector('#tTitle').value.trim();
    if (!title) { toast('请输入任务名'); return; }
    const tagIds = [...container.querySelectorAll('#tagPick input:checked')].map(c => c.value);
    try {
      await db.addTemplate({
        plan_id: state.currentPlanId, child_id: childId,
        subject: container.querySelector('#tSubject').value,
        title, default_minutes: +container.querySelector('#tMin').value,
        points: +container.querySelector('#tPts').value, tagIds
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

function tmplRow(t, tags) {
  const tagHtml = (t.tagIds || []).map(id => {
    const tg = tags.find(x => x.id === id);
    return tg ? `<span class="tag-chip" style="background:${tg.color}">${tg.name}</span>` : '';
  }).join('');
  return `
    <div class="tmpl-row">
      <div class="tmpl-name">
        ${t.title} <small>${t.default_minutes}分·${t.points}分</small>
        <div style="margin-top:3px">${tagHtml}<span class="subj subj-${t.subject}" style="margin-left:4px">${t.subject}</span></div>
      </div>
      <button class="btn-ghost btn-sm" data-del="${t.id}">删除</button>
    </div>`;
}
