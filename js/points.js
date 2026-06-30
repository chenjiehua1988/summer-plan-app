// ============================================================
// 积分与奖励：余额、流水、奖励兑换
// ============================================================
import { state, toast } from './supabase.js';
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

// 积分中心（可作为页面或弹层）—— 这里嵌入设置页的一个区域
export async function renderPoints(container, childId) {
  container.innerHTML = `<div class="loading">加载中…</div>`;
  const [ledger, rewards, balance] = await Promise.all([
    db.fetchLedger(childId), db.fetchRewards(childId), db.fetchPointBalance(childId)
  ]);

  container.innerHTML = `
    <div class="balance-card">
      <div class="bal-num">⭐ ${balance}</div>
      <div class="bal-label">当前积分</div>
    </div>
    <div class="redeem-box">
      <input id="rName" type="text" placeholder="奖励名（如：看一集动画）" />
      <input id="rCost" type="number" placeholder="花费积分" style="width:90px" />
      <button class="btn-primary btn-sm" id="rRedeem">兑换</button>
    </div>
    <div class="section-title">积分流水</div>
    ${ledger.length === 0 ? `<div class="empty">还没有积分记录。</div>` : `
      <ul class="ledger-list">
        ${ledger.slice(0, 30).map(l => `
          <li class="ledger-row">
            <div><div class="ledger-reason">${l.reason}</div>
            <small>${(l.created_at||'').slice(0,16).replace('T',' ')}</small></div>
            <div class="ledger-delta ${l.delta>0?'plus':'minus'}">${l.delta>0?'+':''}${l.delta}</div>
          </li>`).join('')}
      </ul>`}
    <div class="section-title">已兑换奖励</div>
    ${rewards.length === 0 ? `<div class="empty">还没有兑换记录。</div>` : `
      <ul class="ledger-list">
        ${rewards.map(rw => `
          <li class="ledger-row">
            <div><div class="ledger-reason">${rw.name}</div>
            <small>${(rw.redeemed_at||'').slice(0,16).replace('T',' ')}</small></div>
            <div class="ledger-delta minus">-${rw.cost_points}</div>
          </li>`).join('')}
      </ul>`}
  `;

  container.querySelector('#rRedeem').onclick = async () => {
    const name = container.querySelector('#rName').value.trim();
    const cost = +container.querySelector('#rCost').value;
    if (!name || !cost) { toast('请填写奖励名和花费'); return; }
    if (cost > balance) { toast('积分不足'); return; }
    try {
      await db.redeemReward(childId, name, cost);
      toast('兑换成功 🎁');
      await refreshPointBadge();
      renderPoints(container, childId);
    } catch (e) { toast('兑换失败：' + e.message); }
  };
}
