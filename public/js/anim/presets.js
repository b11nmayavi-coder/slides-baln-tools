// Built-in animations. They double as examples of the animation contract for the AI.

const aurora = `// Aurora — flowing light ribbons (fragment shader, full-bleed background)
const FRAG = \`
float hash(vec2 p){ p = fract(p*vec2(123.34, 456.21)); p += dot(p, p+45.32); return fract(p.x*p.y); }
float noise(vec2 p){
  vec2 i = floor(p), f = fract(p); vec2 u = f*f*(3.0-2.0*f);
  return mix(mix(hash(i), hash(i+vec2(1,0)), u.x), mix(hash(i+vec2(0,1)), hash(i+vec2(1,1)), u.x), u.y);
}
float fbm(vec2 p){ float s = 0.0, a = 0.5; for (int i = 0; i < 5; i++){ s += a*noise(p); p *= 2.02; a *= 0.5; } return s; }

void mainImage(out vec4 fragColor, in vec2 fragCoord){
  vec2 p = (fragCoord - 0.5*iResolution.xy) / iResolution.y;
  float t = iTime * u_speed * 0.12;
  vec3 col = uBg;
  for (int i = 0; i < 4; i++){
    float fi = float(i);
    float y = 0.18*sin(p.x*1.3 + t*2.1 + fi*1.9) + 0.22*(fbm(vec2(p.x*0.9 + t*0.8 + fi*3.7, t*0.6 + fi)) - 0.5);
    float d = p.y - y - 0.08*(fi - 1.5);
    float band = exp(-d*d*u_sharpness) * smoothstep(-0.9, 0.2, -d);
    float streak = 0.55 + 0.45*fbm(vec2(p.x*9.0 + fi*11.0, t*2.5));
    vec3 c = mix(u_colorA, u_colorB, 0.5 + 0.5*sin(p.x*1.7 + t*1.3 + fi*1.1));
    col += c * band * streak * u_intensity * 0.42;
  }
  float v = smoothstep(1.3, 0.2, length(p*vec2(0.8, 1.2)));
  col *= mix(0.55, 1.0, v);
  col += (hash(fragCoord + fract(iTime)) - 0.5) * 0.018; // film grain, kills banding
  fragColor = vec4(col, 1.0);
}\`;

function setup(env) {
  return env.lib.shader(env, FRAG, { scale: 0.75 });
}`;

const mesh = `// Mesh gradient — soft drifting colour fields (fragment shader)
const FRAG = \`
float hash(vec2 p){ return fract(sin(dot(p, vec2(12.9898, 78.233))) * 43758.5453); }
void mainImage(out vec4 fragColor, in vec2 fragCoord){
  vec2 uv = fragCoord / iResolution.xy;
  vec2 p = uv; p.x *= iResolution.x / iResolution.y;
  float t = iTime * u_speed * 0.08;
  vec2 c1 = vec2(0.3 + 0.25*sin(t*1.3), 0.3 + 0.2*cos(t*1.7));
  vec2 c2 = vec2(1.3 + 0.3*cos(t*1.1), 0.7 + 0.2*sin(t*1.5));
  vec2 c3 = vec2(0.9 + 0.35*sin(t*0.9 + 2.0), 0.2 + 0.25*cos(t*1.2 + 1.0));
  vec2 c4 = vec2(0.5 + 0.3*cos(t*0.7 + 4.0), 0.85 + 0.15*sin(t*1.9));
  float w1 = 1.0/pow(distance(p, c1)+0.05, u_softness);
  float w2 = 1.0/pow(distance(p, c2)+0.05, u_softness);
  float w3 = 1.0/pow(distance(p, c3)+0.05, u_softness);
  float w4 = 1.0/pow(distance(p, c4)+0.05, u_softness);
  vec3 col = (uAccent*w1 + uAccent2*w2 + u_color3*w3 + uBg*w4*1.4) / (w1+w2+w3+w4*1.4);
  col = mix(uBg, col, u_strength);
  col += (hash(fragCoord + fract(iTime)*7.0) - 0.5) * 0.03;
  fragColor = vec4(col, 1.0);
}\`;

function setup(env) {
  return env.lib.shader(env, FRAG, { scale: 0.5 }); // smooth field: half resolution is invisible and 4x cheaper
}`;

const orb = `// Particle orb — a rotating sphere of dots with travelling colour waves (Canvas 2D)
function setup(env) {
  const { lib, canvas } = env;
  const ctx = canvas.getContext('2d');
  let W = 0, H = 0, N = 0, pts, bands;
  const LEVELS = 8; // depth buckets -> few fillStyle changes, big batched paths

  function build() {
    N = Math.round(env.params.dots);
    pts = lib.fibonacciSphere(N);
    bands = new Uint8Array(N);
    for (let i = 0; i < N; i++) {
      const y = pts[i * 3 + 1], a = Math.atan2(pts[i * 3 + 2], pts[i * 3]);
      bands[i] = (Math.floor((a / lib.TAU + 0.5) * 4 + y * 1.2) % 4 + 4) % 4;
    }
  }
  build();
  // Reused scratch buffers: no allocation per frame.
  let sx = new Float32Array(N), sy = new Float32Array(N), sr = new Float32Array(N), bucket = new Uint8Array(N);

  return {
    resize(w, h, dpr) { W = w; H = h; ctx.setTransform(dpr, 0, 0, dpr, 0, 0); },
    frame(t) {
      if (Math.round(env.params.dots) !== N) { build(); sx = new Float32Array(N); sy = new Float32Array(N); sr = new Float32Array(N); bucket = new Uint8Array(N); }
      const P = env.params, sp = P.speed;
      ctx.clearRect(0, 0, W, H);
      const R = Math.min(W, H) * 0.42 * P.size;
      const cx = W / 2, cy = H / 2;
      const m = env.mouse;
      const yaw = t * 0.35 * sp + (m.active ? (m.x / W - 0.5) * 0.8 : 0);
      const tilt = 0.35 + 0.1 * Math.sin(t * 0.4 * sp) + (m.active ? (m.y / H - 0.5) * 0.6 : 0);
      const cyw = Math.cos(yaw), syw = Math.sin(yaw), ct = Math.cos(tilt), st = Math.sin(tilt);
      const dotR = Math.max(0.6, R * 0.012 * P.dotSize);
      for (let i = 0; i < N; i++) {
        let x = pts[i * 3], y = pts[i * 3 + 1], z = pts[i * 3 + 2];
        const wave = Math.sin(t * 2.2 * sp - y * 5.0 + Math.atan2(z, x) * 2.0) * 0.5 + 0.5;
        const k = 1 + wave * wave * 0.06 * P.wave;
        x *= k; y *= k; z *= k;
        const x1 = x * cyw + z * syw, z1 = -x * syw + z * cyw;
        const y1 = y * ct - z1 * st, z2 = y * st + z1 * ct;
        const depth = (z2 + 1) * 0.5;
        sx[i] = cx + x1 * R; sy[i] = cy - y1 * R;
        sr[i] = dotR * (0.55 + 0.9 * depth) * (0.9 + wave * 0.5);
        bucket[i] = Math.min(LEVELS - 1, Math.floor(depth * LEVELS));
      }
      const cols = [P.color1, P.color2, P.color3, P.color4].map(lib.rgb);
      const base = lib.rgb(env.theme.bg);
      for (let L = 0; L < LEVELS; L++) {            // back to front
        const d = (L + 0.5) / LEVELS;
        const alpha = 0.12 + 0.88 * d * d;
        const mix = 0.35 + 0.65 * d;                  // far dots sink into the background colour
        for (let c = 0; c < 4; c++) {
          const cc = cols[c];
          ctx.fillStyle = 'rgba(' + Math.round(lib.lerp(base[0], cc[0], mix)) + ',' + Math.round(lib.lerp(base[1], cc[1], mix)) + ',' + Math.round(lib.lerp(base[2], cc[2], mix)) + ',' + alpha.toFixed(3) + ')';
          ctx.beginPath();
          for (let i = 0; i < N; i++) {
            if (bucket[i] !== L || bands[i] !== c) continue;
            ctx.moveTo(sx[i] + sr[i], sy[i]);
            ctx.arc(sx[i], sy[i], sr[i], 0, lib.TAU);
          }
          ctx.fill();
        }
      }
    },
  };
}`;

const dotgrid = `// Dot grid — a calm field of dots with ripples that follow the pointer (Canvas 2D)
function setup(env) {
  const { lib, canvas } = env;
  const ctx = canvas.getContext('2d');
  let W = 0, H = 0, cols = 0, rows = 0, gap = 0;
  const BUCKETS = 6;
  let ripple = { x: 0.5, y: 0.5 };

  return {
    resize(w, h, dpr) {
      W = w; H = h; ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      gap = Math.max(8, env.params.spacing * env.unit);
      cols = Math.ceil(W / gap) + 1; rows = Math.ceil(H / gap) + 1;
    },
    frame(t, dt) {
      const P = env.params;
      const g = Math.max(8, P.spacing * env.unit);
      if (g !== gap) this.resize(W, H, env.dpr);
      ctx.clearRect(0, 0, W, H);
      const m = env.mouse;
      const k = 1 - Math.pow(0.02, dt || 0.016);        // frame-rate independent easing
      ripple.x += ((m.active ? m.x / W : 0.5 + 0.2 * Math.cos(t * 0.3)) - ripple.x) * k;
      ripple.y += ((m.active ? m.y / H : 0.5 + 0.2 * Math.sin(t * 0.4)) - ripple.y) * k;
      const rx = ripple.x * W, ry = ripple.y * H, diag = Math.hypot(W, H);
      const r0 = Math.max(0.8, 1.6 * env.unit * P.dotSize);
      const acc = Array.from({ length: BUCKETS }, () => new Path2D());
      for (let j = 0; j < rows; j++) {
        for (let i = 0; i < cols; i++) {
          const x = i * gap, y = j * gap;
          const d = Math.hypot(x - rx, y - ry) / diag;
          const w = Math.sin(d * 38 - t * 2.4 * P.speed) * 0.5 + 0.5;
          const fall = Math.exp(-d * 3.2);
          const n = lib.noise3(x * 0.004, y * 0.004, t * 0.15) * 0.5 + 0.5;
          const v = lib.clamp(w * w * fall * 1.2 + n * 0.25, 0, 0.999);
          const r = r0 * (0.6 + v * 1.6);
          const p = acc[Math.floor(v * BUCKETS)];
          p.moveTo(x + r, y); p.arc(x, y, r, 0, lib.TAU);
        }
      }
      const c = lib.rgb(P.color);
      for (let b = 0; b < BUCKETS; b++) {
        ctx.fillStyle = 'rgba(' + c[0] + ',' + c[1] + ',' + c[2] + ',' + (0.08 + 0.8 * (b / (BUCKETS - 1)) ** 1.6).toFixed(3) + ')';
        ctx.fill(acc[b]);
      }
    },
  };
}`;

const flow = `// Flow field — particles drifting along curl-like noise, leaving soft trails (Canvas 2D)
function setup(env) {
  const { lib, canvas } = env;
  const ctx = canvas.getContext('2d', { alpha: false });
  let W = 0, H = 0, N = 0, px, py, life;
  const rand = lib.rand(7);

  function seed(i) { px[i] = rand() * W; py[i] = rand() * H; life[i] = 40 + rand() * 160; }
  function alloc() {
    N = Math.round(env.params.count);
    px = new Float32Array(N); py = new Float32Array(N); life = new Float32Array(N);
    for (let i = 0; i < N; i++) seed(i);
  }

  return {
    resize(w, h, dpr) {
      W = w; H = h; ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      alloc();
      ctx.fillStyle = env.theme.bg; ctx.fillRect(0, 0, W, H);
    },
    frame(t, dt) {
      const P = env.params;
      if (Math.round(P.count) !== N) alloc();
      ctx.fillStyle = lib.rgba(env.theme.bg, 0.06 * P.fade);  // fading trails
      ctx.fillRect(0, 0, W, H);
      const s = 0.0016 / Math.max(0.3, env.unit), sp = 60 * P.speed * env.unit * Math.min(dt || 0.016, 0.05);
      const groups = [new Path2D(), new Path2D(), new Path2D()];
      for (let i = 0; i < N; i++) {
        const x = px[i], y = py[i];
        const a = lib.noise3(x * s, y * s, t * 0.05) * Math.PI * 2.5;
        const nx = x + Math.cos(a) * sp, ny = y + Math.sin(a) * sp;
        const g = groups[i % 3];
        g.moveTo(x, y); g.lineTo(nx, ny);
        px[i] = nx; py[i] = ny;
        if (--life[i] < 0 || nx < 0 || nx > W || ny < 0 || ny > H) seed(i);
      }
      ctx.lineWidth = Math.max(0.6, 1.2 * env.unit * P.thickness);
      ctx.lineCap = 'round';
      const cs = [env.theme.accent, env.theme.accent2, env.theme.text];
      for (let k = 0; k < 3; k++) { ctx.strokeStyle = lib.rgba(cs[k], k === 2 ? 0.35 : 0.7); ctx.stroke(groups[k]); }
    },
  };
}`;

const stars = `// Starfield — gentle forward drift through a field of stars (Canvas 2D)
function setup(env) {
  const { lib, canvas } = env;
  const ctx = canvas.getContext('2d');
  const N = 1400, rand = lib.rand(3);
  const X = new Float32Array(N), Y = new Float32Array(N), Z = new Float32Array(N);
  for (let i = 0; i < N; i++) { X[i] = rand() * 2 - 1; Y[i] = rand() * 2 - 1; Z[i] = rand(); }
  let W = 0, H = 0;
  return {
    resize(w, h, dpr) { W = w; H = h; ctx.setTransform(dpr, 0, 0, dpr, 0, 0); },
    frame(t, dt) {
      const P = env.params;
      ctx.clearRect(0, 0, W, H);
      const f = Math.max(W, H) * 0.5, cx = W / 2 + (env.mouse.active ? (env.mouse.x - W / 2) * 0.05 : 0), cy = H / 2 + (env.mouse.active ? (env.mouse.y - H / 2) * 0.05 : 0);
      const v = (dt || 0.016) * 0.08 * P.speed;
      const c = lib.rgb(P.color);
      const layers = [new Path2D(), new Path2D(), new Path2D(), new Path2D()];
      ctx.lineCap = 'round';
      for (let i = 0; i < N; i++) {
        const z0 = Z[i];
        let z = z0 - v;
        if (z <= 0.02) { z += 1; X[i] = rand() * 2 - 1; Y[i] = rand() * 2 - 1; }
        Z[i] = z;
        const x = cx + (X[i] / z) * f * 0.5, y = cy + (Y[i] / z) * f * 0.5;
        if (x < -20 || x > W + 20 || y < -20 || y > H + 20) continue;
        const px = cx + (X[i] / (z + v * P.streak * 6)) * f * 0.5, py = cy + (Y[i] / (z + v * P.streak * 6)) * f * 0.5;
        const L = layers[Math.min(3, Math.floor((1 - z) * 4))];
        L.moveTo(px, py); L.lineTo(x, y);
      }
      for (let k = 0; k < 4; k++) {
        ctx.strokeStyle = 'rgba(' + c[0] + ',' + c[1] + ',' + c[2] + ',' + (0.15 + k * 0.28).toFixed(2) + ')';
        ctx.lineWidth = Math.max(0.5, (0.6 + k * 0.7) * env.unit * 1.4);
        ctx.stroke(layers[k]);
      }
    },
  };
}`;

const num = (value, min, max, step = 0.01, label) => ({ type: 'range', value, min, max, step, label });
const col = (value, label) => ({ type: 'color', value, label });

export const PRESETS = [
  { id: 'aurora', name: 'Aurora', target: 'background', code: aurora, params: { speed: num(1, 0, 4), intensity: num(1, 0, 2.5), sharpness: num(18, 2, 60, 0.5), colorA: col('#5ce1e6', 'Color A'), colorB: col('#b69cff', 'Color B') } },
  { id: 'mesh', name: 'Mesh gradient', target: 'background', code: mesh, params: { speed: num(1, 0, 4), softness: num(2.2, 1, 5), strength: num(0.85, 0, 1), color3: col('#ff9a62', 'Third color') } },
  { id: 'orb', name: 'Particle orb', target: 'element', code: orb, params: { speed: num(1, 0, 3), size: num(1, 0.4, 1.2), dots: num(1400, 200, 4000, 10), dotSize: num(1, 0.3, 3), wave: num(1, 0, 3), color1: col('#ff443f', 'Color 1'), color2: col('#1fa73f', 'Color 2'), color3: col('#ffbb1f', 'Color 3'), color4: col('#3b95fd', 'Color 4') } },
  { id: 'dotgrid', name: 'Dot grid', target: 'background', code: dotgrid, params: { speed: num(1, 0, 4), spacing: num(34, 14, 90, 1), dotSize: num(1, 0.3, 3), color: col('#9fb4ff', 'Dot color') } },
  { id: 'flow', name: 'Flow field', target: 'background', code: flow, params: { speed: num(1, 0.1, 4), count: num(1800, 200, 6000, 50), fade: num(1, 0.2, 4), thickness: num(1, 0.3, 3) } },
  { id: 'stars', name: 'Starfield', target: 'background', code: stars, params: { speed: num(1, 0, 5), streak: num(1, 0, 4), color: col('#dfe6ff', 'Star color') } },
];
