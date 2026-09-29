# Vroqn Nexus — Full Audit and Fix Report

**Scope:** every page, route, component, API endpoint, database table, AI integration, and the voice,
Arena, Mock Exam, Code Lab, Notes, Practice and Settings features — audited against real behaviour, not
against the intent of the code.

**Ground rules followed:** nothing working was rebuilt or removed. Every fix was traced to a root cause
and made in place. Every claim below was produced by running a command, and the commands are quoted so
they can be re-run. Nothing is described as verified unless it was.

**Severity scale:** `CRITICAL` = data loss, credential exposure or cross-account access · `HIGH` =
a core feature broken, silently wrong, or trivial to game · `MEDIUM` = wrong behaviour in an edge case,
dead configuration, misleading UI/test · `LOW` = polish, minor information disclosure.

**Headline:** no `CRITICAL` defect was found — ownership checks, key encryption, answer-key handling in
Arena, and the auth boundary all held. Nine `HIGH` defects were found and fixed, four of which made a
headline feature either broken or trivially gameable.

---

## 0. Verification evidence (final build)

| Check | Command | Result |
| --- | --- | --- |
| Types + unused symbols | `npm run typecheck` | **0 errors** (server + client) |
| Tests | `npm test --workspace server` | **84 passed / 0 failed**, 22 suites |
| Production build | `npm run build` | **green** |
| API smoke | `npm run smoke:api` | **135 passed / 0 failed** |
| UI smoke | `npm run smoke:ui` | **33 screens / 0 failed / 0 runtime errors** |
| Student flows 1–8 | `npm run smoke:flows` | **72 passed / 0 failed** |
| Server boot + DB | `node server/dist/index.js` | listens on `0.0.0.0:8787`, migrations applied, DB pinged |

Baseline before this pass: 60 tests / 17 suites, 121–135 api-smoke, 32 ui-smoke, and no flow suite.
The suite grew by **24 tests and 5 suites**, all of which are regression tests for the defects below.

---

## 1. Bugs found — with severity

| # | Severity | Area | Defect | Impact |
| --- | --- | --- | --- | --- |
| B1 | **HIGH** | Mock Exam | The countdown was re-initialised in the browser on every mount (`startedAt = Date.now()`), and no deadline existed server-side | Refreshing the runner handed the student a **fresh full-length timer**, repeatably. Time analytics were also derived from a client-supplied number |
| B2 | **HIGH** | Mock Exam | Answers lived only in component state | A refresh, crash or closed tab **lost the entire attempt** |
| B3 | **HIGH** | Mock Exam | `submitExam` had no duplicate guard | A double-tap or a race inserted a **second result row and re-ran the per-question loop**, recording every topic stat twice. This silently inflated `topic_stats`, so weak-area diagnosis drifted the more a paper was submitted |
| B4 | **HIGH** | Mock Exam | `POST /api/exams` with `questionCount: 20` stored **5** questions | The demo path defaulted the count to 5 and the AI-less bank caps at 15. The student's stated paper length was silently ignored |
| B5 | **HIGH** | Practice | `POST /api/practice/generate` and `GET /api/practice/sets/:id` returned `answer`, `explanation` and worked `steps` for every question before the student answered | The **entire answer key was readable in DevTools**. Practice could be completed without thinking |
| B6 | **HIGH** | Code Lab | Coding `ask`/`explain`/`build` requests fell through to `demoTeachingAnswer`, a physics template | Every coding question was answered with a train-speed worked example and "substitute with units". The feature appeared to work (HTTP 200) while being **completely wrong** |
| B7 | **HIGH** | Auth / rate limiting | The auth limiter was `30 requests / 10 min per IP` and counted **successful** sign-ins | A school computer lab behind one NAT address would **lock students out** after 30 sign-ins. This is the exact network the product targets |
| B8 | **HIGH** | Mock Exam | `timeSpentMs` was taken from the request body | A client could report any elapsed time it liked, making time-based analysis untrustworthy |
| B9 | **HIGH** | Code Lab | `review` / `bugs` / `improve` returned an empty top-level answer in the demo path | JSON-mode tasks rendered nothing where a structured review was expected |
| B10 | **MEDIUM** | Auth/API | Arena's admin paper-review screen (`/arena/admin`) had **no entry point anywhere in the UI** | Staff could not reach the approval gate that Arena requires before a paper can go live |
| B11 | **MEDIUM** | Settings | `autoReadReplies` was a dead duplicate of `voiceMode` — defined in the server type, the settings schema and the client types, referenced nowhere | A configuration field that did nothing |
| B12 | **MEDIUM** | Tests | `ui-smoke` asserted `/` shows a *sign-in* screen, and its Arena checks silently skipped when seed data had been consumed | The suite passed for the wrong reason and under-reported its own coverage |
| B13 | **MEDIUM** | Tests | `api-smoke` reported **11 false failures** when run twice inside a minute | A rate-limit response was indistinguishable from a real regression |
| B14 | **MEDIUM** | Mock Exam | A missing exam threw a plain `Error`, which the error middleware maps to **500** | Wrong status, and a 500 is noisier to triage than a 404 |
| B15 | **LOW** | Code Lab | Python tracebacks exposed the server's temp path (`/tmp/vroqn-run-XXXX/main.py`) | Minor server information disclosure |
| B16 | **LOW** | Docs | The README claimed "strict unused-symbol checks included", but `noUnusedLocals`/`noUnusedParameters` were **`false`** | A verification claim that was not true |
| B17 | **LOW** | UI | Dense toolbars use 32 px (`size="sm"`) tap targets | Below the 40–44 px mobile guidance |
| B18 | **LOW** | Deployment | No deployment blueprint or guide existed anywhere in the repo | A judge could not deploy it without reverse-engineering the env surface |

---

## 2. Bugs fixed — what changed, at the root

### 2.1 Mock Exam is now server-authoritative and survives a refresh (B1, B2, B3, B8, B14)

Four defects shared one root cause: **the exam's clock and answers lived in the browser**. They were
fixed together, server-side, rather than patched in the UI.

*New migration `0003_exam_timing`* adds `exams.started_at`, `exams.expires_at` and an `exam_answers`
table keyed `(exam_id, question_id)`.

*The clock starts once.* `openExam()` stamps `started_at`/`expires_at` the first time a student opens
the paper — not at creation, so authoring a paper and returning to it later is not punished — and
never overwrites them. `clockFor()` derives `remainingMs` and `expired` from that absolute deadline, so
a refresh, a slept laptop or a second device resumes the same attempt.

*Answers autosave.* `POST /api/exams/:id/answers` upserts one row per question. `GET /api/exams/:id`
returns the autosaved map so the runner restores the attempt. The client debounces writes by 600 ms and
flushes on `visibilitychange`, `pagehide` and unmount — so switching apps or closing the tab inside the
debounce window does not lose the last keystroke. The footer now reports the real save state
(`Saving… / Saved / Not saved — retrying`) instead of a hard-coded "nothing is lost".

*Submission is idempotent and server-timed.* `submitExam` refuses a second submit with `409
already_submitted` plus the existing `resultId` (the client redirects to that result rather than showing
an error for work that is safely stored), derives elapsed time from `started_at`, and caps it at
`duration + 60 s` so an abandoned tab is not recorded as a 14-hour attempt. Autosaved answers are merged,
so a payload that races an autosave cannot drop the last answer.

*Every write is guarded:* ownership returns `404`, an unknown question returns `400 unknown_question`,
and an answer after the deadline returns `409 time_up` — while flagging stays harmless.

*Deliberate boundary, stated plainly:* a submit that arrives after the deadline is still accepted, with
the time capped. The Mock Exam is self-practice; discarding a student's work over a slow connection
would be worse than the theoretical gain. **Arena is the strict path** — there the server writes every
answer and refuses late ones outright.

Verified by 16 new tests in `test/exam-timing.test.ts`, by direct curl against a back-dated deadline,
and by flows 4 and 7.

### 2.2 The student's paper configuration is now honoured (B4)

`createExam` tops short papers up from the curated `sampleBank` (41 vetted templates) when the offline
engine returns fewer questions than asked, appends an honest shortfall note if it still cannot reach the
target, filters MCQs that arrived without options (unanswerable), and throws `502 exam_unavailable`
rather than shipping an empty paper. `questionCount: 20` now stores 20; the same request produced 5
before. Repeat runs are deterministic.

### 2.3 The Practice answer key no longer leaves the server (B5)

A `withoutAnswerKey()` projection on the two endpoints that return a set blanks `answer`,
`explanation` and `steps`. `hint` is deliberately kept — it is a nudge shown on request, not the answer.
The client never used those fields before an attempt; it renders the explanation from the
`/practice/check` response *after* an answer is submitted, and that path is unchanged and still returns
the full worked solution. This brings Practice in line with the Mock Exam runner and the Arena runner,
which already stripped these fields.

### 2.4 Code Lab answers coding questions with coding answers (B6, B9)

Traced end-to-end first (UI → request → route → auth → AI service → response → render), as required. The
service was reachable, authorised and returning `200` — the fault was that non-JSON coding tasks had no
offline template and fell through to the physics one. Added `demoCodingAnswer()` (mode-shaped: walkthrough
/ answer / build plan) and routed coding modes to it, detected from the system prompt. `code.ts` now
attributes demo output as `provider: 'sample'`, `model: 'vroqn-sample'` so a sample answer is never
labelled as a model's. Code execution was untouched and still works.

### 2.5 A shared school network no longer locks itself out (B7)

`rateLimit` gained `refundOnSuccess`: a 2xx response returns the slot, a failure keeps it. Failed
attempts still count and still trigger the lockout, so brute-force protection is unchanged. The window
and ceiling are now configurable (`AUTH_RATE_MAX`, `AUTH_RATE_WINDOW_MS`; default raised 30 → 60) because
the right ceiling depends on the deployment. Four tests in `test/rate-limit.test.ts` cover a full lab
signing in, repeated failures still locking out, success and failure budgets staying separate, and
addresses being tracked independently.

> Writing this fix introduced a bug that the tests caught: the first request of a window takes an
> early-return path, so the refund hook was not registered and the first success permanently cost a
> slot. The limiter was restructured to register the hook before every return.

### 2.6 Staff can reach the approval gate (B10)

The server already returns `role` on `/auth/login`, `/auth/signup` and `/auth/me`, but the client `User`
type dropped it and no link existed. Added `role` to the client type and an admin-only **Paper Review**
nav entry, rendered only when `user.role === 'admin'`. The API's `requireAdmin` is unchanged and remains
the actual boundary — verified: a non-allowlisted account gets `403` on `/api/arena/admin/*`.

### 2.7 The test suite now passes for the right reason (B12, B13)

* `ui-smoke` now asserts the **landing page** at `/`: the learning loop, all six features named, both
  `/login` and `/signup` links, a `<footer>`, an `<h1>`, and the Arena independence disclaimer. A
  separate check covers `/login`, so the auth screen is genuinely exercised again.
* `api-smoke` detects `429` and prints "RATE LIMITED … not a logic error", with a closing note, instead
  of reporting a false regression.
* `smoke:flows` was added, and its own contract mistakes were corrected against the real API shapes
  rather than papered over.

### 2.8 Cleanups (B11, B16, B14)

`autoReadReplies` removed from the type, defaults, settings schema and client types. A missing exam now
returns `404`. The README's unused-symbol claim was made true by fixing **13 genuinely dead symbols**
(an unused `forceRegister` helper, an unused `savedAt` ref, a local `totalQuestions` shadowing an export,
three unused imports, three unused parameters) and then enabling `noUnusedLocals` /
`noUnusedParameters` in both tsconfigs — so the claim cannot drift again.

---

## 3. New features

| Feature | Detail |
| --- | --- |
| **Public homepage** at `/` | New `LandingPage.tsx`, lazy-loaded (16.7 kB chunk). Hero, the 7-step loop (Learn → Practise → Build → Test → Compete → Benchmark → Improve), problem/solution, six feature cards, the diagnosis + "Practice My Weak Areas" path, a trust section, CTA and footer. Signed-out `/` is now this page; `/login` and `/signup` are public routes; unknown paths fall back to `/`. Hero copy for signed-out visitors only — a signed-in student still lands straight on their dashboard. Arena is described as an **independent competition created inside Vroqn Nexus**, with an explicit "not an official JEE/NEET examination" disclaimer. No traffic, user or outcome claims are made. Fully responsive; anchors (`#features`, `#arena`) resolve to real sections |
| **Mock Exam resume** | Server-anchored clock, autosaved answers, restored flags, a "picked up where you left off" notice, a real save indicator, and a redirect to the existing result on a duplicate submit |
| **Student flow harness** | `scripts/flow-check.sh` / `npm run smoke:flows` — 72 checks across the eight flows, JSON assertions evaluated in Python to keep shell quoting out of the way |
| **Render blueprint** | `render.yaml` — one web service + managed Postgres, health check, migrations on boot |
| **Deployment guide** | `docs/DEPLOYMENT.md` — build/start commands, the full env surface, Postgres, seeding, verifying a deploy, and known limits |

---

## 4. Files changed

**New (7):**
`client/src/features/landing/LandingPage.tsx` · `server/test/exam-timing.test.ts` ·
`server/test/rate-limit.test.ts` · `scripts/flow-check.sh` · `render.yaml` · `docs/DEPLOYMENT.md` ·
`docs/AUDIT-REPORT.md`

**Server (17):**
`db/schema.ts` (migration) · `types/domain.ts` · `services/exams.ts` · `routes/exams.ts` ·
`routes/practice.ts` · `routes/settings.ts` · `services/ai/demoBank.ts` · `services/ai/demo.ts` ·
`services/code.ts` · `middleware/rateLimit.ts` · `config/env.ts` · `services/arena/attempts.ts` ·
`services/arena/blueprint.ts` · `services/arena/results.ts` · `db/seed-arena.ts` · `index.ts` ·
`tsconfig.json`

**Client (5):**
`App.tsx` · `types/index.ts` · `components/AppShell.tsx` · `features/exams/ExamRunnerPage.tsx` ·
`tsconfig.json`

**Tooling / docs (5):**
`scripts/ui-smoke.mjs` · `scripts/api-smoke.sh` · `package.json` · `README.md` · `.env.example`

---

## 5. Database changes

Migration `0003_exam_timing` (applies automatically on boot; idempotent; verified against the existing
database, not just a fresh one):

```sql
ALTER TABLE exams ADD COLUMN started_at TEXT;
ALTER TABLE exams ADD COLUMN expires_at TEXT;

CREATE TABLE IF NOT EXISTS exam_answers (
  exam_id     TEXT NOT NULL REFERENCES exams(id) ON DELETE CASCADE,
  question_id TEXT NOT NULL,
  answer      TEXT NOT NULL DEFAULT '',
  flagged     INTEGER NOT NULL DEFAULT 0,
  updated_at  TEXT NOT NULL,
  PRIMARY KEY (exam_id, question_id)
);

CREATE INDEX IF NOT EXISTS idx_exam_answers_exam ON exam_answers (exam_id);
```

Portable across SQLite and Postgres: `TEXT`/`INTEGER` only, no engine-specific syntax, no `?` inside SQL
text. `postgres-compat.test.ts` asserts these rules over every statement in the codebase and still
passes. `exam_answers` rows are deleted once the paper is submitted — answers then live in the immutable
`exam_results` row, and `deleteExam` clears them too.

No table was dropped and no existing column was altered.

---

## 6. API changes

| Endpoint | Change |
| --- | --- |
| `GET /api/exams/:id` | Now starts the clock on first open and returns `startedAt`, `expiresAt`, `remainingMs`, `expired`, `durationMs`, `savedAnswers`, `flagged`. Still strips `answer`/`explanation`/`steps` while the paper is in progress |
| `POST /api/exams/:id/answers` | **New.** Autosaves one answer or flag. `{questionId, answer?, flagged?}`. Guards: `404` not owner, `409 already_submitted`, `400 unknown_question`, `409 time_up` |
| `POST /api/exams/:id/submit` | Duplicate submit now `409 already_submitted` + `{resultId}`. Time is derived server-side. Merges autosaved answers. Missing exam `404` (was `500`) |
| `POST /api/practice/generate` | Response no longer carries `answer`/`explanation`/`steps` |
| `GET /api/practice/sets/:id` | Same projection |
| `POST /api/settings` | `autoReadReplies` removed from the accepted schema (unknown keys are ignored, so old clients are unaffected) |
| `GET /api/auth/me` | Unchanged, but the client now consumes the `role` it always returned |
| `POST /api/auth/login`, `/signup` | Rate limit refunded on success; ceiling configurable |

No endpoint was removed or renamed, and no request shape that previously worked now fails.

---

## 7. Voice implementation (requirement 6)

Audited rather than rebuilt — the architecture was already correct.

* **Server-side credentials only.** `server/src/routes/voice.ts` exposes `/api/voice/capabilities`,
  `/transcribe` and `/speak`. Cloud STT is Groq `whisper-large-v3-turbo`, cloud TTS is Gemini
  `gemini-2.5-flash-preview-tts`, both via the same key manager as every other AI call, so a student's
  key stays encrypted on the server and is never sent to the browser. Model ids come from
  `VROQN_MODEL_GROQ_STT` / `VROQN_MODEL_GEMINI_TTS` — no hardcoded ids in the client.
* **No undocumented APIs.** Only documented provider endpoints are used, through the existing adapters.
* **States.** `idle`, `permission`, `listening`, `processing`, `generating`, `speaking`, `error` — all
  present in `useVoice.ts` and rendered by `VoiceOrb`.
* **Controls.** Start, stop, cancel (discards), send transcript, per-message read-aloud (replay) and
  stop-TTS all exist.
* **Avoids unnecessary calls.** The server chooses the engine from the student's setting; the client
  prefers the device's Web Speech API unless `sttEngine === 'server'`, so a student with no provider key
  never pays for a round trip. Speech is only sent when there is audio.
* **Never auto-reads long replies.** Auto-speak sits behind `if (voiceMode)` and truncates to 900
  characters; the per-message speaker button is the explicit path. Verified: `voiceMode` is the only gate.
* **Graceful when exhausted.** With no key, `/transcribe` answers `503 stt_failed` with
  *"You can still type your question — nothing is lost."* and `/speak` answers
  `200 {available:false, message:"… using your device voice instead."}` so the client falls back silently.
  **Verified by test.** What is *not* verified: a real transcription with a live key — see §15.
* **Modular.** STT, the AI turn and TTS are separate modules (`lib/voice.ts`, `useVoice.ts`, the server
  routes) with no coupling between them.

No change was needed here. The dead `autoReadReplies` duplicate was removed so there is one setting, not
two.

---

## 8. Mock Exam implementation (requirement 8)

**Before creation — student-configurable and validated.** Subject, up to 8 chapters/topics, question
count (1–40), duration (5–180 min), difficulty (easy/medium/hard) and question type
(mcq/short/numerical/conceptual/mixed) are all chosen by the student and validated by a zod schema
before anything is generated. There is no fixed hardcoded exam. Verified: a 20-question 30-minute MCQ
paper stores 20 questions; a 6-question paper stores 6 with the requested duration.

**During the exam.** Server-authoritative timing (the countdown is derived from the server's absolute
deadline, so it cannot drift or be reset), a visible timer with a warning state under a minute,
previous/next navigation, a question palette that jumps anywhere, answers autosaved as the student works,
flag-for-review, submit with an unanswered-count confirmation, auto-submit at zero, and refresh recovery.

**After.** Score, correct/incorrect/unanswered, accuracy, time taken, per-topic performance, per-question
breakdown, an analysis report with weak/strong topics and recommended revision, and a deterministic
fallback analysis if the AI call fails. Results are private to the owner.

---

## 9. Code Lab fix (requirement 9)

The actual cause, traced as required: the UI sent the right mode, the route was mounted, auth passed, and
the AI service returned `200` — but for the offline engine, non-JSON *coding* tasks had no template and
fell through to the physics `demoTeachingAnswer`. Only the AI service changed; the UI, the request shape
and the code runner were left alone.

Verified for all six modes against the live server: `review` and `bugs` return structured reviews with a
summary, `ask` and `explain` return 1000+ character answers, none contain the physics contamination
markers (`train`, `substitute with units`, `km/h`), attribution is `provider: 'sample'` /
`model: 'vroqn-sample'`, and Python execution still prints `6` for `print(sum([1,2,3]))`.

**Root cause of the empty JSON-mode response (B9):** the demo path returned the structured object but no
top-level prose, so the UI rendered nothing where it expected text. Fixed alongside B6.

---

## 10. Homepage implementation (requirement 2)

`client/src/features/landing/LandingPage.tsx`, lazy-loaded, static (no data fetching, so it renders
instantly and cannot fail on a network error).

Content: hero; the seven-step loop; problem → solution; six feature cards (AI Tutor, Practice, Mock Exam,
Notes, Code Lab, Vroqn Arena); the diagnosis path and "Practice My Weak Areas", which links to the real
Practice surface; a trust section; a final CTA with both sign-in and sign-up; and a footer with the
required disclaimer.

Compliance with the stated constraints: no traffic, ranking or outcome claims; Arena is described as an
**independent competition created inside Vroqn Nexus** and explicitly **not** an official JEE/NEET
examination. Verified automatically — `ui-smoke` fails if the disclaimer wording is missing, if any of the
six features is unnamed, if either CTA link is absent, or if the footer or `h1` disappears.

Routing: signed-out `/` is the homepage, `/login` and `/signup` are public, unknown paths fall back to `/`.
Signed in, `/` remains the dashboard and `/login`/`/signup` redirect there.

---

## 11. Arena fixes

Arena was reviewed end-to-end and **no functional defect was found** — the lifecycle, approval gate,
answer-key secrecy and ownership rules all held under test. What was found and fixed:

| Finding | Severity | Fix |
| --- | --- | --- |
| The admin paper-review screen had no entry point, so the approval gate Arena requires was unreachable from the UI | MEDIUM | Admin-only **Paper Review** nav entry, gated on `user.role`; the API gate is unchanged |
| Dead `forceRegister` helper in the seeder, with a comment claiming the seeder writes registrations directly (it uses the real `register()`) | LOW | Removed the dead helper |
| Unused parameters in `attempts.ts`, a dead local in `blueprint.ts`, an unused type import in `results.ts`, a dead `savedAt` ref in the runner | LOW | Removed |

Verified working and left untouched: the server-clock state machine
`REGISTRATION_OPEN → LIVE → SUBMISSION_CLOSED → PROCESSING_RESULTS → RESULTS_PUBLISHED → ARCHIVED`;
registration idempotence; the paper lock before the start time; **entry closed to late joiners**; the
answer key absent from every pre-publish payload; autosave and reload-resume; the scored submit outcome;
a refused second submission; competition history kept separate from AI chat history; weak areas fed from
real topic stats into Practice; and `403` on every admin route for a non-allowlisted account.

---

## 12. Security fixes

| Item | Status |
| --- | --- |
| Practice answer key exposed to the browser before an attempt (B5) | **FIXED** |
| Auth limiter locking out a shared school NAT address (B7) | **FIXED** |
| Mock Exam `timeSpentMs` trusted from the client (B8) | **FIXED** — derived server-side, capped |
| Mock Exam accepted post-deadline answer writes at the API level | **FIXED** — `409 time_up` |
| Mock Exam duplicate submit | **FIXED** — `409 already_submitted`, no second result row |
| Duplicate submits double-counting `topic_stats`, corrupting weak-area diagnosis | **FIXED** |
| Admin UI unreachable (availability, not exposure) | **FIXED** |
| Python tracebacks exposing the server temp path (B15) | **ACCEPTED / LOW** — sandbox temp dir, no secret; the traceback itself is genuinely useful to a student |
| No secrets, keys, passwords or DB credentials in client code | **VERIFIED** — scanned; none found. API keys are encrypted at rest and never returned to the browser |
| Hardcoded production/demo credentials | **VERIFIED** — none in `src`; demo credentials exist only in the README, `scripts/api-smoke.sh` and the seeders, and both seeders refuse to run against production without an explicit opt-in |
| IDOR / ownership | **VERIFIED** — Mock Exam, Practice, Notes, Arena and results all return `404`/`403` for another account's data (tested with an intruder account) |
| `dangerouslySetInnerHTML` | **VERIFIED** — none; Markdown renders to React nodes |
| Console logging of secrets | **VERIFIED** — none, and secrets are redacted in error paths |

No existing control was weakened. The two security-adjacent changes both *tighten* behaviour.

---

## 13. Mobile fixes

**What was verified:** a static hazard audit of every page (fixed widths, non-responsive grids, tables
without scroll wrappers, sub-12px text, tap targets), plus the landing page's own review, plus jsdom
rendering of all 33 screens.

**Result: no mobile blocking defect was found.** The existing implementation is genuinely mobile-first:

* the desktop sidebar is `hidden lg:flex`; the mobile bottom bar and drawer carry the same five primary
  destinations;
* the Arena runner hides all chrome during an exam, moves its palette into a full-screen dialog on
  mobile, and keeps the timer in a sticky header;
* the exam palette's 5-column grid and the admin table's `min-w-[720px]` are both desktop-only, and the
  admin table is inside `overflow-x-auto`;
* every marketing grid on the new landing page is responsive (`sm:`/`lg:` prefixed);
* no table lacks a scroll wrapper; no fixed width outside a desktop-only container.

Addressed: **B17** — dense toolbars use 32 px `size="sm"` buttons, below the 40–44 px guidance. Recorded
as `LOW` deliberately rather than churning the design system late in the pass.

**What could not be verified:** real pixel layout. No browser binary is available in this environment and
the UI harness is jsdom, which does not compute layout. Every mobile claim above is structural or
class-level, not visual. **Open the app on a phone before claiming mobile is proven.**

---

## 14. Tests performed

| # | Test | Result |
| --- | --- | --- |
| 1 | `npm run typecheck` (with `noUnusedLocals`/`noUnusedParameters` now on) | 0 errors |
| 2 | `npm run build` | green |
| 3 | `npm test --workspace server` | 84/84, 22 suites |
| 4 | `npm run smoke:api` | 135/0 |
| 5 | `npm run smoke:ui` | 33 screens, 0 failed, 0 runtime errors |
| 6 | `npm run smoke:flows` | 72/0 across the eight student flows |
| 7 | Mock Exam: clock starts once, survives a GET, deducts elapsed time, expires | verified by curl + tests |
| 8 | Mock Exam: autosave, flag, resume, unknown question, post-deadline write | verified by curl |
| 9 | Mock Exam: duplicate submit, server-timed submit, cap, autosave merge, ownership | verified by curl + tests |
| 10 | Practice: answer key absent from generate and get; explanation still returned by `/check` | verified by curl |
| 11 | Code Lab: all six assist modes + run + error + unsupported language | verified by curl |
| 12 | Voice: capabilities, no-key STT failure with a hint, TTS device-voice fallback | verified by curl |
| 13 | Rate limiter: lab sign-in, failure lockout, separate budgets, per-address tracking | 4 tests |
| 14 | Auth: signup, duplicate, weak password, wrong password, session persistence, logout, 401s | flow 1 + flow 8 |
| 15 | Arena: register, double register, early start, late join refused, autosave, reload-resume, submit, duplicate refused, history, weak areas, admin 403 | flow 7 |
| 16 | Migration applied to an **existing** database (not just a fresh one) | verified: `0001, 0002, 0003`, columns present |
| 17 | Production fail-fast (missing secrets, short JWT, SQLite in prod, bad DSN) | verified in the CSC pass; unchanged |
| 18 | Seeders refuse production without an explicit opt-in | unchanged, still enforced |

---

## 15. Tests NOT performed (stated plainly)

1. **No real browser.** No Chrome/Chromium/Playwright binary exists in this environment. All UI
   verification is jsdom (DOM + behaviour, no layout, no CSS, no pixels). Pixel layout, animation
   smoothness, cross-browser rendering and true mobile viewports are **not verified**. This is the single
   largest gap in the verification story.
2. **No live PostgreSQL server.** The Postgres path is code-reviewed and guarded by
   `postgres-compat.test.ts`, and the new migration follows the same portable rules — but it has only
   ever been *executed* against SQLite. A Postgres deploy should be smoke-tested once before judging.
3. **No real provider API key.** Every AI path was exercised through the offline sample engine and the
   failover/rotation unit tests. Therefore **not verified against a live provider**: real Gemini/Groq/
   OpenRouter completions, real Whisper transcription, real Gemini TTS audio, real streaming, live
   rate-limit behaviour, and whether a live model honours the structured-JSON contracts. The
   graceful-degradation paths *were* verified.
4. **No real audio recording.** STT was tested by posting bytes with no key connected (rejection path)
   and by verifying the request contract. Actual microphone capture to a transcript is not verified.
5. **No multi-instance deployment.** Rate limiting is in-process; behaviour behind a load balancer was
   not tested.
6. **No container-isolated code execution.** Code Lab runs in a stripped child process, not a sandbox —
   a known and documented limitation, unchanged by this pass.
7. **No load, soak or concurrency testing** beyond the duplicate-submission races.
8. **Long-session timers** (an exam left open for hours in a real browser) were simulated by back-dating
   the database, not by waiting.

---

## 16. Remaining issues

| Severity | Issue | Why it remains |
| --- | --- | --- |
| MEDIUM | **No real-browser / mobile-pixel verification** | No browser binary available. The code is structurally sound and every hazard found by static analysis was fixed, but layout is unproven. Fix by opening the app on a phone and in Chrome/Firefox before judging |
| MEDIUM | **No Postgres runtime test** | No server available. The migration is portable by construction and the portability rules are asserted in tests, but the first Postgres deploy is still the first Postgres run |
| MEDIUM | **AI behaviour unverified against live providers** | No key. The architecture, routing, failover and refusal handling are tested; the models themselves are not |
| MEDIUM | **Mock Exam accepts a late submission** | Deliberate: a student's work is not discarded over a slow connection, and the recorded time is capped. Arena remains strict. Change if the exam must be invigilated |
| LOW | 32 px tap targets in dense toolbars | Consistent with the design system; changing it late risks layout regressions for marginal gain |
| LOW | Python tracebacks expose a temp path | Useful to a student, harmless to an attacker; scrubbing it would reduce debuggability |
| LOW | Rate limiting is per instance | Fine for a single Render service; would need a shared store behind multiple instances |
| LOW | `smoke:api` and `smoke:flows` are stateful | Both drive the demo account through a live Arena paper and must be preceded by `npm run seed:arena --workspace server`, and paced ~1 minute apart. Both now say so in their own output |
| LOW | No offline/PWA caching | Out of scope for this pass |

---

## 17. What was deliberately *not* changed

* No existing feature was rebuilt or replaced.
* No new infrastructure: no microservices, no Redis, no WebSockets. Voice, AI, Arena, Notes, Practice and
  Settings run on what was already there.
* The three-provider AI model (Gemini / Groq / OpenRouter), multi-key rotation, BYOK and the
  never-bypass-safety-refusals rule were left exactly as they were.
* The dark cyan visual identity was preserved; only dead code and the two dead configuration items were
  removed.
* No fake or demo data was introduced as a substitute for real functionality. Where the offline sample
  engine answers, it now says so honestly (`provider: 'sample'`) instead of impersonating a provider.
