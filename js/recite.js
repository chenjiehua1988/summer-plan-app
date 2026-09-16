// ============================================================
// 背诵模块：新概念课文/单词背诵记录
// 记录每次背诵（课次+课文质量+错词+录音），统计熟练度、生词本，
// 生成复习建议（倒序扫读游标 + 间隔到期插队）。
// ============================================================
import { state, todayStr, toast, segHtml, bindSeg, bookCfgs, bookNames } from './supabase.js';
import * as db from './db.js';

const Q_LABEL = { perfect: '一遍过', hint: '有提示', fail: '没背下来' };
const Q_CLS = { perfect: 'lv3', hint: 'lv2', fail: 'lv1', '': 'lv0' };
// 熟练度：连续顺利1次=🔴生疏 2次=🟡一般 ≥3次=🟢熟练
// 复习间隔：streak 0/1→1天 2→3天 3→7天 4→15天 ≥5→30天
const INTERVAL = [1, 1, 3, 7, 15];

// 课本配置来自 families.books（设置页管理）；step=2 时课文在奇数课（偶数课是练习）
function bookCfg(book) {
  return bookCfgs().find(b => b.name === book) || { lessons: 96, step: 1 };
}
// 生成该课本全部课号列表：step=1 → 1..lessons；step=2 → 1,3,5..lessons
function lessonList(book) {
  const { lessons, step } = bookCfg(book);
  const a = [];
  for (let i = 1; i <= lessons; i += step || 1) a.push(i);
  return a;
}
// 复习/默认课号的步长（单双配对的课本按单课 -2 走）
function pairStep(book) { return bookCfg(book).step || 1; }
// 下一节新课号（新概念一取下一个单课）
function nextNewLesson(book, maxLearned) {
  if (pairStep(book) === 1) return maxLearned + 1;
  return maxLearned % 2 === 1 ? maxLearned + 2 : maxLearned + 1;
}
function addDays(dateStr, n) {
  const d = new Date(dateStr + 'T00:00:00');
  d.setDate(d.getDate() + n);
  return todayStr(d);
}
// 词表粘贴解析：一行一条；整行带空格（词+释义）就整行保留，释义里的逗号不拆；
// 只有不含空格的裸词行才按逗号/顿号/分号拆开
function parseWordList(text) {
  const out = [];
  text.split(/\n+/).map(s => s.trim()).filter(Boolean).forEach(line => {
    if (/\s/.test(line)) { out.push(line); return; }
    line.split(/[,，、;；]+/).map(s => s.trim()).filter(Boolean).forEach(w => out.push(w));
  });
  return out.slice(0, 100);
}
// 单词键：取首词（去释义），错词记录/生词本统一用它
function wordKey(w) { return String(w).trim().split(/\s+/)[0]; }

// ---------- 任务是否显示背诵登记区块（今日打卡面板用） ----------
// 以标签为准：任务标签含「背诵」才显示登记区块
export function isReciteTask(r) {
  return (r.tags || []).some(t => /背诵/.test(t));
}

// ---------- 统计：每课熟练度（由记录推导，不落库） ----------
function calcLessonStats(recs, book) {
  const map = {};
  for (const r of recs) {
    if (r.book !== book) continue;
    (map[r.lesson_no] = map[r.lesson_no] || []).push(r);
  }
  const today = todayStr();
  const out = {};
  for (const k of Object.keys(map)) {
    const list = map[k].slice().sort((a, b) =>
      (a.recite_date + (a.created_at || '')).localeCompare(b.recite_date + (b.created_at || '')));
    let streak = 0;
    for (let i = list.length - 1; i >= 0; i--) {
      if (list[i].text_quality === 'perfect') streak++; else break;
    }
    const level = streak >= 3 ? 3 : streak === 2 ? 2 : 1;
    const interval = streak >= 5 ? 30 : INTERVAL[streak];
    const last = list[list.length - 1];
    const nextDue = addDays(last.recite_date, interval);
    out[k] = { recs: list, streak, level, lastDate: last.recite_date, nextDue, overdue: today > nextDue };
  }
  return out;
}

// ---------- 生词本：最近一次结果是错的留在「未掌握」；之后答对过一次算「已掌握」（保留展示/导出） ----------
function calcWordBook(recs, book, lists) {
  const lmap = {};
  (lists || []).forEach(l => { lmap[l.lesson_no] = l.words || []; });
  const words = {};
  for (const r of recs) {
    if (r.book !== book) continue;
    for (const w of (r.wrong_words || [])) {
      const key = String(w).trim();
      if (!key) continue;
      const e = words[key] = words[key] || { word: key, miss: 0, firstMissed: '', lastMissed: '', lessons: new Set(), lesson: r.lesson_no };
      e.miss++;
      e.lessons.add(r.lesson_no);
      if (!e.firstMissed || r.recite_date < e.firstMissed) e.firstMissed = r.recite_date;
      if (r.recite_date > e.lastMissed) { e.lastMissed = r.recite_date; e.lesson = r.lesson_no; }
    }
  }
  // 出本（转已掌握）：lastMissed 之后同课有一次带词表的背诵且没再错
  const active = [], mastered = [];
  for (const key of Object.keys(words)) {
    const e = words[key];
    const after = recs.filter(r => r.book === book && r.lesson_no === e.lesson
      && r.recite_date > e.lastMissed && (r.words_total || 0) > 0);
    (after.some(r => !(r.wrong_words || []).includes(key)) ? mastered : active).push(e);
  }
  const byMiss = (a, b) => b.miss - a.miss || b.lastMissed.localeCompare(a.lastMissed);
  return { active: active.sort(byMiss), mastered: mastered.sort(byMiss) };
}

// ---------- 家长导出错词 CSV（聚合：单词/次数/状态/涉及课/首错/最近错） ----------
function exportWrongWords(childId, recs, listsByBook) {
  const name = (state.children.find(x => x.id === childId) || {}).name || '孩子';
  const rows = [['书', '单词', '错误次数', '状态', '错过的课', '首错日期', '最近错日期']];
  for (const b of [...new Set(recs.map(r => r.book))]) {
    const wb = calcWordBook(recs, b, listsByBook[b]);
    const push = (e, ok) => rows.push([b, e.word, e.miss, ok ? '已掌握' : '未掌握',
      [...e.lessons].sort((a, c) => a - c).map(l => 'L' + l).join(' '), e.firstMissed, e.lastMissed]);
    wb.active.forEach(e => push(e, false));
    wb.mastered.forEach(e => push(e, true));
  }
  if (rows.length === 1) { toast('还没有错词记录'); return; }
  const csv = '﻿' + rows.map(r => r.map(v => `"${String(v).replace(/"/g, '""')}"`).join(',')).join('\n');
  const a = document.createElement('a');
  a.href = URL.createObjectURL(new Blob([csv], { type: 'text/csv' }));
  a.download = `错词-${name}-${todayStr()}.csv`;
  document.body.appendChild(a);
  a.click();
  a.remove();
  toast(`已导出 ${rows.length - 1} 条错词 → 下载目录`);
}

// ---------- 倒序游标推进（保存一条记录后调用） ----------
// 新课不动游标；复习：课号≤游标或游标到头/未开始 → 跟随，否则视为插队不动
export async function updateCursorAfterSave(childId, book, lessonNo, isFirst) {
  try {
    const sts = await db.fetchReciteStates(childId);
    const st = sts.find(x => x.book === book);
    let cur = st ? st.cursor_lesson : null;
    if (!isFirst) {
      if (cur == null || cur <= 1 || lessonNo <= cur) cur = lessonNo;
      if (st || cur != null) await db.upsertReciteState(childId, book, cur);
    } else if (st) {
      await db.upsertReciteState(childId, book, cur); // 新课不动，仅刷新时间戳
    }
  } catch (e) { console.warn('cursor update failed', e.message); }
}

// ============================================================
// 背诵 tab 主视图
// ============================================================
export async function renderRecite(view) {
  const childId = state.currentChildId;
  if (!childId) { view.innerHTML = `<div class="empty">请先添加孩子。</div>`; return; }
  view.innerHTML = `<div class="loading">加载中…</div>`;
  try {
    const isParent = state.mode === 'parent';
    const c = state.children.find(x => x.id === childId) || { name: '' };
    // 只加载当前选中孩子的记录（与进度/历史一致，不再显示其他孩子的建议卡）
    const [recs, sts] = await Promise.all([db.fetchRecitations(childId), db.fetchReciteStates(childId)]);
    // 词表（生词本计算用）
    const listsByBook = {};
    for (const b of bookNames()) {
      try { listsByBook[b] = await db.fetchAllLessonWords(b); } catch (e) { listsByBook[b] = []; }
    }

    view.innerHTML = `
      <div class="page-head">
        <div>
          <div class="date-label">📖 背诵</div>
          <div class="progress-label">课文背诵 · 单词 · 复习提醒</div>
        </div>
        ${isParent ? `<div style="display:flex;gap:8px">
          <button class="btn-ghost btn-sm" id="rcExport">⬇ 导出错词</button>
          <button class="btn-ghost btn-sm" id="rcWords">📋 词表</button>
          <button class="btn-primary btn-sm" id="rcAdd">＋ 补录</button></div>` : ''}
      </div>
      <div id="rcSug"></div>
      <div class="section-title">进度与熟练度</div>
      <div id="rcProgress">${progressHtml(recs, listsByBook)}</div>
      <div class="section-title">最近记录</div>
      <div id="rcHistory"></div>
    `;

    // 点进度格子 → 看这一课的全部历史（手机也能用）
    view.querySelectorAll('#rcProgress [data-lg]').forEach(cell => {
      cell.onclick = () => {
        const [b, l] = cell.dataset.lg.split('|');
        openLessonHistory(b, +l, recs, isParent, () => renderRecite(view));
      };
    });

    // 复习建议卡（当前孩子的每本书一块）
    const sugEl = view.querySelector('#rcSug');
    const books = [...new Set(recs.map(r => r.book))];
    sugEl.innerHTML = books.map(b => {
      const stats = calcLessonStats(recs, b);
      const st = sts.find(x => x.book === b);
      const cur = st ? st.cursor_lesson : null;
      return suggestionHtml(c.name, b, stats, cur);
    }).join('') || `<div class="empty">还没有背诵记录。完成背诵类任务的打卡，或由家长「补录」。</div>`;

    // 历史列表
    const histEl = view.querySelector('#rcHistory');
    if (!recs.length) histEl.innerHTML = `<div class="empty">还没有背诵记录。</div>`;
    else {
      histEl.innerHTML = `<ul class="task-list">${recs.slice(0, 30).map(r => histRow(r, isParent)).join('')}</ul>`;
      histEl.querySelectorAll('[data-delrec]').forEach(b => {
        b.onclick = async () => {
          if (!confirm('删除这条背诵记录？熟练度会重新计算。')) return;
          try { await db.deleteRecitation(b.dataset.delrec); toast('已删除'); renderRecite(view); }
          catch (e) { toast('删除失败：' + e.message); }
        };
      });
    }

    // 补录 / 词表管理
    const addBtn = view.querySelector('#rcAdd');
    if (addBtn) addBtn.onclick = () => openRecitePanel(childId, () => renderRecite(view));
    const wlBtn = view.querySelector('#rcWords');
    if (wlBtn) wlBtn.onclick = () => openWordListPanel(childId, () => renderRecite(view));
    const exBtn = view.querySelector('#rcExport');
    if (exBtn) exBtn.onclick = () => exportWrongWords(childId, recs, listsByBook);
  } catch (e) {
    console.warn(e);
    view.innerHTML = `<div class="empty">加载失败：${e.message}</div>`;
  }
}

function suggestionHtml(name, book, stats, cursor) {
  const learned = Object.keys(stats).map(Number).sort((a, b) => b - a);
  if (!learned.length) return '';
  const overdue = learned.filter(l => stats[l].overdue);
  let line = '';
  if (cursor == null) line = `▶️ 建议开始倒序复习，从 <b>L${learned[0]}</b> 往前`;
  else if (cursor <= 1) line = `🔄 第一轮倒序已扫完，建议从 <b>L${learned[0]}</b> 重新开始`;
  else {
    const s = pairStep(book);
    const nexts = [cursor - s, cursor - 2 * s].filter(l => l >= 1 && stats[l]);
    line = nexts.length ? `➡️ 倒序复习：<b>${nexts.map(l => 'L' + l).join('、')}</b>` : `➡️ 倒序复习：继续往前（L${cursor - s} 之前还没背）`;
  }
  const odLine = overdue.length
    ? `<div class="rc-od">⏰ 插队：${overdue.slice(0, 3).map(l => `<b>L${l}</b>`).join('、')} 已超期（上次 ${stats[overdue[0]].lastDate}）</div>` : '';
  return `
    <div class="card rc-sug">
      <div class="rc-sug-head">${name} · ${book}</div>
      ${odLine}
      <div class="rc-sug-line">${line}</div>
    </div>`;
}

function progressHtml(recs, listsByBook) {
  const books = [...new Set(recs.map(r => r.book))];
  if (!books.length) return `<div class="empty">还没有背诵记录。</div>`;
  return books.map(b => {
    const stats = calcLessonStats(recs, b);
    const wb = calcWordBook(recs, b, listsByBook[b]);
    const all = lessonList(b);
    const cells = all.map(l => {
      const s = stats[l];
      const cls = s ? 'lv' + s.level + (s.overdue ? ' od' : '') : '';
      const tip = s ? `L${l}：背过${s.recs.length}次 · ${Q_LABEL[s.recs[s.recs.length - 1].text_quality] || '—'} · 上次 ${s.lastDate}` : `L${l}：未背`;
      return `<span class="rg-cell ${cls}" data-lg="${b}|${l}" style="cursor:pointer" title="${tip}">${l}</span>`;
    }).join('');
    const cnt = Object.keys(stats).length;
    const green = Object.values(stats).filter(s => s.level === 3).length;
    const chip = (w, ok) => `<span class="word-chip bad"${ok ? ' style="opacity:.5"' : ''}>${w.word}×${w.miss}${ok ? ' ✓' : ''}</span>`;
    let wbLine = '';
    if (wb.active.length || wb.mastered.length) {
      const act = wb.active.length
        ? wb.active.slice(0, 8).map(w => chip(w)).join('') + (wb.active.length > 8 ? ' …' : '')
        : '无 🎉';
      const mas = wb.mastered.length
        ? `<div style="margin-top:4px;color:var(--muted)">✓ 已掌握（${wb.mastered.length}）：`
          + wb.mastered.slice(0, 8).map(w => chip(w, true)).join('') + (wb.mastered.length > 8 ? ' …' : '') + '</div>'
        : '';
      wbLine = `<div class="rc-words">📌 未掌握（${wb.active.length}）：${act}${mas}</div>`;
    }
    return `
      <div class="card rc-prog">
        <div class="rc-sug-head">${b} <small>已学 ${cnt}/${all.length} 课 · 🟢熟练 ${green} 课</small></div>
        <div class="recite-grid">${cells}</div>
        ${wbLine}
      </div>`;
  }).join('');
}

function histRow(r, isParent) {
  const audios = r.audio_urls || [];
  const wrong = r.wrong_words || [];
  return `
    <li class="task-item is-done">
      <div class="task-body" style="flex:1">
        <div class="task-title">${r.book} L${r.lesson_no} <small style="color:var(--muted)">${r.kind === 'new' ? '新课' : '复习'}</small></div>
        <div class="task-meta">
          <span class="badge ${Q_CLS[r.text_quality || '']}">${r.text_quality ? Q_LABEL[r.text_quality] : '没背课文'}</span>
          ${r.words_total > 0 ? `<span class="note">单词 ${r.words_total - wrong.length}/${r.words_total}</span>` : ''}
          ${wrong.length ? `<span class="note" style="color:var(--no)">错：${wrong.join('、')}</span>` : ''}
          ${audios.length ? `<span class="note">🎙×${audios.length}</span>` : ''}
        </div>
        ${r.note ? `<div class="task-note">📝 ${r.note}</div>` : ''}
        <div class="task-meta"><span class="note">${r.recite_date} · ${r.created_by || ''}</span></div>
        ${audios.length ? `<div class="rc-audio">${audios.map(u => `<audio controls preload="none" src="${u}"></audio>`).join('')}</div>` : ''}
      </div>
      ${isParent ? `<button class="btn-ghost btn-sm" data-delrec="${r.id}" style="color:var(--no)">删</button>` : ''}
    </li>`;
}

// 某一课的全部背诵记录（点进度格子弹出；手机无 hover，用点击看历史）
function openLessonHistory(book, lessonNo, recs, isParent, onDeleted) {
  const list = recs.filter(r => r.book === book && r.lesson_no === lessonNo)
    .sort((a, b) => b.recite_date.localeCompare(a.recite_date));
  const overlay = document.createElement('div');
  overlay.className = 'checkin-overlay';
  overlay.innerHTML = `
    <div class="checkin-sheet">
      <div class="checkin-head">
        <span class="checkin-title">${book} L${lessonNo} · 背过 ${list.length} 次</span>
        <button class="btn-ghost btn-sm" id="lhClose">关闭</button>
      </div>
      ${list.length
        ? `<ul class="task-list">${list.map(r => histRow(r, isParent)).join('')}</ul>`
        : `<div class="empty">这一课还没背过。</div>`}
    </div>`;
  document.body.style.overflow = 'hidden';
  document.body.appendChild(overlay);
  const close = () => { document.body.style.overflow = ''; overlay.remove(); };
  overlay.addEventListener('click', e => { if (e.target === overlay) close(); });
  overlay.querySelector('#lhClose').onclick = close;
  overlay.querySelectorAll('[data-delrec]').forEach(b => {
    b.onclick = async () => {
      if (!confirm('删除这条背诵记录？熟练度会重新计算。')) return;
      try { await db.deleteRecitation(b.dataset.delrec); toast('已删除'); close(); onDeleted && onDeleted(); }
      catch (e) { toast('删除失败：' + e.message); }
    };
  });
}

// ============================================================
// 背诵登记面板（家长补录用，含录音；孩子打卡面板的精简版在下方）
// ============================================================
export function openRecitePanel(childId, onSaved) {
  const isParent = state.mode === 'parent';
  const overlay = document.createElement('div');
  overlay.className = 'checkin-overlay';
  overlay.innerHTML = `
    <div class="checkin-sheet">
      <div class="checkin-head">
        <span class="checkin-title">背诵登记</span>
        <button class="btn-ghost btn-sm" id="rpClose">取消</button>
      </div>
      <div class="tp-row">
        <div class="seg-block" id="rpBook" style="flex:1"></div>
      </div>
      <div class="tp-row">
        <div class="seg-block" id="rpKind" style="flex:1"></div>
        <label class="tp-label">课号 <input type="number" id="rpLesson" min="1" style="width:76px"></label>
        ${isParent ? `<label class="tp-label">日期 <input type="date" id="rpDate" style="width:140px"></label>` : ''}
      </div>
      <div class="tp-label">课文质量</div>
      <div class="seg-block" id="rpQuality"></div>
      <div class="tp-label">单词</div>
      <div id="rpWords"><div class="loading">加载词表…</div></div>
      <div id="rpPasteBox" style="display:none">
        <textarea class="checkin-note" id="rpPaste" rows="3" placeholder="一行一个，也可空格/逗号隔开；可带释义，如：mistake 错误"></textarea>
        <button class="btn-ghost btn-sm" id="rpPasteSave" style="margin-bottom:8px">保存词表</button>
      </div>
      <div class="tp-label">录音（可选）</div>
      <div class="checkin-rec">
        <span id="rpRecTime">00:00</span>
        <button class="btn-primary btn-sm" id="rpRecToggle">开始</button>
        <span class="checkin-hint" id="rpRecHint"></span>
      </div>
      <div class="checkin-picked" id="rpPicked"></div>
      <input class="checkin-note" id="rpNote" type="text" placeholder="备注（可选）" />
      <button class="btn-primary checkin-submit" id="rpSave">保存</button>
    </div>`;
  document.body.style.overflow = 'hidden';
  document.body.appendChild(overlay);
  const $ = s => overlay.querySelector(s);
  const close = () => { stopRec(); document.body.style.overflow = ''; overlay.remove(); };
  overlay.addEventListener('click', e => { if (e.target === overlay) close(); });
  $('#rpClose').onclick = close;

  const f = { book: bookNames()[0], kind: 'new', quality: 'perfect', lesson: 1, wrong: new Set(), words: null, blobs: [] };
  // 录音
  const mime = MediaRecorder.isTypeSupported('audio/webm') ? 'webm'
    : MediaRecorder.isTypeSupported('audio/mp4') ? 'mp4' : '';
  let recorder = null, recTimer = null, recSec = 0, recording = false;
  function stopRec() {
    if (recording && recorder && recorder.state !== 'inactive') recorder.stop();
    recording = false;
    if (recTimer) { clearInterval(recTimer); recTimer = null; }
  }
  $('#rpRecToggle').onclick = () => {
    if (!recording) {
      navigator.mediaDevices.getUserMedia({ audio: true }).then(stream => {
        const chunks = [];
        recorder = new MediaRecorder(stream, mime ? { mimeType: 'audio/' + mime } : undefined);
        recorder.ondataavailable = e => { if (e.data.size) chunks.push(e.data); };
        recorder.onstop = () => {
          const blob = new Blob(chunks.slice(), { type: 'audio/' + mime });
          f.blobs.push({ blob, ext: mime, sec: recSec });
          renderPicked();
          stream.getTracks().forEach(t => t.stop());
        };
        recSec = 0; recorder.start(); recording = true;
        $('#rpRecToggle').textContent = '停止';
        recTimer = setInterval(() => { recSec++; $('#rpRecTime').textContent = fmtSec(recSec); }, 1000);
      }).catch(() => { $('#rpRecHint').textContent = '无法访问麦克风'; });
    } else stopRec();
  };
  function renderPicked() {
    $('#rpRecToggle').textContent = recording ? '停止' : (f.blobs.length ? '再录一段' : '开始');
    $('#rpPicked').innerHTML = f.blobs.map((a, i) =>
      `<span class="pick-chip">🎙${a.sec}秒<b data-rm="${i}">×</b></span>`).join('');
    overlay.querySelectorAll('[data-rm]').forEach(b => b.onclick = () => {
      if (!confirm('确认删除这段录音？')) return;
      f.blobs.splice(+b.dataset.rm, 1); renderPicked();
    });
  }

  // 初始化：默认书 = 该孩子最近一次记录的书；默认课号按类型给
  let existed = new Set(), cursor = null, maxLearned = 0;
  (async () => {
    try {
      const [recs, sts] = await Promise.all([db.fetchRecitations(childId), db.fetchReciteStates(childId)]);
      if (recs.length) f.book = recs[0].book;
      existed = new Set(recs.filter(r => r.book === f.book).map(r => r.lesson_no));
      maxLearned = existed.size ? Math.max(...existed) : 0;
      const st = sts.find(x => x.book === f.book);
      cursor = st ? st.cursor_lesson : null;
    } catch (e) { console.warn('recite init', e.message); }
    $('#rpBook').innerHTML = segHtml(bookNames(), f.book, true);
    $('#rpKind').innerHTML = segHtml([{ value: 'new', label: '新课' }, { value: 'review', label: '复习' }], f.kind, true);
    $('#rpQuality').innerHTML = segHtml([
      { value: 'perfect', label: '一遍过' }, { value: 'hint', label: '有提示' },
      { value: 'fail', label: '没背下来' }, { value: '', label: '没背课文' }
    ], f.quality, true);
    bindSeg($('#rpBook'), v => { f.book = v; resetLessonDefault(); });
    bindSeg($('#rpKind'), v => { f.kind = v; resetLessonDefault(); });
    bindSeg($('#rpQuality'), v => { f.quality = v; });
    if ($('#rpDate')) $('#rpDate').value = todayStr();
    resetLessonDefault();
  })();

  function resetLessonDefault() {
    (async () => {
      try {
        const [recs, sts] = await Promise.all([db.fetchRecitations(childId), db.fetchReciteStates(childId)]);
        existed = new Set(recs.filter(r => r.book === f.book).map(r => r.lesson_no));
        maxLearned = existed.size ? Math.max(...existed) : 0;
        const st = sts.find(x => x.book === f.book);
        cursor = st ? st.cursor_lesson : null;
      } catch (e) { console.warn('recite reset', e.message); }
      f.lesson = f.kind === 'new' ? nextNewLesson(f.book, maxLearned) : (cursor ? Math.max(1, cursor - pairStep(f.book)) : maxLearned);
      $('#rpLesson').value = f.lesson;
      loadWords();
    })();
  }
  $('#rpLesson').onchange = () => { f.lesson = +$('#rpLesson').value || 1; loadWords(); };

  // 词表加载 + 芯片
  async function loadWords() {
    const box = $('#rpWords');
    if (!f.lesson) { box.innerHTML = ''; f.words = null; return; }
    box.innerHTML = `<div class="loading">加载词表…</div>`;
    let row = null;
    try { row = await db.fetchLessonWords(f.book, f.lesson); } catch (e) {}
    f.words = row ? row.words : null;
    f.wrong = new Set();
    renderWords();
  }
  function renderWords() {
    const box = $('#rpWords');
    if (f.words && f.words.length) {
      box.innerHTML = `
        <div class="rc-wordchips">${f.words.map(w => {
          const k = wordKey(w);
          return `<span class="word-chip ${f.wrong.has(k) ? 'bad' : ''}" data-w="${escAttr(k)}">${escHtml(w)}</span>`;
        }).join('')}</div>
        <div class="tp-label" style="margin-top:4px">点单词标错，全对不用动</div>`;
      box.querySelectorAll('.word-chip').forEach(ch => ch.onclick = () => {
        const w = ch.dataset.w;
        if (f.wrong.has(w)) f.wrong.delete(w); else f.wrong.add(w);
        renderWords();
      });
    } else {
      box.innerHTML = `
        <div class="checkin-hint" style="color:var(--muted);font-size:13px">本课还没有词表，只记整体对错；可粘贴词表后逐词标错。</div>
        <button class="btn-ghost btn-sm" id="rpPasteOpen">📋 粘贴本课词表</button>
        <input class="checkin-note" id="rpWrongManual" type="text" placeholder="背错的单词（空格/逗号隔开，可选）" style="margin-top:6px" />`;
      box.querySelector('#rpPasteOpen').onclick = () => { $('#rpPasteBox').style.display = ''; };
    }
  }
  $('#rpPasteSave').onclick = async () => {
    const words = parseWordList($('#rpPaste').value);
    if (!words.length) { toast('请先粘贴单词'); return; }
    try {
      await db.saveLessonWords(f.book, f.lesson, words);
      f.words = words; f.wrong = new Set();
      $('#rpPasteBox').style.display = 'none';
      renderWords();
      toast('词表已保存');
    } catch (e) { toast('保存失败：' + e.message); }
  };

  $('#rpSave').onclick = async () => {
    const lessonNo = +$('#rpLesson').value || 0;
    if (!lessonNo) { toast('请填课号'); return; }
    const manual = overlay.querySelector('#rpWrongManual');
    const wrongWords = f.words && f.words.length ? [...f.wrong] : (manual ? parseWordList(manual.value) : []);
    stopRec();
    const btn = $('#rpSave');
    btn.disabled = true; btn.textContent = '保存中…';
    try {
      const urls = [];
      for (let i = 0; i < f.blobs.length; i++) {
        btn.textContent = `上传录音 ${i + 1}/${f.blobs.length}…`;
        urls.push(await db.uploadReciteAudio(childId, f.blobs[i].blob, f.blobs[i].ext));
      }
      await db.addRecitation({
        child_id: childId, book: f.book, lesson_no: lessonNo, kind: f.kind,
        text_quality: f.quality || null,
        wrong_words: wrongWords, words_total: f.words && f.words.length ? f.words.length : 0,
        audio_urls: urls, note: $('#rpNote').value.trim() || null,
        recite_date: ($('#rpDate') && $('#rpDate').value) || todayStr()
      });
      await updateCursorAfterSave(childId, f.book, lessonNo, !existed.has(lessonNo));
      toast('已登记 ✓');
      close();
      onSaved && onSaved();
    } catch (e) { toast('保存失败：' + e.message); btn.disabled = false; btn.textContent = '保存'; }
  };
}

// ============================================================
// 词表管理面板：只维护某本书某课的单词表，不产生任何背诵记录
// ============================================================
export function openWordListPanel(childId, onSaved) {
  const overlay = document.createElement('div');
  overlay.className = 'checkin-overlay';
  overlay.innerHTML = `
    <div class="checkin-sheet">
      <div class="checkin-head">
        <span class="checkin-title">课程词表</span>
        <button class="btn-ghost btn-sm" id="wpClose">取消</button>
      </div>
      <div class="tp-row">
        <div class="seg-block" id="wpBook" style="flex:1"></div>
        <label class="tp-label">课号 <input type="number" id="wpLesson" min="1" style="width:76px"></label>
      </div>
      <div id="wpLearned" style="margin:6px 0"></div>
      <textarea class="checkin-note" id="wpPaste" rows="6" placeholder="一行一个，可带释义，如：mistake 错误"></textarea>
      <div class="checkin-hint" id="wpCount" style="margin:6px 0"></div>
      <button class="btn-primary checkin-submit" id="wpSave">保存词表</button>
    </div>`;
  document.body.style.overflow = 'hidden';
  document.body.appendChild(overlay);
  const $ = s => overlay.querySelector(s);
  const close = () => { document.body.style.overflow = ''; overlay.remove(); };
  overlay.addEventListener('click', e => { if (e.target === overlay) close(); });
  $('#wpClose').onclick = close;

  const f = { book: bookNames()[0], lesson: 1 };
  let existed = new Set();

  (async () => {
    try {
      const recs = await db.fetchRecitations(childId);
      if (recs.length) f.book = recs[0].book;
      existed = new Set(recs.filter(r => r.book === f.book).map(r => r.lesson_no));
      // 默认课号 = 下一个新课（新概念一取下一个单课）
      if (existed.size) f.lesson = nextNewLesson(f.book, Math.max(...existed));
    } catch (e) { console.warn('wordlist init', e.message); }
    $('#wpBook').innerHTML = segHtml(bookNames(), f.book, true);
    bindSeg($('#wpBook'), v => {
      f.book = v;
      existed = new Set(); // 换书后重新拉已学课
      (async () => {
        try {
          const recs = await db.fetchRecitations(childId);
          existed = new Set(recs.filter(r => r.book === f.book).map(r => r.lesson_no));
        } catch (e) {}
        f.lesson = existed.size ? nextNewLesson(f.book, Math.max(...existed)) : 1;
        $('#wpLesson').value = f.lesson;
        renderLearned(); loadList();
      })();
    });
    $('#wpLesson').value = f.lesson;
    renderLearned();
    loadList();
  })();

  // 最近学过的课，点一下快速填课号
  function renderLearned() {
    const ls = [...existed].sort((a, b) => b - a).slice(0, 12);
    $('#wpLearned').innerHTML = ls.length
      ? `<div class="rc-wordchips">${ls.map(l => `<span class="word-chip" data-l="${l}">L${l}</span>`).join('')}</div>` : '';
    $('#wpLearned').querySelectorAll('[data-l]').forEach(ch => ch.onclick = () => {
      f.lesson = +ch.dataset.l; $('#wpLesson').value = f.lesson; loadList();
    });
  }
  $('#wpLesson').onchange = () => { f.lesson = +$('#wpLesson').value || 0; if (f.lesson) loadList(); };

  async function loadList() {
    const ta = $('#wpPaste');
    if (!f.lesson) { ta.value = ''; updCount(); return; }
    ta.value = '加载中…'; ta.disabled = true;
    let words = [];
    try { const row = await db.fetchLessonWords(f.book, f.lesson); words = row ? (row.words || []) : []; } catch (e) {}
    ta.value = words.join('\n');
    ta.disabled = false;
    updCount();
  }
  function updCount() {
    const n = parseWordList($('#wpPaste').value).length;
    const to = `${f.book} L${+$('#wpLesson').value || '?'}`;
    $('#wpCount').textContent = n ? `将保存 ${n} 个词 → ${to}` : `留空保存 = 清空 ${to} 的词表`;
  }
  $('#wpPaste').oninput = updCount;

  $('#wpSave').onclick = async () => {
    const lessonNo = +$('#wpLesson').value || 0;
    if (!lessonNo) { toast('请填课号'); return; }
    const words = parseWordList($('#wpPaste').value);
    if (!words.length && !confirm(`清空 ${f.book} L${lessonNo} 的词表？`)) return;
    const btn = $('#wpSave');
    btn.disabled = true; btn.textContent = '保存中…';
    try {
      await db.saveLessonWords(f.book, lessonNo, words);
      toast('词表已保存 ✓ 孩子打卡时即可点选标错');
      close();
      onSaved && onSaved();
    } catch (e) { toast('保存失败：' + e.message); btn.disabled = false; btn.textContent = '保存词表'; }
  };
}

// ============================================================
// 今日打卡面板内的精简背诵区块（tasks.js 的 openCheckinPanel 调用）
// 用法：const recite = mountCheckinRecite(overlay, r); 打卡提交时 await recite.save();
// 默认收起（save() 不产生记录），点开登记才写入 —— 新课学习前几天无需理会
// ============================================================
export function mountCheckinRecite(overlay, r) {
  const sheet = overlay.querySelector('.checkin-sheet');
  const submitBtn = overlay.querySelector('#ckSubmit');
  const box = document.createElement('div');
  box.innerHTML = `
    <div class="tp-row" id="crToggle" style="margin-top:10px;align-items:center;cursor:pointer;user-select:none">
      <div class="tp-label" style="flex:1">📖 背诵登记（选填）</div>
      <span class="btn-ghost btn-sm" id="crToggleBtn">背了？点开登记 ▾</span>
    </div>
    <div id="crBody" style="display:none">
      <div class="tp-row">
        <div class="seg" id="crKind"></div>
        <label class="tp-label">课号 <input type="number" id="crLesson" min="1" style="width:70px"></label>
      </div>
      <div class="seg-block" id="crQuality" style="margin-top:6px"></div>
      <div id="crWords"></div>
    </div>`;
  sheet.insertBefore(box, submitBtn);
  const $ = s => box.querySelector(s);

  // 默认收起：新课学习前几天打卡不用管这里，背了才点开
  // 类型按任务名猜：带「旧/复习」默认复习，否则新课
  const f = { book: bookNames()[0], kind: /旧|复习/.test(r.title || '') ? 'review' : 'new', quality: 'perfect', lesson: 0, wrong: new Set(), words: null };
  let existed = new Set(), cursor = null, maxLearned = 0, ready = false, expanded = false;
  $('#crToggle').onclick = () => {
    expanded = !expanded;
    $('#crBody').style.display = expanded ? '' : 'none';
    $('#crToggleBtn').textContent = expanded ? '收起 ▴' : '背了？点开登记 ▾';
  };

  function renderKind() {
    $('#crKind').innerHTML = segHtml([{ value: 'new', label: '新课' }, { value: 'review', label: '复习' }], f.kind);
    bindSeg($('#crKind'), v => { f.kind = v; resetLessonDefault(); });
  }
  function resetLessonDefault() {
    f.lesson = f.kind === 'new' ? nextNewLesson(f.book, maxLearned) : (cursor ? Math.max(1, cursor - pairStep(f.book)) : maxLearned);
    $('#crLesson').value = f.lesson;
    loadWords();
  }
  $('#crLesson').onchange = () => { f.lesson = +$('#crLesson').value || 0; loadWords(); };
  $('#crQuality').innerHTML = segHtml([
    { value: 'perfect', label: '一遍过' }, { value: 'hint', label: '有提示' },
    { value: 'fail', label: '没背下来' }, { value: '', label: '没背课文' }
  ], f.quality, true);
  bindSeg($('#crQuality'), v => { f.quality = v; });

  (async () => {
    try {
      const childId = r.child_id;
      const [recs, sts] = await Promise.all([db.fetchRecitations(childId), db.fetchReciteStates(childId)]);
      if (recs.length) f.book = recs[0].book;
      existed = new Set(recs.filter(x => x.book === f.book).map(x => x.lesson_no));
      maxLearned = existed.size ? Math.max(...existed) : 0;
      const st = sts.find(x => x.book === f.book);
      cursor = st ? st.cursor_lesson : null;
      renderKind();
      resetLessonDefault();
      ready = true;
    } catch (e) { console.warn('recite block init', e.message); renderKind(); ready = true; }
  })();

  async function loadWords() {
    const boxW = $('#crWords');
    if (!boxW || !f.lesson) { if (boxW) boxW.innerHTML = ''; f.words = null; return; }
    boxW.innerHTML = `<div class="loading">词表…</div>`;
    let row = null;
    try { row = await db.fetchLessonWords(f.book, f.lesson); } catch (e) {}
    f.words = row ? row.words : null;
    f.wrong = new Set();
    if (f.words && f.words.length) {
      boxW.innerHTML = `<div class="rc-wordchips">${f.words.map(w => {
        const k = wordKey(w);
        return `<span class="word-chip ${f.wrong.has(k) ? 'bad' : ''}" data-w="${escAttr(k)}">${escHtml(w)}</span>`;
      }).join('')}</div>
        <div class="tp-label" style="margin-top:2px">点单词标错，全对不用动</div>`;
      boxW.querySelectorAll('.word-chip').forEach(ch => ch.onclick = () => {
        const w = ch.dataset.w;
        if (f.wrong.has(w)) f.wrong.delete(w); else f.wrong.add(w);
        ch.classList.toggle('bad', f.wrong.has(w));
      });
    } else {
      boxW.innerHTML = `<input class="checkin-note" id="crWrongManual" type="text" placeholder="背错的单词（空格/逗号隔开，选填）" />`;
    }
  }

  return {
    async save() {
      if (!expanded) return; // 收起状态 = 今天不登记背诵
      const lessonNo = +$('#crLesson').value || 0;
      if (!ready || !lessonNo) return; // 没填课号 = 不登记
      const manual = box.querySelector('#crWrongManual');
      const wrongWords = f.words && f.words.length ? [...f.wrong] : (manual ? parseWordList(manual.value) : []);
      await db.addRecitation({
        child_id: r.child_id, book: f.book, lesson_no: lessonNo, kind: f.kind,
        text_quality: f.quality || null,
        wrong_words: wrongWords, words_total: f.words && f.words.length ? f.words.length : 0,
        audio_urls: [], note: null, recite_date: todayStr()
      });
      await updateCursorAfterSave(r.child_id, f.book, lessonNo, !existed.has(lessonNo));
    }
  };
}

// ---------- 小工具 ----------
function fmtSec(s) {
  return String(Math.floor(s / 60)).padStart(2, '0') + ':' + String(s % 60).padStart(2, '0');
}
function escHtml(s) {
  return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}
function escAttr(s) { return escHtml(s); }
