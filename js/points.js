// ============================================================
// 积分与奖励：余额、兑换商店、流水、兑换记录
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

// 积分中心（嵌入设置页区域）：余额 + 兑换商店 + 流水 + 兑换记录
export async function renderPoints(container, childId) {
  container.innerHTML = `<div class="loading">加载中…</div>`;
  const [ledger, rewards, balance, shop] = await Promise.all([
    db.fetchLedger(childId), db.fetchRewards(childId), db.fetchPointBalance(childId), db.fetchShop()
  ]);
  const onShop = shop.filter(s => s.active);

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
          <div class="shop-cost">${s.cost_points} 分</div>
          <button class="btn-primary btn-sm shop-btn" data-redeem="${s.id}">兑换</button>
        </div>`).join('')}
    </div>` : `<div class="empty">商店还没有上架奖励。去上方「兑换商店目录」添加。</div>`}

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

  container.querySelectorAll('[data-redeem]').forEach(b => {
    b.onclick = async () => {
      const s = shop.find(x => x.id === b.dataset.redeem);
      if (!s) return;
      if (s.cost_points > balance) { toast('积分不足'); return; }
      if (!confirm(`兑换「${s.name}」，扣 ${s.cost_points} 分？`)) return;
      try {
        await db.redeemReward(childId, s);
        toast('兑换成功 🎁');
        await refreshPointBadge();
        renderPoints(container, childId);
      } catch (e) { toast('兑换失败：' + e.message); }
    };
  });
}
