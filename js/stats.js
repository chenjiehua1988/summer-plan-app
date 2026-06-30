// ============================================================
// 统计报表：完成率、连续打卡、各科用时、周/月趋势
// ============================================================
import { state, todayStr } from './supabase.js';
import * as db from './db.js';

export async function renderStats(view) {
  const childId = state.currentChildId;
  if (!childId) { view.innerHTML = `<div class="empty">请先添加孩子。</div>`; return; }
  view.innerHTML = `<div class="loading">加载中…</div>`;

  const today = new Date();
  const from30 = new Date(); from30.setDate(today.getDate() - 29);
  const fromStr = fmt(from30), toStr = fmt(today);

  let records = [];
  try { records = await db.fetchRecordsRange(childId, fromStr, toStr); }
  catch (e) { records = []; }

  const total = records.length;
  const verified = records.filter(r => r.status === 'verified').length;
  const done = records.filter(r => r.status === 'done' || r.status === 'verified').length;
  const rate = total ? Math.round((verified / total) * 100) : 0;
  const points = records.filter(r => r.status === 'verified')
                        .reduce((s, r) => s + (r.points || 0), 0);
  const streak = calcStreak(records);

  // 各科用时（用 actual_minutes，若空用 default 估算不到，这里只统计已记录的）
  const bySubject = {};
  records.forEach(r => {
    bySubject[r.subject] = bySubject[r.subject] || { count: 0, verified: 0, minutes: 0 };
    bySubject[r.subject].count++;
    if (r.status === 'verified') bySubject[r.subject].verified++;
    if (r.actual_minutes) bySubject[r.subject].minutes += r.actual_minutes;
  });

  // 近 7 天每日完成数柱状
  const last7 = [];
  for (let i = 6; i >= 0; i--) {
    const d = new Date(); d.setDate(today.getDate() - i);
    const ds = fmt(d);
    const dayCount = records.filter(r => r.date === ds && (r.status === 'done' || r.status === 'verified')).length;
    const dayTotal = records.filter(r => r.date === ds).length;
    last7.push({ ds: ds.slice(5), count: dayCount, total: dayTotal });
  }
  const maxDay = Math.max(1, ...last7.map(d => d.count));

  view.innerHTML = `
    <div class="page-head"><div><div class="date-label">最近 30 天统计</div></div></div>
    <div class="stat-cards">
      <div class="stat-card"><div class="stat-num">${rate}%</div><div class="stat-lab">验收完成率</div></div>
      <div class="stat-card"><div class="stat-num">${streak}</div><div class="stat-lab">连续打卡(天)</div></div>
      <div class="stat-card"><div class="stat-num">${points}</div><div class="stat-lab">累计积分</div></div>
      <div class="stat-card"><div class="stat-num">${verified}/${total}</div><div class="stat-lab">验收/总任务</div></div>
    </div>

    <div class="section-title">各科情况</div>
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
  `;
}

function calcStreak(records) {
  // 连续天数：从今天往前数，每天只要有一条 done/verified 就算
  const okDates = new Set(records
    .filter(r => r.status === 'done' || r.status === 'verified')
    .map(r => r.date));
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
  const m = String(d.getMonth()+1).padStart(2,'0');
  const day = String(d.getDate()).padStart(2,'0');
  return `${y}-${m}-${day}`;
}
