// WebXR 会话管理：能力检测、layers 特性检测、会话中断/恢复、视图数量匹配。

export class XRSessionManager {
  constructor(renderer, emit) {
    this.renderer = renderer;
    this.emit = emit;
    this.session = null;
    this.refSpace = null;
    this.glLayer = null;
    this.userEnded = false;
    this.interrupted = false;
    this.onFrame = null; // (xrViews) => void，由 main 注入实际渲染
    this.onStateChange = null; // (state) => void
    this.requestedViews = 1;
    this.capabilities = { webxr: false, immersiveVr: false, layers: false };
  }

  async detect() {
    if (!('xr' in navigator)) {
      this.emit('warn', '浏览器不支持 WebXR，已使用 Canvas 预览模式');
      return this.capabilities;
    }
    this.capabilities.webxr = true;
    try {
      this.capabilities.immersiveVr = await navigator.xr.isSessionSupported('immersive-vr');
    } catch {
      this.capabilities.immersiveVr = false;
    }
    // layers 特性检测：XRProjectionLayer / XRCylinderLayer 是否存在
    this.capabilities.layers =
      typeof XRProjectionLayer !== 'undefined' && typeof XRCylinderLayer !== 'undefined';
    if (!this.capabilities.immersiveVr) {
      this.emit('warn', '当前设备不支持 immersive-vr 会话，保持 Canvas 预览模式');
    }
    if (!this.capabilities.layers) {
      this.emit('warn', '浏览器不支持 WebXR Layers（XRProjectionLayer/XRCylinderLayer），'
        + '投影/圆柱图层将以 WebGL 几何体降级渲染');
    }
    return this.capabilities;
  }

  async enter() {
    if (!this.capabilities.immersiveVr) {
      this.emit('error', '无法进入 XR：设备不支持 immersive-vr');
      return false;
    }
    const optionalFeatures = ['local-floor', 'bounded-floor'];
    if (this.capabilities.layers) optionalFeatures.push('layers');
    try {
      this.session = await navigator.xr.requestSession('immersive-vr', { optionalFeatures });
    } catch (err) {
      this.emit('error', `XR 会话请求失败：${err.message}`);
      return false;
    }
    this.userEnded = false;
    this.interrupted = false;

    this.session.addEventListener('end', () => this.#handleEnd());
    this.session.addEventListener('visibilitychange', () => {
      if (this.session.visibilityState !== 'visible') {
        this.emit('warn', `XR 会话可见性变化：${this.session.visibilityState}，渲染已暂停等待恢复`);
      } else {
        this.emit('ok', 'XR 会话已恢复可见');
      }
    });

    try {
      this.refSpace = await this.#requestRefSpace();
    } catch (err) {
      this.emit('error', `参考空间获取失败：${err.message}`);
      await this.session.end().catch(() => {});
      return false;
    }

    const gl = this.renderer.gl;
    try {
      await gl.makeXRCompatible();
    } catch {
      this.emit('warn', 'makeXRCompatible 失败，继续尝试默认帧缓冲');
    }
    this.glLayer = new XRWebGLLayer(this.session, gl);
    this.session.updateRenderState({ baseLayer: this.glLayer });
    if (this.capabilities.layers) {
      this.emit('ok', 'XR 会话已建立（支持 Layers，演示中以 baseLayer 渲染 + 几何降级对比）');
    } else {
      this.emit('ok', 'XR 会话已建立（XRWebGLLayer 降级路径）');
    }

    this.session.requestAnimationFrame((t, f) => this.#onXRFrame(t, f));
    if (this.onStateChange) this.onStateChange('active');
    return true;
  }

  async #requestRefSpace() {
    for (const type of ['local-floor', 'local', 'viewer']) {
      try {
        return await this.session.requestReferenceSpace(type);
      } catch { /* 尝试下一种 */ }
    }
    throw new Error('无可用参考空间');
  }

  #onXRFrame(time, frame) {
    if (!this.session) return;
    this.session.requestAnimationFrame((t, f) => this.#onXRFrame(t, f));
    if (this.session.visibilityState !== 'visible') return;
    const pose = frame.getViewerPose(this.refSpace);
    if (!pose) {
      this.emit('warn', '追踪丢失：本帧无 ViewerPose，跳过渲染');
      return;
    }
    const xrViews = pose.views.map((view) => ({
      raw: view,
      viewProj: multiplyMat4(view.projectionMatrix, view.transform.inverse.matrix),
    }));

    // 视图数量不匹配检测
    if (xrViews.length !== this.requestedViews) {
      this.emit('warn',
        `视图数量不匹配：请求 ${this.requestedViews} 视图，XR 设备提供 ${xrViews.length} 视图，已按设备能力渲染`);
      this.requestedViews = xrViews.length;
      if (this.onStateChange) this.onStateChange('view-mismatch', xrViews.length);
    }
    if (this.onFrame) this.onFrame(this.glLayer, xrViews);
  }

  #handleEnd() {
    const wasInterrupted = !this.userEnded;
    this.session = null;
    this.refSpace = null;
    this.glLayer = null;
    if (wasInterrupted) {
      this.interrupted = true;
      this.emit('error', 'XR 会话意外中断，可点击「恢复会话」重新进入');
      if (this.onStateChange) this.onStateChange('interrupted');
    } else {
      this.emit('ok', 'XR 会话已正常退出，回到 Canvas 预览模式');
      if (this.onStateChange) this.onStateChange('ended');
    }
  }

  async resume() {
    this.emit('info', '正在恢复 XR 会话…');
    return this.enter();
  }

  async exit() {
    if (!this.session) return;
    this.userEnded = true;
    await this.session.end().catch(() => {});
  }

  // 模拟会话中断（验收测试用）：直接结束当前会话但不标记为用户退出
  async simulateInterrupt() {
    if (!this.session) {
      this.emit('warn', '当前无 XR 会话，模拟中断仅触发恢复流程提示');
      this.interrupted = true;
      if (this.onStateChange) this.onStateChange('interrupted');
      return;
    }
    this.userEnded = false;
    await this.session.end().catch(() => {});
  }

  get active() {
    return this.session !== null;
  }
}

function multiplyMat4(a, b) {
  const out = new Float32Array(16);
  for (let c = 0; c < 4; c++) {
    for (let r = 0; r < 4; r++) {
      out[c * 4 + r] =
        a[r] * b[c * 4] +
        a[4 + r] * b[c * 4 + 1] +
        a[8 + r] * b[c * 4 + 2] +
        a[12 + r] * b[c * 4 + 3];
    }
  }
  return out;
}
