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

You need **Node.js 22.5 or newer**.

```sh
git clone https://github.com/b11nmayavi-coder/slides-baln-tools.git
cd slides-baln-tools
npm install
npm start
```

The first `npm start` asks two questions, checks your answers, saves them to `.dev.vars`, and starts the app at
**http://localhost:8787**:

```
1) Where should decks and uploaded media be stored?
  1) SQLite    a single local file, nothing to set up
  2) Firebase  Firestore + Cloud Storage in your Firebase project

2) Which LLM provider should the assistant use?
  1) Ollama    Ollama Cloud or Ollama running on this machine
  2) Gemini    Google Gemini API key from aistudio.google.com
```

Run `npm run setup` any time to change the answers.

### Storage options

| | What you need | Where things go |
|---|---|---|
| **SQLite** | nothing | one file, `data/slides.db` by default: decks, chats and uploaded images/videos |
| **Firebase** | a Firebase project with **Firestore** and **Storage** enabled, and a service-account key (Firebase console → Project settings → Service accounts → Generate new private key) | deck index in the Firestore collection `slides_decks`; decks, chats and media under `slides/` in Cloud Storage |

Decks you already made in the browser are moved to the database the first time you open the app.

### LLM options

| | What you need | Default model |
|---|---|---|
| **Ollama Cloud** | an API key from [ollama.com/settings/keys](https://ollama.com/settings/keys) | `kimi-k3` |
| **Ollama on your machine** | [Ollama](https://ollama.com/download) running, with a model that supports tools (setup lists the ones you have and shows which support vision) | your pick |
| **Gemini** | an API key from [aistudio.google.com/apikey](https://aistudio.google.com/apikey) | `gemini-3.8-flash` |

You can switch models later in the assistant header or in **Settings**. Vision matters: after writing an
animation, the model gets a screenshot of it running and uses it to fix what looks wrong.

| Ollama Cloud models | Tools | Vision |
|---|---|---|
| `kimi-k3`, `kimi-k2.7-code`, `minimax-m3`, `gemma4:31b`, `mistral-large-3:675b` | ✓ | ✓ |
| `glm-5.3`, `deepseek-v4-pro:0813`, `gpt-oss:120b` | ✓ | – |

Gemini options: `gemini-3.8-flash` (default), `gemini-3.1-pro-preview`, `gemini-3.7-flash`,
`gemini-3.5-flash-lite`.

### Running the Cloudflare version locally instead

`npm run dev` runs the production Cloudflare Worker through Wrangler (R2 simulated on disk, decks kept in the
browser). It reads the same `.dev.vars`; no Cloudflare account is needed to run it locally.

### Troubleshooting

- **"WebGL2 is unavailable"**: shader animations need WebGL2. Turn on hardware acceleration in your browser
  (Chrome: `chrome://settings/system`). Canvas 2D animations work either way, and the assistant is told which
  one your browser supports.
- **"Model not found"**: providers retire models. Pick another in Settings, or run `npm run setup`.
- **Firebase: bucket not found / permission denied**: enable Firestore and Storage in the Firebase console, and
  check the bucket name (newer projects use `<project-id>.firebasestorage.app`, older ones `<project-id>.appspot.com`).
- **The app asks for an access token**: `ACCESS_TOKEN` is set in `.dev.vars`. Remove it for local use, or enter
  the same value in Settings.
- **`npm start` exits with "needs a one-time setup"**: the questions need a real terminal. Run `npm run setup` in one,
  or fill in `.dev.vars` by hand (see `.dev.vars.example`).

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
src/app.js             request handling shared by both runtimes (chat proxy, uploads, media, deck storage)
src/llm.js             LLM providers: Ollama passthrough, Gemini translation
src/worker.js          Cloudflare Worker entry: static assets + media in R2
server/start.js        `npm start` / `npm run setup`: the setup questions, then the Node server
server/node.js         Node HTTP server
server/storage/        sqlite.js (node:sqlite) and firebase.js (Firestore + Cloud Storage)
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
implement the `media` and `store` adapters described at the top of `src/app.js`.

## Deploy

**Anywhere Node runs** (a VM, Fly.io, Railway, a home server): run `npm run setup` once, then `npm start` behind a
reverse proxy, with `ACCESS_TOKEN` set. With SQLite, keep `data/slides.db` on persistent storage.

**Cloudflare Workers:**

1. Change the `routes` entry in `wrangler.jsonc` to a domain on your Cloudflare account, or delete it to use
   the free `*.workers.dev` URL.
2. Create the bucket and secrets, then deploy:

```sh
npx wrangler login
npx wrangler r2 bucket create slides-baln-tools-media
npx wrangler secret put OLLAMA_API_KEY      # or GEMINI_API_KEY, plus: npx wrangler secret put LLM_PROVIDER (gemini)
npx wrangler secret put ACCESS_TOKEN     # any long random string; you'll enter it in Settings
npm run deploy
```

**Always set `ACCESS_TOKEN` on a public deployment.** Without it, anyone who finds the URL can use your Ollama
key and upload files to your storage.
