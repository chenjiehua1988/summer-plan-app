// ============================================================
// 任务模板管理 + 每日打卡视图（按周期 + 标签）
// ============================================================
import { state, todayStr, toast, actorName, segHtml, bindSeg, hm } from './supabase.js';
import * as db from './db.js';

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
               <button class="btn-ghost btn-sm" id="presetDayOff">预设其他日期假期</button>`
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
    el.querySelector('.check')?.addEventListener('click', () => onToggle(id, el, records));
    // 打卡拍照/备注：点任务体（已完成的）展开
    el.querySelector('.task-act')?.addEventListener('click', (e) => {
      e.stopPropagation();
      openCheckinPanel(id, r, records, el);
    });
    // 查看已有照片/录音
    el.querySelector('.task-photos')?.addEventListener('click', (e) => {
      e.stopPropagation();
      if (e.target.dataset.viewaudio) viewAudios(r.audios || []);
      else viewPhotos(r.photos || []);
    });
  });
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
  if (preset) preset.onclick = async () => {
    const d = prompt('要预设哪天为假期？（YYYY-MM-DD）');
    if (!d) return;
    const reason = prompt('假期原因（可选）') || '';
    try { await db.markDayOff(state.currentPlanId, childId, d, reason); toast(`${d} 已设为假期`); }
    catch (e) { toast('操作失败：' + e.message); }
  };
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
    ? `<span class="task-photos link">📷 ${photos.length}</span>` : '';
  const audios = r.audios || [];
  const audiosHtml = audios.length
    ? `<span class="task-photos link" data-viewaudio="1">🎙 ${audios.length}</span>` : '';
  const actBtn = (!skipped && !verified)
    ? `<button class="task-act btn-ghost btn-sm">${done ? '改' : '记'}</button>` : '';
  return `
    <li class="task-item ${done ? 'is-done' : ''} ${skipped ? 'is-skip' : ''}" data-id="${r.id}">
      <button class="check ${done ? 'checked' : ''} ${skipped ? 'skip' : ''}" aria-label="完成">${done ? '✓' : skipped ? '—' : ''}</button>
      <div class="task-body">
        <div class="task-title">${r.title}</div>
        <div class="task-meta">
          <span class="subj subj-${r.subject}">${r.subject}</span>
          ${tagsHtml}
          ${tag}
          ${photosHtml}
          ${audiosHtml}
          ${r.note ? `<span class="note">📝 ${r.note}</span>` : ''}
          ${r.completed_at ? `<span class="note">打卡 ${hm(r.completed_at)}</span>` : ''}
          ${r.verified_at ? `<span class="note">验收 ${hm(r.verified_at)}</span>` : ''}
        </div>
      </div>
      ${actBtn}
      <div class="task-pts">${skipped ? '' : '+' + r.points}</div>
    </li>`;
}

// 打卡面板：底部抽屉，备注+拍照+录音+完成（都是可选）
function openCheckinPanel(id, r, records, el) {
  // 状态：待上传的照片文件、录音 blob
  const st = { photoFiles: [], audioBlobs: [], recorder: null, recMime: 'webm', recording: false, recTimer: null, recSec: 0 };

  const overlay = document.createElement('div');
  overlay.className = 'checkin-overlay';
  overlay.innerHTML = `
    <div class="checkin-sheet">
      <div class="checkin-head">
        <span class="checkin-title">${r.title}</span>
        <button class="btn-ghost btn-sm" id="ckClose">取消</button>
      </div>
      <input class="checkin-note" type="text" placeholder="说明（可选）" value="${r.note || ''}" />
      <div class="checkin-actions">
        <button class="btn-ghost btn-sm" id="ckPhoto">📷 拍照/选图</button>
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
    const ph = st.photoFiles.map((f, i) => `<span class="pick-chip">📷${i+1}<b data-rm-photo="${i}">×</b></span>`).join('');
    const au = st.audioBlobs.map((a, i) => `<span class="pick-chip">🎙${a.sec}秒<b data-rm-audio="${i}">×</b></span>`).join('');
    $('#ckPicked').innerHTML = ph + au;
    overlay.querySelectorAll('[data-rm-photo]').forEach(b => b.onclick = () => { st.photoFiles.splice(+b.dataset.rmPhoto,1); renderPicked(); });
    overlay.querySelectorAll('[data-rm-audio]').forEach(b => b.onclick = () => { st.audioBlobs.splice(+b.dataset.rmAudio,1); renderPicked(); });
  };

  // 拍照/选图
  $('#ckPhoto').onclick = () => {
    const input = document.createElement('input');
    input.type = 'file'; input.accept = 'image/*'; input.multiple = true; input.capture = 'environment';
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
      const patch = { status: 'done', note: note || null,
        completed_at: new Date().toISOString(), completed_by: actorName() };
      await db.updateRecord(id, patch);
      Object.assign(r, patch);
      if (st.photoFiles.length) {
        toast(`上传 ${st.photoFiles.length} 张照片…`);
        const urls = [];
        for (const f of st.photoFiles) urls.push(await db.uploadPhoto(id, f));
        const up = await db.appendPhotos(id, urls);
        r.photos = up.photos;
      }
      if (st.audioBlobs.length) {
        toast(`上传 ${st.audioBlobs.length} 段录音…`);
        const urls = [];
        for (const a of st.audioBlobs) urls.push(await db.uploadAudio(id, a.blob, a.ext));
        const up = await db.appendAudios(id, urls);
        r.audios = up.audios;
      }
      toast('已打卡 ✓');
      overlay.remove();
      renderToday(document.getElementById('view'));
    } catch (e) { toast('保存失败：' + e.message); btn.disabled = false; btn.textContent = '完成打卡'; }
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
    <div class="photo-bar"><span>照片 ${photos.length} 张</span><button class="btn-ghost btn-sm">关闭</button></div>
    <div class="photo-grid">${photos.map(u => `<img src="${u}" />`).join('')}</div>`;
  overlay.onclick = (e) => { if (e.target === overlay || e.target.tagName === 'BUTTON') overlay.remove(); };
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
    <div class="tmpl-add">
      <input id="tTitle" type="text" placeholder="任务名（如：口算100题）" class="grow" />
      <input id="tMin" type="number" placeholder="分钟" value="30" style="width:60px" />
      <input id="tPts" type="number" placeholder="积分" value="1" style="width:54px" />
      <button class="btn-primary btn-sm" id="tAdd">添加</button>
    </div>
    <div class="seg-block" id="tSubjectSeg"></div>
    <input type="hidden" id="tSubject" value="语文" />
    ${tags.length ? `<div class="tag-pick" id="tagPick">
      ${tags.map(t => `<label data-tid="${t.id}"><input type="checkbox" value="${t.id}">${t.name}</label>`).join('')}
    </div>` : ''}
    ${templates.length ? templates.map(t => tmplRow(t, tags)).join('') : `<div class="empty">还没有任务，添加第一个吧。</div>`}
  `;

  // 标签选中样式
  container.querySelectorAll('#tagPick label').forEach(lb => {
    const cb = lb.querySelector('input');
    const sync = () => {
      lb.classList.toggle('on', cb.checked);
      const tg = tags.find(x => x.id === cb.value);
      if (cb.checked && tg) lb.style.background = tg.color;
      else lb.style.background = '';
    };
    cb.onchange = sync; sync();
  });

  // 科目选择卡
  const subjSeg = container.querySelector('#tSubjectSeg');
  subjSeg.innerHTML = segHtml(['语文','数学','英语','生活'], '语文', true);
  bindSeg(subjSeg, v => { container.querySelector('#tSubject').value = v; });

  container.querySelector('#tAdd').onclick = async () => {
    const title = container.querySelector('#tTitle').value.trim();
    if (!title) { toast('请输入任务名'); return; }
    const tagIds = [...container.querySelectorAll('#tagPick input:checked')].map(c => c.value);
    try {
      await db.addTemplate({
        plan_id: state.currentPlanId, child_id: childId,
        subject: container.querySelector('#tSubject').value,
        title, default_minutes: +container.querySelector('#tMin').value,
        points: +container.querySelector('#tPts').value, tagIds
      });
      toast('已添加');
      renderTemplates(container, childId);
    } catch (e) { toast('添加失败：' + e.message); }
  };
  container.querySelectorAll('[data-del]').forEach(b => {
    b.onclick = async () => {
      try { await db.deleteTemplate(b.dataset.del); toast('已删除'); renderTemplates(container, childId); }
      catch (e) { toast('删除失败：' + e.message); }
    };
  });
  container.querySelectorAll('[data-edit]').forEach(b => {
    b.onclick = () => openEditTemplate(b.dataset.edit, templates, tags, container, childId);
  });
}

// 编辑任务：用 prompt 逐项改，标签用简易多选
function openEditTemplate(id, templates, tags, container, childId) {
  const t = templates.find(x => x.id === id);
  if (!t) return;
  const title = prompt('任务名', t.title);
  if (title === null) return;
  const min = prompt('用时（分钟）', t.default_minutes);
  if (min === null) return;
  const pts = prompt('积分', t.points);
  if (pts === null) return;
  const subj = prompt('科目（语文/数学/英语/生活）', t.subject);
  if (subj === null) return;
  // 标签多选：列出标签，已选的带[√]
  const cur = t.tagIds || [];
  const tagStr = tags.map(tg => (cur.includes(tg.id) ? '[√]' : '[ ]') + tg.name).join('  ');
  const tagInput = prompt('选择标签（输入标签名，多个用逗号分隔；留空=不改变）\n' + tagStr, cur.map(id => (tags.find(x=>x.id===id)||{}).name).join(','));
  const active = confirm(t.active === false ? '当前已停用，点确定启用，取消保持停用' : '点确定保持启用，取消则停用');
  const patch = { title: title.trim() || t.title, default_minutes: +min || t.default_minutes,
    points: +pts || t.points, subject: ['语文','数学','英语','生活'].includes(subj) ? subj : t.subject,
    active: active ? true : (t.active === false ? false : true) };
  // 解析标签
  let newTagIds;
  if (tagInput !== null) {
    const names = tagInput.split(/[,，、\s]+/).map(s=>s.trim()).filter(Boolean);
    newTagIds = tags.filter(tg => names.includes(tg.name)).map(tg => tg.id);
  }
  db.updateTemplate(id, patch, tagInput === null ? undefined : newTagIds).then(() => {
    toast('已保存');
    renderTemplates(container, childId);
  }).catch(e => toast('保存失败：' + e.message));
}

function tmplRow(t, tags) {
  const tagHtml = (t.tagIds || []).map(id => {
    const tg = tags.find(x => x.id === id);
    return tg ? `<span class="tag-chip" style="background:${tg.color}">${tg.name}</span>` : '';
  }).join('');
  const activeTag = t.active === false ? '<span class="badge badge-skip">已停用</span>' : '';
  return `
    <div class="tmpl-row">
      <div class="tmpl-name">
        ${t.title} <small>${t.default_minutes}分·${t.points}分</small> ${activeTag}
        <div style="margin-top:3px">${tagHtml}<span class="subj subj-${t.subject}" style="margin-left:4px">${t.subject}</span></div>
      </div>
      <button class="btn-ghost btn-sm" data-edit="${t.id}">改</button>
      <button class="btn-ghost btn-sm" data-del="${t.id}">删除</button>
    </div>`;
}
