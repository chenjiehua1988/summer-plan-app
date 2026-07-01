// ============================================================
// 父母验收视图：展示孩子已完成的任务，验收通过 / 打回
// ============================================================
import { state, todayStr, toast, hm } from './supabase.js';
import * as db from './db.js';

export async function renderVerify(view) {
  const childId = state.currentChildId;
  if (!childId) { view.innerHTML = `<div class="empty">请先添加孩子。</div>`; return; }
  if (!state.currentPlanId) { view.innerHTML = `<div class="empty">请先选择一个学习周期。</div>`; return; }
  const date = todayStr();
  view.innerHTML = `<div class="loading">加载中…</div>`;
  let records = [];
  try { records = await db.ensureDailyRecords(childId, date, state.currentPlanId); }
  catch (e) { records = await db.getCachedRecords(childId, date); }

  const pending = records.filter(r => r.status === 'done');
  const verified = records.filter(r => r.status === 'verified');
  const rejected = records.filter(r => r.status === 'rejected');

  view.innerHTML = `
    <div class="page-head">
      <div><div class="date-label">${date} 验收</div>
      <div class="progress-label">待验收 ${pending.length} · 已验收 ${verified.length}</div></div>
      <button class="btn-ghost btn-sm" id="refreshVerify">刷新</button>
    </div>
    ${pending.length ? `<div class="section-title">待验收</div>
      <ul class="task-list">${pending.map(verifyRow).join('')}</ul>` : `<div class="empty">没有待验收的任务。</div>`}
    ${verified.length ? `<div class="section-title">今日已验收</div>
      <ul class="task-list">${verified.map(doneRow).join('')}</ul>` : ''}
    ${rejected.length ? `<div class="section-title">今日被打回</div>
      <ul class="task-list">${rejected.map(doneRow).join('')}</ul>` : ''}
  `;

  view.querySelector('#refreshVerify').onclick = () => renderVerify(view);
  view.querySelectorAll('[data-act]').forEach(b => {
    b.onclick = async () => {
      const id = b.dataset.id;
      const act = b.dataset.act;
      const noteEl = view.querySelector(`.vnote[data-for="${id}"]`);
      const note = noteEl ? noteEl.value.trim() : '';
      try {
        await db.verifyRecord(id, act === 'pass' ? 'verified' : 'rejected', note);
        toast(act === 'pass' ? '已验收并加分 ✓' : '已打回');
        renderVerify(view);
        if (window.refreshPointBadge) window.refreshPointBadge();
      } catch (e) { toast('操作失败：' + e.message); }
    };
  });
  // 补拍照片
  view.querySelectorAll('[data-addphoto]').forEach(b => {
    b.onclick = () => {
      const id = b.dataset.addphoto;
      const input = document.createElement('input');
      input.type = 'file'; input.accept = 'image/*'; input.multiple = true; input.capture = 'environment';
      input.onchange = async () => {
        const files = [...input.files];
        if (!files.length) return;
        try {
          toast(`上传 ${files.length} 张…`);
          const urls = [];
          for (const f of files) urls.push(await db.uploadPhoto(id, f));
          await db.appendPhotos(id, urls);
          toast('已添加照片');
          renderVerify(view);
        } catch (e) { toast('上传失败：' + e.message); }
      };
      input.click();
    };
  });
  // 查看照片
  view.querySelectorAll('[data-viewphoto]').forEach(b => {
    b.onclick = () => {
      const id = b.dataset.viewphoto;
      const r = records.find(x => x.id === id);
      viewPhotos(r?.photos || []);
    };
  });
  view.querySelectorAll('[data-viewaudio]').forEach(b => {
    b.onclick = () => {
      const id = b.dataset.viewaudio;
      const r = records.find(x => x.id === id);
      viewAudios(r?.audios || []);
    };
  });
}

function verifyRow(r) {
  const photos = r.photos || [];
  const audios = r.audios || [];
  return `
    <li class="task-item" data-id="${r.id}">
      <div class="task-body" style="flex:1">
        <div class="task-title">${r.title}</div>
        <div class="task-meta">
          <span class="subj subj-${r.subject}">${r.subject}</span>
          <span class="note">+${r.points} 分</span>
          ${photos.length ? `<span class="task-photos link" data-viewphoto="${r.id}">📷 ${photos.length}</span>` : ''}
          ${audios.length ? `<span class="task-photos link" data-viewaudio="${r.id}">🎙 ${audios.length}</span>` : ''}
          ${r.note ? `<span class="note">📝 ${r.note}</span>` : ''}
          ${r.completed_at ? `<span class="note">打卡 ${hm(r.completed_at)}</span>` : ''}
        </div>
        <input class="vnote" data-for="${r.id}" type="text" placeholder="备注（可选）" />
        <button class="btn-ghost btn-sm" data-addphoto="${r.id}" style="margin-top:6px">📷 补拍照片</button>
      </div>
      <div class="verify-btns">
        <button class="btn-primary btn-sm" data-act="pass" data-id="${r.id}">通过</button>
        <button class="btn-ghost btn-sm" data-act="reject" data-id="${r.id}">打回</button>
      </div>
    </li>`;
}
function doneRow(r) {
  const cls = r.status === 'verified' ? 'badge-ok' : 'badge-no';
  const txt = r.status === 'verified' ? '已验收' : '已打回';
  const photos = r.photos || [];
  const audios = r.audios || [];
  return `
    <li class="task-item is-done">
      <div class="task-body" style="flex:1">
        <div class="task-title">${r.title}</div>
        <div class="task-meta">
          <span class="subj subj-${r.subject}">${r.subject}</span>
          <span class="badge ${cls}">${txt}</span>
          ${photos.length ? `<span class="task-photos link" data-viewphoto="${r.id}">📷 ${photos.length}</span>` : ''}
          ${audios.length ? `<span class="task-photos link" data-viewaudio="${r.id}">🎙 ${audios.length}</span>` : ''}
          ${r.note ? `<span class="note">📝 ${r.note}</span>` : ''}
          ${r.completed_at ? `<span class="note">打卡 ${hm(r.completed_at)}</span>` : ''}
          ${r.verified_at ? `<span class="note">验收 ${hm(r.verified_at)}${r.verified_by?' · '+r.verified_by:''}</span>` : ''}
        </div>
      </div>
    </li>`;
}

// 照片预览
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
