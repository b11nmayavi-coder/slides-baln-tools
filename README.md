# Slides

A minimal presentation editor where the AI writes **code-driven animations** (backgrounds and animated
elements) instead of using video. Describe a look, or paste a screenshot of one, and the assistant writes the
animation, runs it on your slide, looks at the result and refines it.

Live: **https://slides.baln.tools**

- Three panes: slides · canvas · assistant
- Rich text, shapes, images and video, tables, themes, backgrounds, transitions, entrance effects
- Undo/redo, keyboard shortcuts, copy/paste, drag-and-drop, speaker notes
- Fullscreen presenting, print to PDF, JSON import/export
- Animations run off the main thread, pause when off-screen, and expose live sliders for their parameters

## Run it locally

You need **Node.js 22.5 or newer** and an AI model from one of:

- **Ollama Cloud**: an API key from [ollama.com/settings/keys](https://ollama.com/settings/keys), or
- **Ollama on your machine** ([download](https://ollama.com/download)): no key needed. Use a model with tool
  support, ideally vision too.

### 1. Get the code and configure it

```sh
git clone https://github.com/b11nmayavi-coder/slides-baln-tools.git
cd slides-baln-tools
npm install
cp .dev.vars.example .dev.vars
```

Edit `.dev.vars` and set one of these:

```sh
OLLAMA_API_KEY=your-ollama-cloud-key        # Ollama Cloud
# OLLAMA_URL=http://localhost:11434         # …or a local Ollama
```

### 2. Start it: pick a backend

**Option A: plain Node + SQLite (no Cloudflare)**

```sh
npm start
```

This is a small Node server (`server/node.js`). Uploaded images and videos are stored in a local SQLite file,
`data/slides.db`, using Node's built-in `node:sqlite`, so there's nothing else to install. Set `SLIDES_DB` to put
the file somewhere else, and `PORT` to change the port.

**Option B: Cloudflare Worker, simulated locally**

```sh
npm run dev
```

This runs the same code as production through Wrangler, with R2 storage simulated on disk. No Cloudflare
account is needed to run it locally.

Either way, open **http://localhost:8787**.

Decks and chat history are saved in your browser (IndexedDB). Use the deck menu (top-left) to export or import
decks as JSON files; uploaded media is embedded when you export.

### Choosing a model

Pick a model in the assistant header, or type any Ollama model tag in **Settings**.

| Model (Ollama Cloud) | Tools | Vision |
|---|---|---|
| `kimi-k3` (default) | ✓ | ✓ |
| `kimi-k2.7-code`, `minimax-m3`, `gemma4:31b`, `mistral-large-3:675b` | ✓ | ✓ |
| `glm-5.3`, `deepseek-v4-pro:0813`, `gpt-oss:120b` | ✓ | – |

Vision matters: after writing an animation, the model gets a screenshot of it running and uses it to fix what
looks wrong. With a local Ollama, check a model's capabilities with `ollama show <model>`. It needs `tools`,
and ideally `vision`.

### Troubleshooting

- **"WebGL2 is unavailable"**: shader animations need WebGL2. Turn on hardware acceleration in your browser
  (Chrome: `chrome://settings/system`). Canvas 2D animations work either way, and the assistant is told which
  one your browser supports.
- **"The server has no OLLAMA_API_KEY or OLLAMA_URL"**: `.dev.vars` is missing or empty. Restart the server after
  editing it.
- **"Model not found"**: Ollama retires cloud models. Pick another in Settings.
- **The app asks for an access token**: `ACCESS_TOKEN` is set in `.dev.vars`. Remove it for local use, or enter the
  same value in Settings.

## How animations work

Every animation is a small JavaScript module with a fixed contract:

```js
function setup(env) {   // env: canvas, width, height, dpr, unit, params, theme, mouse, lib
  return {
    resize(w, h, dpr) {},
    frame(t, dt) {},
  };
}
```

- Each one runs in its **own Web Worker on an OffscreenCanvas**, so rendering never blocks editing. A watchdog
  stops code that hangs instead of letting it freeze the app.
- Workers load from a `data:` URL (opaque origin), so animation code can't read the app's storage.
- Animations pause when off-screen or when the tab is hidden, and their resolution is capped
  (about 1.6 MP while editing, 4.2 MP when presenting). The next slide's animations start early while presenting.
- `env.lib.shader(env, glsl)` provides Shadertoy-style fragment shaders, with params and theme colours bound
  automatically as uniforms. `env.lib` also has noise, colour and math helpers.
- `params` definitions become live sliders and colour pickers: click the animation badge on the slide.

The assistant edits the deck through tools: `write_animation`, `update_slide`, `add_slides`, `manage_slides`,
`get_slides` and `set_theme`. After `write_animation` the app runs the code on the slide and returns the fps and
any error with its line number, then a screenshot for vision models, so the model can check and fix its own
work. Every AI change is a normal undo step.

## Project layout

```
src/app.js             request handling shared by both backends (Ollama proxy, uploads, media, ranges)
src/worker.js          Cloudflare Worker entry: static assets + media in R2
server/node.js         Node entry: static files + media in SQLite
public/index.html
public/css/app.css
public/js/
  main.js              boot, top bar, deck menu, shortcuts, import/export/print
  store.js model.js    state, undo history, IndexedDB persistence, deck model
  render.js            keyed slide renderer (editor, thumbnails, presenter, print)
  editor.js            selection, drag/resize/rotate with snapping, text and table editing, clipboard
  toolbar.js           contextual toolbar and panels
  filmstrip.js         thumbnails, reorder, slide actions
  present.js           presenter (transitions, entrance effects)
  ai.js prompt.js      assistant UI, tool loop, system prompt and tool schemas
  anim/runtime.js      code that runs inside each animation worker, plus its helper library
  anim/host.js         main-thread side of an animation
  anim/presets.js      built-in animations (also used as examples for the model)
```

The front end has no build step: plain ES modules served as static files. To add another storage backend,
implement the three-method `media` adapter described at the top of `src/app.js` (`head`, `get`, `put`).

## Deploy

**Anywhere Node runs** (a VM, Fly.io, Railway, a home server): `npm start` behind a reverse proxy. Keep
`data/slides.db` on persistent storage.

**Cloudflare Workers:**

1. Change the `routes` entry in `wrangler.jsonc` to a domain on your Cloudflare account, or delete it to use
   the free `*.workers.dev` URL.
2. Create the bucket and secrets, then deploy:

```sh
npx wrangler login
npx wrangler r2 bucket create slides-baln-tools-media
npx wrangler secret put OLLAMA_API_KEY
npx wrangler secret put ACCESS_TOKEN     # any long random string; you'll enter it in Settings
npm run deploy
```

**Always set `ACCESS_TOKEN` on a public deployment.** Without it, anyone who finds the URL can use your Ollama
key and upload files to your storage.
