/**
 * Leaderboard and contributions (§25, §36).
 *
 * Contribution is earned from things that help other students — a helpful answer, a finished
 * challenge, a resource, taking part in a competition. Messages sent are deliberately not rewarded,
 * because that is how a study group turns into a chat room (§43: no engagement-farming mechanics).
 * An owner can switch the leaderboard off, and when it is off nothing is computed or returned.
 */
import { useState } from 'react';
import { Award, Flame, Info, Medal, Trophy } from 'lucide-react';
import { Badge, Card, EmptyState, ErrorState, LoadingState, ProgressBar } from '../../../components/ui';
import { CommunitySection, RoleBadge } from '../components';
import type { CommunityDetail } from '../api';
import { useRemote } from '../useCommunities';

interface BadgeRow {
  key: string;
  label: string;
  emoji: string;
  description: string;
  earnedAt: string | null;
}

interface Row {
  userId: string;
  name: string;
  role: 'owner' | 'admin' | 'moderator' | 'mentor' | 'member';
  contributionPoints: number;
  helpfulAnswers: number;
  challengesCompleted: number;
  competitionsParticipated: number;
  resourcesContributed: number;
  rank: number;
  isSelf: boolean;
}

export function LeaderboardTab({ community }: { community: CommunityDetail }) {
  const [metric, setMetric] = useState<'contribution' | 'helpful'>('contribution');
  const board = useRemote<{ entries: Row[]; enabled: boolean }>(`/communities/${community.id}/leaderboard?metric=${metric}`, [metric]);
  const badges = useRemote<{ badges: BadgeRow[]; streakDays: number }>('/communities/badges');
  const mine = useRemote<{ contributionPoints: number; helpfulAnswers: number; role: string; rank: number | null }>(
    `/communities/${community.id}/contribution`,
  );

  if (board.loading && !board.data) return <LoadingState message="Loading the leaderboard…" className="py-16" />;
  if (board.error) return <ErrorState title="Could not load the leaderboard" message={board.error} onRetry={() => void board.refresh()} />;

  if (board.data && !board.data.enabled) {
    return (
      <EmptyState
        icon={<Trophy size={22} />}
        title="The leaderboard is switched off"
        description="An owner or admin of this community turned it off. Your own contribution summary is still here."
      />
    );
  }

  const entries = board.data?.entries ?? [];
  const top = entries[0]?.contributionPoints ?? 0;

  return (
    <div className="space-y-4">
      <Card className="flex flex-wrap items-center justify-between gap-3 p-4">
        <div className="min-w-0">
          <p className="text-[12px] uppercase tracking-wide text-[var(--color-muted-dim)]">Your standing</p>
          <p className="mt-0.5 text-[20px] font-semibold text-[var(--color-text)]">
            {mine.data?.contributionPoints ?? 0} <span className="text-[12.5px] font-normal text-[var(--color-muted)]">contribution points</span>
          </p>
          <p className="mt-0.5 text-[12.5px] text-[var(--color-muted)]">
            {mine.data?.helpfulAnswers ?? 0} helpful {mine.data?.helpfulAnswers === 1 ? 'answer' : 'answers'}
            {mine.data?.rank ? ` · rank ${mine.data.rank}` : ''}
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <div role="tablist" aria-label="Leaderboard metric" className="flex rounded-lg border border-[var(--color-border)] p-0.5">
            <button
              type="button"
              role="tab"
              aria-selected={metric === 'contribution'}
              onClick={() => setMetric('contribution')}
              className={[
                'rounded-md px-3 py-1.5 text-[12.5px]',
                metric === 'contribution' ? 'bg-[var(--color-primary)]/12 text-[var(--color-primary)]' : 'text-[var(--color-muted)]',
              ].join(' ')}
            >
              Contribution
            </button>
            <button
              type="button"
              role="tab"
              aria-selected={metric === 'helpful'}
              onClick={() => setMetric('helpful')}
              className={[
                'rounded-md px-3 py-1.5 text-[12.5px]',
                metric === 'helpful' ? 'bg-[var(--color-primary)]/12 text-[var(--color-primary)]' : 'text-[var(--color-muted)]',
              ].join(' ')}
            >
              Helpful answers
            </button>
          </div>
        </div>
      </Card>

      <Card className="flex items-start gap-3 p-3.5">
        <Info size={15} className="mt-0.5 shrink-0 text-[var(--color-primary)]" />
        <p className="text-[12.5px] leading-relaxed text-[var(--color-muted)]">
          Points come from answering doubts that the asker marked helpful, finishing challenge days, sharing resources and taking
          part in competitions. Sending chat messages earns nothing — this board is about helping, not posting.
        </p>
      </Card>

      {entries.length === 0 ? (
        <EmptyState icon={<Medal size={22} />} title="No contributions recorded yet" description="Answer a doubt or finish a challenge day and you will be the first person on it." />
      ) : (
        <ol className="space-y-1.5">
          {entries.map((entry) => (
            <li key={entry.userId}>
              <Card className={['flex items-center gap-3 p-3', entry.isSelf ? 'border-[var(--color-primary)]/40' : ''].join(' ')}>
                <span
                  className={[
                    'flex h-8 w-8 shrink-0 items-center justify-center rounded-full text-[12.5px] font-semibold',
                    entry.rank === 1
                      ? 'bg-[var(--color-warning)]/15 text-[var(--color-warning)]'
                      : entry.rank <= 3
                        ? 'bg-[var(--color-primary)]/12 text-[var(--color-primary)]'
                        : 'bg-[var(--color-surface)] text-[var(--color-muted)]',
                  ].join(' ')}
                >
                  {entry.rank}
                </span>
                <span className="min-w-0 flex-1">
                  <span className="flex flex-wrap items-center gap-2">
                    <span className="truncate text-[13px] font-medium text-[var(--color-text)]">{entry.name}</span>
                    <RoleBadge role={entry.role} />
                    {entry.isSelf ? <Badge tone="primary">You</Badge> : null}
                  </span>
                  <span className="mt-1 block text-[11.5px] text-[var(--color-muted-dim)]">
                    {entry.helpfulAnswers} helpful · {entry.challengesCompleted} challenge days · {entry.competitionsParticipated} competitions ·{' '}
                    {entry.resourcesContributed} resources
                  </span>
                  <ProgressBar
                    value={top > 0 ? entry.contributionPoints / top : 0}
                    className="mt-1.5"
                    label={`${entry.name} contribution`}
                  />
                </span>
                <span className="shrink-0 text-right">
                  <span className="block text-[14px] font-semibold text-[var(--color-text)]">{entry.contributionPoints}</span>
                  <span className="block text-[11px] uppercase tracking-wide text-[var(--color-muted-dim)]">points</span>
                </span>
              </Card>
            </li>
          ))}
        </ol>
      )}

      <CommunitySection
        title="Badges"
        description="Earned automatically from real activity — a badge you cannot see the reason for is not shown."
      >
        {badges.loading && !badges.data ? (
          <LoadingState message="Loading badges…" className="py-8" />
        ) : (
          <>
            <p className="mb-2 inline-flex items-center gap-1.5 text-[12.5px] text-[var(--color-muted)]">
              <Flame size={13} className="text-[var(--color-warning)]" /> Study streak: {badges.data?.streakDays ?? 0}{' '}
              {(badges.data?.streakDays ?? 0) === 1 ? 'day' : 'days'}
            </p>
            <div className="grid gap-2 sm:grid-cols-2">
              {(badges.data?.badges ?? []).map((badge) => (
                <Card key={badge.key} className={['flex items-start gap-3 p-3', badge.earnedAt ? '' : 'opacity-60'].join(' ')}>
                  <span aria-hidden="true" className="text-[20px]">
                    {badge.emoji}
                  </span>
                  <span className="min-w-0">
                    <span className="flex items-center gap-2">
                      <span className="text-[13px] font-medium text-[var(--color-text)]">{badge.label}</span>
                      {badge.earnedAt ? <Badge tone="success">Earned</Badge> : <Badge tone="muted">Not yet</Badge>}
                    </span>
                    <span className="mt-0.5 block text-[12px] text-[var(--color-muted)]">{badge.description}</span>
                  </span>
                </Card>
              ))}
            </div>
          </>
        )}
      </CommunitySection>

      <p className="inline-flex items-center gap-1.5 text-[11.5px] text-[var(--color-muted-dim)]">
        <Award size={12} /> Points and badges are stored on the server and cannot be edited from the browser.
      </p>
    </div>
  );
}
