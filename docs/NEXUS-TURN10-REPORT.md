# Vroqn Nexus — Turn 10 report (final)

What you asked for in this round, what was actually wrong underneath it, and the evidence.

---

## 1. Homepage cleaned up

You listed the sections you wanted gone. All of them are removed from Home:

| Removed from Home | Still exists, where |
| --- | --- |
| Your profile card | **Profile** (sidebar / header menu) |
| Learning analytics preview | **Learning Analytics** |
| "Start here" quick actions | **AI · Practice · Mock Exam · Notes · Code Lab** in the menu |
| "Everything in Vroqn" (14 destinations) | the header menu — all 14, verified |
| Vroqn Communities block | **Groups** |
| Today's Learning | **Learning Activity** |
| What to do next | **AI Tutor / Practice** |
| Your AI connections | **Settings → AI keys** |

Nothing was deleted — nine screens are now one tap away in the menu instead of scrolling past on Home.
Home is: **hero (with the 3D core) → search → top communities → news → Arena nudge.**

The scan now asserts *both halves* of that: the menu really does list all 14 destinations, and Home
really does not contain the removed sections any more. A removal request tested as "it renders" would
have passed while ignoring what you actually asked for.

## 2. The 3D animation: bigger, realistic, and every disc is now a real button

**Bigger.** Box went 214→**300px** on a phone and 332→**430px** on a laptop, and the orbit itself grew
to r=152px with the scale raised at every breakpoint. Breakdowns are in the CSS comment so "bigger"
can never become "clipped" at 320px.

**More realistic.** Three changes, all measured on screen:

* **Real perspective depth.** The discs sit on a plane tilted 62°, so a disc's y position is a genuine
  z offset — and the 1000px camera turns that into size. The disc in the foreground is really larger,
  the one behind is really smaller. The old version faked this with a hand-tuned `scale(0.82–1.0)` *on
  top of* the projection, which fought itself and flattened the picture.
* **A cored sphere instead of a bright blob.** The heart now shades white → cyan → deep teal with a
  dark limb, wrapped in a translucent glass shell with a specular highlight. It reads as a lit ball
  with a surface, not a glow.
* **A real instrument.** A solid track ring on the discs' own path, a dashed inner ring turning the
  other way, 48 machined tick marks with a long one every sixth, and a slow sweep hand — all in the
  same tilted plane, so the dial lines up with the orbit exactly.

**And it works when you click it — this was the important part.** Every one of the seven discs is a
real link:

| Disc | Opens |
| --- | --- |
| Physics | `/practice?subject=Physics` |
| Maths | `/practice?subject=Mathematics` |
| Chemistry | `/practice?subject=Chemistry` |
| Notes | `/notes` |
| Code Lab | `/code-lab` |
| Practice | `/practice` |
| Arena | `/arena` |

Three things make that usable rather than decorative, and each was a bug first:

1. **The orbit holds still when you reach for it.** A moving tap target is a target you miss — my own
   test failed trying to click a disc in motion, which is exactly what a finger would do. The orbit
   now pauses on hover, pauses on keyboard focus, and pauses for 1.2s after any press (a phone has no
   hover at all). On touch devices with no hover the orbit also just runs much slower.
2. **Focus is not a trap.** The discs used to be inside a subtree that was `aria-hidden` — invisible to
   screen readers entirely. The artwork is still hidden; the discs are not. Each carries a real name
   ("Physics — practise"), and the visible word is inside it, so voice control works too.
3. **The artwork can never eat your tap.** The root keeps `pointer-events: none`; only the discs opt
   back in.

Why not three.js: a WebGL context costs a student real battery and breaks outright where WebGL is
blocked. This is CSS transforms on a handful of layers — it composites like a rectangle, has no
per-frame JavaScript, and still freezes into a complete drawing under reduced motion.

## 3. What the scan found while checking all this

* **A stale-database problem, not a product problem.** The demo account had accumulated **80 communities
  of test debris** — leftovers from interrupted suite runs — and nothing had ever seeded real
  communities, so "top communities" was showing `Probe…`, `Smoke…`, `Zylo…` and throwaway `Quantum
  Circle…` rows. Fixed properly: a new `npm run seed:communities` creates five real starter clubs
  (JEE Practice, Class 10 CBSE, Mathematics Doubts, Code Club, NEET Biology) with classmates already
  in them, and it sweeps old debris on every run.
* **The scan now heals itself.** It removes leftovers from any earlier run that died mid-section, so a
  crash can never poison the next run. That was the root cause above — a suite that only cleans up on
  the happy path.
* **My own member-count check was lying.** Reading a card's `textContent` glues child nodes together,
  so a community literally named "…Circle 6243" followed by "2 members" reported as a **62,432-member
  community** and failed the ordering check. It now reads the number from the element that is the
  number.
* **My own click check was ignoring the real obstacle.** Playwright's stability-waiting `hover()` can
  never succeed on a permanently moving element — that failure was the discovery that the orbit needed
  a pause in the first place.
* **Three suites could not find the browser** in an environment without the slim headless shell. They
  now accept a full Chromium build too.

## 4. Verification — all of it re-run on this final build

| Suite | Result |
| --- | --- |
| `npm run typecheck` | clean (server + client) |
| `npm test` | **162 passing / 0 failing**, 42 suites |
| `npm run smoke:api` | **124 / 0** |
| `npm run smoke:flows` | **66 / 0** |
| `npm run smoke:ui` | **39 screens / 0 failed / 0 runtime errors** |
| `npm run smoke:browser` | **34 / 0** (320 · 360 · 390 · 430 · desktop, tap targets, modals, reduced motion, load time) |
| `npm run scan:site` | **116 / 0** (20 routes × phone + desktop) |
| `npm run smoke:ownership` | **15 / 0** — ownership transfer through the screens, both accounts |
| `node scripts/communities-check.mjs` | **106 / 0** |
| `node scripts/private-chat-check.mjs` | **18 / 0** — two real browsers, real WebCrypto |

The core-specific checks in the deep scan: the artwork is hidden and untappable · all seven discs are
real links to real screens · every disc keeps a ≥24px hit area **measured inside the 3D transform** ·
the orbit pauses when you reach for it · pressing a disc lands on the screen it names · reduced motion
freezes it into a complete drawing (7 discs, 48 ticks) · and it still animates in normal mode.

## Honest limits

* The animation is CSS 3D, not a WebGL/three.js scene. It gets its depth from a real perspective
  projection and hand-placed keyframes; there is no lighting model, no reflections, no shadows cast by
  the discs.
* Two of the seven discs ("Practice", "Chemistry") cross the lit core on a phone width, so their labels
  sit on a dark chip to stay readable. On a desktop the orbit is wider and only "Practice" needs it.
* The demo account's communities are seeded by `npm run seed:communities`. Without it, a fresh database
  legitimately has no communities and Home says so.
* `api-smoke` and `smoke:flows` drive the demo account through a live Arena paper: run
  `npm run seed:arena --workspace server` before each pass, otherwise the second run correctly refuses
  with "you have already submitted this competition".
* The suites clean up after themselves and now sweep their own debris, but a killed run can still leave
  a fixture behind until the next `scan:site` or `seed:communities`.

## Running it

```bash
npm install
npm run build
npm start                       # http://localhost:8787

npm run seed --workspace server        # demo student: notes, activity, weak areas
npm run seed:arena --workspace server  # Arena competitions
npm run seed:communities               # starter communities with classmates in them

npm run typecheck && npm test
npm run smoke:api && npm run smoke:flows
npm run smoke:ui && npm run smoke:browser
npm run scan:site && npm run smoke:ownership
```
