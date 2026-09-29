# Vroqn Nexus — turn 8 report

Your message, point by point, then what changed and how it was verified. Everything below was run
against the code in this archive.

---

## 1. Your requests, answered

| # | You said | Status | What was actually done |
| --- | --- | --- | --- |
| 1 | “Remove the navigation, everything will use from the dashboard” | **Done** | The persistent bottom bar is gone on every screen (`scan-site` asserts no fixed bar remains over the content). The dashboard now carries the whole map: a one-tap search field, a **“Everything in Vroqn”** grid with all 13 destinations generated from the navigation definition, quick actions, plus news, profile and communities. Sub-pages get a **back** button in the header instead of a menu, so nothing became a dead end. |
| 2 | “Make the homepage beautiful” | **Done** | New home composition: hero → search → *In the news* + *Your profile* side by side → quick actions → everything-in-Vroqn grid → your groups → today's learning, weak areas, next steps, AI connections. On a 1440 px screen the news and profile cards sit side by side; on a phone everything stacks with a single column. |
| 3 | “Show news on the homepage” | **Done** | `NewsStrip` shows the latest four headlines from the same publisher feeds the News screen uses, each opening the publisher in a new tab, with a door to the full News screen. |
| 4 | “Add the search option; by searching, shows both communities and users” | **Done** | One search box, reachable from the dashboard field, the header button on every page, and `⌘K`/`Ctrl+K`. It returns **Groups** and **Students** sections in one list. People results carry the server's own “can you message this?” decision, so the list never offers an action that would be refused. New endpoint `GET /api/search?q=` (9 tests). |
| 5 | “In Practice we can write our own chapter — no need to select” | **Done** | The chapter field is now a **text box**: type anything (“Rotational Motion”, your school's chapter name, a topic the textbook names differently). The known chapter list is offered as you-type suggestions, not as a gate. |
| 6 | “I am seeing some errors, please correct them” (the screenshots) | **Done** | Two real bugs, both reproduced and fixed — details in section 3. |
| 7 | “On the homepage show news, profile, community etc., make it beautiful” | **Done** | News strip ✅, profile card ✅ (with what classmates can see, and an Edit door), groups block ✅ (existing `CommunitiesHomeBlock` sits under the destination grid). |

Nothing in this list was skipped, and nothing is claimed that was not run.

---

## 2. The two errors in your screenshots

### a) “Could not save that — Invalid enum value. Expected 'public' | 'private', received 'members'”

You were on *Your profile → Privacy → Profile visibility* and tapped the middle option. The screen
offered three choices, but the API only accepted two, so every attempt to pick **Communities** was
rejected — four toasts, no save.

**Root cause:** the profile screen was rebuilt around three-way visibility (public / communities /
private), and the request validator was never widened. Because the screen looked finished, the failure
was invisible until a student used it.

**Fix, at the root and in the data model:**
- `PATCH /api/profile/me` accepts `public | members | private` now (migration **0011** adds a
  `profile_visibility` column; existing rows are backfilled from the old boolean, and both columns are
  written in step so the community layer keeps agreeing).
- **The middle option now means something.** `members` previously would have been a label with no
  effect. It is enforced server-side, in both profile views: a stranger gets the profile card without
  the bio/interests, a student who shares an active community with you sees the details, and `private`
  stays private even from a classmate.
- Covered by 4 new tests (`server/test/search-visibility.test.ts`), including the exact
  “members is accepted” case that produced your toasts.

### b) The chapter dropdown rendered see-through

In your fifth screenshot the *Chapter or topic* list shows the page text bleeding through the options.

**Root cause:** the dropdown panel uses `bg-[var(--color-elevated)]`, and that colour token was never
defined — the CSS variable resolved to nothing, so the panel was fully transparent. A floating surface
must be opaque by definition.

**Fix:** the token now exists (`--color-elevated: #101a22`), the panel is a solid, slightly raised
surface. A token audit was added to the scan workflow: the same bug class cannot return silently,
because every `var(--token)` used in the client is now checked against the token sheet.

### c) Two more polish defects found by the same pass

- The mobile header was translucent (`backdrop-filter`), which is not guaranteed to render — on a
  device or browser without it, the page scrolls *through* the header. It is opaque now.
- Five places used 10.5 px text, below the product's own 11 px floor; all raised.

---

## 3. What changed, file by file

**Server**
- `db/schema.ts` — migration **0011** `profile_visibility` (+ backfill).
- `services/profile.ts` — single `visibilityOf()` used by both profile views; three-way read rule;
  both columns written together.
- `services/communities/reputation.ts` — the community profile view imports the same visibility rule
  and honours `members` (a stranger cannot read a members-only bio).
- `routes/profile.ts` — validator accepts the three values.
- `routes/search.ts` (new) — one search for people + communities, rate-limited, session required,
  never returns the caller, never returns a private community, one character is not a search.
- `index.ts` — mounts `/api/search`.
- `test/search-visibility.test.ts` (new) — 9 tests.

**Client**
- `components/AppShell.tsx` — bottom bar and “More” sheet removed; header now has back/menu + search +
  AI status; sidebar unchanged on desktop.
- `components/SearchOverlay.tsx` (new) — the search sheet, with debounced results, stale-response
  protection, and “open full results” on Enter.
- `features/dashboard/DashboardPage.tsx` + `DashboardHub.tsx` (new) — search field, news strip,
  profile card, “Everything in Vroqn” destination grid.
- `features/practice/PracticePage.tsx` — chapter is a text field with suggestions.
- `styles.css` — `--color-elevated` defined (and the whole token sheet audited).
- All screens: bottom-bar padding removed; 10.5 px text raised to 11 px.

---

## 4. Verification (run on this build)

| Suite | Result |
| --- | --- |
| Server tests (`npm test`) | **144 tests / 39 suites / 144 pass / 0 fail** (was 135) |
| API smoke | **124 pass / 0 fail** |
| Flows | **66 pass / 0 fail** |
| UI screens (jsdom) | **44 screens / 0 failed / 0 runtime errors** |
| Real browser layout (320/360/390/430/1440 px) | **33 pass / 0 fail** |
| Whole-site deep scan | **82 pass / 0 fail** |
| Private chat, two real browsers | **18 pass / 0 fail** |

New checks added this turn, so the removals and additions stay honest:
- “the bottom navigation bar is gone” (no fixed bar overlapping content on a phone),
- “every destination is on the dashboard” (13 links, compared against the navigation definition),
- “search returns groups” **and** “search returns students in the same list” (the scan creates the
  community and the second student it then looks for, instead of hoping the database has them),
- “search says what it will not do” (the privacy note is on screen),
- “a sub-page can go back”, “the dashboard shows news”, “the dashboard shows your profile card”.

---

## 5. Known limitations (unchanged from last turn, still true)

1. Search covers **students and public groups**. Private groups are not discoverable, and DM content is
   never searched — the server holds only ciphertext.
2. The dashboard news strip needs outbound internet from the server to reach the publishers' feeds. If
   it cannot, the card says so and links to the News screen; it never shows invented headlines.
3. Encryption is real but not “verified” E2E (no safety numbers yet), exactly as before.
4. AI features still need your own Gemini / Groq / OpenRouter key; with no key the answers come from
   the labelled sample engine and mirror the language you write in.
