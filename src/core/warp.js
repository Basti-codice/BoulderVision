// Perspective warp: camera image -> straightened wall. WebGL (fast) with a CPU fallback.
import { invert3, wallHomography } from './geometry.js';

const VS = `attribute vec2 p; varying vec2 v; void main(){ v = p*0.5+0.5; gl_Position = vec4(p,0.,1.); }`;
const FS = `precision highp float;
varying vec2 v;
uniform sampler2D tex;
uniform mat3 M;        // output pixel -> source pixel (homogeneous)
uniform vec2 out_px;   // output size
uniform vec2 src_px;   // source size
uniform vec2 wall_px;  // wall size (for clipping)
uniform mat3 toWall;   // output pixel -> wall pixel
void main(){
  vec2 o = vec2(v.x*out_px.x, (1.-v.y)*out_px.y);
  vec3 w = toWall*vec3(o,1.); vec2 wp = w.xy/w.z;
  if(wp.x<0.||wp.y<0.||wp.x>wall_px.x||wp.y>wall_px.y){ gl_FragColor = vec4(0.); return; }
  vec3 s = M*vec3(o,1.); vec2 sp = s.xy/s.z;
  gl_FragColor = vec4(texture2D(tex, sp/src_px).rgb, 1.);
}`;

const T = (m) => [m[0], m[3], m[6], m[1], m[4], m[7], m[2], m[5], m[8]]; // row-major -> GL column-major
const mul = (A, B) => { const C = new Array(9).fill(0); for (let i = 0; i < 3; i++) for (let j = 0; j < 3; j++) for (let k = 0; k < 3; k++) C[i * 3 + j] += A[i * 3 + k] * B[k * 3 + j]; return C; };

export class Warper {
  constructor(canvas) {
    this.canvas = canvas;
    const gl = canvas.getContext('webgl', { premultipliedAlpha: false, preserveDrawingBuffer: true, alpha: true, antialias: false });
    this.gl = gl;
    if (!gl) return;
    const sh = (type, src) => { const s = gl.createShader(type); gl.shaderSource(s, src); gl.compileShader(s); if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) throw new Error(gl.getShaderInfoLog(s)); return s; };
    const prog = gl.createProgram();
    gl.attachShader(prog, sh(gl.VERTEX_SHADER, VS)); gl.attachShader(prog, sh(gl.FRAGMENT_SHADER, FS));
    gl.linkProgram(prog);
    if (!gl.getProgramParameter(prog, gl.LINK_STATUS)) throw new Error(gl.getProgramInfoLog(prog));
    this.prog = prog; gl.useProgram(prog);
    const buf = gl.createBuffer(); gl.bindBuffer(gl.ARRAY_BUFFER, buf);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 1, -1, -1, 1, 1, 1]), gl.STATIC_DRAW);
    const loc = gl.getAttribLocation(prog, 'p'); gl.enableVertexAttribArray(loc); gl.vertexAttribPointer(loc, 2, gl.FLOAT, false, 0, 0);
    this.u = Object.fromEntries(['tex', 'M', 'out_px', 'src_px', 'wall_px', 'toWall'].map((n) => [n, gl.getUniformLocation(prog, n)]));
    this.tex = gl.createTexture(); gl.bindTexture(gl.TEXTURE_2D, this.tex);
    for (const [k, v] of [[gl.TEXTURE_MIN_FILTER, gl.LINEAR], [gl.TEXTURE_MAG_FILTER, gl.LINEAR], [gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE], [gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE]]) gl.texParameteri(gl.TEXTURE_2D, k, v);
  }
  get ok() { return !!this.gl; }

  /**
   * source: canvas/video/image. Hw2i: wall->image homography (flat 3x3) from corner marking.
   * view: {k, tx, ty}: wall px -> output px (x_out = k*x_wall + tx). wall: {RW, RH}.
   */
  render(source, srcW, srcH, H_img2wall, wall, view, outW, outH) {
    const gl = this.gl;
    if (this.canvas.width !== outW || this.canvas.height !== outH) { this.canvas.width = outW; this.canvas.height = outH; }
    gl.viewport(0, 0, outW, outH);
    gl.clearColor(0, 0, 0, 0); gl.clear(gl.COLOR_BUFFER_BIT);
    if (!H_img2wall) return;
    const Hw2i = invert3(H_img2wall);
    if (!Hw2i) return;
    const out2wall = [1 / view.k, 0, -view.tx / view.k, 0, 1 / view.k, -view.ty / view.k, 0, 0, 1];
    gl.activeTexture(gl.TEXTURE0); gl.bindTexture(gl.TEXTURE_2D, this.tex);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, source);
    gl.uniform1i(this.u.tex, 0);
    gl.uniformMatrix3fv(this.u.M, false, T(mul(Hw2i, out2wall)));
    gl.uniformMatrix3fv(this.u.toWall, false, T(out2wall));
    gl.uniform2f(this.u.out_px, outW, outH); gl.uniform2f(this.u.src_px, srcW, srcH); gl.uniform2f(this.u.wall_px, wall.RW, wall.RH);
    gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
  }

  /** Render the whole wall 1:1 (RW x RH) and return RGBA pixels, top row first. */
  snapshot(source, srcW, srcH, H_img2wall, wall) {
    this.render(source, srcW, srcH, H_img2wall, wall, { k: 1, tx: 0, ty: 0 }, wall.RW, wall.RH);
    const gl = this.gl, { RW, RH } = wall, buf = new Uint8Array(RW * RH * 4);
    gl.readPixels(0, 0, RW, RH, gl.RGBA, gl.UNSIGNED_BYTE, buf);
    const out = new Uint8ClampedArray(RW * RH * 4);
    for (let y = 0; y < RH; y++) out.set(buf.subarray((RH - 1 - y) * RW * 4, (RH - y) * RW * 4), y * RW * 4);
    return { data: out, width: RW, height: RH };
  }
}

/** CPU bilinear warp (fallback when WebGL is unavailable). src: ImageData-like. Returns ImageData-like. */
export function warpCPU(src, H_img2wall, RW, RH) {
  const Hi = invert3(H_img2wall), out = new Uint8ClampedArray(RW * RH * 4), { data, width: sw, height: sh } = src;
  if (!Hi) return { data: out, width: RW, height: RH };
  for (let y = 0; y < RH; y++) for (let x = 0; x < RW; x++) {
    const w = Hi[6] * x + Hi[7] * y + Hi[8], sx = (Hi[0] * x + Hi[1] * y + Hi[2]) / w, sy = (Hi[3] * x + Hi[4] * y + Hi[5]) / w;
    const x0 = Math.max(0, Math.min(sw - 2, Math.floor(sx))), y0 = Math.max(0, Math.min(sh - 2, Math.floor(sy)));
    const fx = Math.max(0, Math.min(1, sx - x0)), fy = Math.max(0, Math.min(1, sy - y0)), i = (y * RW + x) * 4;
    const a = (y0 * sw + x0) * 4, b = a + 4, c = a + sw * 4, d = c + 4;
    for (let k = 0; k < 3; k++) out[i + k] = (data[a + k] * (1 - fx) + data[b + k] * fx) * (1 - fy) + (data[c + k] * (1 - fx) + data[d + k] * fx) * fy;
    out[i + 3] = 255;
  }
  return { data: out, width: RW, height: RH };
}

export { wallHomography };
