# OPTIMUS — Web (static, no backend, free hosting)

Pure HTML/CSS/JS. No server, no database, no Python. Deploys free on GitHub
Pages, Netlify, or Cloudflare Pages — just these files.

## Why this version exists
The FastAPI version needs a Python host (Heroku/Render/HF Spaces). This
version needs nothing but static file hosting, which is what GitHub Pages
actually gives you for free. Everything runs in the visitor's own browser.

## Deploy (GitHub Pages)
1. Push this folder's contents to a GitHub repo.
2. Settings → Pages → Deploy from a branch → `main`, `/ (root)` → Save.
3. Open the `https://<you>.github.io/<repo>/` link it gives you.

Netlify: drag this folder onto app.netlify.com/drop, or connect the repo
with an empty build command and `/` as the publish directory.

## What changed in this pass
- **Fixed the 503 error.** A transient "having trouble right now" from a provider is now retried automatically once before it ever reaches you as an error.
- **Old or new model, same code path.** Gemini-model-specific parameters (like thinking mode) are sent only when the model looks like it supports them, and if a model still rejects it, OPTIMUS automatically retries once without it — so a brand-new model or an older one you type in by hand both just work, instead of the app assuming one fixed API shape forever.
- **Responses now stream in live**, token by token, like ChatGPT — for Gemini, Groq, and OpenRouter alike.
- **Stop button**: the send button turns into a Stop button while a reply is generating. Stopping mid-stream keeps whatever text had already arrived instead of discarding it.
- **Regenerate** the last reply, and **Copy** any message, with a button under each bubble.
- **Rename a chat** from the pencil icon next to its title.
- Auto-resizing message box, a "↓ New content" button if you've scrolled up while a reply is still streaming, and full markdown rendering (headings, ordered/unordered lists, blockquotes, tables, bold/italic) instead of the previous flat line-by-line text.
- **Icons added throughout** — every button in Settings, Files, Memory, Projects, Images, and the chat mode/search bar now has one, not just the sidebar.
- **Light/dark theme toggle** (header, top right), proper typography (Inter for UI text, JetBrains Mono for code), and every color in the interface was checked against both themes — a few were hardcoded for dark mode only and went invisible in light mode (e.g. a literal white-on-white link); all of those are fixed now.
- **Image generation has its own provider and key**, completely separate from the Chat provider. Go to Images → pick Google Gemini or OpenRouter, paste a key just for that. You can chat on Groq and generate images on Gemini at the same time without them conflicting.
- Every reachable code path was run through an automated test (DOM rendering, every button, every provider switch, every delete/edit flow, simulated network failures, a realistic mid-stream Stop-button abort) with zero errors remaining, then re-verified visually in a real headless Chrome browser at desktop/iPhone/Android sizes in both themes. Details in Testing below.

## Choose your AI provider
Settings now has a provider dropdown:
- **Google Gemini** — free key at aistudio.google.com/apikey. Only one with live search grounding, image generation, and voice input.
- **Groq** — free key at console.groq.com/keys. Very fast responses, supports voice input (Whisper), no search grounding or image generation.
- **OpenRouter** — free key at openrouter.ai/keys. Access to many free community models, text only.

Each provider's key is stored separately, so switching providers in Settings
doesn't erase the others — come back to Gemini later and your key is still
there. A **Test connection** button in Settings checks a key actually works
before you rely on it.

If a feature isn't supported by the provider you've picked (e.g. live search
on Groq), OPTIMUS tells you in plain language and quietly falls back instead
of throwing a raw error — image generation always uses a Gemini key
specifically (paste one just for that, even if you're chatting with Groq).

## Built for "no errors"
- Every page render is wrapped so a bug in one screen shows a "Try again /
  Go home" card instead of a blank app.
- Every AI call normalizes provider error codes (401/403/429/5xx) into a
  plain-English message instead of raw JSON.
- If a reply fails, your typed message is restored instead of lost.
- Global handlers catch anything that slips through and show a toast rather
  than failing silently.
- Offline detection warns before a request is even attempted.
- Private/incognito mode (where storage may not persist) is detected and
  flagged up front.

## Data & privacy
Chats, files, memory, and generated images are stored in this browser's
IndexedDB — nothing is sent to any OPTIMUS server, because there isn't one.
Use Settings → Export to back up your data as a `.json` file, and Import to
restore it (or move it to another browser/device).

## Testing
Before shipping this build it was run through:
1. A headless DOM test (jsdom) that renders every page, switches every provider, toggles the theme, adds/edits/deletes every data type (chats, memory, projects, files, images), and runs every AI-call path — including a **simulated live token stream** for both the Gemini and OpenAI-compatible (Groq/OpenRouter) response shapes, a **realistic mid-stream Stop-button abort** (the mock stream honors the same AbortSignal timing a real browser fetch does, so this actually proves the Stop button interrupts generation rather than assuming it), and a simulated failing network to confirm errors are caught and shown as a friendly message with a Retry button, never a crash. It also feeds the renderer the exact `\r\n` and cut-off-code-fence cases that broke a previous version, plus tables/lists/blockquotes/headings.
2. A real headless Chrome pass (puppeteer) rendering the live app at desktop (1440px), iPhone (390px), and Android (412px) widths, in both dark and light theme, including a live mid-stream screenshot — checking for any browser console or JS errors. Result: zero console errors, zero page errors, on all of them. This pass is also what caught the light-theme color bugs (hardcoded colors meant only for dark mode) before they shipped.
Neither test can call the real Gemini/Groq/OpenRouter APIs from this environment, so a genuinely invalid key or a provider outage can still surface an error — but it'll be the friendly, specific message built for that case, with automatic retry already attempted, not a broken screen.

## Limits of a backend-free app
- No shared/multi-device sync — it's per-browser.
- PDF/DOCX text extraction happens in-browser (pdf.js / mammoth.js, loaded
  from cdnjs on first use).
- Image generation needs a Gemini key specifically; other providers here
  don't offer native image output yet.
