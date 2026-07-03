// ============================================================
// 积分与奖励：余额、兑换商店、流水、兑换记录
// ============================================================
import { state, toast, mdhm, todayStr } from './supabase.js';
import * as db from './db.js';

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

    <div class="section-title">兑换商店</div>
    ${onShop.length ? `<div class="shop-grid">
      ${onShop.map(s => `
        <div class="shop-item">
          <div class="shop-icon">${s.icon || '🎁'}</div>
          <div class="shop-name">${s.name}</div>
          <div class="shop-cost">${s.cost_points} 分${s.custom_points ? '/个' : ''}</div>
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

  // 流水过滤任务下拉：从当前周期+孩子的任务列表填
  const filterSel = container.querySelector('#ledgerFilter');
  try {
    const tmpls = await db.fetchTemplates(state.currentPlanId, childId);
    tmpls.forEach(t => { const o = document.createElement('option'); o.value = t.title; o.textContent = t.title; filterSel.appendChild(o); });
  } catch (e) {}

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
    if (kw) list = list.filter(l => (l.reason||'').includes(kw));
    renderLedger(list);
  };

  container.querySelectorAll('[data-redeem]').forEach(b => {
    b.onclick = async () => {
      const s = shop.find(x => x.id === b.dataset.redeem);
      if (!s) return;
      const custom = s.custom_points;
      // 自定义积分：输入数量，按单价算总积分（如1分=1分钟，输入25=25分=25分钟）
      // 固定积分：输入数量，按单价×数量算
      const unitText = custom ? `${s.cost_points}分=1个` : `单价${s.cost_points}分`;
      const qtyStr = prompt(`兑换「${s.name}」\n${unitText}，当前余额 ${balance} 分\n请输入数量：`, '1');
      if (qtyStr === null) return;
      const qty = Math.max(1, parseInt(qtyStr) || 1);
      const total = custom ? s.cost_points * qty : s.cost_points * qty;
      if (isChild) {
        if (!confirm(`申请兑换「${s.name}」×${qty}，共 ${total} 分？\n需爸妈同意后才能扣分兑付。`)) return;
        try {
          // 自定义积分：写一条申请，cost_points=total；固定积分：按数量写多条
          if (custom) {
            await db.addRedeemRequest(childId, { ...s, cost_points: total, name: `${s.name} ×${qty}` });
          } else {
            for (let i = 0; i < qty; i++) await db.addRedeemRequest(childId, s);
          }
          toast(`已申请，等爸妈同意`);
          renderPoints(container, childId);
        } catch (e) { toast('申请失败：' + e.message); }
      } else {
        if (total > balance) { toast(`积分不足，需要 ${total} 分，当前 ${balance} 分`); return; }
        if (!confirm(`兑换「${s.name}」×${qty}，扣 ${total} 分？`)) return;
        try {
          if (custom) {
            await db.redeemReward(childId, { ...s, cost_points: total, name: `${s.name} ×${qty}` });
          } else {
            for (let i = 0; i < qty; i++) await db.redeemReward(childId, s);
          }
          toast(`兑换成功 🎁`);
          await refreshPointBadge();
          renderPoints(container, childId);
        } catch (e) { toast('兑换失败：' + e.message); }
      }
    };
  });
}

