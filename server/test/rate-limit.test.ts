/**
 * Auth rate-limiting behaviour.
 *
 * The limiter is keyed by IP, which is correct for blocking credential stuffing — but every
 * *successful* sign-in used to spend the same budget as a failed one. A school computer lab sits
 * behind a single NAT address, so 30 students signing in within ten minutes locked out the 31st for
 * the rest of the window. That is a realistic way for this product to fail on the network it is
 * built for.
 *
 * The rule now: a failed attempt counts, a successful one is refunded.
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

process.env.JWT_SECRET = 'rate-limit-test-secret-not-used-for-real';
process.env.VROQN_MASTER_KEY = 'd'.repeat(64);
process.env.AUTH_RATE_MAX = '3';
process.env.AUTH_RATE_WINDOW_MS = '60000';

const { limits, resetRateLimits } = await import('../src/middleware/rateLimit.js');

interface MockResponse {
  statusCode: number;
  headers: Record<string, string>;
  body?: unknown;
  setHeader(name: string, value: string): void;
  status(code: number): MockResponse;
  json(payload: unknown): MockResponse;
  on(event: string, handler: () => void): void;
}

/** Minimal Express response double: enough for the limiter and its `finish` refund hook. */
function makeRes(): MockResponse & { finish(): void } {
  const handlers: Record<string, (() => void)[]> = {};
  return {
    statusCode: 200,
    headers: {},
    setHeader(name, value) {
      this.headers[name] = value;
    },
    status(code) {
      this.statusCode = code;
      return this;
    },
    json(payload) {
      this.body = payload;
      return this;
    },
    on(event, handler) {
      (handlers[event] ??= []).push(handler);
    },
    finish() {
      for (const handler of handlers.finish ?? []) handler();
    },
  };
}

function makeReq(ip = '203.0.113.7') {
  return { ip } as never;
}

/** Runs one request through the limiter and reports whether it was allowed (or 429'd). */
function attempt(handler: ReturnType<typeof limits.auth>, outcome: 'success' | 'failure', ip?: string) {
  const res = makeRes();
  let allowed = false;
  handler(makeReq(ip), res as never, () => {
    allowed = true;
  });
  if (!allowed) return { allowed, status: res.statusCode };
  res.statusCode = outcome === 'success' ? 200 : 401;
  res.finish();
  return { allowed, status: res.statusCode };
}

describe('auth limiter refunds successful attempts', () => {
  it('lets a whole lab sign in from one shared address', () => {
    resetRateLimits();
    const handler = limits.auth();
    // Ten times the limit, all succeeding: a NAT'd classroom must never lock itself out.
    for (let i = 0; i < 30; i += 1) {
      const result = attempt(handler, 'success');
      assert.equal(result.allowed, true, `sign-in ${i + 1} was rejected despite succeeding`);
    }
  });

  it('still locks out after repeated failures', () => {
    resetRateLimits();
    const handler = limits.auth();

    for (let i = 0; i < 3; i += 1) {
      assert.equal(attempt(handler, 'failure').allowed, true, `failure ${i + 1} should be allowed`);
    }

    const blocked = attempt(handler, 'failure');
    assert.equal(blocked.allowed, false, 'the limiter must engage once the failure budget is spent');
    assert.equal(blocked.status, 429);
  });

  it('keeps the failure budget separate from successful traffic', () => {
    resetRateLimits();
    const handler = limits.auth();

    // A student signs in successfully, then an attacker guesses from the same address.
    assert.equal(attempt(handler, 'success').allowed, true);
    assert.equal(attempt(handler, 'failure').allowed, true, 'the failed guess still counted');
    assert.equal(attempt(handler, 'failure').allowed, true);
    assert.equal(attempt(handler, 'failure').allowed, true);
    assert.equal(
      attempt(handler, 'failure').allowed,
      false,
      'the success did not consume budget, but the failures did',
    );
  });

  it('tracks addresses independently', () => {
    resetRateLimits();
    const handler = limits.auth();
    for (let i = 0; i < 4; i += 1) attempt(handler, 'failure', '198.51.100.9');

    assert.equal(
      attempt(handler, 'failure', '198.51.100.9').allowed,
      false,
      'the offending address is blocked',
    );
    assert.equal(
      attempt(handler, 'success', '203.0.113.50').allowed,
      true,
      'an unrelated address is unaffected',
    );
  });
});
