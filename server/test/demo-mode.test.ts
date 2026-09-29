/**
 * The offline sample engine must be switchable off, and sample output must never be attributed to a
 * provider that did not run.
 *
 * Two real defects motivated this file:
 *
 *  1. `DEMO_MODE=off` had no effect. The decision to answer from the built-in sample library depended
 *     only on the *per-user* setting (`settings.demoMode`, which defaults to true), so an operator who
 *     disabled the sample engine still got sample answers — and in production the server refused
 *     `DEMO_MODE=on` while still permitting the library by default. The switch did the opposite of
 *     what it said.
 *  2. The sample path declared `provider: 'gemini'`, which the Arena analysis persisted verbatim.
 *     The audit trail therefore claimed a Gemini call had produced the analysis when nothing but the
 *     offline library ran.
 *
 * This process runs with `DEMO_MODE=off` and no provider keys, which is the operator's "no sample
 * content, ever" configuration.
 */
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import { describe, it } from 'node:test';

process.env.DATA_DIR = path.join(os.tmpdir(), `vroqn-demooff-${Date.now()}`);
process.env.JWT_SECRET = 'demo-off-test-secret-not-used-for-anything-real';
process.env.VROQN_MASTER_KEY = 'e'.repeat(64);
process.env.DEMO_MODE = 'off';
process.env.NODE_ENV = 'development';

const { config } = await import('../src/config/env.js');
const { planFor } = await import('../src/services/ai/taskRouter.js');
const { complete } = await import('../src/services/ai/router.js');
const { DEFAULT_SETTINGS } = await import('../src/types/domain.js');

describe('DEMO_MODE=off disables the sample engine', () => {
  it('reports the sample engine as unavailable', () => {
    assert.equal(config.demoModeDefault, false, 'the server-level cap must be off');
  });

  it('refuses to plan a sample answer even when the student left the setting on', () => {
    const plan = planFor({
      task: 'exam',
      // The stored per-user default is `true` — the server cap has to win.
      settings: { ...DEFAULT_SETTINGS, demoMode: true },
      needsVision: false,
      providersWithKeys: [],
    });
    assert.equal(plan.demoAllowed, false);
    assert.equal(plan.steps.length > 0, true, 'the plan still describes the real provider order');
  });

  it('fails the request instead of serving sample content', async () => {
    await assert.rejects(
      () =>
        complete({
          userId: 'demo-off-user',
          task: 'exam',
          system: 'You are a tutor.',
          messages: [{ role: 'user', content: 'Explain photosynthesis.' }],
        } as never),
      // No keys are configured in this process, so there is nothing left to answer with.
      (err: unknown) => err instanceof Error,
    );
  });
});
