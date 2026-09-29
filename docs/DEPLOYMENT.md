# Deployment

Vroqn Nexus ships as **one service**: an Express API that also serves the built React client. The
browser only ever talks to one origin, so there is no CORS surface to configure and the httpOnly
session cookie works without `SameSite=None`. There are no microservices, no Redis and no WebSocket
tier — nothing in the product needs them.

---

## 1. What the deploy actually runs

| Step | Command | Notes |
| --- | --- | --- |
| Install | `npm ci` | npm workspaces; `client/` and `server/` install together |
| Build | `npm run build` | Vite builds `client/dist`, `tsc` compiles the server to `server/dist` |
| Start | `npm start` | `node server/dist/index.js`, binds `0.0.0.0:$PORT` |
| Health | `GET /api/health` | returns `{ ok: true, ... }` — used by Render's health check |
| Migrate | automatic | runs on boot, before the server starts listening |

The boot sequence is deliberate and fails loudly rather than half-starting:

1. `assertConfig()` — refuses to boot on a misconfigured production environment (missing
   `JWT_SECRET` / `VROQN_MASTER_KEY` / `DATABASE_URL`, a bad `VROQN_MASTER_KEY` format, `DEMO_MODE=on`
   in production, SQLite in production without an explicit override). Every problem is printed with a
   `[config]` prefix so a platform log shows the cause immediately.
2. `migrate()` — applies any pending migration inside a transaction and records it in
   `schema_migrations`. Re-running is a no-op.
3. `ping()` — verifies the database answers. An unreachable database aborts the boot instead of
   serving 500s to students.
4. `listen()` — only now does the server accept traffic.

---

## 2. Deploying with the Render blueprint

`render.yaml` in the repository root defines the web service and a managed PostgreSQL database.

1. Push the repository to GitHub.
2. Render → **New** → **Blueprint** → select the repository.
3. Fill in the two values Render prompts for (see §3), then apply.

The blueprint pins `NODE_ENV=production`, wires `DATABASE_URL` from the database, generates
`JWT_SECRET`, sets the Node version, and leaves `DEMO_MODE` unset so it defaults to **off** in
production.

---

## 3. Environment variables

### Required in production

| Variable | Value | Why |
| --- | --- | --- |
| `NODE_ENV` | `production` | enables the fail-fast checks and disables the sample AI engine |
| `DATABASE_URL` | Postgres connection string | **required**; SQLite is refused in production |
| `JWT_SECRET` | ≥ 32 random characters | signs session cookies. The blueprint generates it |
| `VROQN_MASTER_KEY` | **exactly 64 hex characters** | encrypts each student's provider API keys at rest. Generate with `openssl rand -hex 32` |

`VROQN_MASTER_KEY` is the one value that cannot be auto-generated: the server validates the format,
precisely so a mistyped key is caught at boot rather than at the first key save. **Losing it makes
every stored API key unreadable** — those keys must then be re-entered by hand.

> In development both secrets are generated on first run and cached in `server/.data/server.secrets.json`.
> That convenience is deliberately unavailable in production, where generated secrets would silently
> invalidate every session on each restart.

### Optional

| Variable | Default | Purpose |
| --- | --- | --- |
| `PORT` | `8787` | Render injects its own |
| `ARENA_ADMIN_EMAILS` | empty | comma-separated allowlist that unlocks `/arena/admin`. Empty = student-only deployment; nobody can self-promote. **Exactly what that grants (and what it does not) is written out in `docs/ARENA-ACCESS.md`** |
| `API_ACCESS_TOKEN` | unset | optional shared-secret gate for a fully private instance |
| `FRAME_ANCESTORS` | unset | set only if the app must be embedded in a school portal iframe. Unset keeps `frame-ancestors 'self'` |
| `ALLOW_SQLITE_IN_PROD` | unset | escape hatch for a single-instance demo with a persistent disk. Not used by the blueprint |
| `SEED_ALLOW_PROD` / `ARENA_SEED_DEMO` | unset | allow the demo seeders to run against production. Off by default |
| `AI_MAX_ATTEMPTS` | `8` | provider attempts before giving up |
| `AI_ATTEMPT_TIMEOUT_MS` | `45000` | per-attempt timeout |
| `VROQN_MODEL_*` | see `.env.example` | model ids per provider — change models without a code change |

Provider API keys are **never** environment variables. Each student pastes their own keys in
**AI Settings**; the server stores them encrypted with `VROQN_MASTER_KEY` and never returns them to
the browser.

---

## 4. Postgres

The SQL layer is portable: queries are written with `?` placeholders and rewritten to `$n` for
Postgres, and every column type is `TEXT`/`INTEGER`/`REAL`. Migrations run automatically on boot, so a
blueprint deploy needs no manual schema step.

Render's free Postgres instance expires after 90 days and its storage is not durable forever — for a
long-lived deployment use a paid plan (or any managed Postgres) and point `DATABASE_URL` at it.

To verify a connection string locally:

```bash
DATABASE_URL='postgresql://user:pass@host/db' NODE_ENV=production \
  JWT_SECRET="$(openssl rand -hex 24)" \
  VROQN_MASTER_KEY="$(openssl rand -hex 32)" \
  npm start
```

The boot log prints the resolved database kind and confirms the connection:

```
[vroqn] Nexus API listening on http://0.0.0.0:10000 (postgres, production)
[vroqn] Database: postgres connected
```

---

## 5. Demo data

The seeders refuse to run against production unless explicitly allowed:

```bash
npm run seed --workspace server                 # demo student account
npm run seed:arena --workspace server           # three demo competitions
```

Both abort with a clear message when `NODE_ENV=production` and `SEED_ALLOW_PROD=1` /
`ARENA_SEED_DEMO=1` are not set. **Never enable them on a public deployment** — the demo account's
password is documented in the README, so anyone could sign in as it.

For a hackathon demo where the demo account is genuinely wanted:

```bash
SEED_ALLOW_PROD=1 ARENA_SEED_DEMO=1 npm run seed --workspace server
```

---

## 6. Verifying a deployment

```bash
curl -s https://<your-service>.onrender.com/api/health          # {"ok":true,...}
curl -s -o /dev/null -w '%{http_code}\n' https://<service>/login # 200 (SPA fallback)
```

Then walk the product: open `/`, sign up, ask the AI Tutor a question, generate a practice set, start
a mock exam, run code in the Code Lab. The landing page must render for signed-out visitors, and
`/notes` must redirect to the sign-in screen when it is opened without a session.

---

## 7. Known deployment limits (read before claiming it is production-grade)

* **Code Lab execution** runs in a stripped child process with timeouts and output caps — not a
  container. It is not a security boundary; see `docs/SECURITY.md`. Do not expose it to untrusted
  input as-is.
* **Rate limiting is in-process** (per instance). Behind more than one instance, limits apply per
  instance rather than globally. A single Render service is unaffected.
* **No offline PWA caching**; the client needs a network connection.
* **Voice** uses the device's Web Speech API by default. Provider STT/TTS is an opt-in engine that
  requires the student to have added their own Groq or Gemini key.
