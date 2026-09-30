// Renders poster frames (thumbnails) for animations on slides that haven't been opened yet.
import { store } from './store.js';
import { AnimHost, blobToDataURL } from './anim/host.js';
import { h } from './util.js';

let running = false;

export async function fillMissingPosters() {
  if (running || !store.deck) return;
  running = true;
  try {
    const deck = store.deck;
    const jobs = [];
    for (const s of deck.slides) {
      if (s.bg?.anim?.code && !s.bg.anim.poster) jobs.push({ slide: s, anim: s.bg.anim, w: 480, hh: 270 });
      for (const e of s.elements) if (e.type === 'anim' && e.anim?.code && !e.anim.poster) {
        const k = Math.min(480 / e.w, 480 / e.h);
        jobs.push({ slide: s, anim: e.anim, w: Math.max(40, Math.round(e.w * k)), hh: Math.max(40, Math.round(e.h * k)) });
      }
    }
    for (const job of jobs) {
      if (store.deck !== deck) break;
      // Off to the side but inside the viewport-independent layout; the worker renders even when paused.
      const box = h('div', { style: { position: 'fixed', left: '-10000px', top: '0', width: job.w + 'px', height: job.hh + 'px', pointerEvents: 'none' } });
      document.body.append(box);
      const host = new AnimHost(box, job.anim, { theme: deck.theme, quality: 'preview', autoplay: false });
      await host.whenReady(5000);
      if (!host.error) {
        host.worker?.postMessage({ type: 'seek', t: 2.5 });
        const blob = await host.snapshot(480);
        if (blob && !job.anim.poster) {
          job.anim.poster = await blobToDataURL(blob);
          store.emit('poster', job.slide.id);
        }
      }
      host.destroy();
      box.remove();
    }
    if (jobs.length) store.save();
  } finally {
    running = false;
  }
}
