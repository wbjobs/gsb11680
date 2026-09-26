import { Renderer } from './renderer.js';
import { FrameStats, fmtMs, fmtFps } from './stats.js';
import { XRSessionManager } from './xr-session.js';

const $ = (id) => document.getElementById(id);
const canvas = $('glcanvas');
const logEl = $('log');

function notify(msg, type = 'info') {
  const line = document.createElement('div');
  line.className = type;
  line.textContent = `[${new Date().toLocaleTimeString()}] ${msg}`;
  logEl.prepend(line);
  while (logEl.children.length > 80) logEl.lastChild.remove();
  const overlay = $('overlay-status');
  overlay.textContent = msg;
  overlay.style.color = type === 'error' ? '#ef6461' : type === 'warn' ? '#f0b429' : '#dfe6ee';
}

const stats = new FrameStats();
stats.onLongTask = (d) => notify(`检测到长任务 ${d.toFixed(0)} ms，可能造成卡顿`, 'warn');

const renderer = new Renderer(canvas, {
  notify,
  onDegraded: () => syncUIFromRenderer(),
});

const xr = new XRSessionManager(renderer, {
  notify,
  onSessionEnd: () => {
    $('btn-exit-xr').disabled = true;
    $('btn-enter-xr').disabled = false;
    $('btn-resume-xr').disabled = false;
    notify('已回到桌面模拟模式，可点击「恢复会话」重连', 'warn');
  },
  onViewMismatch: handleViewMismatch,
});

function handleViewMismatch(requested, actual) {
  notify(`视图数量不匹配：请求 ${requested} 视图，会话提供 ${actual} 视图，已自动适配`, 'warn');
  $('stat-views').textContent = `${actual}（请求 ${requested}，已适配）`;
}

// ---------- 渲染循环 ----------
let xrAnimHandle = null;

function desktopLoop() {
  const step = () => {
    if (!xr.active) { // XR 会话期间由 XR 循环接管
      stats.beginFrame();
      renderer.renderFrame(performance.now() / 1000);
      stats.endFrame();
    }
    requestAnimationFrame(step);
  };
  requestAnimationFrame(step);
}

function startXRLoop() {
  const onFrame = (time, frame) => {
    if (!xr.active) return;
    stats.beginFrame();
    const views = xr.onXRFrame(frame, time / 1000);
    if (views > 0 && !xr._mismatchNotified) {
      $('stat-views').textContent = String(views);
    }
    stats.endFrame();
    xr.session.requestAnimationFrame(onFrame);
  };
  xr.session.requestAnimationFrame(onFrame);
}

// ---------- UI 绑定 ----------
function requestedViewCount() {
  return Number(document.querySelector('input[name="viewmode"]:checked').value);
}

function currentLayerFlags() {
  return {
    projection: $('layer-projection').checked,
    texture: $('layer-texture').checked,
    cylinder: $('layer-cylinder').checked,
  };
}

function syncUIFromRenderer() {
  // 降级后回写 UI，保持可视化与状态一致
  document.querySelector(`input[name="viewmode"][value="${renderer.viewCount}"]`).checked = true;
  $('layer-projection').checked = renderer.layerFlags.projection;
  $('layer-texture').checked = renderer.layerFlags.texture;
  $('layer-cylinder').checked = renderer.layerFlags.cylinder;
}

document.querySelectorAll('input[name="viewmode"]').forEach((r) => {
  r.addEventListener('change', () => {
    const n = requestedViewCount();
    renderer.setViewCount(n);
    xr.requestedViews = n;
    xr._mismatchNotified = false;
    notify(`切换视图模式：${n} 视图`);
  });
});

['layer-projection', 'layer-texture', 'layer-cylinder'].forEach((id) => {
  $(id).addEventListener('change', () => {
    renderer.setLayerFlags(currentLayerFlags());
    notify('图层配置已更新');
  });
});

$('btn-enter-xr').addEventListener('click', async () => {
  const ok = await xr.enter(requestedViewCount());
  if (ok) {
    $('btn-enter-xr').disabled = true;
    $('btn-exit-xr').disabled = false;
    $('btn-resume-xr').disabled = true;
    startXRLoop();
  }
});
$('btn-exit-xr').addEventListener('click', () => xr.exit());
$('btn-resume-xr').addEventListener('click', async () => {
  const ok = await xr.resume();
  if (ok) {
    $('btn-enter-xr').disabled = true;
    $('btn-exit-xr').disabled = false;
    $('btn-resume-xr').disabled = true;
    startXRLoop();
  }
});

// ---------- 故障注入 ----------
$('fault-texture').addEventListener('click', () => {
  renderer.setFaults({ textureFail: true });
  notify('已注入：纹理格式不支持', 'warn');
});
$('fault-vram').addEventListener('click', () => {
  renderer.setFaults({ vramPressure: true });
  notify('已注入：显存不足（+512MB 占用）', 'warn');
});
$('fault-mismatch').addEventListener('click', () => {
  const requested = renderer.viewCount;
  const actual = requested === 4 ? 2 : 1;
  handleViewMismatch(requested, actual);
  renderer.setViewCount(actual);
  syncUIFromRenderer();
});
$('fault-interrupt').addEventListener('click', () => {
  if (xr.active) {
    xr.exit();
  } else {
    notify('当前无 XR 会话，模拟桌面渲染中断 → 重建上下文', 'warn');
    const ext = renderer.gl?.getExtension('WEBGL_lose_context');
    if (ext) {
      ext.loseContext();
      setTimeout(() => ext.restoreContext(), 1200);
    } else {
      notify('WEBGL_lose_context 不可用，无法模拟中断', 'error');
    }
  }
});
$('fault-nolayers').addEventListener('click', () => {
  xr.forceNoLayers = true;
  notify('已注入：下次进入 XR 时禁用 layers 特性', 'warn');
});
$('fault-clear').addEventListener('click', () => {
  renderer.setFaults({ textureFail: false, vramPressure: false });
  renderer.degradedReasons.clear();
  xr.forceNoLayers = false;
  notify('故障已清除，状态已重置', 'ok');
});

// ---------- 统计刷新 ----------
function refreshStats() {
  $('stat-backend').textContent = renderer.backend + (xr.active ? (xr.usingXRLayers ? ' + XR layers' : ' + XR') : '');
  if (!xr.active) $('stat-views').textContent = String(renderer.viewCount);
  $('stat-cpu').textContent = fmtMs(stats.avgMs);
  $('stat-gpu').textContent = renderer.gpuTimeMs !== null ? fmtMs(renderer.gpuTimeMs) : '不支持';
  $('stat-fps').textContent = fmtFps(stats.fps);
  $('stat-vram').textContent = renderer.vramUsedMB.toFixed(1) + ' MB';
  $('stat-vram-budget').textContent = renderer.vramBudgetMB.toFixed(0) + ' MB';
  $('stat-heap').textContent = performance.memory
    ? (performance.memory.usedJSHeapSize / 1048576).toFixed(1) + ' MB'
    : '不支持';
  $('stat-degraded').textContent = renderer.degradedText;
  $('stat-degraded').style.color = renderer.degradedReasons.size ? '#f0b429' : '#4cc38a';
}
setInterval(refreshStats, 500);

// ---------- 启动 ----------
(async function init() {
  const support = await xr.checkSupport();
  $('xr-support').textContent = support.available
    ? '✅ 支持 immersive-vr，可进入 XR 会话'
    : '⚠️ ' + support.reason + '，将以桌面模拟模式运行';
  $('xr-support').style.color = support.available ? '#4cc38a' : '#f0b429';
  if (!support.available) $('btn-enter-xr').disabled = true;

  renderer.setViewCount(1);
  renderer.setLayerFlags(currentLayerFlags());
  notify(`渲染后端：${renderer.backend}`);
  desktopLoop();
})();
