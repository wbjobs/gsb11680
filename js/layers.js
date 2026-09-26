// 三种图层的几何体 / 纹理 / 绘制逻辑
import { mat4Multiply, mat4Translate, mat4RotateY, mat4RotateX } from './math.js';

const VS = `
attribute vec3 aPos;
attribute vec2 aUV;
uniform mat4 uMVP;
uniform mat4 uModel;
varying vec2 vUV;
void main() {
  vUV = aUV;
  gl_Position = uMVP * uModel * vec4(aPos, 1.0);
}`;

const FS_TEXTURED = `
precision mediump float;
varying vec2 vUV;
uniform sampler2D uTex;
uniform float uAlpha;
void main() {
  vec4 c = texture2D(uTex, vUV);
  gl_FragColor = vec4(c.rgb, c.a * uAlpha);
}`;

const FS_GRADIENT = `
precision mediump float;
varying vec2 vUV;
uniform float uTime;
uniform float uAlpha;
void main() {
  vec3 top = vec3(0.05, 0.10, 0.22);
  vec3 bottom = vec3(0.35 + 0.15 * sin(uTime), 0.18, 0.30);
  vec3 c = mix(bottom, top, vUV.y);
  float grid = step(0.97, fract(vUV.x * 20.0)) + step(0.97, fract(vUV.y * 12.0));
  c += grid * 0.08;
  gl_FragColor = vec4(c, uAlpha);
}`;

function compile(gl, type, src) {
  const sh = gl.createShader(type);
  gl.shaderSource(sh, src);
  gl.compileShader(sh);
  if (!gl.getShaderParameter(sh, gl.COMPILE_STATUS)) {
    throw new Error('着色器编译失败: ' + gl.getShaderInfoLog(sh));
  }
  return sh;
}

export function createProgram(gl, fragSrc) {
  const prog = gl.createProgram();
  gl.attachShader(prog, compile(gl, gl.VERTEX_SHADER, VS));
  gl.attachShader(prog, compile(gl, gl.FRAGMENT_SHADER, fragSrc));
  gl.linkProgram(prog);
  if (!gl.getProgramParameter(prog, gl.LINK_STATUS)) {
    throw new Error('着色器链接失败: ' + gl.getProgramInfoLog(prog));
  }
  return {
    prog,
    aPos: gl.getAttribLocation(prog, 'aPos'),
    aUV: gl.getAttribLocation(prog, 'aUV'),
    uMVP: gl.getUniformLocation(prog, 'uMVP'),
    uModel: gl.getUniformLocation(prog, 'uModel'),
    uTex: gl.getUniformLocation(prog, 'uTex'),
    uTime: gl.getUniformLocation(prog, 'uTime'),
    uAlpha: gl.getUniformLocation(prog, 'uAlpha'),
  };
}

function createMesh(gl, interleaved, count) {
  const vbo = gl.createBuffer();
  gl.bindBuffer(gl.ARRAY_BUFFER, vbo);
  gl.bufferData(gl.ARRAY_BUFFER, interleaved, gl.STATIC_DRAW);
  return { vbo, count, bytes: interleaved.byteLength };
}

// ---------- 投影图层：全屏渐变四边形 ----------
export function createProjectionLayer(gl) {
  const data = new Float32Array([
    -1, -1, -0.5, 0, 0,   1, -1, -0.5, 1, 0,   1, 1, -0.5, 1, 1,
    -1, -1, -0.5, 0, 0,   1, 1, -0.5, 1, 1,   -1, 1, -0.5, 0, 1,
  ]);
  const mesh = createMesh(gl, data, 6);
  const program = createProgram(gl, FS_GRADIENT);
  return {
    name: 'projection',
    bytes: mesh.bytes,
    draw(gl, vp, time) {
      gl.useProgram(program.prog);
      gl.bindBuffer(gl.ARRAY_BUFFER, mesh.vbo);
      gl.enableVertexAttribArray(program.aPos);
      gl.enableVertexAttribArray(program.aUV);
      gl.vertexAttribPointer(program.aPos, 3, gl.FLOAT, false, 20, 0);
      gl.vertexAttribPointer(program.aUV, 2, gl.FLOAT, false, 20, 12);
      const ident = new Float32Array([1,0,0,0,0,1,0,0,0,0,1,0,0,0,0,1]);
      gl.uniformMatrix4fv(program.uMVP, false, ident);
      gl.uniformMatrix4fv(program.uModel, false, ident);
      gl.uniform1f(program.uTime, time);
      gl.uniform1f(program.uAlpha, 1.0);
      gl.depthMask(false);
      gl.disable(gl.DEPTH_TEST);
      gl.drawArrays(gl.TRIANGLES, 0, mesh.count);
      gl.enable(gl.DEPTH_TEST);
      gl.depthMask(true);
    },
  };
}

// ---------- 纹理图层：旋转立方体 ----------
export function createTextureLayer(gl, texture) {
  // 6 面 * 2 三角形 * 3 顶点，每顶点 pos(3)+uv(2)
  const faces = [];
  const quads = [
    [[-0.5,-0.5, 0.5],[ 0.5,-0.5, 0.5],[ 0.5, 0.5, 0.5],[-0.5, 0.5, 0.5]],
    [[ 0.5,-0.5,-0.5],[-0.5,-0.5,-0.5],[-0.5, 0.5,-0.5],[ 0.5, 0.5,-0.5]],
    [[ 0.5,-0.5, 0.5],[ 0.5,-0.5,-0.5],[ 0.5, 0.5,-0.5],[ 0.5, 0.5, 0.5]],
    [[-0.5,-0.5,-0.5],[-0.5,-0.5, 0.5],[-0.5, 0.5, 0.5],[-0.5, 0.5,-0.5]],
    [[-0.5, 0.5, 0.5],[ 0.5, 0.5, 0.5],[ 0.5, 0.5,-0.5],[-0.5, 0.5,-0.5]],
    [[-0.5,-0.5,-0.5],[ 0.5,-0.5,-0.5],[ 0.5,-0.5, 0.5],[-0.5,-0.5, 0.5]],
  ];
  for (const q of quads) {
    const uv = [[0,0],[1,0],[1,1],[0,1]];
    const idx = [0,1,2, 0,2,3];
    for (const i of idx) faces.push(...q[i], ...uv[i]);
  }
  const mesh = createMesh(gl, new Float32Array(faces), 36);
  const program = createProgram(gl, FS_TEXTURED);
  return {
    name: 'texture',
    bytes: mesh.bytes + texture.bytes,
    draw(gl, vp, time) {
      gl.useProgram(program.prog);
      gl.bindBuffer(gl.ARRAY_BUFFER, mesh.vbo);
      gl.enableVertexAttribArray(program.aPos);
      gl.enableVertexAttribArray(program.aUV);
      gl.vertexAttribPointer(program.aPos, 3, gl.FLOAT, false, 20, 0);
      gl.vertexAttribPointer(program.aUV, 2, gl.FLOAT, false, 20, 12);
      let model = mat4Multiply(mat4RotateY(time * 0.9), mat4RotateX(time * 0.4));
      model = mat4Multiply(mat4Translate(0, 0, -2.2), model);
      gl.uniformMatrix4fv(program.uMVP, false, vp);
      gl.uniformMatrix4fv(program.uModel, false, model);
      gl.activeTexture(gl.TEXTURE0);
      gl.bindTexture(gl.TEXTURE_2D, texture.tex);
      gl.uniform1i(program.uTex, 0);
      gl.uniform1f(program.uAlpha, 1.0);
      gl.drawArrays(gl.TRIANGLES, 0, mesh.count);
    },
  };
}

// ---------- 圆柱图层：等距柱状全景 ----------
export function createCylinderLayer(gl, texture) {
  const segs = 64;
  const radius = 3.2, height = 2.4;
  const verts = [];
  for (let i = 0; i < segs; i++) {
    const a0 = (i / segs) * Math.PI * 2;
    const a1 = ((i + 1) / segs) * Math.PI * 2;
    const x0 = Math.sin(a0) * radius, z0 = Math.cos(a0) * radius;
    const x1 = Math.sin(a1) * radius, z1 = Math.cos(a1) * radius;
    const u0 = i / segs, u1 = (i + 1) / segs;
    const yB = -height / 2, yT = height / 2;
    // 内侧可见（绕序面向圆心）
    verts.push(x0,yB,z0, u0,0,  x0,yT,z0, u0,1,  x1,yT,z1, u1,1);
    verts.push(x0,yB,z0, u0,0,  x1,yT,z1, u1,1,  x1,yB,z1, u1,0);
  }
  const mesh = createMesh(gl, new Float32Array(verts), segs * 6);
  const program = createProgram(gl, FS_TEXTURED);
  return {
    name: 'cylinder',
    bytes: mesh.bytes + texture.bytes,
    draw(gl, vp, time) {
      gl.useProgram(program.prog);
      gl.bindBuffer(gl.ARRAY_BUFFER, mesh.vbo);
      gl.enableVertexAttribArray(program.aPos);
      gl.enableVertexAttribArray(program.aUV);
      gl.vertexAttribPointer(program.aPos, 3, gl.FLOAT, false, 20, 0);
      gl.vertexAttribPointer(program.aUV, 2, gl.FLOAT, false, 20, 12);
      const model = mat4RotateY(time * 0.15);
      gl.uniformMatrix4fv(program.uMVP, false, vp);
      gl.uniformMatrix4fv(program.uModel, false, model);
      gl.activeTexture(gl.TEXTURE0);
      gl.bindTexture(gl.TEXTURE_2D, texture.tex);
      gl.uniform1i(program.uTex, 0);
      gl.uniform1f(program.uAlpha, 0.95);
      gl.enable(gl.BLEND);
      gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA);
      gl.disable(gl.CULL_FACE);
      gl.drawArrays(gl.TRIANGLES, 0, mesh.count);
      gl.disable(gl.BLEND);
    },
  };
}

// ---------- 纹理生成（Canvas 2D 离屏画布） ----------
export function makeCheckerCanvas(size = 256) {
  const c = document.createElement('canvas');
  c.width = c.height = size;
  const ctx = c.getContext('2d');
  const n = 8, s = size / n;
  for (let y = 0; y < n; y++) {
    for (let x = 0; x < n; x++) {
      ctx.fillStyle = (x + y) % 2 ? '#e8543f' : '#f5d76e';
      ctx.fillRect(x * s, y * s, s, s);
    }
  }
  ctx.fillStyle = '#102';
  ctx.font = `bold ${size / 8}px sans-serif`;
  ctx.textAlign = 'center';
  ctx.fillText('纹理图层', size / 2, size / 2);
  return c;
}

export function makePanoramaCanvas(w = 1024, h = 512) {
  const c = document.createElement('canvas');
  c.width = w; c.height = h;
  const ctx = c.getContext('2d');
  const grad = ctx.createLinearGradient(0, 0, 0, h);
  grad.addColorStop(0, '#1b3a5c');
  grad.addColorStop(0.55, '#3f7cac');
  grad.addColorStop(0.62, '#7a5c3f');
  grad.addColorStop(1, '#2e2418');
  ctx.fillStyle = grad;
  ctx.fillRect(0, 0, w, h);
  ctx.strokeStyle = 'rgba(255,255,255,0.25)';
  for (let i = 0; i <= 24; i++) {
    ctx.beginPath(); ctx.moveTo((i / 24) * w, 0); ctx.lineTo((i / 24) * w, h); ctx.stroke();
  }
  for (let i = 0; i <= 8; i++) {
    ctx.beginPath(); ctx.moveTo(0, (i / 8) * h); ctx.lineTo(w, (i / 8) * h); ctx.stroke();
  }
  ctx.fillStyle = '#fff';
  ctx.font = 'bold 36px sans-serif';
  ctx.textAlign = 'center';
  const labels = ['前 0°', '右 90°', '后 180°', '左 270°'];
  labels.forEach((t, i) => ctx.fillText(t, (i / 4 + 0.125) * w, h * 0.42));
  ctx.font = '24px sans-serif';
  ctx.fillText('圆柱全景图层', w / 2, h * 0.52);
  return c;
}
