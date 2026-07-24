// ============================================================
// 统计报表（按学习周期）：总进度、倒计时、按标签/科目、历史对比、近7天
// ============================================================
import { state, todayStr, mdhm } from './supabase.js';
import * as db from './db.js';
import { viewFullPhoto } from './photo-viewer.js';

let _renderToken = 0; // 防止渲染期间被新的一次调用抢先，导致操作已被替换的旧DOM

export async function renderStats(view) {
  const myToken = ++_renderToken;
  const childId = state.currentChildId;
  if (!childId) { view.innerHTML = `<div class="empty">请先添加孩子。</div>`; return; }
  if (!state.currentPlanId) { view.innerHTML = `<div class="empty">请先选择一个学习周期。</div>`; return; }
  const plan = state.plans.find(p => p.id === state.currentPlanId);
  view.innerHTML = `<div class="loading">加载中…</div>`;

  // 当前周期记录
  let records = [];
  try { records = await db.fetchRecordsByPlan(state.currentPlanId, childId); }
  catch (e) { records = []; }
  if (myToken !== _renderToken) return; // 已被更新的一次渲染取代，放弃

  // 排除 skipped（假期免打卡）后统计
  const eff = records.filter(r => r.status !== 'skipped');
  const total = eff.length;
  const verified = eff.filter(r => r.status === 'verified').length;
  const done = eff.filter(r => r.status === 'done' || r.status === 'verified').length;
  const rate = total ? Math.round((verified / total) * 100) : 0;
  const points = eff.filter(r => r.status === 'verified').reduce((s, r) => s + (r.points || 0), 0);
  const skippedCount = records.length - eff.length;
  const today = todayStr();
  // 连续打卡天数：统一口径（不算当天、假期跳过、once例外、当前周期内）
  let streak = 0;
  try { streak = await db.calcConsecutiveDays(childId, today, state.currentPlanId, plan?.start_date); } catch (e) {}
  if (myToken !== _renderToken) return; // 已被更新的一次渲染取代，放弃

  // 假期天数
  let dayOffCount = 0;
  try { dayOffCount = (await db.fetchDayOffs(state.currentPlanId, childId)).length; } catch (e) {}
  if (myToken !== _renderToken) return; // 已被更新的一次渲染取代，放弃

  // 倒计时/天数
  let totalDays = 0, passedDays = 0, leftDays = null, progressPct = 0;
  if (plan?.start_date && plan?.end_date) {
    totalDays = Math.max(1, Math.round((new Date(plan.end_date) - new Date(plan.start_date)) / 86400000) + 1);
    passedDays = Math.max(0, Math.min(totalDays, Math.round((new Date(today) - new Date(plan.start_date)) / 86400000) + 1));
    leftDays = Math.ceil((new Date(plan.end_date) - new Date(today)) / 86400000);
    progressPct = Math.round(passedDays / totalDays * 100);
  }

  // 按标签完成率（排除 skipped）
  const byTag = {};
  eff.forEach(r => {
    const tags = (r.tags && r.tags.length) ? r.tags : ['(无标签)'];
    tags.forEach(tn => {
      byTag[tn] = byTag[tn] || { count: 0, verified: 0 };
      byTag[tn].count++;
      if (r.status === 'verified') byTag[tn].verified++;
    });
  });
  // 按科目完成率（排除 skipped）
  const bySubject = {};
  eff.forEach(r => {
    bySubject[r.subject] = bySubject[r.subject] || { count: 0, verified: 0 };
    bySubject[r.subject].count++;
    if (r.status === 'verified') bySubject[r.subject].verified++;
  });

  // 历史对比：所有周期该孩子的完成率
  let comparisons = [];
  try {
    const others = state.plans.filter(p => p.id !== state.currentPlanId);
    comparisons = await Promise.all(others.map(async p => {
      const rs = (await db.fetchRecordsByPlan(p.id, childId)).filter(r => r.status !== 'skipped');
      const v = rs.filter(r => r.status === 'verified').length;
      const t = rs.length;
      return { name: p.name, rate: t ? Math.round(v / t * 100) : 0, v, t, status: p.status };
    }));
  } catch (e) {}
  if (myToken !== _renderToken) return; // 已被更新的一次渲染取代，放弃

  // 近 7 天柱状
  const last7 = [];
  for (let i = 6; i >= 0; i--) {
    const d = new Date(); d.setDate(new Date(today).getDate() - i);
    const ds = fmt(d);
    last7.push({ ds: ds.slice(5), count: records.filter(r => r.date === ds && (r.status === 'done' || r.status === 'verified')).length });
  }
  const maxDay = Math.max(1, ...last7.map(d => d.count));

  view.innerHTML = `
    <div class="page-head"><div><div class="date-label">${plan ? plan.name : '统计'}</div>
      <div class="progress-label">${plan?.start_date || ''} ${plan?.end_date ? '~ ' + plan.end_date : ''}</div></div></div>

    ${plan?.start_date && plan?.end_date ? `
      <div class="countdown-bar">
        <div class="cb-row"><span>周期进度</span><span>${passedDays}/${totalDays} 天 · ${leftDays != null ? (leftDays > 0 ? '剩 ' + leftDays + ' 天' : leftDays === 0 ? '今天截止' : '已结束') : ''}</span></div>
        <div class="cb-track"><div class="cb-fill" style="width:${progressPct}%"></div></div>
      </div>` : ''}

    <div class="stat-cards">
      <div class="stat-card"><div class="stat-num">${rate}%</div><div class="stat-lab">验收完成率</div></div>
      <div class="stat-card" id="streakCard" style="cursor:pointer"><div class="stat-num">${streak}</div><div class="stat-lab">连续打卡(天) ⓘ</div></div>
      <div class="stat-card"><div class="stat-num">${points}</div><div class="stat-lab">周期积分</div></div>
      <div class="stat-card"><div class="stat-num">${dayOffCount}</div><div class="stat-lab">假期天数</div></div>
    </div>
    <div class="row-hint" style="margin:-4px 2px 8px">验收 ${verified}/${total} · 免打卡 ${skippedCount}</div>

    <div class="section-title">按标签完成率</div>
    ${Object.keys(byTag).length ? `<div class="subj-stats">
      ${Object.entries(byTag).map(([tn, v]) => {
        const sr = v.count ? Math.round(v.verified / v.count * 100) : 0;
        const tg = state.tags.find(x => x.name === tn);
        const c = tg ? tg.color : '#aaa';
        return `<div class="subj-stat-row">
          <span class="tag-chip" style="background:${c}">${tn}</span>
          <div class="bar"><div class="bar-fill" style="width:${sr}%"></div></div>
          <span class="bar-num">${v.verified}/${v.count}</span>
        </div>`;
      }).join('')}
    </div>` : `<div class="empty">暂无数据。</div>`}

    <div class="section-title">按科目完成率</div>
    ${Object.keys(bySubject).length ? `<div class="subj-stats">
      ${Object.entries(bySubject).map(([s, v]) => {
        const sr = v.count ? Math.round(v.verified / v.count * 100) : 0;
        return `<div class="subj-stat-row">
          <span class="subj subj-${s}">${s}</span>
          <div class="bar"><div class="bar-fill" style="width:${sr}%"></div></div>
          <span class="bar-num">${v.verified}/${v.count}</span>
        </div>`;
      }).join('')}
    </div>` : `<div class="empty">暂无数据。</div>`}

    <div class="section-title">近 7 天完成数</div>
    <div class="chart">
      ${last7.map(d => `
        <div class="bar-col">
          <div class="bar-bar" style="height:${Math.round(d.count/maxDay*100)}%"></div>
          <div class="bar-lab">${d.count}</div>
          <div class="bar-x">${d.ds}</div>
        </div>`).join('')}
    </div>

    ${comparisons.length ? `
      <div class="section-title">历史周期对比</div>
      <div class="plan-cards">
        ${comparisons.map(c => `
          <div class="plan-card">
            <div class="pc-name">${c.name}${c.status === 'archived' ? ' ·归档' : ''}</div>
            <div class="pc-rate">${c.rate}%</div>
            <div class="pc-meta">${c.v}/${c.t} 已验收</div>
          </div>`).join('')}
      </div>` : ''}

    <div class="section-title">明细查询</div>
    <div class="detail-query-bar">
      <div class="detail-query-row">
        <input type="date" id="detailFrom" value="${today}" class="detail-date-input">
        <span style="color:var(--muted);font-size:12px">至</span>
        <input type="date" id="detailTo" value="${today}" class="detail-date-input">
        <button class="btn-primary btn-sm" id="btnDetail">查看</button>
      </div>
      <select id="detailFilter" class="detail-filter-select"><option value="">全部任务</option></select>
    </div>

    <div class="section-title">打卡明细</div>
    <div id="detailArea"></div>

    <div class="section-title">验收操作明细</div>
    <div id="verifyArea"></div>
  `;
  // 连续打卡卡片：点击查看中断明细
  const streakCard = view.querySelector('#streakCard');
  if (streakCard) {
    let streakDetail = null;
    streakCard.onclick = async () => {
      const loadingOverlay = showStreakLoading();
      if (streakDetail === null) {
        try { const r = await db.calcConsecutiveDaysDetail(childId, today, state.currentPlanId, plan?.start_date); streakDetail = r.detail; }
        catch (e) { streakDetail = []; }
      }
      loadingOverlay.remove();
      showStreakPanel(streak, streakDetail);
    };
  }
  // 验收操作明细容器（提前声明，避免 TDZ）
  const vArea = view.querySelector('#verifyArea');
  // 任务下拉框：列出当前周期+孩子的任务
  const filterSel = view.querySelector('#detailFilter');
  try {
    const tmpls = await db.fetchTemplates(state.currentPlanId, state.currentChildId);
    tmpls.forEach(t => { const o = document.createElement('option'); o.value = t.title; o.textContent = t.title; filterSel.appendChild(o); });
  } catch (e) {}
  // 查看：同时刷新打卡明细和验收明细（按日期范围+任务名过滤）
  const refresh = () => {
    const from = view.querySelector('#detailFrom').value;
    const to = view.querySelector('#detailTo').value;
    const kw = filterSel.value;
    loadDetail(from, to, kw); loadVerify(from, to, kw);
  };
  refresh();
  view.querySelector('#btnDetail').onclick = refresh;
  async function loadDetail(fromDate, toDate, kw) {
    const area = view.querySelector('#detailArea');
    area.innerHTML = `<div class="loading">加载中…</div>`;
    let list = [];
    try { list = await db.fetchCheckinsByDateRange(state.currentChildId, fromDate, toDate); } catch (e) {}
    if (kw) list = list.filter(c => c.title === kw);
    if (!list.length) { area.innerHTML = `<div class="empty">${fromDate}~${toDate} 没有打卡记录。</div>`; return; }
    area.innerHTML = list.map(c => `
      <div class="checkin-item">
        <div class="checkin-head"><span class="checkin-time">${mdhm(c.created_at)} · ${c.created_by||''}</span></div>
        ${c.title ? `<div class="checkin-note" style="font-weight:600">${c.title}</div>` : ''}
        ${c.note ? `<div class="checkin-note">${c.note}</div>` : ''}
        ${(c.photos||[]).length ? `<div class="checkin-media">${(c.photos||[]).map((u,i)=>`<img src="${u}" data-i="${i}" data-photos='${JSON.stringify(c.photos)}'>`).join('')}</div>` : ''}
        ${(c.audios||[]).length ? `<div>${(c.audios||[]).map(u=>`<audio controls src="${u}" style="width:100%;margin:4px 0"></audio>`).join('')}</div>` : ''}
      </div>`).join('');
    area.querySelectorAll('.checkin-media img').forEach(img => img.onclick = () => {
      const photos = JSON.parse(img.dataset.photos);
      viewFullPhoto(photos, +img.dataset.i);
    });
  }

  // 验收操作明细（用同一日期+任务名过滤）
  async function loadVerify(fromDate, toDate, kw) {
    vArea.innerHTML = `<div class="loading">加载中…</div>`;
    let list = [];
    try { list = await db.fetchVerifyLogsByRange(state.currentChildId, fromDate, toDate); } catch (e) {}
    if (kw) list = list.filter(l => l.title === kw);
    if (!list.length) { vArea.innerHTML = `<div class="empty">${fromDate}~${toDate} 没有验收操作。</div>`; return; }
    const actionText = { pass: '通过', reject: '打回', revoke: '撤销', instruction: '改说明' };
    const actionColor = { pass: 'badge-ok', reject: 'badge-no', revoke: 'badge-mid', instruction: 'badge-skip' };
    vArea.innerHTML = list.map(l => `
      <div class="checkin-item">
        <div class="checkin-head"><span class="checkin-time">${mdhm(l.created_at)} · ${l.operator||''}</span> <span class="badge ${actionColor[l.action]||''}">${actionText[l.action]||l.action}</span></div>
        ${l.title ? `<div class="checkin-note" style="font-weight:600">${l.title}</div>` : ''}
        ${l.note ? `<div class="checkin-note">${l.note}</div>` : ''}
      </div>`).join('');
  }
}

function fmt(d) {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

// 点击后立即显示加载提示（手机网络下查询耗时更明显，避免看起来像卡死）
function showStreakLoading() {
  const overlay = document.createElement('div');
  overlay.className = 'photo-overlay';
  overlay.style.background = 'rgba(0,0,0,.5)';
  overlay.innerHTML = `<div class="streak-panel" style="padding:30px;text-align:center;color:var(--muted,#999)">加载中…</div>`;
  document.body.appendChild(overlay);
  return overlay;
}

// 连续打卡明细面板：点卡片查看哪天中断、中断原因
function showStreakPanel(streak, detail) {
  const statusText = {
    ok: '✅ 全部完成',
    break: '❌ 未完成中断',
    dayoff: '🏖️ 假期',
    none: '— 无任务',
    onceOnly: '📌 仅一次性任务'
  };
  const rows = (detail && detail.length) ? detail.map(it => {
    const extra = it.type === 'break' && it.unfinished?.length
      ? `<div class="streak-break">未完成：${it.unfinished.map(u => `${u.title}（${u.status}）`).join('、')}</div>` : '';
    return `<div class="streak-row streak-${it.type}">
      <span class="streak-date">${it.date.slice(5)}</span>
      <span class="streak-status">${statusText[it.type] || it.type}</span>
      ${extra}
    </div>`;
  }).join('') : '<div class="empty">暂无历史数据。</div>';

  const overlay = document.createElement('div');
  overlay.className = 'photo-overlay';
  overlay.style.background = 'rgba(0,0,0,.5)';
  overlay.innerHTML = `
    <div class="streak-panel">
      <div class="streak-head">
        <span>连续打卡 ${streak} 天</span>
        <button class="btn-ghost btn-sm">关闭</button>
      </div>
      <div class="streak-hint">不含当天（当天未结束不统计）。从最近一天往前：</div>
      <div class="streak-list">${rows}</div>
    </div>`;
  overlay.onclick = (e) => { if (e.target === overlay || e.target.tagName === 'BUTTON') overlay.remove(); };
  document.body.appendChild(overlay);
}
