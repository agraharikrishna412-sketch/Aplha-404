/**
 * Code Lab service — run student code in a restricted child process and review it with AI.
 *
 * Sandbox notes (see docs/SECURITY.md):
 *  - Code runs in a throwaway temp directory with a stripped environment (no app secrets are
 *    inherited), a hard wall-clock timeout and a hard output cap.
 *  - This is a *prototype* sandbox: a production deployment should run each submission inside a
 *    container/gVisor micro-VM with a read-only rootfs and no network. Set CODE_RUN=off to disable
 *    execution entirely (the editor and AI review keep working).
 */
import { spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import * as db from '../db/index.js';
import { nowIso, uuid } from '../db/index.js';
import { config } from '../config/env.js';
import { complete, completeJson } from './ai/router.js';
import { codeSystem } from './ai/prompts.js';
import { promptContextFor } from './tutor.js';
import { recordActivity } from './activity.js';
import type { CodeSession } from '../types/domain.js';

export const LANGUAGES = [
  { id: 'javascript', label: 'JavaScript (Node)', runnable: true, preview: false, extension: 'mjs' },
  { id: 'python', label: 'Python 3', runnable: true, preview: false, extension: 'py' },
  { id: 'html', label: 'HTML + CSS + JS', runnable: false, preview: true, extension: 'html' },
] as const;

export type LanguageId = (typeof LANGUAGES)[number]['id'];

export function isLanguage(value: string): value is LanguageId {
  return LANGUAGES.some((l) => l.id === value);
}

export interface RunResult {
  ok: boolean;
  mode: 'run' | 'preview' | 'disabled';
  stdout: string;
  stderr: string;
  exitCode: number | null;
  durationMs: number;
  timedOut: boolean;
  message?: string;
}

const JS_BANNER = `// Vroqn Nexus Code Lab — runs as a Node ESM module.
// console.log() output appears in the Output panel. Top-level await is supported.
`;

async function runProcess(args: {
  command: string;
  args: string[];
  cwd: string;
  timeoutMs: number;
  stdin?: string;
}): Promise<{ stdout: string; stderr: string; exitCode: number | null; timedOut: boolean; durationMs: number }> {
  const startedAt = Date.now();
  return new Promise((resolve) => {
    const child = spawn(args.command, args.args, {
      cwd: args.cwd,
      // Deliberately minimal env: no DATABASE_URL, JWT_SECRET or master key is inherited.
      env: { PATH: process.env.PATH ?? '/usr/bin:/bin', LANG: 'C.UTF-8', NODE_OPTIONS: '' },
      stdio: ['pipe', 'pipe', 'pipe'],
    });

    let stdout = '';
    let stderr = '';
    let timedOut = false;
    let settled = false;

    const cap = config.code.maxOutputBytes;
    const killTimer = setTimeout(() => {
      timedOut = true;
      child.kill('SIGKILL');
    }, args.timeoutMs);

    child.stdout.on('data', (chunk: Buffer) => {
      if (stdout.length < cap) stdout += chunk.toString('utf8');
    });
    child.stderr.on('data', (chunk: Buffer) => {
      if (stderr.length < cap) stderr += chunk.toString('utf8');
    });
    child.on('error', (err) => {
      if (settled) return;
      settled = true;
      clearTimeout(killTimer);
      resolve({
        stdout,
        stderr: `${stderr}${err.message}`,
        exitCode: null,
        timedOut,
        durationMs: Date.now() - startedAt,
      });
    });
    child.on('close', (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(killTimer);
      resolve({ stdout, stderr, exitCode: code, timedOut, durationMs: Date.now() - startedAt });
    });

    if (args.stdin !== undefined) {
      child.stdin.write(args.stdin);
    }
    child.stdin.end();
  });
}

export async function runCode(args: { language: LanguageId; code: string }): Promise<RunResult> {
  if (!config.code.enabled) {
    return {
      ok: false,
      mode: 'disabled',
      stdout: '',
      stderr: '',
      exitCode: null,
      durationMs: 0,
      timedOut: false,
      message: 'Code execution is turned off on this server (CODE_RUN=off). AI review still works.',
    };
  }
  if (args.language === 'html') {
    return {
      ok: true,
      mode: 'preview',
      stdout: '',
      stderr: '',
      exitCode: 0,
      durationMs: 0,
      timedOut: false,
      message: 'Web code runs in the live preview panel.',
    };
  }

  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'vroqn-run-'));
  const file = path.join(dir, args.language === 'python' ? 'main.py' : 'main.mjs');
  const body = args.language === 'javascript' ? `${JS_BANNER}\n${args.code}` : args.code;
  await fs.writeFile(file, body, 'utf8');

  try {
    const result =
      args.language === 'python'
        ? await runProcess({
            command: process.env.PYTHON_BIN ?? 'python3',
            args: ['-I', '-B', file],
            cwd: dir,
            timeoutMs: config.code.timeoutMs,
          })
        : await runProcess({
            command: process.execPath,
            args: ['--no-warnings', '--max-old-space-size=256', file],
            cwd: dir,
            timeoutMs: config.code.timeoutMs,
          });

    const cap = config.code.maxOutputBytes;
    const trim = (s: string) => (s.length > cap ? `${s.slice(0, cap)}\n… output truncated` : s);
    const stdout = trim(result.stdout);
    const stderr = trim(result.stderr);

    return {
      ok: result.exitCode === 0 && !result.timedOut,
      mode: 'run',
      stdout,
      stderr: result.timedOut
        ? `${stderr}${stderr ? '\n' : ''}Execution stopped after ${config.code.timeoutMs / 1000}s (possible infinite loop).`
        : stderr,
      exitCode: result.exitCode,
      durationMs: result.durationMs,
      timedOut: result.timedOut,
      message: result.timedOut ? 'Timed out — check for infinite loops.' : undefined,
    };
  } catch (err) {
    return {
      ok: false,
      mode: 'run',
      stdout: '',
      stderr: err instanceof Error ? err.message : 'Runtime failed to start.',
      exitCode: null,
      durationMs: 0,
      timedOut: false,
    };
  } finally {
    await fs.rm(dir, { recursive: true, force: true }).catch(() => undefined);
  }
}

/* ------------------------------- sessions -------------------------------- */

interface SessionRow {
  id: string;
  title: string;
  language: string;
  code: string;
  last_output: string | null;
  created_at: string;
  updated_at: string;
}

function toSession(row: SessionRow): CodeSession {
  return {
    id: row.id,
    title: row.title,
    language: row.language,
    code: row.code,
    lastOutput: row.last_output,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export async function listSessions(userId: string, limit = 30): Promise<CodeSession[]> {
  const rows = await db.all<SessionRow>(
    'SELECT * FROM code_sessions WHERE user_id = ? ORDER BY updated_at DESC LIMIT ?',
    [userId, limit],
  );
  return rows.map(toSession);
}

export async function saveSession(
  userId: string,
  args: { id?: string; title?: string; language: string; code: string; lastOutput?: string },
): Promise<CodeSession> {
  const now = nowIso();
  if (args.id) {
    const existing = await db.one<SessionRow>('SELECT * FROM code_sessions WHERE id = ? AND user_id = ?', [args.id, userId]);
    if (existing) {
      await db.run(
        'UPDATE code_sessions SET title = ?, language = ?, code = ?, last_output = ?, updated_at = ? WHERE id = ? AND user_id = ?',
        [
          (args.title ?? existing.title).slice(0, 120),
          args.language,
          args.code,
          (args.lastOutput ?? existing.last_output ?? '').slice(0, 8000),
          now,
          args.id,
          userId,
        ],
      );
      const updated = await db.one<SessionRow>('SELECT * FROM code_sessions WHERE id = ?', [args.id]);
      return toSession(updated!);
    }
  }
  const id = uuid();
  await db.run(
    'INSERT INTO code_sessions (id, user_id, title, language, code, last_output, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
    [
      id,
      userId,
      (args.title ?? 'Untitled snippet').slice(0, 120),
      args.language,
      args.code,
      (args.lastOutput ?? '').slice(0, 8000),
      now,
      now,
    ],
  );
  const created = await db.one<SessionRow>('SELECT * FROM code_sessions WHERE id = ?', [id]);
  return toSession(created!);
}

export async function deleteSession(userId: string, id: string): Promise<void> {
  await db.run('DELETE FROM code_sessions WHERE id = ? AND user_id = ?', [id, userId]);
}

export async function recordCodeRun(args: { userId: string; language: string; ok: boolean; durationMs: number }): Promise<void> {
  await recordActivity({
    userId: args.userId,
    kind: 'code',
    subject: 'Computer Science',
    topic: args.language,
    durationMs: Math.max(args.durationMs, 30_000),
    label: `Ran ${args.language} code (${args.ok ? 'ran fine' : 'had errors'})`,
    meta: { language: args.language, ok: args.ok },
  });
}

/* --------------------------------- AI ------------------------------------ */

export type CodeMode = 'review' | 'explain' | 'bugs' | 'improve' | 'ask' | 'build';

export interface CodeReviewPayload {
  summary?: string;
  rating?: number;
  issues?: { severity?: string; title?: string; detail?: string; fix?: string }[];
  improvements?: string[];
  reviewComments?: string[];
}

const JSON_MODES: CodeMode[] = ['review', 'bugs', 'improve'];

export async function codeAssist(args: {
  userId: string;
  mode: CodeMode;
  language: string;
  code: string;
  question?: string;
  output?: string;
  /**
   * Earlier turns of this Code Lab conversation.
   *
   * Without them, a follow-up like "iska matlab kya hai?" arrived at the model with no referent, so the
   * mentor answered something generic and the student concluded it had not understood them. Only the
   * last few turns are sent, and each is truncated — the editor contents already carry the state.
   */
  history?: { role: 'user' | 'assistant'; content: string }[];
}): Promise<{ text?: string; review?: CodeReviewPayload; provider?: string; model?: string; demo?: boolean; degraded?: string }> {
  const ctx = await promptContextFor(args.userId, 'Computer Science');
  const system = codeSystem(ctx, args.mode);
  const wantsJson = JSON_MODES.includes(args.mode);

  const userContent = [
    `Language: ${args.language}`,
    args.question ? `Student question: ${args.question}` : '',
    args.output?.trim() ? `Last program output:\n${args.output.slice(0, 1500)}` : '',
    'Code:',
    '```' + (args.language === 'python' ? 'python' : args.language === 'html' ? 'html' : 'javascript'),
    args.code.slice(0, 12_000),
    '```',
    wantsJson ? 'Respond with the JSON described in your instructions only.' : '',
  ]
    .filter(Boolean)
    .join('\n');

  /*
   * Conversation memory for the free-form modes only. Structured modes (review / bugs / improve)
   * return JSON that the UI renders as a panel, so earlier prose would only add noise and tokens.
   */
  const earlier = (args.history ?? [])
    .filter((turn) => turn && typeof turn.content === 'string' && turn.content.trim())
    .slice(-6)
    .map((turn) => ({ role: turn.role, content: turn.content.slice(0, 2500) }));
  const conversation = !wantsJson && earlier.length ? earlier : [];

  try {
    if (wantsJson) {
      const { data, summary } = await completeJson<CodeReviewPayload>({
        userId: args.userId,
        task: 'coding',
        system,
        messages: [...conversation, { role: 'user' as const, content: userContent }],
        temperature: 0.3,
        maxTokens: 1600,
      });
      return {
        review: {
          summary: String(data.summary ?? '').trim(),
          rating: Number(data.rating ?? 0) || undefined,
          issues: Array.isArray(data.issues)
            ? data.issues
                .map((i) => ({
                  severity: ['error', 'warning', 'info'].includes(String(i.severity)) ? String(i.severity) : 'info',
                  title: String(i.title ?? '').slice(0, 120),
                  detail: String(i.detail ?? '').slice(0, 600),
                  fix: i.fix ? String(i.fix).slice(0, 800) : undefined,
                }))
                .filter((i) => i.title || i.detail)
                .slice(0, 12)
            : [],
          improvements: Array.isArray(data.improvements) ? data.improvements.map(String).slice(0, 8) : [],
          reviewComments: Array.isArray(data.reviewComments) ? data.reviewComments.map(String).slice(0, 12) : [],
        },
        // Sample output is labelled as sample, never attributed to a provider that did not run.
        provider: summary.demo ? 'sample' : summary.provider,
        model: summary.demo ? 'vroqn-sample' : summary.model,
        demo: summary.demo,
        degraded: summary.demo ? 'Sample review (no AI key connected yet).' : undefined,
      };
    }

    const summary = await complete({
      userId: args.userId,
      task: 'coding',
      system,
      messages: [...conversation, { role: 'user' as const, content: userContent }],
      temperature: 0.4,
      maxTokens: 1800,
    });
    if (summary.error) throw new Error(summary.error.message);
    return {
      text: summary.text,
      provider: summary.demo ? 'sample' : summary.provider,
      model: summary.demo ? 'vroqn-sample' : summary.model,
      demo: summary.demo,
      degraded: summary.demo ? 'Sample explanation (no AI key connected yet).' : undefined,
    };
  } catch (err) {
    return {
      text:
        args.mode === 'explain'
          ? '## Code explanation unavailable\nNo AI connection is reachable right now. Your code still runs in the Output panel — add or test a key in **AI Settings** to get a full walkthrough.'
          : undefined,
      review: wantsJson
        ? {
            summary: 'AI review is unavailable right now — the program still runs, and you can retry the review in a moment.',
            issues: [],
            improvements: [],
            reviewComments: [],
          }
        : undefined,
      degraded: err instanceof Error ? err.message : 'AI review unavailable.',
    };
  }
}

export const STARTERS: Record<LanguageId, string> = {
  javascript: `// Try the Code Lab starter: sum of first n numbers
function sumTo(n) {
  let total = 0;
  for (let i = 1; i <= n; i++) total += i;
  return total;
}

console.log("sumTo(10) =", sumTo(10));

// TODO: print the sum of even numbers from 1 to 20`,
  python: `# Try the Code Lab starter: average of a list
marks = [42, 78, 91, 65, 55]

def average(values):
    return sum(values) / len(values)

print("Average marks:", average(marks))

# TODO: print the highest mark and how far it is from the average`,
  html: `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>My mini project</title>
    <style>
      body { font-family: system-ui, sans-serif; background:#0b1218; color:#e8f6ff; display:grid; place-items:center; min-height:100vh; margin:0 }
      .card { border:1px solid #1d3644; border-radius:14px; padding:24px; text-align:center; background:#0f1a22 }
      button { background:#00e5ff; border:0; padding:10px 16px; border-radius:10px; font-weight:700; cursor:pointer }
    </style>
  </head>
  <body>
    <div class="card">
      <h1 id="title">Hello, Nexus</h1>
      <p>Edit the code and press Preview to refresh.</p>
      <button id="go">Click me</button>
    </div>
    <script>
      let count = 0;
      document.getElementById('go').addEventListener('click', () => {
        count += 1;
        document.getElementById('title').textContent = 'Clicked ' + count + ' times';
      });
    </script>
  </body>
</html>`,
};
