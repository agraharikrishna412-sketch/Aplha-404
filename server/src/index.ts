/**
 * Vroqn Nexus API server.
 *
 * Boot order: migrate database → mount API → serve the built client (single origin in production,
 * Vite dev server proxies to us in development) → graceful shutdown.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import express from 'express';
import cookieParser from 'cookie-parser';
import cors from 'cors';
import { assertConfig, config, describeRuntime } from './config/env.js';
import { migrate } from './db/schema.js';
import { getDb, ping } from './db/index.js';
import { attachUser } from './middleware/auth.js';
import { errorHandler, notFoundHandler } from './middleware/errors.js';
import { limits } from './middleware/rateLimit.js';
import { authRouter } from './routes/auth.js';
import { keysRouter } from './routes/keys.js';
import { settingsRouter } from './routes/settings.js';
import { tutorRouter } from './routes/tutor.js';
import { notesRouter } from './routes/notes.js';
import { practiceRouter } from './routes/practice.js';
import { examsRouter } from './routes/exams.js';
import { codeRouter } from './routes/code.js';
import { activityRouter } from './routes/activity.js';
import { dashboardRouter } from './routes/dashboard.js';
import { arenaRouter } from './routes/arena.js';
import { communitiesRouter } from './routes/communities.js';
import { messagesRouter } from './routes/messages.js';
import { newsRouter } from './routes/news.js';
import { profileRouter } from './routes/profile.js';
import { searchRouter } from './routes/search.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const clientDist = path.resolve(here, '..', '..', 'client', 'dist');

const app = express();
app.disable('x-powered-by');
app.set('trust proxy', 1);

/* ------------------------------ security ------------------------------ */
app.use((_req, res, next) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Referrer-Policy', 'no-referrer');
  // Framing policy. Production refuses cross-origin framing (`X-Frame-Options: SAMEORIGIN` plus
  // `frame-ancestors 'self'` in the CSP) unless FRAME_ANCESTORS names the embedding origins — the
  // case for a school portal that iframes Vroqn. Development sets neither, so the app can be viewed
  // inside an embedded dev preview. See docs/SECURITY.md.
  if (config.isProd && !config.frameAncestors) {
    res.setHeader('X-Frame-Options', 'SAMEORIGIN');
  }
  if (!config.isProd && config.frameAncestors) {
    res.setHeader('Content-Security-Policy', `frame-ancestors ${config.frameAncestors}`);
  }
  res.setHeader('Permissions-Policy', 'microphone=(self), camera=(), geolocation=()');
  res.setHeader('Cross-Origin-Opener-Policy', 'same-origin');
  if (config.isProd) {
    // The client is served from the same origin; the code preview runs in a sandboxed iframe.
    res.setHeader(
      'Content-Security-Policy',
      [
        "default-src 'self'",
        // 'unsafe-inline' is required for the Code Lab live preview (student HTML/CSS/JS runs in a
        // sandboxed iframe via srcdoc). A hardened deployment should serve that preview from a
        // separate origin instead — see docs/SECURITY.md.
        "script-src 'self' 'unsafe-inline'",
        "style-src 'self' 'unsafe-inline'",
        "img-src 'self' data: blob:",
        "font-src 'self' data:",
        "media-src 'self' data: blob:",
        "connect-src 'self'",
        "frame-src 'self' blob: data:",
        `frame-ancestors ${config.frameAncestors ?? "'self'"}`,
        "base-uri 'self'",
        "form-action 'self'",
      ].join('; '),
    );
  }
  next();
});

/**
 * Optional shared-secret gate for self-hosted deployments.
 * Left unset by default; the cookie session is the primary protection.
 */
app.use((req, res, next) => {
  if (!config.apiAccessToken) {
    next();
    return;
  }
  if (req.path === '/api/health') {
    next();
    return;
  }
  const supplied = req.header('x-vroqn-token') ?? '';
  if (supplied && supplied === config.apiAccessToken) {
    next();
    return;
  }
  if (req.header('cookie')?.includes('vroqn_session')) {
    next();
    return;
  }
  res.status(401).json({ error: { message: 'Access token required.', code: 'access_token' } });
});

/* ------------------------------- parsing ------------------------------ */
app.use(express.json({ limit: config.jsonLimit }));
app.use(express.urlencoded({ extended: false, limit: '1mb' }));
app.use(cookieParser());

/* -------------------------------- CORS -------------------------------- */
// Same-origin in production. In development the Vite server proxies /api, so CORS is only needed
// for direct cross-port calls during local experimentation.
const allowedOrigins = new Set(
  [config.clientOrigin, 'http://localhost:5173', 'http://127.0.0.1:5173'].filter(Boolean) as string[],
);
app.use(
  cors({
    origin(origin, callback) {
      if (!origin) return callback(null, true);
      if (allowedOrigins.has(origin) || /^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(origin)) {
        return callback(null, true);
      }
      // Preview/proxy hosts (e.g. *.e2b.app) are allowed so the sandboxed demo works.
      if (/\.e2b\.app$/.test(new URL(origin).hostname)) return callback(null, true);
      return callback(null, false);
    },
    credentials: true,
  }),
);

app.use(attachUser);
app.use('/api', limits.general());

/* -------------------------------- routes ------------------------------ */
app.get('/api/health', (_req, res) => {
  res.json({ ok: true, service: 'vroqn-nexus', time: new Date().toISOString(), runtime: describeRuntime() });
});

app.use('/api/auth', authRouter);
app.use('/api/keys', keysRouter);
app.use('/api/settings', settingsRouter);
app.use('/api/tutor', tutorRouter);
app.use('/api/notes', notesRouter);
app.use('/api/practice', practiceRouter);
app.use('/api/exams', examsRouter);
app.use('/api/code', codeRouter);
app.use('/api/activity', activityRouter);
app.use('/api/dashboard', dashboardRouter);
app.use('/api/arena', arenaRouter);
app.use('/api/communities', communitiesRouter);
/*
 * Private messaging is mounted at its own path: community permissions, moderators and owners have no
 * standing in a private conversation, so the two systems must not share a router (§6).
 */
app.use('/api/messages', messagesRouter);
app.use('/api/profile', profileRouter);
app.use('/api/news', newsRouter);
/* One search box for people and communities — see the route file for what it refuses to search. */
app.use('/api/search', searchRouter);

/* ---------------------------- static client --------------------------- */
if (fs.existsSync(clientDist)) {
  app.use(express.static(clientDist, { index: false, maxAge: '1h', setHeaders: (res, filePath) => {
    if (filePath.endsWith('index.html')) res.setHeader('Cache-Control', 'no-cache');
  } }));
  app.get('*', (req, res, next) => {
    if (req.path.startsWith('/api/')) return next();
    res.sendFile(path.join(clientDist, 'index.html'));
  });
} else {
  app.get('/', (_req, res) => {
    res.type('html').send(
      `<!doctype html><html><body style="font-family:system-ui;background:#05070A;color:#F5F7FA;padding:40px">
        <h1 style="color:#00E5FF">Vroqn Nexus API</h1>
        <p>The client bundle has not been built yet. Run <code>npm run build</code> at the repository root,
        or start the Vite dev server with <code>npm run dev --workspace client</code>.</p>
        <p><a style="color:#22D3EE" href="/api/health">/api/health</a></p>
      </body></html>`,
    );
  });
}

app.use(notFoundHandler);
app.use(errorHandler);

/* ------------------------------- bootstrap ---------------------------- */
async function main(): Promise<void> {
  // Fail fast on a misconfigured deployment (missing production secrets, bad numbers) before we
  // touch the database or accept a single request.
  assertConfig();
  await migrate();
  const probe = await ping();
  if (!probe.ok) {
    throw new Error(`Database is not reachable (${probe.kind}): ${probe.detail ?? 'unknown error'}`);
  }
  const db = await getDb();
  const server = app.listen(config.port, '0.0.0.0', () => {
    const runtime = describeRuntime();
    console.log(`[vroqn] Nexus API listening on http://0.0.0.0:${config.port} (${runtime.database}, ${runtime.env})`);
    console.log(`[vroqn] Code Lab: ${runtime.codeLab} · sample engine allowed: ${runtime.demoModeAllowed}`);
    console.log(`[vroqn] Database: ${probe.kind} connected · data directory: ${config.dataDir}`);
    console.log(`[vroqn] Arena: paper approval ratio ${config.arena.requiredApprovalRatio} · numeric tolerance ±${config.arena.numericTolerancePct}%`);
  });

  const shutdown = async (signal: string) => {
    console.log(`[vroqn] ${signal} received — shutting down`);
    server.close();
    await db.close().catch(() => undefined);
    process.exit(0);
  };
  process.on('SIGINT', () => void shutdown('SIGINT'));
  process.on('SIGTERM', () => void shutdown('SIGTERM'));
  process.on('unhandledRejection', (reason) => {
    console.error('[vroqn] Unhandled rejection:', reason instanceof Error ? reason.message : reason);
  });
}

void main().catch((err) => {
  console.error('[vroqn] Failed to start:', err instanceof Error ? err.message : err);
  process.exit(1);
});

export { app };
