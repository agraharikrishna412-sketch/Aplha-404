/**
 * Provider key management (BYOK). Everything here returns masked values only:
 * the plaintext secret leaves the client once, is encrypted at rest, and never comes back.
 */
import { Router } from 'express';
import { z } from 'zod';
import { PROVIDER_IDS, PROVIDER_CATALOG, type ProviderId } from '../config/models.js';
import { limits } from '../middleware/rateLimit.js';
import { asyncRoute, parseBody, HttpError } from '../middleware/errors.js';
import { requireAuth } from '../middleware/auth.js';
import { addKey, keyOverview, listKeys, removeKey, testKey, updateKey } from '../services/ai/keyManager.js';
import { catalogue, refreshModels } from '../services/ai/router.js';

export const keysRouter = Router();
keysRouter.use(requireAuth);

const providerEnum = z.enum(['gemini', 'groq', 'openrouter']);

const addSchema = z.object({
  provider: providerEnum,
  key: z.string().trim().min(12, 'That key looks too short.').max(500, 'That key looks too long.'),
  label: z.string().trim().max(60).optional(),
  makeDefault: z.boolean().optional(),
});

/** Overview used by AI Settings: providers, models, key statuses and capability flags. */
keysRouter.get(
  '/overview',
  asyncRoute(async (req, res) => {
    const [overview, providerCatalogue] = await Promise.all([keyOverview(req.user!.id), Promise.resolve(catalogue())]);
    res.json({
      providers: providerCatalogue,
      keys: overview,
      hints: Object.fromEntries(
        PROVIDER_IDS.map((id) => [
          id,
          { keyUrl: PROVIDER_CATALOG[id].keyUrl, keyPrefixHint: PROVIDER_CATALOG[id].keyPrefixHint, docsUrl: PROVIDER_CATALOG[id].docsUrl },
        ]),
      ),
    });
  }),
);

keysRouter.get(
  '/',
  asyncRoute(async (req, res) => {
    res.json({ keys: await listKeys(req.user!.id) });
  }),
);

keysRouter.post(
  '/',
  limits.general(),
  asyncRoute(async (req, res) => {
    const body = parseBody(addSchema, req.body);
    try {
      const created = await addKey(req.user!.id, body.provider as ProviderId, body.key, body.label);
      if (body.makeDefault) await updateKey(req.user!.id, created.id, { isDefault: true });
      const keys = await listKeys(req.user!.id);
      res.status(201).json({ key: keys.find((k) => k.id === created.id) ?? created });
    } catch (err) {
      if (err instanceof Error && err.name === 'AIError') throw new HttpError(400, err.message, 'duplicate_key');
      throw err;
    }
  }),
);

const patchSchema = z.object({
  label: z.string().trim().max(60).optional(),
  enabled: z.boolean().optional(),
  isDefault: z.boolean().optional(),
});

keysRouter.patch(
  '/:id',
  asyncRoute(async (req, res) => {
    const body = parseBody(patchSchema, req.body);
    const updated = await updateKey(req.user!.id, req.params.id, body);
    if (!updated) throw new HttpError(404, 'That key no longer exists.');
    res.json({ key: updated });
  }),
);

keysRouter.delete(
  '/:id',
  asyncRoute(async (req, res) => {
    const ok = await removeKey(req.user!.id, req.params.id);
    if (!ok) throw new HttpError(404, 'That key no longer exists.');
    res.json({ ok: true });
  }),
);

/** Real provider round-trip so "Connected" means something. */
keysRouter.post(
  '/:id/test',
  limits.ai(),
  asyncRoute(async (req, res) => {
    const result = await testKey(req.user!.id, req.params.id);
    res.status(result.ok ? 200 : 200).json({
      ok: result.ok,
      status: result.status,
      message: result.message,
      modelCount: result.models?.length ?? 0,
    });
  }),
);

keysRouter.post(
  '/:provider/refresh-models',
  limits.ai(),
  asyncRoute(async (req, res) => {
    const provider = parseBody(providerEnum, req.params.provider);
    const result = await refreshModels(req.user!.id, provider as ProviderId);
    res.json(result);
  }),
);

/** Failover smoke test: proves which providers are reachable right now, without a chat turn. */
keysRouter.post(
  '/check-connections',
  limits.ai(),
  asyncRoute(async (req, res) => {
    const keys = await listKeys(req.user!.id);
    const enabled = keys.filter((k) => k.enabled);
    const results = await Promise.all(
      enabled.slice(0, 8).map(async (key) => {
        const result = await testKey(req.user!.id, key.id);
        return { id: key.id, provider: key.provider, label: key.label, ...result };
      }),
    );
    res.json({
      tested: results.length,
      healthy: results.filter((r) => r.ok).length,
      results,
    });
  }),
);
