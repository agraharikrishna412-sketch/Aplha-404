# Arena — competitive mock exams

Arena is the **TEST → ANALYSE → LEARN AGAIN** half of the Vroqn loop, added on top of the existing
practice/exam pipeline. Students sit scheduled papers under a server-enforced clock and get a
hierarchical benchmark plus an AI post-analysis that hands them straight back into practice.

---

## 1. Student flow

| Step | Route | What happens |
| --- | --- | --- |
| Find a competition | `/arena` | Overview tiles (live / open / registered / completed), filterable catalog, recent attempts, "happening now" strip |
| Read the rules | `/arena/:id` | Structure (per-subject counts, difficulty mix, types, marking), instructions, rules, schedule with server time, registration + one primary action |
| Register | `/arena/:id` | Public competitions: one tap. Private: invite code. Idempotent, withdrawable while open |
| Write the paper | `/arena/:id/start` | Full-screen runner (no app shell): server-authoritative countdown, autosave, flags, palette, per-question timing, keyboard shortcuts, auto-submit at the deadline |
| Read the result | `/arena/results/:attemptId` | Score/accuracy, benchmark (percentile + position + population label), AI post-analysis, breakdowns, time analysis, anonymised standings, weak-area practice, answer review |
| Track progress | `/arena/my-competitions` | Registered/live/completed, attempt history with accuracy trend and deltas |
| Author (admin) | `/arena/admin` | Schedule, generate, review questions, run the lifecycle, delete a competition that never ran |

The **dashboard** gets one Arena strip when something is live or open, and Arena is a primary
destination in the sidebar (desktop) and in the dashboard's destination grid (phone).

## 2. Enforced rules

* **Server clock decides everything.** States (`UPCOMING → REGISTRATION_OPEN → LIVE →
  SUBMISSION_CLOSED → PROCESSING_RESULTS → RESULTS_PUBLISHED → ARCHIVED`) and per-attempt deadlines
  are computed on the server. The client receives `serverNow` only to render a countdown, so a wrong
  device clock changes nothing. Extending a competition window never extends a paper already started.
* **The answer key never reaches a student early.** `studentView()` omits `correctAnswer` and
  `explanation` while a paper is live; the key joins the result payload only after results publish.
* **Autosave, never lost work.** Answers/flags/timings are debounced to the server, retried after a
  failure, flushed on `visibilitychange`/`pagehide`, and restored on resume. A late submission is
  graded from what the server holds instead of being rejected.
* **Honest benchmarking.** Percentile/rank are computed over valid submissions to that competition
  only, labelled with the population (`Independent Vroqn mock · 61 valid submitted attempts`),
  withheld below five submissions, and never presented as an official exam rank. Standings are
  anonymised (`Aspirant N` / `You`).
* **Authoring is allowlisted.** `ARENA_ADMIN_EMAILS` (server env) gates `/api/arena/admin/*`;
  students get `403`. A competition with attempts cannot be deleted (archive instead).

## 3. API surface

All routes are under `/api/arena` and require a session; `/admin/*` additionally requires an
allowlisted account.

```
GET    /catalog                      categories, states, question types
GET    /overview                     live / open / upcoming / registered / completed + next
GET    /competitions                 catalog (?includeDrafts=true for admins)
GET    /my-competitions              registered, live, completed + my attempt index
GET    /history                      attempts with score, accuracy, percentile, deltas
GET    /competitions/:id             detail { competition, blueprint, questionCount, paper? }
POST   /competitions/:id/register    { inviteCode? } → registration (idempotent)
DELETE /competitions/:id/register    withdraw while registration is open
GET    /competitions/:id/status      state, serverNow, remainingSeconds, attempt
POST   /competitions/:id/start       → full paper with the student's saved answers
POST   /competitions/:id/answers     autosave [{ questionId, answer?, flagged?, timeSpentMs? }]
POST   /competitions/:id/submit      { answers[] } → scored attempt
GET    /results/:attemptId           score, benchmark, breakdowns, time, report, review, standings
POST   /results/:attemptId/analyze   generate/regenerate the performance report
POST   /results/:attemptId/practice  weak-area sets + deep link into Practice

GET    /admin/competitions                 list + presets + categories
POST   /admin/competitions                 create (schedule validated)
PATCH  /admin/competitions/:id             reschedule
DELETE /admin/competitions/:id             delete while unstarted (409 once attempts exist)
POST   /admin/competitions/:id/action      publish · open_registration · close_registration ·
                                          start_now (+extendMinutes) · close_submissions ·
                                          publish_results · archive
POST   /admin/competitions/:id/generate    fill the blueprint (bankOnly? replace?)
GET    /admin/competitions/:id/questions   authoring view with the answer key
PATCH  /admin/questions/:questionId        edit text/options/answer/explanation or review status
DELETE /admin/questions/:questionId        remove a question from the paper
```

## 4. Data model (migration `0002_arena`)

`arena_competitions`, `arena_questions`, `arena_registrations`, `arena_attempts`, `arena_answers`,
`arena_results`, `arena_performance_reports`, plus `users.role`. Questions store their `source`
(`ai` | `bank` | `demo`) and `review_status`; attempts store their own `deadline_at`; results store the
computed benchmark and the cached report.

## 5. Question pipeline

1. `blueprint.ts` — presets (Foundation 30, Pre-JEE 60, Pre-NEET 60, Olympiad 25) expand into
   subject × difficulty × type slots, with a `custom` normaliser for hand-built blueprints.
2. `questions.ts` — AI candidates first (validated, numbers-stripped near-duplicate detection), then
   the curated `demoBank`, then the parameterised `sampleBank` (41 templates), always sliced to the
   slot size. Provenance decides the dedupe rule: an `ai` repeat with new values is a duplicate, a
   `bank` variant with new values is not.
3. `validateQuestion` — four options of the right shape, answer present in the options, explanation
   that actually states the answer (token coverage, so "x = 2, 3" and "x = 2 or x = 3" both pass),
   numeric sanity. Only disqualifying issues reject; advisory notes are surfaced to the admin instead.
4. Generation reports `created / rejected / flagged / bySubject` and the paper is reviewable
   per question before it goes live.

## 6. Configuration

| Variable | Purpose |
| --- | --- |
| `ARENA_ADMIN_EMAILS` | Comma-separated allowlist for `/arena/admin`. Empty = student-only deployment |
| `ARENA_SEED_DEMO` | `1` lets `seed:arena` write demo competitions against a production build |
| `ARENA_REQUIRED_APPROVAL_RATIO` | Default `1`: share of the paper that must be approved before students can enter (0.5–1) |
| `ARENA_NUMERIC_TOLERANCE_PCT` | Default `1`: numerical answers within this % of the expected value are marked correct |
| `ARENA_NUMERIC_TOLERANCE_ABS` | Default `1e-9`: absolute tolerance used only when the expected value is `0` |
| `FRAME_ANCESTORS` | Production only: explicit CSP allowlist for embedding Vroqn in a school portal |

## 7. Commands

```bash
npm run seed:arena --workspace server   # 3 demo competitions: open / live / results published
npm run dev --workspace server          # API on :8787
npm run dev:client                      # Vite on :5173 (proxies /api)
npm run typecheck                       # server + client, strict unused-symbol checks
npm test --workspace server             # 60 unit/integration tests (includes the Arena lifecycle + grading suite)
npm run build                           # client bundle + compiled server
bash scripts/api-smoke.sh               # 118 student checks
ARENA_ADMIN_EMAILS=demo@vroqn.dev bash scripts/api-smoke.sh   # 132 checks incl. the admin path
npm run smoke:ui                        # 32 UI checks in a DOM against the live API
DUMP_ROUTE=/arena/<id>/start node scripts/ui-smoke.mjs        # print one screen's text
```

The Arena sections of the smoke scripts write real data (they register, sit and submit the live demo
paper, and — as admin — create and delete a throwaway competition). Re-run `seed:arena` to restore the
demo state.

## 8. Demo data

`seed:arena` creates three competitions for `demo@vroqn.dev` / `nexus1234`:

* **Vroqn Pre-JEE Challenge — Demo** — registration open, 60 generated questions.
* **Vroqn Physics Challenge — Demo (live now)** — live, 15 questions, the student is registered.
* **Vroqn Pre-NEET Challenge — Demo (results out)** — 60 questions, 61 valid submissions, and a graded
  attempt for the demo student (rank, percentile, full analysis) so the results screen has real content.

Every seeded question is approved through the same review function the admin console uses, because a
competition may not start until its paper has been approved — the seeder cannot bypass that gate.

## 9. Limitations

* Percentile is competition-relative by design; it is not a predictor of any official exam rank, and
  the UI says so on every screen that shows it.
* The live competition is time-boxed by the seeder (45 minutes from seeding). Re-run the seeder to get
  a fresh window.
* Report generation falls back to a deterministic server-side report when no AI key is connected —
  same structure, no model prose.
* Admin authoring covers generation, review, lifecycle and deletion; editing a question's text through
  the UI edits prompt/options/answer/explanation but does not re-run the validator, so re-check
  `review_status` stays `pending` until an admin approves the edit.
