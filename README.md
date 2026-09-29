# Vroqn Nexus

An AI-powered learning workspace for school students. One place to **understand concepts, practise,
build, sit mock exams, organise notes and see your own progress** — instead of a chat box with
random tools bolted on.

```
LEARN  →  PRACTISE  →  BUILD  →  TEST  →  ANALYSE  →  LEARN AGAIN
```

Built mobile-first (phones first, then tablets/laptops/desktop) with a mechanical-dark, cyan-accented
interface that stays readable on a low-end Android phone over a slow connection.

---

## What's inside

| Area | What it does |
| --- | --- |
| **AI Tutor** | Ask by text or voice. Answers arrive as **Concept → Explanation → Example → Practice → Quick check**, with follow-up chips, quick actions (simpler, another example, why, step-by-step, test me) and visuals suggested only when they help. |
| **Voice** | First-class STT → AI → TTS flow with explicit idle / listening / processing / generating / speaking / error states, live dictation, cancel, replay and stop. |
| **Practice** | Pick subject → chapter → difficulty → question type, answer one question at a time, get instant explanations with full working for numericals, then hand off to a mock exam. |
| **Mock Exam** | Generate a timed paper, use the question palette and flags, get auto-submit at zero, then a full analysis: weak topics, strong topics and a revision plan. |
| **Notes** | Create, edit, upload photos of handwritten notes / PDFs / text, and let the AI restructure them into Summary, Key Concepts, Definitions, Formulas, Quick Revision and Practice Questions. Study tools per note: summary, key points, definitions, questions, explain. |
| **Code Lab** | JavaScript (Node), Python 3 and HTML/CSS/JS with live preview. Run code, then get AI review, line-by-line explanation, bug hunting and improvement suggestions. |
| **Arena** | **Competitive mock exams.** Register for a scheduled competition, write the paper under a server-enforced clock with autosave and flagging, then get graded with a benchmark (percentile vs. the field), subject/topic/difficulty/time analysis, an AI post-analysis and **one-click practice sets built from the topics that cost you marks**. Admins schedule competitions, generate the paper (AI-assisted, with an offline curated bank), review questions and drive the lifecycle. A **community** can host its own paper too — either **upload one** (it is rewritten before it runs, so the file cannot serve as an answer key) or **let Vroqn AI write it** — and no browser, staff included, can read a community paper while its window is open. |
| **Learning Activity** | Study time, questions attempted/correct, notes organised, code minutes, exam results, weak/strong topics and streaks — presented as *your* progress, never as monitoring, with a one-tap erase. |
| **AI Settings** | Bring-your-own-key for **Gemini, Groq and OpenRouter** only, multiple keys per provider, test/default/enable/disable/remove per key, task-based routing, model preferences, voice and learning profile. |

---

## The AI system (the part that matters)

**Only three providers are supported: Google Gemini, Groq, OpenRouter.** Each supports *unlimited
user-supplied keys*.

A single request flows like this:

```
UI → API route → AI Router → Task Router → Provider Manager → Key Rotation → provider
                                        ↘ that key fails  → next key
                                        ↘ keys exhausted  → next model → next provider
                                        ↘ everything fails → labelled, actionable error
```

* **Per-task routing** — e.g. study help on Gemini, coding on Groq, fallback OpenRouter. Configurable
  in AI Settings; the fallback chain still applies when your choice fails.
* **Failure typing** — rate limit, daily quota, temporary server error, timeout, network failure,
  invalid key, model unavailable, provider unavailable, safety refusal, auth failure. Temporary
  failures move on immediately; rejected keys are parked and flagged; **safety refusals are never
  re-routed to another provider.**
* **Cooldowns** — rate-limited (60 s), quota-exhausted (30 min), auth/invalid (6 h) and server-error
  (20 s) keys are skipped while alternatives exist, but are still used as a last resort so a request
  never dies merely because every key is cooling down.
* **Visible failover** — the tutor stream narrates it: *"Gemini is unavailable (rate limited). Trying
  your next available AI connection…"* and each finished answer shows which provider, model, key label
  and attempt count produced it.
* **Honest sample mode** — if no key is configured (or every key fails and sample mode is on), answers
  come from a built-in sample engine and are clearly labelled as sample content. The app never
  pretends a model answered.
* **Model catalogue** — no obsolete model ids are hardcoded in logic. Everything comes from
  `server/src/config/models.ts`, overridable by env vars or refreshed live from the provider's
  `/models` endpoint from AI Settings.

---

## Tech stack

* **Frontend** — React 18 + TypeScript + Vite 6, Tailwind CSS 4 (CSS-first theme tokens), React Router,
  lucide icons. Hand-written markdown renderer (no `dangerouslySetInnerHTML`).
* **Backend** — Node.js + TypeScript + Express 4, Zod validation, SSE streaming, multer uploads.
* **Database** — PostgreSQL in production (`DATABASE_URL`); embedded SQLite otherwise, through one
  portable SQL layer, so you can run the whole product with a single command.
* **Auth** — email + password (scrypt), signed JWT in an httpOnly cookie. Google sign-in is a
  planned optional addition.
* **AI** — a provider abstraction (`AIProvider`) with Gemini and OpenAI-compatible (Groq/OpenRouter)
  adapters, a key manager, a task router and a fallback engine.

---

## Running it

```bash
npm install                 # installs both workspaces
npm run build               # builds the client bundle
npm start                   # API + built client on http://localhost:8787
```

Open http://localhost:8787, create an account, and start asking questions — no API key required to
explore (sample mode). To use real models, open **AI Settings** and paste a key from
[Google AI Studio](https://aistudio.google.com/app/apikey),
[Groq Console](https://console.groq.com/keys) or [OpenRouter](https://openrouter.ai/keys).

### Arena (competitive exams)

````bash
npm run seed:arena --workspace server     # 3 demo competitions: registration open, live, results published
npm run seed:communities                  # starter communities for the demo account, with classmates already in them

npm run make:admin -- you@example.com     # make that account an Arena organiser (it can then schedule papers)
npm run make:student -- you@example.com   # take the flag back off again
````

Student routes: `/arena` (catalog + overview), `/arena/:id` (detail, register, start), `/arena/:id/start`
(full-screen exam runner), `/arena/results/:attemptId` (analysis, answer review, weak-area practice),
`/arena/my-competitions` (registered + history + trend). Organiser route: `/arena/admin` (schedule,
generate, review, lifecycle). Every window is decided by the **server clock**, and the answer key never
leaves the server until results are published.

#### Creating a competition (the one part that is not a student action)

Taking a competition is open to every signed-in student; **creating** one is deliberately restricted,
because publishing an exam is not something a student may hand themselves. That split is the whole
answer to "how does a competition get created?" — and if you are running this workspace yourself, here
is that path end to end:

1. **Make yourself an organiser.** `npm run make:admin -- you@example.com` (or list the address in
   `ARENA_ADMIN_EMAILS` before `npm run dev`, the bootstrap path for a hosted deploy). The role is read
   from the database on every request, so a refresh is enough — no sign-out needed.
   `npm run make:student -- you@example.com` reverses it.
2. **Open Arena → New competition**, i.e. `/arena/admin`. As an organiser you also get a *"You run
   competitions here"* panel at the top of `/arena`, whose button opens the same dialog directly
   (`/arena/admin?create=1`). Fill in the title, class level, duration, marks and the registration /
   exam / results windows. It is saved as a **draft** — nobody else can see it yet.
3. **Generate the paper, then approve it.** Generate with the AI providers, or choose *bank only* to
   build it from the curated question bank with no keys at all. Then approve, flag or delete each
   question. The server refuses to publish or start a paper that has not met its approved-question
   ratio, and the refusal says which questions are missing — it never silently accepts a thin paper.
4. **Run the lifecycle.** *Open registration → start → close submissions → publish results → archive.*
   Students see the paper appear in `/arena` at that moment; results and answer keys unlock only after
   submissions close.

Students who have never organised anything are not left guessing either: `/arena` carries a collapsed
*"How competitions are created"* card with the same four steps in plain language.
`npm run smoke:arena-organiser` drives this whole path in a real browser with a throwaway account and
deletes that account afterwards, so it is safe to re-run against a live dev server.

Two organisers exist by default, so nothing has to be set up before a demo:

* the **seeded demo account** (`demo@vroqn.dev`) carries the flag — `npm run seed` prints the credentials;
* the seeder also creates **`teacher@vroqn.dev`** (password from `SEED_TEACHER_PASSWORD`, the demo password
  by default), which is the account to show when demonstrating "a teacher hosts a competition".

`npm run who:admin` lists who currently holds the permission, and **`docs/ARENA-ACCESS.md`** spells out
exactly what it grants — and, just as importantly, what it does not (hint: it is not a superuser role).

#### A community hosting its own paper

A community owner or moderator can host a competition inside their own community without being an
organiser (the community capability `create_competition` is what that route checks). Hosting asks one
question — **who writes the paper** — and both answers run on the server the moment the competition is
created:

* **Vroqn AI writes it** — the blueprint is generated, validated and approved automatically.
* **I already have a paper** — paste it or attach a `.txt` / `.csv` / `.md` file
  (`1) question` · `A–D` options · `Answer: A` · optional `Explanation: …`). The questions go to the
  model when a provider key is configured: it keeps the concept and difficulty but changes the numbers,
  the wording and the distractors, reorders the options and recomputes the answer. Every rewrite is
  validated; anything the model cannot deliver is twisted deterministically on the server (values scaled
  by a common factor, options reordered with the key following), so the count the host uploaded is the
  count that runs. **The uploaded text is never stored**, and the host's own paper sets the question
  count of the competition. The reply says which path ran and how many questions the model rewrote.

Reads are counts-only by design: the host sees `{ total, approved, ready }`, never a question. A student's
exam payload carries no key or explanation, and `/api/arena/admin/competitions/:id/questions` — the
operator route that returns the full queue **with answers** — refuses a community paper while its window
is open (`403 community_paper_sealed`), reopening after it closes. `npm run smoke:community-paper`
drives all of that in a real browser. The scheduling question has both answers too: hours from now, or the **exact dates** for registration
opens/closes and exam starts/ends, read back in words and checked against the same three rules the server
enforces. `docs/screenshots/community-schedule-dates.png` shows it.

### Want a populated workspace instead of a blank one?

```bash
npm run seed --workspace server      # demo student: notes, a week of activity, weak/strong topics
```

Then sign in as **demo@vroqn.dev / nexus1234** (override with `SEED_EMAIL` / `SEED_PASSWORD`).
Every screen then has real content: the dashboard shows a streak and suggestions, Activity shows
charts and topic analysis, Notes has three structured notes.

### Development

```bash
npm run dev --workspace server    # API on :8787 (auto-reload)
npm run dev:client                # Vite dev server on :5173, proxies /api to :8787
npm run typecheck                 # server + client
npm test --workspace server       # 84 tests: failover engine, key hygiene, Arena lifecycle/security, grading, Postgres portability

# end-to-end checks against a running server (see docs/ARCHITECTURE.md)
npm run build:smoke --workspace client   # single-bundle test build
npm run smoke:ui --workspace client      # boots the real UI in a DOM, signs in, walks every screen
bash scripts/api-smoke.sh               # 124 student checks (135 when the account is an Arena admin)
DUMP_ROUTE=/arena/<id>/start node scripts/ui-smoke.mjs   # print one screen's text (debugging)

# real-browser layout checks: 320 / 360 / 390 / 430 px + desktop (optional, needs a Chromium build)
npm i --no-save playwright-core
npx playwright-core install chromium-headless-shell
npm run smoke:browser                    # overflow, touch targets, modal fit, exam timer, screenshots

# whole-site deep scan: every route × phone + desktop, plus the Code Lab mentor,
# the messages screen, language handling, navigation and the control audit
node scripts/scan-site.mjs
node scripts/private-chat-check.mjs      # two real browsers: ciphertext on the wire, policies, blocks
npm run smoke:arena-organiser            # the whole "how does a competition get created" path, in a browser
```

`smoke:ui` runs in jsdom, which has **no layout engine** — it verifies behaviour, not geometry.
`smoke:browser` drives a real Chromium at real viewport sizes and is the only check that can catch
horizontal overflow, an undersized touch target, or a dialog opening off-screen. It is deliberately
opt-in: it exits 0 with an explanation when no browser is installed, so it never blocks a normal
`npm test` run. Screenshots land in `docs/screenshots/`.

> **Run it before the Arena-driving suites, or reseed first.** `smoke:api`, `smoke:ui` and
> `smoke:flows` all *submit* the demo account's live Arena paper; this check needs one that is still
> running, to measure the countdown and the exam controls. Order that works:
> `seed:arena` → `smoke:browser`, or `seed:arena` again before it. The check itself only reads the
> paper, so it does not consume one.

**It earns its keep.** On first run it found the Mock Exam page overflowing by 150px at 360px wide
and the upload dialog opening 615px below the fold on a phone — neither of which jsdom can see,
and neither of which the earlier static-analysis pass had caught.

### Useful environment variables

| Variable | Default | Purpose |
| --- | --- | --- |
| `PORT` | `8787` | API port |
| `DATABASE_URL` | — | Use PostgreSQL instead of SQLite |
| `DATA_DIR` | `server/.data` | SQLite file, uploads, generated server secrets |
| `JWT_SECRET`, `VROQN_MASTER_KEY` | generated | Session signing + key-encryption master key (generated once, stored `0600`) |
| `AI_MAX_ATTEMPTS` | `8` | Max key/model/provider attempts per request |
| `AI_ATTEMPT_TIMEOUT_MS` | `45000` | Per-attempt timeout |
| `VROQN_MODEL_GEMINI_BALANCED`, `VROQN_MODEL_GROQ_BALANCED`, `VROQN_MODEL_OPENROUTER_DEEP`, … | see `models.ts` | Override any model id without touching code |
| `ARENA_ADMIN_EMAILS` | — | Comma-separated allowlist for competition authoring (`/arena/admin`) |
| `ARENA_SEED_DEMO` | — | `1` lets `seed:arena` run against a production build |
| `ARENA_REQUIRED_APPROVAL_RATIO` | `1` | Share of a paper that must be approved before it can start (`1` = every question) |
| `ARENA_NUMERIC_TOLERANCE_PCT` | `1` | Numerical answers accepted within this % of the expected value (a blueprint may override it) |
| `ARENA_NUMERIC_TOLERANCE_ABS` | `1e-9` | Absolute tolerance used only when the expected value is exactly `0` |
| `ALLOW_SQLITE_IN_PROD` | — | `1` lets a production build run on SQLite (dev/demo only; production expects `DATABASE_URL`) |
| `SEED_ALLOW_PROD` | — | `1` (plus an explicit `SEED_PASSWORD`) lets `npm run seed` write demo accounts in production |
| `CODE_RUN` | `on` | Set to `off` to disable code execution server-wide |
| `DEMO_MODE` | `on` in dev, `off` in production | Server-wide switch for the offline sample engine. `off` guarantees no sample content is served regardless of per-user settings; `on` is refused in production at startup |

---

## Project layout

```
client/
  src/
    components/        # shell, UI kit, markdown, AI trace
    features/          # auth, dashboard, tutor, practice, exams, arena, notes, code-lab, activity, settings
    hooks/             # auth, settings+keys, toasts
    lib/               # api client, SSE, voice (STT/TTS), formatting
    types/
scripts/
  ui-smoke.mjs         # renders the built app in a DOM, walks every screen and interaction
server/
  src/
    config/            # env + provider/model catalogue
    db/                # portable SQL layer + migrations
    middleware/        # auth, rate limits, error envelope
    routes/            # auth, keys, settings, tutor, notes, practice, exams, arena, code, activity, dashboard, voice
    services/
      ai/
        providers/     # gemini.ts, openaiCompatible.ts (groq + openrouter)
        keyManager.ts  # multi-key storage + rotation
        taskRouter.ts  # task → provider/model ordering
        fallback.ts    # the failover engine
        router.ts      # the only entry point the app talks to
      arena/
        blueprint.ts   # presets, subject/difficulty/type expansion, normalisation
        questions.ts   # generation + validation + duplicate detection + curated-bank fill
        sampleBank.ts  # parameterised offline question bank (demo/placeholder papers)
        competitions.ts# state machine, registration, admin actions
        attempts.ts    # start/resume/autosave/expiry
        results.ts     # grading, benchmarking, analysis report, practice suggestions
      tutor.ts notes.ts practice.ts exams.ts code.ts activity.ts settings.ts visuals.ts
  test/                # failover, key rotation, error taxonomy, crypto, grading
  db/schema.ts         # migrations applied on boot
  db/seed.ts           # demo student for exploring every screen
  db/seed-arena.ts     # demo competitions (open / live / published) for the Arena screens
  render.yaml          # one-service Render blueprint (web service + Postgres)
docs/
  ARCHITECTURE.md      # how the pieces fit together
  ARENA.md             # Arena rules, scoring, benchmarking and lifecycle
  SECURITY.md          # key handling, validation limits, hardened-deployment notes
  DEPLOYMENT.md        # Render, environment variables, Postgres, verifying a deploy
  CSC-REPORT.md        # hackathon review: the 13 points, and what was done about each
  AUDIT-REPORT.md      # page-by-page audit: bugs found, fixes, remaining issues
  UI-POLISH-REPORT.md  # UI/UX pass: hero animation, design system, mobile, accessibility
  COMMUNITIES-REPORT.md    # communities ecosystem: roles, tabs, moderation, tests
  PRIVATE-MESSAGING.md     # DM architecture, what is encrypted, what is not, policies, reports
  NEXUS-TURN7-REPORT.md    # turn 7 acceptance report: every request, every criterion, limitations
  NEXUS-TURN8-REPORT.md    # turn 8: dashboard-as-navigation, search, news on home, writable chapter
```


---

## What has been verified

This prototype is not "it compiles" verified — the whole loop has been exercised end to end:

| Check | Command | Result |
| --- | --- | --- |
| Types (strict unused-symbol checks included) | `npm run typecheck` | clean, server + client |
| Server unit / integration tests | `npm test` | **182 passing across 46 suites** — failover ordering, key parking, safety refusals never re-routed, secret hygiene, error taxonomy, crypto, rate limits, exam timing + autosave, auth rate limiting, Arena lifecycle, answer-key secrecy, grading and ranking maths, Postgres portability, community roles/permissions, private-chat semantics, answer-language mirroring, three-way profile visibility, unified people + communities search, **learning-analytics maths (own-data only, provisional small samples)**, **ownership transfer semantics**, and **member-list permissions** |
| Production build | `npm run build` | client bundle + compiled server in `server/dist` |
| API smoke | `npm run smoke:api` | **124 checks, 0 failures** |
| UI smoke | `npm run smoke:ui` | **39 screens rendered, 0 failures, 0 runtime errors** — the count rises to 44 once a seeded Arena paper adds its attempt and result screens, so the suite is run against both states |
| Student flows | `npm run smoke:flows` | **66 checks, 0 failures** |
| Real-browser layout | `npm run smoke:browser` | **33 checks, 0 failures** — 320 / 360 / 390 / 430 px and desktop: overflow, 40 px tap targets, sticky exam timer, modals, destructive confirm, reduced motion, text floor, homepage load time |
| Whole-site deep scan | `npm run scan:site` | **120 checks, 0 failures** — 20 routes × phone and desktop, no bottom bar, every destination in the dashboard menu, unified search, Code Lab mentor conversation, language handling, control + label audit, joining a community from anywhere, top communities ordering, learning analytics, search → direct message reaching a working composer, the **3D study core: fourteen chips that are real links, a hit area measured inside the 3D transform, the orbit pausing when you reach for it, a press that lands on the screen the disc names, and 26px+ of clear space between the closest two chips in both the moving and the frozen (reduced-motion) drawing**, and **Arena explaining how a competition is created** |
| Community ecosystem, end to end | `node scripts/communities-check.mjs` | **106 checks, 0 failures** — discovery, visibilities, roles and escalation attempts, chat, doubts, knowledge, resources, challenges, plans, events, teams, competitions, moderation, **member mute/remove/ban**, and **ownership handover including the powers that move with it** |
| Ownership transfer, through the screens | `npm run smoke:ownership` | **15 checks, 0 failures** — the Manage gesture, the "Make owner" action, the confirmation, and the role swap verified from both accounts' own sessions |
| Private chat, two real browsers | `node scripts/private-chat-check.mjs` | **18 checks, 0 failures** — real WebCrypto, ciphertext on the wire, policies, blocks, reports |
| Community papers, end to end | `npm run smoke:community-paper` | **21 checks, 0 failures** — in a real browser: the Duration box keeps `180` as typed (the reported bug), exact dates are picked and read back, an impossible schedule is refused before Create, both paper options are offered, an uploaded paper is accepted and reported as rewritten, no question text reaches the page, the stored competition starts at exactly the minutes chosen, **Remove** confirms by name and the card goes, the platform console answers `403 (sealed)` for the same paper, and the test competitions are deleted again afterwards |
| Community paper rules | `server/test/community-paper.test.ts` | **9 tests** — parsing, the twist (original values and option order do not survive; the key still is one of the options), counts-only responses, the key staying absent from a student's exam payload, `409` on a second paper, `403` for a non-host, `400` for text that is not a paper, the console seal, and exact dates surviving to the database |
| Community paper — the model pass | `server/test/community-paper-ai.test.ts` | **1 test with a stubbed provider** — the provider is called, its rewrite is what gets stored, and the reply still carries no question text |
| Arena organiser path, end to end | `npm run smoke:arena-organiser` | **23 checks, 0 failures (25 with the two account cleanups)** — a fresh account signs up, is refused the console while a student, is promoted by `npm run make:admin`, schedules a competition through the real dialog (stored as an invisible draft), and is demoted + deleted again, `make:student` included |

Things a screenshot would catch but this suite cannot: pixel layout, animation smoothness and
browser-specific rendering. Open the app to check those.

Two sequencing notes, both learned the hard way:

* `api-smoke` and `smoke:flows` both drive the *demo* account through a live Arena paper, so run
  `npm run seed:arena --workspace server` before each pass. Without it the second run correctly
  reports `already_submitted` and the checks after it cascade.
* The AI limiter allows 40 model calls per minute per account and the auth limiter counts failed
  attempts per IP. Back-to-back full passes can therefore answer `429`; wait about a minute. Both
  scripts now say so explicitly instead of reporting a false regression.
* Arena-state checks (the integrity gate and the sticky timer) need a paper that has not been started,
  so run the browser suites before `smoke:api` / `smoke:flows`, or on a fresh database. When a paper
  has already been submitted the suites report that state and check the redirect instead of failing.
* The browser suites need a browser: `npm i --no-save playwright-core` then
  `npx playwright-core install chromium` (playwright-core 1.47 rejects `chromium-headless-shell`), and —
  on a slim Linux image — `sudo npx playwright-core install-deps chromium` for the shared libraries.

---

## Prototype scope (honest status)

Phase 1 and 2 of the product plan are implemented and working end-to-end. Known limits:

* Code execution runs in a **stripped child process** with timeouts and output caps, not a container.
  Fine for a prototype; a real deployment should isolate each run (see `docs/SECURITY.md`).
* Voice uses the device's Web Speech API by default, with provider STT/TTS as an opt-in engine
  (server-side keys, never in the browser). Browser dictation support varies (best on Chrome/Android),
  and cloud STT/TTS requires the student to have connected their own Groq or Gemini key. Without one,
  speech-to-text reports itself unavailable and the UI tells the student they can still type.
* The Mock Exam clock and every answer live on the server, so a refresh resumes the attempt instead of
  restarting it. It is self-practice, not invigilated: a student who leaves a tab open and submits after
  the deadline still keeps their work, with the recorded time capped at the paper's duration. Arena is
  the strict path — there the server writes answers and refuses late ones outright.
* The UI smoke harness runs in a DOM (jsdom) rather than a real browser: it proves every screen
  renders, that routing works, that a question streams back an answer and that the Code Lab really
  executes code — but it does not verify pixels. Check the layout in a browser too.
* Postgres is supported through the same SQL layer but has been exercised against SQLite in this
  environment.
* Arena benchmarking is honest by construction: percentile and rank are computed **only** over valid
  submissions to that competition and are labelled as such ("independent Vroqn mock · N valid
  submitted attempts"). Nothing in the product claims a JEE/NEET rank prediction.
* Competition papers are generated by the same validated question pipeline as practice sets (AI when
  a key is connected, curated/parameterised bank otherwise), then reviewed by an admin before the
  paper goes live. Every generated question stores its source and review status.
* No offline PWA caching yet (Phase 3).
