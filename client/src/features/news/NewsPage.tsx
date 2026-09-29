/**
 * News (§ from the supplied design, adapted).
 *
 * The supplied page was a single HTML file that fetched RSS in the browser through a chain of public
 * CORS proxies. That is not something a school platform can ship: the proxies are third-party, the
 * browser leaks a request trail to all of them, and any of them can fail silently. The *design* — a
 * category chip row, a card feed with a hero image, a full reader overlay and a live status line —
 * is kept; the fetching moved to `services/news.ts` on the server, which aggregates the publishers'
 * own public feeds, caches them for ten minutes and serves one clean list.
 *
 * What the page will not do: reprint an article. Every card opens the publisher.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { ArrowLeft, ArrowUp, ExternalLink, RefreshCw, Search, WifiOff, X } from 'lucide-react';
import { PageBody } from '../../components/AppShell';
import { Badge, Button, Card, EmptyState, ErrorState, Skeleton, VroqnIconButton } from '../../components/vroqn';
import { api } from '../../lib/api';
import { timeAgo } from '../../lib/format';
import { useDebounced } from '../communities/useCommunities';

interface NewsItem {
  id: string;
  title: string;
  link: string;
  source: string;
  category: string;
  publishedAt: string;
  summary: string | null;
  imageUrl: string | null;
}

interface NewsFeed {
  category: string;
  label: string;
  items: NewsItem[];
  fetchedAt: string;
  sources: { name: string; ok: boolean }[];
  stale: boolean;
}

const REFRESH_MS = 10 * 60 * 1000;

export function NewsPage() {
  const [categories, setCategories] = useState<{ id: string; label: string }[]>([]);
  const [active, setActive] = useState('top');
  const [feed, setFeed] = useState<NewsFeed | null>(null);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [term, setTerm] = useState('');
  const debouncedTerm = useDebounced(term, 300);
  const [results, setResults] = useState<NewsItem[] | null>(null);
  const [searching, setSearching] = useState(false);
  const [reader, setReader] = useState<NewsItem | null>(null);
  const [showTop, setShowTop] = useState(false);
  const listRef = useRef<HTMLDivElement | null>(null);

  const load = useCallback(async (category: string, force = false) => {
    if (force) setRefreshing(true);
    else setLoading(true);
    try {
      const next = await api.get<NewsFeed>(`/news?category=${encodeURIComponent(category)}${force ? '&refresh=1' : ''}`);
      setFeed(next);
      setError(null);
    } catch (err) {
      setError((err as Error).message ?? 'Could not load the news right now.');
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  }, []);

  useEffect(() => {
    void api
      .get<{ categories: { id: string; label: string }[] }>('/news/categories')
      .then((result) => setCategories(result.categories))
      .catch(() => undefined);
  }, []);

  useEffect(() => {
    void load(active);
  }, [active, load]);

  /* Ten-minute auto-refresh, as in the supplied design — but the server cache decides what a refresh
     actually costs the publishers, so a hundred open tabs still cause one upstream fetch. */
  useEffect(() => {
    const timer = window.setInterval(() => void load(active), REFRESH_MS);
    return () => window.clearInterval(timer);
  }, [active, load]);

  useEffect(() => {
    if (debouncedTerm.trim().length < 2) {
      setResults(null);
      return;
    }
    let cancelled = false;
    setSearching(true);
    void api
      .get<{ items: NewsItem[] }>(`/news/search?q=${encodeURIComponent(debouncedTerm.trim())}`)
      .then((result) => {
        if (!cancelled) setResults(result.items);
      })
      .catch(() => {
        if (!cancelled) setResults([]);
      })
      .finally(() => {
        if (!cancelled) setSearching(false);
      });
    return () => {
      cancelled = true;
    };
  }, [debouncedTerm]);

  useEffect(() => {
    const onScroll = () => setShowTop(window.scrollY > 600);
    window.addEventListener('scroll', onScroll, { passive: true });
    return () => window.removeEventListener('scroll', onScroll);
  }, []);

  const items = results ?? feed?.items ?? [];
  const failing = useMemo(() => (feed?.sources ?? []).filter((source) => !source.ok).map((source) => source.name), [feed]);

  return (
    <div>
      {/* ------------------------------- header ------------------------------- */}
      <div className="sticky top-[52px] z-20 border-b border-[var(--color-border)] bg-[var(--color-bg)]/95 backdrop-blur lg:top-0">
        <div className="mx-auto max-w-5xl px-4 pb-3 pt-4 sm:px-6">
          <div className="flex items-center gap-3">
            <div className="min-w-0 flex-1">
              <h1 className="text-[22px] font-semibold tracking-tight sm:text-[26px]">News</h1>
              <p className="truncate text-[12px] text-[var(--color-muted)]">
                Headlines from publishers&rsquo; own public feeds, brought into one place.
              </p>
            </div>
            <VroqnIconButton label="Refresh the feed" variant="secondary" onClick={() => void load(active, true)} disabled={refreshing}>
              <RefreshCw size={16} className={refreshing ? 'animate-spin' : ''} />
            </VroqnIconButton>
          </div>

          <div className="mt-3 flex items-center gap-2 rounded-[12px] border border-[var(--color-border)] bg-[var(--color-surface)] px-3 py-2">
            <Search size={15} className="shrink-0 text-[var(--color-muted)]" />
            <input
              value={term}
              onChange={(event) => setTerm(event.target.value)}
              type="search"
              placeholder="Search today's headlines…"
              aria-label="Search headlines"
              autoComplete="off"
              className="min-h-[40px] min-w-0 flex-1 bg-transparent text-[14px] outline-none placeholder:text-[var(--color-muted-dim)]"
            />
            {term ? (
              <button type="button" aria-label="Clear search" onClick={() => setTerm('')} className="vroqn-tap text-[var(--color-muted)]">
                <X size={15} />
              </button>
            ) : null}
          </div>

          <div className="mt-2 flex flex-wrap items-center justify-between gap-2 text-[11.5px] text-[var(--color-muted-dim)]">
            <span className="inline-flex items-center gap-1.5">
              <span className={`h-1.5 w-1.5 rounded-full ${feed?.stale ? 'bg-[var(--color-warning)]' : 'bg-[var(--color-primary)]'}`} aria-hidden="true" />
              {feed ? (feed.stale ? 'Showing the last good copy' : 'Live') : 'Connecting…'}
            </span>
            <span>
              {feed ? `Updated ${timeAgo(feed.fetchedAt)}` : ''}
              {feed?.sources.length ? ` · ${feed.sources.filter((s) => s.ok).length}/${feed.sources.length} sources reachable` : ''}
            </span>
          </div>

          <div className="vroqn-no-scrollbar -mx-4 mt-2 flex gap-2 overflow-x-auto px-4 pb-1">
            {(categories.length ? categories : [{ id: 'top', label: 'Top stories' }]).map((category) => (
              <button
                key={category.id}
                type="button"
                aria-pressed={category.id === active && !results}
                onClick={() => {
                  setTerm('');
                  setActive(category.id);
                }}
                className={[
                  'vroqn-tap shrink-0 rounded-full border px-3.5 py-1.5 text-[12.5px] transition-colors',
                  category.id === active && !results
                    ? 'border-[var(--color-primary)]/45 bg-[var(--color-primary)]/12 font-semibold text-[var(--color-primary)]'
                    : 'border-[var(--color-border)] text-[var(--color-muted)] hover:text-[var(--color-text)]',
                ].join(' ')}
              >
                {category.label}
              </button>
            ))}
          </div>
        </div>
      </div>

      <PageBody className="max-w-5xl pt-4">
        {failing.length ? (
          <Card className="mb-3 border-[var(--color-warning)]/35 p-3">
            <p className="flex items-start gap-2 text-[12px] leading-relaxed text-[var(--color-muted)]">
              <WifiOff size={14} className="mt-0.5 shrink-0 text-[var(--color-warning)]" />
              {failing.length} of {feed?.sources.length ?? 0} sources did not answer just now ({failing.slice(0, 3).join(', ')}
              {failing.length > 3 ? '…' : ''}). Everything below is what did load.
            </p>
          </Card>
        ) : null}

        {results ? (
          <p className="mb-2 text-[12px] text-[var(--color-muted)]">
            {searching ? 'Searching…' : `${items.length} matching headline${items.length === 1 ? '' : 's'} for “${debouncedTerm.trim()}”`}
          </p>
        ) : null}

        {loading && !feed ? (
          <div className="space-y-3">
            {[0, 1, 2, 3].map((key) => (
              <Skeleton key={key} className="h-[104px] w-full" rounded="lg" />
            ))}
          </div>
        ) : error && !feed ? (
          <ErrorState message={error} onRetry={() => void load(active, true)} />
        ) : items.length === 0 ? (
          <EmptyState
            title={results ? 'No headline matched that search' : 'No stories arrived'}
            description={
              results
                ? 'Try a shorter or more general word — search only looks at today’s cached headlines.'
                : 'The publishers did not return anything for this desk. Try again in a minute or pick another desk.'
            }
            action={
              <Button size="sm" variant="secondary" onClick={() => (results ? setTerm('') : void load(active, true))}>
                {results ? 'Clear search' : 'Retry'}
              </Button>
            }
          />
        ) : (
          <div ref={listRef} className="space-y-3">
            {items.map((item) => (
              <NewsCard key={item.id} item={item} onOpen={() => setReader(item)} />
            ))}
            <p className="pb-2 pt-1 text-center text-[11.5px] text-[var(--color-muted-dim)]">
              Headlines and short summaries belong to their publishers. Tapping a story opens the original article.
            </p>
          </div>
        )}
      </PageBody>

      {showTop ? (
        <button
          type="button"
          aria-label="Back to top"
          onClick={() => window.scrollTo({ top: 0, behavior: 'smooth' })}
          className="vroqn-tap fixed bottom-[76px] right-4 z-30 grid h-12 w-12 place-items-center rounded-full border border-[var(--color-primary)]/30 bg-[var(--color-card)] text-[var(--color-primary)] shadow-lg lg:bottom-6"
        >
          <ArrowUp size={18} />
        </button>
      ) : null}

      <Reader
        item={reader}
        related={items.filter((entry) => entry.id !== reader?.id).slice(0, 4)}
        onOpenRelated={(entry) => setReader(entry)}
        onClose={() => setReader(null)}
      />
    </div>
  );
}

function NewsCard({ item, onOpen }: { item: NewsItem; onOpen: () => void }) {
  const fresh = Date.now() - new Date(item.publishedAt).getTime() < 60 * 60 * 1000;
  return (
    <article>
      <button
        type="button"
        onClick={onOpen}
        className="vroqn-tap flex w-full gap-3 rounded-[14px] border border-[var(--color-border)] bg-[var(--color-card)] p-3 text-left transition-colors hover:border-[var(--color-border-strong)]"
      >
        {item.imageUrl ? (
          <img
            src={item.imageUrl}
            alt=""
            width={88}
            height={88}
            loading="lazy"
            onError={(event) => {
              // A publisher's image hotlink can rot; drop the frame rather than show a broken box.
              (event.currentTarget as HTMLImageElement).style.display = 'none';
            }}
            className="h-[88px] w-[88px] shrink-0 rounded-[12px] border border-[var(--color-border)] object-cover"
          />
        ) : null}
        <div className="min-w-0 flex-1">
          <h2 className="text-[14.5px] font-semibold leading-snug">{item.title}</h2>
          {item.summary ? (
            <p className="mt-1 line-clamp-2 text-[12.5px] leading-relaxed text-[var(--color-muted)]">{item.summary}</p>
          ) : null}
          <div className="mt-2 flex flex-wrap items-center gap-2 text-[11px] text-[var(--color-muted-dim)]">
            <span className="rounded-full bg-[var(--color-surface)] px-2 py-0.5 font-medium text-[var(--color-muted)]">{item.source}</span>
            <span>{timeAgo(item.publishedAt)}</span>
            {fresh ? <span className="font-semibold text-[var(--color-primary)]">NEW</span> : null}
          </div>
        </div>
      </button>
    </article>
  );
}

/** Full-screen reader: what the supplied design did well, kept — but it always sends you to the source. */
function Reader({
  item,
  related,
  onOpenRelated,
  onClose,
}: {
  item: NewsItem | null;
  related: NewsItem[];
  onOpenRelated: (item: NewsItem) => void;
  onClose: () => void;
}) {
  useEffect(() => {
    if (!item) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onClose();
    };
    document.addEventListener('keydown', onKey);
    const previous = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => {
      document.removeEventListener('keydown', onKey);
      document.body.style.overflow = previous;
    };
  }, [item, onClose]);

  if (!item) return null;

  return (
    <div className="fixed inset-0 z-[80] overflow-y-auto bg-[var(--color-bg)]" role="dialog" aria-modal="true" aria-label={item.title}>
      <div className="mx-auto max-w-2xl pb-16">
        <div className="sticky top-0 z-10 flex items-center justify-between gap-2 border-b border-[var(--color-border)] bg-[var(--color-bg)]/95 px-4 py-2.5 backdrop-blur">
          <button type="button" onClick={onClose} className="vroqn-tap inline-flex items-center gap-1.5 text-[13px] text-[var(--color-muted)]">
            <ArrowLeft size={16} /> Back to the feed
          </button>
          <VroqnIconButton label="Close" onClick={onClose}>
            <X size={17} />
          </VroqnIconButton>
        </div>

        {item.imageUrl ? (
          <img
            src={item.imageUrl}
            alt=""
            loading="lazy"
            onError={(event) => {
              (event.currentTarget as HTMLImageElement).style.display = 'none';
            }}
            className="h-56 w-full object-cover"
          />
        ) : null}

        <div className="space-y-4 px-4 py-5">
          <div className="flex flex-wrap items-center gap-2 text-[12px]">
            <Badge tone="primary">{item.category}</Badge>
            <span className="text-[var(--color-muted)]">
              {item.source} · {timeAgo(item.publishedAt)}
            </span>
          </div>

          <h1 className="text-[20px] font-semibold leading-snug sm:text-[23px]">{item.title}</h1>

          <div className="grid grid-cols-2 gap-2 sm:grid-cols-3">
            <InfoBox label="Source" value={item.source} />
            <InfoBox label="Published" value={new Date(item.publishedAt).toLocaleString()} />
            <InfoBox label="Desk" value={item.category} />
          </div>

          {item.summary ? (
            <Card className="p-4">
              <p className="text-[11px] font-semibold uppercase tracking-wide text-[var(--color-muted-dim)]">Summary from the publisher</p>
              <p className="mt-1.5 whitespace-pre-wrap text-[13.5px] leading-relaxed text-[var(--color-muted)]">{item.summary}</p>
            </Card>
          ) : null}

          <a
            href={item.link}
            target="_blank"
            rel="noopener noreferrer"
            className="vroqn-tap inline-flex w-full items-center justify-center gap-2 rounded-[12px] bg-[var(--color-primary)] px-4 py-3 text-[14px] font-semibold text-black"
          >
            <ExternalLink size={16} /> Read the full story on {item.source}
          </a>

          <p className="text-[11.5px] leading-relaxed text-[var(--color-muted-dim)]">
            Vroqn Nexus links to published journalism; it does not reprint articles. If the link does not open, the publisher may
            have moved the story.
          </p>

          {related.length ? (
            <div className="space-y-2 pt-2">
              <p className="text-[11px] font-semibold uppercase tracking-wide text-[var(--color-muted-dim)]">More from this desk</p>
              {related.map((entry) => (
                <button
                  key={entry.id}
                  type="button"
                  onClick={() => onOpenRelated(entry)}
                  className="vroqn-tap flex w-full items-center gap-3 rounded-[10px] border border-[var(--color-border)] px-3 py-2 text-left transition-colors hover:border-[var(--color-border-strong)]"
                >
                  <span className="min-w-0 flex-1">
                    <span className="block truncate text-[13px] font-medium">{entry.title}</span>
                    <span className="block text-[11px] text-[var(--color-muted-dim)]">
                      {entry.source} · {timeAgo(entry.publishedAt)}
                    </span>
                  </span>
                </button>
              ))}
            </div>
          ) : null}
        </div>
      </div>
    </div>
  );
}

function InfoBox({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-[10px] border border-[var(--color-border)] bg-[var(--color-card)] px-3 py-2">
      <p className="text-[11px] uppercase tracking-wide text-[var(--color-muted-dim)]">{label}</p>
      <p className="mt-0.5 truncate text-[12.5px]">{value}</p>
    </div>
  );
}
