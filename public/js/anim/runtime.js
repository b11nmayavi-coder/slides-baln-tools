// Code that runs inside each animation Worker. It must be fully self-contained:
// it is stringified and loaded from a data: URL (opaque origin, so user code can't
// touch the app's storage). Rendering happens on an OffscreenCanvas, off the main thread.

export function workerMain() {
  const LINE_OFFSET = 3; // lines new Function() adds before user code
  let canvas = null, inst = null, env = null;
  let running = false, dead = false, raf = 0, t = 0, last = 0;
  let frames = 0, cost = 0, statT = 0, snapReq = null;

  const post = (m, tr) => self.postMessage(m, tr || []);
  const RAF = self.requestAnimationFrame ? (f) => self.requestAnimationFrame(f) : (f) => setTimeout(() => f(performance.now()), 16);
  const CAF = self.cancelAnimationFrame ? (id) => self.cancelAnimationFrame(id) : (id) => clearTimeout(id);

  // ---------- helper library exposed to animation code as env.lib ----------
  const TAU = Math.PI * 2;
  const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);
  const lerp = (a, b, f) => a + (b - a) * f;
  const smoothstep = (a, b, x) => { const k = clamp((x - a) / (b - a), 0, 1); return k * k * (3 - 2 * k); };
  const fract = (x) => x - Math.floor(x);

  function mulberry32(seed) {
    let a = seed >>> 0;
    return function () {
      a |= 0; a = (a + 0x6d2b79f5) | 0;
      let r = Math.imul(a ^ (a >>> 15), 1 | a);
      r = (r + Math.imul(r ^ (r >>> 7), 61 | r)) ^ r;
      return ((r ^ (r >>> 14)) >>> 0) / 4294967296;
    };
  }
  const hash = (x, y = 0) => fract(Math.sin(x * 12.9898 + y * 78.233) * 43758.5453);

  // Simplex noise (2D/3D), returns [-1, 1]
  const perm = new Uint8Array(512);
  (function () { const r = mulberry32(1337); const p = new Uint8Array(256); for (let i = 0; i < 256; i++) p[i] = i; for (let i = 255; i > 0; i--) { const j = Math.floor(r() * (i + 1)); const tmp = p[i]; p[i] = p[j]; p[j] = tmp; } for (let i = 0; i < 512; i++) perm[i] = p[i & 255]; })();
  const G3 = new Float32Array([1,1,0,-1,1,0,1,-1,0,-1,-1,0,1,0,1,-1,0,1,1,0,-1,-1,0,-1,0,1,1,0,-1,1,0,1,-1,0,-1,-1]);
  function noise2(xin, yin) {
    const F2 = 0.3660254037844386, G2 = 0.21132486540518713;
    const s = (xin + yin) * F2; const i = Math.floor(xin + s), j = Math.floor(yin + s);
    const t0 = (i + j) * G2; const x0 = xin - (i - t0), y0 = yin - (j - t0);
    const i1 = x0 > y0 ? 1 : 0, j1 = x0 > y0 ? 0 : 1;
    const x1 = x0 - i1 + G2, y1 = y0 - j1 + G2, x2 = x0 - 1 + 2 * G2, y2 = y0 - 1 + 2 * G2;
    const ii = i & 255, jj = j & 255;
    let n = 0, tt, g;
    tt = 0.5 - x0 * x0 - y0 * y0; if (tt > 0) { g = (perm[ii + perm[jj]] % 12) * 3; tt *= tt; n += tt * tt * (G3[g] * x0 + G3[g + 1] * y0); }
    tt = 0.5 - x1 * x1 - y1 * y1; if (tt > 0) { g = (perm[ii + i1 + perm[jj + j1]] % 12) * 3; tt *= tt; n += tt * tt * (G3[g] * x1 + G3[g + 1] * y1); }
    tt = 0.5 - x2 * x2 - y2 * y2; if (tt > 0) { g = (perm[ii + 1 + perm[jj + 1]] % 12) * 3; tt *= tt; n += tt * tt * (G3[g] * x2 + G3[g + 1] * y2); }
    return 70 * n;
  }
  function noise3(x, y, z) {
    const F3 = 1 / 3, G = 1 / 6;
    const s = (x + y + z) * F3; const i = Math.floor(x + s), j = Math.floor(y + s), k = Math.floor(z + s);
    const t0 = (i + j + k) * G; const x0 = x - (i - t0), y0 = y - (j - t0), z0 = z - (k - t0);
    let i1, j1, k1, i2, j2, k2;
    if (x0 >= y0) { if (y0 >= z0) { i1 = 1; j1 = 0; k1 = 0; i2 = 1; j2 = 1; k2 = 0; } else if (x0 >= z0) { i1 = 1; j1 = 0; k1 = 0; i2 = 1; j2 = 0; k2 = 1; } else { i1 = 0; j1 = 0; k1 = 1; i2 = 1; j2 = 0; k2 = 1; } }
    else { if (y0 < z0) { i1 = 0; j1 = 0; k1 = 1; i2 = 0; j2 = 1; k2 = 1; } else if (x0 < z0) { i1 = 0; j1 = 1; k1 = 0; i2 = 0; j2 = 1; k2 = 1; } else { i1 = 0; j1 = 1; k1 = 0; i2 = 1; j2 = 1; k2 = 0; } }
    const x1 = x0 - i1 + G, y1 = y0 - j1 + G, z1 = z0 - k1 + G;
    const x2 = x0 - i2 + 2 * G, y2 = y0 - j2 + 2 * G, z2 = z0 - k2 + 2 * G;
    const x3 = x0 - 1 + 0.5, y3 = y0 - 1 + 0.5, z3 = z0 - 1 + 0.5;
    const ii = i & 255, jj = j & 255, kk = k & 255;
    let n = 0, tt, g;
    tt = 0.6 - x0 * x0 - y0 * y0 - z0 * z0; if (tt > 0) { g = (perm[ii + perm[jj + perm[kk]]] % 12) * 3; tt *= tt; n += tt * tt * (G3[g] * x0 + G3[g + 1] * y0 + G3[g + 2] * z0); }
    tt = 0.6 - x1 * x1 - y1 * y1 - z1 * z1; if (tt > 0) { g = (perm[ii + i1 + perm[jj + j1 + perm[kk + k1]]] % 12) * 3; tt *= tt; n += tt * tt * (G3[g] * x1 + G3[g + 1] * y1 + G3[g + 2] * z1); }
    tt = 0.6 - x2 * x2 - y2 * y2 - z2 * z2; if (tt > 0) { g = (perm[ii + i2 + perm[jj + j2 + perm[kk + k2]]] % 12) * 3; tt *= tt; n += tt * tt * (G3[g] * x2 + G3[g + 1] * y2 + G3[g + 2] * z2); }
    tt = 0.6 - x3 * x3 - y3 * y3 - z3 * z3; if (tt > 0) { g = (perm[ii + 1 + perm[jj + 1 + perm[kk + 1]]] % 12) * 3; tt *= tt; n += tt * tt * (G3[g] * x3 + G3[g + 1] * y3 + G3[g + 2] * z3); }
    return 32 * n;
  }
  function fbm2(x, y, oct = 4) { let a = 0.5, f = 1, s = 0; for (let i = 0; i < oct; i++) { s += a * noise2(x * f, y * f); f *= 2; a *= 0.5; } return s; }

  function rgb(hex) {
    if (Array.isArray(hex)) return hex;
    let h = String(hex || '#000').replace('#', '');
    if (h.length === 3) h = h.split('').map((c) => c + c).join('');
    const n = parseInt(h.slice(0, 6), 16) || 0;
    return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
  }
  const rgba = (hex, a = 1) => { const c = rgb(hex); return `rgba(${c[0]},${c[1]},${c[2]},${a})`; };
  const hsl = (h, s, l, a = 1) => `hsla(${h},${s}%,${l}%,${a})`;
  function palette(t, a = [0.5, 0.5, 0.5], b = [0.5, 0.5, 0.5], c = [1, 1, 1], d = [0, 0.33, 0.67]) {
    return [0, 1, 2].map((i) => Math.round(255 * clamp(a[i] + b[i] * Math.cos(TAU * (c[i] * t + d[i])), 0, 1)));
  }
  function fibonacciSphere(n) {
    const out = new Float32Array(n * 3), g = Math.PI * (3 - Math.sqrt(5));
    for (let i = 0; i < n; i++) { const y = 1 - (2 * (i + 0.5)) / n, r = Math.sqrt(1 - y * y), a = i * g; out[i * 3] = r * Math.cos(a); out[i * 3 + 1] = y; out[i * 3 + 2] = r * Math.sin(a); }
    return out;
  }

  // Shadertoy-style full-screen fragment shader. Params and theme colours become uniforms:
  //   numbers -> uniform float u_<name>; colours -> uniform vec3 u_<name> (0..1); booleans -> uniform bool u_<name>
  //   theme   -> uniform vec3 uBg, uText, uAccent, uAccent2
  function shader(envArg, src, opts = {}) {
    const e = envArg || env;
    const cv = e.canvas;
    const gl = cv.getContext('webgl2', { alpha: true, premultipliedAlpha: true, antialias: false, powerPreference: 'high-performance' });
    if (!gl) throw new Error('WebGL2 is unavailable in this browser (hardware acceleration may be off: chrome://settings/system). Use Canvas 2D instead.');
    const scale = opts.scale || 1;
    const pnames = Object.keys(e.params);
    let decl = 'uniform float iTime;\nuniform vec3 iResolution;\nuniform vec4 iMouse;\nuniform float iUnit;\nuniform vec3 uBg, uText, uAccent, uAccent2;\n';
    const pu = [];
    for (const k of pnames) {
      const v = e.params[k];
      if (typeof v === 'number') { decl += `uniform float u_${k};\n`; pu.push([k, 'f']); }
      else if (typeof v === 'boolean') { decl += `uniform bool u_${k};\n`; pu.push([k, 'b']); }
      else if (typeof v === 'string' && v[0] === '#') { decl += `uniform vec3 u_${k};\n`; pu.push([k, 'c']); }
    }
    const header = '#version 300 es\nprecision highp float;\n' + decl + 'out vec4 _fragColor;\n';
    const headerLines = header.split('\n').length - 1;
    const fsrc = header + src + '\nvoid main(){ vec4 c = vec4(0.0); mainImage(c, gl_FragCoord.xy); _fragColor = c; }\n';
    const vsrc = '#version 300 es\nin vec2 p; void main(){ gl_Position = vec4(p, 0.0, 1.0); }';
    function compile(type, s) {
      const sh = gl.createShader(type); gl.shaderSource(sh, s); gl.compileShader(sh);
      if (!gl.getShaderParameter(sh, gl.COMPILE_STATUS)) {
        const log = (gl.getShaderInfoLog(sh) || '').replace(/ERROR: 0:(\d+)/g, (_, l) => 'shader line ' + (l - headerLines));
        throw new Error('GLSL compile error:\n' + log.trim());
      }
      return sh;
    }
    const prog = gl.createProgram();
    gl.attachShader(prog, compile(gl.VERTEX_SHADER, vsrc));
    gl.attachShader(prog, compile(gl.FRAGMENT_SHADER, fsrc));
    gl.bindAttribLocation(prog, 0, 'p');
    gl.linkProgram(prog);
    if (!gl.getProgramParameter(prog, gl.LINK_STATUS)) throw new Error('GLSL link error: ' + gl.getProgramInfoLog(prog));
    gl.useProgram(prog);
    const buf = gl.createBuffer(); gl.bindBuffer(gl.ARRAY_BUFFER, buf);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 3, -1, -1, 3]), gl.STATIC_DRAW);
    gl.enableVertexAttribArray(0); gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0);
    const U = (n) => gl.getUniformLocation(prog, n);
    const uT = U('iTime'), uR = U('iResolution'), uM = U('iMouse'), uUnit = U('iUnit');
    const themeU = [['uBg', 'bg'], ['uText', 'text'], ['uAccent', 'accent'], ['uAccent2', 'accent2']].map(([n, k]) => [U(n), k]);
    const pLoc = pu.map(([k, ty]) => [k, ty, U('u_' + k)]);
    const extra = {};
    const api = {
      gl, program: prog,
      resize(w, h, dpr) { cv.width = Math.max(1, Math.round(w * dpr * scale)); cv.height = Math.max(1, Math.round(h * dpr * scale)); gl.viewport(0, 0, cv.width, cv.height); },
      set(name, v) { extra[name] = v; },
      frame(time) {
        gl.uniform1f(uT, time);
        gl.uniform3f(uR, cv.width, cv.height, 1);
        const ms = cv.width / Math.max(1, e.width);
        gl.uniform4f(uM, e.mouse.x * ms, (e.height - e.mouse.y) * ms, e.mouse.active ? 1 : 0, 0);
        gl.uniform1f(uUnit, (cv.width / 1920));
        for (const [loc, k] of themeU) if (loc) { const c = rgb(e.theme[k]); gl.uniform3f(loc, c[0] / 255, c[1] / 255, c[2] / 255); }
        for (const [k, ty, loc] of pLoc) {
          if (!loc) continue;
          const v = e.params[k];
          if (ty === 'f') gl.uniform1f(loc, v);
          else if (ty === 'b') gl.uniform1i(loc, v ? 1 : 0);
          else { const c = rgb(v); gl.uniform3f(loc, c[0] / 255, c[1] / 255, c[2] / 255); }
        }
        for (const n in extra) { const loc = U(n); const v = extra[n]; if (!loc) continue; if (typeof v === 'number') gl.uniform1f(loc, v); else if (v.length === 2) gl.uniform2fv(loc, v); else if (v.length === 3) gl.uniform3fv(loc, v); else if (v.length === 4) gl.uniform4fv(loc, v); }
        if (opts.before) opts.before(gl, time);
        gl.drawArrays(gl.TRIANGLES, 0, 3);
      },
    };
    api.resize(e.width, e.height, e.dpr);
    return api;
  }

  const lib = { TAU, clamp, lerp, mix: lerp, smoothstep, fract, hash, rand: mulberry32, noise2, noise3, fbm2, rgb, rgba, hsl, palette, fibonacciSphere, shader };

  // ---------- lifecycle ----------
  function fail(err, phase) {
    if (dead) return;
    dead = true; running = false; CAF(raf);
    const stack = (err && err.stack) || '';
    const m = /<anonymous>:(\d+):(\d+)/.exec(stack) || /Function:(\d+):(\d+)/.exec(stack);
    post({ type: 'error', phase, message: (err && err.message) || String(err), line: m ? Math.max(1, +m[1] - LINE_OFFSET) : null });
  }
  self.addEventListener('error', (ev) => { ev.preventDefault(); fail(ev.error || ev.message, 'runtime'); });
  self.addEventListener('unhandledrejection', (ev) => fail(ev.reason, 'async'));

  function sizeCanvas() {
    canvas.width = Math.max(1, Math.round(env.width * env.dpr));
    canvas.height = Math.max(1, Math.round(env.height * env.dpr));
  }

  async function load(code) {
    try {
      const factory = new Function('lib', '"use strict";\n' + code + '\n;return typeof setup === "function" ? setup : null;');
      const setup = factory(lib);
      if (!setup) throw new Error('The code must define `function setup(env) { ...; return { frame(t, dt) {} } }`');
      let r = setup(env);
      if (r && typeof r.then === 'function') r = await r;
      if (typeof r === 'function') r = { frame: r };
      inst = r || {};
      if (inst.resize) inst.resize(env.width, env.height, env.dpr);
      post({ type: 'ready' });
      if (!running) step(0);
    } catch (e) { fail(e, 'setup'); }
  }

  function step(dt) {
    if (dead || !inst) return;
    t += dt;
    const s = performance.now();
    try { if (inst.frame) inst.frame(t, dt); } catch (e) { fail(e, 'frame'); return; }
    cost += performance.now() - s;
    frames++;
    if (snapReq) doSnap();
    const n = performance.now();
    if (running && n - statT > 1000) {
      post({ type: 'stats', fps: statT ? (frames * 1000) / (n - statT) : 60, ms: cost / Math.max(1, frames), t });
      frames = 0; cost = 0; statT = n;
    }
  }
  function tick(now) {
    if (!running) return;
    raf = RAF(tick);
    const dt = last ? Math.min(0.1, (now - last) / 1000) : 1 / 60;
    last = now;
    step(dt);
  }
  function play() { if (running || dead) return; running = true; last = 0; statT = performance.now(); frames = 0; cost = 0; raf = RAF(tick); }
  function pause() { running = false; CAF(raf); }

  function doSnap() {
    const { id, width } = snapReq; snapReq = null;
    try {
      const w = Math.min(width || 640, canvas.width), h = Math.max(1, Math.round((w * canvas.height) / canvas.width));
      const c = new OffscreenCanvas(w, h);
      c.getContext('2d').drawImage(canvas, 0, 0, w, h);
      c.convertToBlob({ type: 'image/webp', quality: 0.85 }).then((blob) => post({ type: 'snapshot', id, blob }), (e) => post({ type: 'snapshot', id, error: String(e) }));
    } catch (e) { post({ type: 'snapshot', id, error: String(e) }); }
  }

  self.onmessage = (ev) => {
    const m = ev.data;
    switch (m.type) {
      case 'init':
        canvas = m.canvas;
        t = m.t || 0;
        env = {
          canvas, width: m.width, height: m.height, dpr: m.dpr, unit: m.width / 1920,
          params: m.params || {}, theme: m.theme || {}, quality: m.quality,
          mouse: { x: m.width / 2, y: m.height / 2, active: false }, lib,
        };
        sizeCanvas();
        load(m.code).then(() => { if (m.play) play(); });
        break;
      case 'resize':
        if (!env) return;
        env.width = m.width; env.height = m.height; env.dpr = m.dpr; env.unit = m.width / 1920;
        sizeCanvas();
        try { if (inst && inst.resize) inst.resize(env.width, env.height, env.dpr); } catch (e) { fail(e, 'resize'); }
        if (!running) step(0);
        break;
      case 'params': Object.assign(env.params, m.values); if (!running) step(0); break;
      case 'theme': env.theme = m.theme; if (!running) step(0); break;
      case 'mouse': env.mouse.x = m.x * env.width; env.mouse.y = m.y * env.height; env.mouse.active = m.active; break;
      case 'play': play(); break;
      case 'pause': pause(); break;
      case 'seek': t = m.t; if (!running) step(0); break;
      case 'snapshot': snapReq = { id: m.id, width: m.width }; if (!running) step(0); break;
    }
  };
}
