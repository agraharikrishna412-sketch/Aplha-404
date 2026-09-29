# Nexus — Turn 13 report

Five asks, in the order they were reported:

1. **"Duration select karte waqt last 1–2 digits bach jate hain."** Typing 180 gave 240.
2. **"Delete nahi ho raha."** A hosted competition could not be removed from the UI.
3. **The community should be able to run its own paper** — either upload one, or have the AI write it —
   and every member should get that same paper.
4. **"Leak 0."** An uploaded paper must be reviewed, changed and twisted so the file cannot work as an
   answer key, and an AI-written paper must be invisible to everyone.
5. **Exact dates.** A host should choose the day and time registration opens and the exam runs, not just
   "in N hours".

All four are done and verified on the running site, not just in tests.

---

## 1. The duration field ate digits

### What was wrong

The number inputs clamped on **every keystroke**. Type `1` → 1, `8` → 18 × 10 = 180 → but the clamp
ran before the next keystroke, so the sequence the field actually produced was `1 → 5 → 58 → 240`, and
the last digit of whatever you meant to type was gone. Every numeric box in the hosting form had it:
questions, duration, start-in, open-for.

### The fix

`client/src/features/communities/tabs/NumberField.tsx` (new). While the field is focused it keeps your
raw text and only checks it is a number; the clamp to `min`/`max` happens **on blur**. Empty text is
allowed while typing, so you can clear the box and start again. All four fields in `CompetitionsTab`
now use it, and `#comp-duration` reading back `180` after typing `1`,`8`,`0` is one of the checks in
the browser script below.

---

## 2. Remove was missing from the UI

The route (`DELETE /api/communities/:id/competitions/:competitionId`) already existed and worked. The
button did not exist. A host now sees **Remove** on every competition they own in the community, with a
confirmation that names what is being removed — *Remove "Uploaded Sprint 907856" from Class 10 CBSE?*
— and the card disappears when confirmed.

Two decisions worth stating:

* **Who may remove:** the community owner or a moderator (the same capability that lets them host).
  A member who tries it gets a 403 — asserted in the API test.
* **What removal means:** the community stops hosting the competition, but the Arena competition row
  itself is kept. If students already registered, deleting it would destroy their attempt history. That
  rule already existed in the service; only the button was missing.

---

## 3. Two ways to fill the paper

The host dialog now asks **Who writes the paper**:

| Option | What happens |
| --- | --- |
| **Vroqn AI writes it** | The blueprint's subject/count/difficulty is generated on the server, validated, and approved — the paper is ready the moment the competition is created. |
| **I already have a paper** | Paste it or attach a `.txt` / `.csv` / `.md` file in the format `1) question / A–D options / Answer: A / Explanation: …`. The server parses it, rewrites it (below), and stores only the rewrite. |

Both paths run immediately after the competition is created, so hosting no longer produces an empty
competition that can never start. The host gets a toast that states the outcome in words a teacher can
check — *"Paper ready — 3 questions. Every question was rewritten — values scaled by a common factor
and options reordered with the key following — so the uploaded paper cannot be used as an answer key.
The uploaded text was not stored."* — and the card shows the paper's state with the counts.

A competition that already has a paper refuses a second one (`409 paper_exists`) rather than swapping
the paper out from under students: host a new competition instead. Uploading something that is not a
paper (notes, a paragraph, no `Answer:` line) is refused with `400 unreadable_paper`, with the format
in the message.

### The host's paper decides the size of the paper

Found by reading a screenshot rather than by a failing test: the toast said *"Paper prepared: 3 of 12"*.
The form had 12 questions in it, the uploaded file had 3 — and because readiness is measured against
the stored blueprint, the competition would never become ready. The uploaded paper is now the
authority: after a paper is stored, the blueprint is realigned to the question count that was actually
uploaded, keeping the host's marks, duration and difficulty mix. Marks are unchanged; the count is what
runs.

---

## 4. Leak 0

### An uploaded paper is never the paper that runs

`server/src/services/communities/paper.ts`:

1. **Parse** — numbered stems, `A–D` options, `Answer: B`, optional explanation.
2. **Rewrite every question.** A common factor (2, 3, 4 or 5, per question) scales every quantity in
   the stem, the options, the key and the explanation; the options are then rotated and swapped, with
   the key following it. Values that are part of a unit or formula are left alone, so `m/s2` does not
   become `m/s8`. The explanation is made to state the rewritten answer, because the validator (rightly)
   rejects an explanation that never mentions its own answer.
3. **Validate** each rewrite through the same pipeline AI output goes through; anything rejected or
   duplicating an earlier question is dropped, and the host sees how many were dropped.
4. **Store** the rewrite, already approved. **The uploaded text is never stored.**

"Twisted" is accurate; "AI-reviewed" is not — the rewrite is a deterministic transformation, so it is
described in the UI as *rewritten*, not as *reviewed by a model*. A provider-backed rewrite pass can be
added behind the same function later without changing anything around it.

### The AI reviews and twists the uploaded paper

The rewrite is now **run by a model when a provider key exists** (`twistWithModel` in
`server/src/services/communities/paper.ts`, prompt in `server/src/services/ai/prompts.ts`):

* the host's questions are sent in batches, and the model is told to keep the concept and difficulty but
  change the numbers (new values that change the arithmetic, not a blanket doubling), the wording and
  the distractors, to reorder the options, and to recompute the answer;
* **every model answer is validated** by the same pipeline AI-written papers pass. A question that is
  missing, malformed or rejected is twisted deterministically instead, so the count the host uploaded is
  still the count that runs;
* if the router answers from the offline sample engine (no key configured), those questions are
  discarded — they are not twists of the uploaded paper, and calling them one would be a lie. The
  deterministic twist does the work and the reply says so;
* the reply reports which path ran and how many questions came from the model
  (`method: 'ai' | 'mixed' | 'deterministic'`, `rewrittenByModel`), and the toast repeats it in the
  host's words.


* The paper route answers with **counts only** — `{accepted, rejected, skipped, method, ready, required,
  note}`. No stem, no option, no key, not even in the refusal.
* A student who starts the paper receives stems and options; the payload contains no `answer`,
  `correct_answer` or explanation field, because answers and explanations are only joined after
  submission.
* **The platform console is sealed too.** `/api/arena/admin/competitions/:id/questions` — the route
  that returns every question with its key for review — refuses any competition that is hosted by a
  community while its window is open, with `403 community_paper_sealed`. It reopens once the window
  ends, when every attempt is already recorded. This is the difference between "students cannot see it"
  and "nobody can": for a community paper, an arena admin is nobody too.
* The host cannot read the paper back either — only its readiness counts (`communityPaperStatus`).

---

## 5. Exact dates for registration and the exam

The hosting dialog used to ask only "starts in N hours / open for M hours". A school works in dates, so
the dialog now offers **In hours** or **Exact dates**, and the date mode takes all four instants:

| Field | Meaning |
| --- | --- |
| Registration opens | when students may start entering |
| Registration closes | the last moment to enter |
| Exam starts | when the paper opens |
| Exam ends | when it closes and the paper is sealed |

Both modes end up as the same four ISO instants, so the product still has one clock; the host only
chooses how to describe it. The dialog reads the choice back in words
(*"Registration: Thu, 1 Oct, 10:00 am → Sun, 4 Oct, 10:00 am · Exam: Mon, 5 Oct, 10:00 am · 3 hours
window"*), and the same three rules the server enforces are checked before Create — registration must
close after it opens, the exam cannot start before registration closes, and it must end after it starts
— so an impossible schedule is refused in words instead of as a 400. Switching to date mode seeds the
fields from the hours currently entered, and a reset button puts them back.

---

## Verification

Everything below was run against this code. Nothing is claimed from reading the diff.

### Server tests — 182 passed, 0 failed (46 suites)

New file `server/test/community-paper.test.ts`, **9 tests**, hitting a real Express app over real HTTP
with a real SQLite database:

| Test | What it proves |
| --- | --- |
| parses the plain-text format | 3 questions with options, keys and explanations read correctly |
| rewrites so the file is not a key | stem, key and options all change; the key is still one of the options; the physics still holds |
| host fills the paper, never gets it back | upload → 201 with counts, no stem anywhere in the response; stored rows are approved with the key among their options; the form said 8, the file had 3, and the stored blueprint now says 3 with the marks and duration kept |
| key secret from students, second paper refused | member gets 403 on the paper route; a second upload gets 409 `paper_exists`; the student's start payload has no key, no answer and no explanation |
| console sealed while the window is open | arena admin gets 403 `community_paper_sealed` mid-window, the refusal carries no question text, a non-community competition is unaffected, and the console reopens after the window |
| AI path fills and approves | blueprint honoured, `ready: true`, approved rows equal the reported count |
| junk text refused, competition removable | notes are refused with `unreadable_paper`; the owner's DELETE removes the link; a stranger gets 403 |
| **the twist leaves nothing of the file** | after either path, no uploaded number survives in any stored stem, the options stay distinct, the key is among them, and the note carries prose only |
| **exact dates** | the four instants the host picked come back out of the database unchanged, with the duration; a schedule where registration closes after the exam starts is refused `400 bad_schedule` |

Second new file `server/test/community-paper-ai.test.ts`, **1 test with a stubbed provider**: a key is
stored, the provider is scripted, and the paper that ends up in the database must be the model's
rewrite — `method: 'ai'`, `rewrittenByModel: 2`, the uploaded wording gone, the reply still carrying no
question text. That is the test that proves the model branch actually runs.

### Live browser check — 21 of 21 passed

`scripts/check-community-paper.mjs` (new) drives Chromium against the running site as the host:

* sign in, find the community, open its Competitions tab
* **type `180` into Duration → the box reads `180`** (this is the reported bug, in a browser)
* type `12` into Questions → the box reads `12`
* both paper options are offered; the paste box recognises a real paper
* create → the toast says the paper was rewritten, and warns it cannot be used as an answer key
* no question text appears anywhere in the page
* the card reports its paper state; **Remove** exists, names the competition in its confirmation, and
  the card is gone afterwards
* **exact dates**: the four `datetime-local` fields are filled with a school's calendar, the dialog reads
  them back in words, an impossible schedule shows *"The exam cannot start before registration closes."*
  and disables Create, and the competition stored in the database starts and ends at exactly the minutes
  that were picked
* the AI path reports *"Paper ready — 14 questions. Generated on the server and approved automatically.
  No question text is returned to any browser."*
* the host sees readiness counts only; the platform console answers `403 (sealed)` for the same paper
* the check deletes the two competitions it created — Arena is back to its four seeded papers afterwards

### API smoke — 124 passed, 0 failed

Run against a freshly seeded server (`DATA_DIR` in a temp directory) so the result measures the code,
not the accumulated state of the live database. One fix was needed in the script itself: it picked
"the" live/open competition by state, which after community hosting could select a private community
paper — the fixture picker now prefers public seeded papers, which is what the console checks it makes
are about.

### Other sweeps

* `client` typecheck: clean. `npm run build --workspace client`: built (275.58 kB main bundle).
* `server` `tsc --noEmit`: clean.
* Deep site scan (`npm run scan:site`): **120 checks, 0 failures** — including the study-core geometry
  (frozen core 14 chips, 296 px spread, 33 px closest pair) and reduced-motion freeze.

---

## Screenshots

| File | What it shows |
| --- | --- |
| `docs/screenshots/community-paper-mode.png` | the hosting dialog with "Who writes the paper" and the pasted paper, Duration reading 180 |
| `docs/screenshots/community-paper-uploaded.png` | the upload outcome toast: paper rewritten, answer-key warning, nothing stored |
| `docs/screenshots/community-paper-ai.png` | the AI path: paper ready, approved automatically, no question text returned |
| `docs/screenshots/community-competition-remove.png` | the Remove confirmation naming the competition |
| `docs/screenshots/community-schedule-dates.png` | the host picking exact dates for registration and the exam, with the window read back in words |

---

## Files touched

**Server**

* `src/services/communities/paper.ts` (new) — parsing, the model twist with its deterministic fallback,
  validation, storage, blueprint realignment, readiness, and the console seal
* `src/services/ai/prompts.ts` — `paperTwistSystem`, the prompt for that pass
* `test/community-paper-ai.test.ts` (new) — the model branch, with a stubbed provider
* `src/routes/communities.ts` — `POST` / `GET /:id/competitions/:competitionId/paper`
* `src/routes/arena.ts` — admin question routes sealed for open community papers
* `src/services/communities/competitions.ts` — re-exports for the route layer
* `test/community-paper.test.ts` (new) — 7 tests

**Client**

* `src/features/communities/tabs/NumberField.tsx` (new)
* `src/features/communities/tabs/schedule.ts` (new) — hours ⇄ exact dates, the three schedule rules, and
  the plain-language summary
* `src/features/communities/tabs/CompetitionsTab.tsx` — Remove + confirmation, paper mode UI, outcome
  toast, and the In hours / Exact dates switch
* `src/features/communities/api.ts` — `preparePaper` / `paperStatus` and their types

**Scripts / docs**

* `scripts/check-community-paper.mjs` (new), `scripts/clean-probe-communities.mjs` (new)
* `scripts/api-smoke.sh` — fixture picker narrowed to public seeded papers
* `docs/ARENA-ACCESS.md` — the seal added to the list of things an admin cannot do

---

## Honest limits

* The twist runs **on the model when a provider key is configured** — new numbers, new wording, new
  distractors, recomputed answers — and each rewrite is validated before it can be stored. With no key
  configured the deterministic fallback runs instead (values scaled, options reordered, key following):
  it still defeats the file as an answer key, but the wording stays recognisable, and the reply says
  "twisted on the server" rather than claiming the AI did it.
* The model is not asked to invent new questions, only to rewrite the ones the school uploaded, so a
  paper stays faithful to the syllabus the teacher chose — that is the point, and also the limit.
* The console seal ends when the paper's window ends: after that an arena admin can read the stored
  questions, which is what reviewing a finished paper requires.
* Removing a community competition does not delete the Arena row (by design, for attempt history). A
  host who wants the Arena row gone as well asks their arena admin to delete it.
* Uploads are limited to 120 000 characters and 120 questions per paper, and to the plain-text/markdown
  shapes the parser understands — no PDF or DOCX parsing.
