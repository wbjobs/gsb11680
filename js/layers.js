// 三类图层：纹理图层（四边形组）、投影图层（等距柱状天空球）、圆柱图层。
// 纹理由 Canvas 2D 程序化生成，创建时检测纹理格式支持并计入显存统计。

function makeCheckerCanvas(size, c1, c2, cells = 8) {
  const cv = document.createElement('canvas');
  cv.width = cv.height = size;
  const ctx = cv.getContext('2d');
  const step = size / cells;
  for (let y = 0; y < cells; y++) {
    for (let x = 0; x < cells; x++) {
      ctx.fillStyle = (x + y) % 2 ? c1 : c2;
      ctx.fillRect(x * step, y * step, step, step);
    }
  }
  ctx.fillStyle = 'rgba(255,255,255,.85)';
  ctx.font = `${size / 8}px sans-serif`;
  ctx.textAlign = 'center';
  ctx.fillText('TEX', size / 2, size / 2);
  return cv;
}

function makeSkyCanvas(w, h) {
  const cv = document.createElement('canvas');
  cv.width = w; cv.height = h;
  const ctx = cv.getContext('2d');
  const grad = ctx.createLinearGradient(0, 0, 0, h);
  grad.addColorStop(0, '#0a1a3f');
  grad.addColorStop(0.5, '#27518f');
  grad.addColorStop(0.55, '#c97b3d');
  grad.addColorStop(1, '#1a0f08');
  ctx.fillStyle = grad;
  ctx.fillRect(0, 0, w, h);
  ctx.fillStyle = 'rgba(255,255,255,.9)';
  for (let i = 0; i < 160; i++) {
    const x = Math.random() * w;
    const y = Math.random() * h * 0.5;
    ctx.fillRect(x, y, 2, 2);
  }
  return cv;
}

function makeGridCanvas(size, label) {
  const cv = document.createElement('canvas');
  cv.width = cv.height = size;
  const ctx = cv.getContext('2d');
  ctx.fillStyle = '#12324a';
  ctx.fillRect(0, 0, size, size);
  ctx.strokeStyle = '#4fc3f7';
  ctx.lineWidth = 2;
  const step = size / 8;
  for (let i = 0; i <= 8; i++) {
    ctx.beginPath(); ctx.moveTo(i * step, 0); ctx.lineTo(i * step, size); ctx.stroke();
    ctx.beginPath(); ctx.moveTo(0, i * step); ctx.lineTo(size, i * step); ctx.stroke();
  }
  ctx.fillStyle = '#b3e5fc';
  ctx.font = `${size / 7}px sans-serif`;
  ctx.textAlign = 'center';
  ctx.fillText(label, size / 2, size / 2);
  return cv;
}

// 检测纹理格式是否可渲染（不支持时返回 false，调用方降级）
export function checkTextureFormat(gl, internalFormat, format, type) {
  const tex = gl.createTexture();
  gl.bindTexture(gl.TEXTURE_2D, tex);
  gl.texImage2D(gl.TEXTURE_2D, 0, internalFormat, 4, 4, 0, format, type, null);
  const fbo = gl.createFramebuffer();
  gl.bindFramebuffer(gl.FRAMEBUFFER, fbo);
  gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, tex, 0);
  const ok = gl.checkFramebufferStatus(gl.FRAMEBUFFER) === gl.FRAMEBUFFER_COMPLETE;
  gl.bindFramebuffer(gl.FRAMEBUFFER, null);
  gl.deleteFramebuffer(fbo);
  gl.deleteTexture(tex);
  return ok;
}

class BaseLayer {
  constructor(renderer, name) {
    this.renderer = renderer;
    this.name = name;
    this.enabled = true;
    this.mesh = null;
    this.texture = null;
    this.textureBytes = 0;
    this.bufferBytes = 0;
    this.tint = [1, 1, 1, 1];
  }

  createMesh(positions, uvs, indices) {
    const gl = this.renderer.gl;
    const bytes = (positions.length + uvs.length) * 4 + indices.length * 2;
    if (!this.renderer.alloc(bytes, `${this.name} 顶点缓冲`)) return false;
    const vbo = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, vbo);
    const interleaved = new Float32Array(positions.length + uvs.length);
    const verts = positions.length / 3;
    for (let i = 0; i < verts; i++) {
      interleaved[i * 5] = positions[i * 3];
      interleaved[i * 5 + 1] = positions[i * 3 + 1];
      interleaved[i * 5 + 2] = positions[i * 3 + 2];
      interleaved[i * 5 + 3] = uvs[i * 2];
      interleaved[i * 5 + 4] = uvs[i * 2 + 1];
    }
    gl.bufferData(gl.ARRAY_BUFFER, interleaved, gl.STATIC_DRAW);
    const ibo = gl.createBuffer();
    gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, ibo);
    gl.bufferData(gl.ELEMENT_ARRAY_BUFFER, indices, gl.STATIC_DRAW);
    this.mesh = { vbo, ibo, count: indices.length };
    this.bufferBytes = bytes;
    this.renderer.trackBuffer(bytes);
    return true;
  }

  createTexture(canvas, { halfFloat = false } = {}) {
    const gl = this.renderer.gl;
    let internal = gl.RGBA8 !== undefined ? gl.RGBA8 : gl.RGBA;
    let type = gl.UNSIGNED_BYTE;
    let bpp = 4;
    if (halfFloat && this.renderer.isGL2) {
      // RGBA16F 需要可渲染且可线性过滤（mipmap 依赖后者）
      const filterable = !!gl.getExtension('OES_texture_half_float_linear');
      if (filterable && checkTextureFormat(gl, gl.RGBA16F, gl.RGBA, gl.HALF_FLOAT)) {
        internal = gl.RGBA16F;
        type = gl.HALF_FLOAT;
        bpp = 8;
      } else {
        this.renderer.emit('warn', `半浮点纹理格式（RGBA16F）不支持，${this.name}已降级为 RGBA8`);
      }
    }
    const bytes = Math.floor(canvas.width * canvas.height * bpp * 1.33); // 含 mipmap
    if (!this.renderer.alloc(bytes, `${this.name} 纹理`)) return false;
    const tex = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, tex);
    gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false);
    try {
      gl.texImage2D(gl.TEXTURE_2D, 0, internal, gl.RGBA, type, canvas);
    } catch {
      // 某些驱动不接受 DOM 源上传到浮点纹理，降级 RGBA8 重试
      this.renderer.emit('warn', `${this.name}浮点纹理上传失败，已降级为 RGBA8`);
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8 !== undefined ? gl.RGBA8 : gl.RGBA,
        gl.RGBA, gl.UNSIGNED_BYTE, canvas);
    }
    gl.generateMipmap(gl.TEXTURE_2D);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR_MIPMAP_LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.REPEAT);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    this.texture = tex;
    this.textureBytes = bytes;
    this.renderer.trackTexture(bytes);
    return true;
  }

  draw(gl, progInfo) {
    if (!this.enabled || !this.mesh || !this.texture) return;
    gl.bindBuffer(gl.ARRAY_BUFFER, this.mesh.vbo);
    gl.enableVertexAttribArray(0);
    gl.enableVertexAttribArray(1);
    gl.vertexAttribPointer(0, 3, gl.FLOAT, false, 20, 0);
    gl.vertexAttribPointer(1, 2, gl.FLOAT, false, 20, 12);
    gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, this.mesh.ibo);
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, this.texture);
    gl.uniform4fv(progInfo.uTint, this.tint);
    gl.drawElements(gl.TRIANGLES, this.mesh.count, gl.UNSIGNED_SHORT, 0);
  }

  dispose() {
    const gl = this.renderer.gl;
    if (this.mesh) {
      gl.deleteBuffer(this.mesh.vbo);
      gl.deleteBuffer(this.mesh.ibo);
      this.renderer.untrackBuffer(this.bufferBytes);
      this.mesh = null;
    }
    if (this.texture) {
      gl.deleteTexture(this.texture);
      this.renderer.untrackTexture(this.textureBytes);
      this.texture = null;
    }
  }
}

// 纹理图层：空间中漂浮的若干纹理四边形
export class TextureLayer extends BaseLayer {
  constructor(renderer) {
    super(renderer, '纹理图层');
  }

  build() {
    const positions = [];
    const uvs = [];
    const indices = [];
    const quads = [
      { c: [-1.6, 0.6, -2.5], s: 0.9 },
      { c: [1.6, 0.4, -3.0], s: 0.8 },
      { c: [0.0, 1.4, -4.0], s: 1.1 },
      { c: [-0.9, -0.7, -2.2], s: 0.7 },
      { c: [1.0, -0.6, -2.6], s: 0.75 },
      { c: [0.0, 0.2, -1.6], s: 0.5 },
    ];
    quads.forEach((q, qi) => {
      const [cx, cy, cz] = q.c;
      const s = q.s;
      const base = qi * 4;
      positions.push(
        cx - s, cy - s, cz,
        cx + s, cy - s, cz,
        cx + s, cy + s, cz,
        cx - s, cy + s, cz,
      );
      uvs.push(0, 0, 1, 0, 1, 1, 0, 1);
      indices.push(base, base + 1, base + 2, base, base + 2, base + 3);
    });
    const size = this.renderer.quality.texSize;
    if (!this.createMesh(positions, uvs, new Uint16Array(indices))) return false;
    return this.createTexture(makeCheckerCanvas(Math.min(size, 256), '#e8553d', '#f5d76e'));
  }
}

// 投影图层：包裹观察者的等距柱状天空球（对应 XRProjectionLayer 的降级实现）
export class ProjectionLayer extends BaseLayer {
  constructor(renderer) {
    super(renderer, '投影图层');
  }

  build() {
    const radius = 50;
    const cols = 48;
    const rows = 24;
    const positions = [];
    const uvs = [];
    const indices = [];
    for (let y = 0; y <= rows; y++) {
      const v = y / rows;
      const phi = v * Math.PI;
      for (let x = 0; x <= cols; x++) {
        const u = x / cols;
        const theta = u * Math.PI * 2;
        positions.push(
          radius * Math.sin(phi) * Math.cos(theta),
          radius * Math.cos(phi),
          radius * Math.sin(phi) * Math.sin(theta),
        );
        uvs.push(u, 1 - v);
      }
    }
    for (let y = 0; y < rows; y++) {
      for (let x = 0; x < cols; x++) {
        const a = y * (cols + 1) + x;
        const b = a + cols + 1;
        // 内侧可见：反向绕序
        indices.push(a, a + 1, b, a + 1, b + 1, b);
      }
    }
    const size = this.renderer.quality.texSize;
    if (!this.createMesh(positions, uvs, new Uint16Array(indices))) return false;
    // 天空纹理尝试半浮点格式，演示格式不支持时的降级
    return this.createTexture(makeSkyCanvas(size, size >> 1), { halfFloat: true });
  }

  draw(gl, progInfo) {
    gl.depthMask(false);
    gl.disable(gl.CULL_FACE);
    super.draw(gl, progInfo);
    gl.enable(gl.CULL_FACE);
    gl.depthMask(true);
  }
}

// 圆柱图层：以观察者为中心的圆柱弧面（对应 XRCylinderLayer 的降级实现）
export class CylinderLayer extends BaseLayer {
  constructor(renderer) {
    super(renderer, '圆柱图层');
  }

  build() {
    const radius = 4;
    const height = 2.4;
    const arc = (Math.PI * 2) / 3; // 120°
    const segs = 48;
    const positions = [];
    const uvs = [];
    const indices = [];
    for (let i = 0; i <= segs; i++) {
      const t = i / segs;
      const theta = -arc / 2 + t * arc;
      const x = radius * Math.sin(theta);
      const z = -radius * Math.cos(theta);
      positions.push(x, -height / 2, z, x, height / 2, z);
      uvs.push(t * 3, 0, t * 3, 1);
    }
    for (let i = 0; i < segs; i++) {
      const a = i * 2;
      indices.push(a, a + 2, a + 1, a + 1, a + 2, a + 3);
    }
    const size = this.renderer.quality.texSize;
    if (!this.createMesh(positions, uvs, new Uint16Array(indices))) return false;
    return this.createTexture(makeGridCanvas(Math.min(size, 256), 'CYL'));
  }

  draw(gl, progInfo) {
    gl.disable(gl.CULL_FACE);
    super.draw(gl, progInfo);
    gl.enable(gl.CULL_FACE);
  }
}
