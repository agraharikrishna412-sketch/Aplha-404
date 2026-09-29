# Nexus — Turn 12 report

Two asks, both about things that were confusing or cramped rather than broken:

1. **"Competition Arena ma kaisa banata hai — samajh nahi aa raha."** How does a competition get
   created? That question had no answer inside the product.
2. **"Planet ke har every icon ma kafi gap kar."** More space between every icon on the study core.

And the standing delivery requirement: a new `.zip` once both are done.

---

## 1. Creating a competition

### What was actually wrong

The path existed and worked — `/arena/admin` schedules papers, generates the questions, and drives the
lifecycle — but nothing in the product said so, from either side:

* **A student** saw a catalog, "No competitions yet", and the line *"when your school or Vroqn publishes
  a competition it appears here"*. True, but it never said who publishes, how, or that it is a
  permission at all. Zero mentions of "admin" or "create" anywhere on `/arena`.
* **An organiser** could only reach the console through a menu entry that appears for staff accounts —
  and there was no way to *become* staff. The only documented path was an environment variable
  (`ARENA_ADMIN_EMAILS`) that has to be set before the server boots, which is fine for a deploy and
  useless for someone running the workspace locally who just wants to try it.

So the honest answer to "how is one created?" was: *by an organiser, through the console, and being an
organiser is a permission you cannot grant yourself* — but the product never said that, and there was
no first-class way to hand someone that permission off-deploy.

### What changed

**A command to hand out the permission, and one to take it back.**

```bash
npm run make:admin -- you@example.com     # this account can now schedule competitions
npm run make:student -- you@example.com   # …and now it cannot
```

Both write the `users.role` flag the server already enforced, honour `DATA_DIR`/`DB_PATH`, print the
next step, and refuse cleanly (listing known accounts) when the email does not exist. The role is read
from the database on every request, so a refresh is enough — no sign-out, no restart. The
`ARENA_ADMIN_EMAILS` allowlist is untouched and still works as the bootstrap path for a hosted deploy.

**Arena now explains itself, for whoever is looking.**

* **Students** get a collapsed *"How competitions are created"* card with the real four steps — an
  organiser writes the paper, you register while it is open, it goes live, results and a leaderboard
  follow — plus the promise that solutions unlock only once the paper closes.
* **Organisers** get a *"You run competitions here"* panel at the top of `/arena` with a **Create a
  competition** button that lands on the console with the create dialog already open
  (`/arena/admin?create=1`; the parameter is consumed and stripped so a refresh does not re-open it).
* **The console** opens with a three-step strip: name the paper → generate and review → drive the
  lifecycle, each step naming the button that does it and the server rule behind it.

**Tests that keep the answer correct.** A new `server/test/arena-organiser.test.ts` (4 tests) exercises
both ways of becoming an organiser and the whole authoring path through the real HTTP surface: a
student is refused (403), a signed-out visitor is refused (401), `make:admin` grants access and
`make:student` revokes it, an allowlisted email works without touching the database, a scheduled
competition is stored as a **draft** (invisible to students, `register` → 404), publishing before the
paper exists is refused with a message that names the missing step (`paper_not_ready`), a bank-only
generation produces 30 questions with no AI keys, approving them unlocks publish → open registration →
register → start, and the student who registers sees exactly the paper the organiser started.

The test runs the *shipped scripts* rather than repeating their SQL, so what is verified is the command
in the README, not a copy of it.

**A browser check for the path a human walks** — `npm run smoke:arena-organiser`, 23 checks: a new
account signs up and is refused the console, is promoted by the documented command, sees the organiser
panel, clicks through to the console, schedules a paper in the real dialog, sees it listed as a draft,
and the demo student cannot see it; then the flag is taken off, the panel disappears, and the
throwaway account deletes itself through the real deletion route (which also removes its draft paper).
It leaves the workspace exactly as it found it.

---

## 2. Space between the icons on the planet

### What was actually wrong

Measured before touching anything, at 390px: **the closest two chips had 1.3px of clear space between
them**, and every one of the four tightest pairs was inner-ring-to-inner-ring. On a 320px phone it was
1.2px. The six inner chips were squeezed onto a screen ellipse of 60×34px *around* a 122px ball, so
they were both colliding with each other and hugging the sphere.

Two more things were wrong underneath that:

* **The frozen drawing was a pile.** `prefers-reduced-motion` killed every animation — but the
  keyframes were also what *positioned* the chips, so the accessible version of the planet was all
  fourteen icons stacked at the centre (worst "gap": −39.6px). Nobody had looked at it; the check only
  counted discs.
* **The paths were polygons, not ellipses.** One keyframe per chip made the orbit an octagon/hexagon, so
  chips rode straight chords and the gaps pinched at every corner of the path.

### What changed

* **Bigger, rounder rings.** Outer ring: 8 chips on a 172×358 plane ellipse (≈148×138 on screen at
  390). Inner ring: 6 chips on a 95×172 plane ellipse (≈82×66 on screen) — clear of the 117px ball and
  far inside the outer ring. Numbers were solved against measured screen geometry, not against a paper
  model: the plane is squashed to about 0.45 vertically on screen, which is why the plane radii look so
  much bigger than what a phone shows.
* **24 keyframe samples per revolution** instead of one per chip, so the paths are smooth and the
  spacing stays even all the way round.
* **The frozen state draws the same picture.** Chip positions for the reduced-motion case are computed
  in the component from the same radii the keyframes use (`--still-x/--still-y`), so the still planet is
  the moving planet with the motion taken out.
* Slightly smaller discs (44/34 plane px), a 136px ball, the dial band moved between the two rings, and
  the whole assembly scaled 0.76 on the narrowest phones so nothing touches the card edge.

### Measured, after

Worst gap between any two chips, sampled at 72 phases across a full lap with the animations paused and
stepped (so every relative phase is covered, not sampled by luck):

| Width | Worst pair | Outer↔outer | Inner↔inner | Screen ellipses (outer / inner) |
| --- | --- | --- | --- | --- |
| 320px | **28.5px** (was 1.2px) | 59.4px | 32.5px | 131×122 / 72×59 |
| 390px | **32.2px** (was 1.3px) | 67.2px | 36.8px | 148×138 / 82×66 |

Frozen (`prefers-reduced-motion`) at 390px: 14 chips, **296px spread, 32.7px worst gap** (was a pile).
Chips stay inside the hero card at every width, with no horizontal overflow on the page at
320/360/390/430/1440.

The deep scan now measures the gap **edge to edge** (centre distances passed the crowded version — two
44px chips 50px apart still look like a pile) and requires ≥26px, in both the moving and the frozen
drawing, so this cannot silently regress.

---

## Verification (this turn)

| Check | Command | Result |
| --- | --- | --- |
| Types | `npm run typecheck` | clean (server + client) |
| Server tests | `npm test` | **171 passing, 0 failing** (44 suites; +4 new organiser tests) |
| Build | `npm run build` | client bundle + `server/dist` |
| API smoke | `bash scripts/api-smoke.sh` | **124 passing, 0 failing** |
| Student flows | `bash scripts/flow-check.sh` | **66 passing, 0 failing** |
| UI smoke (jsdom) | `npm run smoke:ui` | **39 screens, 0 failed, 0 runtime errors** |
| Real browser | `npm run smoke:browser` | **33 passing, 0 failing** (320/360/390/430 + desktop) |
| Whole-site scan | `node scripts/scan-site.mjs` | **122 passing, 0 failing** |
| Arena organiser path | `npm run smoke:arena-organiser` | **23 passing, 0 failing** |
| Communities | `node scripts/communities-check.mjs` | **106 passing, 0 failing** |
| Ownership transfer | `npm run smoke:ownership` | **15 passing, 0 failing** |
| Private chat | `node scripts/private-chat-check.mjs` | **18 passing, 0 failing** |

Two failures were found and fixed during this pass, both mine: the new *"How competitions are
created"* summary was a 21px-tall tap target (now 44px), and the scan's own navigation check broke
because the new Arena section left the browser on `/arena` (the section now returns the page to the
dashboard when it is done).

---

## Honest status

* The **first** `smoke:browser` run of this turn failed 4 checks (the summary's tap height). Fixed,
  re-run, 33/0.
* `smoke:ui` reports **39 screens** in this state rather than 44: the count depends on how much Arena
  data the demo account has (submitted attempts add result screens). Both states pass; the difference
  is data, not a missing screen.
* The dots-on-the-planet geometry was solved against **this** Chromium at 320/390/1440. Other engines
  (Safari/Firefox) were not measured; the numbers depend on 3D transforms and perspective that all
  modern engines implement the same way, but only Chromium was verified here.
* Competition creation is still deliberately **staff-only**. A student cannot schedule a paper, and no
  client-side flag can change that — verified from the API side (403) and by the organiser check.
* `ARENA_ADMIN_EMAILS` is read per request, so revoking access is instant; this is intentional and
  documented, not an oversight.
* The scratch measuring scripts used for this turn's geometry work are not shipped in the zip; the
  checks that protect the result (scan-site gap + frozen checks, the organiser check) are.
