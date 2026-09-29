# Vroqn Nexus — UI/UX Polish Pass

**Scope:** whole product — public homepage, all ten authenticated pages, the Arena runner, the Mock
Exam runner, Code Lab, the AI Tutor and the mobile shell.
**Constraint honoured throughout:** the existing Vroqn identity was **improved, not replaced**. The
Mechanical Dark palette, the cyan accent, the logo, the copy voice, every route and every feature
already shipped are all still present and still work.

---

## 1. What this pass set out to change

| Goal | How it was approached |
| --- | --- |
| Premium, futuristic, educational — not a basic template | A real design layer: elevation scale, one shared easing curve, glass/metal surfaces, an SVG knowledge core for the hero |
| Homepage hero that communicates AI + Learning + Knowledge + Progress | `KnowledgeCore` — an inline-SVG diagram, not a video or a WebGL scene |
| Cohesive, restrained theme | Animated `transform`/`opacity` only; glow reserved for state, never decoration |
| Consistent UI quality | One primitive per job (button, card, tab, badge, loading, empty, error) with shared radius/spacing/type |
| Understandable without instructions | Plain-language copy throughout; every loading, empty and error state says what to do next |
| Mobile-first, not compressed desktop | Bottom navigation, bottom-sheet modals, `dvh` sizing, 40 px touch targets, stacked forms |
| Subtle, purposeful micro-interactions | Page entry, card lift, button press, progress, saving, voice states — and nothing else |
| Accessibility | WCAG AA contrast fixed and measured, visible focus, motion tiers, semantic roles |
| Performance | CSS-only animation, one lazy-loaded hero chunk, hardware hints, no new animation library |

Hard rules that shaped the work: **do not animate every element**, **do not sacrifice functionality,
accessibility, performance or usability for visual effects**, and **never present Arena as an
official JEE/NEET examination**.

---

## 2. The homepage hero

`client/src/features/landing/KnowledgeCore.tsx` (new, 276 lines) is a single inline SVG — no canvas,
no WebGL, no animation library, no image request.

**What it shows.** A central Vroqn core with a progress arc at 68 %, wrapped by three orbit rings
(slow / mid / fast) carrying the **seven learning nodes that map to the seven steps of the learning
loop** on the same page — Learn, Practice, Test, Compete, Benchmark, Diagnose, Improve. Seven
particle streams travel inward along the connection paths, so the diagram reads as *knowledge
flowing into a core that measures progress* rather than as generic decoration.

**How it stays cheap.**

* Only `transform` and `opacity` are animated — no layout, no paint on the critical path.
* Orbit durations are 52 s / 34 s / 22 s. Slow enough to be ambient, not distracting.
* SVG node pulses animate `transform: scale()` with `transform-box: fill-box`, because animating the
  SVG `r` attribute is unreliable in Safari.
* The particle dash loop uses a `stroke-dashoffset` of −66 — exactly three dash periods — so the
  cycle is seamless instead of visibly jumping.
* The hero wash keeps its blur at or below 22 rem / 100 px; larger blurs on a full-width element are
  an expensive paint on mobile GPUs.
* `pointer-events: none` and `aria-hidden` on the decorative layers: the hero can never swallow a
  tap and a screen reader never has to read 40 stray shapes.

**Three motion tiers** (`client/src/hooks/useMotionTier.ts`, new) — mirrored onto a `data-motion`
attribute so markup and CSS cannot drift apart:

| Tier | Triggered by | What still animates |
| --- | --- | --- |
| `full` | A capable device, no reduced-motion preference | Orbit rings, core breathing, halo, 7 particle streams |
| `reduced` | ≤ 4 CPU cores, or a mid memory hint | Orbit rings and core breathing only — the 7 particle streams are dropped |
| `static` | `prefers-reduced-motion: reduce`, very low memory, or `saveData` / slow effective connection | Nothing. The complete diagram is still drawn |

The tier is also live: `matchMedia` change events are subscribed to, so switching on "reduce motion"
mid-session takes effect without a reload.

**Graceful degradation is the whole point.** If every hardware hint is missing — an old browser, a
privacy extension — each check falls through to `full` rather than breaking. And because the
pre-reveal state is applied *by JavaScript*, the hero and every other section render fully visible
when JS does not run at all. **With all animation disabled the hero is still a labelled diagram of the
learning loop plus a complete product message.**

---

## 3. Design system and theme

`client/src/styles.css` grew to 567 lines and is now the single source of truth: `@theme` tokens →
`@layer base` → `@layer components` → `@layer utilities` → motion overrides.

**Added tokens:** a three-step elevation scale, one shared easing curve
(`--ease-out`) used by every transition in the product, and orbit variables for the hero.

**Added surfaces and utilities** (22 classes total, listed here so they can be found again):

```
.vroqn-glass  .vroqn-metal  .vroqn-edge   .vroqn-grid-bg  .vroqn-lift
.vroqn-page-enter  .vroqn-skeleton  .vroqn-sweep  .vroqn-tap
.vroqn-ring-pulse  .vroqn-tabular  .vroqn-text-balance  .vroqn-scroll-x
.core-breathe  .core-halo  .core-flow  .core-node  .core-orbit-slow
.core-orbit-mid  .core-orbit-fast  .core-drift  .core-label
```

Eleven keyframes back these: `core-breathe`, `orbit-rotate`, `orbit-rotate-reverse`, `flow-dash`,
`node-pulse`, `halo-breathe`, `progress-arc`, `drifts`, `skeleton-shimmer`, `bar-sweep`, plus the
existing `rise` / `fade` / `blink` / `ripple`.

**Restraint, deliberately.** No new colours were introduced. Glow is used for state (focus, live
competition, connected AI key, timer urgency) — never as decoration. There is one accent hue, one
radius family, one type scale.

**Reveal-on-scroll** (`client/src/hooks/useReveal.tsx`, new) wraps the homepage sections. It fails
open by design: the pre-reveal state is applied *by JS*, the observer unobserves after firing, it is
skipped entirely under the `static` tier, and it is `motion-reduce:transition-none`. Content can
never end up invisible because an observer did not fire.

---

## 4. UI quality — what was actually changed

**Buttons.** All four sizes now share one transition curve and one `focus-visible` outline. Every
size meets the 40 px touch minimum: `sm` is 32 px *drawn* but gains a transparent `::after` that
extends its hit area to 40 px — **only under `pointer: coarse`**, so desktop keeps its intended
density. Loading, disabled, hover, active and focus states are visible on every variant.

**Chips.** Six chip-sized (28–32 px) buttons that had no touch affordance were fixed — the AI-status
chip in the header, the **mobile-only "Palette" control in the Arena runner** (the one control you
would most regret missing under a timed paper), the weak-topic chip on the exam result, and three
Tutor prompt/attachment controls.

**Tabs.** `Segmented` was rebuilt as a `role="radiogroup"` with `role="radio"` children, roving
`tabindex`, `aria-checked` and full Arrow/Home/End keyboard navigation. Previously a keyboard user
had to tab through every option and there was no announced selection state.

**Confirmations.** `client/src/components/Confirm.tsx` (new) provides `ConfirmProvider` +
`useConfirm()`, mounted in `main.tsx`. **All five** `window.confirm` call sites were converted
(activity reset, note delete, two settings resets, exam discard). Delete/reset confirmations are now
in-product, themed, keyboard-accessible and screen-reader-legible, with a clear destructive label
instead of a browser dialog. `window.confirm` no longer appears in shipped code — the only remaining
match is the comment explaining why.

**Loading states.** `Skeleton`, `SkeletonCard` and `LoadingState` were added to the UI kit.
`LoadingState` carries `role="status"` + `aria-live="polite"`, so the wait is announced. **Twelve
pages** that previously showed a bare spinner with no explanation now name what is loading — "Loading
your paper…", "Building your progress report…", "Loading the question queue…". Six of them had *no* text
at all before. The dashboard's stat row now uses skeletons rather than a spinner.

**Empty and error states.** These were already well covered (`EmptyState` ×15, `ErrorState` ×22
across the feature pages); this pass verified each one offers a next action rather than a dead end,
and left them in place.

**Typography and readability.** An 11 px floor is now enforced product-wide — **no text is smaller
than 11 px anywhere**. That included primary navigation labels, which had been 10.5 px (the last place
to shrink type, since a student reads them constantly) and chart axis labels at 10 px. Larger contrast
and size changes were made surgically rather than sweeping, so no layout reflowed unexpectedly.

**Terminology.** Student-facing strings were checked for jargon. "Generate practice set", "Start
practice", "Answer one at a time" — no "Initialize Practice Session" style phrasing anywhere.

**Modals.** Already mobile-correct (bottom sheet under 640 px, `max-h-[92dvh]`, full-screen scroll),
verified rather than rebuilt.

---

## 5. Mobile-first

* **Navigation.** Bottom navigation was raised to `h-14` links with a larger label size, an animated
  inside-box marker, matching More button and `aria-current="page"`. The marker style was changed
  from an outside item so it cannot push the item wider than its slot.
* **Exam surfaces.** The Arena runner keeps its countdown in a `sticky top-0` glass header with
  `role="timer"` and tabular numerals, colour-stepped to amber then red, plus an explicit "under a
  minute — the paper submits automatically at zero" warning. Controls stay reachable via a `sticky
  bottom-0` glass footer. This is the requirement most likely to be silently broken and it was
  checked directly: `ui-smoke` asserts `timer=true` and `Runner hides chrome`.
* **Forms.** The sign-up Class/Board pair was two selects side by side — about 150 px each on a 360 px
  phone, which clips "State board". They now stack below 640 px. The first form a new student ever
  fills in is no longer cramped.
* **Long values.** The Arena result meta row (time used, average per question) was a hard 2-column
  grid that forced long strings into half-width cells; it is now a wrapping flex row with
  `whitespace-nowrap` items, so entries wrap as whole units.
* **Horizontal overflow.** Every fixed-width element was audited. The 248 px sidebar and 268 px Tutor
  aside are `lg:`/`xl:` only, the admin table already sits in an `overflow-x-auto` wrapper, long
  filenames are truncated, and the exam progress bar is `flex-wrap` with a 200 px minimum. No
  full-width scroll risk was found by static analysis.
* **Keyboard vs. inputs.** Modals and runners use `dvh` units, so the composer and footer stay clear
  of the on-screen keyboard.

Two `grid-cols-2` layouts were **kept deliberately** — the percentile/position stat pair and the paper
palette legend. Both hold only short values, and stacking them would waste vertical space on the exact
screens where space is scarcest.

**This section was originally static analysis. It has since been measured in a real browser, which
found two bugs it had missed — see §13.**

---

## 6. Micro-interactions

Every one of these is `transform`/`opacity`/`color` only, has a visible start and end state, and
respects `prefers-reduced-motion`:

| Interaction | Where | Signal |
| --- | --- | --- |
| Page entry fade-and-rise | Every route (`AppShell`) | Navigation happened |
| Card lift on hover | Feature cards, competition cards | This card is interactive |
| Press feedback | All buttons | The tap registered |
| Shimmer skeleton | Dashboard stat row | Content is loading, shape is known |
| Progress sweep | Progress bars | Work is advancing |
| Saving / saved / retry | Arena and exam answer sync | Whether your answer is safe |
| Live competition pulse | Arena cards | This paper is running right now |
| Timer urgency | Exam + Arena runner | Time is running out |
| Voice states | AI Tutor orb | Listening vs. thinking vs. idle |

Deliberately **not** animated: headings, body copy, table rows, form fields, navigation items,
badges, list items, the sidebar, and every element that is merely being displayed. The rule applied
was: if moving it does not tell the student something, it does not move.

---

## 7. Accessibility

**Contrast — measured, not assumed.** `--color-muted-dim` failed WCAG AA and is used in **99 call
sites across 24 files**, so the token was fixed rather than each usage:

| Token | Before | After | Ratio (card / page) |
| --- | --- | --- | --- |
| `--color-muted-dim` | `#64748b` | **`#8494a8`** | 4.24 / 3.86 (fail) → **5.94 / 7.02 (AA pass)** |

Other measured values: `#f5f7fa` 18.79 / 17.12 / 17.93, `#94a3b8` 7.87 / 7.17 / 7.50, `#00e5ff`
13.11, `#7ee2a8` 12.80, `#fcd28b` 14.15, `#fca5a5` 10.63. All pass AA; most pass AAA.

**Keyboard and semantics.** A global `:focus-visible` outline covers every focusable element,
including raw `<button>`s that predate the UI kit. `Segmented` is a proper radiogroup with arrow-key
navigation. Nav items carry `aria-current="page"`. Destructive confirmations are real dialogs.

**Screen readers.** The hero is exposed as a single labelled image (`role="img"`, "Diagram of the
Vroqn learning core: seven learning nodes connected to a central core that measures your progress.")
with all 13 decorative layers `aria-hidden`. Loading states announce themselves politely. The exam
timer is `aria-live="off"` so a countdown does not chatter.

**Names and text.** All 45 `<button>` elements in the product were checked programmatically:
**0 have no accessible name.** No `<img>` elements exist at all — the product uses inline SVG icons
exclusively, and the logo mark is a labelled SVG. No heading level is skipped anywhere.
`<html lang="en">` is set.

**Motion.** `prefers-reduced-motion: reduce` is honoured globally (animations and transitions
collapse, smooth scrolling off) *and* by the tier system, which switches ambient decoration off rather
than fast-forwarding it.

---

## 8. Performance

| Measure | Turn 4 | Turn 5 | Note |
| --- | --- | --- | --- |
| Entry chunk | 226 KB | **225 KB** | Slightly smaller despite the whole new design layer |
| Entry chunk gzipped | — | 70 KB | |
| CSS bundle | — | 70 KB | |
| Lazy homepage chunk | — | 26 KB | The hero ships only with the landing page |
| `client/dist` | 732 KB | 752 KB | 51 cache-friendly lazy chunks |
| Animation libraries added | — | **0** | Pure CSS + inline SVG |

The hero costs no new dependency, no image request and no network round trip. It is a static SVG that
CSS animates, in a chunk that is lazy-loaded and only reaches visitors who see the homepage.

---

## 9. The seven-question new-student test

Run against the **actual UI with a genuinely new account** (signed up fresh, zero activity) — not
against the marketing page.

| # | Question | Where the answer is | Verdict |
| --- | --- | --- | --- |
| 1 | What is Vroqn? | Landing headline "Study smarter with one workspace that learns how you learn"; the nav tagline "Learn · Practise · Build · Test"; the dashboard tool grid with a one-line description per tool | ✅ |
| 2 | What can I do here? | Dashboard **Start here** grid: Ask AI (text or voice), Practice (topic-wise sets), Mock Exam (timed, with analysis), Notes (upload & clean up), Code Lab (write, run, review), Arena | ✅ |
| 3 | Where do I start? | "Ready to learn something new?" + **Start here**, and **What to do next** → "Connect your first AI key… Add a free Gemini, Groq or OpenRouter key" | ✅ |
| 4 | How do I practise? | Practice page: "Generate a set, answer one question at a time, and see exactly why an answer is right or wrong", a 4-step "How practice works here" list, then subject / chapter / difficulty / question type / count | ✅ |
| 5 | What is Arena? | **Fixed this pass.** The page opening now reads: "Timed papers created and run inside Vroqn Nexus… Arena is a Vroqn-created competition — not an official JEE, NEET or board examination." Previously it opened with abstract copy that never answered the question directly | ✅ (improved) |
| 6 | How do I see my performance? | Learning Activity: "Your progress across every part of Vroqn Nexus", 7/30-day toggle, study time, questions, weak/strong areas, per-attempt analysis; dashboard links to it as **Full report** | ✅ |
| 7 | What should I practice next? | Dashboard **Weak areas** (ranked from your own attempts) → "Practise this", and **What to do next** with a one-line reason. For a new account this correctly reads "No weak areas yet — answer a practice set or sit a mock exam and Vroqn Nexus will spot the topics that need work" | ✅ |

Every answer is reachable from the dashboard in at most one tap, with no documentation. Question 5
was the single genuine gap and was fixed by rewriting the Arena page's first sentence.

---

## 10. Verification

All results below are from commands that were actually run after the final code change.

| Check | Command | Result |
| --- | --- | --- |
| Types | `npm run typecheck` | **0 errors** |
| Client build | `npm run build --workspace client` | ✅ 4.07 s |
| Server build | `npm run build --workspace server` | ✅ clean |
| Unit / integration tests | `npm test` | **84 passing / 22 suites / 0 failing** |
| API smoke | `npm run smoke:api` | **PASS 135 / FAIL 0** |
| UI smoke (jsdom) | `npm run smoke:ui` | **37 screens / 0 failed / 0 runtime errors** |
| Real-browser layout | `npm run smoke:browser` | **25 passed / 0 failed** (360 / 390 / 430 / desktop) |
| End-to-end flows | `npm run smoke:flows` | **PASS 72 / FAIL 0** |

All five suites were re-run after the §11 fixes and are green.

The running server was confirmed to be serving the freshly built bundle with `/api/health` → 200.

**Four new permanent regression checks were added to `ui-smoke`** so the hero cannot silently break:

```
ok  Hero animation        Knowledge core rendered, tier=reduced
ok  Hero reduced motion   tier=static, diagram still complete
ok  Hero on weak hardware tier=reduced, particles dropped, diagram intact
ok  Hero on minimal hardware tier=static, diagram intact
```

The harness can now simulate an OS reduced-motion setting, a dual-core handset and a 1 GB device. The
landing-page check also now asserts that every in-page `#anchor` resolves and that four of the seven
new-student questions are answered on the page.

The three motion tiers were additionally confirmed against real markup: the core renders in all
three, always with its 7 nodes, 3 orbit rings and progress arc intact.

**Known test-harness behaviour — all suites share the demo account's live Arena paper.**

* `smoke:api`, `smoke:ui` and `smoke:flows` **submit** it. Run them back to back without reseeding and
  the next suite sees "already submitted" and cascades into ~11 spurious failures.
* `smoke:browser` only **reads** it (to measure the countdown and the exam controls) but needs one
  that is still running, so it must run *before* those suites or after a reseed.

The procedure followed for every result above: `npm run seed:arena --workspace server`, then a ~60 s
wait for the auth rate-limiter window, before each Arena-driving suite.

---

## 11. Real-browser verification — and the three bugs it found

Everything above is reasoning about layout. This section is measurement.

`scripts/browser-check.mjs` drives Chromium at **360×740, 390×844, 430×932 and 1440×900**, signing
in as a real account and walking eleven routes at each width. It measures the document for horizontal
overflow, every interactive element for its hit area, every text node for its rendered size, opens the
tallest modal, opens a live Arena paper and scrolls it 900px, and re-loads the homepage under
`prefers-reduced-motion: reduce`.

**It found three defects that jsdom cannot see and static analysis had missed.**

### 11.1 · CRITICAL — the Mock Exam form was clipped off the right of the screen

At 360 px the Mock Exam page had `scrollWidth = 510` against a 360 px viewport: **150 px of the setup
form was off-screen, and `overflow-x: hidden` on `body` meant it could not be scrolled to either.**
The student simply could not reach the right-hand side of the form. Measured on six routes:

| Route | Overflow at 360 px |
| --- | --- |
| Mock Exam | **+150 px** |
| Arena | **+97 px** |
| Dashboard | +4 px |
| Practice, Notes, Code Lab, Activity, Settings, Tutor | 0 px |

**Root cause.** A grid item defaults to `min-width: auto`, so it refuses to shrink below its own
content's min-content width. The card was 494 px inside a **328 px** parent — it had punched straight
through its own column and taken the page with it.

**Fix.** `min-w-0` on the `Card` primitive, plus a scoped `.grid > * { min-width: 0 }` so the whole
class of bug cannot return silently. Grid tracks were already `minmax(0, 1fr)`; this only brings the
item back in line with its own track. Text wraps instead of overflowing. One change fixed both
affected pages.

### 11.2 · HIGH — every modal on the site opened below the fold on a phone

The upload dialog rendered at **y = 615 in a 640 px viewport.** A student who tapped "Upload & clean"
saw a dimmed backdrop, a sliver of the dialog title at the very bottom edge — and nothing else. The
screenshot is unambiguous; the dialog title was literally half-cut by the bottom of the screen.

**Root cause — and this one was a regression I introduced earlier in this same pass.** A
`position: fixed` element is laid out against the nearest ancestor that establishes a *containing
block*, and more ordinary CSS does that than people expect: `transform`, `filter`, `backdrop-filter`,
`will-change`, `contain`. The page wrapper carried `animation: rise 0.32s var(--ease-out) both`, and
`both` persists the final keyframe — **leaving a permanent `transform` on that wrapper.** Every
in-place overlay was therefore positioned against the page instead of the viewport.

**Fix**, in two layers:
1. **Root cause** — `Modal` and `Confirm` now render through `createPortal` into `document.body`, so
   no ancestor can ever become their containing block again.
2. **Defence in depth** — the entry animation changed from `both` to `backwards`, so it no longer
   leaves a transform behind for anything added later.

Verified after the fix: the overlay measures 360×640 at y=0, the panel 360×589 at y=51 — **fully on
screen, with content scrollable to reach the rest.**

### 11.3 · MEDIUM — 84 interactive elements were under the touch minimum

Systematic, not scattered. Four real classes, all fixed:

| Element | Measured | Fix |
| --- | --- | --- |
| Note "star" control | **14×14** | Real 32×32 box, 40 px touch target |
| Segmented options (difficulty, count, provider, mode) | 37 px tall | `vroqn-tap` on both size variants |
| Mock Exam topic chips | 29 px tall | `vroqn-tap` + more vertical padding |
| Arena "Continue exam" / "View analysis" / other CTAs | 36 px tall | Raised to 40 px (`Button md` parity) |
| Tutor history rows, Code Lab session rows | 38–39 px | `vroqn-tap` |
| Arena competition + attempt title links | 21–22 px | `vroqn-tap` |
| On/off switches | 24 px tall | `vroqn-tap` (drawing unchanged) |
| Underlined text actions (Practise, Details, Regenerate…) | 18 px tall | `vroqn-tap` + `inline-flex` |

Two of these were genuine WCAG 2.5.8 failures and had been since before this pass: the 14 px star
button and the 18 px text actions. Note the `inline-flex` change also **fixed a latent bug**: `mt-1.5`
is ignored on an inline box, so the spacing those elements were written to have had never applied.

**Result: 0 undersized targets** across eleven routes at four viewport widths.

Full-suite re-verification after all three fixes: **25 / 25 browser checks pass**, with
`typecheck`, unit tests (84), `smoke:api` (135), `smoke:ui` (37) and `smoke:flows` (72) all unaffected.

---

## 12. Files touched

**New (4)**

| File | Lines | Purpose |
| --- | --- | --- |
| `client/src/hooks/useMotionTier.ts` | 83 | `full` / `reduced` / `static` device tier |
| `client/src/hooks/useReveal.tsx` | 101 | Fail-open reveal-on-scroll |
| `client/src/features/landing/KnowledgeCore.tsx` | 276 | The hero diagram |
| `client/src/components/Confirm.tsx` | 203 | `ConfirmProvider` + `useConfirm()` |

**Changed — foundation (5):** `styles.css` (+design layer), `components/ui.tsx`, `components/AppShell.tsx`,
`main.tsx`, `App.tsx`.

**Changed — pages (14):** `LandingPage`, `DashboardPage`, `TutorPage`, `PracticePage` (verification
only), `NotesPage`, `CodeLabPage` (verification only), `ActivityPage`, `SettingsPage`, `AuthPage`,
plus all six Arena surfaces and the three exam surfaces.

**Changed — tooling (2):** `scripts/ui-smoke.mjs` (4 hero checks, 2 landing checks, motion simulation);
`scripts/browser-check.mjs` — **new**, real-Chromium layout verification (25 checks, 12 screenshots).

**Fixed as a result of real-browser measurement (§11):** `components/ui.tsx` (`Card` `min-w-0`,
`Modal` portal, `Switch` target, `Segmented` target), `components/Confirm.tsx` (portal),
`styles.css` (`.grid > *` guard, entry animation), `features/notes/NotesPage.tsx`,
`features/exams/ExamsPage.tsx`, `features/tutor/TutorPage.tsx`, `features/code-lab/CodeLabPage.tsx`,
`features/dashboard/DashboardPage.tsx`, `features/activity/ActivityPage.tsx`,
`features/settings/SettingsPage.tsx`, `components/ToastHost.tsx`, `components/AITrace.tsx`,
and the five Arena files with 36 px CTAs.

---

## 13. What is still not verified, and known limits

Honest status — these are the gaps, not resolved issues.

1. **Real-browser layout verification now exists** (§13), but it is opt-in and covers layout, not
   animation feel. It measures overflow, touch targets, modal fit, the sticky exam timer and reduced
   motion at 360/390/430 px and desktop. What it still cannot judge is whether an animation *looks*
   smooth — frame pacing on real hardware is unmeasured.
2. **Bundle size warning.** Rollup still warns that a chunk exceeds 500 KB. It is the deliberately
   unsplit smoke bundle; the production build splits into 51 lazy chunks with a 225 KB entry.
3. **`prefers-reduced-motion` collapses all transitions, including spinners.** The spinner freezes
   rather than rotating. This is intentional and the correct reading of the setting, and every
   loading state now carries text — but it is a deliberate trade, so it is recorded here.
4. **`server/.data/` SQLite state persists** between sessions. Suites that drive Arena must reseed.
5. **PostgreSQL has never been run.** It remains code-reviewed plus a compatibility test; only SQLite
   has been executed.
6. **No ESLint or Prettier** in the project. The only linter-equivalent is `tsc` with
   `noUnusedLocals` / `noUnusedParameters`.
7. **Docs staleness:** `docs/ARENA.md` still quotes older smoke counts.
8. **Arena remains an independent Vroqn competition.** It is not, and is never presented as, an
   official JEE, NEET or board examination. This wording is now on the Arena page opening, every
   competition card, and the public homepage — and `ui-smoke` asserts it is present.
