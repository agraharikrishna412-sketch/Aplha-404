# CSC Back-to-School submission — review & fix report

**Project:** Vroqn Nexus — mobile-first AI learning workspace with the Arena competitive-exam track
**Scope of this pass:** review and fix the existing codebase for stability, security and demo-readiness.
No feature was removed and no new product surface was added; every change below is a fix, a guard or a
verification aid.
**Ships as:** `vroqn-nexus-code.zip` (this report is included at `docs/CSC-REPORT.md`). The archive was
extracted into an empty directory and verified from scratch — see §5.5.
**Verified on:** the running build and the extracted archive itself (Node 20, SQLite dev database, no AI provider keys
present — the AI paths were exercised through their deterministic fallback and the existing failover tests).

---

## 1. Problems found (and what was actually wrong)

### Arena

| # | Problem | Why it mattered |
| --- | --- | --- |
| A1 | Numerical marking used a hardcoded tolerance: `Math.max(|expected| × 0.01, 1e-9)`. | The requirement is a configurable tolerance. The absolute floor also leaked into non-zero answers, so an expected `1.0e-10` accepted `1.5e-10` — a 50% error marked correct. |
| A2 | Nothing required the paper to be approved before students sat it. The lifecycle went LIVE on the clock alone, and `paperTotals()` counted *every* question including rejected ones. | A competition could start with unapproved, flagged or half-generated questions while still showing a full mark denominator. |
| A3 | `generatePaper()` could rewrite a paper while students were writing (or after they had written) it. | Regenerating during a live paper changes what students already received; grading would compare against a different question set. |
| A4 | A second submission silently returned the stored result. | Requirement 5 asks to prevent duplicate submissions. Silent success also hid the real race between a tab and the auto-submit timer. |
| A5 | A final submit arriving after the deadline could still add answers. | The deadline was enforced for reads but a late POST could change the graded set. |
| A6 | Generated questions (AI **and** bank) were stored as `approved`. | The approval gate is only meaningful if generation cannot approve its own output. |
| A7 | Paper generation could finish short of its blueprint without failing (`pre-neet` produced 58 of 60). | The demo showed a 58-question paper advertised as 60, and a rejected bank candidate ended the fill attempt for that section. |
| A8 | The result payload did not say how the paper was marked. | A student whose numerical answer was accepted within tolerance had no way to see the rule that was applied. |
| A9 | Seeded historical results were written by back-dating rows, not by running the flow. | The demo data did not exercise the very guards the competition depends on. |
| A10 | The offline sample engine declared `provider: 'gemini'`, and the Arena analysis persisted that verbatim. | The audit trail claimed a Gemini call produced the analysis when only the built-in sample library ran — sample output presented as model output. |

### Database / deployment

| # | Problem | Why it mattered |
| --- | --- | --- |
| D1 | Production configuration was never validated: the server happily started in `production` with generated secrets, `DEMO_MODE=on` and a SQLite file. | A production deploy could silently lose every session and stored API key on restart, and serve the sample AI engine. |
| D2 | `npm run seed` would create demo accounts in any environment, with a published password. | Hardcoded demo credentials in production. |
| D3 | The PostgreSQL driver path had no boolean/bigint normalisation and no startup connectivity check. | Postgres returns `true/false` and strings for `BIGINT`, while the app compares `=== 1` and does arithmetic; and an unreachable database only surfaced on the first user request. |
| D4 | Migrations ran `CREATE UNIQUE INDEX` statements that could abort the whole migration on a duplicate row. | On a legacy Postgres database, a duplicate row would make the app fail to boot with an opaque error. |
| D5 | "Results are visible" was computed from a timestamp in some places and from `status` in others. | An admin who published results could get a state label that disagreed with the locked/unlocked result screen. |
| D6 | `DEMO_MODE` was never enforced server-side. The sample engine depended only on the *per-user* setting (default `true`), so `DEMO_MODE=off` changed nothing — and in production the server refused `DEMO_MODE=on` while still permitting the sample library. | The switch did the opposite of what it documented: an operator disabling sample content still served it, and production served sample answers by default. |

### Frontend

| # | Problem | Why it mattered |
| --- | --- | --- |
| F1 | `ProgressBar` takes a ratio (0–1), but three Arena call sites passed percentages. | Score and accuracy bars were pinned at 100% regardless of the score. |
| F2 | `scoreTone()` takes a ratio, but Arena passed `accuracy / 100`. | Accuracy was always coloured as a failure and the "good/ok/weak" thresholds never matched. |
| F3 | The accuracy-trend chart on My Competitions treated a 0–1 ratio as a 0–100 percentage. | Labels read "1%", bar heights were clamped and every bar was red. |
| F4 | Opening the runner for a paper that was already submitted showed a dead-end error. | The most likely demo click — re-opening a submitted paper — ended on an error screen instead of the analysis. |
| F5 | An expired session left the UI on the signed-in screens while every request failed. | No global 401 handling: the student had no way forward except manually clearing the cookie. |
| F6 | The runner's per-question time merge read a stale value from a render closure. | Question timings (which the post-analysis uses) were under-reported when navigating quickly. |
| F7 | A failed history load on My Competitions rendered as an empty list. | "No competitions yet" is misleading when the request actually failed. |

### Auth / API surface (reviewed, already sound)

Registration idempotence, ownership checks (`403` on another student's attempt/result/analysis), the
answer-key projection, `requireAdmin` on `/admin/*`, rate limits and the httpOnly cookie session were
already correct — they are now covered by tests and API-level checks rather than assumed.

---

## 2. Fixes made

**Marking and paper integrity**
- New `server/src/services/arena/grading.ts` — the single grading entry point (`results.ts` imports it).
  Correct → full marks, wrong → `-negativeMarks`, blank → 0. Option letters (`B`), option text, units,
  commas, exponent notation and trailing punctuation all handled.
- Tolerance is configuration: `ARENA_NUMERIC_TOLERANCE_PCT` (default 1%), `ARENA_NUMERIC_TOLERANCE_ABS`
  (default `1e-9`, used **only** when the expected value is 0). A competition's blueprint may override the
  percentage; the resolved rule is reported in the result payload and on the analysis screen.
- `paperReadiness(competitionId)` → approved / pending / flagged / rejected against
  `ceil(paperSize × ARENA_REQUIRED_APPROVAL_RATIO)` (default 1 = every question). Enforced when an admin
  starts/publishes **and** when a student enters the paper (`409 paper_not_ready`, blocker included).
- Generated questions now land as `pending`; the seeder approves them through the same review function the
  admin console uses. `paperTotals()` counts approved questions only.
- `paperLockedFor(state)` + `generatePaper({ force })` — a live, closed, published or archived paper is
  immutable (`409 paper_locked`).
- Slot filling is now a validation-aware loop that widens within the subject (keeping each template's own
  difficulty label) and reports every relaxation. `pre-neet` and `pre-jee` now produce a full 60/60, and a
  shortfall is named in the generation warnings instead of being hidden.

**Submissions, timing and results**
- Duplicate submission → `409 already_submitted` with `{ attemptId, resultId }`; the runner navigates to the
  existing result (both on load and on submit).
- Late answers are ignored in the **service**, not just the route: once the attempt deadline or the
  competition end has passed, the paper is graded from what the server already holds and recorded as
  `autoSubmitted`.
- Attempt deadlines are stored at start time (`min(now + duration, ends_at)`) and never re-negotiated with
  the client; extending a window does not extend a running paper.
- Results visibility comes from one derived helper (`isPublished`), used by the API and the UI.

**Database / production**
- `assertConfig()` fails the boot with a named list of problems. Verified: production without
  `JWT_SECRET`/`VROQN_MASTER_KEY`/`DATABASE_URL` → refuses (exit 1); short `JWT_SECRET` → refuses; with all
  three plus `ALLOW_SQLITE_IN_PROD=1` → starts; unreachable Postgres → fails at boot with the driver error.
- `db/seed.ts` refuses to seed in production unless `SEED_ALLOW_PROD=1` **and** an explicit `SEED_PASSWORD`
  is given. Demo credentials are dev defaults only, documented as such, and the smoke scripts now read
  `SMOKE_EMAIL`/`SMOKE_PASSWORD` from the environment.
- Postgres driver: booleans/bigints normalised on read, `ping()` on boot, `getDb()` wraps connection errors,
  and migrations tolerate a pre-existing duplicate row instead of aborting.
- Seeder history now walks the real lifecycle (register → start → submit → publish → back-date the schedule),
  so the demo state is something the server itself produced.

**AI system: the sample-engine switch and attribution**
- `DEMO_MODE=off` is now a real server-side cap: the sample library answers only when the student's own
  setting allows it **and** the server allows it. In production the cap defaults to **off** (sample content
  is never served unless the operator explicitly opts in), in development it stays on so the demo works
  without keys. Verified: `off → cap=false`, dev unset → `true`, production unset → `false`.
- Sample answers are no longer attributed to a provider that never ran: the Arena analysis persists
  `provider: 'sample'`, `model: 'vroqn-sample'` instead of the provider id that *would* have been used, and
  the report payload exposes that attribution. The AI trace in chat already labelled it "Sample engine".
- Added `test/demo-mode.test.ts` (3 tests) proving the cap and the refusal path, and a lifecycle test that
  asserts the analysis prose contains **this attempt's** score and only topics from **this paper**, with the
  stored attribution checked in the database. That test was confirmed to fail against the old code.

**Frontend**
- Ratio/percentage scale bugs fixed at every Arena call site; `ProgressBar` now documents its 0–1 contract.
- Runner redirects an already-submitted paper to its result; the server sends the attempt id it needs.
- Global 401 handling: `onUnauthorized()` in the API client clears the session, so an expired cookie returns
  the student to the sign-in screen with a message instead of a broken page.
- Runner timing merge reads from a ref mirror; My Competitions surfaces load errors.
- Practice hand-off: the server returns one ready-made deep link per suggestion
  (`subject`, `chapter`, `difficulty`, `questionType`, `count`, `from=arena`, `topic`), and `PracticePage`
  validates/clamps those parameters and shows a "From your Arena result" badge.

---

## 3. Files changed

**Server** — `src/config/env.ts`, `src/index.ts`, `src/types/arena.ts`, `src/db/index.ts`, `src/db/schema.ts`,
`src/db/seed.ts`, `src/db/seed-arena.ts`, `src/services/arena/grading.ts` *(new)*,
`src/services/arena/questions.ts`, `src/services/arena/blueprint.ts`, `src/services/arena/competitions.ts`,
`src/services/arena/attempts.ts`, `src/services/arena/results.ts`, `src/services/arena/sampleBank.ts`,
`src/routes/arena.ts`, `test/arena-lifecycle.test.ts` *(new)*, `test/arena-grading.test.ts` *(new)*,
`test/postgres-compat.test.ts` *(new)*

**Client** — `src/types/arena.ts`, `src/lib/api.ts`, `src/hooks/useAuth.tsx`, `src/components/ui.tsx`,
`src/features/arena/ArenaRunnerPage.tsx`, `src/features/arena/ArenaResultsPage.tsx`,
`src/features/arena/ArenaMyPage.tsx`, `src/features/arena/ArenaCompetitionPage.tsx`,
`src/features/arena/ArenaAdminPage.tsx`, `src/features/practice/PracticePage.tsx`

**Scripts / docs** — `scripts/api-smoke.sh`, `README.md`, `.env.example`, `docs/ARENA.md`,
`docs/ARCHITECTURE.md`, `docs/SECURITY.md`

---

## 4. Database changes

No destructive change and no data migration was required; the schema (`0001_initial`, `0002_arena`) is
unchanged in structure.

- Numerical tolerance lives in the competition's `blueprint` JSON (optional `numericTolerance`), so no column
  was added.
- `migrate()` now runs each statement through a wrapper that warns and continues if a `CREATE UNIQUE INDEX`
  hits an existing duplicate row (previously it aborted the migration).
- Reads normalise `BOOLEAN`/`BIGINT` values for the Postgres driver; `COUNTA(*)` results are always coerced
  with `Number()` before arithmetic.
- A startup `ping()` proves the database is reachable before the API accepts traffic.
- Demo data is still fully re-creatable: `npm run seed --workspace server` and
  `npm run seed:arena --workspace server` (the latter writes real registrations, attempts, results and reports).
- A portability test asserts, on every run, that each `ON CONFLICT (…)` target has a matching unique
  constraint, that column types are engine-neutral, that booleans are `INTEGER 0/1`, and that no
  SQLite-only SQL exists anywhere in the server source.

---

## 5. Tests / build status (real output from this pass)

| Check | Command | Result |
| --- | --- | --- |
| Typecheck (server + client) | `npm run typecheck` | clean |
| Unit / integration tests | `npm test --workspace server` | **64 tests / 18 suites — 64 pass, 0 fail** (was 27). New: `arena-lifecycle` (14), `arena-grading` (14), `postgres-compat` (6), `demo-mode` (3) |
| Production build | `npm run build` | green — client bundle + `server/dist` |
| API smoke, student | `bash scripts/api-smoke.sh` | **121 passed, 0 failed** (was 115) |
| API smoke, admin | `bash scripts/api-smoke.sh` against a server started with `ARENA_ADMIN_EMAILS` | **135 passed, 0 failed** (was 124) — the script now detects the admin surface from the server instead of its own shell environment |
| UI smoke (real build in a DOM) | `npm run smoke:ui` | **32 checks, 0 failed, 0 runtime errors** (runner-redirect branch: 28 checks, 0 failed) |
| Seeder | `npm run seed:arena --workspace server` | 3 competitions, papers 60 / 15 / 60 questions, 61 valid attempts, demo score 128/240 · rank 28/61 · percentile 54.9 |
| Production guards | manual runs of `node server/dist/index.js` and `npm run seed` in `NODE_ENV=production` | 5 scenarios verified (missing secrets, short secret, SQLite opt-in, unreachable Postgres, seeding refusal) |

### Verification of the shipped archive (clean-clone test)

The `.zip` that accompanies this report was extracted into an empty directory (no `node_modules`, no
database, no `.env`) and put through the whole pipeline from scratch — this is what a reviewer will do:

| Step in the clean clone | Result |
| --- | --- |
| `npm install` | 299 packages, no errors |
| `npm run typecheck` | 0 errors (server + client) |
| `npm test --workspace server` | **64 passed, 0 failed** |
| `npm run build` | client bundle + `server/dist` built |
| `npm run seed --workspace server` | demo student, notes and activity created |
| `npm run seed:arena --workspace server` | 3 competitions with approved papers (60 / 15 / 60 questions, 61 valid attempts) |
| `bash scripts/api-smoke.sh` (against the clone on :8790) | **135 passed, 0 failed** |
| `npm run smoke:ui --workspace client -- http://localhost:8790` | **32 checks, 0 failed, 0 runtime errors** |

Two things this also confirmed:

* **The archive contains no secrets and no data.** No `.env`, no `server/.data`, no database, no
  `server.secrets.json` — checked with `unzip -l`. The clone generated its own JWT secret and master key
  on first run with `0600` permissions, and the seeders produced the demo state from nothing.
* **A freshly migrated database passes every check**, so the schema and migrations are self-sufficient
  (no manual SQL step is needed before the demo).

### Runtime proofs recorded during the second pass

| Claim | How it was proven | Result |
| --- | --- | --- |
| The analysis uses the student's real data | Generated the report for the seeded attempt and compared it line by line with `arena_results` / `arena_answers` | `DB: 128/240, 37 correct, 20 wrong, 3 blank` → prose says the same; weak areas are topics from that paper; report persisted (1,470 bytes) |
| The fallback fires when the AI layer fails | Ran with the sample engine disabled and no keys (the AI call raises), then requested the analysis | `source: local`, full summary/strong/weak/plan sections, stored with no provider attribution |
| `DEMO_MODE` really gates the sample engine | Same code path run three ways | `DEMO_MODE=off → demoAllowed=false` · unset (dev) `→ true` · unset (production) `→ false` |
| Sample output is never attributed to a provider | Reverted the attribution fix and re-ran the test (it fails), then restored it | Fails as `expected 'sample'`; passes after the fix, in the report payload **and** the database column |
| Arena → Practice hand-off (item 8) | `POST /arena/results/:id/practice` then rendered the returned deep link in the real UI | 4 suggestions with validated params; the Practice screen shows the "From your Arena result" badge, states that "Ecosystem basics" was flagged, and pre-selects Biology — the notice renders exactly once |

What the new tests actually prove:

* **Lifecycle** — `REGISTRATION_OPEN → LIVE → SUBMISSION_CLOSED → RESULTS_PUBLISHED → ARCHIVED` derived from
  the server clock; a client-supplied clock drift of −99 minutes cannot move the attempt deadline; extending
  a competition window does not extend a running paper.
* **Approval gate** — a freshly generated paper blocks both student entry and admin start (`paper_not_ready`);
  flagging a question mid-competition blocks a newcomer; an approved paper lets students in; a live paper
  cannot be regenerated (`paper_locked`).
* **Key secrecy** — the serialised paper contains no `correctAnswer`/`explanation` before publish; the review
  and benchmark are withheld until results are published, then appear.
* **Submissions** — a duplicate submit raises `already_submitted` carrying the attempt id; after the deadline
  the server grades its own stored answers and ignores the late set (`autoSubmitted: true`).
* **Access control** — another student gets `403` on the attempt, the result and the analysis; competition
  history contains only Arena attempts and never chat conversations (and vice versa).
* **Grading** — tolerance from env, from a blueprint override, the boundary values on both sides, `0`
  expected, scientific notation, commas and units, option letters, negative marking, blank answers, and the
  mid-rank/percentile maths including ties and negative totals.
* **Portability** — the Postgres rules above, plus an assertion that Arena services never touch the chat tables.

---

## 6. Remaining limitations (honest list)

1. **No PostgreSQL server exists in this environment.** Every Postgres fix is code-reviewed and covered by the
   automated portability test, but the app was executed against SQLite. Production should be smoke-tested
   against a real Postgres instance (`DATABASE_URL=postgres://…`) before launch.
2. **No AI provider keys are present**, so live Gemini/Groq/OpenRouter calls were not exercised here. The AI
   layer is covered by the existing failover/taxonomy tests, and every AI-dependent Arena feature has a
   deterministic server-side fallback (`localReport`, the sample bank) that *was* exercised. The failure
   path was proven directly: with the sample engine switched off and no keys, `POST /analyze` still returns a
   report built from the attempt's real numbers, and the request itself fails rather than inventing content.
3. **Benchmarks are competition-relative by construction** and withheld below five valid submissions; they are
   not a prediction of any official exam rank, and the UI states this.
4. **The demo password (`demo@vroqn.dev` / `nexus1234`) is a development default.** Production refuses to seed
   without `SEED_ALLOW_PROD=1` and an explicit `SEED_PASSWORD`, but the credential itself is intentionally
   documented for the demo.
5. **Per-competition tolerance is available through the blueprint payload and environment variables, not the
   admin UI.** Changing it per paper currently means editing the blueprint (or the env default).
   Likewise `DEMO_MODE` is an environment switch; per-student control is the existing AI Settings toggle,
   and the server cap always wins over it.
6. **The UI smoke harness runs in a DOM, not a browser** — it proves routing, state and API wiring, not pixels
   or animation. The layout was reviewed at mobile and desktop widths but should be eyeballed once more in a
   real browser.
7. **Code Lab still runs code in a stripped child process**, not a container (unchanged from the prototype
   scope documented in `docs/SECURITY.md`).
8. **SQLite remains single-instance.** Multi-instance production requires `DATABASE_URL`; `ALLOW_SQLITE_IN_PROD`
   exists only for a single-instance demo.

---

## 7. How to reproduce the verified state

```bash
npm install
npm run typecheck && npm run build
npm test --workspace server

npm run seed --workspace server           # demo student + notes + activity
npm run seed:arena --workspace server     # 3 Arena competitions (registration / live / results out)

ARENA_ADMIN_EMAILS=demo@vroqn.dev npm run dev --workspace server   # API :8787
npm run dev:client                                                   # UI  :5173

bash scripts/api-smoke.sh                                   # 121 checks (student)
ARENA_ADMIN_EMAILS=demo@vroqn.dev bash scripts/api-smoke.sh # 135 checks (admin paths)
npm run build:smoke --workspace client && npm run smoke:ui   # 32 UI checks
```

Demo sign-in: `demo@vroqn.dev` / `nexus1234` (dev only). The admin console at `/arena/admin` is unlocked by
putting that address in `ARENA_ADMIN_EMAILS`. The Arena smoke checks write real data, so re-run
`npm run seed:arena --workspace server` afterwards to restore the demo state.
