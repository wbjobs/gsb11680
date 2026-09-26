// 渲染器：WebGL2 -> WebGL1 -> Canvas2D 三级降级
import { mat4Multiply, mat4Perspective, mat4LookAt } from './math.js';
import {
  createProjectionLayer, createTextureLayer, createCylinderLayer,
  makeCheckerCanvas, makePanoramaCanvas,
} from './layers.js';

export const VRAM_BUDGET_MB = 256;

function fmtMB(bytes) { return (bytes / 1048576).toFixed(1) + ' MB'; }

export class Renderer {
  constructor(canvas, hooks = {}) {
    this.canvas = canvas;
    this.hooks = hooks;           // { notify(msg,type), onDegraded(reason) }
    this.viewCount = 1;
    this.layerFlags = { projection: true, texture: true, cylinder: true };
    this.layers = [];
    this.textures = [];
    this.allocatedBytes = 0;
    this.vramBudget = VRAM_BUDGET_MB * 1048576;
    this.forceTextureFail = false;
    this.forceVramPressure = false;
    this.degradedReasons = new Set();
    this.gpuTimeMs = null;
    this.timerQuery = null;
    this.timerExt = null;
    this.backend = 'none';
    this._lost = false;
    this._initGL();
  }

  _initGL() {
    const opts = { antialias: true, alpha: false, xrCompatible: true };
    let gl = this.canvas.getContext('webgl2', opts);
    this.isGL2 = !!gl;
    if (!gl) gl = this.canvas.getContext('webgl', opts) || this.canvas.getContext('experimental-webgl', opts);
    if (!gl) {
      this.backend = 'canvas2d';
      this.ctx2d = this.canvas.getContext('2d');
      this.hooks.notify('WebGL 不可用，降级为 Canvas2D 渲染', 'warn');
      this.degradedReasons.add('WebGL 不可用 → Canvas2D');
      return;
    }
    this.gl = gl;
    this.backend = this.isGL2 ? 'webgl2' : 'webgl1';
    gl.enable(gl.DEPTH_TEST);
    gl.clearColor(0.02, 0.03, 0.05, 1);

    // GPU 计时（WebGL2 扩展，不可用时仅展示 CPU 耗时）
    if (this.isGL2) {
      this.timerExt = gl.getExtension('EXT_disjoint_timer_query_webgl2');
    }

    this.canvas.addEventListener('webglcontextlost', (e) => {
      e.preventDefault();
      this._lost = true;
      this.hooks.notify('WebGL 上下文丢失（可能显存不足），尝试恢复…', 'error');
    });
    this.canvas.addEventListener('webglcontextrestored', () => {
      this._lost = false;
      this._rebuild();
      this.hooks.notify('WebGL 上下文已恢复', 'ok');
    });

    this._pickTextureFormat();
    this._buildLayers();
  }

  // 纹理格式探测：half-float -> RGBA8，全部失败则禁用纹理类图层
  _pickTextureFormat() {
    const gl = this.gl;
    this.texFormat = null;
    if (this.forceTextureFail) {
      this.hooks.notify('纹理格式探测失败（故障注入），纹理/圆柱图层已禁用', 'error');
      this.degradedReasons.add('纹理格式不支持 → 禁用纹理类图层');
      return;
    }
    const candidates = [];
    if (this.isGL2) {
      const hf = gl.getExtension('OES_texture_half_float') || gl.getExtension('EXT_color_buffer_half_float');
      if (hf) candidates.push({ name: 'RGBA16F', internal: gl.RGBA16F, format: gl.RGBA, type: gl.HALF_FLOAT });
    }
    candidates.push({ name: 'RGBA8', internal: gl.RGBA, format: gl.RGBA, type: gl.UNSIGNED_BYTE });

    for (const c of candidates) {
      const tex = gl.createTexture();
      gl.bindTexture(gl.TEXTURE_2D, tex);
      try {
        gl.texImage2D(gl.TEXTURE_2D, 0, c.internal, 4, 4, 0, c.format, c.type, null);
        if (gl.getError() === gl.NO_ERROR) {
          gl.deleteTexture(tex);
          const changed = this.texFormat?.name !== c.name;
          this.texFormat = c;
          if (changed) this.hooks.notify(`纹理格式：${c.name}`, 'ok');
          return;
        }
      } catch (_) { /* 尝试下一个 */ }
      gl.deleteTexture(tex);
    }
    this.hooks.notify('所有纹理格式均不支持，纹理/圆柱图层已禁用', 'error');
    this.degradedReasons.add('纹理格式不支持 → 禁用纹理类图层');
  }

  _uploadTexture(canvas2d, label) {
    const gl = this.gl;
    if (!this.texFormat) return null;
    const tex = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, tex);
    gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, true);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, canvas2d);
    gl.generateMipmap(gl.TEXTURE_2D);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR_MIPMAP_LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.REPEAT);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    const bytes = canvas2d.width * canvas2d.height * 4 * 1.33; // 含 mipmap
    const entry = { tex, bytes, label };
    this.textures.push(entry);
    this.allocatedBytes += bytes;
    return entry;
  }

  _buildLayers() {
    const gl = this.gl;
    this.layers = [];
    this.textures = [];
    this.allocatedBytes = 0;

    if (this.layerFlags.projection) {
      this.layers.push(createProjectionLayer(gl));
    }
    if (this.layerFlags.texture && this.texFormat) {
      const t = this._uploadTexture(makeCheckerCanvas(), 'checker');
      if (t) this.layers.push(createTextureLayer(gl, t));
    }
    if (this.layerFlags.cylinder && this.texFormat) {
      const t = this._uploadTexture(makePanoramaCanvas(), 'panorama');
      if (t) this.layers.push(createCylinderLayer(gl, t));
    }
    // 帧缓冲近似占用（颜色+深度，按视图数估算）
    const fb = this.canvas.width * this.canvas.height * 8;
    this.allocatedBytes += fb;
    if (this.forceVramPressure) this.allocatedBytes += 512 * 1048576; // 故障注入
  }

  _rebuild() {
    if (!this.gl) return;
    this._pickTextureFormat();
    this._buildLayers();
  }

  setViewCount(n) {
    this.viewCount = n;
    this._rebuild();
    this._checkVram();
  }

  setLayerFlags(flags) {
    this.layerFlags = { ...flags };
    this._rebuild();
    this._checkVram();
  }

  setFaults({ textureFail, vramPressure }) {
    let changed = false;
    if (textureFail !== undefined && textureFail !== this.forceTextureFail) {
      this.forceTextureFail = textureFail; changed = true;
    }
    if (vramPressure !== undefined && vramPressure !== this.forceVramPressure) {
      this.forceVramPressure = vramPressure; changed = true;
    }
    if (changed) { this._rebuild(); this._checkVram(); }
  }

  // 显存检查：超预算则逐级降级（减视图 -> 减图层）
  _checkVram() {
    if (!this.gl) return;
    if (this.allocatedBytes <= this.vramBudget) return;
    this.hooks.notify(
      `显存占用 ${fmtMB(this.allocatedBytes)} 超出预算 ${fmtMB(this.vramBudget)}，执行降级`, 'warn');
    if (this.viewCount > 1) {
      this.viewCount = 1;
      this.degradedReasons.add('显存不足 → 降级为单视图');
      this.hooks.notify('已降级为单视图', 'warn');
      this._rebuild();
      if (this.allocatedBytes <= this.vramBudget) { this.hooks.onDegraded?.(); return; }
    }
    if (this.layerFlags.cylinder) {
      this.layerFlags.cylinder = false;
      this.degradedReasons.add('显存不足 → 关闭圆柱图层');
      this.hooks.notify('显存仍不足，关闭圆柱图层', 'warn');
      this._rebuild();
    }
    if (this.allocatedBytes > this.vramBudget && this.layerFlags.texture) {
      this.layerFlags.texture = false;
      this.degradedReasons.add('显存不足 → 关闭纹理图层');
      this.hooks.notify('显存仍不足，关闭纹理图层', 'warn');
      this._rebuild();
    }
    this.hooks.onDegraded?.();
  }

  // 计算 n 个视图的布局（桌面模拟模式用）
  _viewports(n) {
    const w = this.canvas.width, h = this.canvas.height;
    if (n === 1) return [{ x: 0, y: 0, w, h, yaw: 0, eye: 0, label: '单眼' }];
    if (n === 2) {
      return [
        { x: 0, y: 0, w: w / 2, h, yaw: 0, eye: -0.032, label: '左眼' },
        { x: w / 2, y: 0, w: w / 2, h, yaw: 0, eye: 0.032, label: '右眼' },
      ];
    }
    // 四视图：2x2，分别朝向前/右/后/左
    return [
      { x: 0, y: h / 2, w: w / 2, h: h / 2, yaw: 0, eye: 0, label: '前' },
      { x: w / 2, y: h / 2, w: w / 2, h: h / 2, yaw: Math.PI / 2, eye: 0, label: '右' },
      { x: 0, y: 0, w: w / 2, h: h / 2, yaw: Math.PI, eye: 0, label: '后' },
      { x: w / 2, y: 0, w: w / 2, h: h / 2, yaw: -Math.PI / 2, eye: 0, label: '左' },
    ];
  }

  _beginGpuTimer() {
    if (!this.timerExt || this.timerQuery) return;
    const gl = this.gl;
    this.timerQuery = gl.createQuery();
    gl.beginQuery(this.timerExt.TIME_ELAPSED_EXT, this.timerQuery);
  }

  _endGpuTimer() {
    if (!this.timerQuery) return;
    const gl = this.gl;
    gl.endQuery(this.timerExt.TIME_ELAPSED_EXT);
    const q = this.timerQuery;
    this.timerQuery = null;
    const poll = () => {
      if (this._lost) { gl.deleteQuery(q); return; }
      if (gl.getQueryParameter(q, gl.QUERY_RESULT_AVAILABLE)) {
        const disjoint = gl.getParameter(this.timerExt.GPU_DISJOINT_EXT);
        if (!disjoint) this.gpuTimeMs = gl.getQueryParameter(q, gl.QUERY_RESULT) / 1e6;
        gl.deleteQuery(q);
      } else {
        setTimeout(poll, 8);
      }
    };
    poll();
  }

  // 桌面/模拟模式渲染一帧
  renderFrame(time) {
    if (this.backend === 'canvas2d') return this._renderFrame2D(time);
    const gl = this.gl;
    if (!gl || this._lost) return;
    if (this.canvas.width !== this.canvas.clientWidth || this.canvas.height !== this.canvas.clientHeight) {
      this.canvas.width = this.canvas.clientWidth;
      this.canvas.height = this.canvas.clientHeight;
    }
    this._beginGpuTimer();
    gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT);
    const vps = this._viewports(this.viewCount);
    for (const v of vps) {
      gl.viewport(v.x, v.y, v.w, v.h);
      gl.scissor(v.x, v.y, v.w, v.h);
      gl.enable(gl.SCISSOR_TEST);
      const aspect = v.w / v.h;
      const proj = mat4Perspective(Math.PI / 3, aspect, 0.05, 100);
      const eye = [Math.sin(v.yaw) * 0.001 + v.eye, 0, 0.001];
      const center = [Math.sin(v.yaw) * -1 + v.eye, 0, Math.cos(v.yaw) * -1];
      const view = mat4LookAt(eye, center);
      const vp = mat4Multiply(proj, view);
      for (const layer of this.layers) layer.draw(gl, vp, time);
      gl.disable(gl.SCISSOR_TEST);
    }
    this._endGpuTimer();
  }

  // XR 模式渲染一帧：按 XRView 的 viewport 绘制
  renderXRFrame(gl, frame, refSpace, baseLayer, time) {
    const pose = frame.getViewerPose(refSpace);
    if (!pose) return 0;
    gl.bindFramebuffer(gl.FRAMEBUFFER, baseLayer.framebuffer);
    gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT);
    for (const view of pose.views) {
      const vp = baseLayer.getViewport(view);
      gl.viewport(vp.x, vp.y, vp.width, vp.height);
      const viewProj = mat4Multiply(
        new Float32Array(view.projectionMatrix),
        new Float32Array(view.transform.inverse.matrix),
      );
      for (const layer of this.layers) layer.draw(gl, viewProj, time);
    }
    return pose.views.length;
  }

  _renderFrame2D(time) {
    const ctx = this.ctx2d;
    const c = this.canvas;
    if (c.width !== c.clientWidth) { c.width = c.clientWidth; c.height = c.clientHeight; }
    const vps = this._viewports(this.viewCount);
    for (const v of vps) {
      const g = ctx.createLinearGradient(0, v.y, 0, v.y + v.h);
      g.addColorStop(0, '#1b3a5c'); g.addColorStop(1, '#0d1520');
      ctx.fillStyle = g;
      ctx.fillRect(v.x, v.y, v.w, v.h);
      ctx.strokeStyle = '#4cc38a';
      ctx.strokeRect(v.x + 2, v.y + 2, v.w - 4, v.h - 4);
      ctx.fillStyle = '#fff';
      ctx.font = '16px sans-serif';
      ctx.fillText(`${v.label}（Canvas2D 降级）`, v.x + 12, v.y + 24);
      const cx = v.x + v.w / 2 + Math.sin(time) * v.w * 0.2;
      const cy = v.y + v.h / 2 + Math.cos(time * 1.3) * v.h * 0.2;
      ctx.fillStyle = '#e8543f';
      ctx.fillRect(cx - 20, cy - 20, 40, 40);
    }
  }

  get vramUsedMB() { return this.allocatedBytes / 1048576; }
  get vramBudgetMB() { return this.vramBudget / 1048576; }
  get degradedText() { return this.degradedReasons.size ? [...this.degradedReasons].join('；') : '无'; }
}
