// ============================================================
// 统计报表（按学习周期）：总进度、倒计时、按标签/科目、历史对比、近7天
// ============================================================
import { state, todayStr } from './supabase.js';
import * as db from './db.js';

export async function renderStats(view) {
  const childId = state.currentChildId;
  if (!childId) { view.innerHTML = `<div class="empty">请先添加孩子。</div>`; return; }
  if (!state.currentPlanId) { view.innerHTML = `<div class="empty">请先选择一个学习周期。</div>`; return; }
  const plan = state.plans.find(p => p.id === state.currentPlanId);
  view.innerHTML = `<div class="loading">加载中…</div>`;

  // 当前周期记录
  let records = [];
  try { records = await db.fetchRecordsByPlan(state.currentPlanId, childId); }
  catch (e) { records = []; }

  const total = records.length;
  const verified = records.filter(r => r.status === 'verified').length;
  const done = records.filter(r => r.status === 'done' || r.status === 'verified').length;
  const rate = total ? Math.round((verified / total) * 100) : 0;
  const points = records.filter(r => r.status === 'verified').reduce((s, r) => s + (r.points || 0), 0);
  const okDates = new Set(records.filter(r => r.status === 'done' || r.status === 'verified').map(r => r.date));
  const streak = calcStreak(okDates);

  // 倒计时/天数
  const today = todayStr();
  let totalDays = 0, passedDays = 0, leftDays = null, progressPct = 0;
  if (plan?.start_date && plan?.end_date) {
    totalDays = Math.max(1, Math.round((new Date(plan.end_date) - new Date(plan.start_date)) / 86400000) + 1);
    passedDays = Math.max(0, Math.min(totalDays, Math.round((new Date(today) - new Date(plan.start_date)) / 86400000) + 1));
    leftDays = Math.ceil((new Date(plan.end_date) - new Date(today)) / 86400000);
    progressPct = Math.round(passedDays / totalDays * 100);
  }

  // 按标签完成率
  const byTag = {};
  records.forEach(r => {
    const tags = (r.tags && r.tags.length) ? r.tags : ['(无标签)'];
    tags.forEach(tn => {
      byTag[tn] = byTag[tn] || { count: 0, verified: 0 };
      byTag[tn].count++;
      if (r.status === 'verified') byTag[tn].verified++;
    });
  });
  // 按科目完成率
  const bySubject = {};
  records.forEach(r => {
    bySubject[r.subject] = bySubject[r.subject] || { count: 0, verified: 0 };
    bySubject[r.subject].count++;
    if (r.status === 'verified') bySubject[r.subject].verified++;
  });

  // 历史对比：所有周期该孩子的完成率
  let comparisons = [];
  try {
    const others = state.plans.filter(p => p.id !== state.currentPlanId);
    comparisons = await Promise.all(others.map(async p => {
      const rs = await db.fetchRecordsByPlan(p.id, childId);
      const v = rs.filter(r => r.status === 'verified').length;
      const t = rs.length;
      return { name: p.name, rate: t ? Math.round(v / t * 100) : 0, v, t, status: p.status };
    }));
  } catch (e) {}

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
      <div class="stat-card"><div class="stat-num">${streak}</div><div class="stat-lab">连续打卡(天)</div></div>
      <div class="stat-card"><div class="stat-num">${points}</div><div class="stat-lab">周期积分</div></div>
      <div class="stat-card"><div class="stat-num">${verified}/${total}</div><div class="stat-lab">验收/总任务</div></div>
    </div>

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
  `;
}

function calcStreak(okDates) {
  let streak = 0;
  const d = new Date();
  for (;;) {
    const ds = fmt(d);
    if (okDates.has(ds)) { streak++; d.setDate(d.getDate() - 1); }
    else break;
  }
  return streak;
}
function fmt(d) {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}
