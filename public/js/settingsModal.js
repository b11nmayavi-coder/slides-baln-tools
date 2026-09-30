import { settings, saveSettings, server, pref, setPref } from './settings.js';
import { MODELS } from './prompt.js';
import { h } from './util.js';
import { modal, field } from './ui.js';
import { store } from './store.js';

export function openSettings(onSave) {
  const token = h('input', { type: 'password', value: settings.accessToken, placeholder: 'Shared token set on the server', autocomplete: 'off' });
  const list = h('datalist', { id: 'modelList' }, MODELS.map((m) => h('option', { value: m.id }, m.label + (m.vision ? '' : ' · no vision'))));
  const model = h('input', { type: 'text', value: settings.model, list: 'modelList', spellcheck: 'false' });
  const effort = h('select', null, ['low', 'medium', 'high'].map((e) => h('option', { value: e, selected: settings.effort === e }, e)));
  const themeSel = h('select', null, ['system', 'light', 'dark'].map((t) => h('option', { value: t, selected: pref('uiTheme', 'system') === t }, t)));

  const body = h('div', { class: 'modal-body' },
    field('Access token', token, !server.ai
      ? 'The server has no OLLAMA_API_KEY or OLLAMA_URL yet (see README).'
      : server.auth ? 'This server requires its shared ACCESS_TOKEN for the assistant and uploads.'
      : 'Not required: this server has no ACCESS_TOKEN set.'),
    h('div', { style: { display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '12px' } },
      field('Model', h('div', null, model, list), 'Pick one, or type any Ollama model tag.'),
      field('Reasoning', effort, 'Thinking depth for models that support it.'),
    ),
    field('Interface theme', themeSel),
  );
  const m = modal({
    title: 'Settings',
    body,
    foot: [
      h('button', { class: 'btn', onclick: () => m.close() }, 'Cancel'),
      h('button', { class: 'btn primary', onclick: () => {
        saveSettings({ accessToken: token.value.trim(), model: model.value.trim() || MODELS[0].id, effort: effort.value });
        setPref('uiTheme', themeSel.value);
        applyUITheme();
        store.emit('settings');
        m.close();
        onSave?.();
      } }, 'Save'),
    ],
  });
  setTimeout(() => token.focus(), 30);
}

export function applyUITheme() {
  const t = pref('uiTheme', 'system');
  if (t === 'system') document.documentElement.removeAttribute('data-theme');
  else document.documentElement.dataset.theme = t;
}
