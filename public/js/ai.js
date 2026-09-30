// Right pane: the assistant. Streams an Ollama Cloud model (through the Worker, which holds the key),
// runs deck-editing tools locally, and feeds animation screenshots + fps/errors back so the model can
// see and refine what it wrote.
import { store } from './store.js';
import { db } from './db.js';
import { settings, saveSettings, server } from './settings.js';
import { SYSTEM, TOOLS, modelsFor, modelInfo, activeModel } from './prompt.js';
import { sanitizeHTML } from './sanitize.js';
import { newElement, newSlide, FONTS, SHAPES, color as themeColor } from './model.js';
import { h, clone, uid, esc, readAsDataURL, toast } from './util.js';
import { icon } from './icons.js';
import { paramValues } from './anim/host.js';
import { openSettings } from './settingsModal.js';
import { pickFile } from './toolbar.js';

const CHAT_VERSION = 2; // Ollama message format (+ gemini_parts on assistant turns when using Gemini)
const OLLAMA_TOOLS = TOOLS.map((t) => ({ type: 'function', function: { name: t.name, description: t.description, parameters: t.input_schema } }));

const SUGGESTIONS = [
  'Create a slow, premium aurora background that matches this deck’s theme',
  'Add an animated particle orb on the right side of this slide, like a glowing globe made of dots',
  'Make a 5-slide deck about why code beats video for motion, with one consistent animated background',
  'Tidy up this slide: better hierarchy, spacing and alignment',
];

class ApiError extends Error {
  constructor(status, message) { super(message); this.status = status; }
}

export class Assistant {
  constructor(root, editor) {
    this.root = root;
    this.ed = editor;
    this.history = [];
    this.attachments = [];
    this.busy = false;
    this.build();
    store.on('deck', () => this.loadChat());
    store.on('focus-ai', (prefill) => this.focus(prefill));
    store.on('selection', () => this.renderCtx());
    store.on('slide', () => this.renderCtx());
    store.on('settings', () => this.updateNote());
  }

  // ---------- UI ----------
  build() {
    this.orb = h('span', { class: 'ai-orb' });
    const modelSel = h('select', { class: 'tb-select', title: 'Model', style: { fontSize: '11.5px', color: 'var(--text-2)', maxWidth: '150px' } });
    modelSel.onchange = () => saveSettings({ model: modelSel.value });
    this.modelSel = modelSel;
    const head = h('div', { class: 'ai-head' },
      h('h3', null, this.orb, 'Assistant'),
      modelSel,
      h('button', { class: 'btn ghost icon-only', title: 'New chat', html: icon('refresh'), onclick: () => this.newChat() }),
      h('button', { class: 'btn ghost icon-only', title: 'AI settings', html: icon('settings'), onclick: () => openSettings() }),
    );
    this.log = h('div', { class: 'ai-log' });
    this.ctxRow = h('div', { class: 'ai-ctx' });
    this.ta = h('textarea', { rows: 1, placeholder: 'Describe a slide, a layout, or an animation…' });
    this.ta.addEventListener('input', () => this.autosize());
    this.ta.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) { e.preventDefault(); this.submit(); }
      e.stopPropagation();
    });
    this.ta.addEventListener('paste', (e) => {
      const files = [...(e.clipboardData?.files || [])].filter((f) => f.type.startsWith('image/'));
      if (files.length) { e.preventDefault(); files.forEach((f) => this.attach(f)); }
    });
    this.sendBtn = h('button', { class: 'ai-send', title: 'Send (Enter)', html: icon('send', 16), onclick: () => (this.busy ? this.stop() : this.submit()) });
    const attachBtn = h('button', { class: 'tb', title: 'Attach reference image', html: icon('clip'), onclick: () => pickFile('image/*', (f) => this.attach(f)) });
    this.box = h('div', { class: 'ai-box' }, this.ta, h('div', { class: 'ai-box-row' }, attachBtn, this.sendBtn));
    this.box.addEventListener('dragover', (e) => { if ([...e.dataTransfer.types].includes('Files')) { e.preventDefault(); this.box.classList.add('drop'); } });
    this.box.addEventListener('dragleave', () => this.box.classList.remove('drop'));
    this.box.addEventListener('drop', (e) => {
      e.preventDefault(); this.box.classList.remove('drop');
      [...e.dataTransfer.files].filter((f) => f.type.startsWith('image/')).forEach((f) => this.attach(f));
    });
    this.note = h('div', { class: 'ai-note' });
    this.root.append(head, this.log, h('div', { class: 'ai-input' }, this.ctxRow, this.box, this.note));
    this.renderEmpty();
    this.updateNote();
  }

  updateNote() {
    const provider = server.provider || 'ollama';
    const current = activeModel(settings, server);
    const opts = [...modelsFor(provider)];
    if (!opts.some((m) => m.id === current)) opts.push({ id: current, label: current });
    this.modelSel.replaceChildren(...opts.map((m) => h('option', { value: m.id, selected: m.id === current }, m.label)));
    const m = modelInfo(current, provider);
    const name = provider === 'gemini' ? 'Gemini' : 'Ollama';
    this.note.textContent = !server.ai
      ? (server.checked ? `The server has no ${provider === 'gemini' ? 'GEMINI_API_KEY' : 'OLLAMA_API_KEY or OLLAMA_URL'} yet — run \`npm run setup\`.` : '')
      : server.auth && !settings.accessToken ? 'Add the access token in settings to start.'
      : m.vision ? `${name} · ${m.label}` : `${name} · ${m.label} (no vision: it can’t see screenshots or images)`;
  }

  autosize() { this.ta.style.height = 'auto'; this.ta.style.height = Math.min(200, this.ta.scrollHeight) + 'px'; }

  focus(prefill) {
    store.emit('show-ai');
    if (typeof prefill === 'string') { this.ta.value = prefill; this.autosize(); }
    this.ta.focus();
    this.ta.setSelectionRange(this.ta.value.length, this.ta.value.length);
  }

  renderCtx() {
    const chips = [];
    if (store.deck) {
      chips.push(h('span', { class: 'chip' }, `Slide ${store.index + 1}`));
      const n = store.selection.length;
      if (n) chips.push(h('span', { class: 'chip' }, n === 1 ? `${store.selected[0]?.type} selected` : `${n} selected`));
    }
    this.attachments.forEach((a, i) => chips.push(h('span', { class: 'chip' }, h('img', { src: a.url, alt: '' }), 'Image',
      h('button', { html: icon('x', 12), title: 'Remove', onclick: () => { this.attachments.splice(i, 1); this.renderCtx(); } }))));
    this.ctxRow.replaceChildren(...chips);
  }

  renderEmpty() {
    if (this.history.length) return;
    this.log.replaceChildren(h('div', { class: 'ai-empty' },
      h('h4', null, 'What should we make?'),
      h('p', null, 'Describe it, or paste a screenshot of a look you like. I write the animation code, run it on your slide, check the result and refine it.'),
      h('div', { class: 'ai-sugg' }, SUGGESTIONS.map((s) => h('button', { onclick: () => { this.ta.value = s; this.autosize(); this.ta.focus(); } }, s))),
    ));
  }

  async attach(file) {
    if (this.attachments.length >= 6) return toast('Up to 6 images per message');
    const bmp = await createImageBitmap(file);
    const s = Math.min(1, 1568 / Math.max(bmp.width, bmp.height));
    const c = new OffscreenCanvas(Math.round(bmp.width * s), Math.round(bmp.height * s));
    c.getContext('2d').drawImage(bmp, 0, 0, c.width, c.height);
    bmp.close();
    const blob = await c.convertToBlob({ type: 'image/jpeg', quality: 0.9 });
    const url = await readAsDataURL(blob);
    this.attachments.push({ data: url.split(',')[1], url });
    this.renderCtx();
  }

  scroll() { this.log.scrollTop = this.log.scrollHeight; }
  nearBottom() { return this.log.scrollHeight - this.log.scrollTop - this.log.clientHeight < 80; }

  setBusy(b) {
    this.busy = b;
    this.orb.classList.toggle('busy', b);
    this.sendBtn.innerHTML = icon(b ? 'stop' : 'send', 16);
    this.sendBtn.title = b ? 'Stop' : 'Send (Enter)';
  }

  // ---------- persistence ----------
  // History is stored in Ollama's message format. Fields starting with "_" are UI-only and stripped before sending.
  async loadChat() {
    this.stop();
    this.deckId = store.deck.id;
    const saved = await db.get('chats', this.deckId);
    this.history = saved?.v === CHAT_VERSION ? saved.history : [];
    this.log.replaceChildren();
    if (!this.history.length) this.renderEmpty();
    else this.renderHistory();
    this.renderCtx();
    this.updateNote();
  }
  saveChat() { if (this.deckId) db.put('chats', this.deckId, { v: CHAT_VERSION, history: this.history, updated: Date.now() }).catch((e) => console.warn('chat not saved', e)); }
  newChat() {
    this.stop();
    this.history = [];
    this.saveChat();
    this.log.replaceChildren();
    this.renderEmpty();
  }

  renderHistory() {
    for (let i = 0; i < this.history.length; i++) {
      const m = this.history[i];
      if (m.role === 'user' && !m._auto) {
        this.userBubble(m._text ?? m.content, (m.images || []).map((b) => 'data:image/jpeg;base64,' + b));
      } else if (m.role === 'assistant') {
        if (m.content?.trim()) this.log.append(h('div', { class: 'msg assistant', html: md(m.content) }));
        (m.tool_calls || []).forEach((tc, j) => {
          const card = this.toolCard(tc.function.name, tc.function.arguments || {});
          // Tool results follow the assistant message in call order.
          const r = this.history[i + 1 + j];
          if (r?.role === 'tool') card.done(r._ok, r._summary, r._image);
          else card.done(false, 'interrupted');
        });
      }
    }
    this.scroll();
  }

  userBubble(text, imgs = []) {
    const b = h('div', { class: 'msg user' });
    if (imgs.length) b.append(h('div', { class: 'att' }, imgs.map((src) => h('img', { src, alt: '' }))));
    if (text) b.append(document.createTextNode(text));
    this.log.append(b);
  }

  toolCard(name, input = {}) {
    const titleOf = (inp = {}) => ({
      write_animation: () => `${inp.target === 'element' ? 'Animation' : inp.target === 'background' ? 'Background' : 'Animation'} · ${inp.name || '…'}`,
      update_slide: () => `Edit slide${inp.slide != null ? ' ' + (inp.slide + 1) : ''}`,
      add_slides: () => `Add ${inp.slides?.length || ''} slide${inp.slides?.length === 1 ? '' : 's'}`.replace('  ', ' '),
      manage_slides: () => `${cap(inp.action || 'Manage')} slides`,
      get_slides: () => 'Read slides',
      set_theme: () => 'Update theme',
    }[name] || (() => name))();
    const title = h('span', { class: 'tc-title' }, titleOf(input));
    const state = h('span', { class: 'tc-state' }, h('span', { class: 'spinner' }));
    const pre = h('pre', null, name === 'write_animation' ? input.code || '' : JSON.stringify(input, null, 2).slice(0, 4000));
    const body = h('div', { class: 'tc-body', hidden: true }, pre);
    const head = h('div', { class: 'tc-head', html: icon(name === 'write_animation' ? 'sparkles' : name === 'set_theme' ? 'palette' : 'file', 14) }, title, state);
    head.onclick = () => { body.hidden = !body.hidden; };
    const card = h('div', { class: 'tool-card' }, head, body);
    this.log.append(card);
    return {
      el: card,
      done: (ok, summary, img) => {
        state.className = 'tc-state ' + (ok ? 'ok' : 'err');
        state.innerHTML = icon(ok ? 'check' : 'alert', 13) + `<span>${esc(summary || (ok ? 'Done' : 'Failed'))}</span>`;
        if (img) { card.querySelector('img.shot')?.remove(); card.append(h('img', { class: 'shot', src: img, alt: 'Rendered animation' })); }
      },
    };
  }

  // ---------- conversation ----------
  submit() {
    const text = this.ta.value.trim();
    if (!text && !this.attachments.length) return;
    if (this.busy) return;
    if (server.auth && !settings.accessToken) { openSettings(() => this.updateNote()); return; }
    if (!this.history.length) this.log.replaceChildren();
    const said = text || 'See the attached image(s).';
    this.userBubble(text, this.attachments.map((a) => a.url));
    const msg = { role: 'user', content: deckContext() + '\n\n' + said, _text: text };
    if (this.attachments.length) msg.images = this.attachments.map((a) => a.data);
    this.history.push(msg);
    this.ta.value = '';
    this.autosize();
    this.attachments = [];
    this.renderCtx();
    this.scroll();
    this.saveChat();
    this.run();
  }

  stop() {
    this.abort?.abort();
    this.abort = null;
  }

  // Messages as Ollama expects them: UI-only fields removed, images dropped for text-only models.
  wireMessages(vision) {
    const out = [{ role: 'system', content: SYSTEM }];
    for (const m of this.history) {
      const w = { role: m.role, content: m.content || '' };
      if (m.images?.length) {
        if (vision) w.images = m.images;
        else w.content += `\n\n[${m.images.length} image(s) attached, but this model cannot see images.]`;
      }
      if (m.tool_calls) w.tool_calls = m.tool_calls;
      if (m.tool_name) w.tool_name = m.tool_name;
      if (m.thinking) w.thinking = m.thinking;
      if (m.gemini_parts) w.gemini_parts = m.gemini_parts;
      out.push(w);
    }
    return out;
  }

  async run() {
    this.setBusy(true);
    const abort = (this.abort = new AbortController());
    try {
      for (let turn = 0; turn < 24; turn++) {
        if (abort.signal.aborted) break;
        const provider = server.provider || 'ollama';
        const model = modelInfo(activeModel(settings, server), provider);
        const body = { model: model.id, messages: this.wireMessages(model.vision), tools: OLLAMA_TOOLS, stream: true };
        const effort = settings.effort || 'high';
        if (provider === 'gemini' || model.id.startsWith('gpt-oss')) body.think = effort;
        else if (model.thinking) body.think = effort !== 'low';

        const ui = this.streamUI();
        let msg;
        try {
          msg = await this.chat(body, abort.signal, ui);
        } catch (err) {
          ui.abandon();
          if (abort.signal.aborted) break;
          throw err;
        }
        ui.finish();
        const calls = (msg.tool_calls || []).map((tc) => ({ function: { name: tc.function?.name, arguments: parseArgs(tc.function?.arguments) } }));
        const entry = { role: 'assistant', content: msg.content || '' };
        if (msg.thinking) entry.thinking = msg.thinking;
        if (calls.length) entry.tool_calls = calls;
        if (msg.gemini_parts?.length) entry.gemini_parts = msg.gemini_parts; // replayed verbatim (thought signatures)
        this.history.push(entry);
        this.saveChat();
        if (!calls.length) {
          if (!msg.content?.trim()) this.errorMsg(`${model.label} returned an empty reply${msg.done_reason ? ` (${msg.done_reason})` : ''}.`);
          break;
        }

        const shots = [];
        for (const tc of calls) {
          const { name, arguments: args } = tc.function;
          const card = this.toolCard(name, args || {});
          if (this.nearBottom()) this.scroll();
          let res;
          if (abort.signal.aborted) res = { error: 'Stopped by the user.' };
          else if (!args || typeof args !== 'object') res = { error: 'Tool arguments were not valid JSON. Call the tool again with a JSON object.' };
          else {
            try { res = await this.execTool(name, args); } catch (e) { res = { error: String(e?.message || e) }; }
          }
          const text = res.error ? 'ERROR: ' + res.error : typeof res.content === 'string' ? res.content : res.content.filter((b) => b.type === 'text').map((b) => b.text).join('\n');
          const summary = res.summary || (res.error ? shortErr(res.error) : 'Done');
          this.history.push({ role: 'tool', tool_name: name, content: text, _ok: !res.error, _summary: summary, _image: res.image || null });
          card.done(!res.error, summary, res.image);
          if (res.image) shots.push(res.image.split(',')[1]);
          if (this.nearBottom()) this.scroll();
        }
        // Tool messages are text-only, so screenshots go back as a follow-up user message.
        if (shots.length && model.vision) {
          this.history.push({ role: 'user', content: `Screenshot${shots.length > 1 ? 's' : ''} of the rendered result from the tool call${shots.length > 1 ? 's' : ''} above. Check it against the request and refine if needed.`, images: shots, _auto: true });
        }
        this.saveChat();
      }
    } catch (err) {
      this.errorMsg(describeError(err));
    } finally {
      if (this.abort === abort) this.abort = null;
      this.setBusy(false);
      this.saveChat();
    }
  }

  // POST to the Worker proxy and read Ollama's NDJSON stream. Returns the assembled assistant message.
  async chat(body, signal, ui) {
    const res = await fetch('/api/chat', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-slides-token': settings.accessToken || '' },
      body: JSON.stringify(body),
      signal,
    });
    if (!res.ok) {
      const raw = await res.text();
      let msg = raw;
      try { const j = JSON.parse(raw); msg = j.error?.message || j.error || raw; } catch {}
      throw new ApiError(res.status, String(msg).slice(0, 400));
    }
    const out = { content: '', thinking: '', tool_calls: [], done_reason: null, gemini_parts: null };
    const reader = res.body.pipeThrough(new TextDecoderStream()).getReader();
    let buf = '';
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      buf += value;
      let nl;
      while ((nl = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, nl).trim();
        buf = buf.slice(nl + 1);
        if (!line) continue;
        let chunk;
        try { chunk = JSON.parse(line); } catch { continue; }
        if (chunk.error) throw new ApiError(500, String(chunk.error));
        const m = chunk.message || {};
        if (m.thinking) { out.thinking += m.thinking; ui.thinking(out.thinking); }
        if (m.content) { out.content += m.content; ui.text(out.content); }
        if (m.tool_calls?.length) { out.tool_calls.push(...m.tool_calls); ui.tools(out.tool_calls); }
        if (m.gemini_parts) out.gemini_parts = m.gemini_parts;
        if (chunk.done) out.done_reason = chunk.done_reason;
      }
    }
    return out;
  }

  errorMsg(text) {
    this.log.append(h('div', { class: 'msg err' }, text));
    this.scroll();
  }

  // Incremental rendering of one streamed assistant message.
  streamUI() {
    const thinking = h('div', { class: 'thinking' }, 'Thinking…');
    this.log.append(thinking);
    this.scroll();
    let textEl = null, raf = 0, pending = null;
    const flush = () => {
      raf = 0;
      const stick = this.nearBottom();
      if (pending?.text != null) {
        if (!textEl) { textEl = h('div', { class: 'msg assistant' }); this.log.insertBefore(textEl, thinking); }
        textEl.innerHTML = md(pending.text);
        thinking.textContent = 'Working…';
      }
      if (pending?.thinking != null && !textEl) {
        const t = pending.thinking.trim().split('\n').filter(Boolean).pop() || '';
        thinking.textContent = t ? 'Thinking · ' + t.slice(0, 140) : 'Thinking…';
      }
      if (pending?.tools) thinking.textContent = `Running ${pending.tools.map((t) => t.function?.name).join(', ')}…`;
      pending = null;
      if (stick) this.scroll();
    };
    const mark = (k, v) => { pending = { ...(pending || {}), [k]: v }; if (!raf) raf = requestAnimationFrame(flush); };
    return {
      text: (t) => mark('text', t),
      thinking: (t) => mark('thinking', t),
      tools: (t) => mark('tools', t),
      finish: () => { cancelAnimationFrame(raf); flush(); thinking.remove(); },
      abandon: () => { cancelAnimationFrame(raf); thinking.remove(); },
    };
  }

  // ---------- tools ----------
  async execTool(name, input) {
    switch (name) {
      case 'write_animation': return this.toolWriteAnimation(input);
      case 'update_slide': return this.toolUpdateSlide(input);
      case 'add_slides': return this.toolAddSlides(input);
      case 'manage_slides': return this.toolManageSlides(input);
      case 'get_slides': return this.toolGetSlides(input);
      case 'set_theme': return this.toolSetTheme(input);
    }
    return { error: `Unknown tool ${name}` };
  }

  slideIndex(i) {
    const n = store.deck.slides.length;
    if (i == null) return store.index;
    if (!Number.isInteger(i) || i < 0 || i >= n) throw new Error(`Slide index ${i} is out of range (deck has ${n} slides, 0-based).`);
    return i;
  }

  async toolWriteAnimation(inp) {
    if (typeof inp.code !== 'string' || !inp.code.includes('setup')) return { error: 'code must be a string defining function setup(env).' };
    if (!['background', 'element'].includes(inp.target)) return { error: 'target must be "background" or "element".' };
    const idx = this.slideIndex(inp.slide);
    const params = normalizeParams(inp.params);
    const anim = { name: String(inp.name || 'Animation').slice(0, 60), code: inp.code, params };
    store.stopEditing();
    store.go(idx);
    const slide = store.slide;
    let key = 'bg';
    if (inp.target === 'background') {
      store.commit('AI: background animation', () => { slide.bg = { ...slide.bg, anim }; });
      store.select([]);
    } else {
      const existing = inp.element_id && slide.elements.find((e) => e.id === inp.element_id);
      if (existing) {
        store.commit('AI: animation', () => { existing.type = 'anim'; existing.anim = anim; });
        key = existing.id;
      } else {
        const b = inp.box || {};
        const el = newElement('anim', { anim, ...num4(b, { x: 610, y: 190, w: 700, h: 700 }) });
        store.commit('AI: animation', () => slide.elements.push(el));
        key = el.id;
      }
      store.select([key]);
    }
    await nextFrames(2);
    const res = await this.ed.inspectAnim(key, 1700);
    if (res.error) {
      const e = res.error;
      const lines = anim.code.split('\n');
      const around = e.line ? lines.slice(Math.max(0, e.line - 4), e.line + 3).map((l, i) => `${Math.max(1, e.line - 3) + i}: ${l}`).join('\n') : '';
      return { error: `Animation failed${e.phase ? ` during ${e.phase}` : ''}${e.line ? ` at line ${e.line}` : ''}: ${e.message}${around ? `\n\nCode around the error:\n${around}` : ''}\n\nThe broken animation is on the slide; fix it by calling write_animation again${key !== 'bg' ? ` with element_id "${key}"` : ''}.` };
    }
    const shot = res.blob ? await composite(res.blob, slide, key) : null;
    const fps = res.stats ? Math.round(res.stats.fps) : null;
    const ms = res.stats ? res.stats.ms.toFixed(2) : null;
    const note = [
      `Rendered OK on slide ${idx} (${key === 'bg' ? 'background' : 'element ' + key}).`,
      fps != null ? `Performance in the editor preview: ${fps} fps, ${ms} ms/frame of script time (keep script time under ~4 ms; GPU cost of shaders isn't included).` : 'Performance: no stats yet.',
      `Params exposed to the user: ${Object.keys(params).join(', ') || 'none'}.`,
      shot ? 'Screenshot (approximate composite: slide background + your animation + rough outlines/text of other elements):' : 'No screenshot available.',
    ].join('\n');
    const content = [{ type: 'text', text: note }];
    if (shot) content.push({ type: 'image', source: { type: 'base64', media_type: 'image/jpeg', data: shot.split(',')[1] } });
    return { content, summary: fps != null ? `${fps} fps` : 'Running', image: shot };
  }

  async toolUpdateSlide(inp) {
    const idx = this.slideIndex(inp.slide);
    const s = store.deck.slides[idx];
    const warnings = [], added = [];
    store.stopEditing();
    store.commit('AI: edit slide', () => {
      if (inp.background && typeof inp.background === 'object') s.bg = { ...s.bg, ...bgPatch(inp.background) };
      if (Array.isArray(inp.remove)) {
        const rm = new Set(inp.remove);
        s.elements = s.elements.filter((e) => !rm.has(e.id));
      }
      for (const u of Array.isArray(inp.update) ? inp.update : []) {
        const e = s.elements.find((x) => x.id === u.id);
        if (!e) { warnings.push(`No element with id ${u.id}`); continue; }
        const patch = cleanElementProps(u, e.type, warnings);
        if (patch.style) patch.style = { ...e.style, ...patch.style };
        Object.assign(e, patch);
      }
      for (const a of Array.isArray(inp.add) ? inp.add : []) {
        const el = makeElement(a, warnings);
        if (el) { s.elements.push(el); added.push(el.id); }
      }
      if (Array.isArray(inp.order)) {
        const pos = new Map(inp.order.map((id, i) => [id, i]));
        s.elements.sort((a, b) => (pos.get(a.id) ?? 1e9) - (pos.get(b.id) ?? 1e9));
      }
      if (typeof inp.notes === 'string') s.notes = inp.notes;
      if (typeof inp.transition === 'string') s.transition = inp.transition;
    });
    store.go(idx);
    const out = { ok: true, slide: idx, added_ids: added, warnings };
    return { content: JSON.stringify(out), summary: added.length ? `+${added.length} element${added.length > 1 ? 's' : ''}` : 'Updated' };
  }

  async toolAddSlides(inp) {
    if (!Array.isArray(inp.slides) || !inp.slides.length) return { error: 'slides must be a non-empty array' };
    const after = inp.after == null ? store.index : inp.after === -1 ? -1 : this.slideIndex(inp.after);
    const src = store.deck.slides[Math.max(0, after)];
    const warnings = [];
    const made = inp.slides.map((spec) => {
      const s = newSlide('blank', store.deck.theme);
      if (inp.copy_background !== false && src?.bg) s.bg = clone(src.bg);
      if (spec.background) s.bg = { ...s.bg, ...bgPatch(spec.background) };
      for (const a of Array.isArray(spec.elements) ? spec.elements : []) { const el = makeElement(a, warnings); if (el) s.elements.push(el); }
      if (typeof spec.notes === 'string') s.notes = spec.notes;
      if (typeof spec.transition === 'string') s.transition = spec.transition;
      return s;
    });
    store.stopEditing();
    store.commit('AI: add slides', (d) => d.slides.splice(after + 1, 0, ...made));
    store.go(after + 1);
    const indices = made.map((_, i) => after + 1 + i);
    return {
      content: JSON.stringify({ ok: true, indices, element_ids: made.map((s) => s.elements.map((e) => e.id)), warnings }),
      summary: `${made.length} slide${made.length > 1 ? 's' : ''}`,
    };
  }

  async toolManageSlides(inp) {
    const idx = (inp.indices || []).map((i) => this.slideIndex(i));
    if (!idx.length) return { error: 'indices is empty' };
    store.stopEditing();
    const slides = store.deck.slides;
    if (inp.action === 'go') { store.go(idx[0]); return { content: `Now showing slide ${idx[0]}.`, summary: `Slide ${idx[0] + 1}` }; }
    if (inp.action === 'delete') {
      if (idx.length >= slides.length) return { error: 'Cannot delete every slide.' };
      const ids = new Set(idx.map((i) => slides[i].id));
      store.commit('AI: delete slides', (d) => { d.slides = d.slides.filter((s) => !ids.has(s.id)); });
      store.index = Math.min(store.index, store.deck.slides.length - 1);
      store.emit('slide');
      return { content: `Deleted ${idx.length} slide(s). Deck now has ${store.deck.slides.length} slides.`, summary: 'Deleted' };
    }
    if (inp.action === 'duplicate') {
      const copies = idx.map((i) => { const c = clone(slides[i]); c.id = uid('s'); c.elements.forEach((e) => { e.id = uid('e'); }); return c; });
      const at = Math.max(...idx) + 1;
      store.commit('AI: duplicate slides', (d) => d.slides.splice(at, 0, ...copies));
      store.go(at);
      return { content: `Duplicated to indices ${copies.map((_, i) => at + i).join(', ')}.`, summary: 'Duplicated' };
    }
    if (inp.action === 'move') {
      const to = Math.max(0, Math.min(inp.to ?? 0, slides.length - 1));
      const from = idx[0];
      store.commit('AI: move slide', (d) => { const [s] = d.slides.splice(from, 1); d.slides.splice(to, 0, s); });
      store.go(to);
      return { content: `Moved slide ${from} to ${to}.`, summary: 'Moved' };
    }
    return { error: `Unknown action ${inp.action}` };
  }

  async toolGetSlides(inp) {
    const out = (inp.indices || []).map((i) => ({ index: i, ...slideJSON(store.deck.slides[this.slideIndex(i)], true) }));
    return { content: JSON.stringify(out), summary: `${out.length} slide${out.length > 1 ? 's' : ''}` };
  }

  async toolSetTheme(inp) {
    const d = store.deck;
    const warnings = [];
    const patch = {};
    for (const k of ['heading', 'body']) if (typeof inp[k] === 'string') { if (FONTS.includes(inp[k])) patch[k] = inp[k]; else warnings.push(`Font ${inp[k]} is not available`); }
    for (const k of ['bg', 'text', 'muted', 'accent', 'accent2']) if (typeof inp[k] === 'string') patch[k] = inp[k];
    store.commit('AI: theme', () => {
      d.theme = { ...d.theme, ...patch };
      if (typeof inp.title === 'string' && inp.title.trim()) d.title = inp.title.trim().slice(0, 120);
    });
    store.emit('deck-title');
    return { content: JSON.stringify({ ok: true, theme: d.theme, warnings }), summary: 'Theme updated' };
  }
}

// ---------- context & helpers ----------
function textOf(html) {
  const d = document.createElement('div');
  d.innerHTML = (html || '').replace(/<\/(p|li|div|h\d)>/g, '$& ').replace(/<br\s*\/?>/g, ' ');
  return d.textContent.replace(/\s+/g, ' ').trim();
}

function slideJSON(s, withCode) {
  return JSON.parse(JSON.stringify(s, (k, v) => {
    if (k === 'poster') return undefined;
    if ((k === 'src' || k === 'image') && typeof v === 'string' && (v.startsWith('data:') || v.startsWith('local:'))) return '[local media]';
    if (k === 'code' && !withCode) return `[${v.length} chars — use get_slides to read]`;
    return v;
  }));
}

function summarizeSlide(s, i) {
  const bg = s.bg || {};
  const bgs = [bg.fill && `fill ${bg.fill.length > 40 ? 'gradient' : bg.fill}`, bg.image && 'image', bg.anim && `animation "${bg.anim.name}"`, bg.dim && `dim ${bg.dim}`].filter(Boolean).join(', ') || 'theme bg';
  const els = s.elements.map((e) => {
    const pos = `@${Math.round(e.x)},${Math.round(e.y)} ${Math.round(e.w)}×${Math.round(e.h)}`;
    if (e.type === 'text' || (e.type === 'shape' && e.html && textOf(e.html))) return `${e.type}#${e.id} "${textOf(e.html).slice(0, 70)}" ${pos}`;
    if (e.type === 'anim') return `anim#${e.id} "${e.anim?.name}" ${pos}`;
    if (e.type === 'table') return `table#${e.id} ${e.rows.length}×${e.rows[0]?.length} ${pos}`;
    return `${e.type}#${e.id}${e.shape ? ' ' + e.shape : ''} ${pos}`;
  });
  return `[${i}] bg: ${bgs}${els.length ? '\n    ' + els.join('\n    ') : ' (empty)'}${s.notes ? `\n    notes: "${s.notes.slice(0, 80)}"` : ''}`;
}

const WEBGL2 = (() => { try { return !!new OffscreenCanvas(4, 4).getContext('webgl2'); } catch { return false; } })();

function deckContext() {
  const d = store.deck;
  const cur = store.slide;
  return [
    '<deck_context>',
    `Deck "${d.title}" · ${d.slides.length} slides · current slide index ${store.index} (0-based)`,
    `Theme: ${JSON.stringify(d.theme)}`,
    `Renderer: WebGL2 ${WEBGL2 ? 'available' : 'NOT available in this browser — use Canvas 2D only, no lib.shader'}; OffscreenCanvas in workers.`,
    `Selected element ids: ${store.selection.length ? store.selection.join(', ') : 'none'}`,
    'Slides:',
    ...d.slides.map(summarizeSlide),
    `Current slide (index ${store.index}) full JSON:`,
    JSON.stringify(slideJSON(cur, true)),
    '</deck_context>',
  ].join('\n');
}

function normalizeParams(p) {
  const out = {};
  if (!p || typeof p !== 'object') return out;
  for (const k in p) {
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(k)) continue;
    let d = p[k];
    if (d == null || typeof d !== 'object') {
      if (typeof d === 'number') d = { type: 'range', value: d, min: 0, max: d ? Math.abs(d) * 3 : 1, step: 0.01 };
      else if (typeof d === 'boolean') d = { type: 'toggle', value: d };
      else if (typeof d === 'string' && d.startsWith('#')) d = { type: 'color', value: d };
      else continue;
    }
    const v = d.value;
    if (d.type === 'color' || (typeof v === 'string' && v.startsWith('#'))) out[k] = { type: 'color', value: String(v || '#ffffff'), label: d.label };
    else if (d.type === 'toggle' || typeof v === 'boolean') out[k] = { type: 'toggle', value: !!v, label: d.label };
    else if (d.type === 'select') out[k] = { type: 'select', value: v, options: d.options || [], label: d.label };
    else {
      const val = Number(v) || 0;
      const min = Number.isFinite(+d.min) ? +d.min : Math.min(0, val);
      const max = Number.isFinite(+d.max) ? +d.max : Math.max(1, val * 3);
      out[k] = { type: 'range', value: val, min, max, step: Number.isFinite(+d.step) ? +d.step : (max - min) / 100, label: d.label };
    }
    if (!out[k].label) delete out[k].label;
  }
  return out;
}

const TYPES = ['text', 'shape', 'image', 'video', 'table'];
const STYLE_KEYS = ['font', 'fontSize', 'color', 'align', 'valign', 'lineHeight', 'fontWeight', 'letterSpacing', 'italic', 'underline', 'padding'];

function cleanElementProps(a, type, warnings) {
  const p = {};
  for (const k of ['x', 'y', 'w', 'h', 'rot', 'opacity', 'strokeWidth', 'radius']) if (Number.isFinite(a[k])) p[k] = a[k];
  if (p.w != null) p.w = Math.max(4, p.w);
  if (p.h != null) p.h = Math.max(4, p.h);
  if (p.opacity != null) p.opacity = Math.max(0, Math.min(1, p.opacity));
  for (const k of ['shadow', 'header', 'stripe']) if (typeof a[k] === 'boolean') p[k] = a[k];
  for (const k of ['fill', 'stroke', 'headerFill', 'border', 'fit']) if (typeof a[k] === 'string' || a[k] === null) p[k] = a[k];
  if (typeof a.shape === 'string') { if (SHAPES.includes(a.shape)) p.shape = a.shape; else warnings.push(`Unknown shape ${a.shape}`); }
  if (typeof a.src === 'string' && /^(https?:|\/a\/|data:image|data:video)/.test(a.src)) p.src = a.src;
  if (typeof a.html === 'string') p.html = sanitizeHTML(a.html);
  if (a.style && typeof a.style === 'object') {
    p.style = {};
    for (const k of STYLE_KEYS) if (a.style[k] !== undefined) p.style[k] = a.style[k];
    if (p.style.font && !['heading', 'body'].includes(p.style.font) && !FONTS.includes(p.style.font)) { warnings.push(`Font ${p.style.font} unavailable; using body`); p.style.font = 'body'; }
  }
  if (Array.isArray(a.rows) && a.rows.every(Array.isArray)) {
    const cols = Math.max(...a.rows.map((r) => r.length));
    p.rows = a.rows.map((r) => Array.from({ length: cols }, (_, j) => sanitizeHTML(r[j] == null ? '' : /^\s*</.test(String(r[j])) ? String(r[j]) : `<p>${esc(String(r[j]))}</p>`)));
  }
  if (Array.isArray(a.colW)) p.colW = a.colW.map(Number).filter(Number.isFinite);
  if (a.cellFill && typeof a.cellFill === 'object') p.cellFill = { ...a.cellFill };
  if (a.enter === null) p.enter = null;
  else if (a.enter && typeof a.enter === 'object' && typeof a.enter.effect === 'string') p.enter = { effect: a.enter.effect, delay: Number(a.enter.delay) || 0 };
  return p;
}

function makeElement(a, warnings) {
  if (!a || !TYPES.includes(a.type)) { warnings.push(`Skipped element with invalid type ${a?.type}${a?.type === 'anim' ? ' (use write_animation for animations)' : ''}`); return null; }
  const p = cleanElementProps(a, a.type, warnings);
  const base = newElement(a.type, a.type === 'table' && p.rows ? { r: p.rows.length, c: p.rows[0]?.length || 1 } : {});
  const el = { ...base, ...p, id: uid('e') };
  if (p.style) el.style = { ...base.style, ...p.style };
  return el;
}

function bgPatch(b) {
  const out = {};
  if ('fill' in b) out.fill = typeof b.fill === 'string' ? b.fill : null;
  if ('image' in b) out.image = typeof b.image === 'string' && /^(https?:|\/a\/)/.test(b.image) ? b.image : null;
  if (Number.isFinite(b.dim)) out.dim = Math.max(0, Math.min(0.9, b.dim));
  return out;
}

function num4(b, d) { return { x: Number.isFinite(b.x) ? b.x : d.x, y: Number.isFinite(b.y) ? b.y : d.y, w: Number.isFinite(b.w) ? Math.max(20, b.w) : d.w, h: Number.isFinite(b.h) ? Math.max(20, b.h) : d.h }; }

// rAF is paused in background tabs, so fall back to a timer.
const nextFrames = (n) => Promise.race([
  new Promise((r) => { const step = () => (n-- <= 0 ? r() : requestAnimationFrame(step)); step(); }),
  new Promise((r) => setTimeout(r, 120)),
]);

// Rough composite of the slide for the model: background, the animation snapshot, and other elements.
async function composite(blob, slide, key) {
  const W = 960, H = 540, k = W / 1920;
  const theme = store.deck.theme;
  const c = new OffscreenCanvas(W, H);
  const ctx = c.getContext('2d');
  const fill = slide.bg?.fill && !slide.bg.fill.includes('gradient') ? themeColor(slide.bg.fill, theme, theme.bg) : theme.bg;
  ctx.fillStyle = fill; ctx.fillRect(0, 0, W, H);
  const bmp = await createImageBitmap(blob);
  const drawBgAnim = async () => {
    if (key === 'bg') ctx.drawImage(bmp, 0, 0, W, H);
    else if (slide.bg?.anim?.poster) {
      const img = await createImageBitmap(await (await fetch(slide.bg.anim.poster)).blob());
      ctx.drawImage(img, 0, 0, W, H);
    }
  };
  await drawBgAnim();
  if (slide.bg?.dim) { ctx.fillStyle = `rgba(0,0,0,${slide.bg.dim})`; ctx.fillRect(0, 0, W, H); }
  for (const e of slide.elements) {
    ctx.save();
    ctx.globalAlpha = e.opacity ?? 1;
    ctx.translate((e.x + e.w / 2) * k, (e.y + e.h / 2) * k);
    if (e.rot) ctx.rotate((e.rot * Math.PI) / 180);
    const x = (-e.w / 2) * k, y = (-e.h / 2) * k, w = e.w * k, hh = e.h * k;
    if (e.id === key) ctx.drawImage(bmp, x, y, w, hh);
    else if (e.type === 'anim' && e.anim?.poster) {
      try { ctx.drawImage(await createImageBitmap(await (await fetch(e.anim.poster)).blob()), x, y, w, hh); } catch {}
    } else if (e.type === 'shape' && e.fill && !e.fill.includes('gradient')) {
      ctx.fillStyle = themeColor(e.fill, theme, 'transparent'); ctx.fillRect(x, y, w, hh);
    } else if (e.type === 'image' || e.type === 'video' || e.type === 'table') {
      ctx.strokeStyle = 'rgba(128,128,128,.8)'; ctx.setLineDash([4, 3]); ctx.strokeRect(x, y, w, hh);
      ctx.fillStyle = 'rgba(128,128,128,.9)'; ctx.font = '12px Inter'; ctx.fillText(e.type, x + 6, y + 16);
    }
    if (e.html && (e.type === 'text' || e.type === 'shape')) {
      const st = e.style || {};
      const fs = (st.fontSize || 40) * k;
      const fam = st.font === 'heading' ? theme.heading : !st.font || st.font === 'body' ? theme.body : st.font;
      ctx.font = `${st.italic ? 'italic ' : ''}${st.fontWeight || 400} ${fs}px "${fam}", Inter, sans-serif`;
      ctx.fillStyle = themeColor(st.color, theme, theme.text);
      ctx.textBaseline = 'top';
      const lh = fs * (st.lineHeight || 1.3);
      const lines = wrap(ctx, textOf(e.html), w);
      const total = lines.length * lh;
      let ty = st.valign === 'middle' ? y + (hh - total) / 2 : st.valign === 'bottom' ? y + hh - total : y;
      for (const line of lines) {
        const lw = ctx.measureText(line).width;
        const tx = st.align === 'center' ? x + (w - lw) / 2 : st.align === 'right' ? x + w - lw : x;
        ctx.fillText(line, tx, ty);
        ty += lh;
      }
    }
    ctx.restore();
  }
  bmp.close();
  const out = await c.convertToBlob({ type: 'image/jpeg', quality: 0.85 });
  return readAsDataURL(out);
}

function wrap(ctx, text, maxW) {
  const words = text.split(' ');
  const lines = [];
  let cur = '';
  for (const w of words) {
    const t = cur ? cur + ' ' + w : w;
    if (ctx.measureText(t).width > maxW && cur) { lines.push(cur); cur = w; } else cur = t;
  }
  if (cur) lines.push(cur);
  return lines.slice(0, 30);
}

const shortErr = (s) => String(s).split('\n')[0].slice(0, 60);
const cap = (s) => s.charAt(0).toUpperCase() + s.slice(1);

function parseArgs(a) {
  if (a && typeof a === 'object') return a;
  if (typeof a === 'string') { try { return JSON.parse(a); } catch { return null; } }
  return null;
}

function describeError(err) {
  const status = err?.status;
  const msg = err?.message || String(err);
  if (status === 401) return /token/i.test(msg) ? 'Wrong access token — check Settings.' : `The provider rejected the API key: ${msg}`;
  if (status === 404) return `Model not found (it may have been retired). Pick another model. ${msg}`;
  if (status === 429) return 'Rate limit or usage cap reached. Wait a bit and try again.';
  if (status === 503) return msg;
  if (/Failed to fetch|NetworkError|Load failed/i.test(msg)) return 'Network error — could not reach the server.';
  return status ? `Error ${status}: ${msg}` : msg;
}

// Tiny markdown renderer for assistant text.
function md(src) {
  const blocks = [];
  let s = esc(src).replace(/```(\w+)?\n([\s\S]*?)(```|$)/g, (_, l, code) => { blocks.push(`<pre><code>${code}</code></pre>`); return `\u0000${blocks.length - 1}\u0000`; });
  const inline = (t) => t
    .replace(/`([^`]+)`/g, '<code>$1</code>')
    .replace(/\*\*([^*]+)\*\*/g, '<b>$1</b>')
    .replace(/(^|[^*])\*([^*\n]+)\*/g, '$1<i>$2</i>')
    .replace(/\[([^\]]+)\]\((https?:[^)\s]+)\)/g, '<a href="$2" target="_blank" rel="noopener">$1</a>');
  const out = [];
  for (const para of s.split(/\n{2,}/)) {
    const lines = para.split('\n');
    if (lines.every((l) => /^\s*[-*•] /.test(l))) out.push('<ul>' + lines.map((l) => `<li>${inline(l.replace(/^\s*[-*•] /, ''))}</li>`).join('') + '</ul>');
    else if (lines.every((l) => /^\s*\d+[.)] /.test(l))) out.push('<ol>' + lines.map((l) => `<li>${inline(l.replace(/^\s*\d+[.)] /, ''))}</li>`).join('') + '</ol>');
    else if (/^\u0000\d+\u0000$/.test(para.trim())) out.push(para.trim());
    else if (/^#{1,4} /.test(para)) out.push(`<p><b>${inline(para.replace(/^#{1,4} /, ''))}</b></p>`);
    else out.push(`<p>${inline(para).replace(/\n/g, '<br>')}</p>`);
  }
  return out.join('').replace(/\u0000(\d+)\u0000/g, (_, i) => blocks[+i]);
}

export { paramValues };
