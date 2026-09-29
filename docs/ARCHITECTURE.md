# Architecture

## Layers

```
┌──────────────────────────────────────────────────────────────────────┐
│ React client (Vite, TypeScript, Tailwind 4)                          │
│  features/{tutor, practice, exams, arena, notes, code-lab, …}        │
│  lib/api.ts (fetch + ApiError)  ·  lib/sse.ts (POST SSE)  ·  voice   │
└───────────────▲──────────────────────────────────────────────────────┘
                │ same-origin /api (cookies, SSE, multipart)
┌───────────────┴──────────────────────────────────────────────────────┐
│ Express API                                                          │
│  middleware: security headers, auth (JWT cookie), rate limits, errors │
│  routes: auth keys settings tutor notes practice exams arena code     │
│          activity dashboard voice                                    │
└───────────────▲──────────────────────────────────────────────────────┘
                │ typed service calls
┌───────────────┴──────────────────────────────────────────────────────┐
│ Domain services                                                       │
│  tutor · practice · exams · notes · code · activity · visuals          │
│  arena           (competitions · questions · attempts · results)       │
│  settings        (per-student JSON settings document)                  │
└───────────────▲──────────────────────────────────────────────────────┘
                │ provider-agnostic tasks only ("generate questions",
                │ "grade this answer", "clean these notes")
┌───────────────┴──────────────────────────────────────────────────────┐
│ AI layer                                                              │
│  router.ts ──► taskRouter.ts ──► fallback.ts ──► keyManager.ts         │
│                      │                              │                 │
│                      └────────► providers/{gemini,openaiCompatible}    │
└───────────────▲──────────────────────────────────────────────────────┘
                │ one portable SQL layer (Postgres or SQLite)
┌───────────────┴──────────────────────────────────────────────────────┐
│ Storage: users, api_keys, user_settings, conversations, messages,     │
│ notes, uploads, practice_sets/attempts, exams/results, activity,      │
│ topic_stats, code_sessions, arena_* (competitions, questions,         │
│ registrations, attempts, answers, results, performance reports)       │
└──────────────────────────────────────────────────────────────────────┘
```

## Why the AI layer is shaped this way

**`AIProvider`** (`services/ai/types.ts`) is the only contract the rest of the app sees:
`validateKey`, `streamChat`, `chat`, optional `transcribe` and `speak`, plus declared capabilities
(streaming, vision, pdf, json, stt, tts). Adding or replacing a vendor means writing one file and
registering it in `providers/index.ts` — nothing above the router changes.

**`taskRouter`** turns a task (`general`, `coding`, `notes`, `exam`, `practice`, `vision`, `voice`,
`grading`, `fallback`) plus the student's preferences into an ordered plan:
preferred provider → configured fallback provider → remaining providers, and inside each provider the
models ranked by the task profile (speed, code, vision). The plan is emitted to the client so the UI
can explain the order.

**`fallback.ts`** executes the plan. Per provider it tries every eligible key for each model; keys that
fail are parked with a cooldown derived from the *failure kind*; the loop continues until something
succeeds or the attempt budget is spent. It emits `plan → attempt → (delta… | attempt_failed
[+restart]) → done | error` events, which is exactly what the SSE endpoint forwards.

**Restart semantics**: if a provider dies mid-answer, the engine emits `restart`, the client clears the
partial text, and the next connection produces one clean answer instead of a spliced one.

**Safety refusals** terminate the run with `failure: 'safety'` and a rephrase suggestion. The same
prompt is never shopped to a different provider to get around a provider's safety system.

## Data model notes

* One SQL surface for both engines: `?` placeholders are rewritten to `$n` for Postgres, and only
  portable column types are used (TEXT ids, ISO-8601 TEXT timestamps, INTEGER counters/booleans).
* `user_settings` stores a JSON document per student, so new preferences need no migration.
* `topic_stats` accumulates per-topic attempt/accuracy, which powers weak-area detection, dashboard
  suggestions and revision plans. Anything with ≥2 attempts and <70 % accuracy is "weak"; ≥3 attempts
  and ≥80 % is "strong".
* Arena lives in its own tables added by migration `0002_arena` (`arena_competitions`,
  `arena_questions`, `arena_registrations`, `arena_attempts`, `arena_answers`, `arena_results`,
  `arena_performance_reports`) plus a `users.role` column. Attempts and answers are separate rows so
  autosave is a small upsert and grading reads exactly what the student last saved.
* `activity_events` is the single source for the Learning Activity page — visible to the student,
  erasable by them, and never used for anything else.

## Learning loop wiring

| Step | Where |
| --- | --- |
| Ask a question | `POST /api/tutor/stream` (SSE), persisted to `messages` + `activity_events` |
| Practise it | "Practise this" on an answer → `/practice?subject&chapter`, or `POST /practice/generate` |
| Record mistakes | `POST /practice/check` → `practice_attempts` + `topic_stats` |
| Test | `POST /exams` → `POST /exams/:id/submit` → per-question grading + one analysis call |
| Analyse | `GET /api/activity/{summary,topics}` + dashboard suggestions |
| Compete | `POST /api/arena/competitions/:id/{register,start,answers,submit}` → server-clock paper, autosave, auto-submit |
| Benchmark | `POST /api/arena/admin/competitions/:id/action {publish_results}` → percentiles recomputed over valid submissions |
| Learn again (Arena) | `POST /api/arena/results/:attemptId/analyze` + `/practice` → weak-topic sets deep-link into Practice |
| Learn again | Dashboard weak-area links and exam revision list deep-link back into Practice |

## Arena (competitive exams)

Arena is a second, stricter exam track that reuses the practice pipeline instead of duplicating it.

**Lifecycle.** `arena_competitions.status` plus the schedule fields feed `computeState()`, which derives
the student-visible state (`UPCOMING → REGISTRATION_OPEN → LIVE → SUBMISSION_CLOSED →
PROCESSING_RESULTS → RESULTS_PUBLISHED → ARCHIVED`) from the **server clock**. The client never decides
whether a paper is open: it asks `/status` and renders what it is told. An attempt stores its own
`deadline_at` (started_at + duration), so extending a competition window never gives a running paper
extra time.

**Paper generation.** `blueprint.ts` expands a preset into per-subject/per-difficulty/per-type slots
(60 questions for Pre-JEE, 30 for Foundation, …). `questions.ts` fills each slot with validated
candidates:
1. AI candidates when a key is connected (`competitionGenSystem` prompt), `origin:'ai'` → near-duplicate
   detection uses numbers-stripped similarity (≥0.82) because a model re-asks the same question with new
   values.
2. Curated bank candidates when the slot is still short, `origin:'bank'` → only **exact** wording repeats
   are rejected, because a parameterised bank deliberately varies the numbers.
3. The parameterised `sampleBank.ts` generator as the offline fallback, so a demo or keyless deployment
   still ships a full-size paper.

Every candidate passes the same `validateQuestion` gate (four options, answer present in options,
explanation that actually states the answer, sanity checks) and every stored question keeps its
`source` and `review_status`. Rejections are counted and reported to the admin console rather than
silently dropped. Filling a slot is a *loop*: if a bank candidate is rejected, the next pass widens
the draw within the same subject (keeping each template's own difficulty label and reporting every
relaxation in the generation warnings), so a paper either reaches its blueprint size or the shortfall
is named. `generatePaper` never approves its own output — a paper is only usable once
`paperReadiness()` says every required question is approved.

**Marking.** `grading.ts` is the single grading entry point (the results service imports it instead of
holding its own copy). Correct answers award `marksPerQuestion`, wrong ones subtract `negativeMarks`,
blanks score zero. Numerical answers are compared against the expected value inside a tolerance that
comes from the competition blueprint or `ARENA_NUMERIC_TOLERANCE_PCT`/`ARENA_NUMERIC_TOLERANCE_ABS`.

**Answer key handling.** Students only ever receive `studentView()` of a question — no `correctAnswer`,
no `explanation`. The key is joined into the result payload only when `resultsPublishedAt` is set, and
grading happens server-side from the stored paper.

**Benchmarking.** `results.ts` grades the attempt (positive marks, negative marking from the stored
paper, unanswered cost nothing), then benchmarks over attempts that actually submitted. Population size
is carried in the payload and shown in the UI (`Independent Vroqn mock · 61 valid submitted attempts`),
percentile below five valid submissions is withheld, and standings are anonymised (`Aspirant N` / `You`).

**Analysis.** Subject → topic → difficulty → type breakdowns, per-question timing (first third vs last
third → time-pressure flag), then a performance report. With a provider available the evidence block is
sent to `competitionAnalysisSystem`; without one, `localReport()` derives the same structure from the
same numbers. Either way the report is stored per attempt and regenerable.

**Weak-area loop.** `buildPracticeSuggestions()` turns the worst topics into concrete practice sets and
`POST /results/:attemptId/practice` hands back a deep link into the existing Practice feature
(`/practice?subject=…&from=arena`), closing LEARN → TEST → ANALYSE → LEARN AGAIN.

**Admin.** Authoring is gated by the `ARENA_ADMIN_EMAILS` allowlist (`requireAdmin`). Admins schedule
competitions, run the lifecycle actions, generate/regenerate papers (optionally bank-only, i.e. no AI
call at all), review or delete individual questions, and delete a competition that never ran (refused
once attempts exist — archive instead).

## Frontend structure

* `components/ui.tsx` — the entire visual vocabulary (buttons, cards, badges, fields, modal, states,
  progress, tiles, switches) so spacing and focus rings stay identical everywhere.
* `components/AITrace.tsx` — renders the failover story (`TraceStatus`, `AnswerMeta`, `SlowHint`).
* `features/*` own their own state and call the API directly; no global store is needed because each
  screen is self-contained. Shared cross-cutting state lives in two contexts: auth and settings/keys.
* Route-level code splitting keeps the first load small; heavy screens (tutor, notes, code lab)
  arrive as separate chunks.
* Everything is mobile-first: the **dashboard is the navigation** (turn 8). Under `lg` the header
  carries a menu (on the dashboard) or a back button (everywhere else) plus search; above `lg` a
  sidebar lists every destination. There is no persistent bottom bar — it covered the last rows of
  every long page on a phone. Touch-sized targets, no horizontal overflow, iOS-zoom-safe input sizing.

## How it is tested

Three layers, each answering a different question:

1. **Unit / integration (`server/test/*.test.ts`, `node --test`)** — the failover engine is driven
   through the real key manager and database with stubbed provider adapters, so attempt ordering,
   cooldown behaviour, key parking and the "safety is never re-routed" rule are asserted directly.
   `crypto.test.ts` proves keys round-trip through AES-GCM, are masked, are re-generated with a fresh
   IV each time, and that log redaction removes every supported key shape.
2. **API smoke (`/tmp`-style shell script, or curl by hand)** — a signed-in walk through every route
   against a running server, including the negative cases: 401 without a session, a wrong password,
   malformed bodies, a rejected key, and a program that never terminates (the sandbox must kill it).
   The shell script also walks the whole Arena surface — registration idempotence, the server-deadline
   paper, autosave + resume, submit, publish-gating, benchmark, answer review, weak-area practice, admin
   generation (asserting a full-size paper) and the `403` gates — and cleans up the competition it
   creates. With `ARENA_ADMIN_EMAILS` unset it asserts the student-side `403`s instead. Arena sections
   write real data, so `npm run seed:arena --workspace server` restores the demo state.
3. **UI smoke (`scripts/ui-smoke.mjs` + `client/vite.smoke.config.ts`)** — the production client is
   code-split ESM, which a DOM-only environment cannot run, so the harness builds a single IIFE
   bundle and boots the *real* app against the live API with jsdom: it signs in, visits all twelve
   routes, checks the `<h1>` of each screen (so a blank page cannot pass by matching sidebar text),
   then performs real interactions — asking a question and waiting for the streamed structured
   answer, generating a practice set, running code in the Code Lab, and sitting a mock exam through
   to the analysis screen. For Arena it renders the competition detail, the published result analysis
   (benchmark, answer review filter chips) and the exam runner (server clock, autosave, palette), and
   checks that the runner runs without the app shell and that an answer really reaches the server.
   `DUMP_ROUTE=<route>` prints one screen's text for debugging.

The UI harness is deliberately part of the repo: it is the cheapest way to catch "the app crashed on
first paint" without a browser in CI.

## Extending it

1. **New provider** → add a spec to `config/models.ts` and an adapter in `services/ai/providers/`
   (only Gemini, Groq and OpenRouter are supported by design).
2. **New model** → env var `VROQN_MODEL_<PROVIDER>_<TIER>` or "Refresh from provider" in AI Settings.
3. **New competition preset** → add an entry to `BLUEPRINT_PRESETS` and a category in
   `services/arena/competitions.ts`; generation, validation and the admin console pick it up.
3. **New task** → add a `TaskKind`, a profile in `taskRouter.ts`, a prompt in `prompts.ts`, and a route.
4. **New learning module** → a service + route on the server, a `features/<name>` folder on the client,
   and one line in `App.tsx`'s lazy routes.
