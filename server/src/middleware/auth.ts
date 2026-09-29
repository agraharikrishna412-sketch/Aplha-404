/**
 * Session handling.
 * - Passwords are hashed with scrypt (see services/crypto).
 * - Sessions are signed JWTs delivered in an httpOnly, SameSite=Lax cookie.
 * - Bearer tokens are also accepted so the API can be used from tools/tests.
 * - Nothing about the student beyond name/email/class is stored.
 */
import type { NextFunction, Request, Response } from 'express';
import jwt from 'jsonwebtoken';
import { COOKIE_NAME, JWT_SECRET, config } from '../config/env.js';
import * as db from '../db/index.js';

export type UserRole = 'student' | 'admin';

export interface SessionUser {
  id: string;
  email: string;
  name: string;
  role: UserRole;
}

declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request {
      user?: SessionUser;
    }
  }
}

const SESSION_DAYS = 30;

export function signSession(user: SessionUser): string {
  return jwt.sign({ sub: user.id, email: user.email, name: user.name }, JWT_SECRET, {
    expiresIn: `${SESSION_DAYS}d`,
    issuer: 'vroqn-nexus',
  });
}

export function setSessionCookie(res: Response, token: string): void {
  res.cookie(COOKIE_NAME, token, {
    httpOnly: true,
    sameSite: 'lax',
    secure: config.isProd,
    path: '/',
    maxAge: SESSION_DAYS * 86_400_000,
  });
}

export function clearSessionCookie(res: Response): void {
  res.clearCookie(COOKIE_NAME, { path: '/' });
}

function tokenFrom(req: Request): string | null {
  const header = req.headers.authorization;
  if (header?.startsWith('Bearer ')) return header.slice(7).trim();
  const cookie = (req.cookies as Record<string, string> | undefined)?.[COOKIE_NAME];
  return cookie ?? null;
}

export async function resolveUser(req: Request): Promise<SessionUser | null> {
  const token = tokenFrom(req);
  if (!token) return null;
  try {
    const payload = jwt.verify(token, JWT_SECRET) as jwt.JwtPayload;
    const id = String(payload.sub ?? '');
    if (!id) return null;
    const row = await db.one<{ id: string; email: string; name: string; role: string | null }>(
      'SELECT id, email, name, role FROM users WHERE id = ?',
      [id],
    );
    if (!row) return null;
    // Admins are either flagged in the database or listed in ARENA_ADMIN_EMAILS (bootstrap path).
    const allowlist = (process.env.ARENA_ADMIN_EMAILS ?? '')
      .split(',')
      .map((value) => value.trim().toLowerCase())
      .filter(Boolean);
    const role: UserRole =
      row.role === 'admin' || allowlist.includes(row.email.toLowerCase()) ? 'admin' : 'student';
    return { id: row.id, email: row.email, name: row.name, role };
  } catch {
    return null;
  }
}

export async function attachUser(req: Request, _res: Response, next: NextFunction): Promise<void> {
  req.user = (await resolveUser(req)) ?? undefined;
  next();
}

export function requireAuth(req: Request, res: Response, next: NextFunction): void {
  if (!req.user) {
    res.status(401).json({ error: { message: 'Please sign in to continue.', code: 'unauthenticated' } });
    return;
  }
  next();
}

/**
 * Competition creation and publication are restricted (spec: minimal admin surface).
 * Students may take competitions; only admins may author or publish them.
 */
export function requireAdmin(req: Request, res: Response, next: NextFunction): void {
  if (!req.user) {
    res.status(401).json({ error: { message: 'Please sign in to continue.', code: 'unauthenticated' } });
    return;
  }
  if (req.user.role !== 'admin') {
    res.status(403).json({
      error: {
        message: 'Competition authoring is restricted to Vroqn staff accounts.',
        code: 'forbidden',
      },
    });
    return;
  }
  next();
}

export function isAdmin(user: SessionUser | undefined | null): boolean {
  return user?.role === 'admin';
}
