// ============================================================
// app.js：路由 / 导航 / 初始化
// ============================================================
import { state, toast, todayStr, segHtml, bindSeg, mdhm } from './supabase.js';
import * as auth from './auth.js';
import * as db from './db.js';
import { renderToday, renderTemplates } from './tasks.js';
import { renderVerify } from './verify.js';
import { renderStats } from './stats.js';
import { renderLife } from './life.js';
import { renderPoints, refreshPointBadge } from './points.js';
import { enablePush, disablePush, isPushEnabled } from './push.js';

const view = document.getElementById('view');
const authScreen = document.getElementById('authScreen');

window.refreshPointBadge = refreshPointBadge;

let realtimeChannel = null;

// ---------- 初始化 ----------
async function boot() {
  registerSW();
  bindAuthUI();
  bindTabs();
  bindChildSwitcher();
  bindPlanSwitcher();
  bindLogoutTop();
  bindPointsModal();
  window.addEventListener('online', () => { toast('已联网，同步中…'); db.flushQueue(); refreshCurrent(); });

  const fam = await auth.restoreSession();
  if (fam) await maybeEnterApp();
  else showAuth();
}

async function maybeEnterApp() {
  if (!state.family?.id) { showAuth(); return; }
  await db.fetchChildren();
  // child 模式：currentChildId 已是登录选的；parent 模式：默认第一个
  if (state.mode === 'child') {
    // 确保孩子存在
    if (!state.children.find(c => c.id === state.currentChildId) && state.children.length) {
      state.currentChildId = state.children[0].id;
    }
  } else if (!state.currentChildId && state.children.length) {
    state.currentChildId = state.children[0].id;
  }
  // 加载周期与标签（孩子模式也需要周期来打卡）
  try {
    state.plans = await db.fetchPlans();
    state.tags = await db.fetchTags();
    if (state.mode === 'parent') state.planTypes = await db.fetchPlanTypes();
  } catch (e) { console.warn('load plans/tags', e); }
  if (state.currentPlanId && !state.plans.find(p => p.id === state.currentPlanId)) {
    state.currentPlanId = null;
  }
  if (!state.currentPlanId) {
    const firstActive = state.plans.find(p => p.status === 'active') || state.plans[0];
    if (firstActive) { state.currentPlanId = firstActive.id; auth.switchPlan(firstActive.id); }
  }
  applyModeUI();
  fillChildSwitcher();
  fillPlanSwitcher();
  authScreen.style.display = 'none';
  // 默认页：孩子→今日，父母→验收
  if (state.mode === 'child') {
    state.pendingTab = 'today';
  } else {
    state.pendingTab = state.pendingTab === 'today' ? 'verify' : (state.pendingTab || 'verify');
  }
  switchTab(state.pendingTab || 'today');
}

// 按 mode 显示/隐藏 UI：child 隐藏验收/设置 tab，左上角显示孩子名（替代孩子切换器）
function applyModeUI() {
  const isChild = state.mode === 'child';
  document.querySelectorAll('.tab').forEach(t => {
    const tab = t.dataset.tab;
    if (isChild && (tab === 'verify' || tab === 'setup' || tab === 'life')) t.style.display = 'none';
    else t.style.display = '';
  });
  const cs = document.getElementById('childSwitcher');
  const who = document.getElementById('whoAmI');
  if (isChild) {
    if (cs) cs.style.display = 'none';
    const c = state.children.find(x => x.id === state.currentChildId);
    if (who) { who.textContent = c ? `${c.name}·${c.grade_target || ''}` : '我'; who.style.display = ''; }
  } else {
    if (cs) cs.style.display = '';
    if (who) who.style.display = 'none';
  }
}

function registerSW() {
  if ('serviceWorker' in navigator) {
    navigator.serviceWorker.register('./sw.js').catch(e => console.warn('SW reg fail', e));
  }
}

// 顶栏退出登录（家长/孩子通用）
function bindLogoutTop() {
  const btn = document.getElementById('btnLogoutTop');
  if (!btn) return;
  btn.onclick = async () => {
    if (!confirm('确定退出登录？')) return;
    await auth.logout();
    applyModeUI();
    fillChildSwitcher(); fillPlanSwitcher();
    showAuth();
  };
}

// 顶栏积分按钮 → 打开积分浮层（家长/孩子通用）
function bindPointsModal() {
  const btn = document.getElementById('btnPoints');
  const modal = document.getElementById('pointsModal');
  const close = document.getElementById('btnClosePoints');
  if (!btn) return;
  btn.onclick = async () => {
    if (!state.currentChildId) { toast('请先选择孩子'); return; }
    // 先显示浮层+全屏加载态（避免从小条撑开）
    document.getElementById('pointsModalArea').innerHTML = `<div class="loading" style="padding:40px 0">加载中…</div>`;
    modal.style.display = 'flex';
    await renderPoints(document.getElementById('pointsModalArea'), state.currentChildId);
  };
  if (close) close.onclick = () => { modal.style.display = 'none'; };
  modal.addEventListener('click', (e) => { if (e.target === modal) modal.style.display = 'none'; });
}

// ---------- 鉴权 UI（家长/孩子） ----------
function bindAuthUI() {
  const $ = id => document.getElementById(id);
  // 家长角色选择卡
  const roleSeg = $('loginRoleSeg');
  if (roleSeg) {
    roleSeg.innerHTML = segHtml([{value:'妈妈',label:'妈妈'},{value:'爸爸',label:'爸爸'}], '妈妈');
    bindSeg(roleSeg, v => { $('loginRole').value = v; });
  }
  // 家长 / 孩子 顶部切换
  const tabParent = $('tabParent'), tabChild = $('tabChild');
  const showParent = () => {
    tabParent.classList.add('active'); tabChild.classList.remove('active');
    $('parentBox').style.display = ''; $('childBox').style.display = 'none'; authMsg('');
  };
  const showChild = () => {
    tabChild.classList.add('active'); tabParent.classList.remove('active');
    $('parentBox').style.display = 'none'; $('childBox').style.display = ''; authMsg('');
  };
  tabParent.onclick = showParent;
  tabChild.onclick = showChild;

  // 家长：登录/创建 子tab
  const tabLogin = $('tabLogin'), tabCreate = $('tabCreate');
  const showLogin = () => {
    tabLogin.classList.add('active'); tabCreate.classList.remove('active');
    $('btnLogin').style.display = ''; $('btnCreateFamily').style.display = 'none';
    $('createExtra').style.display = 'none'; authMsg('');
  };
  const showCreate = () => {
    tabCreate.classList.add('active'); tabLogin.classList.remove('active');
    $('btnLogin').style.display = 'none'; $('btnCreateFamily').style.display = '';
    $('createExtra').style.display = ''; authMsg('');
  };
  tabLogin.onclick = showLogin;
  tabCreate.onclick = showCreate;

  $('btnLogin').onclick = async () => {
    showLoginLoading();
    try { await auth.loginAsParent($('familyName').value, $('password').value, $('loginRole').value); await maybeEnterApp(); }
    catch (e) { authMsg(e.message); }
    finally { hideLoginLoading(); }
  };
  $('btnCreateFamily').onclick = async () => {
    showLoginLoading();
    try {
      await auth.createFamily($('familyName').value, $('password').value, $('loginRole').value);
      await maybeEnterApp();
    } catch (e) { authMsg(e.message); }
    finally { hideLoginLoading(); }
  };

  // 孩子登录
  $('btnLoadKids').onclick = async () => {
    const fn = $('childFamilyName').value.trim();
    if (!fn) { authMsg('请填家庭名'); return; }
    const kids = await auth.fetchChildrenOf(fn);
    if (!kids.length) { authMsg('找不到该家庭或还没有孩子档案'); return; }
    const box = $('childPickBox');
    box.innerHTML = segHtml(kids.map(k => ({ value: k.id, label: `${k.name}（${k.grade_target || ''}）` })), null, true);
    box.style.display = '';
    $('childPick').value = '';
    $('btnChildLogin').style.display = '';
    bindSeg(box, v => { $('childPick').value = v; });
    authMsg('');
  };
  $('btnChildLogin').onclick = async () => {
    const fn = $('childFamilyName').value.trim();
    const cid = $('childPick').value;
    if (!fn || !cid) { authMsg('请先查找家庭并选择自己'); return; }
    showLoginLoading();
    try { await auth.loginAsChild(fn, cid); await maybeEnterApp(); }
    catch (e) { authMsg(e.message); }
    finally { hideLoginLoading(); }
  };
}
function authMsg(m) { document.getElementById('authMsg').textContent = m; }
function showAuth() { authScreen.style.display = 'flex'; }
function showLoginLoading() { const el = document.getElementById('loginLoading'); if (el) el.style.display = 'flex'; }
function hideLoginLoading() { const el = document.getElementById('loginLoading'); if (el) el.style.display = 'none'; }

// ---------- 周期切换 ----------
function bindPlanSwitcher() {
  const sel = document.getElementById('planSwitcher');
  if (!sel) return;
  sel.onchange = () => {
    auth.switchPlan(sel.value || null);
    updatePlanCountdown();
    refreshCurrent();
  };
}
function fillPlanSwitcher() {
  const sel = document.getElementById('planSwitcher');
  if (!sel) return;
  const opts = state.plans.map(p =>
    `<option value="${p.id}" ${p.status === 'archived' ? 'data-arch':''}>${p.name}${p.status === 'archived' ? '(归档)' : ''}</option>`).join('');
  sel.innerHTML = `<option value="">(无周期)</option>` + opts;
  if (state.currentPlanId) sel.value = state.currentPlanId;
  updatePlanCountdown();
}
function updatePlanCountdown() {
  const el = document.getElementById('planCountdown');
  if (!el) return;
  const p = state.plans.find(x => x.id === state.currentPlanId);
  if (!p || !p.end_date) { el.textContent = p ? p.type : ''; return; }
  const today = todayStr();
  const end = p.end_date;
  const days = Math.ceil((new Date(end) - new Date(today)) / 86400000);
  if (days > 0) el.textContent = `剩 ${days} 天`;
  else if (days === 0) el.textContent = '今天截止';
  else el.textContent = '已结束';
}

// ---------- 底部 Tab ----------
function bindTabs() {
  document.querySelectorAll('.tab').forEach(t => {
    t.onclick = () => switchTab(t.dataset.tab);
  });
}
function switchTab(tab) {
  // child 模式屏蔽 verify/setup
  if (state.mode === 'child' && (tab === 'verify' || tab === 'setup')) return;
  // life 暂未对孩子适配，孩子模式下也屏蔽
  if (state.mode === 'child' && tab === 'life') return;
  state.pendingTab = tab;
  document.querySelectorAll('.tab').forEach(t =>
    t.classList.toggle('active', t.dataset.tab === tab));
  refreshCurrent();
}

function refreshCurrent() {
  if (!state.family?.id) return;
  const tab = state.pendingTab;
  if (tab === 'today') renderToday(view);
  else if (tab === 'verify' && state.mode === 'parent') renderVerify(view);
  else if (tab === 'stats') renderStats(view);
  else if (tab === 'life' && state.mode === 'parent') renderLife(view);
  else if (tab === 'setup' && state.mode === 'parent') renderSetup(view);
  refreshPointBadge();
}

// ---------- 孩子切换 ----------
function bindChildSwitcher() {
  const sel = document.getElementById('childSwitcher');
  sel.onchange = () => {
    state.currentChildId = sel.value;
    subscribeRealtime();
    refreshCurrent();
  };
}
function fillChildSwitcher() {
  const sel = document.getElementById('childSwitcher');
  sel.innerHTML = state.children.map(c =>
    `<option value="${c.id}">${c.name}（${c.grade_target || ''}）</option>`).join('');
  if (state.currentChildId) sel.value = state.currentChildId;
}
function subscribeRealtime() {
  if (realtimeChannel) { realtimeChannel.unsubscribe(); realtimeChannel = null; }
  if (!state.currentChildId) return;
  realtimeChannel = db.subscribeRecords(state.currentChildId, () => { refreshCurrent(); });
}

// ---------- 设置页 ----------
function renderSetup(view) {
  const plan = state.plans.find(p => p.id === state.currentPlanId);
  view.innerHTML = `
    <div class="page-head"><div><div class="date-label">设置</div></div></div>

    <div class="section-title">家庭</div>
    <div class="card">
      <div class="row-line"><span>家庭名称</span><span>${state.family?.name || '—'}</span></div>
      <div class="row-line"><span>当前身份</span><span>${state.role}（家长）</span></div>
      <div class="row-hint">家长角色登录时已固定，不可切换。退出后可换另一个家长身份登录。</div>
    </div>

    <div class="section-title">通知设置</div>
    <div class="card">
      <div class="row-line"><span>打卡通知</span><button class="btn-ghost btn-sm" id="btnPushToggle">开启</button></div>
      <div class="row-hint">开启后，孩子提交打卡，本设备会收到系统通知（需添加到主屏幕 + 授权通知）。</div>
    </div>

    <div class="section-title">兑换申请</div>
    <div class="card" id="redeemReqCard"></div>

    <div class="section-title">周期类型管理</div>
    <div class="card" id="planTypesCard"></div>
    <div class="child-add">
      <input id="ptName" type="text" placeholder="新类型名（如 期中备考）" class="grow" />
      <button class="btn-primary btn-sm" id="ptAdd">添加类型</button>
    </div>

    <div class="section-title">学习周期</div>
    <div class="card" id="plansCard"></div>
    <div class="child-add">
      <input id="pName" type="text" placeholder="周期名（如 2026暑假）" class="grow" />
      <select id="pType"></select>
      <input id="pStart" type="date" style="width:118px" />
      <input id="pEnd" type="date" style="width:118px" />
      <button class="btn-primary btn-sm" id="pAdd">新建</button>
    </div>

    <div class="section-title">标签管理</div>
    <div class="card" id="tagsCard"></div>
    <div class="child-add">
      <input id="tName" type="text" placeholder="标签名（如 预习）" class="grow" />
      <input id="tColor" type="color" style="width:40px;height:34px;padding:2px" value="#2bb673" />
      <button class="btn-primary btn-sm" id="tAdd">添加</button>
    </div>

    <div class="section-title">兑换商店目录</div>
    <div class="card" id="shopCard"></div>
    <div class="child-add">
      <input id="sName" type="text" placeholder="奖励名（如 看一集动画）" class="grow" />
      <input id="sCost" type="number" placeholder="积分" style="width:70px" />
      <button class="btn-primary btn-sm" id="sAdd">添加</button>
    </div>
    <div class="icon-picker" id="sIconPicker"></div>
    <input type="hidden" id="sIcon" value="🎁" />
    </div>

    <div class="section-title">孩子档案</div>
    <div class="card" id="childrenCard"></div>
    <div class="child-add">
      <input id="cName" type="text" placeholder="孩子姓名" class="grow" />
      <button class="btn-primary btn-sm" id="cAdd">添加</button>
    </div>
    <div class="seg-block" id="cGradeSeg"></div>
    <input type="hidden" id="cGrade" value="准六年级" />

    <div class="section-title">积分中心</div>
    <div id="pointsArea"></div>

    <div class="section-title">任务清单（当前周期 · 当前孩子）</div>
    <div id="tmplArea"></div>

    <div class="section-title">账号</div>
    <div class="card"><button class="btn-ghost btn-sm" id="btnLogout">退出登录</button></div>
  `;

  renderRedeemReqCard();
  initPushToggle();
  renderPlansCard();
  renderPlanTypesCard();
  fillPlanTypeSelect();
  renderTagsCard();
  renderShopCard();
  initShopIconPicker();
  renderChildrenCard();
  const childId = state.currentChildId;
  if (childId && state.currentPlanId) {
    renderPoints(document.getElementById('pointsArea'), childId);
    renderTemplates(document.getElementById('tmplArea'), childId);
  } else {
    document.getElementById('tmplArea').innerHTML =
      `<div class="empty">${!state.currentPlanId ? '请先在上方选择/创建一个学习周期。' : '请先添加孩子。'}</div>`;
  }

  // 新建周期类型
  view.querySelector('#ptAdd').onclick = async () => {
    const name = view.querySelector('#ptName').value.trim();
    if (!name) { toast('请填类型名'); return; }
    try { state.planTypes.push(await db.addPlanType(name)); toast('已添加'); renderPlanTypesCard(); fillPlanTypeSelect(); }
    catch (e) { toast('添加失败：' + e.message); }
  };

  // 新建周期
  view.querySelector('#pAdd').onclick = async () => {
    const name = view.querySelector('#pName').value.trim();
    if (!name) { toast('请填周期名'); return; }
    try {
      const p = await db.addPlan({
        name, type: view.querySelector('#pType').value,
        start_date: view.querySelector('#pStart').value || null,
        end_date: view.querySelector('#pEnd').value || null
      });
      state.plans.push(p);
      auth.switchPlan(p.id);
      fillPlanSwitcher();
      // 询问是否从旧周期复制
      const oldPlans = state.plans.filter(x => x.id !== p.id);
      if (oldPlans.length && state.currentChildId && confirm('是否从某个旧周期复制当前孩子的任务清单？')) {
        const opts = oldPlans.map((o, i) => `${i + 1}. ${o.name}`).join('\n');
        const idx = prompt('选择要复制的旧周期编号：\n' + opts);
        const src = oldPlans[(+idx) - 1];
        if (src) {
          const n = await db.copyTemplates(src.id, p.id, state.currentChildId);
          toast(`已复制 ${n} 个任务`);
        }
      }
      renderPlansCard();
      renderTemplates(document.getElementById('tmplArea'), state.currentChildId);
    } catch (e) { toast('新建失败：' + e.message); }
  };

  // 新建标签
  view.querySelector('#tAdd').onclick = async () => {
    const name = view.querySelector('#tName').value.trim();
    if (!name) { toast('请填标签名'); return; }
    try { state.tags.push(await db.addTag(name, view.querySelector('#tColor').value)); toast('已添加'); renderTagsCard(); }
    catch (e) { toast('添加失败：' + e.message); }
  };

  // 新建奖励项
  view.querySelector('#sAdd').onclick = async () => {
    const name = view.querySelector('#sName').value.trim();
    const cost = +view.querySelector('#sCost').value;
    if (!name || !cost) { toast('请填名称和积分'); return; }
    try { await db.addShopItem({ name, cost_points: cost, icon: view.querySelector('#sIcon').value || '🎁' }); toast('已添加'); renderShopCard(); }
    catch (e) { toast('添加失败：' + e.message); }
  };

  // 年级选择卡
  const cgSeg = view.querySelector('#cGradeSeg');
  cgSeg.innerHTML = segHtml(['准三年级','准四年级','准五年级','准六年级','准初一'], '准六年级', true);
  bindSeg(cgSeg, v => { view.querySelector('#cGrade').value = v; });

  // 新建孩子
  view.querySelector('#cAdd').onclick = async () => {
    const name = view.querySelector('#cName').value.trim();
    if (!name) { toast('请输入姓名'); return; }
    try {
      const c = await db.addChild(name, view.querySelector('#cGrade').value);
      toast('已添加');
      if (!state.currentChildId) { state.currentChildId = c.id; fillChildSwitcher(); }
      renderChildrenCard();
    } catch (e) { toast('添加失败：' + e.message); }
  };

  view.querySelector('#btnLogout').onclick = async () => {
    if (!confirm('确定退出登录？')) return;
    await auth.logout();
    applyModeUI();
    fillChildSwitcher(); fillPlanSwitcher();
    showAuth();
  };
}

function initPushToggle() {
  const btn = document.getElementById('btnPushToggle');
  if (!btn) return;
  // 初始状态
  isPushEnabled().then(on => { btn.textContent = on ? '关闭' : '开启'; });
  btn.onclick = async () => {
    const on = await isPushEnabled();
    if (on) { await disablePush(); btn.textContent = '开启'; }
    else { const ok = await enablePush(); if (ok) btn.textContent = '关闭'; }
  };
}

function renderRedeemReqCard() {
  const card = document.getElementById('redeemReqCard');
  if (!card) return;
  db.fetchPendingRequests().then(list => {
    // 关联孩子名
    card.innerHTML = list.length
      ? list.map(r => {
          const kid = state.children.find(c => c.id === r.child_id);
          return `<div class="mgmt-row">
            <div class="grow">
              <div>${kid ? kid.name : '?'} 想兑「${r.name}」<small style="color:var(--warn)"> ${r.cost_points}分</small></div>
              <small style="color:var(--muted)">${mdhm(r.created_at)}</small>
            </div>
            <button class="btn-primary btn-sm" data-approve="${r.id}">同意</button>
            <button class="btn-ghost btn-sm" data-reject="${r.id}">拒绝</button>
          </div>`;
        }).join('')
      : `<div class="empty">没有待审批的兑换申请。</div>`;
    card.querySelectorAll('[data-approve]').forEach(b => {
      b.onclick = async () => {
        const r = list.find(x => x.id === b.dataset.approve);
        try { await db.decideRedeemRequest(r, true); toast('已同意，已扣分'); renderRedeemReqCard(); if (window.refreshPointBadge) window.refreshPointBadge(); }
        catch (e) { toast('操作失败：' + e.message); }
      };
    });
    card.querySelectorAll('[data-reject]').forEach(b => {
      b.onclick = async () => {
        const r = list.find(x => x.id === b.dataset.reject);
        if (!confirm('拒绝该申请？')) return;
        try { await db.decideRedeemRequest(r, false); toast('已拒绝'); renderRedeemReqCard(); }
        catch (e) { toast('操作失败：' + e.message); }
      };
    });
  }).catch(e => { card.innerHTML = `<div class="empty">加载失败</div>`; });
}

function renderPlanTypesCard() {
  const card = document.getElementById('planTypesCard');
  if (!card) return;
  card.innerHTML = state.planTypes.length
    ? state.planTypes.map(t => `
      <div class="mgmt-row">
        <span class="grow">${t.name}</span>
        <button class="btn-ghost btn-sm" data-del-pt="${t.id}">删除</button>
      </div>`).join('')
    : `<div class="empty">还没有类型。</div>`;
  card.querySelectorAll('[data-del-pt]').forEach(b => {
    b.onclick = async () => {
      try { await db.deletePlanType(b.dataset.delPt); state.planTypes = state.planTypes.filter(x => x.id !== b.dataset.delPt); renderPlanTypesCard(); fillPlanTypeSelect(); toast('已删除'); }
      catch (e) { toast('删除失败：' + e.message); }
    };
  });
}
function fillPlanTypeSelect() {
  const sel = document.getElementById('pType');
  if (!sel) return;
  sel.innerHTML = state.planTypes.map(t => `<option>${t.name}</option>`).join('');
}

function renderPlansCard() {
  const card = document.getElementById('plansCard');
  if (!card) return;
  card.innerHTML = state.plans.length
    ? state.plans.map(p => `
      <div class="mgmt-row">
        <span class="grow">${p.name} <small style="color:var(--muted)">${p.type} ${p.start_date||''}~${p.end_date||''} ${p.status==='archived'?'·归档':''}</small></span>
        <button class="btn-ghost btn-sm" data-archive="${p.id}">${p.status==='archived'?'恢复':'归档'}</button>
        <button class="btn-ghost btn-sm" data-del-plan="${p.id}">删除</button>
      </div>`).join('')
    : `<div class="empty">还没有学习周期。</div>`;
  card.querySelectorAll('[data-archive]').forEach(b => {
    b.onclick = async () => {
      const p = state.plans.find(x => x.id === b.dataset.archive);
      const ns = p.status === 'archived' ? 'active' : 'archived';
      try { await db.updatePlan(p.id, { status: ns }); p.status = ns; renderPlansCard(); toast(ns === 'archived' ? '已归档' : '已恢复'); }
      catch (e) { toast('操作失败：' + e.message); }
    };
  });
  card.querySelectorAll('[data-del-plan]').forEach(b => {
    b.onclick = async () => {
      if (!confirm('删除该周期及其所有任务模板和打卡记录？')) return;
      try { await db.deletePlan(b.dataset.delPlan); state.plans = state.plans.filter(x => x.id !== b.dataset.delPlan); if (state.currentPlanId === b.dataset.delPlan) { state.currentPlanId = null; auth.switchPlan(null); } fillPlanSwitcher(); renderPlansCard(); toast('已删除'); }
      catch (e) { toast('删除失败：' + e.message); }
    };
  });
}

function renderTagsCard() {
  const card = document.getElementById('tagsCard');
  if (!card) return;
  card.innerHTML = state.tags.length
    ? state.tags.map(t => `
      <div class="mgmt-row">
        <span class="color-dot" style="background:${t.color}"></span>
        <span class="grow">${t.name}</span>
        <input type="color" value="${t.color}" data-tag-color="${t.id}" style="width:34px;height:28px;padding:2px" />
        <button class="btn-ghost btn-sm" data-del-tag="${t.id}">删除</button>
      </div>`).join('')
    : `<div class="empty">还没有标签。</div>`;
  card.querySelectorAll('[data-del-tag]').forEach(b => {
    b.onclick = async () => {
      if (!confirm('删除该标签？任务上的该标签关联也会删除。')) return;
      try { await db.deleteTag(b.dataset.delTag); state.tags = state.tags.filter(x => x.id !== b.dataset.delTag); renderTagsCard(); toast('已删除'); }
      catch (e) { toast('删除失败：' + e.message); }
    };
  });
  card.querySelectorAll('[data-tag-color]').forEach(inp => {
    inp.onchange = async () => {
      try { await db.updateTag(inp.dataset.tagColor, { color: inp.value }); const t = state.tags.find(x => x.id === inp.dataset.tagColor); if (t) t.color = inp.value; renderTagsCard(); }
      catch (e) { toast('更新失败：' + e.message); }
    };
  });
}

function initShopIconPicker() {
  const picker = document.getElementById('sIconPicker');
  if (!picker) return;
  const icons = ['🎁','📺','🎮','💰','🍦','🧸','📚','🍟','🍕','🎡','🏊','⚽','🏀','🎨','🚲','🎟️','🍫','🥤','🎪','🎯'];
  picker.innerHTML = icons.map(ic => `<button type="button" class="icon-pick ${ic==='🎁'?'on':''}" data-icon="${ic}">${ic}</button>`).join('');
  picker.querySelectorAll('.icon-pick').forEach(b => {
    b.onclick = () => {
      picker.querySelectorAll('.icon-pick').forEach(x => x.classList.remove('on'));
      b.classList.add('on');
      document.getElementById('sIcon').value = b.dataset.icon;
    };
  });
}

function renderShopCard() {
  const card = document.getElementById('shopCard');
  if (!card) return;
  db.fetchShop().then(items => {
    card.innerHTML = items.length
      ? items.map(s => `
        <div class="mgmt-row">
          <span style="font-size:18px">${s.icon||'🎁'}</span>
          <span class="grow">${s.name} <small style="color:var(--warn)">${s.cost_points}分</small></span>
          <button class="btn-ghost btn-sm" data-toggle-shop="${s.id}">${s.active?'下架':'上架'}</button>
          <button class="btn-ghost btn-sm" data-del-shop="${s.id}">删除</button>
        </div>`).join('')
      : `<div class="empty">还没有奖励项。</div>`;
    card.querySelectorAll('[data-toggle-shop]').forEach(b => {
      b.onclick = async () => {
        const s = items.find(x => x.id === b.dataset.toggleShop);
        try { await db.updateShopItem(s.id, { active: !s.active }); renderShopCard(); }
        catch (e) { toast('操作失败：' + e.message); }
      };
    });
    card.querySelectorAll('[data-del-shop]').forEach(b => {
      b.onclick = async () => {
        try { await db.deleteShopItem(b.dataset.delShop); renderShopCard(); toast('已删除'); }
        catch (e) { toast('删除失败：' + e.message); }
      };
    });
  }).catch(e => { card.innerHTML = `<div class="empty">加载失败</div>`; });
}

function renderChildrenCard() {
  const card = document.getElementById('childrenCard');
  if (!card) return;
  card.innerHTML = state.children.length
    ? state.children.map(c => `
      <div class="row-line">
        <span>${c.name}（${c.grade_target || ''}）</span>
        <button class="btn-ghost btn-sm" data-del-child="${c.id}">删除</button>
      </div>`).join('')
    : `<div class="empty">还没有孩子档案。</div>`;
  card.querySelectorAll('[data-del-child]').forEach(b => {
    b.onclick = async () => {
      if (!confirm('删除该孩子及其所有任务记录？')) return;
      try { await db.removeChild(b.dataset.delChild); toast('已删除'); fillChildSwitcher(); renderChildrenCard(); }
      catch (e) { toast('删除失败：' + e.message); }
    };
  });
}

boot();
