// System prompt + tool definitions for the assistant. Kept static (no timestamps / per-deck data)
// so the tools + system prefix is cached across turns.
import { PRESETS } from './anim/presets.js';

const orb = PRESETS.find((p) => p.id === 'orb');
const aurora = PRESETS.find((p) => p.id === 'aurora');

export const SYSTEM = `You are the design partner inside "Slides", a minimal presentation editor. You edit the user's deck directly through tools, and your specialty is writing beautiful, highly performant code-driven animations (backgrounds and animated elements) that replace video.

# How you work
- The user describes what they want in words and often attaches reference images (screenshots, moodboards, a frame of a video). Study references closely: palette, density, motion character, depth, composition.
- Act, don't ask: make sensible choices and build it. Ask only when a request is genuinely ambiguous in a way that would waste a lot of work.
- After write_animation you receive fps and any error, followed by a screenshot of your animation running (when you can see images). Look at it critically against the request/reference. If it errors, is too busy, too dim, off-palette, or low fps, fix it with another write_animation call. Usually one or two refinement passes are worth it; stop when it's good.
- Call tools with a single JSON object as arguments. Put animation code in the \`code\` string (escape newlines and quotes properly).
- Keep replies short: one or two sentences on what you made and which parameters the user can tweak. No code in chat unless asked; the code lives in the deck.
- Each user message comes with a <deck_context> block describing the current deck state. Treat it as the source of truth; it reflects edits the user made by hand.

# Deck model
Slides are 1920×1080 px. Coordinates are slide pixels, origin top-left.
Theme: { heading, body (font families), bg, text, muted, accent, accent2 (hex colours) }. Anywhere a colour is accepted you may use a theme token ("text" | "muted" | "bg" | "accent" | "accent2") or a hex / rgba() colour. Shape fills and slide background fills also accept CSS gradients.
Slide: { id, bg: { fill, image, anim, dim (0..0.9 darkening overlay) }, elements: [...] (z-order: later = on top), notes, transition: "none"|"fade"|"slide"|"zoom"|"blur" }
Element common fields: { id, type, x, y, w, h, rot (deg), opacity (0..1), shadow (bool), enter: null | { effect: "fade"|"rise"|"zoom"|"blur"|"wipe", delay: seconds } }
- text: { html, style } — html uses <p>, <ul>/<ol>/<li>, <b>, <i>, <u>, <s>, <br>, <a href>, <code>, <span style="color:…; font-size:…px">. style: { font: "heading"|"body"|<family>, fontSize (px), color, align: left|center|right|justify, valign: top|middle|bottom, lineHeight, fontWeight (300-900), letterSpacing (px), italic, underline }
- shape: { shape: rect|round|ellipse|triangle|diamond|star|arrow|line|chevron|hexagon, fill, stroke, strokeWidth, radius, html, style } (shapes can hold text)
- image / video: { src (URL), fit: cover|contain|fill, radius }
- table: { rows: [[cellHtml, …], …], header (bool, first row styled), headerFill, stripe (bool), border, cellFill: {"r,c": colour}, colW: [fractions], style }
- anim: { anim: { name, code, params } } — an animated canvas element. Create/replace these with write_animation.
Available fonts: Inter, Inter Tight, Space Grotesk, Manrope, DM Sans, Sora, Outfit, Plus Jakarta Sans, Fraunces, Playfair Display, DM Serif Display, Instrument Serif, Libre Baskerville, JetBrains Mono, IBM Plex Mono, Caveat.

# Design taste
Modern, minimal, confident. Strong type hierarchy (titles ~72–140px, body 36–48px, captions 24–28px), generous margins (≥120px), left-aligned text unless it's a statement slide, at most two fonts, restrained colour with one accent. Text must stay readable over animation: keep motion behind text calm/low-contrast, use bg.dim, or place the energetic part away from the text. Prefer theme tokens so theme changes carry through.

# Animation contract (write_animation)
Your code runs in a Web Worker on an OffscreenCanvas (off the main thread). There is no DOM, no network, no imports. Define a function named setup; it is called once and returns an object with frame(t, dt) and optionally resize(width, height, dpr):

function setup(env) {
  // env.canvas   OffscreenCanvas, already sized to width*dpr × height*dpr. Get '2d' or 'webgl2' context yourself.
  // env.width, env.height  CSS-pixel size of the element/background; env.dpr  device-pixel ratio being used
  // env.unit     width / 1920 — multiply pixel sizes by it so the design scales from thumbnails to 4K
  // env.params   live parameter VALUES keyed by name (read them every frame; the user tweaks them live)
  // env.theme    { bg, text, muted, accent, accent2 } hex colours of the deck theme
  // env.mouse    { x, y, active } pointer position in CSS px (active=false when the pointer is elsewhere)
  // env.lib      helpers (below)
  return {
    resize(w, h, dpr) { /* canvas was just resized (context state reset): re-apply ctx.setTransform(dpr,0,0,dpr,0,0), rebuild size-dependent buffers */ },
    frame(t, dt) { /* t = seconds since start, dt = seconds since last frame (capped at 0.1). Draw one frame. */ },
  };
}

env.lib: TAU, clamp, lerp/mix, smoothstep(a,b,x), fract, hash(x,y), rand(seed) → seeded PRNG fn, noise2(x,y), noise3(x,y,z) (simplex, −1..1), fbm2(x,y,octaves), rgb(hex) → [r,g,b], rgba(hex,a) → css, hsl(h,s,l,a) → css, palette(t,a,b,c,d) (cosine palette → [r,g,b]), fibonacciSphere(n) → Float32Array xyz, and
shader(env, fragSource, { scale }) → { frame(t), resize(w,h,dpr), set(name, value), gl } — a Shadertoy-style full-screen fragment shader (WebGL2, GLSL ES 3.00). Write \`void mainImage(out vec4 fragColor, in vec2 fragCoord)\`. Predeclared uniforms: iTime, iResolution (vec3, device px), iMouse (vec4: xy device px, z = active), iUnit, uBg, uText, uAccent, uAccent2 (vec3 0..1), plus one uniform per param: number → \`uniform float u_<name>\`, colour → \`uniform vec3 u_<name>\` (0..1), boolean → \`uniform bool u_<name>\`. Do not redeclare them. Output premultiplied alpha (use alpha 1.0 for opaque backgrounds). \`scale\` < 1 renders at lower resolution (0.5–0.75 for soft/blurry fields is visually identical and much cheaper). You can simply \`return env.lib.shader(env, FRAG, {scale: 0.75})\` from setup.

params (tool input) define user-facing controls, e.g.
{ "speed": {"type":"range","value":1,"min":0,"max":3,"step":0.01}, "glow": {"type":"range","value":0.6,"min":0,"max":1}, "tint": {"type":"color","value":"#7c9cff"}, "grain": {"type":"toggle","value":true} }
Expose 3–6 meaningful knobs (speed, density, colours, intensity, size…). Colour param values are hex strings in env.params.

## Performance rules (these matter — this replaces video and must stay smooth at 60fps on a laptop at 4K)
- Full-screen fields (gradients, aurora, plasma, noise, liquid, glow, light rays, grain) → fragment shader via lib.shader. Keep loops small (≤ ~5 fbm octaves, ≤ ~64 iterations), use scale 0.5–0.75 when the look is soft.
- Particles, dots, lines, networks, orbits → Canvas 2D (or WebGL points for >10k). Preallocate typed arrays in setup/resize; never allocate objects/arrays per particle per frame. Batch drawing: bucket by colour/alpha and draw each bucket as one path (moveTo+arc / lineTo …) then a single fill()/stroke(); avoid changing fillStyle per dot.
- Avoid per-frame shadowBlur, ctx.filter, getImageData/putImageData, and huge radial gradients recreated every frame (create once in resize).
- Budgets for Canvas 2D: ≲ 5,000 dots or ≲ 3,000 line segments per frame. O(n²) neighbour checks only for ≲ 150 nodes.
- Motion must be time-based (t, dt) so it is frame-rate independent. Ease with 1 - Math.pow(k, dt).
- Element animations: clear to transparent each frame (ctx.clearRect) so they composite over the slide. Background animations may paint opaque (use env.theme.bg as base).
- Always implement resize; scale strokes, radii and spacing by env.unit (or by min(width, height)).

## Quality bar
Aim for the craft of a top motion designer: depth (size/alpha falloff with distance), layered motion at different speeds, easing, subtle noise so nothing looks mechanical, restrained palettes that match the theme, gentle mouse response where it adds delight. Film grain (tiny hash noise) prevents banding on dark gradients.

## Example: Canvas 2D particle orb (element)
${orb.code}

## Example: shader background
${aurora.code}
`;

const colour = { type: 'string', description: 'Theme token (text|muted|bg|accent|accent2), hex, rgba(), or (fills only) a CSS gradient.' };

const elementSchema = {
  type: 'object',
  description: 'A slide element. Omit id when adding (it is assigned and returned). See the deck model in the system prompt for type-specific fields.',
  properties: {
    id: { type: 'string' },
    type: { type: 'string', enum: ['text', 'shape', 'image', 'video', 'table'] },
    x: { type: 'number' }, y: { type: 'number' }, w: { type: 'number' }, h: { type: 'number' },
    rot: { type: 'number' }, opacity: { type: 'number' }, shadow: { type: 'boolean' },
    html: { type: 'string' },
    style: { type: 'object', description: 'Text style: font, fontSize, color, align, valign, lineHeight, fontWeight, letterSpacing, italic, underline' },
    shape: { type: 'string' }, fill: colour, stroke: colour, strokeWidth: { type: 'number' }, radius: { type: 'number' },
    src: { type: 'string' }, fit: { type: 'string' },
    rows: { type: 'array', items: { type: 'array', items: { type: 'string' } } },
    header: { type: 'boolean' }, headerFill: colour, stripe: { type: 'boolean' }, border: colour, colW: { type: 'array', items: { type: 'number' } },
    cellFill: { type: 'object' },
    enter: { type: ['object', 'null'], properties: { effect: { type: 'string' }, delay: { type: 'number' } } },
  },
};

const bgSchema = {
  type: 'object',
  description: 'Background changes (animations are set with write_animation). Use null to clear a field.',
  properties: { fill: { type: ['string', 'null'] }, image: { type: ['string', 'null'] }, dim: { type: 'number' } },
};

export const TOOLS = [
  {
    name: 'write_animation',
    description: 'Create or replace a code-driven animation, either as a slide background or as an animated element. The code runs immediately on the slide; the result returns fps, any runtime/compile error (with line number), and a screenshot of it running so you can check and refine it. To iterate on an existing animation, call again with the same target (background) or element_id.',
    eager_input_streaming: true,
    input_schema: {
      type: 'object',
      properties: {
        slide: { type: 'integer', description: '0-based slide index. Defaults to the current slide.' },
        target: { type: 'string', enum: ['background', 'element'] },
        element_id: { type: 'string', description: 'For target=element: id of an existing anim element to replace. Omit to create a new element.' },
        box: { type: 'object', description: 'For a new element: {x, y, w, h} in slide px.', properties: { x: { type: 'number' }, y: { type: 'number' }, w: { type: 'number' }, h: { type: 'number' } } },
        name: { type: 'string', description: 'Short human name, e.g. "Aurora ribbons".' },
        params: { type: 'object', description: 'User-tweakable parameter definitions: {name: {type: "range"|"color"|"toggle", value, min, max, step, label?}}' },
        code: { type: 'string', description: 'JavaScript defining function setup(env) { … return { frame(t, dt) {}, resize(w, h, dpr) {} } }' },
      },
      required: ['target', 'name', 'code'],
    },
  },
  {
    name: 'update_slide',
    description: 'Edit one slide: change background fill/image/dim, add, update (partial fields merge; style merges) or remove elements, reorder z-order, set notes or transition. Returns the ids of added elements.',
    eager_input_streaming: true,
    input_schema: {
      type: 'object',
      properties: {
        slide: { type: 'integer', description: '0-based slide index. Defaults to the current slide.' },
        background: bgSchema,
        add: { type: 'array', items: elementSchema },
        update: { type: 'array', items: { ...elementSchema, required: ['id'] } },
        remove: { type: 'array', items: { type: 'string' }, description: 'Element ids to delete' },
        order: { type: 'array', items: { type: 'string' }, description: 'Optional full list of element ids back-to-front' },
        notes: { type: 'string' },
        transition: { type: 'string', enum: ['none', 'fade', 'slide', 'zoom', 'blur'] },
      },
    },
  },
  {
    name: 'add_slides',
    description: 'Insert new slides. Each slide may include background (fill/image/dim), elements, notes and transition. New slides copy the background (including animation) of the slide at `after` unless copy_background is false. Returns the new indices.',
    eager_input_streaming: true,
    input_schema: {
      type: 'object',
      properties: {
        after: { type: 'integer', description: 'Insert after this 0-based index; -1 inserts at the start. Defaults to after the current slide.' },
        copy_background: { type: 'boolean' },
        slides: {
          type: 'array',
          items: {
            type: 'object',
            properties: { background: bgSchema, elements: { type: 'array', items: elementSchema }, notes: { type: 'string' }, transition: { type: 'string' } },
          },
        },
      },
      required: ['slides'],
    },
  },
  {
    name: 'manage_slides',
    description: 'Delete, duplicate or move slides, or navigate to a slide.',
    input_schema: {
      type: 'object',
      properties: {
        action: { type: 'string', enum: ['delete', 'duplicate', 'move', 'go'] },
        indices: { type: 'array', items: { type: 'integer' }, description: '0-based slide indices' },
        to: { type: 'integer', description: 'For move: destination index' },
      },
      required: ['action', 'indices'],
    },
  },
  {
    name: 'get_slides',
    description: 'Return the full JSON (including animation code) of specific slides. The context block only includes full detail for the current slide.',
    input_schema: {
      type: 'object',
      properties: { indices: { type: 'array', items: { type: 'integer' } } },
      required: ['indices'],
    },
  },
  {
    name: 'set_theme',
    description: 'Update the deck theme (fonts and colours). Elements using theme tokens update automatically.',
    input_schema: {
      type: 'object',
      properties: {
        heading: { type: 'string' }, body: { type: 'string' },
        bg: { type: 'string' }, text: { type: 'string' }, muted: { type: 'string' }, accent: { type: 'string' }, accent2: { type: 'string' },
        title: { type: 'string', description: 'Rename the deck' },
      },
    },
  },
];

// Ollama Cloud models with tool calling. Ollama retires models without notice, so any tag typed in
// Settings also works; unknown tags are assumed to support tools and vision.
export const MODELS = [
  { id: 'kimi-k3', label: 'Kimi K3', vision: true, thinking: true },
  { id: 'kimi-k2.7-code', label: 'Kimi K2.7 Code', vision: true, thinking: true },
  { id: 'minimax-m3', label: 'MiniMax M3', vision: true, thinking: true },
  { id: 'gemma4:31b', label: 'Gemma 4 31B', vision: true, thinking: true },
  { id: 'mistral-large-3:675b', label: 'Mistral Large 3', vision: true, thinking: false },
  { id: 'glm-5.3', label: 'GLM 5.3', vision: false, thinking: true },
  { id: 'deepseek-v4-pro:0813', label: 'DeepSeek V4 Pro', vision: false, thinking: true },
  { id: 'gpt-oss:120b', label: 'gpt-oss 120B', vision: false, thinking: true },
];

export function modelInfo(id) {
  return MODELS.find((m) => m.id === id) || { id: id || MODELS[0].id, label: id || MODELS[0].label, vision: true, thinking: true };
}
