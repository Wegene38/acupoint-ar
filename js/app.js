/**
 * 寻穴 AcuPoint AR —— 主应用
 * 相机实时预览 + MediaPipe 端侧关键点检测 + 穴位叠加渲染 + 交互 + 拍照
 * 所有画面仅在本地处理，不经任何网络上传。
 */
import {
  POINTS, REGIONS, MERIDIANS, surfaceOK, toArr,
  faceCtx, handCtx, bodyCtx, dist,
} from './data.js?v=1.2';
import {
  FilesetResolver, FaceLandmarker, HandLandmarker, PoseLandmarker,
} from '../vendor/mediapipe/vision_bundle.mjs';

/* ---------------- DOM ---------------- */
const $ = (s) => document.querySelector(s);
const video = $('#video');
const canvas = $('#overlay');
const ctx = canvas.getContext('2d');
const stage = $('#stage');
const statusEl = $('#status');
const hintEl = $('#hint');
const toastEl = $('#toast');
const cardEl = $('#card');
const listEl = $('#list');
const searchEl = $('#search');
const gateEl = $('#startGate');
const gateErrEl = $('#gateError');
const panelEl = $('#panel');
const settingsEl = $('#settings');

/* ---------------- 状态 ---------------- */
const state = {
  running: false,
  mode: 'hand',                 // face | hand | body
  mirror: true,
  showNames: 'key',             // all | key | none
  handSurface: 'auto',          // auto | palm | dorsal | all
  showSkeleton: false,          // 调试：显示 AI 关键点
  selectedId: null,
  detected: false,              // 当前帧是否识别到部位
  models: {},                   // face/hand/body -> landmarker
  modelPromise: {},             // 并发加载守卫
  lastTs: { face: 0, hand: 0, body: 0 },
  det: { face: null, hands: [], body: null }, // 平滑后的关键点
  lastPts: [],                  // 最近一帧的屏幕坐标点（用于点选）
};
let raf = 0;
let frameCount = 0;

/* ---------------- 模型加载 ---------------- */
async function ensureModel(mode) {
  if (state.models[mode]) return state.models[mode];
  if (state.modelPromise[mode]) return state.modelPromise[mode];
  state.modelPromise[mode] = (async () => {
    setStatus(`加载AI模型…`, 'load');
    const fileset = await FilesetResolver.forVisionTasks('vendor/mediapipe/wasm');
    const base = { modelAssetPath: `models/${MODEL_FILES[mode]}`, delegate: 'GPU' };
    let landmarker;
    try {
      landmarker = await createLandmarker(mode, fileset, base);
    } catch {
      landmarker = await createLandmarker(mode, fileset, { ...base, delegate: 'CPU' });
    }
    state.models[mode] = landmarker;
    setStatus('就绪', '');
    return landmarker;
  })().catch((e) => {
    console.error('模型加载失败', e);
    setStatus('模型加载失败', 'err');
    showToast('模型加载失败，请检查网络后重试');
    delete state.modelPromise[mode];
    throw e;
  });
  return state.modelPromise[mode];
}
const MODEL_FILES = {
  face: 'face_landmarker.task',
  hand: 'hand_landmarker.task',
  body: 'pose_landmarker_lite.task',
};
function createLandmarker(mode, fileset, base) {
  const opts = {
    face: { baseOptions: base, runningMode: 'VIDEO', numFaces: 1 },
    hand: { baseOptions: base, runningMode: 'VIDEO', numHands: 2 },
    body: { baseOptions: base, runningMode: 'VIDEO', numPoses: 1, minPoseDetectionConfidence: 0.5 },
  }[mode];
  const Ctor = { face: FaceLandmarker, hand: HandLandmarker, body: PoseLandmarker }[mode];
  return Ctor.createFromOptions(fileset, opts);
}

/* ---------------- 相机 ---------------- */
async function startCamera() {
  try {
    const stream = await navigator.mediaDevices.getUserMedia({
      video: { facingMode: 'user', width: { ideal: 1280 }, height: { ideal: 720 } },
      audio: false,
    });
    video.srcObject = stream;
    await video.play();
    state.running = true;
    gateEl.classList.add('hidden');
    await ensureModel(state.mode);
    if (!raf) loop();
  } catch (e) {
    console.error(e);
    gateErrEl.textContent = e?.name === 'NotAllowedError'
      ? '相机权限被拒绝：请在浏览器地址栏的权限设置中允许相机后刷新。'
      : '无法启动相机：请确认使用 https:// 或 localhost 打开本页，且相机未被其他程序占用。';
    gateErrEl.classList.remove('hidden');
  }
}

/* ---------------- 检测与平滑 ---------------- */
const EMA = 0.55; // 新帧权重
function smoothLm(prev, cur, a = EMA) {
  if (!prev) return cur.map((p) => ({ ...p }));
  return cur.map((p, i) => {
    const o = prev[i] ?? p;
    return { x: o.x + (p.x - o.x) * a, y: o.y + (p.y - o.y) * a, visibility: p.visibility ?? o.visibility ?? 1 };
  });
}
const centroid = (lms) => lms.reduce((s, p) => ({ x: s.x + p.x / lms.length, y: s.y + p.y / lms.length }), { x: 0, y: 0 });

function detect(now) {
  const model = state.models[state.mode];
  if (!model) return;
  const ts = Math.max(now, state.lastTs[state.mode] + 1);
  state.lastTs[state.mode] = ts;

  if (state.mode === 'face') {
    const res = model.detectForVideo(video, ts);
    const raw = res.faceLandmarks?.[0];
    state.det.face = raw ? smoothLm(state.det.face, raw) : null;
  } else if (state.mode === 'hand') {
    const res = model.detectForVideo(video, ts);
    const rawHands = (res.landmarks ?? []).map((lms, i) => {
      const hd = (res.handednesses ?? res.handedness ?? [])[i]?.[0]?.categoryName ?? 'Right';
      return { lms, label: hd };
    });
    // 按质心就近匹配上一帧，避免双手交换时抖动
    const prev = state.det.hands.slice();
    const matched = rawHands.map((h) => {
      const c = centroid(h.lms);
      let best = -1, bestD = Infinity;
      prev.forEach((p, i) => { const d = dist(centroid(p.lms), c); if (d < bestD) { bestD = d; best = i; } });
      const p = best >= 0 ? prev[best] : null;
      return { label: h.label, lms: smoothLm(p?.lms, h.lms) };
    });
    state.det.hands = matched;
  } else {
    const res = model.detectForVideo(video, ts);
    const raw = res.landmarks?.[0];
    state.det.body = raw ? smoothLm(state.det.body, raw) : null;
  }
}

/* ---------------- 坐标变换（cover + 镜像） ---------------- */
function coverRect() {
  const vw = video.videoWidth || 1, vh = video.videoHeight || 1;
  const cw = stage.clientWidth, ch = stage.clientHeight;
  const s = Math.max(cw / vw, ch / vh);
  const dw = vw * s, dh = vh * s;
  return { ox: (cw - dw) / 2, oy: (ch - dh) / 2, dw, dh };
}
function tx(x, y) {
  const { ox, oy, dw, dh } = coverRect();
  return { x: ox + (state.mirror ? 1 - x : x) * dw, y: oy + y * dh };
}

/* ---------------- 计算当前帧穴位屏幕坐标 ---------------- */
function computePoints() {
  const out = [];
  if (state.mode === 'hand') {
    for (const h of state.det.hands) {
      const c = handCtx(h.lms, h.label);
      for (const pt of POINTS) {
        const m = pt.map?.hand;
        if (!m || !surfaceOK(pt, c, state.handSurface)) continue;
        for (const p of toArr(m(c))) {
          const s = tx(p.x, p.y);
          out.push({ pt, sx: s.x, sy: s.y, dim: state.handSurface === 'auto' && c.conf < 0.12 && pt.surface !== 'both' });
        }
      }
    }
  } else {
    const lms = state.mode === 'face' ? state.det.face : state.det.body;
    if (!lms) return out;
    const c = state.mode === 'face' ? faceCtx(lms) : bodyCtx(lms);
    for (const pt of POINTS) {
      const m = pt.map?.[state.mode];
      if (!m) continue;
      for (const p of toArr(m(c))) {
        const s = tx(p.x, p.y);
        out.push({ pt, sx: s.x, sy: s.y });
      }
    }
  }
  return out;
}

/* ---------------- 渲染 ---------------- */
function loop() {
  raf = requestAnimationFrame(loop);
  if (video.readyState < 2) return;
  try { detect(performance.now()); } catch { /* 个别帧异常可忽略 */ }
  render();
}

function render() {
  frameCount++;
  const pts = computePoints();
  state.lastPts = pts;
  state.detected = state.mode === 'hand' ? state.det.hands.length > 0 : !!((state.mode === 'face' ? state.det.face : state.det.body));

  ctx.clearRect(0, 0, canvas.width, canvas.height);
  if (state.showSkeleton) drawSkeleton();
  drawPoints(pts);
  if (frameCount % 20 === 0) updateStatusAndHint();
}

/** 调试：绘制 AI 检测到的原始关键点（用于核对叠加是否与画面同步） */
function drawSkeleton() {
  ctx.save();
  ctx.fillStyle = 'rgba(255,255,255,.65)';
  const dot = (p) => { const s = tx(p.x, p.y); ctx.beginPath(); ctx.arc(s.x, s.y, 1.8, 0, Math.PI * 2); ctx.fill(); };
  if (state.mode === 'face' && state.det.face) {
    for (let i = 0; i < state.det.face.length; i += 2) dot(state.det.face[i]);
  } else if (state.mode === 'hand') {
    state.det.hands.forEach((h) => h.lms.forEach(dot));
  } else if (state.mode === 'body' && state.det.body) {
    state.det.body.forEach((p) => { if ((p.visibility ?? 1) > 0.5) dot(p); });
  }
  ctx.restore();
}

function drawPoints(pts) {
  const t = performance.now();
  const selected = pts.filter((p) => p.pt.id === state.selectedId);

  for (const p of pts) {
    const m = MERIDIANS[p.pt.meridian] ?? MERIDIANS.EX;
    const sel = p.pt.id === state.selectedId;
    const r = sel ? 7.5 : p.pt.key ? 5.5 : 4.5;
    ctx.save();
    if (p.dim) ctx.globalAlpha = 0.45;
    if (p.pt.style === 'back') { // 背面穴位：虚线空心
      ctx.setLineDash([3, 3]);
      ctx.strokeStyle = m.color;
      ctx.lineWidth = 1.6;
      ctx.beginPath(); ctx.arc(p.sx, p.sy, r, 0, Math.PI * 2); ctx.stroke();
    } else {
      ctx.shadowColor = m.color; ctx.shadowBlur = sel ? 14 : 7;
      ctx.fillStyle = m.color;
      ctx.beginPath(); ctx.arc(p.sx, p.sy, r, 0, Math.PI * 2); ctx.fill();
      ctx.shadowBlur = 0;
      ctx.strokeStyle = 'rgba(255,255,255,.92)'; ctx.lineWidth = 1.4;
      ctx.beginPath(); ctx.arc(p.sx, p.sy, r, 0, Math.PI * 2); ctx.stroke();
    }
    ctx.restore();
  }

  // 选中脉冲光环
  for (const p of selected) {
    const m = MERIDIANS[p.pt.meridian] ?? MERIDIANS.EX;
    const rr = 11 + Math.sin(t / 220) * 3;
    ctx.save();
    ctx.strokeStyle = m.color; ctx.lineWidth = 2;
    ctx.beginPath(); ctx.arc(p.sx, p.sy, rr, 0, Math.PI * 2); ctx.stroke();
    ctx.globalAlpha = 0.35;
    ctx.beginPath(); ctx.arc(p.sx, p.sy, rr + 7, 0, Math.PI * 2); ctx.stroke();
    ctx.restore();
  }

  // 名称标签（后画，保证在最上层）
  const FONT = '600 12px -apple-system,"PingFang SC","Microsoft YaHei",sans-serif';
  ctx.font = FONT;
  ctx.textAlign = 'center'; ctx.textBaseline = 'bottom';
  for (const p of pts) {
    const show = state.showNames === 'all'
      || (state.showNames === 'key' && (p.pt.key || p.pt.id === state.selectedId))
      || p.pt.id === state.selectedId;
    if (!show) continue;
    const label = p.pt.name + (p.pt.style === 'back' ? '·背' : '');
    ctx.save();
    if (p.dim) ctx.globalAlpha = 0.5;
    ctx.lineWidth = 3; ctx.strokeStyle = 'rgba(8,14,12,.85)'; ctx.lineJoin = 'round';
    ctx.strokeText(label, p.sx, p.sy - 9);
    ctx.fillStyle = p.pt.id === state.selectedId ? (MERIDIANS[p.pt.meridian]?.color ?? '#fff') : '#f2f7f5';
    ctx.fillText(label, p.sx, p.sy - 9);
    ctx.restore();
  }
}

/* ---------------- 状态与引导提示 ---------------- */
function setStatus(text, cls) {
  statusEl.textContent = text;
  statusEl.className = 'status ' + cls;
}
function updateStatusAndHint() {
  const r = REGIONS[state.mode];
  let hint = '';
  if (!state.running) return;
  if (!state.detected) {
    setStatus(`${r.name} · 未检测到`, 'warn');
    hint = r.hint;
  } else {
    setStatus(`${r.name} · 已识别 ✓`, 'ok');
    if (state.mode === 'face') {
      const L = state.det.face;
      if (L && dist(L[33], L[263]) < 0.16) hint = '请再靠近一点，穴位会更准';
    } else if (state.mode === 'hand') {
      const n = state.det.hands.length;
      if (n > 0 && dist(state.det.hands[0].lms[0], state.det.hands[0].lms[9]) < 0.16) hint = '手再靠近镜头一点，显示更清晰';
    } else {
      const L = state.det.body;
      if (L && (L[27].visibility ?? 0) < 0.5) hint = '已识别上半身；后退一步可显示腿足穴位';
    }
  }
  hintEl.textContent = hint;
  hintEl.classList.toggle('hidden', !hint);
}

/* ---------------- 交互：点选穴位 ---------------- */
canvas.addEventListener('pointerdown', (e) => {
  if (!state.lastPts.length) return;
  const rect = canvas.getBoundingClientRect();
  const px = e.clientX - rect.left, py = e.clientY - rect.top;
  let best = null, bestD = 48;
  for (const p of state.lastPts) {
    const d = Math.hypot(p.sx - px, p.sy - py);
    if (d < bestD) { bestD = d; best = p.pt; }
  }
  if (best) {
    state.selectedId = best.id;
    showCard(best);
    renderList();
  } else {
    state.selectedId = null;
    cardEl.classList.add('hidden');
    renderList();
  }
});

function showCard(pt) {
  const m = MERIDIANS[pt.meridian] ?? MERIDIANS.EX;
  const mappedHere = !!pt.map?.[state.mode];
  const notes = [];
  if (!mappedHere && state.detected) notes.push('此穴在当前模式无实时标注，请按文字定位说明取穴。');
  if (pt.style === 'back') notes.push('背面穴位：虚线圈为参考投影位置，请翻转身体/对照文字取穴。');
  cardEl.innerHTML = `
    <button class="card-close" aria-label="关闭">✕</button>
    <div class="card-head">
      <span class="dot" style="background:${m.color}"></span>
      <h3>${pt.name}</h3>
      <span class="py">${pt.pinyin}</span>
      <span class="tag">${pt.code}</span>
      <span class="tag tag-m" style="border-color:${m.color}">${m.name}</span>
      ${pt.style === 'back' ? '<span class="tag">背面</span>' : ''}
    </div>
    <p class="loc"><b>定位</b>${pt.location}</p>
    <p><b>功效</b>${pt.effects}</p>
    ${pt.tips ? `<p class="tips"><b>按摩</b>${pt.tips}</p>` : ''}
    ${notes.map((n) => `<p class="note">💡 ${n}</p>`).join('')}
    <p class="fine">穴位定位为骨度分寸比例估算，仅供学习参考，以按压产生酸胀感为准；不构成医疗建议。</p>`;
  cardEl.classList.remove('hidden');
  cardEl.querySelector('.card-close').onclick = () => {
    cardEl.classList.add('hidden');
    state.selectedId = null;
    renderList();
  };
}

/* ---------------- 穴位库列表 ---------------- */
function renderList() {
  const q = searchEl.value.trim().toLowerCase();
  const pts = q
    ? POINTS.filter((p) => `${p.name}${p.code}${p.pinyin}${p.effects}${p.location}${(MERIDIANS[p.meridian] ?? MERIDIANS.EX).name}`.toLowerCase().includes(q))
    : POINTS.filter((p) => p.regions.includes(state.mode));
  const order = ['face', 'hand', 'body'];
  const groups = [];
  for (const r of order) {
    const uniq = new Map();
    for (const p of pts) if (p.regions[0] === r) uniq.set(p.id, p);
    if (uniq.size) groups.push([r, [...uniq.values()]]);
  }
  listEl.innerHTML = groups.map(([r, arr]) => `
    <div class="group-title">${REGIONS[r].icon} ${REGIONS[r].name} <i>${arr.length} 穴</i></div>
    ${arr.map((p) => {
      const m = MERIDIANS[p.meridian] ?? MERIDIANS.EX;
      return `<button class="item ${p.id === state.selectedId ? 'active' : ''}" data-id="${p.id}">
        <span class="dot" style="background:${m.color}"></span>
        <span class="nm">${p.name}</span>
        <span class="cd">${p.code}</span>
        <span class="me">${m.name}</span>
        ${p.key ? '<span class="star">★</span>' : ''}
      </button>`;
    }).join('')}`).join('') || `<div class="empty">未找到相关穴位，试试"失眠""头痛""肩颈"等功效词</div>`;

  listEl.querySelectorAll('.item').forEach((el) => {
    el.onclick = () => {
      const pt = POINTS.find((p) => p.id === el.dataset.id);
      if (!pt) return;
      if (!pt.regions.includes(state.mode) && pt.map) setMode(pt.regions[0]);
      state.selectedId = pt.id;
      showCard(pt);
      renderList();
      if (window.innerWidth < 900) panelEl.classList.remove('open'); // 手机上收起面板，先看画面
    };
  });
}
searchEl.addEventListener('input', () => renderList());

/* ---------------- 模式切换 ---------------- */
const modeBtns = document.querySelectorAll('#modes button');
function setMode(mode) {
  if (state.mode === mode) return;
  state.mode = mode;
  state.selectedId = null;
  state.det = { face: null, hands: [], body: null };
  cardEl.classList.add('hidden');
  modeBtns.forEach((b) => b.classList.toggle('active', b.dataset.mode === mode));
  document.body.classList.toggle('mode-hand', mode === 'hand');
  renderList();
  updateStatusAndHint();
  if (state.running) ensureModel(mode).catch(() => {});
}
modeBtns.forEach((b) => { b.onclick = () => setMode(b.dataset.mode); });

/* ---------------- 筛选条 ---------------- */
document.querySelectorAll('[data-names]').forEach((b) => {
  b.classList.toggle('active', b.dataset.names === state.showNames);
  b.onclick = () => {
    state.showNames = b.dataset.names;
    document.querySelectorAll('[data-names]').forEach((x) => x.classList.toggle('active', x === b));
  };
});
document.querySelectorAll('[data-surface]').forEach((b) => {
  b.classList.toggle('active', b.dataset.surface === state.handSurface);
  b.onclick = () => {
    state.handSurface = b.dataset.surface;
    document.querySelectorAll('[data-surface]').forEach((x) => x.classList.toggle('active', x === b));
  };
});

/* ---------------- 设置 ---------------- */
$('#btnSettings').onclick = () => settingsEl.classList.remove('hidden');
$('#settingsClose').onclick = () => settingsEl.classList.add('hidden');
$('#mirrorToggle').checked = state.mirror;
$('#mirrorToggle').onchange = (e) => {
  state.mirror = e.target.checked;
  document.body.classList.toggle('mirror', state.mirror);
};
$('#skeletonToggle').checked = state.showSkeleton;
$('#skeletonToggle').onchange = (e) => { state.showSkeleton = e.target.checked; };

/* ---------------- 拍照 ---------------- */
$('#shutter').onclick = () => {
  if (!state.running) return;
  const dpr = canvas.width / stage.clientWidth;
  const out = document.createElement('canvas');
  out.width = canvas.width; out.height = canvas.height;
  const g = out.getContext('2d');
  const { ox, oy, dw, dh } = coverRect();
  g.save();
  g.translate(out.width, 0); g.scale(-1, 1); // 与预览一致的水平镜像
  g.drawImage(video, ox * dpr, oy * dpr, dw * dpr, dh * dpr);
  g.restore();
  g.drawImage(canvas, 0, 0);
  g.font = `${13 * dpr}px -apple-system,"PingFang SC",sans-serif`;
  g.textBaseline = 'bottom';
  g.lineWidth = 3; g.strokeStyle = 'rgba(8,14,12,.8)';
  const wm = '寻穴 AcuPoint AR · 穴位仅供学习参考';
  g.strokeText(wm, 12 * dpr, out.height - 12 * dpr);
  g.fillStyle = 'rgba(242,247,245,.95)';
  g.fillText(wm, 12 * dpr, out.height - 12 * dpr);

  const a = document.createElement('a');
  a.download = `寻穴_${new Date().toISOString().slice(0, 19).replace(/[T:]/g, '-')}.png`;
  a.href = out.toDataURL('image/png');
  a.click();
  const flash = $('#flash');
  flash.classList.remove('hidden');
  setTimeout(() => flash.classList.add('hidden'), 180);
  showToast('已保存截图 ✓');
};

/* ---------------- 面板/杂项 ---------------- */
$('#panelToggle').onclick = () => panelEl.classList.toggle('open');
$('#btnStart').onclick = startCamera;

let toastTimer = 0;
function showToast(msg) {
  toastEl.textContent = msg;
  toastEl.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => toastEl.classList.remove('show'), 2200);
}

function resize() {
  const dpr = Math.min(window.devicePixelRatio || 1, 2.5);
  canvas.width = Math.round(stage.clientWidth * dpr);
  canvas.height = Math.round(stage.clientHeight * dpr);
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
}
window.addEventListener('resize', resize);

document.addEventListener('visibilitychange', () => {
  if (!document.hidden) state.lastTs = { face: 0, hand: 0, body: 0 };
});

/* ---------------- PWA：安装到桌面 + 离线 ---------------- */
const deferred = { prompt: null };
const installBtns = [$('#gateInstall'), $('#settingsInstall')].filter(Boolean);
const iosTipEl = $('#iosTip');
const ua = navigator.userAgent;
const isIOS = /iphone|ipad|ipod/i.test(ua) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
const isStandalone = matchMedia('(display-mode: standalone)').matches || navigator.standalone === true;

function refreshInstallUI() {
  const showBtn = !!deferred.prompt && !isStandalone;
  installBtns.forEach((b) => b.classList.toggle('hidden', !showBtn));
  if (iosTipEl) iosTipEl.classList.toggle('hidden', !(isIOS && !isStandalone));
}
window.addEventListener('beforeinstallprompt', (e) => {
  e.preventDefault();
  deferred.prompt = e;
  refreshInstallUI();
});
window.addEventListener('appinstalled', () => {
  deferred.prompt = null;
  refreshInstallUI();
  showToast('已添加到桌面 🎉');
});
installBtns.forEach((b) => {
  b.onclick = async () => {
    if (!deferred.prompt) return;
    deferred.prompt.prompt();
    await deferred.prompt.userChoice;
    deferred.prompt = null;
    refreshInstallUI();
  };
});
if (isStandalone) showToast('正在以 App 模式运行 ✓');

// 注册 Service Worker（离线缓存 App 壳与 AI 模型）；新版本接管后自动刷新一次
if ('serviceWorker' in navigator) {
  navigator.serviceWorker.addEventListener('controllerchange', () => {
    if (!sessionStorage.getItem('sw-reloaded')) {
      sessionStorage.setItem('sw-reloaded', '1');
      location.reload();
    }
  });
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('./sw.js').catch((e) => console.warn('SW 注册失败', e));
  });
}
refreshInstallUI();

/* ---------------- 启动 ---------------- */
function init() {
  resize();
  document.body.classList.toggle('mode-hand', state.mode === 'hand');
  document.body.classList.toggle('mirror', state.mirror);
  modeBtns.forEach((b) => b.classList.toggle('active', b.dataset.mode === state.mode));
  renderList();
  updateStatusAndHint();
  if (navigator.mediaDevices?.getUserMedia) {
    gateErrEl.classList.add('hidden');
  } else {
    gateErrEl.textContent = '当前浏览器不支持摄像头（需 HTTPS 或 localhost 环境）。';
    gateErrEl.classList.remove('hidden');
  }
}
init();
