/**
 * Knowledge base (§11).
 *
 * The community's memory: questions that were actually solved, with the answer that was marked
 * helpful. Searchable, and never a dumping ground — entries only appear here when a moderator promotes
 * a solved doubt.
 */
import { useState } from 'react';
import { BookOpen, Sparkles } from 'lucide-react';
import { Badge, Button, Card, EmptyState, ErrorState, SkeletonCard, TextInput } from '../../../components/ui';
import type { CommunityDetail } from '../api';
import { useDebounced, useRemote } from '../useCommunities';

interface KnowledgeEntry {
  id: string;
  doubtId: string | null;
  title: string;
  question: string;
  answer: string;
  aiExplanation: string | null;
  subject: string | null;
  topic: string | null;
  authorName: string;
  createdAt: string;
}

export function KnowledgeTab({ community }: { community: CommunityDetail }) {
  const [search, setSearch] = useState('');
  const [openId, setOpenId] = useState<string | null>(null);
  const debounced = useDebounced(search, 350);

  const knowledge = useRemote<{ items: KnowledgeEntry[]; total: number }>(
    `/communities/${community.id}/knowledge?search=${encodeURIComponent(debounced)}&limit=30`,
    [debounced],
  );

  const items = knowledge.data?.items ?? [];

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-end justify-between gap-2">
        <div className="min-w-0">
          <h2 className="text-[15px] font-semibold text-[var(--color-text)]">Knowledge base</h2>
          <p className="mt-0.5 text-[12.5px] text-[var(--color-muted)]">
            Solved questions from this community, kept so the next student finds the answer instead of asking again.
          </p>
        </div>
      </div>

      <div>
        <label className="sr-only" htmlFor="knowledge-search">
          Search the knowledge base
        </label>
        <TextInput
          id="knowledge-search"
          value={search}
          onChange={(event) => setSearch(event.target.value)}
          placeholder="Search by topic or wording…"
        />
      </div>

      {knowledge.loading && !knowledge.data ? (
        <div className="space-y-2">
          {[0, 1, 2].map((index) => (
            <SkeletonCard key={index} lines={3} />
          ))}
        </div>
      ) : knowledge.error ? (
        <ErrorState title="Could not load the knowledge base" message={knowledge.error} onRetry={() => void knowledge.refresh()} />
      ) : items.length === 0 ? (
        <EmptyState
          icon={<BookOpen size={22} />}
          title={search ? 'Nothing matches that search' : 'The knowledge base is empty'}
          description={
            search
              ? 'Try a shorter word, or browse everything by clearing the search.'
              : 'When a doubt gets a helpful answer, a moderator can add it here. That is how this page fills up.'
          }
          action={search ? <Button onClick={() => setSearch('')}>Clear search</Button> : undefined}
        />
      ) : (
        <div className="space-y-2">
          {items.map((entry) => {
            const open = openId === entry.id;
            return (
              <Card key={entry.id} className="space-y-2 p-3.5">
                <div className="flex flex-wrap items-center gap-2">
                  <Sparkles size={13} className="text-[var(--color-primary)]" />
                  {entry.subject ? <Badge tone="muted">{entry.subject}</Badge> : null}
                  {entry.topic ? <span className="text-[11.5px] text-[var(--color-muted-dim)]">{entry.topic}</span> : null}
                  <span className="text-[11.5px] text-[var(--color-muted-dim)]">
                    added by {entry.authorName} ·{' '}
                    {new Date(entry.createdAt).toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric' })}
                  </span>
                </div>
                <button
                  type="button"
                  onClick={() => setOpenId(open ? null : entry.id)}
                  aria-expanded={open}
                  className="w-full text-left text-[13.5px] font-medium text-[var(--color-text)] hover:text-[var(--color-primary)]"
                >
                  {entry.title}
                </button>
                {open ? (
                  <div className="space-y-2 border-t border-[var(--color-border)] pt-2">
                    <div>
                      <p className="text-[11.5px] uppercase tracking-wide text-[var(--color-muted-dim)]">Question</p>
                      <p className="mt-0.5 whitespace-pre-wrap text-[12.5px] text-[var(--color-muted)]">{entry.question}</p>
                    </div>
                    <div>
                      <p className="text-[11.5px] uppercase tracking-wide text-[var(--color-muted-dim)]">Helpful answer</p>
                      <p className="mt-0.5 whitespace-pre-wrap text-[13px] text-[var(--color-text)]">{entry.answer}</p>
                    </div>
                  </div>
                ) : (
                  <p className="line-clamp-2 text-[12.5px] text-[var(--color-muted)]">{entry.answer}</p>
                )}
              </Card>
            );
          })}
        </div>
      )}
    </div>
  );
}
