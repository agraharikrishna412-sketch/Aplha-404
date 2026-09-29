/** Email + password authentication (optional Google sign-in is a later phase). */
import { Router } from 'express';
import { z } from 'zod';
import * as db from '../db/index.js';
import { nowIso, uuid } from '../db/index.js';
import { hashPassword, verifyPassword } from '../services/crypto.js';
import { asyncRoute, HttpError, parseBody } from '../middleware/errors.js';
import { deleteAccount, previewDeletion } from '../services/account.js';
import {
  clearSessionCookie,
  requireAuth,
  setSessionCookie,
  signSession,
  type SessionUser,
  type UserRole,
} from '../middleware/auth.js';
import { limits } from '../middleware/rateLimit.js';
import { DEFAULT_SETTINGS } from '../types/domain.js';

export const authRouter = Router();

const signupSchema = z.object({
  name: z.string().trim().min(2, 'Please enter your name.').max(60, 'That name is too long.'),
  email: z.string().trim().toLowerCase().email('Please enter a valid email address.'),
  password: z
    .string()
    .min(8, 'Use at least 8 characters.')
    .max(200, 'That password is too long.')
    .refine((v) => /[a-zA-Z]/.test(v) && /[0-9]/.test(v), 'Include at least one letter and one number.'),
  classLevel: z.string().trim().max(20).optional(),
  board: z.string().trim().max(40).optional(),
});

const loginSchema = z.object({
  email: z.string().trim().toLowerCase().email('Please enter a valid email address.'),
  password: z.string().min(1, 'Please enter your password.'),
});

interface UserRow {
  id: string;
  email: string;
  name: string;
  class_level: string | null;
  board: string | null;
  password_hash: string;
  role?: string | null;
}

/** Bootstrap path for the first admin: list staff emails in ARENA_ADMIN_EMAILS. */
function roleFor(email: string, stored?: string | null): UserRole {
  if (stored === 'admin') return 'admin';
  const allowlist = (process.env.ARENA_ADMIN_EMAILS ?? '')
    .split(',')
    .map((value) => value.trim().toLowerCase())
    .filter(Boolean);
  return allowlist.includes(email.toLowerCase()) ? 'admin' : 'student';
}

function publicUser(row: UserRow): SessionUser & { classLevel: string | null; board: string | null } {
  return {
    id: row.id,
    email: row.email,
    name: row.name,
    role: roleFor(row.email, row.role),
    classLevel: row.class_level,
    board: row.board,
  };
}

authRouter.post(
  '/signup',
  limits.auth(),
  asyncRoute(async (req, res) => {
    const body = parseBody(signupSchema, req.body);
    const existing = await db.one<{ id: string }>('SELECT id FROM users WHERE email = ?', [body.email]);
    if (existing) throw new HttpError(409, 'That email is already registered. Try signing in.', 'email_taken');

    const id = uuid();
    const now = nowIso();
    await db.run(
      `INSERT INTO users (id, email, name, class_level, board, password_hash, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        id,
        body.email,
        body.name,
        body.classLevel ?? null,
        body.board ?? null,
        hashPassword(body.password),
        now,
        now,
      ],
    );
    await db.run(
      `INSERT INTO user_settings (user_id, data, updated_at) VALUES (?, ?, ?)
       ON CONFLICT (user_id) DO UPDATE SET data = excluded.data, updated_at = excluded.updated_at`,
      [id, JSON.stringify(DEFAULT_SETTINGS), now],
    );

    const user: SessionUser = { id, email: body.email, name: body.name, role: 'student' };
    setSessionCookie(res, signSession(user));
    res.status(201).json({
      user: { ...user, classLevel: body.classLevel ?? null, board: body.board ?? null },
    });
  }),
);

authRouter.post(
  '/login',
  limits.auth(),
  asyncRoute(async (req, res) => {
    const body = parseBody(loginSchema, req.body);
    const row = await db.one<UserRow>('SELECT * FROM users WHERE email = ?', [body.email]);
    // Constant-ish response regardless of which half is wrong.
    if (!row || !verifyPassword(body.password, row.password_hash)) {
      throw new HttpError(401, 'Email or password is incorrect.', 'invalid_credentials');
    }
    const user: SessionUser = { id: row.id, email: row.email, name: row.name, role: roleFor(row.email, row.role) };
    setSessionCookie(res, signSession(user));
    res.json({ user: publicUser(row) });
  }),
);

authRouter.post('/logout', (_req, res) => {
  clearSessionCookie(res);
  res.json({ ok: true });
});

authRouter.get(
  '/me',
  asyncRoute(async (req, res) => {
    if (!req.user) {
      res.json({ user: null });
      return;
    }
    const row = await db.one<UserRow>('SELECT * FROM users WHERE id = ?', [req.user.id]);
    res.json({ user: row ? publicUser(row) : null });
  }),
);

const updateSchema = z.object({
  name: z.string().trim().min(2).max(60).optional(),
  classLevel: z.string().trim().max(20).nullable().optional(),
  board: z.string().trim().max(40).nullable().optional(),
});

authRouter.patch(
  '/me',
  requireAuth,
  asyncRoute(async (req, res) => {
    const body = parseBody(updateSchema, req.body);
    const current = await db.one<UserRow>('SELECT * FROM users WHERE id = ?', [req.user!.id]);
    if (!current) throw new HttpError(404, 'Account not found.');
    await db.run('UPDATE users SET name = ?, class_level = ?, board = ?, updated_at = ? WHERE id = ?', [
      body.name ?? current.name,
      body.classLevel === undefined ? current.class_level : body.classLevel,
      body.board === undefined ? current.board : body.board,
      nowIso(),
      req.user!.id,
    ]);
    const updated = await db.one<UserRow>('SELECT * FROM users WHERE id = ?', [req.user!.id]);
    res.json({ user: publicUser(updated!) });
  }),
);
/**
 * What deleting this account would remove.
 *
 * A read-only preview so the Settings screen can tell the student exactly what disappears *before*
 * they type their password — including the list of communities that would block the deletion because
 * other students are still in them.
 */
authRouter.get(
  '/deletion-preview',
  requireAuth,
  asyncRoute(async (req, res) => {
    res.json(await previewDeletion(req.user!.id));
  }),
);

const deleteAccountSchema = z.object({
  /** Re-entering the password is what makes a stolen session insufficient to destroy an account. */
  password: z.string().min(1, 'Enter your password to confirm.'),
  /** Typed by hand. A single mis-tap should never be able to end an account. */
  confirm: z.literal('DELETE', { errorMap: () => ({ message: 'Type DELETE to confirm.' }) }),
});

authRouter.post(
  '/delete-account',
  requireAuth,
  limits.auth(),
  asyncRoute(async (req, res) => {
    const body = parseBody(deleteAccountSchema, req.body);
    const result = await deleteAccount({ userId: req.user!.id, password: body.password });
    clearSessionCookie(res);
    res.json({ ok: true, ...result });
  }),
);

