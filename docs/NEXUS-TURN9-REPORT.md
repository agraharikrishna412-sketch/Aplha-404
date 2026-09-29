# Vroqn Nexus — Turn 9 report

Everything you asked for in this round, what was actually wrong underneath it, and the evidence that
it now works. Numbers in the tables at the end come from runs on this build, not from memory.

---

## 1. The 3D study animation on the homepage

**Built:** `client/src/features/dashboard/StudyCore.tsx` — a CSS-3D "study core": concentric rings,
an orbiting atom, a graduated arc of tick marks and a glowing nucleus, drawn in the brand's dark cyan.
No WebGL, no canvas, no new dependency.

**Why CSS instead of three.js:** the homepage has to stay fast on a mid-range phone and the app must
still work when a browser blocks WebGL. A transform-only composition gets the same "cool" and costs
nothing at load; the layout is owned by CSS so it survives font loading and first paint.

**Motion is tiered, never forced:**
* default — gentle rotation and counter-rotation at different speeds (parallax depth),
* `prefers-reduced-motion` — the core freezes into a complete static drawing (7 discs, 24 ticks still
  present), verified in the deep scan,
* low-power / hidden tab — animation pauses.

Decoration only: the whole figure is `aria-hidden` and `pointer-events-none`, so it never steals a
tap or reads noise to a screen reader.

Size measured on the live site: **340 × 214 px at 390 px wide, 487 × 332 px at 1440 px.**

## 2. The homepage now shows top communities, news and the things worth seeing

`client/src/features/dashboard/DashboardHub.tsx` is the hub: search launcher, **top communities**,
a **news strip**, your profile card, and a learning-analytics preview. It is decorated (gradient
field, core, section rhythm) without turning into clutter.

*Top communities* are ordered by member count — and, importantly, that is now a *check*: the deep
scan reads the member numbers straight out of the rendered cards and fails if the order is wrong.

## 3. There is a join control everywhere a community appears — the real bug you spotted

You were right, and it was worse than it looked: **there were two separate defects.**

1. **The dashboard cards had no join action.** Every card was a bare link. You could see the
   community, click it, and still have nothing to press. Fixed: each card carries a one-tap control —
   **Join** on a public community, **Ask** on a private one, **Code** on an invite-only one — which
   becomes **Open** the moment you are in, with a toast for success and a clear message when a
   request is denied.
2. **A non-member opening a public community saw an error panel.** `GET /api/communities/:id/home`
   answers `404` to non-members *by design* — it is members-only content — and the page rendered that
   honest 404 as a red "Could not load this community / Join this community to see its content."
   That is a lie: the community loads fine, you simply are not in it yet. It now renders an
   invitation instead — "Join to see what is inside" — with the join button and the explanation that
   announcements, doubts and competitions unlock on joining.

The Groups screen was already correct (15–18 join buttons per page) and still is.

**Proof it works now:** a brand-new account on the dashboard went from **0 join buttons → 6**, and
one tap really joined (`myRole: member`). The deep scan's new "joining a community" section is
**10 checks, 0 failures** — the home screen offers joining, one tap really joins, the page is not
broken, the invitation is shown, and Groups still offers joining.

## 4. Search → message a person directly

The search overlay's **People** results carry a **Message** action that deep-links to
`/messages?to=<id>`.

There was a genuine bug here from an earlier round: `/messages` and `/messages/:id` are different
route elements, so navigating from search remounted the page and lost the person you had picked —
the composer then opened on the conversation list. Fixed by carrying the first contact in router
history state; do not reintroduce a local-state copy of it.

The deep scan now drives the whole path in a real browser: search for a person → press **Message** →
land on their thread → **composer enabled** → type → send → **the message is rendered back in the
thread**. If the device has no chat key for that person yet, the composer is unlocked by the designed
"Send keys to this device" recovery rather than being left dead.

## 5. Learning analytics in the dashboard

A real page, not a decoration: **`GET /api/activity/analytics?days=`**, surfaced at `/analytics` from
the dashboard.

* Your study minutes, practice attempts, accuracy, streak and topic spread — computed from your own
  rows only.
* Small samples are labelled **provisional** (< 3 attempts) instead of pretending to be a trend.
* It never shows another student's data, and the API rejects anything that is not your own account.

Covered by 7 dedicated server tests.

## 6. The error in your two screenshots

Your screenshots are annotated with red and green strokes, and in both the strokes cover the *content*
of the page — so on their own they did not tell me which element was wrong. What they did carry was
the state: the join problem — visible on a community screen with no way in. That is defect #2 above and
it is fixed.

To be straightforward about this: I also swept the app at 390 px for a second defect matching the
screenshots (faded text, an overlay stuck on top of content, a truncated card) and **did not find
one** on this build. I raised the smallest text in the UI to an 11 px floor while I was there. If the
thing you circled is still wrong, tell me the screen and the words on it and I will fix that exact
element rather than guess.

## 7. The whole site, scanned — and every function tested on its own

This is the part you asked for most forcefully, so here is what it means concretely.

| Suite | What it proves | Result |
| --- | --- | --- |
| `npm run typecheck` | server + client compile, strict unused-symbol checks on | clean |
| `npm test` | server unit + integration tests | **162 passing / 0 failing, 42 suites** |
| `npm run smoke:api` | 124 API behaviours | **124 / 0** |
| `npm run smoke:flows` | 66 student journeys through the HTTP layer | **66 / 0** |
| `npm run smoke:ui` | 39 screens render with no runtime error | **39 screens / 0 failed / 0 errors** |
| `npm run smoke:browser` | real browser at 320/360/390/430/desktop: overflow, 40 px tap targets, sticky timer, modals, destructive confirm, reduced motion, text floor, load time | **34 / 0** |
| `npm run scan:site` | **112 checks** across 20 routes on phone *and* desktop | **112 / 0** |
| `node scripts/communities-check.mjs` | the community ecosystem end to end | **106 / 0** |
| `npm run smoke:ownership` | ownership transfer through the actual screens | **15 / 0** |
| `node scripts/private-chat-check.mjs` | two real browsers, real WebCrypto, ciphertext on the wire | **18 / 0** |

**"Work alone" is tested as literally as I could make it:** every suite starts from a clean account or
a known fixture, drives the feature through its own door, and asserts the *outcome* — not that a
button existed. The deep scan deliberately uses a fresh student where the point is the first-run
experience, and an established one where the point is depth.

### Ownership transfer specifically

You asked to be sure this one genuinely works. It does, and it is verified from both sides:

1. owner opens **Members**, presses **Make owner** (the crown next to a non-owner, active member),
2. a confirmation dialog names the person and says the change is immediate,
3. the server verifies the caller is the current owner — a non-owner gets **403**,
4. both accounts' **own sessions** are then re-read: the successor is `owner`, the former owner is
   `admin` **and has lost `transfer_ownership`**,
5. the old owner retrying the transfer gets **403**,
6. the new owner hands ownership back (**200**) — proving it is not a one-way door,
7. the test community is deleted and the fixture is cleaned up.

This was a real bug this round: `communitiesApi.transfer` existed and worked, but **nothing in the UI
called it** — Manage toasted a "Make owner" achievement that could not happen. Endpoint reachability
is not a feature; the suite now checks the screen as well as the API.

### Two more real defects found and fixed while scanning

* **A removed member kept their role in the UI.** Removing a moderator sets the membership row to
  `status='left'`, but the community detail read the role off that same row, so a kicked moderator's
  page still claimed moderator and offered moderator controls. Every one of those calls correctly
  404'd, so there was no escalation — but the interface was lying, which is bad enough. The role,
  capability flags and tab list are now gated on `isMember`; after removal `myRole` is `null` and the
  members-only surfaces are gone. (Server test coverage: member lists and ownership, 11 tests.)
* **Two of my own checks had gone stale** against the improved UI — the member-count parser was
  tripping over the new "Open" link, and the join check assumed the scan's freshly created community
  would appear in the top six. Both were rewritten to assert the *promise* (ordering by members; one
  tap adds exactly one membership) instead of an implementation detail. The scan went
  **110 passed / 2 failed → 112 / 0** only after those were fixed properly, not loosened.

---

## Honest limits

* The two screenshots: see §6. One suspected defect fixed; no second one located. Not hidden.
* `scan-site` covers 20 routes × 2 viewports; the deep-scan assertions are behaviour, not pixels.
  Layout, animation smoothness and browser-specific rendering still need a human eye.
* The default database is SQLite (`server/.data/vroqn-nexus.db`); the Postgres path is covered by
  portability tests, not by a live Postgres run.
* Fixtures create real rows. The suites clean up after themselves and the demo account was cut from
  29 to 13 owned communities during this round, but a crashed run can leave a community behind.
* `api-smoke` and `smoke:flows` drive the demo account through a live Arena paper, so run
  `npm run seed:arena --workspace server` before each pass — otherwise the second run reports
  "you have already submitted this competition", which is the correct refusal, not a bug.

## Running it

```bash
npm install
npm run build
npm start                 # http://localhost:8787

npm run typecheck && npm test
npm run seed:arena --workspace server
npm run smoke:api && npm run smoke:flows
npm run smoke:ui && npm run smoke:browser
npm run scan:site && npm run smoke:ownership
```
