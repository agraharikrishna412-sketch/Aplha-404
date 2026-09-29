/**
 * One search box for the whole product.
 *
 * "Add the search option, by searching, shows both communities and users" — so this is a single field
 * that answers with two sections: students and groups. It is reachable from every screen (the header
 * button) and from the top of the dashboard, because a student who wants to find a classmate should
 * not have to first decide whether that is a "messages" job or a "groups" job.
 *
 * Behaviour worth knowing:
 *   - results are fetched from one endpoint (`/api/search`), debounced, and every keystroke cancels
 *     the previous request so a slow response cannot overwrite a newer one;
 *   - people results carry the same "can you message this student" decision the server would make,
 *     so the list never offers an action that would be refused;
 *   - pressing Enter opens the full results for the term on the Groups screen (exact behaviour shown
 *     on the button), and Cmd/Ctrl+K opens this panel from anywhere.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { Link, useNavigate } from 'react-router-dom';
import { ArrowRight, MessageSquare, Search, Users, X } from 'lucide-react';
import { Spinner } from './ui';
import { initials } from '../lib/format';
import { api } from '../lib/api';
import { useDebounced } from '../features/communities/useCommunities';

export interface SearchPerson {
  userId: string;
  name: string;
  username: string | null;
  avatarUrl: string | null;
  canMessage: boolean;
  reason: string | null;
}

export interface SearchCommunity {
  id: string;
  name: string;
  slug: string;
  description: string;
  category: string;
  memberCount: number;
}

interface SearchResponse {
  query: string;
  people: SearchPerson[];
  communities: SearchCommunity[];
}

export function useGlobalSearch(term: string) {
  const debounced = useDebounced(term, 280);
  const [data, setData] = useState<SearchResponse | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const requestId = useRef(0);

  useEffect(() => {
    const value = debounced.trim();
    if (value.length < 2) {
      setData(null);
      setLoading(false);
      setError(null);
      return;
    }
    const id = ++requestId.current;
    setLoading(true);
    api
      .get<SearchResponse>(`/search?q=${encodeURIComponent(value)}`)
      .then((result) => {
        // A stale response must never replace a newer one — that is how a search box starts "lying".
        if (id !== requestId.current) return;
        setData(result);
        setError(null);
      })
      .catch((err: unknown) => {
        if (id !== requestId.current) return;
        setError(err instanceof Error ? err.message : 'Search is unavailable right now.');
        setData(null);
      })
      .finally(() => {
        if (id === requestId.current) setLoading(false);
      });
  }, [debounced]);

  return { data, loading, error, term: debounced };
}

/** The result body, shared by the overlay and the dashboard card. */
export function SearchResults({
  term,
  onNavigate,
  compact = false,
}: {
  term: string;
  onNavigate?: () => void;
  compact?: boolean;
}) {
  const { data, loading, error } = useGlobalSearch(term);
  const navigate = useNavigate();

  const empty = !loading && !error && data && data.people.length === 0 && data.communities.length === 0;
  const tooShort = term.trim().length < 2;

  if (tooShort) {
    return (
      <p className="px-1 py-6 text-center text-[12.5px] text-[var(--color-muted)]">
        Type at least two letters to search students and groups.
      </p>
    );
  }
  if (loading && !data) {
    return (
      <p className="flex items-center justify-center gap-2 px-1 py-6 text-[12.5px] text-[var(--color-muted)]">
        <Spinner size={13} /> Searching…
      </p>
    );
  }
  if (error) {
    return <p className="px-1 py-6 text-center text-[12.5px] text-[var(--color-muted)]">{error}</p>;
  }
  if (empty) {
    return (
      <p className="px-1 py-6 text-center text-[12.5px] text-[var(--color-muted)]">
        Nothing matched “{term.trim()}”. Try a shorter word, or a classmate’s handle.
      </p>
    );
  }

  const people = data?.people ?? [];
  const communities = data?.communities ?? [];

  return (
    <div className="space-y-4">
      {communities.length ? (
        <section className="space-y-1.5">
          <p className="px-1 text-[11px] font-semibold uppercase tracking-wide text-[var(--color-muted-dim)]">
            Groups · {communities.length}
          </p>
          <ul className="space-y-1">
            {communities.map((community) => (
              <li key={community.id}>
                <Link
                  to={`/communities/${community.slug}`}
                  onClick={onNavigate}
                  className="vroqn-tap flex items-center gap-3 rounded-[10px] border border-[var(--color-border)] bg-[var(--color-card)] px-3 py-2.5 transition-colors hover:border-[var(--color-primary)]/45"
                >
                  <span className="grid h-9 w-9 shrink-0 place-items-center rounded-[9px] bg-[var(--color-primary)]/12 text-[12px] font-semibold text-[var(--color-primary)]">
                    <Users size={16} />
                  </span>
                  <span className="min-w-0 flex-1">
                    <span className="block truncate text-[13.5px] font-medium text-[var(--color-text)]">{community.name}</span>
                    <span className="block truncate text-[11.5px] text-[var(--color-muted)]">
                      {community.memberCount} member{community.memberCount === 1 ? '' : 's'}
                      {community.description ? ` · ${community.description}` : ''}
                    </span>
                  </span>
                  <ArrowRight size={14} className="shrink-0 text-[var(--color-muted-dim)]" />
                </Link>
              </li>
            ))}
          </ul>
        </section>
      ) : null}

      {people.length ? (
        <section className="space-y-1.5">
          <p className="px-1 text-[11px] font-semibold uppercase tracking-wide text-[var(--color-muted-dim)]">
            Students · {people.length}
          </p>
          <ul className="space-y-1">
            {people.map((person) => (
              <li key={person.userId}>
                <div className="flex items-center gap-3 rounded-[10px] border border-[var(--color-border)] bg-[var(--color-card)] px-3 py-2.5">
                  <span className="grid h-9 w-9 shrink-0 place-items-center rounded-full bg-[var(--color-surface)] text-[12px] font-semibold text-[var(--color-text)]">
                    {initials(person.name)}
                  </span>
                  <span className="min-w-0 flex-1">
                    <span className="block truncate text-[13.5px] font-medium text-[var(--color-text)]">{person.name}</span>
                    <span className="block truncate text-[11.5px] text-[var(--color-muted)]">
                      {person.username ? `@${person.username}` : 'No handle yet'}
                      {!person.canMessage && person.reason ? ` · ${person.reason}` : ''}
                    </span>
                  </span>
                  <span className="flex shrink-0 items-center gap-1.5">
                    <Link
                      to={`/communities/profile/${person.userId}`}
                      onClick={onNavigate}
                      className="rounded-lg border border-[var(--color-border)] px-2 py-1 text-[11.5px] text-[var(--color-muted)] transition-colors hover:border-[var(--color-border-strong)] hover:text-[var(--color-text)]"
                    >
                      Profile
                    </Link>
                    {person.canMessage ? (
                      <button
                        type="button"
                        onClick={() => {
                          onNavigate?.();
                          navigate(`/messages?to=${person.userId}`);
                        }}
                        className="inline-flex items-center gap-1 rounded-lg border border-[var(--color-primary)]/40 bg-[var(--color-primary)]/12 px-2 py-1 text-[11.5px] font-medium text-[var(--color-primary)]"
                      >
                        <MessageSquare size={12} /> Message
                      </button>
                    ) : null}
                  </span>
                </div>
              </li>
            ))}
          </ul>
        </section>
      ) : null}

      {compact ? null : (
        <p className="px-1 pt-1 text-[11.5px] text-[var(--color-muted-dim)]">
          Only public groups and students who allow discovery appear here. Private conversations are never searched.
        </p>
      )}
    </div>
  );
}

/** Full-screen search sheet, opened from the header (or Cmd/Ctrl+K). */
export function SearchOverlay({ open, onClose }: { open: boolean; onClose: () => void }) {
  const [term, setTerm] = useState('');
  const inputRef = useRef<HTMLInputElement | null>(null);
  const navigate = useNavigate();

  useEffect(() => {
    if (!open) return;
    const timer = window.setTimeout(() => inputRef.current?.focus({ preventScroll: true }), 30);
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onClose();
    };
    const previous = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    document.addEventListener('keydown', onKey);
    return () => {
      window.clearTimeout(timer);
      document.body.style.overflow = previous;
      document.removeEventListener('keydown', onKey);
    };
  }, [open, onClose]);

  const submit = useCallback(() => {
    const value = term.trim();
    if (value.length < 2) return;
    onClose();
    navigate(`/communities?q=${encodeURIComponent(value)}`);
  }, [navigate, onClose, term]);

  const suggestions = useMemo(
    () => [
      { label: 'Physics', hint: 'subject' },
      { label: 'JEE', hint: 'exam' },
      { label: 'Doubt', hint: 'groups' },
      { label: 'Code', hint: 'groups' },
    ],
    [],
  );

  if (!open) return null;

  return createPortal(
    <div className="fixed inset-0 z-[80] flex flex-col bg-[var(--color-bg)]/97 backdrop-blur-sm" role="dialog" aria-modal="true" aria-label="Search">
      <div className="safe-top border-b border-[var(--color-border)] px-3 py-3">
        <div className="flex items-center gap-2">
          <div className="flex min-w-0 flex-1 items-center gap-2 rounded-[12px] border border-[var(--color-border-strong)] bg-[var(--color-card)] px-3 py-2.5">
            <Search size={16} className="shrink-0 text-[var(--color-muted)]" />
            <input
              ref={inputRef}
              value={term}
              onChange={(event) => setTerm(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === 'Enter') submit();
              }}
              aria-label="Search students and groups"
              placeholder="Search students and groups…"
              className="min-h-[32px] min-w-0 flex-1 bg-transparent text-[14px] text-[var(--color-text)] outline-none placeholder:text-[var(--color-muted-dim)]"
            />
            {term ? (
              <button type="button" aria-label="Clear search" onClick={() => setTerm('')} className="text-[var(--color-muted)]">
                <X size={15} />
              </button>
            ) : null}
          </div>
          <button
            type="button"
            onClick={onClose}
            className="vroqn-tap shrink-0 rounded-[12px] border border-[var(--color-border)] bg-[var(--color-surface)] px-3 py-2.5 text-[12.5px] text-[var(--color-muted)]"
          >
            Close
          </button>
        </div>

        {term.trim().length < 2 ? (
          <div className="mt-2.5 flex flex-wrap items-center gap-1.5">
            {suggestions.map((entry) => (
              <button
                key={entry.label}
                type="button"
                onClick={() => setTerm(entry.label)}
                className="vroqn-tap rounded-full border border-[var(--color-border)] bg-[var(--color-surface)] px-2.5 py-1 text-[12px] text-[var(--color-muted)] transition-colors hover:border-[var(--color-primary)]/40 hover:text-[var(--color-text)]"
              >
                {entry.label}
              </button>
            ))}
          </div>
        ) : (
          <button
            type="button"
            onClick={submit}
            className="vroqn-tap mt-2.5 inline-flex w-full items-center justify-center gap-1.5 rounded-[10px] border border-[var(--color-border)] bg-[var(--color-surface)] px-3 py-2 text-[12.5px] text-[var(--color-muted)] transition-colors hover:border-[var(--color-primary)]/40 hover:text-[var(--color-text)]"
          >
            Open full results for “{term.trim()}” <ArrowRight size={13} />
          </button>
        )}
      </div>

      <div className="vroqn-scroll-y flex-1 overflow-y-auto px-3 py-4">
        <div className="mx-auto max-w-2xl">
          <SearchResults term={term} onNavigate={onClose} />
        </div>
      </div>
    </div>,
    document.body,
  );
}
