// WebXR 会话管理：进入/退出/中断恢复/layers 探测/视图数适配
export class XRSessionManager {
  constructor(renderer, hooks = {}) {
    this.renderer = renderer;
    this.hooks = hooks; // { notify, onSessionEnd, onViewMismatch }
    this.session = null;
    this.refSpace = null;
    this.baseLayer = null;
    this.layersSupported = false;
    this.usingXRLayers = false;
    this.forceNoLayers = false;
    this.requestedViews = 1;
    this._mismatchNotified = false;
    this._savedState = null;
  }

  async checkSupport() {
    if (!('xr' in navigator)) {
      return { available: false, reason: '浏览器不支持 WebXR（navigator.xr 不存在）' };
    }
    try {
      const ok = await navigator.xr.isSessionSupported('immersive-vr');
      return ok
        ? { available: true }
        : { available: false, reason: '当前设备不支持 immersive-vr 会话' };
    } catch (e) {
      return { available: false, reason: 'WebXR 检测失败: ' + e.message };
    }
  }

  async enter(viewCount) {
    if (this.session) return;
    this.requestedViews = viewCount;
    this._savedState = { viewCount };
    const optionalFeatures = ['local-floor', 'bounded-floor'];
    // layers 特性探测（故障注入可强制走降级路径）
    if (!this.forceNoLayers) optionalFeatures.push('layers');
    let session;
    try {
      session = await navigator.xr.requestSession('immersive-vr', { optionalFeatures });
    } catch (e) {
      this.hooks.notify('会话请求失败: ' + e.message + '，保持桌面模拟模式', 'error');
      return false;
    }
    this.session = session;
    this._mismatchNotified = false;

    session.addEventListener('end', () => this._onEnd());
    session.addEventListener('visibilitychange', () => {
      this.hooks.notify('会话可见性变化: ' + session.visibilityState, 'warn');
    });

    const gl = this.renderer.gl;
    if (!gl) {
      this.hooks.notify('无 WebGL 上下文，无法在 XR 中渲染', 'error');
      await session.end().catch(() => {});
      return false;
    }

    // layers 支持检测
    this.layersSupported =
      !this.forceNoLayers &&
      typeof XRWebGLBinding !== 'undefined' &&
      typeof XRProjectionLayer !== 'undefined' &&
      session.enabledFeatures?.includes('layers');

    try {
      if (this.layersSupported) {
        await this._setupLayersMode(session, gl);
      } else {
        await this._setupLegacyMode(session, gl);
        if (this.forceNoLayers) {
          this.hooks.notify('layers 特性被禁用（故障注入），降级为 XRWebGLLayer 投影合成', 'warn');
        } else {
          this.hooks.notify('浏览器不支持 WebXR layers，降级为 XRWebGLLayer 投影合成', 'warn');
        }
      }
    } catch (e) {
      this.hooks.notify('layers 模式初始化失败: ' + e.message + '，降级为 XRWebGLLayer', 'warn');
      try {
        await this._setupLegacyMode(session, gl);
      } catch (e2) {
        this.hooks.notify('XR 渲染初始化失败: ' + e2.message, 'error');
        await session.end().catch(() => {});
        return false;
      }
    }

    try {
      this.refSpace = await session.requestReferenceSpace('local');
    } catch (_) {
      this.refSpace = await session.requestReferenceSpace('viewer');
    }
    this.hooks.notify(
      `XR 会话已启动（${this.usingXRLayers ? 'layers 模式' : 'XRWebGLLayer 合成模式'}）`, 'ok');
    return true;
  }

  async _setupLayersMode(session, gl) {
    await gl.makeXRCompatible();
    const binding = new XRWebGLBinding(session, gl);
    const layers = [];
    // 投影图层（必须，作为基底）
    const proj = binding.createProjectionLayer({ alpha: false });
    layers.push(proj);
    // 圆柱图层（全景）
    if (typeof XRCylinderLayer !== 'undefined' && this.renderer.layerFlags.cylinder) {
      try {
        const cyl = binding.createCylinderLayer({
          transform: new XRRigidTransform(),
          radius: 3.2, centralAngle: Math.PI * 2, aspectRatio: 2,
        });
        layers.push(cyl);
      } catch (e) {
        this.hooks.notify('圆柱图层创建失败，仅使用投影图层: ' + e.message, 'warn');
      }
    }
    session.updateRenderState({ layers });
    this.usingXRLayers = true;
    // 投影层仍需要每帧渲染纹理层内容
    this.baseLayer = {
      get framebuffer() { return proj.texture ? null : null; },
    };
    this._projLayer = proj;
    this._binding = binding;
  }

  async _setupLegacyMode(session, gl) {
    await gl.makeXRCompatible();
    this.baseLayer = new XRWebGLLayer(session, gl, { alpha: false, antialias: true });
    session.updateRenderState({ baseLayer: this.baseLayer });
    this.usingXRLayers = false;
  }

  // 每帧调用；返回实际视图数（供 UI 展示）
  onXRFrame(frame, time) {
    const session = this.session;
    if (!session || !this.refSpace) return 0;
    const gl = this.renderer.gl;
    let actualViews = 0;
    if (this.usingXRLayers && this._projLayer) {
      // layers 模式：渲染进投影层子图像
      const pose = frame.getViewerPose(this.refSpace);
      if (!pose) return 0;
      actualViews = pose.views.length;
      for (const view of pose.views) {
        const si = this._binding.getViewSubImage(this._projLayer, view);
        gl.bindFramebuffer(gl.FRAMEBUFFER, si.colorSwapchainFramebuffer ?? si.framebuffer);
        gl.viewport(si.viewport.x, si.viewport.y, si.viewport.width, si.viewport.height);
        const viewProj = multiplyF32(view.projectionMatrix, view.transform.inverse.matrix);
        for (const layer of this.renderer.layers) layer.draw(gl, viewProj, time);
      }
    } else {
      actualViews = this.renderer.renderXRFrame(gl, frame, this.refSpace, this.baseLayer, time);
    }
    // 视图数量不匹配检测
    if (actualViews > 0 && actualViews !== this.requestedViews && !this._mismatchNotified) {
      this._mismatchNotified = true;
      this.hooks.onViewMismatch?.(this.requestedViews, actualViews);
    }
    return actualViews;
  }

  _onEnd() {
    this.hooks.notify('XR 会话已结束/中断', 'warn');
    this.session = null;
    this.refSpace = null;
    this.baseLayer = null;
    this._projLayer = null;
    this._binding = null;
    this.usingXRLayers = false;
    this.hooks.onSessionEnd?.(this._savedState);
  }

  async exit() {
    if (this.session) {
      try { await this.session.end(); } catch (_) { /* 已结束 */ }
    }
    this._onEnd();
  }

  // 会话中断后按保存的状态恢复
  async resume() {
    if (!this._savedState) return false;
    this.hooks.notify('正在按中断前状态恢复会话…', 'warn');
    return this.enter(this._savedState.viewCount);
  }

  get active() { return !!this.session; }
}

function multiplyF32(a, b) {
  const out = new Float32Array(16);
  for (let c = 0; c < 4; c++)
    for (let r = 0; r < 4; r++) {
      let s = 0;
      for (let k = 0; k < 4; k++) s += a[k * 4 + r] * b[c * 4 + k];
      out[c * 4 + r] = s;
    }
  return out;
}
