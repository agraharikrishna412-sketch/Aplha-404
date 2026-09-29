/** Failure taxonomy (spec §13): classification and retry policy per failure kind. */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { AIError, FAILURE_POLICY, classifyHttpFailure, classifyTransportFailure } from '../src/services/ai/errors.js';

describe('HTTP failure classification', () => {
  it('separates rate limits from exhausted daily quota', () => {
    assert.equal(classifyHttpFailure('gemini', 429, { error: { message: 'Resource has been exhausted' } }).kind, 'rate_limit');
    assert.equal(
      classifyHttpFailure('gemini', 429, { error: { message: 'You exceeded your current quota, per day limit reached' } }).kind,
      'quota_exhausted',
    );
  });

  it('separates invalid keys from other auth failures', () => {
    assert.equal(classifyHttpFailure('groq', 401, { error: { message: 'Invalid API Key' } }).kind, 'invalid_key');
    assert.equal(classifyHttpFailure('openrouter', 403, { error: { message: 'Forbidden' } }).kind, 'auth');
  });

  it('detects model, timeout, server and provider failures', () => {
    assert.equal(classifyHttpFailure('gemini', 404, { error: { message: 'model not found' } }).kind, 'model_unavailable');
    assert.equal(classifyHttpFailure('groq', 504, {}).kind, 'timeout');
    assert.equal(classifyHttpFailure('groq', 500, { error: { message: 'internal error' } }).kind, 'server_error');
    assert.equal(
      classifyHttpFailure('groq', 503, { error: { message: 'The model is overloaded' } }).kind,
      'provider_unavailable',
    );
  });

  it('recognises safety refusals in 400 responses', () => {
    assert.equal(
      classifyHttpFailure('gemini', 400, { error: { message: 'The response was blocked by safety filters' } }).kind,
      'safety',
    );
  });
});

describe('transport failure classification', () => {
  it('maps aborts, timeouts and network errors', () => {
    assert.equal(classifyTransportFailure('gemini', Object.assign(new Error('x'), { name: 'AbortError' })).kind, 'aborted');
    assert.equal(classifyTransportFailure('gemini', Object.assign(new Error('late'), { name: 'TimeoutError' })).kind, 'timeout');
    assert.equal(classifyTransportFailure('gemini', Object.assign(new Error('fetch failed'), { code: 'ENOTFOUND' })).kind, 'network');
  });

  it('passes an existing AIError through untouched', () => {
    const original = new AIError({ kind: 'rate_limit', message: 'slow down' });
    assert.equal(classifyTransportFailure('groq', original), original);
  });
});

describe('retry policy', () => {
  it('continues fallback for temporary failures', () => {
    for (const kind of ['rate_limit', 'quota_exhausted', 'server_error', 'timeout', 'network'] as const) {
      const policy = FAILURE_POLICY[kind];
      assert.ok(
        policy.otherKeys || policy.otherModels || policy.otherProviders,
        `${kind} should keep trying other connections`,
      );
    }
  });

  it('parks keys that are rejected', () => {
    assert.ok(FAILURE_POLICY.invalid_key.parkKey);
    assert.ok(FAILURE_POLICY.invalid_key.markKeyInvalid);
    assert.equal(FAILURE_POLICY.invalid_key.otherKeys, true);
  });

  it('never re-routes a safety refusal to another provider', () => {
    const policy = FAILURE_POLICY.safety;
    assert.equal(policy.otherKeys, false);
    assert.equal(policy.otherModels, false);
    assert.equal(policy.otherProviders, false);
    assert.equal(policy.parkKey, false);
  });

  it('treats a missing key as "try another provider" rather than a dead end for that key', () => {
    assert.equal(FAILURE_POLICY.no_keys.otherProviders, true);
    assert.equal(FAILURE_POLICY.no_keys.parkKey, false);
  });

  it('exposes a student-facing message for every kind', () => {
    for (const [kind, policy] of Object.entries(FAILURE_POLICY)) {
      assert.ok(policy.userMessage.length > 5, `${kind} needs a user message`);
    }
  });
});
