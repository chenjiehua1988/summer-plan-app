// ============================================================
// 积分与奖励：余额、兑换商店、流水、兑换记录
// ============================================================
import { supabase, state, toast, mdhm, todayStr } from './supabase.js';
import * as db from './db.js';
import { enablePush, disablePush, isPushEnabled } from './push.js';

// 更新顶栏积分显示
export async function refreshPointBadge() {
  const childId = state.currentChildId;
  if (!childId) return;
  try {
    const bal = await db.fetchPointBalance(childId);
    const el = document.getElementById('pointBalance');
    if (el) el.textContent = bal;
  } catch (e) { /* 静默 */ }
}

// 积分中心：parent 直接兑换；child 申请兑换（爸妈审批）
export async function renderPoints(container, childId) {
  container.innerHTML = `<div class="loading">加载中…</div>`;
  const isChild = state.mode === 'child';
  const today = todayStr();
  // 余额查全部（量小），流水默认查当天
  const [rewards, balance, shop, reqs, todayLedger] = await Promise.all([
    db.fetchRewards(childId), db.fetchPointBalance(childId), db.fetchShop(),
    db.fetchRedeemRequestsByChild(childId), db.fetchLedgerRange(childId, today, today)
  ]);
  const onShop = shop.filter(s => s.active);
  const btnLabel = isChild ? '我想兑换' : '兑换';

  container.innerHTML = `
    <div class="balance-card">
      <div class="bal-num">⭐ ${balance}</div>
      <div class="bal-label">当前积分</div>
    </div>

    ${!isChild ? `
    <div class="card" style="margin-bottom:10px">
      <div class="row-line"><span>手动扣分</span><button class="btn-ghost btn-sm" id="btnDeduct" style="color:var(--no)">惩罚扣分</button></div>
      <div class="row-hint">错题太多、抄答案等惩罚性扣分，需输入家庭密码。</div>
    </div>` : ''}

    ${isChild ? `
    <div class="card" style="margin-bottom:10px">
      <div class="row-line"><span>通知</span><button class="btn-ghost btn-sm" id="btnChildPush">开启</button></div>
      <div class="row-hint">开启后，爸妈审批你的兑换申请会收到通知。</div>
    </div>` : ''}

    <div class="section-title">兑换商店</div>
    ${onShop.length ? `<div class="shop-grid">
      ${onShop.map(s => `
        <div class="shop-item">
          <div class="shop-icon">${s.icon || '🎁'}</div>
          <div class="shop-name">${s.name}</div>
          <div class="shop-cost">${s.cost_points} 分</div>
          <button class="btn-primary btn-sm shop-btn" data-redeem="${s.id}">${btnLabel}</button>
        </div>`).join('')}
    </div>` : `<div class="empty">商店还没有上架奖励。</div>`}

    ${isChild && reqs.length ? `
      <div class="section-title">我的兑换申请</div>
      <ul class="ledger-list">
        ${reqs.slice(0, 20).map(r => {
          const st = r.status === 'pending' ? '待审批' : r.status === 'approved' ? '已同意' : '已拒绝';
          const cls = r.status === 'pending' ? 'badge-mid' : r.status === 'approved' ? 'badge-ok' : 'badge-no';
          return `<li class="ledger-row">
            <div><div class="ledger-reason">${r.name} <span class="badge ${cls}">${st}</span></div>
            <small>${mdhm(r.created_at)}</small></div>
            <div class="ledger-delta minus">-${r.cost_points}</div>
          </li>`;
        }).join('')}
      </ul>` : ''}

    <div class="section-title">积分流水</div>
    <div class="detail-query-bar">
      <div class="detail-query-row">
        <input type="date" id="ledgerFrom" value="${today}" class="detail-date-input">
        <span style="color:var(--muted);font-size:12px">至</span>
        <input type="date" id="ledgerTo" value="${today}" class="detail-date-input">
        <button class="btn-primary btn-sm" id="btnLedger">查询</button>
      </div>
      <select id="ledgerFilter" class="detail-filter-select"><option value="">全部</option></select>
    </div>
    <div id="ledgerArea"></div>

    <div class="section-title">已兑换奖励</div>
    ${rewards.length === 0 ? `<div class="empty">还没有兑换记录。</div>` : `
      <ul class="ledger-list">
        ${rewards.slice(0, 30).map(rw => `
          <li class="ledger-row">
            <div><div class="ledger-reason">${rw.name}</div>
            <small>${mdhm(rw.redeemed_at)}</small></div>
            <div class="ledger-delta minus">-${rw.cost_points}</div>
          </li>`).join('')}
      </ul>`}
  `;

  // 孩子端通知开关
  const childPushBtn = container.querySelector('#btnChildPush');
  if (childPushBtn) {
    isPushEnabled().then(on => { childPushBtn.textContent = on ? '关闭' : '开启'; });
    childPushBtn.onclick = async () => {
      const on = await isPushEnabled();
      if (on) { await disablePush(); childPushBtn.textContent = '开启'; }
      else { const ok = await enablePush(); if (ok) childPushBtn.textContent = '关闭'; }
    };
  }

  // 家长手动扣分
  const deductBtn = container.querySelector('#btnDeduct');
  if (deductBtn) {
    deductBtn.onclick = async () => {
      const pwd = prompt('请输入家庭密码：');
      if (pwd === null) return;
      try {
        const { data: ok, error: pe } = await supabase.rpc('pw_match', { p_name: state.family.name, p_pw: pwd });
        if (pe || !ok) { toast('密码错误'); return; }
        const pointsStr = prompt(`扣多少积分？（当前余额 ${balance} 分）`);
        if (pointsStr === null) return;
        const pts = parseInt(pointsStr);
        if (!pts || pts <= 0) { toast('请输入有效积分数'); return; }
        const reason = prompt('扣分原因（如：错题太多/抄答案）') || '惩罚扣分';
        if (!confirm(`确认扣 ${pts} 分？\n原因：${reason}`)) return;
        await supabase.from('point_ledger').insert({
          family_id: state.family.id, child_id: childId, delta: -pts,
          reason: `惩罚扣分：${reason}`, created_by: state.role
        });
        toast(`已扣 ${pts} 分`);
        await refreshPointBadge();
        renderPoints(container, childId);
      } catch (e) { toast('扣分失败：' + e.message); }
    };
  }

  // 流水过滤任务下拉：任务列表 + 系统奖励/扣分
  const filterSel = container.querySelector('#ledgerFilter');
  try {
    const tmpls = await db.fetchTemplates(state.currentPlanId, childId);
    tmpls.forEach(t => { const o = document.createElement('option'); o.value = t.title; o.textContent = t.title; filterSel.appendChild(o); });
  } catch (e) {}
  // 加系统选项
  const sysOpt = document.createElement('option'); sysOpt.value = '__system__'; sysOpt.textContent = '系统奖惩'; filterSel.appendChild(sysOpt);

  // 渲染流水列表
  function renderLedger(list) {
    const area = container.querySelector('#ledgerArea');
    if (!list.length) { area.innerHTML = `<div class="empty">没有积分记录。</div>`; return; }
    area.innerHTML = `<ul class="ledger-list">${list.map(l => `
      <li class="ledger-row">
        <div><div class="ledger-reason">${l.reason}</div>
        <small>${mdhm(l.created_at)}</small></div>
        <div class="ledger-delta ${l.delta>0?'plus':'minus'}">${l.delta>0?'+':''}${l.delta}</div>
      </li>`).join('')}</ul>`;
  }
  // 初始显示当天
  renderLedger(todayLedger);
  // 查询按钮
  container.querySelector('#btnLedger').onclick = async () => {
    const from = container.querySelector('#ledgerFrom').value;
    const to = container.querySelector('#ledgerTo').value;
    const kw = filterSel.value;
    container.querySelector('#ledgerArea').innerHTML = `<div class="loading">加载中…</div>`;
    let list = [];
    try { list = await db.fetchLedgerRange(childId, from, to); } catch (e) {}
    if (kw === '__system__') list = list.filter(l => (l.reason||'').includes('连续') || (l.reason||'').includes('未完成'));
    else if (kw) list = list.filter(l => (l.reason||'').includes(kw));
    renderLedger(list);
  };

  container.querySelectorAll('[data-redeem]').forEach(b => {
    b.onclick = async () => {
      const s = shop.find(x => x.id === b.dataset.redeem);
      if (!s) return;
      // 统一逻辑：输入数量（支持小数），扣分=单价×数量
      const qtyStr = prompt(`兑换「${s.name}」\n单价 ${s.cost_points} 分，当前余额 ${balance} 分\n请输入数量：`, '1');
      if (qtyStr === null) return;
      const qty = parseFloat(qtyStr);
      if (!qty || qty <= 0) { toast('请输入有效数量'); return; }
      const total = Math.round(s.cost_points * qty);
      if (total <= 0) { toast('数量太小'); return; }
      if (isChild) {
        if (!confirm(`申请兑换「${s.name}」×${qty}，共 ${total} 分？\n需爸妈同意后才能扣分兑付。`)) return;
        try {
          await db.addRedeemRequest(childId, { ...s, cost_points: total, name: `${s.name} ×${qty}` });
          toast(`已申请，等爸妈同意`);
          renderPoints(container, childId);
        } catch (e) { toast('申请失败：' + e.message); }
      } else {
        if (total > balance) { toast(`积分不足，需要 ${total} 分，当前 ${balance} 分`); return; }
        if (!confirm(`兑换「${s.name}」×${qty}，扣 ${total} 分？`)) return;
        try {
          await db.redeemReward(childId, { ...s, cost_points: total, name: `${s.name} ×${qty}` });
          toast(`兑换成功 🎁`);
          await refreshPointBadge();
          renderPoints(container, childId);
        } catch (e) { toast('兑换失败：' + e.message); }
      }
    };
  });
}

