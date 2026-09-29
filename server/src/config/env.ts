/**
 * Environment + runtime configuration.
 * Secrets are never logged. Master keys are generated once and stored with 0600 perms.
 */
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import dotenv from 'dotenv';

dotenv.config();

const here = path.dirname(fileURLToPath(import.meta.url));
/** server/ root (src/config -> up two) */
export const SERVER_ROOT = path.resolve(here, '..', '..');
export const REPO_ROOT = path.resolve(SERVER_ROOT, '..');

const env = process.env;
const isProd = env.NODE_ENV === 'production';

/** Treats '' (as exported by some CI/dotenv setups) as "not set". */
function optional(name: string): string | undefined {
  const value = env[name];
  return typeof value === 'string' && value.trim() !== '' ? value.trim() : undefined;
}

/** Numeric env with a fallback and a hard range check, so a typo cannot silently disable a limit. */
function numeric(name: string, fallback: number, opts: { min?: number; max?: number } = {}): number {
  const raw = optional(name);
  if (raw === undefined) return fallback;
  const value = Number(raw);
  if (!Number.isFinite(value)) {
    throw new Error(`[config] ${name} must be a number (got "${raw}").`);
  }
  if (opts.min !== undefined && value < opts.min) throw new Error(`[config] ${name} must be >= ${opts.min}.`);
  if (opts.max !== undefined && value > opts.max) throw new Error(`[config] ${name} must be <= ${opts.max}.`);
  return value;
}

export const config = {
  isProd,
  nodeEnv: env.NODE_ENV ?? 'development',
  /**
   * Optional CSP `frame-ancestors` value (e.g. `'self' https://lms.school.edu`) for deployments that
   * embed Vroqn in a school portal. Ignored in development, where framing stays open for previews.
   */
  frameAncestors: isProd ? (env.FRAME_ANCESTORS?.trim() || null) : null,
  port: numeric('PORT', 8787, { min: 1, max: 65_535 }),
  /** Public origin of the app (used for CORS only when running the client on another port). */
  clientOrigin: env.CLIENT_ORIGIN ?? '',
  /** Postgres connection string. When absent the app runs on an embedded SQLite file. */
  databaseUrl: env.DATABASE_URL ?? '',
  dataDir: env.DATA_DIR ?? path.join(SERVER_ROOT, '.data'),
  get uploadDir() {
    return path.join(this.dataDir, 'uploads');
  },
  /** Hard limits */
  maxUploadMb: numeric('MAX_UPLOAD_MB', 8, { min: 1, max: 64 }),
  maxUploadFiles: 5,
  /** Request body cap (base64 payloads allowed but bounded) */
  jsonLimit: env.JSON_LIMIT ?? '6mb',
  rates: {
    // Configurable because the right ceiling depends on the deployment: a school lab behind one NAT
    // address needs far more headroom than a single classroom of laptops on separate connections.
    // Successful sign-ins are refunded (see rateLimit.ts), so this budget is really "failed attempts".
    auth: {
      windowMs: Number(env.AUTH_RATE_WINDOW_MS ?? 10 * 60_000),
      max: Number(env.AUTH_RATE_MAX ?? 60),
    },
    ai: { windowMs: 60_000, max: 40 },
    upload: { windowMs: 10 * 60_000, max: 40 },
    code: { windowMs: 60_000, max: 20 },
    general: { windowMs: 60_000, max: 300 },
  },
  /** Fallback-engine tuning */
  ai: {
    /** Max total attempts across keys/providers for a single logical request. */
    maxAttempts: Number(env.AI_MAX_ATTEMPTS ?? 8),
    /** Per-attempt request timeout (ms). */
    attemptTimeoutMs: Number(env.AI_ATTEMPT_TIMEOUT_MS ?? 45_000),
    /** How long a key is parked after a rate limit / server error. */
    cooldownRateLimitMs: Number(env.AI_COOLDOWN_RATE_LIMIT_MS ?? 60_000),
    cooldownServerErrorMs: Number(env.AI_COOLDOWN_SERVER_ERROR_MS ?? 20_000),
    /** A key that fails auth is parked much longer, but is never deleted. */
    cooldownAuthMs: Number(env.AI_COOLDOWN_AUTH_MS ?? 6 * 60 * 60_000),
    /** Delay between attempts so the client sees progress rather than a hang. */
    betweenAttemptsMs: Number(env.AI_BETWEEN_ATTEMPTS_MS ?? 250),
  },
  /**
   * Server-level allowance for the offline sample engine.
   *
   * This is a **cap**, not a default: the sample library answers only when the student's own setting
   * allows it *and* this is true. `DEMO_MODE=off` therefore guarantees that no sample content is ever
   * served, regardless of stored per-user settings. In production it is off unless explicitly enabled,
   * because sample answers must never be presented as model output to real students.
   */
  demoModeDefault: env.DEMO_MODE === 'on' || (env.DEMO_MODE !== 'off' && env.NODE_ENV !== 'production'),
  /**
   * Arena (competitive exams). The exam itself is server-controlled; these knobs tune how strictly
   * a paper is graded and how much of it must be approved before students may enter.
   */
  arena: {
    /**
     * Relative tolerance for numerical answers, as a percentage of the expected value
     * (ARENA_NUMERIC_TOLERANCE_PCT, default 1). A competition blueprint may override this.
     */
    numericTolerancePct: numeric('ARENA_NUMERIC_TOLERANCE_PCT', 1, { min: 0, max: 10 }),
    /** Tolerance used when the expected value is exactly 0 (a relative margin cannot express it). */
    numericToleranceAbs: numeric('ARENA_NUMERIC_TOLERANCE_ABS', 1e-9, { min: 0, max: 1 }),
    /**
     * Share of the blueprint's questions that must be approved (and none flagged/rejected) before a
     * competition can start. 1 = every question approved.
     */
    requiredApprovalRatio: numeric('ARENA_REQUIRED_APPROVAL_RATIO', 1, { min: 0.5, max: 1 }),
  },
  /** Code Lab execution sandbox */
  code: {
    enabled: env.CODE_RUN !== 'off',
    timeoutMs: Number(env.CODE_TIMEOUT_MS ?? 6000),
    maxOutputBytes: Number(env.CODE_MAX_OUTPUT_BYTES ?? 40_000),
    languages: ['javascript', 'python', 'html'] as const,
  },
  /** Optional shared secret required to reach the API (left empty by default). */
  apiAccessToken: env.API_ACCESS_TOKEN ?? '',
};

/* ------------------------------------------------------------------ */
/* Persisted server secrets                                            */
/* ------------------------------------------------------------------ */

const secretsFile = path.join(config.dataDir, 'server.secrets.json');

function loadOrCreateSecrets(): { jwtSecret: string; masterKey: string } {
  fs.mkdirSync(config.dataDir, { recursive: true, mode: 0o700 });
  let stored: { jwtSecret?: string; masterKey?: string } = {};
  if (fs.existsSync(secretsFile)) {
    try {
      stored = JSON.parse(fs.readFileSync(secretsFile, 'utf8'));
    } catch {
      stored = {};
    }
  }
  const jwtSecret = env.JWT_SECRET || stored.jwtSecret || crypto.randomBytes(48).toString('hex');
  const masterKey = env.VROQN_MASTER_KEY || stored.masterKey || crypto.randomBytes(32).toString('hex');

  if (!env.JWT_SECRET || !env.VROQN_MASTER_KEY) {
    const next = { jwtSecret, masterKey };
    fs.writeFileSync(secretsFile, JSON.stringify(next), { mode: 0o600 });
    try {
      fs.chmodSync(secretsFile, 0o600);
    } catch {
      /* best effort on exotic filesystems */
    }
  }
  return { jwtSecret, masterKey };
}

/**
 * Fail fast on a misconfigured deployment instead of silently generating throwaway secrets (which
 * would invalidate every session and make stored API keys undecryptable on restart).
 *
 * The master key format is checked in *every* environment, not only production. A malformed
 * `VROQN_MASTER_KEY` (a passphrase instead of 32 bytes of hex, say) produced a short AES key, and the
 * only symptom was a 500 the first time a student tried to save an AI key — a long way from the
 * cause. It now stops the process at boot with the reason.
 */
function assertProductionConfig(): void {
  const masterKeyProblem = 'VROQN_MASTER_KEY must be 64 hex characters (32 bytes) — generate one with `openssl rand -hex 32`';
  if (!isProd) {
    if (optional('VROQN_MASTER_KEY') && !/^[0-9a-fA-F]{64}$/.test(optional('VROQN_MASTER_KEY')!)) {
      throw new Error(`Refusing to start: ${masterKeyProblem}.`);
    }
    if (MASTER_KEY.length !== 32) {
      throw new Error(`Refusing to start: the encryption key is ${MASTER_KEY.length} bytes, not 32.`);
    }
    return;
  }
  const problems: string[] = [];
  if (!optional('JWT_SECRET')) problems.push('JWT_SECRET is required in production (sessions would reset on every restart)');
  if (!optional('VROQN_MASTER_KEY')) problems.push('VROQN_MASTER_KEY is required in production (stored API keys would become unreadable)');
  if (optional('VROQN_MASTER_KEY') && !/^[0-9a-fA-F]{64}$/.test(optional('VROQN_MASTER_KEY')!)) {
    problems.push(masterKeyProblem);
  }
  if (optional('JWT_SECRET') && optional('JWT_SECRET')!.length < 32) problems.push('JWT_SECRET must be at least 32 characters');
  if (!config.databaseUrl && env.ALLOW_SQLITE_IN_PROD !== '1') {
    problems.push('DATABASE_URL is required in production (set ALLOW_SQLITE_IN_PROD=1 only for a single-instance demo)');
  }
  if (optional('DEMO_MODE') === 'on') problems.push('DEMO_MODE=on in production serves sample content to real students');

  for (const problem of problems) console.error(`[config] ${problem}`);
  if (problems.length) {
    throw new Error(`Refusing to start: ${problems.length} production configuration problem(s).`);
  }
}

/** Called once during bootstrap so a bad deployment fails loudly, not halfway through a request. */
export function assertConfig(): void {
  assertProductionConfig();
}

const secrets = loadOrCreateSecrets();
export const JWT_SECRET = secrets.jwtSecret;
/** 32-byte AES-256-GCM key used to encrypt user API keys at rest. */
export const MASTER_KEY = Buffer.from(secrets.masterKey, 'hex').subarray(0, 32);

export const COOKIE_NAME = isProd ? '__Host-vroqn_session' : 'vroqn_session';

/**
 * Presence of real provider credentials — surfaced in the UI so nothing pretends to work.
 */
export function describeRuntime(): Record<string, string | boolean> {
  return {
    env: config.nodeEnv,
    database: config.databaseUrl ? 'postgres' : 'sqlite',
    demoModeAllowed: config.demoModeDefault,
    codeLab: config.code.enabled ? 'enabled' : 'disabled',
  };
}
