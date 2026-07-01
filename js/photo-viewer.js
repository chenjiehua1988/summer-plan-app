// ============================================================
// 照片全屏查看器：双指缩放 + 单指平移 + 左右切换
// 用法：import { viewFullPhoto } from './photo-viewer.js'
//      viewFullPhoto(photos, idx)
// ============================================================

export function viewFullPhoto(photos, idx = 0) {
  if (!photos || !photos.length) return;
  let i = idx;
  // 缩放/平移状态
  let scale = 1, x = 0, y = 0;
  let dragging = false, lastX = 0, lastY = 0;
  let pinchDist = 0, pinchScale = 1;

  const ov = document.createElement('div');
  ov.className = 'photo-fullscreen';
  ov.innerHTML = `
    <button class="pf-close">✕</button>
    <button class="pf-prev">‹</button>
    <div class="pf-stage"><img draggable="false"></div>
    <button class="pf-next">›</button>
    <div class="pf-count"></div>`;
  document.body.appendChild(ov);
  const img = ov.querySelector('img');
  const stage = ov.querySelector('.pf-stage');

  const apply = () => {
    img.style.transform = `translate(${x}px, ${y}px) scale(${scale})`;
  };
  const reset = () => { scale = 1; x = 0; y = 0; apply(); };
  const render = () => {
    img.src = photos[i];
    ov.querySelector('.pf-count').textContent = `${i + 1}/${photos.length}`;
    reset();
  };
  render();

  ov.querySelector('.pf-close').onclick = (e) => { e.stopPropagation(); ov.remove(); };
  ov.querySelector('.pf-prev').onclick = (e) => { e.stopPropagation(); i = (i - 1 + photos.length) % photos.length; render(); };
  ov.querySelector('.pf-next').onclick = (e) => { e.stopPropagation(); i = (i + 1) % photos.length; render(); };
  ov.onclick = (e) => { if (e.target === ov) ov.remove(); };

  // 双击放大/还原
  let lastTap = 0;
  img.onclick = (e) => {
    e.stopPropagation();
    const now = Date.now();
    if (now - lastTap < 300) { scale = scale > 1 ? 1 : 2.5; x = 0; y = 0; apply(); }
    lastTap = now;
  };

  // 触摸：单指拖动平移，双指缩放
  stage.addEventListener('touchstart', (e) => {
    if (e.touches.length === 1) {
      if (scale > 1) { dragging = true; lastX = e.touches[0].clientX; lastY = e.touches[0].clientY; }
    } else if (e.touches.length === 2) {
      pinchDist = dist(e.touches);
      pinchScale = scale;
    }
  }, { passive: true });
  stage.addEventListener('touchmove', (e) => {
    if (e.touches.length === 1 && dragging) {
      const dx = e.touches[0].clientX - lastX;
      const dy = e.touches[0].clientY - lastY;
      x += dx; y += dy; lastX = e.touches[0].clientX; lastY = e.touches[0].clientY;
      apply();
    } else if (e.touches.length === 2) {
      const d = dist(e.touches);
      scale = Math.max(1, Math.min(6, pinchScale * (d / pinchDist)));
      if (scale === 1) { x = 0; y = 0; }
      apply();
    }
  }, { passive: true });
  stage.addEventListener('touchend', (e) => {
    if (e.touches.length === 0) dragging = false;
    if (e.touches.length < 2) pinchDist = 0;
  });

  // 鼠标滚轮缩放（PC调试）
  stage.addEventListener('wheel', (e) => {
    e.preventDefault();
    const delta = e.deltaY > 0 ? -0.2 : 0.2;
    scale = Math.max(1, Math.min(6, scale + delta));
    if (scale === 1) { x = 0; y = 0; }
    apply();
  }, { passive: false });
}

function dist(touches) {
  const dx = touches[0].clientX - touches[1].clientX;
  const dy = touches[0].clientY - touches[1].clientY;
  return Math.hypot(dx, dy);
}
