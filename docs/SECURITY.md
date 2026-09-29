# Security & privacy

Vroqn Nexus is a **bring-your-own-key** product. Students paste real provider keys into it, so key
handling is treated as the most sensitive part of the system.

## API keys

| Concern | How it is handled |
| --- | --- |
| Storage | AES-256-GCM (`services/crypto.ts`) with a 32-byte master key, before the value reaches the database. Ciphertext is versioned (`v1.<iv>.<tag>.<data>`). |
| Master key | `VROQN_MASTER_KEY` env var, or generated once into `server/.data/server.secrets.json` with `0600` permissions. Never committed, never logged. |
| Transport | Keys are sent once over the same-origin API and never returned. The UI only ever receives `masked` (`AIza••••••••4f9c`) plus a non-reversible HMAC fingerprint used for duplicate detection. |
| Display | Only the first ~12 % and last 4 characters are shown, never the middle. Plaintext is visible in the input only while typing. |
| Logs | Nothing about keys is logged. The error handler and fallback engine run upstream messages through `redactSecrets()`, which scrubs Google `AIza…`, Groq `gsk_…`, OpenRouter `sk-or-v1-…`, generic `sk-…` and `Bearer …` patterns. |
| Failures | A rejected key is parked with a cooldown and flagged in AI Settings ("Key rejected") instead of being deleted — the student decides what to remove. |
| Quota honesty | The product states plainly that adding keys does **not** add provider quota; it only lets the app rotate the keys the student already owns. |

## Authentication & sessions

* Passwords hashed with scrypt (N=16384, r=8, p=1), per-user random salt, `timingSafeEqual` comparison.
* Sessions are signed JWTs (issuer `vroqn-nexus`, 30 days) delivered in an `httpOnly`, `SameSite=Lax`
  cookie (`Secure` + `__Host-` prefix in production). `Authorization: Bearer` is also accepted for
  tooling.
* Sign-in returns the same message whether the email or the password was wrong.
* Optional shared-secret gate (`API_ACCESS_TOKEN`) for self-hosted deployments.
* Optional future: Google OAuth. Email/password only today.

## Request protection

* Zod validation on every body, query and params object; failures return a field-level 400.
* In-memory rate limits: auth 30/10 min, AI 40/min, uploads 40/10 min, code 20/min, general 300/min —
  keyed by user id when signed in, otherwise by IP, with `X-RateLimit-Remaining` and `Retry-After`.
* Body size cap (6 MB) for base64 attachments; uploads limited to 8 MB × 5 files, whitelisted by MIME
  extension (`png/jpg/jpeg/webp/gif/pdf/txt/md/csv/json`), stored outside the client bundle.
* Uploaded filenames are replaced with random ids; downloads resolve through `path.basename()` only.
* Security headers on every response: `X-Content-Type-Options`, `Referrer-Policy`, `X-Frame-Options`,
  `Permissions-Policy` (microphone self, camera/geolocation off), `Cross-Origin-Opener-Policy`, and a
  production CSP (`default-src 'self'`, `img/media` limited to self/data/blob, `frame-src` restricted).

### Framing / embedding

In production the app sends `X-Frame-Options: SAMEORIGIN` and `frame-ancestors 'self'`, so a hostile
page cannot frame it. Deployments that legitimately embed Vroqn inside a school portal can set
`FRAME_ANCESTORS` (e.g. `'self' https://lms.school.edu`) to publish an explicit allowlist instead —
the header becomes the CSP directive only, never a wildcard. Development sets neither so the app can
be viewed inside an embedded preview.

### CSP note

`script-src` includes `'unsafe-inline'` because the Code Lab live preview renders student HTML/CSS/JS
through an iframe `srcdoc`. The application itself never uses `dangerouslySetInnerHTML` and renders all
model output through React nodes, so this is the only consumer of that allowance. A hardened
deployment should serve the preview from a separate origin (e.g. `preview.example.com`) and drop
`'unsafe-inline'` from the app origin entirely.

## Code execution sandbox

`services/code.ts` runs student programs in a child process:

* throwaway `mkdtemp` directory, deleted in `finally`;
* environment stripped to `PATH`, `LANG` and `NODE_OPTIONS=''`, so no database URL, JWT secret or
  master key is inherited;
* wall-clock timeout (`CODE_TIMEOUT_MS`, 6 s), `SIGKILL` on expiry, `--max-old-space-size=256` for Node;
* output capped (`CODE_MAX_OUTPUT_BYTES`, 40 KB) to prevent memory blow-ups;
* `CODE_RUN=off` disables execution entirely while leaving the editor and AI review usable.

**This is a prototype sandbox, not a security boundary.** A production deployment must run each
submission in a container or micro-VM with a read-only root filesystem, no network, dropped
capabilities, and per-run resource quotas.

## Competitive exams (Arena)

* **Answer keys stay on the server.** The student-facing question view is an explicit projection that
  omits `correctAnswer` and `explanation`; the key is added to a response only after
  `results_published_at` is set. The API smoke test asserts both halves of this (0 occurrences pre-publish,
  and a key present post-publish).
* **A paper must be approved before it can be used.** Generated questions (AI *and* bank content) land
  as `pending`, never auto-approved. `paperReadiness()` reports approved / pending / flagged / rejected
  against `ceil(paperSize × ARENA_REQUIRED_APPROVAL_RATIO)` (default 1 = every question), and the gate
  is enforced by the service for both `start_now`/`publish` and student entry — the API answers `409
  paper_not_ready`. A live or published paper is also immutable: regeneration returns `409 paper_locked`
  unless the admin explicitly forces it.
* **Late answers are ignored, and a second submission is refused.** The deadline check lives in the
  service, not only in the route, so a stale tab or a crafted request cannot add answers after time;
  the attempt is graded from what the server holds (`autoSubmitted: true`). Submitting twice returns
  `409 already_submitted` with the attempt id — the first submission is the only one that counts.
* **Numerical marking is policy, not a constant.** `ARENA_NUMERIC_TOLERANCE_PCT` (default 1%) and
  `ARENA_NUMERIC_TOLERANCE_ABS` (used when the expected value is 0) set the rule, and a competition's
  blueprint may override the percentage per paper. The grading function is unit-tested on both sides of
  the boundary, including scientific notation.
* **The server clock decides everything.** Windows, deadlines and auto-submission are computed from the
  server's time (the client is sent `serverNow` only to render a countdown), so changing the device clock
  or refreshing the tab changes nothing. A late submission is still accepted and graded from what the
  server already holds — it never discards saved work, and it never accepts answers that arrived after
  time.
* **Registration is explicit and idempotent.** Public competitions accept any signed-in account; private
  ones require the invite code. Double registration returns the existing row instead of creating a second
  entry, and withdrawal is allowed while registration is open.
* **Authoring is allowlisted.** `ARENA_ADMIN_EMAILS` (server env, never user-settable) gates
  `/api/arena/admin/*`; students get `403`. There is no in-app way to become an admin.
* **Benchmarks are honest and anonymised.** Percentile/rank come only from valid submissions to that
  competition, carry a population label, are withheld below five submissions, and standings hide names —
  the UI states that this is an independent mock, not an official exam rank.
* **Competition deletion is restricted.** An admin may delete a competition only while it has no
  attempts; otherwise the API refuses with `409` and suggests archiving.
* Rate limits apply as everywhere else, and paper generation sits behind the tighter AI limit
  (`limits.ai()`), so a stuck admin cannot loop the provider.

## The offline sample engine

The built-in sample library exists so the app is usable with no AI key connected. Two rules keep it
honest:

* **It is a switch, not a hidden default.** `DEMO_MODE=off` disables it server-wide regardless of any
  stored per-user setting; in production it is off by default and `DEMO_MODE=on` is refused at startup,
  so sample content can never be served to real students. With it off and no key connected, an AI request
  fails rather than inventing an answer.
* **Sample output is labelled as sample.** The AI trace shows "Sample engine" and suppresses the model id,
  and the Arena post-competition analysis records `provider = 'sample'` / `model = 'vroqn-sample'` in
  `arena_performance_reports` — never a provider id that did not run. The deterministic analysis (used
  when the model is unavailable or returns something unusable) is recorded with no provider at all.

## Student privacy

* The Learning Activity system records only in-app learning actions (questions asked, answers given,
  exams, notes organised, code runs) and shows the student the raw rows that power the UI.
* No third-party analytics, ad SDKs, fingerprinting or hidden monitoring.
* One-tap erase (`DELETE /api/settings/activity-data`) removes activity events and topic statistics;
  notes, chats and exam papers are untouched.
* Model requests contain only what the student wrote or uploaded plus the tutoring context. Student
  content is never used for training by this application, and it sends the minimum needed to the
  provider the student chose.
* Errors shown to the student never include stack traces or upstream payloads; unknown exceptions
  become a generic message while the details stay in the server log.

## Reporting

This is a prototype. If you find a vulnerability, please open an issue with the steps to reproduce —
do not include real API keys in the report.
