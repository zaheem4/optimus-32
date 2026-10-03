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
- **Interface rebuilt minimal.** Removed the decorative glow/glass effects, cut it down to flat surfaces, one accent color, and consistent spacing. Tested on real desktop, iPhone, and Android viewports in an actual browser (see Testing below) — not just described, actually rendered and screenshotted.
- **Image generation now has its own provider and key**, completely separate from the Chat provider. Go to Images → pick Google Gemini or OpenRouter, paste a key just for that. You can chat on Groq and generate images on Gemini at the same time without them conflicting — each is its own slot.
- Every reachable code path was run through an automated test (DOM rendering, every button, every provider switch, every delete/edit flow, simulated network failures) with zero errors remaining. Details in Testing below.

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
1. A headless DOM test (jsdom) that renders every page, switches every provider, adds/edits/deletes every data type (chats, memory, projects, files, images), runs every AI-call path against a simulated failing network to confirm errors are caught and shown as a friendly message (never a crash), and feeds the code-block renderer the exact `\r\n` and cut-off-fence cases that broke the previous version.
2. A real headless Chrome pass (puppeteer) rendering the live app at desktop (1440px), iPhone (390px), and Android (412px) widths, checking for any browser console or JS errors. Result: zero console errors, zero page errors, on all three.
Neither test can call the real Gemini/Groq/OpenRouter APIs from this environment, so a genuinely invalid key or a provider outage can still surface an error — but it'll be the friendly, specific message built for that case, not a broken screen.

## Limits of a backend-free app
- No shared/multi-device sync — it's per-browser.
- PDF/DOCX text extraction happens in-browser (pdf.js / mammoth.js, loaded
  from cdnjs on first use).
- Image generation needs a Gemini key specifically; other providers here
  don't offer native image output yet.
