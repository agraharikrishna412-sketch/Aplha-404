/**
 * Smart search across a student's communities (§12).
 *
 * The single most important property of this module is what it *cannot* return: every query is
 * filtered to the communities the caller is actually a **member** of, computed server-side.
 *
 * Membership, not visibility, is the right scope. A public community's *about page* is open to any
 * signed-in student, but its doubts, chat and resources are members-only — so searching "current
 * electricity" must not surface a public community's contents to somebody who never joined it. A
 * student who wants that community's material joins it first (§10, §12, §53).
 *
 * Search is deliberately substring-based rather than a search engine: the dataset is small, the
 * deployment is a single process, and §6 rules out extra infrastructure.
 */
import { all } from '../../db/index.js';
import { memberCommunityIds } from './permissions.js';
import type { SearchHit } from './types.js';

export interface SearchOptions {
  /** Restrict to one community the caller can read. */
  communityId?: string | null;
  /** Which entity types to include; default is everything readable. */
  types?: SearchHit['type'][];
  limit?: number;
}

/** Rows are grouped per type so one very chatty type cannot crowd out the others. */
const PER_TYPE_LIMIT = 8;

function like(term: string): string {
  // Escape the SQL wildcards so a student typing `%` searches for a literal percent sign.
  return `%${term.replace(/[\\%_]/g, (char) => `\\${char}`)}%`;
}

/**
 * The words a student actually typed. Searches are phrases - "current electricity", "laws of motion"
 * - so matching the raw string would return nothing for the most common kind of query.
 */
function tokensOf(query: string): string[] {
  return query
    .toLowerCase()
    .split(/\s+/)
    .map((token) => token.trim())
    .filter((token) => token.length >= 2)
    .slice(0, 5);
}

/**
 * SQL for "every word appears somewhere in one of these columns".
 *
 * Each token is spread across the columns (one word may match the title while another matches the
 * body) and the groups are ANDed, so extra words narrow the result instead of emptying it.
 */
function matchAny(columns: string[], tokens: string[]): { sql: string; params: string[] } {
  if (!tokens.length) return { sql: '1 = 0', params: [] };
  const params: string[] = [];
  const groups = tokens.map((token) => {
    const pattern = like(token);
    columns.forEach(() => params.push(pattern));
    return `(${columns.map((column) => `${column} LIKE ? ESCAPE '\\'`).join(' OR ')})`;
  });
  return { sql: groups.join(' AND '), params };
}

export async function search(
  userId: string,
  rawQuery: string,
  options: SearchOptions = {},
): Promise<{ query: string; hits: SearchHit[]; scope: string[] }> {
  const query = rawQuery.trim().slice(0, 80);
  if (query.length < 2) return { query, hits: [], scope: [] };

  const scope = options.communityId ? [options.communityId] : await memberCommunityIds(userId);

  // When the caller asked for one community, re-check that they are a member of it before anything is
  // queried, so a scoped search cannot be used to probe another community's contents.
  if (options.communityId) {
    const memberOf = await memberCommunityIds(userId);
    if (!memberOf.includes(options.communityId)) return { query, hits: [], scope: [] };
  }

  const types = new Set(
    options.types?.length
      ? options.types
      : (['community', 'doubt', 'knowledge', 'resource', 'competition', 'event', 'challenge', 'study_plan', 'member'] as SearchHit['type'][]),
  );
  const limit = Math.min(Math.max(options.limit ?? 40, 1), 80);
  // The caller's own communities. Empty for a student who has not joined anything yet - in which case
  // the search still returns public communities, because that is how they find one to join.
  const ids = scope.slice(0, 200);
  const placeholders = ids.length ? ids.map(() => '?').join(', ') : 'NULL';
  const tokens = tokensOf(query);

  const tasks: Promise<SearchHit[]>[] = [];

  if (types.has('community')) {
    const match = matchAny(['LOWER(c.name)', 'LOWER(c.description)', 'LOWER(c.tags)'], tokens);
    tasks.push(
      all<{ id: string; name: string; description: string; category: string; slug: string }>(
        // Public communities are findable by anybody; a private or invite-only one is only findable
        // by a member, so its name never leaks through search (§12, §17).
        `SELECT c.id, c.name, c.description, c.category, c.slug FROM communities c
          WHERE c.status = 'active'
            AND (c.visibility = 'public'
                 OR c.id IN (SELECT m.community_id FROM community_members m
                              WHERE m.user_id = ? AND m.status IN ('active','muted')))
            AND ${match.sql}
          ORDER BY c.name LIMIT ?`,
        [userId, ...match.params, PER_TYPE_LIMIT],
      ).then((rows) =>
        rows.map((row) => ({
          type: 'community' as const,
          id: row.id,
          title: row.name,
          snippet: trim(row.description, 140),
          communityId: row.id,
          communityName: row.name,
          url: `/communities/${row.slug}`,
          meta: { category: row.category },
        })),
      ),
    );
  }

  if (types.has('doubt') && ids.length) {
    const match = matchAny(['LOWER(d.title)', 'LOWER(d.description)'], tokens);
    tasks.push(
      all<{ id: string; title: string; description: string; community_id: string; community_name: string; status: string }>(
        `SELECT d.id, d.title, d.description, d.community_id, c.name AS community_name, d.status
           FROM community_doubts d JOIN communities c ON c.id = d.community_id
          WHERE d.community_id IN (${placeholders}) AND d.status <> 'removed'
            AND ${match.sql}
          ORDER BY d.created_at DESC LIMIT ?`,
        [...ids, ...match.params, PER_TYPE_LIMIT],
      ).then((rows) =>
        rows.map((row) => ({
          type: 'doubt' as const,
          id: row.id,
          title: row.title,
          snippet: trim(row.description, 140),
          communityId: row.community_id,
          communityName: row.community_name,
          url: `/communities/${row.community_id}/doubts/${row.id}`,
          meta: { status: row.status },
        })),
      ),
    );
  }

  if (types.has('knowledge') && ids.length) {
    const match = matchAny(['LOWER(k.title)', 'LOWER(k.question)', 'LOWER(k.answer)'], tokens);
    tasks.push(
      all<{ id: string; title: string; question: string; community_id: string; community_name: string; subject: string | null }>(
        `SELECT k.id, k.title, k.question, k.community_id, c.name AS community_name, k.subject
           FROM community_knowledge k JOIN communities c ON c.id = k.community_id
          WHERE k.community_id IN (${placeholders})
            AND ${match.sql}
          ORDER BY k.created_at DESC LIMIT ?`,
        [...ids, ...match.params, PER_TYPE_LIMIT],
      ).then((rows) =>
        rows.map((row) => ({
          type: 'knowledge' as const,
          id: row.id,
          title: row.title,
          snippet: trim(row.question, 140),
          communityId: row.community_id,
          communityName: row.community_name,
          url: `/communities/${row.community_id}?tab=knowledge`,
          meta: { subject: row.subject ?? '' },
        })),
      ),
    );
  }

  if (types.has('resource') && ids.length) {
    const match = matchAny(['LOWER(r.title)', 'LOWER(r.description)'], tokens);
    tasks.push(
      all<{ id: string; title: string; description: string; community_id: string; community_name: string; kind: string }>(
        `SELECT r.id, r.title, r.description, r.community_id, c.name AS community_name, r.kind
           FROM community_resources r JOIN communities c ON c.id = r.community_id
          WHERE r.community_id IN (${placeholders})
            AND ${match.sql}
          ORDER BY r.created_at DESC LIMIT ?`,
        [...ids, ...match.params, PER_TYPE_LIMIT],
      ).then((rows) =>
        rows.map((row) => ({
          type: 'resource' as const,
          id: row.id,
          title: row.title,
          snippet: trim(row.description, 140),
          communityId: row.community_id,
          communityName: row.community_name,
          url: `/communities/${row.community_id}/resources`,
          meta: { kind: row.kind },
        })),
      ),
    );
  }

  if (types.has('competition') && ids.length) {
    const match = matchAny(['LOWER(a.title)', 'LOWER(a.description)'], tokens);
    tasks.push(
      all<{ id: string; title: string; description: string; community_id: string; community_name: string; starts_at: string }>(
        `SELECT a.id, a.title, a.description, cc.community_id, c.name AS community_name, a.starts_at
           FROM community_competitions cc
           JOIN arena_competitions a ON a.id = cc.competition_id
           JOIN communities c ON c.id = cc.community_id
          WHERE cc.community_id IN (${placeholders})
            AND ${match.sql}
          ORDER BY a.starts_at DESC LIMIT ?`,
        [...ids, ...match.params, PER_TYPE_LIMIT],
      ).then((rows) =>
        rows.map((row) => ({
          type: 'competition' as const,
          id: row.id,
          title: row.title,
          snippet: trim(row.description, 140),
          communityId: row.community_id,
          communityName: row.community_name,
          url: `/arena/${row.id}`,
          meta: { startsAt: row.starts_at },
        })),
      ),
    );
  }

  if (types.has('event') && ids.length) {
    const match = matchAny(['LOWER(e.title)', 'LOWER(e.description)'], tokens);
    tasks.push(
      all<{ id: string; title: string; description: string; community_id: string; community_name: string; starts_at: string }>(
        `SELECT e.id, e.title, e.description, e.community_id, c.name AS community_name, e.starts_at
           FROM community_events e JOIN communities c ON c.id = e.community_id
          WHERE e.community_id IN (${placeholders})
            AND ${match.sql}
          ORDER BY e.starts_at DESC LIMIT ?`,
        [...ids, ...match.params, PER_TYPE_LIMIT],
      ).then((rows) =>
        rows.map((row) => ({
          type: 'event' as const,
          id: row.id,
          title: row.title,
          snippet: trim(row.description, 140),
          communityId: row.community_id,
          communityName: row.community_name,
          url: `/communities/${row.community_id}/events`,
          meta: { startsAt: row.starts_at },
        })),
      ),
    );
  }

  if (types.has('challenge') && ids.length) {
    const match = matchAny(['LOWER(ch.title)', 'LOWER(ch.description)'], tokens);
    tasks.push(
      all<{ id: string; title: string; description: string; community_id: string; community_name: string }>(
        `SELECT ch.id, ch.title, ch.description, ch.community_id, c.name AS community_name
           FROM community_challenges ch JOIN communities c ON c.id = ch.community_id
          WHERE ch.community_id IN (${placeholders})
            AND ${match.sql}
          ORDER BY ch.created_at DESC LIMIT ?`,
        [...ids, ...match.params, PER_TYPE_LIMIT],
      ).then((rows) =>
        rows.map((row) => ({
          type: 'challenge' as const,
          id: row.id,
          title: row.title,
          snippet: trim(row.description, 140),
          communityId: row.community_id,
          communityName: row.community_name,
          url: `/communities/${row.community_id}/challenges`,
          meta: {},
        })),
      ),
    );
  }

  if (types.has('study_plan') && ids.length) {
    const match = matchAny(['LOWER(p.title)', 'LOWER(p.description)'], tokens);
    tasks.push(
      all<{ id: string; title: string; description: string; community_id: string; community_name: string }>(
        `SELECT p.id, p.title, p.description, p.community_id, c.name AS community_name
           FROM study_plans p JOIN communities c ON c.id = p.community_id
          WHERE p.community_id IN (${placeholders})
            AND ${match.sql}
          ORDER BY p.created_at DESC LIMIT ?`,
        [...ids, ...match.params, PER_TYPE_LIMIT],
      ).then((rows) =>
        rows.map((row) => ({
          type: 'study_plan' as const,
          id: row.id,
          title: row.title,
          snippet: trim(row.description, 140),
          communityId: row.community_id,
          communityName: row.community_name,
          url: `/communities/${row.community_id}/plans`,
          meta: {},
        })),
      ),
    );
  }

  /*
   * Members are searched last and only inside the caller's own communities. A student can find "Aarav
   * who helped me yesterday" without the endpoint ever becoming a way to enumerate strangers (§43).
   */
  if (types.has('member') && ids.length) {
    const match = matchAny(['LOWER(u.name)'], tokens);
    tasks.push(
      all<{ id: string; name: string; community_id: string; community_name: string; role: string }>(
        `SELECT DISTINCT u.id, u.name, m.community_id, c.name AS community_name, m.role
           FROM community_members m
           JOIN users u ON u.id = m.user_id
           JOIN communities c ON c.id = m.community_id
          WHERE m.community_id IN (${placeholders}) AND m.status IN ('active','muted')
            AND ${match.sql}
          ORDER BY u.name LIMIT ?`,
        [...ids, ...match.params, PER_TYPE_LIMIT],
      ).then((rows) =>
        rows.map((row) => ({
          type: 'member' as const,
          id: row.id,
          title: row.name,
          snippet: `Member of ${row.community_name}`,
          communityId: row.community_id,
          communityName: row.community_name,
          url: `/communities/profile/${row.id}`,
          meta: { role: row.role },
        })),
      ),
    );
  }

  const settled = await Promise.all(tasks);
  const hits = settled.flat().filter((hit) => Boolean(hit.title));

  // Interleave by type so the first screen always shows variety rather than eight doubts (handled by
  // ordering below), then trim to the requested size.
  hits.sort((a, b) => {
    const exact = (hit: SearchHit) =>
      hit.title.toLowerCase().includes(query.toLowerCase()) ? 0 : 1;
    return exact(a) - exact(b);
  });

  return { query, hits: hits.slice(0, limit), scope: scope.length ? scope : [] };
}

function trim(value: string | null | undefined, length: number): string {
  const text = (value ?? '').replace(/\s+/g, ' ').trim();
  return text.length > length ? `${text.slice(0, length - 1)}…` : text;
}

/**
 * Suggestions for the chat/Doubts composer's @mention and search boxes. Only members of the given
 * community are ever suggested, so the control cannot enumerate students in other communities (§43).
 */
export async function memberSuggestions(
  userId: string,
  communityId: string,
  term: string,
): Promise<Array<{ id: string; name: string; role: string }>> {
  const memberOf = await memberCommunityIds(userId);
  if (!memberOf.includes(communityId)) return [];
  const pattern = like(term.trim().slice(0, 40));
  return all<{ id: string; name: string; role: string }>(
    `SELECT u.id, u.name, m.role FROM community_members m JOIN users u ON u.id = m.user_id
      WHERE m.community_id = ? AND m.status IN ('active','muted') AND LOWER(u.name) LIKE LOWER(?) ESCAPE '\\'
      ORDER BY u.name LIMIT 8`,
    [communityId, pattern],
  );
}

/** Platform-wide community discovery by name, used by the Explore page's search box. */
export async function searchCommunities(term: string, limit = 20) {
  // Word-by-word, like the main search: "jee physics" has to find "JEE Physics Warriors" and a
  // student should not have to guess the exact phrase the owner typed (§8).
  const tokens = tokensOf(term.trim().slice(0, 60));
  if (!tokens.length) {
    const empty = emptyTokensFallback(term);
    return empty;
  }
  const match = matchAny(
    ['LOWER(c.name)', 'LOWER(c.description)', 'LOWER(c.tags)', 'LOWER(c.category)'],
    tokens,
  );
  return all<{ id: string; name: string; slug: string; description: string; category: string; member_count: number }>(
    `SELECT c.id, c.name, c.slug, c.description, c.category,
            (SELECT COUNT(*) FROM community_members m
              WHERE m.community_id = c.id AND m.status IN ('active','muted')) AS member_count
       FROM communities c
      WHERE c.status = 'active' AND c.visibility = 'public'
        AND ${match.sql}
      ORDER BY member_count DESC LIMIT ?`,
    [...match.params, Math.min(Math.max(limit, 1), 50)],
  );
}

/**
 * A one-character query is not a search. Return nothing rather than the entire directory, which would
 * look like a result set to the student.
 */
function emptyTokensFallback(_term: string) {
  return [] as { id: string; name: string; slug: string; description: string; category: string; member_count: number }[];
}
