# Who can do what in Arena (`ARENA_ADMIN_EMAILS` explained)

Written because this is the question every operator asks first: *"if I put my email in there, what did I
just give myself — and can I now do anything to the whole website?"*

Short answer: **you get the Arena organiser powers, plus the private-message report queue. Nothing
else.** You do not become a superuser: you cannot edit other people's accounts, read their private
messages, change their communities, or see their data.

---

## 1. The two ways to be an organiser

| Way | Where it lives | When it applies | How to undo |
| --- | --- | --- | --- |
| `ARENA_ADMIN_EMAILS=you@school.edu` | the server's environment | every request, read live | remove the address and restart |
| `users.role = 'admin'` | the database | every request, read live | `npm run make:student -- you@school.edu` |

Either one is enough. A student account can never set its own role: signup always writes `student`
(`server/src/routes/auth.ts`), and no route in the product can change `users.role`. The flag is only
ever written by the seeder or by the two scripts above, both of which need filesystem access.

`npm run who:admin` lists who currently holds it.

---

## 2. What that account can do

### Arena (the whole reason the permission exists)

All of these are `requireAdmin` routes in `server/src/routes/arena.ts`:

| Route | What it does |
| --- | --- |
| `GET /api/arena/admin/competitions` | See **every** competition, including other organisers' unpublished drafts, plus each paper's readiness |
| `POST /api/arena/admin/competitions` | **Create** a competition (title, category, duration, marks, windows, visibility, invite code) |
| `PATCH /api/arena/admin/competitions/:id` | **Edit** the schedule of any competition |
| `DELETE /api/arena/admin/competitions/:id` | **Delete** any competition |
| `POST /api/arena/admin/competitions/:id/generate` | Generate the paper with AI, or from the curated bank (works with no API keys) |
| `POST /api/arena/admin/competitions/:id/action` | Drive the lifecycle: `publish` · `open_registration` · `close_registration` · `start_now` · `close_submissions` · `publish_results` · `archive`, and grant an extension |
| `GET /api/arena/admin/competitions/:id/questions` | Read the whole question queue, **including correct answers and explanations** |
| `PATCH /api/arena/admin/questions/:id` | Approve, flag, reject or rewrite a question (prompt, options, answer, explanation) |
| `DELETE /api/arena/admin/questions/:id` | Delete a question |

Knock-on effects worth knowing:

* Publishing results recalculates benchmarks and percentiles for that competition.
* Starting a paper early is refused unless the paper has met its approved-question ratio.
* An organiser **can** read a paper's answer key before the exam — that is what reviewing means. Students
  cannot; the key is withheld per-attempt until that competition's results are published.
* **Except for community papers.** When a competition is hosted by a community, the three question routes
  below are sealed while that paper's window is open: they answer `403 community_paper_sealed` instead,
  and the refusal carries no question text. They reopen once the window ends, when every attempt is
  already recorded. A community's paper is written by a teacher who may also be sitting it with their
  class, so "the organiser can always read it" would be a leak with a permission badge on it. See
  `NEXUS-TURN13-REPORT.md` §4.

### Private messages (one extra power)

| Route | What it does |
| --- | --- |
| `GET /api/messages/reports?scope=all` | Read the **safety report queue** — reports students filed about messages |
| `POST /api/messages/reports/:id/resolve` | Mark a report `reviewing` / `actioned` / `dismissed` with a note |

That is a queue of *reports* (who reported what, when, and which conversation id), not the conversations
themselves. An organiser cannot list someone else's conversations or read their messages: every thread
route in `server/src/routes/messages.ts` goes through a membership check keyed to the caller.

### In the interface

* `Paper Review` (/arena/admin) appears in the navigation.
* `/arena` shows the "You run competitions here" panel with **Create a competition**.
* The dashboard's search, the chat, the communities, everything else behaves exactly as it does for a
  student. The badge on the console says `Admin`; the account is otherwise an ordinary student account.

---

## 3. What that account can **not** do

| Not possible | Why |
| --- | --- |
| Make itself (or anyone) an organiser | Only the seeder and the two scripts write `users.role`; there is no route for it |
| Read another student's private messages or conversations | Thread access is membership-checked per conversation |
| Read your AI API keys of another account | Keys are encrypted per user and never leave the server, not even to the owner in plaintext |
| Edit or delete other users' accounts | Not implemented; the only account deletion route deletes *your own* account |
| Enter someone else's community as its owner | Community roles come from `community_members`, not from this flag |
| Grade or change a student's submitted attempt | Attempts are scored server-side; there is no route to edit marks |
| Bypass exam windows or the integrity rules | Windows are decided by the server clock for everyone, including staff |
| See student safety reports' conversations | Only the report rows, as above |
| Read a community's paper while its window is open | Sealed to every browser, staff included: `403 community_paper_sealed` until that competition's window ends |

In one line: **Arena organiser is a content-authoring role, not a superuser role.**

---

## 4. Running it safely

* Leave `ARENA_ADMIN_EMAILS` empty for a student-only deployment — that is a valid configuration and
  nobody can promote themselves into the empty seat.
* On Render: Dashboard → your service → **Environment** → `ARENA_ADMIN_EMAILS` → comma-separated
  addresses → save (the service restarts). It is already declared in `render.yaml`.
* Revoking: take the address out (or `npm run make:student -- <email>`); the next request is a student
  again — no session refresh needed, because the role is resolved per request.
* Give the flag to a **role account** (a teacher, a school), not to a shared personal login: it can
  publish papers under your institution's name.
* The seeded `teacher@vroqn.dev` account carries this flag so a fresh demo workspace can show the whole
  flow. Change its password (or delete it) before anyone else uses the deployment —
  `npm run make:student -- teacher@vroqn.dev` removes the power, the password change removes the door.
