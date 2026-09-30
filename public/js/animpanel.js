// Animation settings popover (live params) and the code editor modal.
import { store } from './store.js';
import { h, clone } from './util.js';
import { icon } from './icons.js';
import { popover, closePop, modal, paramControls } from './ui.js';
import { AnimHost } from './anim/host.js';

export class AnimPanel {
  constructor(editor) {
    this.ed = editor;
    store.on('open-anim', ({ key, anchor }) => this.open(key, anchor));
  }

  target(key) {
    const slide = store.slide;
    if (key === 'bg') return { anim: slide.bg?.anim, set: (a) => { slide.bg = { ...slide.bg, anim: a }; } };
    const el = store.el(key);
    return { anim: el?.anim, set: (a) => { el.anim = a; } };
  }

  open(key, anchor) {
    const { anim, set } = this.target(key);
    if (!anim) return;
    const host = () => this.ed.view.hosts.get(key);
    const st = this.ed.animState.get(key) || {};

    const name = h('input', { type: 'text', value: anim.name || 'Animation', style: { fontWeight: 600 } });
    name.onchange = () => store.commit('Rename animation', () => { anim.name = name.value.trim() || 'Animation'; });

    let began = false;
    const controls = paramControls(anim.params || {}, (k, v, final) => {
      if (!began) { store.beginGesture('Animation setting'); began = true; }
      anim.params[k] = { ...anim.params[k], value: v };
      host()?.setParams(anim.params);
      if (final) { store.endGesture(true); began = false; }
    });

    const status = h('div', { class: 'hint', style: { marginBottom: '10px', color: st.error ? 'var(--danger)' : 'var(--muted)', whiteSpace: 'pre-wrap' } },
      st.error ? `Error${st.error.line ? ' (line ' + st.error.line + ')' : ''}: ${st.error.message}` : st.stats ? `${Math.round(st.stats.fps)} fps · ${st.stats.ms.toFixed(1)} ms/frame script time` : 'Running off the main thread');

    const row = h('div', { style: { display: 'flex', gap: '6px', flexWrap: 'wrap', marginTop: '4px' } },
      h('button', { class: 'btn small', onclick: () => { closePop(); this.codeEditor(key); } }, h('span', { html: icon('code', 14) }), 'Code'),
      h('button', { class: 'btn small', onclick: () => { closePop(); store.emit('focus-ai', st.error ? `Fix the ${key === 'bg' ? 'background ' : ''}animation "${anim.name}" — it throws: ${st.error.message}` : `Change the ${key === 'bg' ? 'background ' : ''}animation "${anim.name}": `); } }, h('span', { html: icon('wand', 14) }), st.error ? 'Fix with AI' : 'Ask AI'),
      h('button', { class: 'btn small', title: 'Restart', onclick: () => { const hs = host(); if (hs) { hs.code = null; hs.setCode(anim); } } }, h('span', { html: icon('refresh', 14) })),
      h('button', { class: 'btn small danger', title: 'Remove animation', onclick: () => {
        closePop();
        if (key === 'bg') store.commit('Remove animation', () => set(null));
        else this.ed.remove();
      } }, h('span', { html: icon('trash', 14) })),
    );
    popover(anchor, h('div', null, h('div', { class: 'field' }, name), status, controls, row), { className: 'panel-pop' });
  }

  codeEditor(key) {
    const { anim, set } = this.target(key);
    if (!anim) return;
    const draft = clone(anim);
    const ta = h('textarea', { spellcheck: 'false', autocomplete: 'off' });
    ta.value = draft.code;
    const paramsTa = h('textarea', { spellcheck: 'false', rows: 6, style: { width: '100%', font: '11.5px/1.5 var(--mono)', border: '1px solid var(--line)', borderRadius: '8px', padding: '8px', background: 'var(--panel-2)', resize: 'vertical' } });
    paramsTa.value = JSON.stringify(draft.params || {}, null, 2);
    const box = h('div', { class: 'anim-box' });
    const status = h('div', { class: 'code-status' }, 'Starting…');
    const paramsBox = h('div');
    let host = null;

    const setStatus = (text, err) => { status.textContent = text; status.classList.toggle('err', !!err); };
    const run = () => {
      try { draft.params = JSON.parse(paramsTa.value || '{}'); } catch (e) { setStatus('Parameters JSON: ' + e.message, true); return; }
      draft.code = ta.value;
      host?.destroy();
      box.replaceChildren();
      host = new AnimHost(box, { code: draft.code, params: draft.params }, {
        theme: store.deck.theme, quality: 'edit',
        onError: (err) => setStatus(`Error${err.line ? ' on line ' + err.line : ''}${err.phase ? ' (' + err.phase + ')' : ''}:\n${err.message}`, true),
        onStats: (s) => setStatus(`${Math.round(s.fps)} fps · ${s.ms.toFixed(2)} ms/frame script`),
        onReady: () => setStatus('Running'),
      });
      paramsBox.replaceChildren(paramControls(draft.params, (k, v) => {
        draft.params[k] = { ...draft.params[k], value: v };
        paramsTa.value = JSON.stringify(draft.params, null, 2);
        host?.setParams(draft.params);
      }));
    };
    ta.addEventListener('keydown', (e) => {
      if (e.key === 'Tab') {
        e.preventDefault();
        const s = ta.selectionStart, en = ta.selectionEnd;
        ta.setRangeText('  ', s, en, 'end');
      } else if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) { e.preventDefault(); run(); }
    });

    const body = h('div', { class: 'code-edit' },
      h('div', { class: 'code-area' }, ta),
      h('div', { class: 'code-side' },
        h('div', { class: 'code-prev' }, box),
        status,
        h('div', { class: 'code-params' }, paramsBox, h('div', { class: 'pop-label' }, 'Parameter definitions (JSON)'), paramsTa),
      ),
    );
    const m = modal({
      title: `Code · ${anim.name || 'Animation'}`,
      wide: true,
      body,
      foot: [
        h('span', { class: 'hint', style: { marginRight: 'auto', color: 'var(--muted)', fontSize: '12px' } }, h('kbd', null, 'Ctrl'), ' + ', h('kbd', null, 'Enter'), ' to run'),
        h('button', { class: 'btn', onclick: run }, 'Run'),
        h('button', { class: 'btn primary', onclick: () => {
          run();
          store.commit('Edit animation code', () => set({ ...anim, code: draft.code, params: draft.params, poster: anim.poster }));
          m.close();
        } }, 'Apply'),
      ],
      onClose: () => host?.destroy(),
    });
    m.el.querySelector('.code-edit').style.minHeight = '0';
    requestAnimationFrame(run);
  }
}
