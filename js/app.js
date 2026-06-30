// ============================================================
// app.js：路由 / 导航 / 初始化
// ============================================================
import { state, toast } from './supabase.js';
import * as auth from './auth.js';
import * as db from './db.js';
import { renderToday, renderTemplates } from './tasks.js';
import { renderVerify } from './verify.js';
import { renderStats } from './stats.js';
import { renderLife } from './life.js';
import { renderPoints, refreshPointBadge } from './points.js';

const view = document.getElementById('view');
const authScreen = document.getElementById('authScreen');

// 暴露给其他模块（如 verify.js 验收后刷新顶栏积分）
window.refreshPointBadge = refreshPointBadge;

let realtimeChannel = null;

// ---------- 初始化 ----------
async function boot() {
  registerSW();
  bindAuthUI();
  bindTabs();
  bindChildSwitcher();
  bindRoleSwitcher();
  window.addEventListener('online', () => { toast('已联网，同步中…'); db.flushQueue(); refreshCurrent(); });

  // 从本地 session 恢复
  const fam = await auth.restoreSession();
  if (fam) await maybeEnterApp();
  else showAuth();
}

async function maybeEnterApp() {
  if (!state.family?.id) { showAuth(); return; }
  syncRoleSwitcher();
  await db.fetchChildren();
  if (!state.currentChildId && state.children.length) {
    state.currentChildId = state.children[0].id;
  }
  fillChildSwitcher();
  authScreen.style.display = 'none';
  switchTab(state.pendingTab || 'today');
}

// ---------- Service Worker ----------
function registerSW() {
  if ('serviceWorker' in navigator) {
    navigator.serviceWorker.register('./sw.js').catch(e => console.warn('SW reg fail', e));
  }
}

// ---------- 鉴权 UI（家庭密码版） ----------
function bindAuthUI() {
  const $ = id => document.getElementById(id);
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
    try { await auth.loginWithPassword($('familyName').value, $('password').value); await maybeEnterApp(); }
    catch (e) { authMsg(e.message); }
  };
  $('btnCreateFamily').onclick = async () => {
    try {
      await auth.createFamily($('familyName').value, $('password').value, $('newRole').value);
      await maybeEnterApp();
    } catch (e) { authMsg(e.message); }
  };
}
function authMsg(m) { document.getElementById('authMsg').textContent = m; }
function showAuth() {
  authScreen.style.display = 'flex';
}

// ---------- 角色切换（妈妈/爸爸） ----------
function bindRoleSwitcher() {
  const sel = document.getElementById('roleSwitcher');
  if (!sel) return;
  sel.onchange = () => { auth.switchRole(sel.value); syncRoleSwitcher(); };
}
function syncRoleSwitcher() {
  const sel = document.getElementById('roleSwitcher');
  if (sel) sel.value = state.currentRole;
}

// ---------- 底部 Tab ----------
function bindTabs() {
  document.querySelectorAll('.tab').forEach(t => {
    t.onclick = () => switchTab(t.dataset.tab);
  });
}

function switchTab(tab) {
  state.pendingTab = tab;
  document.querySelectorAll('.tab').forEach(t =>
    t.classList.toggle('active', t.dataset.tab === tab));
  const titles = { today:'今日', verify:'验收', stats:'统计', life:'生活', setup:'设置' };
  document.getElementById('topTitle').textContent = titles[tab] || '';
  refreshCurrent();
}

function refreshCurrent() {
  if (!state.family?.id) return;
  const tab = state.pendingTab;
  if (tab === 'today') renderToday(view);
  else if (tab === 'verify') renderVerify(view);
  else if (tab === 'stats') renderStats(view);
  else if (tab === 'life') renderLife(view);
  else if (tab === 'setup') renderSetup(view);
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
  realtimeChannel = db.subscribeRecords(state.currentChildId, () => {
    refreshCurrent();
  });
}

// ---------- 设置页 ----------
function renderSetup(view) {
  view.innerHTML = `
    <div class="page-head"><div><div class="date-label">设置</div></div></div>

    <div class="section-title">家庭</div>
    <div class="card">
      <div class="row-line"><span>家庭名称</span><span>${state.family?.name || '—'}</span></div>
      <div class="row-line"><span>当前角色</span>
        <select id="roleSwitcher2">
          <option value="妈妈">妈妈</option>
          <option value="爸爸">爸爸</option>
        </select>
      </div>
      <div class="row-hint">爸妈共用一个家庭密码，这里切换当前操作人（验收/打卡会记录是谁）。</div>
    </div>

    <div class="section-title">孩子档案</div>
    <div class="card" id="childrenCard"></div>
    <div class="child-add">
      <input id="cName" type="text" placeholder="孩子姓名" />
      <select id="cGrade">
        <option>准三年级</option><option>准四年级</option><option>准五年级</option>
        <option>准六年级</option><option>准初一</option>
      </select>
      <button class="btn-primary btn-sm" id="cAdd">添加</button>
    </div>

    <div class="section-title">积分中心</div>
    <div id="pointsArea"></div>

    <div class="section-title">任务模板（当前孩子）</div>
    <div id="tmplArea"></div>

    <div class="section-title">账号</div>
    <div class="card">
      <button class="btn-ghost btn-sm" id="btnLogout">退出登录</button>
    </div>
  `;

  // 角色切换
  const rs2 = view.querySelector('#roleSwitcher2');
  if (rs2) {
    rs2.value = state.currentRole;
    rs2.onchange = () => { auth.switchRole(rs2.value); toast('已切换为 ' + rs2.value); };
  }

  renderChildrenCard();
  const childId = state.currentChildId;
  if (childId) {
    renderPoints(document.getElementById('pointsArea'), childId);
    renderTemplates(document.getElementById('tmplArea'), childId);
  }

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
    fillChildSwitcher();
    showAuth();
  };
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
