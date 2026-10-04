/* OPTIMUS — static web build.
   No backend. Runs on GitHub Pages / any static host.
   The user enters their own Gemini API key in Settings; all AI calls go straight
   from the browser to Google. Chats, files, memory, images are stored in this
   browser (IndexedDB). */

const view = document.getElementById("view"), toast = document.getElementById("toast");

/* ---------- AI providers ----------
   All three support direct browser calls (confirmed CORS-safe for client-side
   use — Gemini and OpenRouter explicitly, Groq via its documented
   dangerouslyAllowBrowser client mode). Bring your own free key for whichever
   you prefer; OPTIMUS never sends your key anywhere but that provider. */
const PROVIDERS = {
  gemini: { label: "Google Gemini", keyUrl: "https://aistudio.google.com/apikey", keyHint: "Free key from Google AI Studio", defaultModel: "gemini-3.8-flash", supportsSearch: true, supportsImage: true, supportsVoice: true },
  groq: { label: "Groq", keyUrl: "https://console.groq.com/keys", keyHint: "Free key, very fast responses", defaultModel: "llama-3.3-70b-versatile", supportsSearch: false, supportsImage: false, supportsVoice: true },
  openrouter: { label: "OpenRouter", keyUrl: "https://openrouter.ai/keys", keyHint: "Free key, access to many free models", defaultModel: "meta-llama/llama-3.3-70b-instruct:free", supportsSearch: false, supportsImage: false, supportsVoice: false },
};
function keyStoreKey(p) { return "optimus_key_" + p; }
function modelStoreKey(p) { return "optimus_model_" + p; }

const state = {
  provider: localStorage.getItem("optimus_provider") || "gemini",
  name: localStorage.getItem("optimus_user_name") || "",
  theme: localStorage.getItem("optimus_theme") || "dark",
  mode: "general",
  search: false,
};
state.apiKey = localStorage.getItem(keyStoreKey(state.provider)) || "";
state.model = localStorage.getItem(modelStoreKey(state.provider)) || PROVIDERS[state.provider].defaultModel;
document.documentElement.setAttribute("data-theme", state.theme); // set immediately, before first paint, to avoid a flash of the wrong theme
function providerInfo() { return PROVIDERS[state.provider] || PROVIDERS.gemini; }
let conversationId = null;
let attached = []; // file ids chosen for the next message

/* ---------- Storage (IndexedDB, falls back to memory) ---------- */
let DB = { conversations: [], memories: [], projects: [], files: [], images: [] };
let idb = null, saveTimer = null, storageOk = true;
function openIDB() {
  return new Promise(res => {
    try {
      const rq = indexedDB.open("optimus", 1);
      rq.onupgradeneeded = () => rq.result.createObjectStore("kv");
      rq.onsuccess = () => res(rq.result);
      rq.onerror = () => res(null);
    } catch { res(null); }
  });
}
function idbGet(k) { return new Promise(res => { try { const r = idb.transaction("kv").objectStore("kv").get(k); r.onsuccess = () => res(r.result); r.onerror = () => res(undefined); } catch { res(undefined); } }); }
function idbSet(k, v) { return new Promise(res => { try { const tx = idb.transaction("kv", "readwrite"); tx.objectStore("kv").put(v, k); tx.oncomplete = () => res(true); tx.onerror = () => res(false); } catch { res(false); } }); }
async function initStorage() {
  idb = await openIDB();
  if (!idb) { storageOk = false; return; }
  const saved = await idbGet("db");
  if (saved) DB = Object.assign(DB, saved);
}
function persist() {
  if (!idb) return;
  clearTimeout(saveTimer);
  saveTimer = setTimeout(async () => { const ok = await idbSet("db", DB); if (!ok) notify("Couldn't save — browser storage may be full"); }, 250);
}
function nextId(arr) { return arr.length ? Math.max(...arr.map(x => x.id)) + 1 : 1; }

/* ---------- Helpers ---------- */
function notify(t) { toast.textContent = t; toast.classList.add("show"); setTimeout(() => toast.classList.remove("show"), 2800); }
function esc(s) { return String(s ?? "").replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c])); }
function timeAgo(ts) {
  const s = Math.max(1, Math.floor((Date.now() - ts) / 1000));
  if (s < 60) return "just now";
  if (s < 3600) return Math.floor(s / 60) + "m ago";
  if (s < 86400) return Math.floor(s / 3600) + "h ago";
  if (s < 604800) return Math.floor(s / 86400) + "d ago";
  return new Date(ts).toLocaleDateString();
}
function fileToBase64(file) {
  return new Promise((resolve, reject) => { const r = new FileReader(); r.onload = () => resolve(String(r.result).split(",")[1]); r.onerror = reject; r.readAsDataURL(file); });
}

/* ---------- Text rendering: code blocks, headings, lists, tables, quotes ----------
   Fenced code is pulled out into placeholders first (so markdown inside code
   never gets reformatted), forced onto their own line (so a code fence stuck
   directly against surrounding text still extracts cleanly), then the rest is
   parsed line-by-line into real block elements instead of flat <br> soup. */
let codeSeq = 0;
function inlineMd(t) {
  t = t.replace(/\*\*([^*\n]+)\*\*/g, "<b>$1</b>");
  t = t.replace(/(^|[^*\w])\*([^*\n]+)\*(?!\*)/g, "$1<i>$2</i>");
  t = t.replace(/`([^`\n]+)`/g, "<code>$1</code>");
  return t;
}
function renderText(s) {
  const blocks = [];
  // Tolerates \r\n, missing newline after the fence, and a block cut off before its closing fence.
  let raw = String(s ?? "").replace(/```([\w+#.-]*)[ \t]*\r?\n?([\s\S]*?)(```|$)/g, (m, lang, code) => {
    blocks.push({ lang, code: code.replace(/\r\n/g, "\n").replace(/\n$/, "") });
    return `\n\u0000B${blocks.length - 1}\u0000\n`;
  });
  raw = esc(raw).replace(/\r\n/g, "\n");
  const lines = raw.split("\n");
  const out = [];
  let para = [];
  const flushPara = () => { if (para.length) { out.push("<p>" + inlineMd(para.join(" ")) + "</p>"); para = []; } };
  let i = 0;
  while (i < lines.length) {
    const line = lines[i], trimmed = line.trim();
    const codeMatch = trimmed.match(/^\u0000B(\d+)\u0000$/);
    if (codeMatch) {
      flushPara();
      const b = blocks[+codeMatch[1]], id = "cb" + (++codeSeq);
      out.push(`<div class="codeWrap"><div class="codeHead"><span>${esc(b.lang || "code")}</span><button class="copyBtn" onclick="copyCode('${id}')">⧉ Copy</button></div><pre class="codeBlock" id="${id}"><code>${esc(b.code)}</code></pre></div>`);
      i++; continue;
    }
    if (trimmed === "") { flushPara(); i++; continue; }
    if (/^(-{3,}|\*{3,}|_{3,})$/.test(trimmed)) { flushPara(); out.push("<hr>"); i++; continue; }
    const h = trimmed.match(/^(#{1,6})\s+(.+)$/);
    if (h) { flushPara(); const lvl = Math.min(h[1].length + 2, 6); out.push(`<h${lvl}>${inlineMd(h[2])}</h${lvl}>`); i++; continue; }
    if (/^&gt;\s?/.test(trimmed)) {
      flushPara();
      const qlines = [];
      while (i < lines.length && /^&gt;\s?/.test(lines[i].trim())) { qlines.push(lines[i].trim().replace(/^&gt;\s?/, "")); i++; }
      out.push("<blockquote>" + inlineMd(qlines.join("<br>")) + "</blockquote>");
      continue;
    }
    if (/\|/.test(trimmed) && i + 1 < lines.length && /^[\s|:-]+$/.test(lines[i + 1].trim()) && lines[i + 1].includes("-")) {
      flushPara();
      const headCells = trimmed.replace(/^\||\|$/g, "").split("|").map(c => c.trim());
      i += 2;
      const rows = [];
      while (i < lines.length && lines[i].includes("|") && lines[i].trim() !== "") { rows.push(lines[i].replace(/^\||\|$/g, "").split("|").map(c => c.trim())); i++; }
      out.push(`<div class="tableWrap"><table><thead><tr>${headCells.map(c => `<th>${inlineMd(c)}</th>`).join("")}</tr></thead><tbody>${rows.map(r => `<tr>${r.map(c => `<td>${inlineMd(c)}</td>`).join("")}</tr>`).join("")}</tbody></table></div>`);
      continue;
    }
    if (/^\d+\.\s+/.test(trimmed)) {
      flushPara();
      const items = [];
      while (i < lines.length && /^\d+\.\s+/.test(lines[i].trim())) { items.push(lines[i].trim().replace(/^\d+\.\s+/, "")); i++; }
      out.push("<ol>" + items.map(it => `<li>${inlineMd(it)}</li>`).join("") + "</ol>");
      continue;
    }
    if (/^[-*]\s+/.test(trimmed)) {
      flushPara();
      const items = [];
      while (i < lines.length && /^[-*]\s+/.test(lines[i].trim())) { items.push(lines[i].trim().replace(/^[-*]\s+/, "")); i++; }
      out.push("<ul>" + items.map(it => `<li>${inlineMd(it)}</li>`).join("") + "</ul>");
      continue;
    }
    para.push(line); i++;
  }
  flushPara();
  return out.join("");
}
function copyCode(id) {
  const el = document.getElementById(id); if (!el) return;
  const text = el.textContent || "";
  const done = () => notify("Code copied");
  if (navigator.clipboard?.writeText) navigator.clipboard.writeText(text).then(done).catch(() => fallbackCopy(text, done));
  else fallbackCopy(text, done);
}
function fallbackCopy(text, done) {
  const ta = document.createElement("textarea"); ta.value = text; ta.style.position = "fixed"; ta.style.opacity = "0";
  document.body.appendChild(ta); ta.select();
  try { document.execCommand("copy"); done(); } catch { notify("Couldn't copy — select the code manually"); }
  ta.remove();
}
function sourcesHtml(sources) {
  if (!sources?.length) return "";
  return `<div class="sources"><small>Sources</small>${sources.map(s => `<a href="${esc(s.uri)}" target="_blank" rel="noopener noreferrer">${esc(s.title || s.uri)}</a>`).join("")}</div>`;
}

/* ---------- Networking: friendly errors + automatic retry ----------
   Two kinds of resilience live here, both aimed at "no matter old or new
   model/API, it just works":
   1. A transient 5xx from the provider (like the 503 "having trouble" case)
      is retried once automatically after a short wait, before ever
      reaching the user as an error.
   2. A 400 caused by a parameter one particular model doesn't recognize
      (e.g. an older Gemini model rejecting thinkingConfig, or a future
      model renaming it) triggers one automatic retry with that parameter
      stripped — so OPTIMUS adapts to the model instead of assuming one
      fixed shape forever. */
function friendlyError(msg, status, provider) {
  const name = PROVIDERS[provider]?.label || IMAGE_PROVIDERS[provider]?.label || "the AI provider";
  if (status === 401 || (status === 400 && /api[ _-]?key/i.test(msg))) return `Your ${name} API key isn't valid. Check it in Settings.`;
  if (status === 403) return `Access denied (403) from ${name}. Your key may not have access to this model. ${msg}`;
  if (status === 404) return `That model isn't available on ${name} for your key. Pick another in Settings → Load available models.`;
  if (status === 429) return `Rate limit or quota reached on your ${name} key. Wait a minute, or switch provider in Settings.`;
  if (status >= 500) return `${name} is having trouble right now (${status}). It was retried automatically and still failed — try again in a moment, or switch provider in Settings.`;
  return msg || `${name} returned an unexpected error.`;
}
function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }
async function apiFetch(url, opts, provider, retriesLeft = 1) {
  if (typeof navigator !== "undefined" && navigator.onLine === false) throw new Error("You appear to be offline. Check your internet connection and try again.");
  let r;
  try { r = await fetch(url, opts); }
  catch (e) {
    if (e.name === "AbortError") throw e;
    throw new Error("Couldn't reach " + (PROVIDERS[provider]?.label || "the AI provider") + ". Check your internet connection, or an ad blocker/extension may be blocking the request.");
  }
  if (!r.ok && r.status >= 500 && retriesLeft > 0) { await sleep(700); return apiFetch(url, opts, provider, retriesLeft - 1); }
  let d = {}; try { d = await r.json(); } catch { }
  if (!r.ok) throw new Error(friendlyError(d?.error?.message || d?.error || `error ${r.status}`, r.status, provider));
  return d;
}
// Same retry behavior as apiFetch but returns the raw Response for streaming
// (can't pre-parse the body as JSON — that would consume the stream).
async function rawFetch(url, opts, provider, retriesLeft = 1) {
  if (typeof navigator !== "undefined" && navigator.onLine === false) throw new Error("You appear to be offline. Check your internet connection and try again.");
  let r;
  try { r = await fetch(url, opts); }
  catch (e) {
    if (e.name === "AbortError") throw e;
    throw new Error("Couldn't reach " + (PROVIDERS[provider]?.label || "the AI provider") + ". Check your internet connection, or an ad blocker/extension may be blocking the request.");
  }
  if (!r.ok) {
    if (r.status >= 500 && retriesLeft > 0) { await sleep(700); return rawFetch(url, opts, provider, retriesLeft - 1); }
    let msg = `error ${r.status}`;
    try { const d = await r.json(); msg = d?.error?.message || d?.error || msg; } catch { }
    throw new Error(friendlyError(msg, r.status, provider));
  }
  return r;
}
// Reads a Server-Sent-Events body, calling onData(payload) for each "data: ..." line.
async function streamSSE(response, onData) {
  if (!response.body?.getReader) { // very old browsers without streaming fetch — fall back to reading it all at once
    const text = await response.text();
    for (const line of text.split("\n")) { const t = line.trim(); if (t.startsWith("data:")) { const d = t.slice(5).trim(); if (d && d !== "[DONE]") onData(d); } }
    return;
  }
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buf = "";
  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    buf += decoder.decode(value, { stream: true });
    let idx;
    while ((idx = buf.indexOf("\n")) >= 0) {
      const line = buf.slice(0, idx).trim();
      buf = buf.slice(idx + 1);
      if (!line.startsWith("data:")) continue;
      const data = line.slice(5).trim();
      if (data === "[DONE]") return;
      if (data) onData(data);
    }
  }
}
function thinkingSupported(model) { return /^gemini-(3(\.\d+)?)/i.test(model); } // gemini-3.x and newer send thinkingConfig; older/unknown models skip it, with a retry safety net either way
function isCompatParamError(msg) { return /thinkingConfig|thinking_config|unknown name|unrecognized|invalid.*field|not supported for model/i.test(msg || ""); }

/* ---- Gemini (native format; supports search grounding, images, voice) ---- */
async function callGemini(model, apiKey, { system, messages, search, thinking }) {
  const contents = messages.map(m => ({ role: m.role === "assistant" ? "model" : "user", parts: [{ text: m.content }, ...(m.parts || [])] }));
  async function attempt(includeThinking) {
    const payload = { contents };
    if (system) payload.systemInstruction = { parts: [{ text: system }] };
    if (includeThinking && thinking && thinkingSupported(model)) payload.generationConfig = { thinkingConfig: { thinkingLevel: "medium" } };
    if (search) payload.tools = [{ google_search: {} }];
    return apiFetch(`https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`, { method: "POST", headers: { "x-goog-api-key": apiKey, "Content-Type": "application/json" }, body: JSON.stringify(payload) }, "gemini");
  }
  let d;
  try { d = await attempt(true); }
  catch (e) { if (isCompatParamError(e.message)) d = await attempt(false); else throw e; }
  const parts = d?.candidates?.[0]?.content?.parts || [];
  const text = parts.filter(p => p.text && !p.thought).map(p => p.text).join("") || (d?.promptFeedback?.blockReason ? `The request was blocked by Google's safety filters (${d.promptFeedback.blockReason}).` : "");
  const chunks = d?.candidates?.[0]?.groundingMetadata?.groundingChunks || [];
  const seen = new Set(), sources = [];
  for (const c of chunks) if (c.web?.uri && !seen.has(c.web.uri)) { seen.add(c.web.uri); sources.push({ uri: c.web.uri, title: c.web.title }); }
  return { text: text || "I received an empty response. Please try again.", sources: sources.slice(0, 6) };
}
// Streaming variant. The compat retry is still safe here: a 400 for an
// unsupported param arrives as the initial (non-OK) HTTP response, which
// rawFetch rejects BEFORE any stream reading starts — so no partial text
// can have reached onDelta yet, and retrying clean never duplicates output.
async function callGeminiStream(model, apiKey, { system, messages, search, thinking, onDelta, signal }) {
  const contents = messages.map(m => ({ role: m.role === "assistant" ? "model" : "user", parts: [{ text: m.content }, ...(m.parts || [])] }));
  async function attempt(includeThinking) {
    const payload = { contents };
    if (system) payload.systemInstruction = { parts: [{ text: system }] };
    if (includeThinking && thinking && thinkingSupported(model)) payload.generationConfig = { thinkingConfig: { thinkingLevel: "medium" } };
    if (search) payload.tools = [{ google_search: {} }];
    const r = await rawFetch(`https://generativelanguage.googleapis.com/v1beta/models/${model}:streamGenerateContent?alt=sse`, { method: "POST", headers: { "x-goog-api-key": apiKey, "Content-Type": "application/json" }, body: JSON.stringify(payload), signal }, "gemini");
    let text = "", blocked = null;
    const seen = new Set(), sources = [];
    await streamSSE(r, raw => {
      let obj; try { obj = JSON.parse(raw); } catch { return; }
      const parts = obj?.candidates?.[0]?.content?.parts || [];
      for (const p of parts) if (p.text && !p.thought) { text += p.text; onDelta?.(p.text); }
      const chunks = obj?.candidates?.[0]?.groundingMetadata?.groundingChunks || [];
      for (const c of chunks) if (c.web?.uri && !seen.has(c.web.uri)) { seen.add(c.web.uri); sources.push({ uri: c.web.uri, title: c.web.title }); }
      if (obj?.promptFeedback?.blockReason) blocked = obj.promptFeedback.blockReason;
    });
    if (!text && blocked) { text = `The request was blocked by Google's safety filters (${blocked}).`; onDelta?.(text); }
    return { text: text || "I received an empty response. Please try again.", sources: sources.slice(0, 6) };
  }
  try { return await attempt(true); }
  catch (e) { if (e.name !== "AbortError" && isCompatParamError(e.message)) return attempt(false); throw e; }
}

/* ---- OpenAI-compatible chat (Groq, OpenRouter, and in principle any other OpenAI-style free API) ---- */
async function callOpenAICompatible(baseUrl, model, apiKey, { system, messages }, provider) {
  const body = { model, messages: [...(system ? [{ role: "system", content: system }] : []), ...messages.map(m => ({ role: m.role, content: m.content }))], temperature: 0.7 };
  const d = await apiFetch(`${baseUrl}/chat/completions`, { method: "POST", headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" }, body: JSON.stringify(body) }, provider);
  const text = d?.choices?.[0]?.message?.content || "";
  return { text: text || "I received an empty response. Please try again.", sources: [] };
}
async function callOpenAICompatibleStream(baseUrl, model, apiKey, { system, messages, onDelta, signal }, provider) {
  const body = { model, stream: true, messages: [...(system ? [{ role: "system", content: system }] : []), ...messages.map(m => ({ role: m.role, content: m.content }))], temperature: 0.7 };
  const r = await rawFetch(`${baseUrl}/chat/completions`, { method: "POST", headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" }, body: JSON.stringify(body), signal }, provider);
  let text = "";
  await streamSSE(r, raw => {
    let obj; try { obj = JSON.parse(raw); } catch { return; }
    const delta = obj?.choices?.[0]?.delta?.content;
    if (delta) { text += delta; onDelta?.(delta); }
  });
  return { text: text || "I received an empty response. Please try again.", sources: [] };
}

/* ---- Router: every non-streaming caller goes through this (plans, research, voice, test connection) ---- */
async function callAI({ system, messages, search = false, thinking = true, model, apiKey, provider }) {
  provider = provider || state.provider; apiKey = apiKey || state.apiKey; model = model || state.model;
  if (!apiKey) throw new Error(`Add a ${PROVIDERS[provider]?.label || ""} API key in Settings first.`);
  if (search && !PROVIDERS[provider]?.supportsSearch) { search = false; } // silently degrade instead of erroring
  if (provider === "gemini") return callGemini(model, apiKey, { system, messages, search, thinking });
  if (provider === "groq") return callOpenAICompatible("https://api.groq.com/openai/v1", model, apiKey, { system, messages }, "groq");
  if (provider === "openrouter") return callOpenAICompatible("https://openrouter.ai/api/v1", model, apiKey, { system, messages }, "openrouter");
  throw new Error("Unknown provider selected.");
}
/* ---- Router: streaming version, used by Chat so replies appear live ---- */
async function callAIStream({ system, messages, search = false, thinking = true, model, apiKey, provider, onDelta, signal }) {
  provider = provider || state.provider; apiKey = apiKey || state.apiKey; model = model || state.model;
  if (!apiKey) throw new Error(`Add a ${PROVIDERS[provider]?.label || ""} API key in Settings first.`);
  if (search && !PROVIDERS[provider]?.supportsSearch) search = false;
  if (provider === "gemini") return callGeminiStream(model, apiKey, { system, messages, search, thinking, onDelta, signal });
  if (provider === "groq") return callOpenAICompatibleStream("https://api.groq.com/openai/v1", model, apiKey, { system, messages, onDelta, signal }, "groq");
  if (provider === "openrouter") return callOpenAICompatibleStream("https://openrouter.ai/api/v1", model, apiKey, { system, messages, onDelta, signal }, "openrouter");
  throw new Error("Unknown provider selected.");
}

const MODE_PROMPTS = {
  general: "Be a clear, accurate, helpful assistant.",
  code: "You are an expert software engineer. Give complete, working code in fenced blocks with a language tag. Briefly explain the approach, then how to run it. Mention edge cases and any assumptions. Do not leave placeholders unless unavoidable.",
  write: "You are a skilled writer and editor. Produce polished, well-structured writing that matches the requested tone and audience.",
  analyze: "You are a careful analyst. Work step by step, show key calculations or reasoning, state assumptions, and separate facts from inference.",
};
function systemPrompt(convo) {
  const now = new Date();
  const tz = Intl.DateTimeFormat().resolvedOptions().timeZone || "local time";
  let s = `You are OPTIMUS, a personal AI workspace assistant. Be accurate and honest. If you are not sure, say so instead of guessing. Never claim to have done something you can't do from a chat window. If a question depends on current events or facts that may have changed, and live search is not enabled, tell the user to turn on "Live search".\n\n${MODE_PROMPTS[state.mode] || MODE_PROMPTS.general}\n\nThe user's current date and time: ${now.toLocaleString("en-US", { dateStyle: "full", timeStyle: "long" })} (${tz}). Use this for any date/time question.`;
  if (state.name) s += `\nThe user's name is ${state.name}.`;
  if (DB.memories.length) s += "\n\nThings to remember about the user:\n" + DB.memories.map(m => "- " + m.content).join("\n");
  const ids = new Set([...(convo?.fileIds || []), ...attached]);
  let budget = 90000;
  const texts = [];
  for (const id of ids) {
    const f = DB.files.find(x => x.id === id);
    if (f && f.text && budget > 0) { const t = f.text.slice(0, budget); budget -= t.length; texts.push(`--- FILE: ${f.name} ---\n${t}`); }
  }
  if (texts.length) s += "\n\nThe user attached these files. Use their content when relevant:\n\n" + texts.join("\n\n");
  return s;
}
function imagePartsFor(ids) {
  return (ids || []).map(id => DB.files.find(f => f.id === id)).filter(f => f && f.isImage && f.b64).map(f => ({ inline_data: { mime_type: f.mime, data: f.b64 } }));
}

/* ---------- Settings/profile ---------- */
function switchProvider(p) {
  state.provider = p;
  state.apiKey = localStorage.getItem(keyStoreKey(p)) || "";
  state.model = localStorage.getItem(modelStoreKey(p)) || PROVIDERS[p].defaultModel;
  localStorage.setItem("optimus_provider", p);
  settings();
}
function saveSettings() {
  state.apiKey = document.getElementById("apiKey").value.trim();
  state.model = document.getElementById("model").value.trim() || providerInfo().defaultModel;
  state.name = document.getElementById("userName").value.trim();
  localStorage.setItem(keyStoreKey(state.provider), state.apiKey);
  localStorage.setItem(modelStoreKey(state.provider), state.model);
  localStorage.setItem("optimus_provider", state.provider);
  localStorage.setItem("optimus_user_name", state.name);
  document.getElementById("modelPill").textContent = "● " + state.model;
  applyProfile(); notify("Settings saved");
}
function clearKey() { state.apiKey = ""; localStorage.removeItem(keyStoreKey(state.provider)); const el = document.getElementById("apiKey"); if (el) el.value = ""; notify("API key cleared"); }
function needKey() { if (!state.apiKey) { page("settings"); notify(`Add a ${providerInfo().label} API key first`); return false; } return true; }
async function testConnection() {
  const key = document.getElementById("apiKey").value.trim() || state.apiKey;
  const model = document.getElementById("model").value.trim() || providerInfo().defaultModel;
  if (!key) { notify("Enter a key first"); return; }
  const out = document.getElementById("testResult");
  out.textContent = "Testing…";
  try {
    await callAI({ messages: [{ role: "user", content: "Say OK." }], provider: state.provider, apiKey: key, model, thinking: false });
    out.textContent = "✅ Working — your key and model are good.";
  } catch (e) { out.textContent = "❌ " + e.message; }
}
function setNav(p) { document.querySelectorAll(".nav").forEach(x => x.classList.toggle("active", x.dataset.page === p)); }
// Every page render is guarded: a bug in one screen shows a recoverable error
// card instead of leaving the whole app blank or frozen.
function page(p) {
  setNav(p);
  try {
    const fn = ({ home, chat, projects, files, memory, agents, settings, research, createImage, history: historyPage })[p] || home;
    const result = fn();
    if (result?.catch) result.catch(err => showPageError(p, err));
  } catch (err) { showPageError(p, err); }
}
function showPageError(p, err) {
  console.error("OPTIMUS page error:", p, err);
  view.innerHTML = `<div class="sectionTitle"><h2>Something went wrong</h2><p>This screen hit an unexpected error. Your chats, files and memory are untouched.</p></div><div class="card danger">${esc(err?.message || String(err))}</div><button class="action" style="margin-top:12px" onclick="page('${p}')">Try again</button> <button class="action" style="margin-top:12px" onclick="page('home')">Go home</button>`;
}
function newChat() { conversationId = null; attached = []; chat(); }
function card(i, t, d, p) { return `<button class="card feature" onclick="page('${p}')"><div class="icon">${i}</div><h3>${t}</h3><p>${d}</p><span class="arrow">→</span></button>`; }
function applyProfile() {
  const n = state.name || "Guest";
  const a = document.getElementById("sideName"); if (a) a.textContent = n;
  const b = document.getElementById("sideAvatar"); if (b) b.textContent = n.slice(0, 1).toUpperCase() || "O";
}
function greeting() {
  const h = new Date().getHours();
  const part = h < 12 ? "Good Morning" : h < 17 ? "Good Afternoon" : "Good Evening";
  return state.name ? `${part},<br><b>${esc(state.name)}</b>` : `Hello, I'm <b>Optimus</b>`;
}
function setMode(m) { state.mode = m; }

/* ---------- Home ---------- */
function home() {
  view.innerHTML = `<section class="hero">
    <h1>${greeting()}</h1>
    <p>Ideas. Code. Create. — All in one place.</p>
    <div class="composer"><textarea id="prompt" rows="1" placeholder="Ask Optimus anything..."></textarea><button class="sendBtn" onclick="sendHome()">↑</button></div>
    <div class="chips">
      <button class="chip" onclick="setMode('code');newChat()">&lt;/&gt; Code</button>
      <button class="chip" onclick="page('research')">⌕ Research</button>
      <button class="chip" onclick="setMode('write');newChat()">✧ Create</button>
      <button class="chip" onclick="setMode('analyze');newChat()">▥ Analyze</button>
      <button class="chip" onclick="page('createImage')">▤ Images</button>
    </div>
  </section>
  <div class="sectionHead"><h2>Quick Actions</h2></div>
  <section class="grid">
    ${card("⌘", "Write Code", "Build, debug and improve your code.", "chat")}
    ${card("◇", "Turn Ideas Into Plans", "Get structured steps for your goals.", "agents")}
    ${card("⌕", "Deep Research", "Explore topics with live search grounding.", "research")}
    ${card("▧", "Generate Images", "Create stunning visuals from your ideas.", "createImage")}
  </section>
  <div class="sectionHead"><h2>Recent Chats</h2><a onclick="page('history')">View all →</a></div>
  <div class="recentList" id="recentList"></div>`;
  document.getElementById("prompt").addEventListener("keydown", e => { if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); sendHome(); } });
  const sorted = [...DB.conversations].sort((a, b) => b.updated_at - a.updated_at).slice(0, 5);
  document.getElementById("recentList").innerHTML = sorted.length ? sorted.map(c => `<button class="recentItem" onclick="openConversation(${c.id})"><span class="bubbleIcon">◌</span><span class="meta"><b>${esc(c.title)}</b><small>${timeAgo(c.updated_at)}</small></span><span class="goArrow">→</span></button>`).join("") : `<div class="drop">No conversations yet — start one above.</div>`;
  if (!state.apiKey) document.getElementById("recentList").insertAdjacentHTML("beforebegin", `<div class="notice" style="max-width:1000px;margin:0 auto 14px">👋 To start, open <a href="#" onclick="page('settings');return false" style="color:var(--accent)">Settings</a> and paste a free API key — Google Gemini, Groq, or OpenRouter, your choice.</div>`);
}
function openConversation(id) { conversationId = id; attached = []; page("chat"); }
function historyPage() {
  const sorted = [...DB.conversations].sort((a, b) => b.updated_at - a.updated_at);
  view.innerHTML = `<div class="sectionTitle"><h2>All Chats</h2><p>Stored in this browser only.</p></div><div class="recentList">${sorted.length ? sorted.map(c => `<div class="recentItem" style="cursor:default"><span class="bubbleIcon">◌</span><span class="meta" style="cursor:pointer" onclick="openConversation(${c.id})"><b>${esc(c.title)}</b><small>${timeAgo(c.updated_at)}</small></span><button class="action danger" style="padding:6px 12px" onclick="deleteConversation(${c.id})">✕ Delete</button></div>`).join("") : `<div class="drop">No conversations yet.</div>`}</div>`;
}
function deleteConversation(id) { DB.conversations = DB.conversations.filter(c => c.id !== id); if (conversationId === id) conversationId = null; persist(); historyPage(); }
function sendHome() { const p = document.getElementById("prompt").value.trim(); if (!p) return; if (!needKey()) return; conversationId = null; chat(p, true); }

/* ---------- Chat ---------- */
const ACCEPT = ".pdf,.docx,.txt,.md,.csv,.json,.py,.js,.ts,.jsx,.tsx,.html,.css,.java,.c,.cpp,.h,.hpp,.cs,.php,.go,.rs,.sql,.sh,.yaml,.yml,.xml,.png,.jpg,.jpeg,.webp,.gif";
const MODE_ICON = { general: "◎", code: "⌥", write: "✎", analyze: "▥" };
let generating = false, currentAbort = null;
function attachedChips() {
  return attached.map(id => { const f = DB.files.find(x => x.id === id); return f ? `<span class="fileChip" onclick="detach(${id})" title="Remove">${esc(f.name)} ✕</span>` : ""; }).join("");
}
function autoResize(el) { el.style.height = "auto"; el.style.height = Math.min(el.scrollHeight, 180) + "px"; }
function chat(prefill = "", autosend = false) {
  const convo = DB.conversations.find(c => c.id === conversationId);
  view.innerHTML = `<div class="chatWrap"><div class="sectionTitle chatTitleRow"><div><h2>${convo ? esc(convo.title) : "Chat"}</h2><p>Conversation, memory and attached file context stay connected.</p></div>${convo ? `<button class="iconBtn small" title="Rename chat" onclick="renameConversation(${convo.id})">✎</button>` : ""}</div>
  <div class="modeBar">
    ${["general", "code", "write", "analyze"].map(m => `<button class="chip ${state.mode === m ? "selected" : ""}" onclick="setMode('${m}');chat(document.getElementById('chatInput').value)">${MODE_ICON[m]} ${m[0].toUpperCase() + m.slice(1)}</button>`).join("")}
    <span class="spacer"></span>
    <button class="searchToggle ${state.search ? "on" : ""}" onclick="toggleSearch()">⌕ Live search ${state.search ? "on" : "off"}</button>
  </div>
  <div id="messages" class="messages"></div>
  <button id="scrollDown" class="scrollDownBtn" style="display:none" onclick="scrollMessagesToBottom(true)">↓ New content</button>
  <div class="attachRow"><input type="file" id="chatFile" multiple accept="${ACCEPT}" onchange="attachFromChat()"><label for="chatFile" class="attachBtn">+ Attach files</label>${DB.files.length ? `<button class="attachBtn" onclick="pickStored()">⊞ From Files</button>` : ""}<span id="attached">${attachedChips()}</span></div>
  <div id="picker"></div>
  <div class="composer chatComposer"><button class="micBtn" id="micBtn" onclick="toggleRecording()" title="Voice input">🎤</button><textarea id="chatInput" rows="1" placeholder="Ask Optimus anything...">${esc(prefill)}</textarea><button class="sendBtn" id="sendBtn" onclick="sendChat()" title="Send">↑</button></div></div>`;
  renderMessages();
  const ta = document.getElementById("chatInput");
  autoResize(ta);
  if (!(navigator.mediaDevices && window.MediaRecorder)) { const mb = document.getElementById("micBtn"); mb.disabled = true; mb.style.opacity = .35; mb.title = "Voice input isn't supported in this browser"; }
  ta.addEventListener("input", () => autoResize(ta));
  ta.addEventListener("keydown", e => { if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); sendChat(); } });
  document.getElementById("messages").addEventListener("scroll", updateScrollDownVisibility);
  setSendButtonState();
  if (autosend && prefill) sendChat();
}
function setSendButtonState() {
  const btn = document.getElementById("sendBtn"); if (!btn) return;
  if (generating) { btn.textContent = "⏹"; btn.title = "Stop generating"; btn.classList.add("stop"); btn.onclick = stopGenerating; }
  else { btn.textContent = "↑"; btn.title = "Send"; btn.classList.remove("stop"); btn.onclick = sendChat; }
}
function stopGenerating() { currentAbort?.abort(); }
function isNearBottom(el) { return el.scrollHeight - el.scrollTop - el.clientHeight < 60; }
function updateScrollDownVisibility() {
  const el = document.getElementById("messages"), btn = document.getElementById("scrollDown");
  if (!el || !btn) return;
  btn.style.display = isNearBottom(el) ? "none" : "block";
}
function scrollMessagesToBottom(force) {
  const el = document.getElementById("messages"); if (!el) return;
  if (force || isNearBottom(el)) { el.scrollTop = el.scrollHeight; document.getElementById("scrollDown")?.style.setProperty("display", "none"); }
}
function toggleSearch() { state.search = !state.search; chat(document.getElementById("chatInput")?.value || ""); }
function detach(id) { attached = attached.filter(x => x !== id); const el = document.getElementById("attached"); if (el) el.innerHTML = attachedChips(); }
function pickStored() {
  document.getElementById("picker").innerHTML = `<div class="card" style="margin-top:10px;min-height:auto">${DB.files.map(f => `<button class="fileChip" style="cursor:pointer;margin:3px" onclick="attachStored(${f.id})">${esc(f.name)}</button>`).join("")}</div>`;
}
function attachStored(id) { if (!attached.includes(id)) attached.push(id); document.getElementById("picker").innerHTML = ""; document.getElementById("attached").innerHTML = attachedChips(); }
function renameConversation(id) {
  const convo = DB.conversations.find(c => c.id === id); if (!convo) return;
  const next = prompt("Rename this chat", convo.title);
  if (next === null) return;
  const trimmed = next.trim();
  if (trimmed) { convo.title = trimmed.slice(0, 80); persist(); chat(); }
}
function bubbleHtml(m, index, total) {
  const isLastAssistant = m.role === "assistant" && index === total - 1;
  const actions = `<div class="msgActions">
    <button class="msgActionBtn" title="Copy" onclick="copyMessage(${index})">⧉</button>
    ${isLastAssistant && !generating ? `<button class="msgActionBtn" title="Regenerate" onclick="regenerateLast()">↻</button>` : ""}
  </div>`;
  return `<div class="bubble ${m.role}${m.stopped ? " stopped" : ""}" data-idx="${index}">${renderText(m.content)}${m.stopped ? `<div class="stoppedNote">Stopped</div>` : ""}${sourcesHtml(m.sources)}${actions}</div>`;
}
function renderMessages() {
  const el = document.getElementById("messages"); if (!el) return;
  const convo = DB.conversations.find(c => c.id === conversationId);
  const msgs = convo?.messages || [];
  el.innerHTML = msgs.map((m, i) => bubbleHtml(m, i, msgs.length)).join("");
  el.scrollTop = el.scrollHeight;
}
function copyMessage(index) {
  const convo = DB.conversations.find(c => c.id === conversationId);
  const m = convo?.messages?.[index]; if (!m) return;
  const done = () => notify("Copied");
  if (navigator.clipboard?.writeText) navigator.clipboard.writeText(m.content).then(done).catch(() => fallbackCopy(m.content, done));
  else fallbackCopy(m.content, done);
}
function ensureConvo(firstUserText) {
  let convo = DB.conversations.find(c => c.id === conversationId);
  if (!convo) {
    convo = { id: nextId(DB.conversations), title: firstUserText.slice(0, 60), messages: [], fileIds: [], updated_at: Date.now() };
    DB.conversations.push(convo); conversationId = convo.id;
  }
  return convo;
}
// Shared by sendChat and regenerateLast: streams a reply into the DOM live,
// then saves it. Handles Stop (AbortError keeps partial text) and any error
// by restoring the UI to a usable state rather than leaving it stuck.
async function runAssistantTurn(convo) {
  generating = true; setSendButtonState();
  const box = document.getElementById("messages");
  const bubbleId = "live" + Date.now();
  box.insertAdjacentHTML("beforeend", `<div class="bubble assistant" id="${bubbleId}"><span class="spinner"></span> Thinking...</div>`);
  scrollMessagesToBottom(true);
  const sys = systemPrompt(convo);
  const wantedSearch = state.search;
  currentAbort = new AbortController();
  let streamed = "", started = false;
  try {
    const recent = convo.messages.slice(-30).map(m => ({ role: m.role, content: m.content, parts: state.provider === "gemini" && m.role === "user" ? imagePartsFor(m.imageIds) : [] }));
    const { text: answer, sources } = await callAIStream({
      system: sys, messages: recent, search: wantedSearch, signal: currentAbort.signal,
      onDelta: delta => {
        streamed += delta; started = true;
        const b = document.getElementById(bubbleId);
        if (b) { b.innerHTML = renderText(streamed) + '<span class="caret"></span>'; scrollMessagesToBottom(); }
      },
    });
    if (wantedSearch && !providerInfo().supportsSearch) notify(`Live search isn't available on ${providerInfo().label} — answered from the model's own knowledge instead.`);
    convo.messages.push({ role: "assistant", content: answer || streamed, sources: sources?.length ? sources : undefined });
    convo.updated_at = Date.now();
    persist();
    generating = false; setSendButtonState();
    renderMessages();
  } catch (e) {
    generating = false; setSendButtonState();
    if (e.name === "AbortError") {
      // Keep whatever streamed in before Stop was pressed — don't throw it away.
      convo.messages.push({ role: "assistant", content: streamed || "(stopped before any text arrived)", stopped: true });
      convo.updated_at = Date.now();
      persist(); renderMessages();
      return;
    }
    document.getElementById(bubbleId)?.remove();
    if (started) {
      // We already had partial text on screen when the connection died — keep it rather than erroring it away.
      convo.messages.push({ role: "assistant", content: streamed, stopped: true });
      persist(); renderMessages();
      notify("Connection interrupted: " + e.message);
    } else {
      convo.messages.pop(); // the user message never got an answer at all — don't keep it dangling
      persist();
      box.insertAdjacentHTML("beforeend", `<div class="bubble assistant danger">${esc(e.message)} <button class="action small" onclick="retryLast()">↻ Retry</button></div>`);
      scrollMessagesToBottom(true);
    }
  }
}
async function sendChat() {
  if (generating) return; // Send button turns into Stop while generating; this guards stray double-clicks
  if (!needKey()) return;
  const input = document.getElementById("chatInput"), text = input.value.trim();
  if (!text) return;
  const convo = ensureConvo(text);
  const imageIds = attached.filter(id => DB.files.find(f => f.id === id)?.isImage);
  for (const id of attached) if (!convo.fileIds.includes(id)) convo.fileIds.push(id);
  convo.messages.push({ role: "user", content: text, imageIds });
  convo.updated_at = Date.now();
  renderMessages();
  input.value = ""; autoResize(input);
  if (imageIds.length && state.provider !== "gemini") notify(`${providerInfo().label} can't see images in chat — attached file(s) will be used as text only. Switch to Gemini in Settings for image understanding.`);
  attached = []; const chipEl = document.getElementById("attached"); if (chipEl) chipEl.innerHTML = "";
  await runAssistantTurn(convo);
}
async function regenerateLast() {
  if (generating) return;
  const convo = DB.conversations.find(c => c.id === conversationId); if (!convo) return;
  if (convo.messages[convo.messages.length - 1]?.role === "assistant") convo.messages.pop();
  renderMessages();
  await runAssistantTurn(convo);
}
async function retryLast() {
  if (generating) return;
  const convo = DB.conversations.find(c => c.id === conversationId); if (!convo) return;
  await runAssistantTurn(convo);
}

/* ---------- File reading (in the browser) ---------- */
function loadScript(src) {
  return new Promise((resolve, reject) => {
    if (document.querySelector(`script[src="${src}"]`)) return resolve();
    const s = document.createElement("script"); s.src = src; s.onload = resolve; s.onerror = () => reject(new Error("Couldn't load " + src)); document.head.appendChild(s);
  });
}
async function extractPdf(file) {
  await loadScript("https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.min.js");
  window.pdfjsLib.GlobalWorkerOptions.workerSrc = "https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.worker.min.js";
  const doc = await window.pdfjsLib.getDocument({ data: await file.arrayBuffer() }).promise;
  let out = "";
  for (let i = 1; i <= doc.numPages; i++) { const tc = await (await doc.getPage(i)).getTextContent(); out += tc.items.map(it => it.str).join(" ") + "\n"; }
  return out;
}
async function extractDocx(file) {
  try { await loadScript("https://cdnjs.cloudflare.com/ajax/libs/mammoth/1.4.21/mammoth.browser.min.js"); }
  catch { await loadScript("https://cdn.jsdelivr.net/npm/mammoth@1.7.0/mammoth.browser.min.js"); }
  return (await window.mammoth.extractRawText({ arrayBuffer: await file.arrayBuffer() })).value || "";
}
const TEXT_EXT = /\.(txt|md|markdown|csv|json|py|js|ts|jsx|tsx|html|css|java|c|cpp|h|hpp|cs|php|go|rs|sql|sh|yaml|yml|xml|log|ini|toml)$/i;
// Decides by extension first (mobile browsers often send a blank/wrong MIME type).
async function ingestFile(f) {
  if (f.size > 20 * 1024 * 1024) throw new Error(f.name + " is larger than 20 MB");
  const name = f.name, type = f.type || "";
  const isImage = /^image\//.test(type) || /\.(png|jpe?g|webp|gif)$/i.test(name);
  const rec = { id: nextId(DB.files), name, mime: type || "application/octet-stream", size: f.size, text: "", isImage: false, added: Date.now() };
  if (isImage) {
    if (f.size > 6 * 1024 * 1024) throw new Error(name + ": images must be under 6 MB");
    rec.isImage = true; rec.b64 = await fileToBase64(f);
    if (!/^image\//.test(rec.mime)) rec.mime = /\.png$/i.test(name) ? "image/png" : /\.webp$/i.test(name) ? "image/webp" : /\.gif$/i.test(name) ? "image/gif" : "image/jpeg";
  } else if (/\.pdf$/i.test(name) || type === "application/pdf") rec.text = (await extractPdf(f)).slice(0, 200000);
  else if (/\.docx$/i.test(name) || type.includes("wordprocessingml")) rec.text = (await extractDocx(f)).slice(0, 200000);
  else if (/\.doc$/i.test(name)) throw new Error(name + ": old .doc files aren't supported — save it as .docx or PDF");
  else if (TEXT_EXT.test(name) || /^text\//.test(type) || /json|xml|javascript/.test(type)) rec.text = (await f.text()).slice(0, 200000);
  else throw new Error(name + ": unsupported file type");
  DB.files.unshift(rec); persist();
  return rec;
}
async function attachFromChat() {
  const input = document.getElementById("chatFile");
  for (const f of input.files) {
    try { const rec = await ingestFile(f); attached.push(rec.id); notify("Attached " + rec.name + (!rec.isImage && !rec.text ? " (no text found — it may be a scanned PDF)" : "")); }
    catch (e) { notify(e.message); }
  }
  input.value = ""; chat(document.getElementById("chatInput")?.value || "");
}

/* ---------- Voice input ---------- */
async function transcribeAudio(blob, mime) {
  if (state.provider === "gemini") {
    const { text } = await callGemini(state.model, state.apiKey, { system: null, messages: [{ role: "user", content: "Transcribe this audio verbatim. Reply with ONLY the transcribed text, no commentary.", parts: [{ inline_data: { mime_type: mime, data: await fileToBase64(blob) } }] }], search: false, thinking: false });
    return text;
  }
  if (state.provider === "groq") {
    const fd = new FormData();
    fd.append("file", blob, "audio." + (mime.includes("mp4") ? "mp4" : mime.includes("ogg") ? "ogg" : "webm"));
    fd.append("model", "whisper-large-v3-turbo");
    const d = await apiFetch("https://api.groq.com/openai/v1/audio/transcriptions", { method: "POST", headers: { Authorization: `Bearer ${state.apiKey}` }, body: fd }, "groq");
    return d.text || "";
  }
  throw new Error(`Voice input isn't available on ${providerInfo().label}.`);
}
let mediaRecorder = null, audioChunks = [];
function pickMime() { for (const c of ["audio/webm;codecs=opus", "audio/webm", "audio/mp4", "audio/aac", "audio/ogg"]) if (window.MediaRecorder?.isTypeSupported?.(c)) return c; return ""; }
async function toggleRecording() {
  if (mediaRecorder && mediaRecorder.state === "recording") { mediaRecorder.stop(); return; }
  if (!needKey()) return;
  if (!providerInfo().supportsVoice) { notify(`Voice input isn't available on ${providerInfo().label} — switch to Gemini or Groq in Settings.`); return; }
  try {
    const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    const mimeChoice = pickMime();
    mediaRecorder = mimeChoice ? new MediaRecorder(stream, { mimeType: mimeChoice }) : new MediaRecorder(stream);
    audioChunks = [];
    mediaRecorder.ondataavailable = e => { if (e.data.size) audioChunks.push(e.data); };
    mediaRecorder.onstop = async () => {
      stream.getTracks().forEach(t => t.stop());
      document.getElementById("micBtn")?.classList.remove("recording");
      const mime = (mediaRecorder.mimeType || mimeChoice || "audio/webm").split(";")[0];
      const blob = new Blob(audioChunks, { type: mime });
      if (blob.size < 500) { notify("Recording was too short"); return; }
      const input = document.getElementById("chatInput"); if (!input) return;
      const original = input.value;
      input.value = original + (original ? " " : "") + "(transcribing...)";
      try {
        const text = await transcribeAudio(blob, mime);
        input.value = (original + " " + text.trim()).trim(); input.focus();
      } catch (e) { input.value = original; notify("Transcription failed: " + e.message); }
    };
    mediaRecorder.start();
    document.getElementById("micBtn")?.classList.add("recording");
  } catch { notify("Microphone access denied or unavailable"); }
}

/* ---------- Projects / Memory ---------- */
function projects() {
  view.innerHTML = `<div class="sectionTitle"><h2>Projects</h2><p>Separate workspaces for different goals.</p></div><div class="list"><div class="card"><div class="formRow"><input class="input" id="pn" placeholder="Project name"><button class="action" onclick="addProject()">+ Create</button></div><label class="label">Description</label><input class="input" id="pd" placeholder="Optional project context"></div>${DB.projects.length ? DB.projects.map(x => `<div class="card"><b>${esc(x.name)}</b><p>${esc(x.description || "No description")}</p><button class="action danger" onclick="delProject(${x.id})">✕ Delete</button></div>`).join("") : `<div class="drop">No projects yet.</div>`}</div>`;
}
function addProject() { const name = document.getElementById("pn").value.trim(); if (!name) return; DB.projects.unshift({ id: nextId(DB.projects), name, description: document.getElementById("pd").value.trim() }); persist(); notify("Project created"); projects(); }
function delProject(id) { DB.projects = DB.projects.filter(x => x.id !== id); persist(); projects(); }
function memory() {
  view.innerHTML = `<div class="sectionTitle"><h2>Memory</h2><p>Facts OPTIMUS uses in every conversation.</p></div><div class="list"><div class="card"><div class="formRow"><input class="input" id="mem" placeholder="e.g. I study software engineering and prefer Python"><button class="action" onclick="addMem()">◇ Remember</button></div></div>${DB.memories.length ? DB.memories.map(x => `<div class="card">${esc(x.content)} <button class="action danger" onclick="delMem(${x.id})">✕ Delete</button></div>`).join("") : `<div class="drop">No memories saved.</div>`}</div>`;
}
function addMem() { const v = document.getElementById("mem").value.trim(); if (!v) return; DB.memories.unshift({ id: nextId(DB.memories), content: v }); persist(); memory(); notify("Memory saved"); }
function delMem(id) { DB.memories = DB.memories.filter(x => x.id !== id); persist(); memory(); }

/* ---------- Files ---------- */
function files() {
  view.innerHTML = `<div class="sectionTitle"><h2>Files</h2><p>PDF, Word (.docx), text, code and images. Text is read in your browser — nothing is uploaded to a server. Attach them in Chat. You can edit extracted text before it's used.</p></div><div class="list"><div class="card"><input type="file" id="file" multiple accept="${ACCEPT}"><button class="action" onclick="uploadFiles()">+ Add</button><p>Up to 20 MB per file (images up to 6 MB).</p></div>${DB.files.length ? DB.files.map(x => `<div class="card"><div class="fileLine"><div><b>${esc(x.name)}</b><p>${esc(x.mime)} · ${Math.round(x.size / 1024)} KB · ${x.isImage ? "image" : x.text ? x.text.length + " characters read" : "no text found"}</p></div><div>${x.text ? `<button class="action" onclick="toggleEdit(${x.id})">✎ View / Edit</button> ` : ""}<button class="action danger" onclick="delFile(${x.id})">✕ Delete</button></div></div><div id="edit-${x.id}" style="display:none;margin-top:10px"><textarea class="textarea" id="ta-${x.id}" style="min-height:180px">${esc(x.text)}</textarea><button class="action" onclick="saveEdit(${x.id})">✓ Save edits</button></div></div>`).join("") : `<div class="drop">No files yet.</div>`}</div>`;
}
async function uploadFiles() {
  const input = document.getElementById("file"); if (!input.files.length) return;
  for (const f of input.files) { try { const r = await ingestFile(f); notify("Added " + r.name); } catch (e) { notify(e.message); } }
  files();
}
function toggleEdit(id) { const w = document.getElementById("edit-" + id); w.style.display = w.style.display === "none" ? "block" : "none"; }
function saveEdit(id) { const f = DB.files.find(x => x.id === id); if (!f) return; f.text = document.getElementById("ta-" + id).value; persist(); notify("Saved — OPTIMUS will use your edited text"); }
function delFile(id) { DB.files = DB.files.filter(x => x.id !== id); persist(); files(); }

/* ---------- Agents (AI-generated plans) ---------- */
function agents() {
  view.innerHTML = `<div class="sectionTitle"><h2>Agents</h2><p>Turn a goal into a clear, step-by-step plan.</p></div><div class="list"><div class="card"><textarea class="textarea" id="goal" placeholder="Build a portfolio website for my software projects"></textarea><button class="action" onclick="makePlan()">⌁ Create Plan</button></div><div id="plan"></div></div>`;
}
async function makePlan() {
  if (!needKey()) return;
  const goal = document.getElementById("goal").value.trim(); if (!goal) return;
  const box = document.getElementById("plan");
  box.innerHTML = `<div class="card"><span class="spinner"></span> Planning...</div>`;
  try {
    const { text } = await callAI({ system: "You turn goals into practical plans. Output: a one-line summary, then numbered steps (each with a short title and 1-2 sentences), then a 'Risks & checks' list, then 'First action to take today'. Be concrete and realistic.", messages: [{ role: "user", content: goal }] });
    box.innerHTML = `<div class="card">${renderText(text)}</div>`;
  } catch (e) { box.innerHTML = `<div class="card danger">${esc(e.message)}</div>`; }
}

/* ---------- Research ---------- */
function research() {
  if (!needKey()) return;
  const note = providerInfo().supportsSearch ? "Uses Google Search grounding, so answers reflect current information — with sources." : `${providerInfo().label} doesn't support live search grounding, so this will answer from the model's own knowledge. Switch to Gemini in Settings for grounded, sourced answers.`;
  view.innerHTML = `<div class="sectionTitle"><h2>Deep Research</h2><p>${note}</p></div><div class="list"><div class="card"><textarea class="textarea" id="rq" placeholder="What should OPTIMUS research?"></textarea><button class="action" onclick="runResearch()">⌕ Research</button></div><div id="rr"></div></div>`;
}
async function runResearch() {
  const q = document.getElementById("rq").value.trim(); if (!q) return;
  const box = document.getElementById("rr");
  box.innerHTML = `<div class="card"><span class="spinner"></span> Researching...</div>`;
  try {
    const { text, sources } = await callAI({ system: `Today is ${new Date().toDateString()}. Research the question${providerInfo().supportsSearch ? " using search" : ""}. Give a clear, well-organized answer, note disagreements between sources if any, and say what is uncertain.`, messages: [{ role: "user", content: q }], search: true });
    box.innerHTML = `<div class="card">${renderText(text || "No answer returned.")}${sourcesHtml(sources)}</div>`;
  } catch (e) { box.innerHTML = `<div class="card danger">${esc(e.message)}</div>`; }
}

/* ---------- Image generation ----------
   This is a SEPARATE provider+key from the chat one, on purpose — image
   generation needs different provider support than text chat does, so you
   can e.g. chat on Groq while generating images on Gemini, without the two
   fighting over one key slot. */
const IMAGE_PROVIDERS = {
  gemini: { label: "Google Gemini", keyUrl: "https://aistudio.google.com/apikey", defaultModel: "gemini-3.1-flash-image" },
  openrouter: { label: "OpenRouter", keyUrl: "https://openrouter.ai/keys", defaultModel: "google/gemini-3.1-flash-image" },
};
function imgState() {
  const provider = localStorage.getItem("optimus_img_provider") || "gemini";
  return { provider, apiKey: localStorage.getItem("optimus_img_key_" + provider) || "", model: localStorage.getItem("optimus_img_model_" + provider) || IMAGE_PROVIDERS[provider].defaultModel };
}
function saveImageSettings() {
  const provider = document.getElementById("imgProvider").value;
  const key = document.getElementById("imgKey").value.trim();
  const model = document.getElementById("imgModel").value.trim() || IMAGE_PROVIDERS[provider].defaultModel;
  localStorage.setItem("optimus_img_provider", provider);
  localStorage.setItem("optimus_img_key_" + provider, key);
  localStorage.setItem("optimus_img_model_" + provider, model);
  notify("Image settings saved");
  createImage();
}
function createImage() {
  const refs = DB.files.filter(f => f.isImage);
  const img = imgState();
  view.innerHTML = `<div class="sectionTitle"><h2>Create Image</h2><p>Uses its own provider and key, separate from Chat — set it up once below.</p></div><div class="list">
  <div class="card">
    <label class="label">Image provider</label>
    <select class="input" id="imgProvider" onchange="createImage()">${Object.entries(IMAGE_PROVIDERS).map(([id, p]) => `<option value="${id}" ${id === img.provider ? "selected" : ""}>${esc(p.label)}</option>`).join("")}</select>
    <label class="label">${esc(IMAGE_PROVIDERS[img.provider].label)} API key</label>
    <input class="input" id="imgKey" type="password" autocomplete="off" value="${esc(img.apiKey)}" placeholder="Paste a free key here">
    <label class="label">Model</label>
    <input class="input" id="imgModel" value="${esc(img.model)}">
    <button class="action" style="margin-top:10px" onclick="saveImageSettings()">✓ Save</button>
    <p class="muted" style="font-size:12px;margin-top:8px">Free key: <a style="color:var(--accent)" href="${IMAGE_PROVIDERS[img.provider].keyUrl}" target="_blank" rel="noopener">${IMAGE_PROVIDERS[img.provider].keyUrl.replace("https://", "")}</a></p>
  </div>
  <div class="card"><textarea class="textarea" id="ip" placeholder="Describe the image you want..."></textarea>${refs.length ? `<label class="label">Reference image (optional)</label><select class="input" id="iref"><option value="">None</option>${refs.map(f => `<option value="${f.id}">${esc(f.name)}</option>`).join("")}</select>` : ""}<button class="action" style="margin-top:12px" onclick="generateImage()">▤ Generate</button></div>
  <div id="imageResult"></div>
  ${DB.images.length ? `<div class="sectionHead" style="margin:20px 0 4px"><h2>Your images</h2></div><div class="imgGrid">${DB.images.map(x => `<div class="card" style="padding:8px;min-height:auto"><img src="${x.dataUrl}" alt="${esc(x.prompt)}"><small class="muted">${esc(x.prompt.slice(0, 50))}</small><br><a class="danger" href="#" onclick="delImage(${x.id});return false">✕ Delete</a> · <a href="${x.dataUrl}" download="optimus-${x.id}.png" style="color:var(--accent)">⇩ Save</a></div>`).join("")}</div>` : ""}
  </div>`;
}
async function generateImage() {
  const prompt = document.getElementById("ip").value.trim(); if (!prompt) return;
  const provider = document.getElementById("imgProvider").value;
  const key = document.getElementById("imgKey").value.trim();
  const model = document.getElementById("imgModel").value.trim() || IMAGE_PROVIDERS[provider].defaultModel;
  if (!key) { notify(`Add a ${IMAGE_PROVIDERS[provider].label} key above first`); return; }
  const refId = +(document.getElementById("iref")?.value || 0);
  const box = document.getElementById("imageResult");
  box.innerHTML = `<div class="card"><span class="spinner"></span> Generating image...</div>`;
  try {
    let dataUrl;
    if (provider === "gemini") {
      const d = await apiFetch(`https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`, { method: "POST", headers: { "x-goog-api-key": key, "Content-Type": "application/json" }, body: JSON.stringify({ contents: [{ role: "user", parts: [{ text: prompt }, ...imagePartsFor(refId ? [refId] : [])] }], generationConfig: { responseModalities: ["IMAGE"] } }) }, "gemini");
      const part = (d?.candidates?.[0]?.content?.parts || []).find(p => p.inlineData || p.inline_data);
      if (!part) throw new Error("No image came back. Your key/model may not have image-generation access, or the prompt was blocked. Try rewording.");
      const inl = part.inlineData || part.inline_data;
      dataUrl = `data:${inl.mimeType || inl.mime_type || "image/png"};base64,${inl.data}`;
    } else if (provider === "openrouter") {
      const refParts = refId ? DB.files.filter(f => f.id === refId && f.isImage).map(f => ({ type: "image_url", image_url: { url: `data:${f.mime};base64,${f.b64}` } })) : [];
      const d = await apiFetch("https://openrouter.ai/api/v1/chat/completions", { method: "POST", headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" }, body: JSON.stringify({ model, modalities: ["image", "text"], messages: [{ role: "user", content: [{ type: "text", text: prompt }, ...refParts] }] }) }, "openrouter");
      const images = d?.choices?.[0]?.message?.images;
      if (!images?.length) throw new Error("No image came back. Make sure the model you entered supports image output (check openrouter.ai/models?output_modalities=image), and that the prompt wasn't blocked.");
      dataUrl = images[0]?.image_url?.url || images[0]?.url;
      if (!dataUrl) throw new Error("OpenRouter returned an image in a format OPTIMUS doesn't recognize yet.");
    } else throw new Error("Unknown image provider.");
    DB.images.unshift({ id: nextId(DB.images), prompt, dataUrl, created: Date.now() });
    DB.images = DB.images.slice(0, 24); persist(); createImage();
  } catch (e) { box.innerHTML = `<div class="card danger">${esc(e.message)}</div>`; }
}
function delImage(id) { DB.images = DB.images.filter(x => x.id !== id); persist(); createImage(); }

/* ---------- Settings ---------- */
function settings() {
  const info = providerInfo();
  view.innerHTML = `<div class="settings"><div class="sectionTitle"><h2>Settings</h2><p>Bring your own free API key — pick whichever provider you like.</p></div>
  <div class="card"><label class="label">Your name</label><input class="input" id="userName" value="${esc(state.name)}" placeholder="Shown in the sidebar and greeting"></div>
  <div class="card" style="margin-top:12px"><label class="label">AI Provider</label>
  <select class="input" id="providerSel" onchange="switchProvider(this.value)">${Object.entries(PROVIDERS).map(([id, p]) => `<option value="${id}" ${id === state.provider ? "selected" : ""}>${esc(p.label)}</option>`).join("")}</select>
  <div class="featureRow">${info.supportsSearch ? '<span class="tag">✓ Live search</span>' : '<span class="tag off">✕ Live search</span>'}${info.supportsImage ? '<span class="tag">✓ Image generation</span>' : '<span class="tag off">✕ Image generation</span>'}${info.supportsVoice ? '<span class="tag">✓ Voice input</span>' : '<span class="tag off">✕ Voice input</span>'}</div>
  <label class="label">${esc(info.label)} API Key</label><input class="input" id="apiKey" type="password" autocomplete="off" value="${esc(state.apiKey)}" placeholder="Paste your key here">
  <label class="label">Model</label><select class="input" id="model"><option>${esc(state.model)}</option></select>
  <div class="formRow" style="margin-top:12px;flex-wrap:wrap"><button class="action" onclick="saveSettings()">✓ Save on this device</button><button class="action" onclick="loadModels()">⟳ Load available models</button><button class="action" onclick="testConnection()">⚡ Test connection</button><button class="action danger" onclick="clearKey()">✕ Clear key</button></div>
  <p id="testResult" class="muted" style="font-size:12px;min-height:16px"></p>
  <p class="muted" style="font-size:12px">${info.keyHint} — <a style="color:var(--accent)" href="${info.keyUrl}" target="_blank" rel="noopener">${info.keyUrl.replace("https://", "")}</a>.</p></div>
  <div class="card" style="margin-top:12px"><label class="label">Appearance</label><div class="formRow"><button class="action ${state.theme !== "light" ? "selected" : ""}" onclick="setTheme('dark')">● Dark</button><button class="action ${state.theme === "light" ? "selected" : ""}" onclick="setTheme('light')">○ Light</button></div></div>
  <div class="notice" style="margin-top:12px">🔒 Each key is stored only in this browser (one slot per provider, so switching providers doesn't lose the others) and is sent only to that provider's own servers. There is no OPTIMUS server in between. Anyone using this same browser profile can see your keys, so don't use this on a shared computer. Chats, files, memory and images also live only in this browser — use Export below to back them up.</div>
  <div class="card" style="margin-top:12px"><b>Your data</b><p>${DB.conversations.length} chats · ${DB.files.length} files · ${DB.memories.length} memories · ${DB.images.length} images${storageOk ? "" : " · ⚠ browser storage unavailable (private/incognito mode?) — data won't be kept after you close this tab"}</p><div class="formRow" style="flex-wrap:wrap"><button class="action" onclick="exportData()">⇩ Export (.json)</button><button class="action" onclick="document.getElementById('imp').click()">⇧ Import</button><input type="file" id="imp" accept=".json" style="display:none" onchange="importData(this)"><button class="action danger" onclick="resetData()">⌫ Erase everything</button></div></div></div>`;
}
function setTheme(t) {
  state.theme = t;
  localStorage.setItem("optimus_theme", t);
  document.documentElement.setAttribute("data-theme", t);
  const tgl = document.getElementById("themeToggle"); if (tgl) tgl.textContent = t === "light" ? "◑" : "◐";
  if (document.querySelector(".settings")) settings();
}
function toggleTheme() { setTheme(state.theme === "light" ? "dark" : "light"); }
async function loadModels() {
  const key = document.getElementById("apiKey").value.trim() || state.apiKey;
  if (!key) { notify("Add your API key first"); return; }
  const sel = document.getElementById("model");
  sel.innerHTML = `<option>Loading…</option>`;
  try {
    let names = [];
    if (state.provider === "gemini") {
      const r = await fetch("https://generativelanguage.googleapis.com/v1beta/models?pageSize=200", { headers: { "x-goog-api-key": key } });
      const d = await r.json(); if (!r.ok) throw new Error(friendlyError(d?.error?.message || "Could not load models", r.status, "gemini"));
      names = d.models.filter(m => (m.supportedGenerationMethods || []).includes("generateContent") && /gemini/i.test(m.name) && !/image|tts|embed|live|audio/i.test(m.name)).map(m => m.name.replace("models/", ""));
    } else if (state.provider === "groq") {
      const d = await apiFetch("https://api.groq.com/openai/v1/models", { headers: { Authorization: `Bearer ${key}` } }, "groq");
      names = (d.data || []).map(m => m.id).filter(id => !/whisper|guard|tts/i.test(id)).sort();
    } else if (state.provider === "openrouter") {
      const d = await apiFetch("https://openrouter.ai/api/v1/models", {}, "openrouter");
      names = (d.data || []).filter(m => m.id.endsWith(":free")).map(m => m.id).sort();
      if (!names.length) names = (d.data || []).slice(0, 100).map(m => m.id).sort();
    }
    if (!names.length) throw new Error("No models returned for this key.");
    sel.innerHTML = names.map(n => `<option ${n === state.model ? "selected" : ""}>${esc(n)}</option>`).join("");
    notify(names.length + " models loaded");
  } catch (e) { sel.innerHTML = `<option>${esc(state.model)}</option>`; notify(e.message); }
}
function exportData() {
  const a = document.createElement("a");
  a.href = URL.createObjectURL(new Blob([JSON.stringify(DB)], { type: "application/json" }));
  a.download = "optimus-backup.json"; a.click();
}
async function importData(inp) {
  try { const d = JSON.parse(await inp.files[0].text()); DB = Object.assign({ conversations: [], memories: [], projects: [], files: [], images: [] }, d); persist(); notify("Imported"); settings(); }
  catch { notify("That file isn't a valid OPTIMUS backup"); }
}
function resetData() {
  if (!confirm("Delete ALL chats, files, memory, projects and images stored in this browser?")) return;
  DB = { conversations: [], memories: [], projects: [], files: [], images: [] }; conversationId = null; attached = []; persist(); notify("Erased"); page("home");
}

// Last-resort safety net: any error that isn't already caught (a bug in a
// button handler, a rejected promise nobody awaited) shows a toast instead
// of silently doing nothing or leaving the UI stuck.
let lastErrorNotify = 0;
function notifyErrorOnce(msg) {
  const now = Date.now();
  if (now - lastErrorNotify < 1500) return; // avoid a storm of toasts from one failure
  lastErrorNotify = now;
  notify("Something went wrong: " + msg);
}
window.addEventListener("error", e => notifyErrorOnce(e.error?.message || e.message || "unexpected error"));
window.addEventListener("unhandledrejection", e => notifyErrorOnce(e.reason?.message || String(e.reason)));
window.addEventListener("offline", () => notify("You're offline — OPTIMUS needs internet to reach the AI provider."));
window.addEventListener("online", () => notify("Back online"));

(async function start() {
  try {
    await initStorage();
    if (!storageOk) notify("Private/incognito mode detected — your data won't be saved after this tab closes.");
    document.getElementById("modelPill").textContent = "● " + state.model;
    document.getElementById("modelPill").onclick = () => page("settings");
    const tgl = document.getElementById("themeToggle"); if (tgl) tgl.textContent = state.theme === "light" ? "◑" : "◐";
    applyProfile();
    page("home");
  } catch (err) {
    console.error("OPTIMUS failed to start:", err);
    view.innerHTML = `<div class="sectionTitle"><h2>OPTIMUS couldn't start</h2><p>Try reloading the page. If this keeps happening, your browser may be blocking local storage — try a normal (non-private) window.</p></div><div class="card danger">${esc(err?.message || String(err))}</div>`;
  }
})();
