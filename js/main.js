// 应用入口：组装渲染器、图层、XR 会话、性能统计与全部降级/异常处理。

import { Renderer } from './renderer.js';
import { TextureLayer, ProjectionLayer, CylinderLayer } from './layers.js';
import { StatsMonitor } from './stats.js';
import { XRSessionManager } from './xr-session.js';
import { perspective, lookAt, multiply } from './math.js';

const $ = (id) => document.getElementById(id);
const canvas = $('gl');
const banner = $('banner');
const logBox = $('log');

let bannerTimer = 0;
function showBanner(text, level = 'warn', sticky = false) {
  banner.textContent = text;
  banner.className = `banner${level === 'error' ? ' error' : level === 'ok' ? ' ok' : ''}`;
  banner.hidden = false;
  clearTimeout(bannerTimer);
  if (!sticky) bannerTimer = setTimeout(() => { banner.hidden = true; }, 5000);
}

function log(level, msg) {
  const time = new Date().toLocaleTimeString('zh-CN', { hour12: false });
  const line = document.createElement('div');
  line.innerHTML = `<span class="t">${time}</span><span class="${level}">${msg}</span>`;
  logBox.prepend(line);
  while (logBox.children.length > 60) logBox.lastChild.remove();
  if (level === 'error' || level === 'warn') showBanner(msg, level);
}

// ---------- 初始化 ----------
const stats = new StatsMonitor();
const renderer = new Renderer(canvas, log);
if (!renderer.init()) {
  showBanner('WebGL 初始化失败，页面无法渲染', 'error', true);
  throw new Error('WebGL init failed');
}
log('ok', `渲染器就绪：${renderer.isGL2 ? 'WebGL2' : 'WebGL1'}，PerformanceObserver `
  + `${stats.supported ? '已启用' : '不可用（耗时统计使用 performance.now 兜底）'}`);

const layers = {
  texture: new TextureLayer(renderer),
  projection: new ProjectionLayer(renderer),
  cylinder: new CylinderLayer(renderer),
};

function buildLayers() {
  for (const layer of Object.values(layers)) {
    layer.dispose();
    layer.build();
  }
}
buildLayers();

const activeLayers = () => Object.values(layers).filter((l) => l.enabled);

// ---------- 降级策略 ----------
const degradeSteps = [
  () => {
    renderer.quality.texSize = Math.max(64, renderer.quality.texSize >> 1);
    buildLayers();
    return `纹理分辨率降低至 ${renderer.quality.texSize}px`;
  },
  () => {
    layers.cylinder.enabled = false;
    $('layer-cylinder').checked = false;
    return '关闭圆柱图层';
  },
  () => {
    layers.texture.enabled = false;
    $('layer-texture').checked = false;
    return '关闭纹理图层';
  },
  () => {
    setViewCount(1, true);
    return '降级到单视图渲染';
  },
];
let degradeLevel = 0;

function degrade(reason) {
  if (degradeLevel >= degradeSteps.length) {
    log('error', `${reason}：降级措施已用尽`);
    return;
  }
  const action = degradeSteps[degradeLevel++]();
  log('warn', `${reason}，已执行降级：${action}`);
}
renderer.onBudgetExceeded = () => degrade('显存不足');

// ---------- 视图模式 ----------
const viewButtons = [...$('view-buttons').querySelectorAll('button')];
function setViewCount(n, silent = false) {
  renderer.setViewCount(n);
  xr.requestedViews = n;
  viewButtons.forEach((b) => b.classList.toggle('active', Number(b.dataset.views) === n));
  if (!silent) log('info', `视图模式切换为 ${n} 视图（渲染路径：${renderer.renderPath}）`);
}
viewButtons.forEach((btn) => {
  btn.addEventListener('click', () => {
    const n = Number(btn.dataset.views);
    if (xr.active && n > 2) {
      log('warn', `XR 会话中请求 ${n} 视图：多数 XR 设备仅提供 2 视图，将按设备实际视图图渲染并提示`);
    }
    setViewCount(n);
  });
});

// ---------- 图层开关 ----------
for (const [key, id] of [['texture', 'layer-texture'], ['projection', 'layer-projection'], ['cylinder', 'layer-cylinder']]) {
  $(id).addEventListener('change', (e) => {
    layers[key].enabled = e.target.checked;
    log('info', `${layers[key].name}${e.target.checked ? '已开启' : '已关闭'}`);
  });
}

// ---------- XR 会话 ----------
const xr = new XRSessionManager(renderer, log);
xr.onFrame = (glLayer, xrViews) => {
  stats.beginFrame();
  renderer.renderXRViews(glLayer, xrViews, activeLayers());
  stats.endFrame();
};
xr.onStateChange = (state, data) => {
  const inXR = state === 'active' || state === 'view-mismatch';
  $('btn-enter-xr').disabled = inXR;
  $('btn-exit-xr').disabled = !inXR;
  $('btn-resume-xr').hidden = state !== 'interrupted';
  if (state === 'view-mismatch') {
    setViewCount(data, true);
    showBanner(`视图数量不匹配，已按 XR 设备能力降级为 ${data} 视图`, 'warn');
  }
  if (state === 'interrupted') {
    showBanner('XR 会话中断，点击「恢复会话」继续', 'error', true);
  }
  if (state === 'active') {
    banner.hidden = true;
    $('xr-status').textContent = 'XR 会话进行中';
  }
  if (state === 'ended') $('xr-status').textContent = 'XR 会话已结束';
};

xr.detect().then((caps) => {
  $('xr-status').textContent = !caps.webxr
    ? 'WebXR 不可用（Canvas 预览模式）'
    : caps.immersiveVr
      ? `可进入 XR（Layers：${caps.layers ? '支持' : '不支持，走降级'}）`
      : '不支持 immersive-vr（Canvas 预览模式）';
  $('btn-enter-xr').disabled = !caps.immersiveVr;
});

$('btn-enter-xr').addEventListener('click', () => xr.enter());
$('btn-exit-xr').addEventListener('click', () => xr.exit());
$('btn-resume-xr').addEventListener('click', async () => {
  const ok = await xr.resume();
  if (ok) log('ok', 'XR 会话恢复成功');
});

// ---------- 故障模拟 ----------
$('btn-sim-oom').addEventListener('click', () => {
  renderer.memBudget = renderer.textureBytes + renderer.bufferBytes; // 预算压到当前用量
  log('warn', `模拟显存不足：预算调整为 ${(renderer.memBudget / 1048576).toFixed(1)} MB`);
  degrade('显存不足');
});
$('btn-sim-ctxlost').addEventListener('click', () => {
  const ext = renderer.gl.getExtension('WEBGL_lose_context');
  if (ext) {
    log('warn', '模拟 WebGL 上下文丢失…');
    ext.loseContext();
  } else {
    log('error', 'WEBGL_lose_context 扩展不可用，无法模拟');
  }
});
$('btn-sim-interrupt').addEventListener('click', () => xr.simulateInterrupt());

// ---------- 上下文丢失 / 恢复（真实显存不足的主要表现） ----------
canvas.addEventListener('webglcontextlost', (e) => {
  e.preventDefault();
  log('error', 'WebGL 上下文丢失（可能由显存不足导致），等待恢复…');
  showBanner('渲染上下文丢失，正在尝试恢复…', 'error', true);
});
canvas.addEventListener('webglcontextrestored', () => {
  log('ok', 'WebGL 上下文已恢复，以降低画质重建资源');
  degradeLevel = Math.max(degradeLevel, 1);
  renderer.quality.texSize = Math.max(64, renderer.quality.texSize >> 1);
  renderer.init();
  buildLayers();
  showBanner('上下文已恢复（已降级画质）', 'ok');
});

// ---------- 页面可见性（会话中断场景） ----------
document.addEventListener('visibilitychange', () => {
  if (document.hidden) {
    log('warn', '页面不可见，渲染循环暂停');
  } else {
    log('ok', '页面恢复可见，渲染继续');
  }
});

// ---------- 预览渲染循环（非 XR 模式） ----------
const EYE_OFFSETS = {
  1: [[0, 0]],
  2: [[-0.16, 0], [0.16, 0]],
  4: [[-0.16, 0.1], [0.16, 0.1], [-0.16, -0.1], [0.16, -0.1]],
};

function previewFrame(time) {
  requestAnimationFrame(previewFrame);
  if (document.hidden || xr.active) return;
  renderer.resize();
  const t = time * 0.0002;
  const baseEye = [Math.sin(t) * 6, 1.2, Math.cos(t) * 6];
  const vps = renderer.getViewports();
  const n = renderer.viewCount;
  const viewProjs = new Float32Array(16 * n);
  for (let i = 0; i < n; i++) {
    const [ox, oy] = EYE_OFFSETS[n][i];
    const eye = [baseEye[0] + ox, baseEye[1] + oy, baseEye[2]];
    const view = lookAt(eye, [0, 0, 0], [0, 1, 0]);
    const proj = perspective(Math.PI / 3, vps[i].w / vps[i].h, 0.1, 120);
    viewProjs.set(multiply(proj, view), i * 16);
  }
  stats.beginFrame();
  renderer.renderFrame(viewProjs, activeLayers());
  stats.endFrame();
}
requestAnimationFrame(previewFrame);

// ---------- HUD 刷新 ----------
function fmtMB(bytes) {
  return `${(bytes / 1048576).toFixed(1)} MB`;
}
setInterval(() => {
  stats.setMemory(renderer.textureBytes, renderer.bufferBytes, renderer.memBudget);
  const s = stats.snapshot();
  $('stat-frame').textContent = `${s.lastMs.toFixed(2)} ms`;
  $('stat-avg').textContent = `${s.avgMs.toFixed(2)} / ${s.p95Ms.toFixed(2)} ms`;
  $('stat-fps').textContent = `${s.fps.toFixed(0)} fps`;
  $('stat-mem').textContent = fmtMB(s.textureBytes + s.bufferBytes);
  $('stat-budget').textContent = fmtMB(s.budgetBytes);
  $('stat-heap').textContent = s.heapBytes ? fmtMB(s.heapBytes) : 'N/A';
  $('stat-path').textContent = renderer.renderPath;
  $('stat-views').textContent = String(renderer.viewCount);
}, 250);

log('info', '应用已启动：单眼预览模式，可切换视图/图层或进入 XR');
