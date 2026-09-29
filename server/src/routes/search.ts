/**
 * One search box for the whole product (§ new, turn 8).
 *
 * The brief for this turn was blunt: "add the search option, by searching, shows both communities and
 * users". Two separate searches (one on the communities page, one in the messages sheet) meant a
 * student had to know *which* box to type in before they knew what they were looking for. This route
 * answers both questions from one term and returns them in one payload, so the UI can show a single
 * result list with two sections.
 *
 * What it deliberately does not do:
 *   - it never searches private message content (there is none to search — the server holds ciphertext);
 *   - it only returns communities the caller is allowed to discover (`searchCommunities` filters to
 *     active/public), so a private group cannot be enumerated by guessing names;
 *   - it never returns the caller as a person result;
 *   - a term shorter than two characters returns an empty result rather than the whole directory.
 */
import { Router } from 'express';
import { asyncRoute } from '../middleware/errors.js';
import { requireAuth } from '../middleware/auth.js';
import { limits } from '../middleware/rateLimit.js';
import { searchPeople } from '../services/profile.js';
import { searchCommunities } from '../services/communities/search.js';

export const searchRouter = Router();

searchRouter.use(requireAuth);

searchRouter.get(
  '/',
  limits.general(),
  asyncRoute(async (req, res) => {
    const term = String(req.query.q ?? '').trim().slice(0, 60);
    if (term.length < 2) {
      res.json({ query: term, people: [], communities: [] });
      return;
    }

    const limit = Math.min(Math.max(Number(req.query.limit ?? 6) || 6, 1), 12);
    const [people, communities] = await Promise.all([
      searchPeople(req.user!.id, term, limit),
      searchCommunities(term, limit),
    ]);

    res.json({
      query: term,
      people,
      communities: communities.map((entry) => ({
        id: entry.id,
        name: entry.name,
        slug: entry.slug,
        description: entry.description,
        category: entry.category,
        memberCount: entry.member_count,
      })),
    });
  }),
);
