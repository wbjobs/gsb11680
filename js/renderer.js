// 多视图渲染器：
//  - WebGL2 + OVR_multiview2 时走单次绘制的 multiview 路径（纹理数组 + gl_ViewID_OVR）
//  - 否则降级为逐视图（per-view）分视口渲染
//  - 统一管理显存预算，超预算时拒绝分配并触发降级回调

const VS_BODY = `
layout(location=0) in vec3 aPos;
layout(location=1) in vec2 aUV;
uniform mat4 uViewProj[4];
uniform int uViewIndex;
out vec2 vUV;
void main() {
  int idx = uViewIndex;
#ifdef MULTIVIEW
  idx = int(gl_ViewID_OVR);
#endif
  gl_Position = uViewProj[idx] * vec4(aPos, 1.0);
  vUV = aUV;
}`;

const FS_BODY = `
precision mediump float;
in vec2 vUV;
uniform sampler2D uTex;
uniform vec4 uTint;
out vec4 outColor;
void main() { outColor = texture(uTex, vUV) * uTint; }`;

const BLIT_VS = `#version 300 es
out vec2 vUV;
void main() {
  vec2 p = vec2(float((gl_VertexID << 1) & 2), float(gl_VertexID & 2));
  vUV = p;
  gl_Position = vec4(p * 2.0 - 1.0, 0.0, 1.0);
}`;

const BLIT_FS = `#version 300 es
precision mediump float;
in vec2 vUV;
uniform sampler2DArray uTex;
uniform int uLayer;
out vec4 outColor;
void main() { outColor = texture(uTex, vec3(vUV, float(uLayer))); }`;

const VS_GL1 = `
attribute vec3 aPos;
attribute vec2 aUV;
uniform mat4 uViewProj;
varying vec2 vUV;
void main() { gl_Position = uViewProj * vec4(aPos, 1.0); vUV = aUV; }`;

const FS_GL1 = `
precision mediump float;
varying vec2 vUV;
uniform sampler2D uTex;
uniform vec4 uTint;
void main() { gl_FragColor = texture2D(uTex, vUV) * uTint; }`;

export class Renderer {
  constructor(canvas, emit) {
    this.canvas = canvas;
    this.emit = emit; // (level, message) => void
    this.gl = null;
    this.isGL2 = false;
    this.multiviewExt = null;
    this.maxViews = 1;
    this.viewCount = 1;
    this.useMultiview = false;
    this.textureBytes = 0;
    this.bufferBytes = 0;
    this.memBudget = 512 * 1024 * 1024;
    this.quality = { texSize: 512 };
    this.onBudgetExceeded = null; // 显存不足时的降级回调
    this._mv = null; // multiview 帧缓冲资源
  }

  init() {
    const attrs = { antialias: true, alpha: false, xrCompatible: true };
    let gl = this.canvas.getContext('webgl2', attrs);
    if (gl) {
      this.isGL2 = true;
    } else {
      gl = this.canvas.getContext('webgl', attrs);
      this.emit('warn', 'WebGL2 不可用，已降级为 WebGL1（仅逐视图渲染）');
    }
    if (!gl) {
      this.emit('error', '当前浏览器不支持 WebGL，无法渲染');
      return false;
    }
    this.gl = gl;
    // 上下文恢复等重初始化场景：重置显存统计与 multiview 资源
    this.textureBytes = 0;
    this.bufferBytes = 0;
    this._mv = null;

    if (this.isGL2) {
      this.multiviewExt = gl.getExtension('OVR_multiview2');
      if (this.multiviewExt) {
        this.maxViews = gl.getParameter(this.multiviewExt.MAX_VIEWS_OVR);
        this.emit('ok', `OVR_multiview2 可用，最多支持 ${this.maxViews} 视图`);
      } else {
        this.emit('warn', 'OVR_multiview2 不可用，多视图将使用逐视图渲染');
      }
    }

    this.#buildPrograms();
    gl.enable(gl.DEPTH_TEST);
    gl.enable(gl.CULL_FACE);
    return true;
  }

  // ---------- 显存预算 ----------
  alloc(bytes, what) {
    if (this.textureBytes + this.bufferBytes + bytes > this.memBudget) {
      this.emit('warn', `显存预算不足，分配 ${what}（${(bytes / 1048576).toFixed(1)} MB）被拒绝`);
      if (this.onBudgetExceeded) this.onBudgetExceeded();
      return false;
    }
    return true;
  }

  trackTexture(bytes) { this.textureBytes += bytes; }
  untrackTexture(bytes) { this.textureBytes = Math.max(0, this.textureBytes - bytes); }
  trackBuffer(bytes) { this.bufferBytes += bytes; }
  untrackBuffer(bytes) { this.bufferBytes = Math.max(0, this.bufferBytes - bytes); }

  // ---------- 着色器 ----------
  #buildPrograms() {
    const gl = this.gl;
    if (this.isGL2) {
      this.progSingle = this.#compileProgram(`#version 300 es\n${VS_BODY}`, `#version 300 es\n${FS_BODY}`);
      if (this.multiviewExt) {
        const vs = `#version 300 es\n#extension GL_OVR_multiview2 : require\n#define MULTIVIEW 1\n${VS_BODY}`;
        this.progMulti = this.#compileProgram(vs, `#version 300 es\n${FS_BODY}`);
        this.progBlit = this.#compileProgram(BLIT_VS, BLIT_FS);
      }
    } else {
      this.progSingle = this.#compileProgram(VS_GL1, FS_GL1);
    }
  }

  #compileProgram(vsSrc, fsSrc) {
    const gl = this.gl;
    const compile = (type, src) => {
      const sh = gl.createShader(type);
      gl.shaderSource(sh, src);
      gl.compileShader(sh);
      if (!gl.getShaderParameter(sh, gl.COMPILE_STATUS)) {
        throw new Error('着色器编译失败: ' + gl.getShaderInfoLog(sh));
      }
      return sh;
    };
    const prog = gl.createProgram();
    gl.bindAttribLocation(prog, 0, 'aPos');
    gl.bindAttribLocation(prog, 1, 'aUV');
    gl.attachShader(prog, compile(gl.VERTEX_SHADER, vsSrc));
    gl.attachShader(prog, compile(gl.FRAGMENT_SHADER, fsSrc));
    gl.linkProgram(prog);
    if (!gl.getProgramParameter(prog, gl.LINK_STATUS)) {
      throw new Error('着色器链接失败: ' + gl.getProgramInfoLog(prog));
    }
    return {
      prog,
      uViewProj: gl.getUniformLocation(prog, 'uViewProj'),
      uViewProjSingle: gl.getUniformLocation(prog, 'uViewProj'),
      uViewIndex: gl.getUniformLocation(prog, 'uViewIndex'),
      uTex: gl.getUniformLocation(prog, 'uTex'),
      uTint: gl.getUniformLocation(prog, 'uTint'),
      uLayer: gl.getUniformLocation(prog, 'uLayer'),
    };
  }

  // ---------- 视图布局 ----------
  setViewCount(n) {
    this.viewCount = n;
    this.useMultiview = false;
    if (n >= 2 && this.isGL2 && this.multiviewExt) {
      if (n <= this.maxViews) {
        this.useMultiview = true;
      } else {
        this.emit('warn',
          `视图数量不匹配：请求 ${n} 视图，multiview 扩展最多 ${this.maxViews} 视图，已切换逐视图渲染`);
      }
    }
    this.#destroyMultiviewTarget();
    return this.viewCount;
  }

  getViewports() {
    const w = this.canvas.width;
    const h = this.canvas.height;
    switch (this.viewCount) {
      case 2:
        return [
          { x: 0, y: 0, w: w >> 1, h },
          { x: w >> 1, y: 0, w: w - (w >> 1), h },
        ];
      case 4: {
        const hw = w >> 1, hh = h >> 1;
        return [
          { x: 0, y: hh, w: hw, h: h - hh },
          { x: hw, y: hh, w: w - hw, h: h - hh },
          { x: 0, y: 0, w: hw, h: hh },
          { x: hw, y: 0, w: w - hw, h: hh },
        ];
      }
      default:
        return [{ x: 0, y: 0, w, h }];
    }
  }

  resize() {
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    const w = Math.floor(this.canvas.clientWidth * dpr);
    const h = Math.floor(this.canvas.clientHeight * dpr);
    if (this.canvas.width !== w || this.canvas.height !== h) {
      this.canvas.width = w;
      this.canvas.height = h;
      this.#destroyMultiviewTarget();
    }
  }

  // ---------- multiview 渲染目标 ----------
  #createMultiviewTarget() {
    const gl = this.gl;
    const ext = this.multiviewExt;
    const vps = this.getViewports();
    const vw = vps[0].w;
    const vh = vps[0].h;
    const n = this.viewCount;

    const colorTex = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D_ARRAY, colorTex);
    gl.texStorage3D(gl.TEXTURE_2D_ARRAY, 1, gl.RGBA8, vw, vh, n);
    const depthTex = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D_ARRAY, depthTex);
    gl.texStorage3D(gl.TEXTURE_2D_ARRAY, 1, gl.DEPTH_COMPONENT16, vw, vh, n);

    const fbo = gl.createFramebuffer();
    gl.bindFramebuffer(gl.FRAMEBUFFER, fbo);
    ext.framebufferTextureMultiviewOVR(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, colorTex, 0, 0, n);
    ext.framebufferTextureMultiviewOVR(gl.FRAMEBUFFER, gl.DEPTH_ATTACHMENT, depthTex, 0, 0, n);
    const ok = gl.checkFramebufferStatus(gl.FRAMEBUFFER) === gl.FRAMEBUFFER_COMPLETE;
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);

    if (!ok) {
      gl.deleteTexture(colorTex);
      gl.deleteTexture(depthTex);
      gl.deleteFramebuffer(fbo);
      this.emit('warn', 'multiview 帧缓冲不完整，已降级为逐视图渲染');
      this.useMultiview = false;
      return null;
    }
    const bytes = vw * vh * n * (4 + 2);
    this.trackTexture(bytes);
    this._mv = { fbo, colorTex, depthTex, vw, vh, bytes };
    return this._mv;
  }

  #destroyMultiviewTarget() {
    if (!this._mv) return;
    const gl = this.gl;
    gl.deleteFramebuffer(this._mv.fbo);
    gl.deleteTexture(this._mv.colorTex);
    gl.deleteTexture(this._mv.depthTex);
    this.untrackTexture(this._mv.bytes);
    this._mv = null;
  }

  // ---------- 帧渲染 ----------
  // viewProjs: Float32Array(16 * viewCount)，layers: 图层数组
  renderFrame(viewProjs, layers) {
    const gl = this.gl;
    if (this.useMultiview) {
      if (!this._mv) {
        if (!this.#createMultiviewTarget()) this.useMultiview = false;
      }
    }

    if (this.useMultiview && this._mv) {
      const mv = this._mv;
      gl.bindFramebuffer(gl.FRAMEBUFFER, mv.fbo);
      gl.viewport(0, 0, mv.vw, mv.vh);
      gl.clearColor(0.04, 0.05, 0.08, 1);
      gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT);
      const p = this.progMulti;
      gl.useProgram(p.prog);
      gl.uniformMatrix4fv(p.uViewProj, false, viewProjs);
      gl.uniform1i(p.uTex, 0);
      for (const layer of layers) layer.draw(gl, p);
      // 把纹理数组的每一层 blit 到对应视口
      gl.bindFramebuffer(gl.FRAMEBUFFER, null);
      gl.disable(gl.DEPTH_TEST);
      const b = this.progBlit;
      gl.useProgram(b.prog);
      gl.activeTexture(gl.TEXTURE0);
      gl.bindTexture(gl.TEXTURE_2D_ARRAY, mv.colorTex);
      gl.uniform1i(b.uTex, 0);
      const vps = this.getViewports();
      for (let i = 0; i < this.viewCount; i++) {
        gl.viewport(vps[i].x, vps[i].y, vps[i].w, vps[i].h);
        gl.uniform1i(b.uLayer, i);
        gl.drawArrays(gl.TRIANGLES, 0, 3);
      }
      gl.enable(gl.DEPTH_TEST);
      gl.bindTexture(gl.TEXTURE_2D_ARRAY, null);
    } else {
      gl.bindFramebuffer(gl.FRAMEBUFFER, null);
      gl.viewport(0, 0, this.canvas.width, this.canvas.height);
      gl.clearColor(0.04, 0.05, 0.08, 1);
      gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT);
      const p = this.progSingle;
      gl.useProgram(p.prog);
      gl.uniform1i(p.uTex, 0);
      const vps = this.getViewports();
      for (let i = 0; i < this.viewCount; i++) {
        gl.viewport(vps[i].x, vps[i].y, vps[i].w, vps[i].h);
        if (this.isGL2) {
          gl.uniformMatrix4fv(p.uViewProj, false, viewProjs);
          gl.uniform1i(p.uViewIndex, i);
        } else {
          gl.uniformMatrix4fv(p.uViewProjSingle, false, viewProjs.subarray(i * 16, i * 16 + 16));
        }
        for (const layer of layers) layer.draw(gl, p);
      }
    }
  }

  // XR 会话内渲染：framebuffer / viewport 由 XRWebGLLayer 提供
  renderXRViews(xrLayer, xrViews, layers) {
    const gl = this.gl;
    gl.bindFramebuffer(gl.FRAMEBUFFER, xrLayer.framebuffer);
    gl.clearColor(0.04, 0.05, 0.08, 1);
    gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT);
    const p = this.progSingle;
    gl.useProgram(p.prog);
    gl.uniform1i(p.uTex, 0);
    const vpData = new Float32Array(16 * xrViews.length);
    for (let i = 0; i < xrViews.length; i++) {
      vpData.set(xrViews[i].viewProj, i * 16);
    }
    if (this.isGL2) gl.uniformMatrix4fv(p.uViewProj, false, vpData);
    for (let i = 0; i < xrViews.length; i++) {
      const vp = xrLayer.getViewport(xrViews[i].raw);
      gl.viewport(vp.x, vp.y, vp.width, vp.height);
      if (this.isGL2) {
        gl.uniform1i(p.uViewIndex, i);
      } else {
        gl.uniformMatrix4fv(p.uViewProjSingle, false, vpData.subarray(i * 16, i * 16 + 16));
      }
      for (const layer of layers) layer.draw(gl, p);
    }
  }

  get renderPath() {
    if (this.useMultiview && this._mv) return `multiview ×${this.viewCount}`;
    return `逐视图 ×${this.viewCount}`;
  }
}
