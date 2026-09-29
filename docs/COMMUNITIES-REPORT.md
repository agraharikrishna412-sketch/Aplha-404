# Vroqn Communities — final report

**Scope:** the complete Vroqn Communities ecosystem (§1–§65 of `Vroqn_Communities_Complete_Master_Prompt.txt`)
plus the anti-cheating work (§44) and the online-exam integrity controls requested on top of it.
**Date:** 26 September 2026 · **Build:** Vroqn Nexus monorepo (`client` + `server`), SQLite in development,
PostgreSQL-compatible SQL for production.

This report answers the 17 numbered items of §65 in order, then records the anti-cheating work in detail.
Everything below was measured on this build; nothing is asserted that has not been run.

---

## Verification summary (what was run, and the result)

| Suite | Command | Result |
|---|---|---|
| Server unit + integration tests | `npm test --workspace server` | **107 tests / 31 suites · 0 fail** |
| Communities HTTP + integrity (new) | `node --import tsx --test test/communities-http.test.ts` (from `server/`) | **23 tests · 0 fail** |
| Communities end-to-end (new) | `node scripts/communities-check.mjs` | **PASS 83 / FAIL 0** (run 4× consecutively, identical) |
| API smoke | `bash scripts/api-smoke.sh` | **PASS 121 / FAIL 0** |
| Flow / contract checks | `bash scripts/flow-check.sh` | **PASS 72 / FAIL 0** |
| UI screens in jsdom | `node scripts/ui-smoke.mjs` (from `client/`) | **44 screens rendered · 0 failed · 0 runtime errors** |
| Real-browser checks (Chromium) | `node scripts/browser-check.mjs` | **30 passed / 0 failed** at 360, 390, 430 and 1440 px |
| Typecheck | `npm run typecheck` | **0 errors** (client and server) |
| Build | `npm run build` | **green** (client ~4.5 s, server `tsc`) |

Screenshots from the browser pass are in `docs/screenshots/` (including `390-community.png`, the
community page on a phone).

---

## 1. What was implemented

**A community feature that is a first-class part of Vroqn Nexus**, not a second app. Every screen
reuses the existing design tokens, UI kit, auth, database and Arena engine.

- **Discover / create / join / leave / my communities** — Explore page with search, category filters,
  tag filters, member counts, "popular" and "recent" sorts; a create form covering name, description,
  logo, banner, category, tags, rules, visibility, member limit, join requirements, welcome message and
  accent colour.
- **Three visibilities** — PUBLIC (instant join), PRIVATE (request → admin approves), INVITE-ONLY
  (secure, expiring, usage-limited code). Enforced entirely server-side.
- **Roles and permission matrix** — OWNER / ADMIN / MODERATOR / MENTOR / MEMBER, with a single
  capability matrix (`services/communities/permissions.ts`) consulted by every write. Ownership moves
  only through an explicit, confirmed **Transfer ownership**.
- **The community page** with eleven tabs (Home, Chat, Doubts, Competitions, Resources, Challenges,
  Study Plans, Events, Leaderboard, Members, Knowledge). Only the tabs a community actually has content
  and permission for are enabled.
- **Chat** — text, avatars, timestamps, replies/threads, @mentions, reactions, edit/delete own,
  moderator deletion, pinning, search, unread counts, cursor pagination, attachment sharing, polls and
  announcements; reports, mutes, blocks, flood control and a moderation queue with an audit trail.
- **Doubts and the knowledge base** — ask, answer, mark the helpful answer, promote a solved doubt into
  the community knowledge base (searchable, with the AI explanation attached).
- **Smart search** — one search across doubts, knowledge, resources, competitions, events, challenges,
  study plans and members, **scoped to the communities the caller is a member of**, with a
  community-scoped variant for the in-page search box.
- **Community competitions hosted on Arena** — no second competition engine. A host picks an Arena
  blueprint and schedule; the paper is an Arena paper with all Arena guarantees (server clock,
  question approval, no answer key before submission, one submission).
- **Resources** (links, notes and uploaded files with membership-gated download), **Challenges**
  (streaks with per-day ticks), **Study teams** (with standings), **Events**, **Study plans**,
  **Leaderboards**, **Badges**, **Contribution reputation**, **Notifications** (centre, unread badge,
  preferences), **My Communities**, **Creator dashboard**, **Analytics (aggregate only)**, **Rules and
  welcome message**, **Verified communities**, **Member management**, **Invites**, **Join requests**,
  **Reporting and moderation**, and **student-safety controls** (block, mute, report, no unrestricted
  private messaging, no public contact details).
- **Online-exam integrity (new, §44)** — a server-authoritative integrity record for every timed paper,
  used by both Arena competitions and personal mock exams, with a consent screen in front of the paper,
  an attempt-level and host-level view, and strictly limited data collection.

## 2. Files changed (high level)

**Server** (`server/src/`)
- `routes/communities.ts` (1,630 lines) — the whole `/api/communities` surface (~90 endpoints),
  including a `router.param('id')` hook that resolves a slug to its canonical id before any handler runs.
- `services/communities/` — 16 modules (~9,000 lines): `access.ts`, `permissions.ts`, `communities.ts`,
  `chat.ts`, `learning.ts`, `programs.ts`, `teams.ts`, `competitions.ts`, `notifications.ts`,
  `moderation.ts`, `polls.ts`, `reputation.ts`, `analytics.ts`, `search.ts`, `bus.ts` (SSE), `types.ts`.
- `services/arena/proctor.ts` — the integrity engine (shared by Arena and mock exams).
- `routes/arena.ts`, `routes/exams.ts` — signal + integrity endpoints; competition visibility rule.
- `services/arena/competitions.ts` — `isHost` on summaries, competition visibility clause.
- `services/exams.ts`, `services/arena/attempts.ts` — integrity hooks on submit.
- `db/schema.ts` — migrations 0004–0008 (below).
- `config/env.ts` — master-key format now validated in every environment.
- `test/communities-http.test.ts` — 23 new HTTP tests.

**Client** (`client/src/`)
- `features/communities/` — 21 files: Explore, Create, Community page, Notifications, Profile pages,
  the dashboard block, API client, hooks, shared components and the twelve tab modules.
- `features/arena/proctor/useProctor.ts`, `components.tsx` — `IntegrityNotice`, `ProctorBar`,
  `AwayNotice`, `IntegrityPanel`, `HostIntegrityList`.
- `features/arena/ArenaRunnerPage.tsx`, `ArenaResultsPage.tsx`, `ArenaCompetitionPage.tsx`,
  `features/exams/ExamRunnerPage.tsx`, `ExamResultPage.tsx` — consent gate, proctor wiring, panels.
- `features/landing/CommunitiesSection.tsx` (new) and `LandingPage.tsx` — hero block
  "Learn Together. Compete Together. Improve Together." with the Students → Knowledge → Practice →
  Competition → Progress animation.
- `features/communities/CommunitiesHomeBlock.tsx` mounted on the dashboard.
- `App.tsx`, `components/AppShell.tsx` — lazy routes and the Communities primary nav entry.
- `styles.css` — the flow animation plus its reduced-motion rules.

**Scripts / docs**
- `scripts/communities-check.mjs` (new, 22-phase E2E), `scripts/ui-smoke.mjs` and
  `scripts/browser-check.mjs` (extended for the consent gate and a mobile community page),
  `docs/COMMUNITIES-PLAN.md`, this report.

## 3. Database schema / migrations changed

Additive only. No existing table was dropped, renamed or reset; running the app applies them in order.

| Migration | Contents |
|---|---|
| `0004_communities` | Communities, members, join requests, invites, messages, reactions, polls, doubts, answers, knowledge, resources, challenges + day progress, study plans + tasks + progress, events, RSVPs, study rooms + participants, teams + members, announcements, notifications, notification prefs, reports, moderation actions, badges, contribution points, profile settings, blocks. |
| `0005_community_teams` | Team goal, member limit, status, timestamps. |
| `0006_community_resource_files` | Uploaded resource files (`stored_path`, size, mime, original name). |
| `0007_arena_integrity` | `integrity_events` (append-only, one row per observation) and `integrity_reports` (one summary row per paper, `UNIQUE (scope, ref_id)`), with indexes on `(scope, ref_id, occurred_at)`, `(scope, kind)` and `(scope, risk_level)`. `scope ∈ {arena, exam}`. |
| `0008_room_checklist` | `study_rooms.checklist` — the room's checklist template, so a joiner receives the host's list. |

Foreign keys, indexes, unique constraints and timestamps are in place throughout; `updated_at` is
maintained by the services. Verified on the live database: 8 migrations recorded, 71 communities,
115 memberships, 386 messages, 29 doubts, 6 integrity events, 1 integrity report, 0 orphaned rows.

## 4. API changes

All under the existing conventions (`requireAuth`, `limits.*`, `asyncRoute`, `zod` validation, the
`{ error: { message, code } }` envelope, camelCase views). Representative endpoints:

- **Communities:** `GET /api/communities/discover|search|smart-search|mine|dashboard|badges|profile/*`,
  `POST|PATCH|DELETE /api/communities[/:id]`, `POST /:id/transfer|join|leave|read`,
  `GET|POST /:id/join-requests[/:requestId]`, `GET|POST|DELETE /:id/invites[/:inviteId]`,
  `GET /:id/members|contribution|moderation|analytics`, `POST /:id/members/:userId/role|kick|ban|mute`.
- **Content:** `/:id/messages` (list/send/edit/delete/pin/reactions), `/:id/polls[/:pollId/vote]`,
  `/:id/doubts[/:doubtId/answers|helpful|knowledge]`, `/:id/knowledge`, `/:id/resources`
  (+ `/upload`, `/download`), `/:id/announcements`, `/:id/challenges[/:challengeId/days/:dayIndex]`,
  `/:id/plans[/:planId/tasks/:taskId]`, `/:id/events[/:eventId/rsvp]`, `/:id/rooms[/:roomId/join|checklist]`,
  `/:id/leaderboard`, `/:id/teams[/:teamId/join|leave|invite|members/:userId]`, `/:id/teams/standings`,
  `/:id/competitions[/:competitionId/register|withdraw]`, `/:id/home`, `/:id/mentions`,
  `POST|GET /:id/stream` (SSE), `POST /stream/user`.
- **Integrity:** `POST /api/arena/competitions/:id/signals`, `POST /api/exams/:id/signals`,
  `GET /api/arena/results/:attemptId/integrity`, `GET /api/exams/:id/integrity`,
  `GET /api/arena/competitions/:id/integrity`.
- **Changed in Arena:** competition lists and details now filter on visibility (see §11), and
  summaries carry `isHost` for the host UI.

## 5. Arena integrations

- A community competition **is** an Arena competition: created through `services/arena/competitions`,
  stored in `arena_competitions`, linked by `community_competitions`. There is one competition engine,
  one question pipeline, one scoring and ranking implementation.
- A private or invite-only community paper is stored as an Arena `private` paper and given a
  server-minted invite code that **is never returned to a browser**; membership of the community is the
  entry gate. Public community papers appear in Arena → Public competitions and carry "Hosted by".
- Community papers inherit Arena's guarantees verbatim: server-owned clock and deadlines, question
  review before a paper can start, no answer key before submission, one official submission, server-side
  scoring, percentile over the real participant set.
- Results and analysis shown inside a community are the Arena result views (score, accuracy,
  correct/incorrect/unanswered, time, rank, percentile, participant count, subject/topic/difficulty
  breakdown), labelled as Vroqn-created competitions — never as official board or JEE/NEET exams.

## 6. AI integrations

The three existing providers (Gemini, Groq, OpenRouter) are untouched; **no new provider, model or key
path was added**, and no model id is hardcoded. Communities use AI in two places, both optional and
both routed through the existing server-side BYOK router:

- **Ask Vroqn inside a doubt thread** — an AI answer can be requested and, if the student accepts it,
  one of the answers in the thread; provider failures degrade to a clear message, not a broken screen.
- **Knowledge entries** may store the AI explanation alongside the human answer, which is what makes
  the knowledge base searchable by concept rather than by wording.
- The integrity feature uses **no AI**, sends **no data to any provider**, and never sends attempt
  content anywhere.

## 7. Authentication / authorization changes

- No change to the session mechanism: same JWT cookie, same `requireAuth`, same scrypt password
  storage, same Bearer support.
- **Every** communities route is authenticated; every handler authorises through
  `loadForMember(userId, communityId, { requireMembership, capability })` so a new endpoint cannot
  forget the check.
- A community the caller may not read answers **404, not 403** — a 403 would confirm a private
  community exists.
- Ownership is a single row: `changeMemberRole` refuses any attempt to grant `owner`; only
  `POST /:id/transfer` (with `confirm: true`) moves it, and the previous owner becomes an admin.
- Slugs are supported in links and **resolved to the canonical id before any handler runs**
  (`router.param('id')`), so a slug can never be written into a row as if it were an id.

## 8. Existing features preserved

Login, signup, dashboard, AI tutor (with voice), practice, mock exams, notes, Code Lab, Arena
(competitions, attempts, results, analysis, benchmarks), learning activity, profiles, settings, key
management, the SSE/notification bus and the deployment setup are all unchanged in behaviour. The
server test suite (107 tests) covers the pre-existing Arena lifecycle, exam timing, grading, demo mode,
rate limiting, crypto and PostgreSQL compatibility, and all of it passes. No existing route was removed
and no existing table was altered destructively.

## 9. Tests performed

- **Automated, this build:** the table at the top of this report, plus 4 consecutive runs of the
  communities E2E script (identical 83/0 each time), two full server suites, and a browser pass at four
  widths.
- **New coverage added this turn:** 23 HTTP tests for slug addressing, private-community 404s, join
  requests, invite codes (including reuse), member limits, role escalation, ownership transfer, plan
  progress, event validation, room checklists, and the exam/Arena integrity endpoints (record, read,
  self-only access, freeze on submit, empty state, unknown signal kinds, one attempt per paper).
- **Manual/E2E coverage in `scripts/communities-check.mjs`:** 22 phases covering signup → create →
  join (public/private/invite) → chat lifecycle (send, reply, react, edit, delete, pin, search,
  pagination, poll, announcement) → doubts → knowledge → resources (link + file upload/download) →
  challenges → study plans → events → rooms → teams → competitions (host, register, non-member refused)
  → moderation (report, mute, ban, audit trail) → analytics → invites → join requests → notification
  preferences → search scoping → privacy checks.
- **Anti-cheat coverage:** the integrity endpoints are exercised both through the HTTP suite and through
  the browser pass, which accepts the consent screen as a student would and then confirms the paper
  runs (timer sticky, autosave working, attempt persisted server-side).

## 10. Bugs found and fixed

Real defects found by this turn's testing, all fixed and now pinned by tests:

1. **A slug was written into rows as if it were a community id.** Community links carry a slug; the
   detail route resolved it for display but downstream services wrote/queried `community_id = <slug>`,
   so messages and doubts posted through a slug URL became invisible and the owner of a community saw
   their own community as *"0 members · Join"*. Fixed by resolving the canonical id in
   `router.param('id')` before any handler runs, plus a slug-safe `membershipOf`, plus a repair of the
   two rows that had been written with a slug (0 remain).
2. **Ownership could be duplicated.** `changeMemberRole` allowed an owner to grant `owner` to somebody
   else, producing two owners with conflicting answers to "who owns this". Now refused outright;
   ownership moves only via the confirmed transfer, and the transfer leaves exactly one owner row.
3. **The integrity record never wrote its first row.** The `INSERT INTO integrity_reports` statement had
   20 placeholders and 19 values, so the first signal batch of any paper failed with a 500 — i.e. the
   anti-cheating feature silently recorded nothing until it had recorded something. Fixed; the tests now
   assert the rows in the database, not just the HTTP response.
4. **Private and invite-only competitions were listed to everyone.** `listCompetitions` had no
   visibility filter, so a community's members-only paper appeared in the public Arena list and its
   detail was readable by anybody who knew the id. A fresh account saw 13 papers including 8 private
   ones; it now sees 5, all public, and a private id returns 404.
5. **The owner was read from `created_by`, which never changes.** After a transfer the header and the
   manage screen still named the previous owner. The owner is now the holder of the owner role (falling
   back to `created_by`), and "communities I run" includes ones handed to me.
6. **A study room threw away the host's checklist**, and the host was not in their own room, so members
   received a generic list instead of the plan the host wrote. The template is stored on the room
   (migration 0008), the host is enrolled at creation, and joiners copy it.
7. **An event that had already finished could be created**, notifying every member about a session they
   had missed. Now rejected with a clear message (30-minute grace).
8. **Promoting a doubt to the knowledge base returned an empty id** on first promotion, so the client
   could not link to the entry it had just created.
9. **A malformed `VROQN_MASTER_KEY` only failed at the first key save** (a 500 for the student, far from
   the cause). The format is now validated at boot in every environment, and the process refuses to
   start with a bad key.
10. **4px horizontal page overflow on the community page** at 390px, caused by a negative margin on the
    tab strip; and **32px tap targets** on the dashboard's community actions. Both fixed; the browser
    pass at 360/390/430/1440 now reports zero overflow and no tap target under 40px.
11. **Two smoke-harness faults** that looked like product failures: the consent-gate text was read
    *after* the gate had been dismissed, and the exam runner wait pattern matched a word the gate also
    contains. The harness now asserts the captured gate text and waits for the runner itself — the
    product was fine, the test was measuring the wrong screen. (Recorded because it would otherwise
    have been reported as a passing/failing feature by mistake.)

## 11. Security checks performed

- **Authentication:** every communities and integrity endpoint requires a session; unauthenticated
  reads and writes return 401 (tested).
- **Authorisation / IDOR:** private community content returns 404 to non-members (tested through the
  detail, chat and search routes); a personal mock exam's integrity record and a personal attempt's
  record return 404 to any other student (tested); the host integrity overview returns 404 to
  non-hosts (tested).
- **Privilege escalation:** a member cannot promote themselves; a moderator cannot remove or demote an
  admin; only the owner can transfer; granting `owner` by role change is refused (tested).
- **Invite abuse:** an invite code is required for invite-only communities, an invalid code is rejected,
  and a single-use code cannot be reused (tested). Codes are 32-byte random tokens, hashed at rest.
- **Visibility:** private competitions are neither listed nor readable by outsiders (tested with a fresh
  account); community content is searchable only inside the caller's own memberships, and smart search
  returns public communities but never their members-only content.
- **Injection / XSS:** all SQL goes through parameterised statements and the shared `?` → `$n`
  PostgreSQL rewriter (`postgres-compat.test.ts` guards this); user text is rendered as text, there is
  no `dangerouslySetInnerHTML` in the product, and uploaded files are only ever served as downloads with
  `Content-Security-Policy: default-src 'none'; sandbox` and a basename guard.
- **Uploads:** type and size limited, stored outside the served path under a random name, download gated
  by membership.
- **Rate limiting:** community writes use the existing chat/general/upload buckets; integrity signals use
  a dedicated bucket (120/min) so a chatty client cannot lock itself out of answering; signal batches are
  capped at 60 per request and 400 per paper.
- **Secrets:** no key, password or token is logged or returned; API keys stay masked server-side; the
  dev credentials used in this session live only in the shell that started the process, never in the
  repository.

## 12. Performance checks performed

- Chat loads with cursor pagination (bounded pages, never "all messages"); doubts, knowledge, resources
  and members are paginated with limits and offsets.
- Indexes added for every hot path in migration 0004–0008 (community feed, messages by community+time,
  members, doubts, resources, events, plans, teams, integrity events/reports).
- Search runs one bounded query per entity type with `LIMIT`, per-type caps, and a maximum of 200
  member communities in scope.
- The integrity panel is a single indexed read; signals are batched client-side (≤60 per request) and
  never gate answering.
- The landing animation is one GPU-composited transform on a single element, disabled entirely under
  `prefers-reduced-motion` and on low-power devices.
- Measured: homepage load event 462 ms at 390px; no horizontal scroll on any route at 360/390/430/1440;
  no running ambient animations when the OS asks for reduced motion.

## 13. Remaining limitations

- **Cheating cannot be prevented completely, and the product does not claim it can.** The integrity
  record is evidence for a human to review — focus loss, full-screen exits, copy/paste attempts,
  blocked keys, resize, a second display, reopen counts — not an automatic verdict. A student using a
  second device or handwriting answers cannot be detected by any browser-based system.
- Browser coverage is Chromium (headless). Firefox and Safari were not exercised in this environment;
  the `isExtended` check is polled rather than event-driven precisely because Safari lacks the event.
- No PostgreSQL server was available here: Postgres compatibility is enforced by review plus
  `postgres-compat.test.ts` (placeholder rewriting, unique constraints for `ON CONFLICT`, portable
  column types, no SQLite-only SQL). Runtime verification was on SQLite.
- Video/voice rooms, live co-editing and push notifications are out of scope; the SSE bus covers live
  updates inside the app.
- Community analytics are deliberately aggregate-only; per-student analytics are not exposed.
- The seed/demo competitions are marked `is_demo` and flagged wherever they appear.

## 14. Deployment requirements

- Node 20+, one process. `npm install` at the root, `npm run build`, then `npm start` (serves the API
  and the built client from one origin).
- Either SQLite (`server/.data/`) or PostgreSQL via `DATABASE_URL`; migrations run automatically at
  boot and are additive.
- HTTPS in production (the session cookie is `__Host-` prefixed and `secure` in production), a persistent
  volume for the data directory (SQLite) or managed Postgres, and writable upload storage.
- `render.yaml` remains valid; the deployment docs (`docs/DEPLOYMENT.md`) list the same steps as before,
  with no new services to provision.

## 15. Environment variables required

- `JWT_SECRET` (≥32 chars) — required in production.
- `VROQN_MASTER_KEY` — **64 hex characters** (32 bytes), required in production; now validated in every
  environment. Used to encrypt stored AI keys at rest.
- `DATABASE_URL` (production) or SQLite by default; `ALLOW_SQLITE_IN_PROD=1` only for a single-instance
  demo.
- `PORT`, `NODE_ENV`, `DATA_DIR`, `CORS_ORIGINS`, `DEMO_MODE`, `ARENA_ADMIN_EMAILS`,
  `ARENA_NUMERIC_TOLERANCE_PCT`, `ARENA_REQUIRED_APPROVAL_RATIO`, `SEED_ALLOW_PROD` — unchanged.
- Provider keys are **never** environment-level requirements: students bring their own, stored
  encrypted per account.

## 16. Exact steps to test the complete Communities flow

```bash
# 1. Build and start (one origin)
npm install
npm run build
JWT_SECRET=<32+ chars> VROQN_MASTER_KEY=$(openssl rand -hex 32) npm start

# 2. Put the demonstration data in place (competitions, demo student)
npm run seed:arena --workspace server

# 3. Automated verification (each command should end with 0 failures)
npm test --workspace server
node scripts/communities-check.mjs                       # PASS 83 / FAIL 0
bash scripts/api-smoke.sh                                # PASS 121 / FAIL 0
bash scripts/flow-check.sh                               # PASS 72 / FAIL 0
cd client && npm run build:smoke && node ../scripts/ui-smoke.mjs
cd .. && PLAYWRIGHT_BROWSERS_PATH=/tmp/pw-browsers node scripts/browser-check.mjs
```

**By hand in the browser** (any phone-sized window):

1. Create an account → the dashboard shows the **Vroqn Communities** block.
2. **Explore** → search "physics", filter by category → open a public community → **Join**.
3. **Create** a community of your own: give it rules and a welcome message, leave visibility PUBLIC.
4. In your community: post a chat message, reply to it, react, pin it; ask a doubt; mark an answer
   helpful; promote the doubt to the **Knowledge** tab; search for a word from the doubt.
5. **Challenges → create a challenge**, tick a day; **Study plans → create a plan**, tick a task;
   **Events → create an event**, RSVP; **Study rooms → open a room with a checklist**, then join it
   from a second account and confirm you see the same checklist.
6. **Competitions → host a competition** (pick subjects and a schedule) → it appears in the community
   and, being public, in Arena → Public competitions with "Hosted by".
7. Open the paper: read the **consent screen**, tick it, start, answer a question, allow the tab to lose
   focus once, submit. Then check your result → the **integrity record** lists what was observed.
8. As the host, open the same competition → the host panel lists participants and flags.
9. Sign in as a second account: the private community is invisible, a private competition id returns
   404, and the other student's integrity record is not readable.
10. Report a message, mute a member, ban a member, then read the **moderation** trail as the owner.

## 17. Features that could not be safely completed

Nothing in §1–§65 was dropped. Three deliberate boundaries, each chosen to avoid unsafe or fake
functionality:

1. **No separate chat server, Redis, WebSocket cluster or microservice.** Live updates use the existing
   in-process SSE bus, exactly as §6 requires.
2. **No real-time video/voice rooms or group calls.** The room feature is a scheduled study session with
   a shared checklist and a participant list; anything more would have needed infrastructure the spec
   rules out. Nothing in the UI pretends a call exists.
3. **No automatic cheating verdicts and no proctoring beyond the browser.** Signals are recorded as
   evidence with a plain-language explanation for the student, per §44's instruction not to claim
   cheating can be completely prevented. Data collection is limited to what an exam needs, and the
   consent screen says what is recorded before anything is.

---

## Anti-cheating work in detail (§44)

**Server-authoritative by construction.** The clock, deadline, remaining time, paper state, question
access, submission, scoring, ranking and percentile are all computed on the server from the database.
The client can display a countdown, but it cannot extend a deadline, reopen a submitted paper, fetch an
answer key early, or submit twice — each of those is refused server-side and covered by tests
(`already_submitted`, submission lock, review locked before results).

**Randomisation.** Question order and option order are shuffled per student when the paper is configured
for it; the shuffle is stored with the attempt, so a re-open shows the same order rather than a new one.

**One official submission.** `arena_attempts` has a unique index on `(competition_id, user_id)`; the
first submission is the one that counts, and a second attempt to submit returns the existing result
instead of inserting another (`exam` scoring has the same first-submission-wins rule).

**Integrity record (new).**

- `POST /api/arena/competitions/:id/signals` and `POST /api/exams/:id/signals` accept up to 60 signals
  per request (400 per paper), rate-limited to 120 requests/minute per student.
- The attempt/exam referenced is resolved **server-side** from the caller, never from the body, so a
  student cannot report signals against somebody else's paper (404).
- Only the 18 known signal kinds are stored; anything else is counted as ignored.
- Observations: `focus_lost` / `focus_regained` (with the total time away), `fullscreen_exit` /
  `fullscreen_enter`, `copy` / `cut` / `paste`, `context_menu`, `key_blocked`, `resize`, `print`,
  `devtools_suspect`, `nav_attempt`, `extended_display`, `offline` / `online`, `session_start` /
  `resume`. Each row carries when it happened and optional free text limited to 300 characters.
- A summary row is recomputed per batch: counts, a weighted risk score, a level (`clean`, `minor`,
  `notable`, `high`), and a plain-language headline such as *"2 times the paper lost focus, 1 copy
  attempt."* When nothing happened the headline is **"Nothing was recorded during this attempt."**
- The record is **frozen when the paper closes**: signals sent after submission are accepted (no error)
  and deliberately not stored.
- Reads are self-only (`GET /api/arena/results/:attemptId/integrity`, `GET /api/exams/:id/integrity`)
  or host/admin for a hosted competition (`GET /api/arena/competitions/:id/integrity`, which returns
  participants, flagged counts and the policy text) — everyone else gets 404.

**Consent and transparency.** A paper opens on a screen that states it is an independent Vroqn-created
competition (never an official examination), lists what is recorded, runs a preflight (visibility API,
single display, connection, memory), warns about anything missing on that device, and requires an
explicit acceptance before the clock starts and before any signal is sent. Full-screen is requested for
real papers; if the browser refuses, the paper still runs and the refusal is recorded rather than
blocking the student. While the paper is running, a bar shows "Integrity mode on · nothing recorded",
which changes to a visible notice when something is observed.

**Host view.** A host (or an admin) sees a per-participant table of what was observed and how many
attempts are flagged, together with the policy statement. It is a review aid: no automatic pass/fail,
no public shaming, no score changes based on it.

**Data minimisation.** No keystrokes, no camera, no microphone, no clipboard contents, no screenshots,
no third-party script and no AI call. The record holds counts, timestamps and short details, readable by
the student themselves and by the host of that paper only.
