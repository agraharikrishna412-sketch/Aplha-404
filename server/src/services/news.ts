/**
 * News aggregation for the News page.
 *
 * The page design came from a standalone HTML file that fetched feeds *in the browser* through public
 * CORS proxies. That approach cannot ship inside Vroqn: it hands a student's IP and reading habits to
 * an unrelated third-party proxy, it breaks whenever a proxy rate-limits or disappears, and it puts
 * arbitrary remote XML through a client-side parser. The same feeds are therefore fetched **here**, on
 * the server, cached, and exposed as a small JSON API. No proxy, no third party, no key.
 *
 * Honest limitations, stated in the API rather than hidden:
 *  - Feeds are public RSS/Atom. When a publisher is unreachable we report that source as unavailable
 *    instead of inventing stories.
 *  - Headline + link + source + time is what a feed gives us. The full text stays at the publisher;
 *    the reader view links out rather than reprinting someone's article.
 *  - The cache is in memory with a TTL, so a restart costs one refresh and a burst of students costs
 *    one upstream request.
 */
import { all, nowIso, one, run, uuid } from '../db/index.js';

export interface NewsItem {
  id: string;
  title: string;
  link: string;
  source: string;
  category: string;
  publishedAt: string;
  summary: string | null;
  imageUrl: string | null;
}

export interface NewsFeed {
  category: string;
  label: string;
  items: NewsItem[];
  fetchedAt: string;
  /** Sources that answered, and those that did not — so the UI can be truthful about coverage. */
  sources: { name: string; ok: boolean }[];
  stale: boolean;
}

export const NEWS_CATEGORIES = [
  {
    id: 'top',
    label: 'Top stories',
    queries: ['india top news', 'world top news'],
    feeds: [
      'https://feeds.bbci.co.uk/news/world/rss.xml',
      'https://feeds.feedburner.com/ndtvnews-top-stories',
      'https://timesofindia.indiatimes.com/rssfeedstopstories.cms',
    ],
  },
  {
    id: 'india',
    label: 'India',
    queries: ['india news today'],
    feeds: [
      'https://feeds.feedburner.com/ndtvnews-india-news',
      'https://timesofindia.indiatimes.com/rssfeeds/-2128936835.cms',
      'https://www.thehindu.com/news/national/feeder/default.rss',
    ],
  },
  {
    id: 'world',
    label: 'World',
    queries: ['world news today'],
    feeds: ['https://feeds.bbci.co.uk/news/world/rss.xml', 'https://www.aljazeera.com/xml/rss/all.xml'],
  },
  {
    id: 'education',
    label: 'Education & exams',
    queries: ['cbse board exam news', 'jee neet exam news', 'education news india'],
    feeds: ['https://timesofindia.indiatimes.com/rssfeeds/913168846.cms'],
  },
  {
    id: 'science',
    label: 'Science',
    queries: ['science news', 'isro space mission news'],
    feeds: [
      'https://feeds.bbci.co.uk/news/science_and_environment/rss.xml',
      'https://www.sciencedaily.com/rss/all.xml',
    ],
  },
  {
    id: 'technology',
    label: 'Technology',
    queries: ['technology news', 'artificial intelligence news'],
    feeds: [
      'https://feeds.bbci.co.uk/news/technology/rss.xml',
      'https://techcrunch.com/feed/',
      'https://www.theverge.com/rss/index.xml',
    ],
  },
  {
    id: 'sports',
    label: 'Sports',
    queries: ['cricket news india'],
    feeds: ['https://feeds.bbci.co.uk/sport/rss.xml', 'https://www.espncricinfo.com/rss/content/story/feeds/0.xml'],
  },
  {
    id: 'business',
    label: 'Business',
    queries: ['business news india'],
    feeds: ['https://feeds.bbci.co.uk/news/business/rss.xml', 'https://economictimes.indiatimes.com/rssfeedstopstories.cms'],
  },
] as const;

export type CategoryId = (typeof NEWS_CATEGORIES)[number]['id'];

const CACHE_TTL_MS = 10 * 60 * 1000;
const FETCH_TIMEOUT_MS = 7000;
const MAX_ITEMS = 60;
const GOOGLE_NEWS = 'https://news.google.com/rss/search?hl=en-IN&gl=IN&ceid=IN:en&q=';

interface CacheEntry {
  feed: NewsFeed;
  fetchedAtMs: number;
}

const cache = new Map<string, CacheEntry>();
/** One in-flight fetch per category, so ten students opening the page cause one upstream request. */
const inFlight = new Map<string, Promise<NewsFeed>>();

/* ------------------------------------------------------------------ parsing --------------------- */

const ENTITIES: Record<string, string> = {
  amp: '&',
  lt: '<',
  gt: '>',
  quot: '"',
  apos: "'",
  nbsp: ' ',
  '#39': "'",
  '#8217': '’',
  '#8216': '‘',
  '#8220': '“',
  '#8221': '”',
  '#8211': '–',
  '#8212': '—',
  '#160': ' ',
};

/** Decodes the small set of XML entities feeds actually use, then strips any remaining tags. */
export function decodeXml(value: string): string {
  return value
    .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1')
    .replace(/&(#?\w+);/g, (match, name: string) => {
      const key = name.toLowerCase();
      if (ENTITIES[name] !== undefined) return ENTITIES[name];
      if (ENTITIES[key] !== undefined) return ENTITIES[key];
      if (/^#\d+$/.test(name)) {
        const code = Number(name.slice(1));
        return Number.isFinite(code) ? String.fromCodePoint(code) : match;
      }
      return match;
    });
}

function stripTags(value: string): string {
  return decodeXml(value)
    .replace(/<[^>]*>/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function pick(block: string, tag: string): string | null {
  const match = new RegExp(`<${tag}(?:\\s[^>]*)?>([\\s\\S]*?)</${tag}>`, 'i').exec(block);
  if (!match) return null;
  const value = stripTags(match[1]);
  return value.length ? value : null;
}

function pickAttribute(block: string, tag: string, attribute: string): string | null {
  const match = new RegExp(`<${tag}[^>]*\\b${attribute}="([^"]+)"`, 'i').exec(block);
  return match ? decodeXml(match[1]).trim() : null;
}

/** Minimal, dependency-free RSS/Atom reader: item/entry blocks, then the fields the page shows. */
export function parseFeed(xml: string, category: string, sourceHint: string): NewsItem[] {
  const items: NewsItem[] = [];
  const blocks = xml.match(/<(item|entry)\b[\s\S]*?<\/(item|entry)>/gi) ?? [];
  for (const block of blocks) {
    let title = pick(block, 'title');
    if (!title) continue;

    const link =
      pickAttribute(block, 'link', 'href') ??
      pick(block, 'link') ??
      pick(block, 'guid') ??
      null;
    if (!link || !/^https?:\/\//i.test(link)) continue;

    const dateText = pick(block, 'pubDate') ?? pick(block, 'published') ?? pick(block, 'updated') ?? pick(block, 'dc:date');
    const parsed = dateText ? Date.parse(dateText) : NaN;
    const publishedAt = Number.isFinite(parsed) ? new Date(parsed).toISOString() : nowIso();

    let source = pick(block, 'source') ?? sourceHint;
    // Google News puts "Headline - Publisher" in the title; split it so the card reads properly.
    const dash = title.lastIndexOf(' - ');
    if (sourceHint === 'Google News' && dash > 10) {
      source = title.slice(dash + 3).trim();
      title = title.slice(0, dash).trim();
    }

    const summary = pick(block, 'description') ?? pick(block, 'summary') ?? pick(block, 'content');
    const imageUrl =
      pickAttribute(block, 'media:content', 'url') ??
      pickAttribute(block, 'media:thumbnail', 'url') ??
      pickAttribute(block, 'enclosure', 'url');

    items.push({
      id: stableId(link),
      title: title.slice(0, 220),
      link,
      source: (source ?? 'News').slice(0, 60),
      category,
      publishedAt,
      summary: summary ? summary.slice(0, 300) : null,
      imageUrl: imageUrl && /^https?:\/\//i.test(imageUrl) ? imageUrl : null,
    });
  }
  return items;
}

/** A stable id so the client can key list items and de-duplicate across refreshes. */
export function stableId(value: string): string {
  let hash = 0;
  for (let index = 0; index < value.length; index += 1) {
    hash = (hash * 31 + value.charCodeAt(index)) | 0;
  }
  return `n${Math.abs(hash).toString(36)}`;
}

/* ------------------------------------------------------------------ fetching -------------------- */

async function fetchText(url: string): Promise<string | null> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  try {
    const response = await fetch(url, {
      signal: controller.signal,
      headers: {
        // Identify ourselves honestly; some publishers block requests without a user agent.
        'user-agent': 'VroqnNexus/1.0 (student learning workspace; news reader)',
        accept: 'application/rss+xml, application/xml, text/xml, */*',
      },
    });
    if (!response.ok) return null;
    const text = await response.text();
    return text.length > 20 ? text : null;
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

function dedupe(items: NewsItem[]): NewsItem[] {
  const seen = new Set<string>();
  const out: NewsItem[] = [];
  for (const item of items) {
    const key = item.title.toLowerCase().replace(/[^a-z0-9]/g, '').slice(0, 80);
    if (!key || seen.has(key)) continue;
    seen.add(key);
    out.push(item);
  }
  return out;
}

function categoryConfig(id: string) {
  return NEWS_CATEGORIES.find((entry) => entry.id === id) ?? NEWS_CATEGORIES[0];
}

export async function buildFeed(categoryId: string): Promise<NewsFeed> {
  const config = categoryConfig(categoryId);
  const sourceNames = [
    ...config.feeds.map((feed) => new URL(feed).hostname.replace(/^www\./, '')),
    'Google News',
  ];
  const results = await Promise.all([
    ...config.feeds.map(async (feed) => {
      const host = new URL(feed).hostname.replace(/^www\./, '');
      const xml = await fetchText(feed);
      return { name: host, items: xml ? parseFeed(xml, config.id, host) : [] };
    }),
    ...config.queries.map(async (query) => {
      const xml = await fetchText(`${GOOGLE_NEWS}${encodeURIComponent(query)}`);
      return { name: 'Google News', items: xml ? parseFeed(xml, config.id, 'Google News') : [] };
    }),
  ]);

  const byName = new Map<string, { ok: boolean; count: number }>();
  for (const result of results) {
    const previous = byName.get(result.name) ?? { ok: false, count: 0 };
    byName.set(result.name, { ok: previous.ok || result.items.length > 0, count: previous.count + result.items.length });
  }

  const items = dedupe(results.flatMap((result) => result.items))
    .sort((a, b) => Date.parse(b.publishedAt) - Date.parse(a.publishedAt))
    .slice(0, MAX_ITEMS);

  return {
    category: config.id,
    label: config.label,
    items,
    fetchedAt: nowIso(),
    sources: sourceNames.map((name) => ({ name, ok: byName.get(name)?.ok ?? false })),
    stale: false,
  };
}

/** Cached read. `force` bypasses the TTL, used by the refresh button and the background refresher. */
export async function getFeed(categoryId: string, options: { force?: boolean } = {}): Promise<NewsFeed> {
  const config = categoryConfig(categoryId);
  const cached = cache.get(config.id);
  if (!options.force && cached && Date.now() - cached.fetchedAtMs < CACHE_TTL_MS) {
    return cached.feed;
  }
  const running = inFlight.get(config.id);
  if (running && !options.force) return running;

  const promise = buildFeed(config.id)
    .then((feed) => {
      /*
       * A refresh that returns nothing (all sources down) keeps the previous, still-useful list and
       * marks it stale, rather than replacing good headlines with an empty page.
       */
      if (!feed.items.length && cached?.feed.items.length) {
        const stale = { ...cached.feed, stale: true };
        cache.set(config.id, { feed: stale, fetchedAtMs: Date.now() });
        return stale;
      }
      cache.set(config.id, { feed, fetchedAtMs: Date.now() });
      // Recorded for operators, not for the page: a visible answer to "were the feeds reachable?".
      void recordHealth(config.id, feed).catch(() => undefined);
      return feed;
    })
    .catch(() => {
      if (cached) return { ...cached.feed, stale: true };
      throw new Error('News is unavailable right now.');
    })
    .finally(() => {
      inFlight.delete(config.id);
    });

  inFlight.set(config.id, promise);
  return promise;
}

/** Reading list for search: the cached set across categories, filtered locally (no new upstream calls). */
export async function search(term: string): Promise<NewsItem[]> {
  const needle = term.trim().toLowerCase();
  if (needle.length < 2) return [];
  const feeds = await Promise.all(NEWS_CATEGORIES.map((entry) => getFeed(entry.id)));
  const seen = new Set<string>();
  const out: NewsItem[] = [];
  for (const feed of feeds) {
    for (const item of feed.items) {
      if (seen.has(item.id)) continue;
      if (!item.title.toLowerCase().includes(needle) && !item.source.toLowerCase().includes(needle)) continue;
      seen.add(item.id);
      out.push(item);
      if (out.length >= 40) return out;
    }
  }
  return out;
}

/**
 * Small persisted summary of what was fetched.
 *
 * The page works entirely from the cache; this row exists so a restart is not a cold start and so an
 * operator can see whether the upstream feeds were reachable.
 */
export async function recordHealth(category: string, feed: NewsFeed): Promise<void> {
  const existing = await one<{ id: string }>(`SELECT id FROM news_fetch_log WHERE category = ?`, [category]);
  const now = nowIso();
  if (existing) {
    await run(`UPDATE news_fetch_log SET items = ?, fetched_at = ?, ok = ? WHERE id = ?`, [
      feed.items.length,
      now,
      feed.items.length > 0 ? 1 : 0,
      existing.id,
    ]);
  } else {
    await run(`INSERT INTO news_fetch_log (id, category, items, fetched_at, ok) VALUES (?, ?, ?, ?, ?)`, [
      uuid(),
      category,
      feed.items.length,
      now,
      feed.items.length > 0 ? 1 : 0,
    ]);
  }
}

export async function health(): Promise<{ category: string; items: number; fetchedAt: string; ok: boolean }[]> {
  const rows = await all<{ category: string; items: number; fetched_at: string; ok: number }>(
    `SELECT category, items, fetched_at, ok FROM news_fetch_log ORDER BY category`,
  ).catch(() => []);
  return rows.map((row) => ({
    category: row.category,
    items: row.items,
    fetchedAt: row.fetched_at,
    ok: row.ok === 1,
  }));
}
