// LLM providers behind one endpoint. The browser always speaks Ollama's /api/chat format
// (messages with role/content/images/tool_calls, tools as {type:'function', function}, NDJSON stream back).
//
//   ollama  passthrough to Ollama Cloud (OLLAMA_API_KEY) or a local Ollama (OLLAMA_URL)
//   gemini  translated to Gemini's streamGenerateContent (GEMINI_API_KEY) and back
//
// Choose with LLM_PROVIDER=ollama|gemini (defaults to whichever is configured, Ollama first).

export const DEFAULT_MODELS = { ollama: 'kimi-k3', gemini: 'gemini-3.8-flash' };
const GEMINI_BASE = 'https://generativelanguage.googleapis.com/v1beta';

export function llmInfo(env) {
  const hasOllama = Boolean(env.OLLAMA_API_KEY || env.OLLAMA_URL);
  const hasGemini = Boolean(env.GEMINI_API_KEY);
  const provider = env.LLM_PROVIDER === 'gemini' || env.LLM_PROVIDER === 'ollama'
    ? env.LLM_PROVIDER
    : hasOllama || !hasGemini ? 'ollama' : 'gemini';
  const configured = provider === 'gemini' ? hasGemini : hasOllama;
  const model = provider === 'gemini' ? env.GEMINI_MODEL || DEFAULT_MODELS.gemini : env.OLLAMA_MODEL || DEFAULT_MODELS.ollama;
  const problem = configured ? null
    : provider === 'gemini' ? 'The server has no GEMINI_API_KEY configured.'
    : 'The server has no OLLAMA_API_KEY (or OLLAMA_URL) configured.';
  return { provider, configured, model, problem };
}

function jsonError(status, type, message) {
  return new Response(JSON.stringify({ error: { type, message } }), { status, headers: { 'content-type': 'application/json' } });
}

export async function chat(env, body) {
  const { provider, model } = llmInfo(env);
  if (!body.model) body.model = model;
  return provider === 'gemini' ? geminiChat(env, body) : ollamaChat(env, body);
}

// ---------- Ollama ----------
async function ollamaChat(env, body) {
  const base = (env.OLLAMA_URL || 'https://ollama.com').replace(/\/+$/, '');
  const headers = { 'content-type': 'application/json' };
  if (env.OLLAMA_API_KEY && !env.OLLAMA_URL) headers.authorization = `Bearer ${env.OLLAMA_API_KEY}`;
  for (const m of body.messages || []) delete m.gemini_parts;
  let upstream;
  try {
    upstream = await fetch(base + '/api/chat', { method: 'POST', headers, body: JSON.stringify(body) });
  } catch (err) {
    return jsonError(502, 'upstream_unreachable', `Could not reach Ollama at ${base}: ${err.message}`);
  }
  // Stream NDJSON straight through; surface upstream errors verbatim (a retired model fails here).
  return new Response(upstream.body, {
    status: upstream.status,
    headers: { 'content-type': upstream.headers.get('content-type') || 'application/x-ndjson', 'cache-control': 'no-store' },
  });
}

// ---------- Gemini ----------
function mimeOf(b64) {
  if (b64.startsWith('/9j/')) return 'image/jpeg';
  if (b64.startsWith('iVBOR')) return 'image/png';
  if (b64.startsWith('UklGR')) return 'image/webp';
  if (b64.startsWith('R0lG')) return 'image/gif';
  return 'image/jpeg';
}

function toGeminiRequest(body) {
  const system = [];
  const contents = [];
  // Gemini wants user/model turns to alternate, so consecutive same-role parts are merged.
  const push = (role, parts) => {
    if (!parts.length) return;
    const last = contents[contents.length - 1];
    if (last && last.role === role) last.parts.push(...parts);
    else contents.push({ role, parts });
  };
  let calls = []; // function calls of the last model turn, matched to tool results in order
  for (const m of body.messages || []) {
    if (m.role === 'system') { if (m.content) system.push(m.content); continue; }
    if (m.role === 'user') {
      const parts = (m.images || []).map((d) => ({ inlineData: { mimeType: mimeOf(d), data: d } }));
      if (m.content) parts.push({ text: m.content });
      push('user', parts);
    } else if (m.role === 'assistant') {
      // Replay Gemini's own parts verbatim when we have them: they carry thought signatures that must be returned.
      let parts = Array.isArray(m.gemini_parts) && m.gemini_parts.length ? m.gemini_parts : null;
      if (!parts) {
        parts = [];
        if (m.content) parts.push({ text: m.content });
        for (const tc of m.tool_calls || []) parts.push({ functionCall: { name: tc.function?.name, args: tc.function?.arguments || {} } });
      }
      calls = parts.filter((p) => p.functionCall).map((p) => p.functionCall);
      push('model', parts);
    } else if (m.role === 'tool') {
      const call = calls.shift();
      const fr = { name: m.tool_name || call?.name || 'tool', response: { result: m.content ?? '' } };
      if (call?.id) fr.id = call.id;
      push('user', [{ functionResponse: fr }]);
    }
  }

  const req = { contents };
  if (system.length) req.systemInstruction = { parts: [{ text: system.join('\n\n') }] };
  if (Array.isArray(body.tools) && body.tools.length) {
    req.tools = [{
      functionDeclarations: body.tools.map((t) => ({
        name: t.function.name,
        description: t.function.description,
        parametersJsonSchema: t.function.parameters,
      })),
    }];
  }
  const level = thinkingLevel(body.model, body.think);
  req.generationConfig = { thinkingConfig: { includeThoughts: true, ...(level ? { thinkingLevel: level } : {}) } };
  return req;
}

// Map the app's reasoning setting onto levels each model family accepts.
function thinkingLevel(model, think) {
  if (think === undefined || think === null) return null;
  const want = think === false ? 'low' : think === true ? 'high' : String(think);
  if (/pro/.test(model || '') && want === 'medium') return 'high';
  return ['minimal', 'low', 'medium', 'high'].includes(want) ? want : 'high';
}

// Merge streamed text fragments, but never across a part that carries a thought signature.
function compactParts(parts) {
  const out = [];
  for (const p of parts) {
    const last = out[out.length - 1];
    const isText = typeof p.text === 'string' && !p.functionCall;
    if (isText && !p.text && !p.thoughtSignature) continue;
    if (isText && last && typeof last.text === 'string' && !last.functionCall && !last.thoughtSignature && !p.thoughtSignature && Boolean(last.thought) === Boolean(p.thought)) {
      last.text += p.text;
      continue;
    }
    out.push({ ...p });
  }
  return out;
}

async function geminiChat(env, body) {
  const model = String(body.model).replace(/^models\//, '');
  let upstream;
  try {
    upstream = await fetch(`${GEMINI_BASE}/models/${encodeURIComponent(model)}:streamGenerateContent?alt=sse`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-goog-api-key': env.GEMINI_API_KEY },
      body: JSON.stringify(toGeminiRequest(body)),
    });
  } catch (err) {
    return jsonError(502, 'upstream_unreachable', `Could not reach Gemini: ${err.message}`);
  }
  if (!upstream.ok) {
    const raw = await upstream.text();
    let msg = raw;
    try { msg = JSON.parse(raw).error?.message || raw; } catch {}
    return jsonError(upstream.status, 'upstream_error', `Gemini (${model}) returned ${upstream.status}: ${String(msg).slice(0, 500)}`);
  }

  const enc = new TextEncoder();
  const reader = upstream.body.pipeThrough(new TextDecoderStream()).getReader();
  const all = [];
  let finish = null;
  const line = (o) => enc.encode(JSON.stringify(o) + '\n');
  const stream = new ReadableStream({
    async start(controller) {
      let buf = '';
      const handle = (data) => {
        let chunk;
        try { chunk = JSON.parse(data); } catch { return; }
        if (chunk.error) { controller.enqueue(line({ error: chunk.error.message || 'Gemini error' })); return; }
        if (chunk.promptFeedback?.blockReason) { controller.enqueue(line({ error: `Gemini blocked the prompt (${chunk.promptFeedback.blockReason}).` })); return; }
        const cand = chunk.candidates?.[0];
        if (!cand) return;
        if (cand.finishReason) finish = cand.finishReason;
        for (const p of cand.content?.parts || []) {
          all.push(p);
          const msg = { role: 'assistant', content: '' };
          if (p.functionCall) msg.tool_calls = [{ function: { name: p.functionCall.name, arguments: p.functionCall.args || {} } }];
          else if (p.thought && p.text) msg.thinking = p.text;
          else if (p.text) msg.content = p.text;
          else continue;
          controller.enqueue(line({ model, message: msg, done: false }));
        }
      };
      try {
        for (;;) {
          const { value, done } = await reader.read();
          if (done) break;
          buf += value;
          let i;
          while ((i = buf.indexOf('\n')) >= 0) {
            const ln = buf.slice(0, i).trim();
            buf = buf.slice(i + 1);
            if (ln.startsWith('data:')) handle(ln.slice(5).trim());
          }
        }
        if (buf.trim().startsWith('data:')) handle(buf.trim().slice(5).trim());
        if (finish && !['STOP', 'MAX_TOKENS'].includes(finish) && !all.some((p) => p.functionCall)) {
          controller.enqueue(line({ error: `Gemini stopped early (${finish}).` }));
        }
        controller.enqueue(line({
          model,
          message: { role: 'assistant', content: '', gemini_parts: compactParts(all) },
          done: true,
          done_reason: finish === 'MAX_TOKENS' ? 'length' : 'stop',
        }));
      } catch (err) {
        controller.enqueue(line({ error: `Gemini stream failed: ${err.message}` }));
      }
      controller.close();
    },
  });
  return new Response(stream, { headers: { 'content-type': 'application/x-ndjson', 'cache-control': 'no-store' } });
}
