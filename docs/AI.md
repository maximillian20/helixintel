# AI in Helix: setup, limits and how it stays honest

Helix can draft summaries, answer questions about your records, suggest related reports and draft bulletins **without any paid AI service and without installing anything on your computer**. There are two ways to run it:

* **Option A, hosted (no install): Cloudflare Workers AI, Free plan.** You create a free Cloudflare account and paste three settings into Render. Nothing runs on your computer.
* **Option B, your own computer: Ollama.** For when records must never leave your machine. Needs an install, see the end of the setup section.

If AI is not set up, or the free allowance is used up, the app says **"AI setup required"** or **"Daily free limit reached"** and everything else keeps working. No AI result is ever invented to fill the gap.

## Option A: set up the hosted route (no install)

1. Create a free account at cloudflare.com. Cloudflare may ask for a payment card when you sign up; I could not verify that, so check at signup. If it insists on one and you do not want to give it, use Option B.
2. In the Cloudflare dashboard copy your **Account ID** (32 characters).
3. Create an **API token** (My Profile, API Tokens, Create Token) with the permission **Workers AI**. Copy it once; Cloudflare will not show it again.
4. In Render open the service, Environment, and add:
   * `AI_PROVIDER` = `cloudflare`
   * `AI_CLOUDFLARE_ACCOUNT_ID` = your Account ID
   * `AI_API_KEY` = the token
   * optional: `AI_MODEL` (see below) and `AI_ALLOW_PRIVATE_RECORDS` (see below)
   Save. Render redeploys.
5. Open **Ask Helix**. The banner should say *AI ready* and name the free plan.

### What the free plan means (from Cloudflare's documentation)

* **10,000 "neurons" a day, free.** On the Free plan Cloudflare stops answering when the allowance is used up; it does not charge. The allowance resets at 00:00 UTC. Helix then shows "Daily free limit reached" and stops sending requests until the reset. Staying on the free plan is your responsibility: do not upgrade the Cloudflare account to the Paid plan if you want a hard stop (the Paid plan bills about $0.011 per 1,000 neurons).
* **Data handling.** Cloudflare states that it does not train on Workers AI customer content and does not keep inputs or outputs for standard requests. Turning on Cloudflare's AI Gateway logging or caching is an exception; do not route Helix through it.
* **How many questions that is.** Cloudflare prices per token. My own arithmetic, not a measurement: with the default 70B model roughly 55 questions a day, with a small model roughly 340. Set `AI_MODEL=@cf/qwen/qwen3-30b-a3b-fp8` for more questions per day (I have not confirmed how it handles Helix's structured output; try it and read the answers), or `@cf/meta/llama-3.1-8b-instruct-fp8-fast` for the cheapest option. The default is `@cf/meta/llama-3.3-70b-instruct-fp8-fast`.
* **Automatic summaries of new reports are off by default** on this route, so they do not use up the allowance. Set `AI_AUTO_ENRICH=critical-high` to turn them on.

### Privacy: your private records stay out by default

Cloudflare is a third party. Unless you say otherwise, Helix therefore sends it **public report text only** (headline and summary). Your incidents, assessments, places and exposure data are not retrieved, not put in prompts, and the features that need them (incident and country assistants, bulletins drafted from an incident or country, market explanations of an incident) show "needs private records" instead of running. Ask Helix, report summaries, related reports, bulletins drafted from reports and map filters work.

If you accept sending private records to Cloudflare, set `AI_ALLOW_PRIVATE_RECORDS=1`. The Settings panel in Ask Helix shows which mode is active.

### Not verified

I could not test against the real Cloudflare service from the build environment. These items are unconfirmed: whether signup needs a card; the exact wording of the daily-limit error (Helix detects it by pattern, and a bare "too many requests" is treated as "busy, try again"); whether the default model always honours the JSON schema (Helix validates every answer and retries once, then reports a failure rather than guessing); the per-question estimates above. Other free hosted services (Groq, Gemini, OpenRouter) were not checked and are not built in.

## Option B: on your own computer (Ollama)

### What it costs

* **Model access: free.** The default model (`qwen3:4b`, Apache-2.0 licence) is open-weight.
* **You still pay in hardware and electricity.** The computer has to be on while people use AI features. A laptop is fine for one analyst; it is slow without a graphics card (expect tens of seconds to a few minutes per answer on a CPU).
* **Hosting stays as it is.** Render's free instance cannot run a model, so it never tries. The Render server only forwards requests to your computer.
* **Paid providers are refused by the app on purpose (`api.openai.com`, `api.anthropic.com`, and similar addresses are rejected at start-up). The only hosted address the app will use is Cloudflare Workers AI, built from your Account ID.

## Which model

| Computer | Suggested model | Notes |
|---|---|---|
| Laptop or desktop, 8 GB RAM, no GPU | `qwen3:4b` (about 2.5 GB, the default) | Works; slow. Good for summaries, short answers. |
| 16 GB RAM, or a GPU with 8 GB memory | `qwen3:8b` (about 5.2 GB) | Better instruction-following and non-English text. Set `AI_MODEL=qwen3:8b`. |

I could not test real model quality in the build environment (no GPU, no model, no internet). Run `npm run ai:eval` on your own computer to check your model against the built-in checks, then read the sample answers yourself.

## Setup, step by step

You need a Windows, macOS or Linux computer that stays on while you use AI, and Node.js 22 or newer.

1. **Install Ollama** from ollama.com and start it.
2. **Download the model** (one time, about 2.5 GB): `ollama pull qwen3:4b`
3. **Create a secret key** (any long random text), for example: `node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"`. Keep it private. It lives only on your computer and in Render's environment settings; never in the code.
4. **Start the gateway** from this project's folder: `AI_API_KEY=<your key> npm run ai:gateway` (on Windows PowerShell: `$env:AI_API_KEY="<your key>"; npm run ai:gateway`). It listens on `127.0.0.1:8787`, checks the key on every request, and forwards only the two calls Helix needs. Ollama itself is never exposed.
5. **Give Render a way in with an encrypted tunnel.** Install `cloudflared` and create a *named* tunnel to `http://127.0.0.1:8787` (Cloudflare Zero Trust, free plan; follow Cloudflare's "Create a locally-managed tunnel" guide). This gives a stable `https://…` address. A "Quick Tunnel" also works for a test but its address changes every time, so it is not suitable for daily use.
6. **Tell Helix.** In Render, open the service, Environment, and add:
   * `AI_BASE_URL` = your tunnel address (must start with `https://`)
   * `AI_API_KEY` = the same key as step 3
   * `AI_MODEL` = `qwen3:4b` (or `qwen3:8b`)
   Save. Render redeploys.
7. Open **Ask Helix** in the app. The banner should say *AI ready*. If not, it tells you which step is missing (not set up, computer unreachable, or model not downloaded).

Running everything on one computer (no Render) needs only `AI_BASE_URL=http://127.0.0.1:11434` and no key.

### Settings (all optional)

`AI_ENABLED=0` switches AI off for everyone. `AI_AUTO_ENRICH` is `off`, `critical-high` (default) or `all`: whether new reports are summarised automatically, only while the model is idle. `AI_TIMEOUT_MS`, `AI_CONCURRENCY` (default 1), `AI_QUEUE_LIMIT`, `AI_NUM_CTX`, `AI_MAX_OUTPUT_TOKENS` tune speed and memory. Each person can also switch AI off for their own browser in Ask Helix, Settings.

## What you get

* **Ask Helix**: ask in plain words. Filters (time, country, severity, review state, watchlist) are applied *before* retrieval, from your wording and the controls. Each statement is labelled *Reported*, *Corroborated*, *AI interpretation*, *Conflicting accounts* or *Unknown*, links to numbered sources, and shows dates, how fresh the data is, and whether only a headline or a summary was used.
* **Report summaries** in the feed: summary, key facts, type, countries and organisations named, event date, translation. The AI's severity suggestion is shown beside, never instead of, the feed severity or your override.
* **Related reports** (no model needed): by country, time, type and names, split into *repeated reporting* (same publisher or near-identical text, counted once) and *possible independent corroboration*. Nothing is merged or linked automatically.
* **Incident and country assistants**: what changed, conflicts, gaps and suggested updates. They never edit your records, change severities or score countries. Exposure is shown as *potential* only.
* **Draft bulletin with AI**: creates a **new** draft SIB. It cannot be approved until a named person presses "I have reviewed this draft". Approval and distribution stay explicit, and an approved bulletin is never changed (reopening it clears the confirmation).
* **Briefings**: on demand or scheduled in the app, covering only what is new or changed since the last one. If nothing changed, the model is not called.
* **Indicators and Market Impact**: the numbers are calculated by the app; the AI explains pathways, alternatives and limits. Forecasts and trading language are removed.
* **Map**: describe what you want to see; it becomes a checked filter (severity, category, country, review, time, plain keywords). No model-written queries or code ever run.

## Safety design

* Retrieved text is treated as data. It is wrapped in per-request random delimiters, instruction-like wording is flagged to the reader, and the system prompt says it is never an instruction.
* Records come only from what your browser may see (the shared public feed plus your own incidents, assessments, places, watchlist). Caches and saved results are per browser.
* The app, not the model, decides what is "Corroborated" (independent publishers), removes statements with no valid source, and removes numbers, links and addresses the sources do not contain. Removed statements are counted on screen.
* One model request at a time (queue limit, time limit, cancel button, one repair retry). Every AI action is logged with who, what, which records and which model version.
* The only host the server contacts for AI is the one you configured. Remote addresses must be `https` with a key; `localhost` is refused on Render because it would mean Render itself.

## Known limits

* Quality depends on your model; small models make mistakes. Everything is labelled as an AI draft for that reason.
* Only headlines and publisher summaries are stored, never full article text. Many answers will therefore say "headline only".
* Syndicated copies with different wording cannot be detected, so some corroboration may be overstated.
* The AI works only while your computer is on and reachable. Scheduled briefings simply wait.
* On Render's free plan the database is lost on redeploy unless you add a persistent disk, which also deletes saved AI results and bulletins.
