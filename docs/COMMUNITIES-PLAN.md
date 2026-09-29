# Vroqn Communities — Implementation Plan

Written before any code, per §60 of the master prompt. The requirement order is: inspect → map
reuse → plan → implement incrementally → test each feature → polish → integration test.

---

## 1. What already exists (inspected, not assumed)

| System | Where | Reuse decision |
| --- | --- | --- |
| Auth, sessions, roles | `middleware/auth.ts` — `requireAuth`, `requireAdmin`, `SessionUser` | Reuse as-is. Community roles are a **separate** axis from platform roles. |
| Rate limiting | `middleware/rateLimit.ts` — `limits.general/ai/upload/code`, per-user or per-IP | Add a `chat` + `communityWrite` bucket in the same factory. |
| Errors + validation | `middleware/errors.ts` — `asyncRoute`, `HttpError`, `parseBody`, zod | Reuse. Every route wraps in `asyncRoute`. |
| DB access | `db/index.ts` — `all/one/run/transaction/nowIso/uuid/json/bool` | Reuse. Portable `?` SQL only. |
| Migrations | `db/schema.ts` — `MIGRATIONS[]`, one transaction each, recorded in `schema_migrations` | **Append** `0004_communities`. Never touch 0001–0003. |
| Arena | `services/arena/*` (competitions, questions, attempts, results, grading), 12 tables | **Fully reused.** §13 explicitly forbids a second competition engine. |
| AI (3 providers + BYOK) | `services/ai/*`, `services/tutor.ts`, `promptContextFor` | Reuse the router. Ask-Vroqn reuses the tutor prompts, never a new provider path. |
| SSE streaming | `routes/tutor.ts` — `text/event-stream`, ping loop, abort wiring | Reuse the pattern for chat + notifications. |
| Activity + weak topics | `services/activity.ts` — `recordActivity`, `recordTopicResult`, `learningSummary` | Reuse so community work feeds the existing Learning Activity page. |
| UI kit | `components/ui.tsx` — Button, Card, Modal, Segmented, EmptyState, ErrorState, LoadingState, Skeleton, ProgressBar, Badge, Field | Reuse for every new screen. No new primitives unless genuinely needed. |
| Design tokens, motion | `styles.css`, `useMotionTier`, `useReveal`, `KnowledgeCore` | Reuse tokens; new animation only where it communicates state. |
| Notifications | **Does not exist** | Build it. This is the one genuinely new cross-cutting system. |

## 2. Database changes

One migration, `0004_communities`, additive only. Nothing is dropped or rewritten; `0001`–`0003` are
untouched and existing rows are preserved (§58).

Rules the schema must obey (enforced by `test/postgres-compat.test.ts`):

* Column types limited to `TEXT` / `INTEGER` / `REAL`.
* Any `is_*` column is `INTEGER NOT NULL DEFAULT 0`.
* Every `ON CONFLICT (a, b)` needs a matching unique index.
* `?` placeholders only, no driver-specific SQL.

~30 tables, grouped:

* **Identity & membership** — `communities`, `community_members`, `community_join_requests`,
  `community_invites`, `community_blocks`
* **Chat** — `community_messages`, `message_reactions`
* **Learning** — `community_doubts`, `doubt_answers`, `community_knowledge`, `community_resources`,
  `community_challenges`, `challenge_progress`, `study_plans`, `study_plan_tasks`,
  `study_plan_progress`, `study_rooms`, `study_room_participants`
* **Activity** — `community_events`, `event_participants`, `community_announcements`,
  `community_polls`, `poll_options`, `poll_votes`
* **Trust & safety** — `community_reports`, `moderation_actions`
* **Motivation** — `community_badges`, `user_badges`
* **Platform** — `community_notifications`, `community_notification_prefs`
* **Arena bridge** — `community_competitions` (maps a community to an existing `arena_competitions`
  row; no duplicate competition engine, no `ALTER TABLE` on Arena)

## 3. Security model (server-authoritative, §15 + §53)

A single `permissions.ts` holds the capability matrix; every route asks it. The client is never
trusted for visibility, role or ownership — the UI only decides what to *show*.

| Capability | OWNER | ADMIN | MODERATOR | MENTOR | MEMBER |
| --- | --- | --- | --- | --- | --- |
| Edit community / delete | ✅ | ✅ (not delete) | — | — | — |
| Manage members + roles | ✅ | ✅ | — | — | — |
| Approve join requests | ✅ | ✅ | — | — | — |
| Create invites | ✅ | ✅ | — | — | — |
| Create competitions / challenges / events / plans | ✅ | ✅ | — | ✅ (learning only) | — |
| Moderate messages (delete any, mute, pin) | ✅ | ✅ | ✅ | — | — |
| Handle reports | ✅ | ✅ | ✅ | — | — |
| Post announcements | ✅ | ✅ | ✅ | — | — |
| Read private community | member | member | member | member | member |

Extra invariants: the owner cannot be demoted by anyone but themselves; an admin cannot grant a role
above their own; the last owner cannot leave without transferring; a banned user cannot rejoin a
private community without an admin clearing the ban.

**Private content never leaks.** `visibleCommunityIds(userId)` is the *only* way list endpoints
filter, and every detail endpoint calls `assertCanView`. Chat, doubts, resources and knowledge all
inherit the community's visibility; private competitions additionally check the Arena registration.

## 4. API surface

One router, `routes/communities.ts`, mounted at `/api/communities`, following the existing
conventions (`asyncRoute`, zod `parseBody`, `HttpError`). ~90 endpoints. Grouped as:

* `/communities` — list/discover, create, get, patch, delete
* `/:id/join|leave|join-request|invite` — membership
* `/:id/members` — list, role change, remove, ban, mute, approve/reject
* `/:id/messages` — list (cursor pagination), send, edit, delete, react, pin, report
* `/:id/chat/stream` — SSE
* `/:id/doubts`, `/:id/doubts/:doubtId/answers`, helpful-answer, promote-to-knowledge
* `/:id/resources`, `/:id/events`, `/:id/challenges`, `/:id/plans`, `/:id/polls`
* `/:id/competitions` — create (hosted in Arena), list
* `/:id/leaderboard`, `/:id/analytics`, `/:id/knowledge`, `/:id/reports`
* `/notifications` — list, read, read-all, preferences, SSE
* `/search` — authorised content only
* `/badges` — earned only, never claimable

## 5. Real-time architecture

No Redis, no separate chat server (§6 explicitly forbids it). The app is a single Node process, so an
**in-process pub/sub** (`services/communities/bus.ts`) fans events out to SSE connections, with a
heartbeat and cleanup on disconnect. Polling is the fallback if the stream drops: the client refetches
on `visibilitychange` and on reconnect. Chat history loads a page at a time (cursor), never the whole
table (§54).

## 6. Phases

Implementation order — each phase compiles and is tested before the next:

* **Phase 1 (core):** schema, permissions, communities CRUD, member roles, join/requests/invites,
  community page + tabs, chat + moderation, notifications, home feed.
* **Phase 2 (Arena):** community competitions through the existing Arena engine, visibility
  (public/private/invite), participation, results, history, integrity controls.
* **Phase 3 (learning):** resources, doubts, knowledge base, Ask Vroqn (contextual + group),
  announcements, challenges, events, study plans, polls, study rooms.
* **Phase 4:** leaderboard, badges, study teams, contribution reputation, analytics.
* **Phase 5 (future-ready):** mentor role (implemented as a capability set), group-vs-group aggregate
  stats, tournaments and verified communities as schema + guarded endpoints that are honest about
  being unused until there is data.

## 7. Testing

* Unit/integration: permission matrix, visibility/IDOR, chat pagination, moderation, scoring reuse.
* `smoke:api` — extend with community endpoint checks including negative authorization cases.
* `smoke:ui` — every community screen, empty and populated.
* `smoke:browser` — the community surfaces at 360/390/430/desktop, chat, and the competition runner.
* Every existing suite must stay green (§57).
