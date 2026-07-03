// ============================================================
// 任务模板管理 + 每日打卡视图（按周期 + 标签）
// ============================================================
import { state, todayStr, toast, actorName, segHtml, bindSeg, hm, mdhm } from './supabase.js';
import * as db from './db.js';
import { viewFullPhoto } from './photo-viewer.js';

// 今日打卡视图：渲染当天 daily_records，按标签分组；支持假期标记与打卡拍照
export async function renderToday(view) {
  const childId = state.currentChildId;
  if (!childId) { view.innerHTML = `<div class="empty">请先在「设置」里添加孩子。</div>`; return; }
  if (!state.currentPlanId) {
    view.innerHTML = `<div class="empty">请先在顶栏选择或去「设置」创建一个学习周期。</div>`;
    return;
  }
  const date = todayStr();
  view.innerHTML = `<div class="loading">加载中…</div>`;
  let records = [];
  try { records = await db.ensureDailyRecords(childId, date, state.currentPlanId); }
  catch (e) { records = await db.getCachedRecords(childId, date); }

  // 是否假期
  let dayOff = null;
  try {
    const offs = await db.fetchDayOffs(state.currentPlanId, childId);
    dayOff = offs.find(o => o.date === date) || null;
  } catch (e) {}

  const doneCount = records.filter(r => r.status === 'done' || r.status === 'verified').length;
  const effectiveTotal = records.filter(r => r.status !== 'skipped').length;
  // 按标签分组（skipped 也显示但灰色；无标签归"其他"）
  const groups = {};
  records.forEach(r => {
    const tags = (r.tags && r.tags.length) ? r.tags : ['其他'];
    tags.forEach(tg => { (groups[tg] = groups[tg] || []).push(r); });
  });
  const groupKeys = Object.keys(groups);

  view.innerHTML = `
    <div class="page-head">
      <div>
        <div class="date-label">${date}</div>
        <div class="progress-label">已完成 ${doneCount}/${effectiveTotal}${dayOff ? ' · 假期' : ''}</div>
      </div>
      <button class="btn-ghost btn-sm" id="refreshToday">刷新</button>
    </div>
    <div class="dayoff-bar">
      ${dayOff
        ? `<span>🏖️ 今天是假期${dayOff.reason ? '（' + dayOff.reason + '）' : ''}</span>
           ${state.mode === 'parent' ? `<button class="btn-ghost btn-sm" id="unmarkDayOff">取消假期</button>` : ''}`
        : (state.mode === 'parent'
            ? `<button class="btn-ghost btn-sm" id="markDayOff">今天设为假期</button>
               <button class="btn-ghost btn-sm" id="presetDayOff">预设假期时段</button>`
            : `<span style="color:var(--muted)">今天正常学习</span>`)}
    </div>
    ${records.length === 0 ? `<div class="empty">今天还没有任务。去「设置」给当前周期/孩子添加任务清单。</div>` : ''}
    ${groupKeys.map(g => `
      <div class="task-group-head">${g}</div>
      <ul class="task-list">${groups[g].map(r => taskRow(r)).join('')}</ul>
    `).join('')}
  `;

  view.querySelector('#refreshToday').onclick = () => renderToday(view);
  bindDayOff(view, childId, date, dayOff);
  view.querySelectorAll('.task-item').forEach(el => {
    const id = el.dataset.id;
    const r = records.find(x => x.id === id);
    // 父母模式下圆圈不可点（打卡是孩子的操作）
    if (state.mode !== 'parent') {
      el.querySelector('.check')?.addEventListener('click', () => onToggle(id, el, records));
    }
    // 打卡/改/历史 按钮
    el.querySelectorAll('.task-act').forEach(b => {
      b.addEventListener('click', (e) => {
        e.stopPropagation();
        if (b.dataset.history) openHistoryPanel(r);
        else openCheckinPanel(id, r, records, el);
      });
    });
    // 父母改当天说明
    el.querySelector('.edit-instr')?.addEventListener('click', async (e) => {
      e.stopPropagation();
      const v = prompt('当天要求说明（如：今天背第3课）', r.instruction || '');
      if (v === null) return;
      try { await db.updateRecord(id, { instruction: v || null }); r.instruction = v || null; renderToday(document.getElementById('view')); toast('已更新'); }
      catch (e) { toast('更新失败：' + e.message); }
    });
    // 查看已有照片/录音
    el.querySelector('.task-photos')?.addEventListener('click', (e) => {
      e.stopPropagation();
      if (e.target.dataset.viewaudio) viewAudios(r.audios || []);
      else viewPhotos(r.photos || []);
    });
  });
}

// 历史打卡记录面板
async function openHistoryPanel(r) {
  const overlay = document.createElement('div');
  overlay.className = 'photo-overlay';
  overlay.innerHTML = `<div class="photo-bar"><span>${r.title} · 打卡历史</span><button class="btn-ghost btn-sm">关闭</button></div><div class="loading">加载中…</div>`;
  overlay.onclick = (e) => { if (e.target === overlay || e.target.tagName === 'BUTTON') overlay.remove(); };
  document.body.appendChild(overlay);
  let list = [];
  try { list = await db.fetchCheckins(r.id); } catch (e) {}
  if (!list.length) {
    // 回退显示 daily_records 快照
    overlay.querySelector('.loading').outerHTML = `<div class="empty">暂无历史打卡记录。</div>`;
    return;
  }
  const html = list.map(c => `
    <div class="checkin-item">
      <div class="checkin-head">
        <span class="checkin-time">${mdhm(c.created_at)} · ${c.created_by||''}</span>
      </div>
      ${c.note ? `<div class="checkin-note">${c.note}</div>` : ''}
      ${(c.photos||[]).length ? `<div class="checkin-media">${(c.photos||[]).map(u=>`<img src="${u}" data-full="${u}">`).join('')}</div>` : ''}
      ${(c.audios||[]).length ? `<div>${(c.audios||[]).map(u=>`<audio controls src="${u}" style="width:100%;margin:4px 0"></audio>`).join('')}</div>` : ''}
    </div>`).join('');
  overlay.querySelector('.loading').outerHTML = `<div class="checkin-list">${html}</div>`;
  overlay.querySelectorAll('.checkin-media img').forEach(img => img.onclick = () => viewPhotos([img.dataset.full]));
}

function bindDayOff(view, childId, date, dayOff) {
  const mark = view.querySelector('#markDayOff');
  const unmark = view.querySelector('#unmarkDayOff');
  const preset = view.querySelector('#presetDayOff');
  if (mark) mark.onclick = async () => {
    const reason = prompt('假期原因（可选，如 旅游/考试/外出）');
    try { await db.markDayOff(state.currentPlanId, childId, date, reason); toast('已设为假期'); renderToday(view); }
    catch (e) { toast('操作失败：' + e.message); }
  };
  if (unmark) unmark.onclick = async () => {
    if (!confirm('取消假期？当天任务恢复待打卡。')) return;
    try { await db.unmarkDayOff(state.currentPlanId, childId, date); toast('已取消假期'); renderToday(view); }
    catch (e) { toast('操作失败：' + e.message); }
  };
  if (preset) preset.onclick = () => openDayOffRangePanel(childId, view);
}

function taskRow(r) {
  const skipped = r.status === 'skipped';
  const done = r.status === 'done' || r.status === 'verified';
  const verified = r.status === 'verified';
  const rejected = r.status === 'rejected';
  const tag = skipped ? `<span class="badge badge-skip">免打卡</span>`
            : verified ? `<span class="badge badge-ok">已验收</span>`
            : rejected ? `<span class="badge badge-no">被打回</span>`
            : done ? `<span class="badge badge-mid">待验收</span>`
            : ``;
  const tagsHtml = (r.tags || []).map(tn => {
    const tg = state.tags.find(x => x.name === tn);
    const c = tg ? tg.color : '#aaa';
    return `<span class="tag-chip" style="background:${c}">${tn}</span>`;
  }).join('');
  const photos = r.photos || [];
  const photosHtml = photos.length
    ? `<span class="task-photos link" data-viewphoto="1">📷 ${photos.length}</span>` : '';
  const audios = r.audios || [];
  const audiosHtml = audios.length
    ? `<span class="task-photos link" data-viewaudio="1">🎙 ${audios.length}</span>` : '';
  const isParent = state.mode === 'parent';
  let actBtn;
  if (skipped) actBtn = '';
  else if (verified) actBtn = `<button class="task-act btn-ghost btn-sm" data-history="${r.id}">历史</button>`;
  else if (isParent) actBtn = done ? `<button class="task-act btn-ghost btn-sm" data-history="${r.id}">历史</button>` : '';
  else actBtn = `<button class="task-act btn-ghost btn-sm">${done ? '改' : '记'}</button>${done ? `<button class="task-act btn-ghost btn-sm" data-history="${r.id}" style="margin-right:0">历史</button>` : ''}`;
  return `
    <li class="task-item ${done ? 'is-done' : ''} ${skipped ? 'is-skip' : ''}" data-id="${r.id}">
      <button class="check ${done ? 'checked' : ''} ${skipped ? 'skip' : ''}" aria-label="完成">${done ? '✓' : skipped ? '—' : ''}</button>
      <div class="task-body">
        <div class="task-title">${r.title}</div>
        ${r.instruction ? `<div class="task-instruction">❗ ${r.instruction}${isParent ? ` <b class="edit-instr" data-instr="${r.id}">改</b>` : ''}</div>` : (isParent ? `<div class="task-instruction"><b class="edit-instr" data-instr="${r.id}">+加说明</b></div>` : '')}
        <div class="task-meta">
          <span class="subj subj-${r.subject}">${r.subject}</span>
          ${tagsHtml}
          ${tag}
        </div>
        <div class="task-meta">
          ${photosHtml}
          ${audiosHtml}
          ${r.completed_at ? `<span class="note">打卡 ${hm(r.completed_at)}</span>` : ''}
          ${r.verified_at ? `<span class="note">验收 ${hm(r.verified_at)}${r.verified_by?' · '+r.verified_by:''}</span>` : ''}
        </div>
        ${r.note ? `<div class="task-note">📝 ${r.note}</div>` : ''}
      </div>
      ${actBtn}
      <div class="task-pts">${skipped ? '' : '+' + r.points}</div>
    </li>`;
}

// 打卡面板：底部抽屉，备注+拍照+录音+完成（都是可选）
// 打开时带出上次的备注/照片/录音（daily_records 快照），可增删改
function openCheckinPanel(id, r, records, el) {
  // 状态：existingXxx=已上传的URL（上次带的）；photoFiles/audioBlobs=新加的
  const st = {
    existingPhotos: [...(r.photos || [])], existingAudios: [...(r.audios || [])],
    photoFiles: [], audioBlobs: [], recorder: null, recMime: 'webm', recording: false, recTimer: null, recSec: 0
  };

  const overlay = document.createElement('div');
  overlay.className = 'checkin-overlay';
  overlay.innerHTML = `
    <div class="checkin-sheet">
      <div class="checkin-head">
        <span class="checkin-title">${r.title}</span>
        <button class="btn-ghost btn-sm" id="ckClose">取消</button>
      </div>
      <textarea class="checkin-note" placeholder="说明（可选，支持多行）" rows="2">${(r.status === 'rejected' ? '' : (r.note || ''))}</textarea>
      <div class="checkin-actions">
        <button class="btn-ghost btn-sm" id="ckPhoto">📷 拍照</button>
        <button class="btn-ghost btn-sm" id="ckGallery">🖼 选相册</button>
        <button class="btn-ghost btn-sm" id="ckRec">🎙 录音</button>
        <button class="btn-ghost btn-sm" id="ckAudioFile">🎵 选音频文件</button>
      </div>
      <div class="checkin-rec" id="ckRecBox" style="display:none">
        <span id="ckRecTime">00:00</span>
        <button class="btn-primary btn-sm" id="ckRecToggle">开始</button>
        <span class="checkin-hint" id="ckRecHint"></span>
      </div>
      <div class="checkin-picked" id="ckPicked"></div>
      <button class="btn-primary checkin-submit" id="ckSubmit">完成打卡</button>
    </div>`;
  document.body.appendChild(overlay);
  const $ = sel => overlay.querySelector(sel);

  const close = () => { stopRecIf(); overlay.remove(); };
  overlay.addEventListener('click', e => { if (e.target === overlay) close(); });
  $('#ckClose').onclick = close;

  const renderPicked = () => {
    // 已有照片：缩略图（点看大图）+ 删除×
    const eph = st.existingPhotos.map((u, i) =>
      `<span class="pick-thumb"><img src="${u}" data-view="${i}"><b data-rm-ephoto="${i}">×</b></span>`).join('');
    // 已有录音：芯片 + 删除
    const eau = st.existingAudios.map((u, i) => `<span class="pick-chip">🎙${i+1}<b data-rm-eaudio="${i}">×</b></span>`).join('');
    // 新选照片：缩略图（本地预览）+ 删除
    const ph = st.photoFiles.map((f, i) => {
      const url = URL.createObjectURL(f);
      return `<span class="pick-thumb"><img src="${url}"><b data-rm-photo="${i}">×</b></span>`;
    }).join('');
    // 新录音
    const au = st.audioBlobs.map((a, i) => `<span class="pick-chip">🎙${a.sec}秒<b data-rm-audio="${i}">×</b></span>`).join('');
    $('#ckPicked').innerHTML = eph + eau + ph + au;
    // 已有照片点看大图
    overlay.querySelectorAll('[data-view]').forEach(img => img.onclick = (e) => {
      e.stopPropagation();
      viewFullPhoto(st.existingPhotos, +img.dataset.view);
    });
    overlay.querySelectorAll('[data-rm-ephoto]').forEach(b => b.onclick = () => { st.existingPhotos.splice(+b.dataset.rmEphoto,1); renderPicked(); });
    overlay.querySelectorAll('[data-rm-eaudio]').forEach(b => b.onclick = () => { st.existingAudios.splice(+b.dataset.rmEaudio,1); renderPicked(); });
    overlay.querySelectorAll('[data-rm-photo]').forEach(b => b.onclick = () => { st.photoFiles.splice(+b.dataset.rmPhoto,1); renderPicked(); });
    overlay.querySelectorAll('[data-rm-audio]').forEach(b => b.onclick = () => { st.audioBlobs.splice(+b.dataset.rmAudio,1); renderPicked(); });
  };
  renderPicked(); // 初始显示已有的

  // 拍照（调相机）
  $('#ckPhoto').onclick = () => {
    const input = document.createElement('input');
    input.type = 'file'; input.accept = 'image/*'; input.multiple = true; input.capture = 'environment';
    input.onchange = () => { st.photoFiles.push(...input.files); renderPicked(); };
    input.click();
  };
  // 选相册（不调相机，可多选）
  $('#ckGallery').onclick = () => {
    const input = document.createElement('input');
    input.type = 'file'; input.accept = 'image/*'; input.multiple = true;
    input.onchange = () => { st.photoFiles.push(...input.files); renderPicked(); };
    input.click();
  };
  // 选音频文件
  $('#ckAudioFile').onclick = () => {
    const input = document.createElement('input');
    input.type = 'file'; input.accept = 'audio/*';
    input.onchange = async () => {
      for (const f of input.files) {
        const sec = await audioDuration(f);
        st.audioBlobs.push({ blob: f, ext: (f.name.split('.').pop() || 'mp4').toLowerCase(), sec });
      }
      renderPicked();
    };
    input.click();
  };

  // 录音
  const recBox = $('#ckRecBox');
  const recToggle = $('#ckRecToggle');
  const recTime = $('#ckRecTime');
  const recHint = $('#ckRecHint');
  $('#ckRec').onclick = async () => {
    recBox.style.display = '';
    if (!st.recorder && !st.recording) {
      try {
        const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
        st.recMime = MediaRecorder.isTypeSupported('audio/webm') ? 'webm'
          : MediaRecorder.isTypeSupported('audio/mp4') ? 'mp4' : '';
        const mr = new MediaRecorder(stream, st.recMime ? { mimeType: 'audio/' + st.recMime } : undefined);
        const chunks = [];
        mr.ondataavailable = e => { if (e.data.size) chunks.push(e.data); };
        mr.onstop = () => {
          const blob = new Blob(chunks, { type: 'audio/' + st.recMime });
          st.audioBlobs.push({ blob, ext: st.recMime, sec: st.recSec });
          renderPicked();
          stream.getTracks().forEach(t => t.stop());
        };
        st.recorder = mr;
        recHint.textContent = '';
      } catch (e) { recHint.textContent = '无法访问麦克风，请用「选音频文件」'; return; }
    }
  };
  recToggle.onclick = () => {
    if (!st.recorder) return;
    if (!st.recording) {
      st.recorder.start();
      st.recording = true; st.recSec = 0;
      recToggle.textContent = '停止';
      st.recTimer = setInterval(() => { st.recSec++; recTime.textContent = fmtSec(st.recSec); }, 1000);
    } else {
      stopRecIf();
    }
  };
  function stopRecIf() {
    if (st.recording && st.recorder && st.recorder.state !== 'inactive') st.recorder.stop();
    st.recording = false;
    if (st.recTimer) { clearInterval(st.recTimer); st.recTimer = null; }
    if (recToggle) recToggle.textContent = '开始';
  }

  // 完成
  $('#ckSubmit').onclick = async () => {
    const note = overlay.querySelector('.checkin-note').value.trim();
    stopRecIf();
    const btn = $('#ckSubmit');
    btn.disabled = true; btn.textContent = '提交中…';
    try {
      // 上传新照片/录音
      let newPhotos = [], newAudios = [];
      if (st.photoFiles.length) {
        toast(`上传 ${st.photoFiles.length} 张照片…`);
        for (const f of st.photoFiles) newPhotos.push(await db.uploadPhoto(id, f));
      }
      if (st.audioBlobs.length) {
        toast(`上传 ${st.audioBlobs.length} 段录音…`);
        for (const a of st.audioBlobs) newAudios.push(await db.uploadAudio(id, a.blob, a.ext));
      }
      // 合并：已有的（没删的）+ 新传的
      const allPhotos = [...st.existingPhotos, ...newPhotos];
      const allAudios = [...st.existingAudios, ...newAudios];
      // 写一条 checkins 流水（含本次保留的旧+新传）
      await db.addCheckin(r, { note, photos: allPhotos, audios: allAudios });
      // 更新 daily_records 快照（用户没删的旧+新传）
      await db.updateRecord(id, { note: note || null, photos: allPhotos, audios: allAudios });
      // 更新 daily_records 状态为 done（若已 verified 则不改状态，但仍记录本次打卡）
      if (r.status !== 'verified') {
        const patch = { status: 'done', completed_at: new Date().toISOString(), completed_by: actorName() };
        await db.updateRecord(id, patch);
        Object.assign(r, patch);
      }
      r.note = note || null; r.photos = allPhotos; r.audios = allAudios;
      toast('已打卡 ✓');
      overlay.remove();
      renderToday(document.getElementById('view'));
    } catch (e) { toast('保存失败：' + e.message); btn.disabled = false; btn.textContent = '完成打卡'; }
  };
}

// 预设假期时段面板（底部抽屉，选开始~结束日期+原因）
function openDayOffRangePanel(childId, view) {
  const plan = state.plans.find(p => p.id === state.currentPlanId);
  const today = todayStr();
  const start = plan?.start_date || today;
  const end = plan?.end_date || today;
  const overlay = document.createElement('div');
  overlay.className = 'checkin-overlay';
  overlay.innerHTML = `
    <div class="checkin-sheet">
      <div class="checkin-head">
        <span class="checkin-title">预设假期时段</span>
        <button class="btn-ghost btn-sm" id="drClose">取消</button>
      </div>
      <p class="checkin-hint" style="color:var(--muted);font-size:13px;margin:0 0 12px">选一段时间，范围内每天都设为假期（不生成打卡）。</p>
      <div class="dayoff-range-row">
        <label>开始 <input type="date" id="drStart" value="${today}" min="${start}" max="${end}"></label>
        <label>结束 <input type="date" id="drEnd" value="${today}" min="${start}" max="${end}"></label>
      </div>
      <input class="checkin-note" id="drReason" type="text" placeholder="原因（可选，如 旅游/考试）" />
      <button class="btn-primary checkin-submit" id="drSubmit">设为假期</button>
    </div>`;
  document.body.appendChild(overlay);
  const close = () => overlay.remove();
  overlay.addEventListener('click', e => { if (e.target === overlay) close(); });
  overlay.querySelector('#drClose').onclick = close;
  overlay.querySelector('#drSubmit').onclick = async () => {
    const s = overlay.querySelector('#drStart').value;
    const e = overlay.querySelector('#drEnd').value;
    const reason = overlay.querySelector('#drReason').value.trim();
    if (!s || !e) { toast('请选开始和结束日期'); return; }
    if (s > e) { toast('开始日期不能晚于结束日期'); return; }
    try {
      const n = await db.markDayOffRange(state.currentPlanId, childId, s, e, reason);
      toast(`${s} ~ ${e} 共 ${n} 天已设为假期`);
      overlay.remove();
      renderToday(view);
    } catch (err) { toast('操作失败：' + err.message); }
  };
}

// 音频时长（秒）
function audioDuration(file) {
  return new Promise(res => {
    const url = URL.createObjectURL(file);
    const a = new Audio();
    a.onloadedmetadata = () => { URL.revokeObjectURL(url); res(Math.round(a.duration) || 0); };
    a.onerror = () => { URL.revokeObjectURL(url); res(0); };
    a.src = url;
  });
}
function fmtSec(s) { const m = String(Math.floor(s/60)).padStart(2,'0'); const ss = String(s%60).padStart(2,'0'); return m+':'+ss; }

// 照片/录音预览
function viewPhotos(photos) {
  if (!photos.length) return;
  const overlay = document.createElement('div');
  overlay.className = 'photo-overlay';
  overlay.innerHTML = `
    <div class="photo-bar"><span>照片 ${photos.length} 张（点图放大）</span><button class="btn-ghost btn-sm">关闭</button></div>
    <div class="photo-grid">${photos.map((u,i) => `<img src="${u}" data-i="${i}">`).join('')}</div>`;
  overlay.onclick = (e) => { if (e.target === overlay || e.target.tagName === 'BUTTON') overlay.remove(); };
  overlay.querySelectorAll('img').forEach(img => {
    img.onclick = (e) => { e.stopPropagation(); viewFullPhoto(photos, +img.dataset.i); };
  });
  document.body.appendChild(overlay);
}
function viewAudios(audios) {
  if (!audios.length) return;
  const overlay = document.createElement('div');
  overlay.className = 'photo-overlay';
  overlay.innerHTML = `
    <div class="photo-bar"><span>录音 ${audios.length} 段</span><button class="btn-ghost btn-sm">关闭</button></div>
    <div class="audio-list">${audios.map(u => `<audio controls src="${u}" style="width:100%;margin-bottom:8px"></audio>`).join('')}</div>`;
  overlay.onclick = (e) => { if (e.target === overlay || e.target.tagName === 'BUTTON') overlay.remove(); };
  document.body.appendChild(overlay);
}

async function onToggle(id, el, records) {
  const r = records.find(x => x.id === id);
  if (!r) return;
  if (r.status === 'verified') { toast('已验收，不能取消'); return; }
  if (r.status === 'skipped') { toast('假期免打卡'); return; }
  const willDone = !(r.status === 'done');
  if (willDone) {
    // 勾选完成时打开打卡面板（备注+照片）
    openCheckinPanel(id, r, records, el);
    return;
  }
  const patch = { status: 'pending', completed_at: null, completed_by: null, note: null };
  try {
    await db.updateRecord(id, patch);
    Object.assign(r, patch);
    renderToday(document.getElementById('view'));
  } catch (e) { toast('操作失败：' + e.message); }
}

// ---------- 任务清单管理（设置页内嵌，绑「当前周期+孩子」+ 标签） ----------
export async function renderTemplates(container, childId) {
  if (!state.currentPlanId) {
    container.innerHTML = `<div class="empty">请先选择或创建一个学习周期。</div>`;
    return;
  }
  container.innerHTML = `<div class="loading">加载中…</div>`;
  const templates = await db.fetchTemplates(state.currentPlanId, childId);
  const tags = state.tags;

  container.innerHTML = `
    <button class="btn-primary btn-sm" id="tAdd" style="margin-bottom:10px">+ 添加任务</button>
    ${templates.length ? templates.map(t => tmplRow(t, tags)).join('') : `<div class="empty">还没有任务，添加第一个吧。</div>`}
  `;

  container.querySelector('#tAdd').onclick = () => openTemplatePanel(null, tags, container, childId);
  container.querySelectorAll('[data-del]').forEach(b => {
    b.onclick = async () => {
      if (!confirm('删除该任务？')) return;
      try { await db.deleteTemplate(b.dataset.del); toast('已删除'); renderTemplates(container, childId); }
      catch (e) { toast('删除失败：' + e.message); }
    };
  });
  container.querySelectorAll('[data-edit]').forEach(b => {
    b.onclick = () => {
      const t = templates.find(x => x.id === b.dataset.edit);
      openTemplatePanel(t, tags, container, childId);
    };
  });
}

// 任务编辑/添加面板（底部抽屉）
function openTemplatePanel(t, tags, container, childId) {
  const isEdit = !!t;
  const cur = t || { title:'', subject:'语文', default_minutes:30, points:1, active:true, tagIds:[], weekdays:[], start_date:'', end_date:'' };
  const plan = state.plans.find(p => p.id === state.currentPlanId);
  const overlay = document.createElement('div');
  overlay.className = 'checkin-overlay';
  overlay.innerHTML = `
    <div class="checkin-sheet">
      <div class="checkin-head">
        <span class="checkin-title">${isEdit ? '编辑任务' : '添加任务'}</span>
        <button class="btn-ghost btn-sm" id="tpClose">取消</button>
      </div>
      <input class="checkin-note" id="tpTitle" type="text" placeholder="任务名（如：口算100题）" value="${cur.title}" />
      <div class="tp-label">科目</div>
      <div class="seg-block" id="tpSubject"></div>
      <div class="tp-row">
        <label class="tp-label">用时(分) <input id="tpMin" type="number" value="${cur.default_minutes}" style="width:70px"></label>
        <label class="tp-label">积分 <input id="tpPts" type="number" value="${cur.points}" style="width:60px"></label>
      </div>
      <div class="tp-label">标签</div>
      <div class="seg" id="tpTags"></div>
      <div class="tp-label">要求说明（默认，每天可单独改）</div>
      <textarea class="checkin-note" id="tpInstruction" placeholder="如：每天背一课古诗，先读3遍再背" rows="2">${cur.instruction||''}</textarea>
      <div class="tp-label">生效日期（留空=整周期）</div>
      <div class="dayoff-range-row">
        <label>开始 <input type="date" id="tpStart" value="${cur.start_date||''}" min="${plan?.start_date||''}" max="${plan?.end_date||''}"></label>
        <label>结束 <input type="date" id="tpEnd" value="${cur.end_date||''}" min="${plan?.start_date||''}" max="${plan?.end_date||''}"></label>
      </div>
      <div class="tp-label">每周哪几天（不选=每天）</div>
      <div class="seg-block" id="tpWeekdays"></div>
      <div class="tp-row">
        <label class="tp-label"><input type="checkbox" id="tpActive" ${cur.active!==false?'checked':''}> 启用</label>
      </div>
      <button class="btn-primary checkin-submit" id="tpSave">保存</button>
      ${isEdit ? `<button class="btn-ghost checkin-submit" id="tpDel" style="margin-top:8px;color:var(--no)">删除任务</button>` : ''}
    </div>`;
  document.body.appendChild(overlay);
  const $ = s => overlay.querySelector(s);
  const close = () => overlay.remove();
  overlay.addEventListener('click', e => { if (e.target === overlay) close(); });
  $('#tpClose').onclick = close;

  // 科目单选
  const subjEl = $('#tpSubject');
  subjEl.innerHTML = segHtml(['语文','数学','英语','生活'], cur.subject, true);
  let subj = cur.subject;
  subjEl.querySelectorAll('.seg-btn').forEach(b => b.onclick = () => {
    subjEl.querySelectorAll('.seg-btn').forEach(x=>x.classList.remove('on'));
    b.classList.add('on'); subj = b.dataset.seg;
  });
  // 标签多选
  const tagEl = $('#tpTags');
  const selTags = new Set(cur.tagIds || []);
  tagEl.innerHTML = tags.map(tg => `<button type="button" class="seg-btn ${selTags.has(tg.id)?'on':''}" data-tid="${tg.id}">${tg.name}</button>`).join('');
  tagEl.querySelectorAll('.seg-btn').forEach(b => b.onclick = () => {
    b.classList.toggle('on');
    if (b.classList.contains('on')) selTags.add(b.dataset.tid); else selTags.delete(b.dataset.tid);
  });
  // 周几多选
  const wdEl = $('#tpWeekdays');
  const WD = [['日',0],['一',1],['二',2],['三',3],['四',4],['五',5],['六',6]];
  const selWd = new Set(cur.weekdays || []);
  wdEl.innerHTML = WD.map(([n,v]) => `<button type="button" class="seg-btn ${selWd.has(v)?'on':''}" data-wd="${v}">${n}</button>`).join('');
  wdEl.querySelectorAll('.seg-btn').forEach(b => b.onclick = () => {
    b.classList.toggle('on');
    const v = +b.dataset.wd;
    if (b.classList.contains('on')) selWd.add(v); else selWd.delete(v);
  });

  $('#tpSave').onclick = async () => {
    const title = $('#tpTitle').value.trim();
    if (!title) { toast('请输入任务名'); return; }
    const patch = {
      title, subject: subj,
      default_minutes: +$('#tpMin').value || 30,
      points: +$('#tpPts').value || 1,
      start_date: $('#tpStart').value || null,
      end_date: $('#tpEnd').value || null,
      weekdays: [...selWd],
      instruction: $('#tpInstruction').value.trim() || null,
      active: $('#tpActive').checked,
      tagIds: [...selTags]
    };
    try {
      if (isEdit) {
        await db.updateTemplate(t.id, patch, patch.tagIds);
      } else {
        await db.addTemplate({ ...patch, plan_id: state.currentPlanId, child_id: childId });
      }
      toast('已保存');
      overlay.remove();
      renderTemplates(container, childId);
    } catch (e) { toast('保存失败：' + e.message); }
  };
  if (isEdit) $('#tpDel').onclick = async () => {
    if (!confirm('删除该任务？')) return;
    try { await db.deleteTemplate(t.id); toast('已删除'); overlay.remove(); renderTemplates(container, childId); }
    catch (e) { toast('删除失败：' + e.message); }
  };
}

function tmplRow(t, tags) {
  const tagHtml = (t.tagIds || []).map(id => {
    const tg = tags.find(x => x.id === id);
    return tg ? `<span class="tag-chip" style="background:${tg.color}">${tg.name}</span>` : '';
  }).join('');
  const activeTag = t.active === false ? '<span class="badge badge-skip">已停用</span>' : '';
  // 生效时段标记
  const sched = [];
  const wd = t.weekdays || [];
  if (wd.length) {
    const names = ['日','一','二','三','四','五','六'];
    // 连续段简化显示
    sched.push('周' + [...wd].sort().map(d=>names[d]).join(''));
  }
  if (t.start_date || t.end_date) {
    sched.push(`${t.start_date?(t.start_date.slice(5))+'起':''}${t.end_date?('至'+(t.end_date.slice(5))):''}`);
  }
  const schedHtml = sched.length ? `<span class="note" style="color:var(--primary)">📅 ${sched.join(' · ')}</span>` : '';
  return `
    <div class="tmpl-card">
      <div class="tmpl-card-title">${t.title} ${activeTag}</div>
      <div class="tmpl-card-tags">${tagHtml}<span class="subj subj-${t.subject}">${t.subject}</span></div>
      ${schedHtml ? `<div class="tmpl-card-sched">${schedHtml}</div>` : ''}
      <div class="tmpl-card-foot">
        <span class="tmpl-card-info">${t.default_minutes}分 · ${t.points}积分</span>
        <div class="tmpl-card-btns">
          <button class="btn-ghost btn-sm" data-edit="${t.id}">改</button>
          <button class="btn-ghost btn-sm" data-del="${t.id}">删</button>
        </div>
      </div>
    </div>`;
}
