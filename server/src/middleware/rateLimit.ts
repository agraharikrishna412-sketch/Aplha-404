/**
 * Small in-memory rate limiter.
 * Protects auth, AI and upload endpoints from accidental loops and abuse (spec §27).
 * For multi-instance deployments, swap the Map for Redis — the interface stays the same.
 */
import type { NextFunction, Request, Response } from 'express';
import { config } from '../config/env.js';

interface Bucket {
  count: number;
  resetAt: number;
}

const buckets = new Map<string, Bucket>();

setInterval(() => {
  const now = Date.now();
  for (const [key, bucket] of buckets) if (bucket.resetAt <= now) buckets.delete(key);
}, 60_000).unref();

export interface RateLimitOptions {
  windowMs: number;
  max: number;
  keyPrefix: string;
  /** Identify by user id when signed in, otherwise by IP. */
  byUser?: boolean;
  /**
   * Give the slot back when the request succeeds.
   *
   * Sign-in and sign-up are keyed by IP, which is the right choice for blocking credential stuffing —
   * but it also means every *legitimate* sign-in from one address spends the same budget. A school
   * computer lab sits behind a single NAT address, so 30 students signing in within ten minutes used
   * to lock out the 31st for the rest of the window. A successful attempt is not abuse, so it is
   * refunded; a failed one still counts and still triggers the lockout.
   */
  refundOnSuccess?: boolean;
}

export function rateLimit(options: RateLimitOptions) {
  return (req: Request, res: Response, next: NextFunction): void => {
    const identity = options.byUser && req.user?.id ? `u:${req.user.id}` : `ip:${req.ip ?? 'unknown'}`;
    const key = `${options.keyPrefix}:${identity}`;
    const now = Date.now();
    let bucket = buckets.get(key);

    if (!bucket || bucket.resetAt <= now) {
      bucket = { count: 0, resetAt: now + options.windowMs };
      buckets.set(key, bucket);
    }

    // Registered before any early return, so the very first request of a window is refunded too —
    // otherwise the first successful sign-in would permanently cost one slot.
    if (options.refundOnSuccess) {
      res.on('finish', () => {
        // Only a 2xx is refunded: a wrong password still spends budget.
        if (res.statusCode >= 200 && res.statusCode < 300) {
          const current = buckets.get(key);
          if (current && current.count > 0) current.count -= 1;
        }
      });
    }

    bucket.count += 1;
    const remaining = Math.max(0, options.max - bucket.count);
    res.setHeader('X-RateLimit-Remaining', String(remaining));
    if (bucket.count > options.max) {
      const retryAfter = Math.ceil((bucket.resetAt - now) / 1000);
      res.setHeader('Retry-After', String(retryAfter));
      res.status(429).json({
        error: {
          message: `Too many requests. Try again in ${retryAfter}s.`,
          code: 'rate_limited',
        },
      });
      return;
    }
    next();
  };
}

export function resetRateLimits(): void {
  buckets.clear();
}

export const limits = {
  // Refunded on success: see `refundOnSuccess` — a shared school network must not lock itself out.
  auth: () => rateLimit({ ...config.rates.auth, keyPrefix: 'auth', refundOnSuccess: true }),
  ai: () => rateLimit({ ...config.rates.ai, keyPrefix: 'ai', byUser: true }),
  upload: () => rateLimit({ ...config.rates.upload, keyPrefix: 'upload', byUser: true }),
  code: () => rateLimit({ ...config.rates.code, keyPrefix: 'code', byUser: true }),
  /*
   * Community posting: chat, doubts, answers, resources, polls, announcements.
   *
   * Deliberately its own bucket so a fast-moving chat cannot spend the budget a student needs for
   * the AI tutor, and so a spammer is stopped here rather than by the general limiter. It is a
   * *write* limit only - reading a community is never rate limited beyond the general bucket (§7).
   *
   * 60 writes a minute is roughly one per second sustained, which no student typing by hand reaches
   * but a runaway script or a copy-paste flood does. Structural creation (challenges, plans, events,
   * competitions) shares this bucket on purpose: a community owner setting one up does a dozen of
   * those in a minute, and a single clear limit is easier to reason about than two overlapping ones.
   */
  chat: () => rateLimit({ windowMs: 60_000, max: 60, keyPrefix: 'chat', byUser: true }),
  /*
   * Exam integrity signals. The Arena runner batches its observations every few seconds, so the bucket
   * is roomier than chat but still finite: a client that decides to spam the endpoint is throttled
   * without ever being able to interrupt the paper itself, because signals never gate answering.
   */
  proctor: () => rateLimit({ windowMs: 60_000, max: 120, keyPrefix: 'proctor', byUser: true }),
  general: () => rateLimit({ ...config.rates.general, keyPrefix: 'general', byUser: true }),
};
