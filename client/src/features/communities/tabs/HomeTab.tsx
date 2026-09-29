/**
 * Community Home (§9).
 *
 * Ordered by educational relevance, not engagement: announcements first, then what is coming up, then
 * what to study, then who is contributing. No "trending", no popularity ranking, nothing that rewards
 * being online.
 */
import { Link } from 'react-router-dom';
import { CalendarClock, FileText, HelpCircle, Megaphone, Pin, Trophy, Users } from 'lucide-react';
import { Badge, Button, Card, EmptyState, ErrorState, SkeletonCard } from '../../../components/ui';
import { CommunitySection } from '../components';
import { communitiesApi } from '../api';
import { useRelativeTime, useRemote } from '../useCommunities';
import type { CommunityDetail } from '../api';

type HomeData = Awaited<ReturnType<typeof communitiesApi.home>>;

export function HomeTab({
  community,
  onNavigate,
}: {
  community: CommunityDetail;
  onNavigate: (tab: string) => void;
}) {
  const home = useRemote<HomeData>(`/communities/${community.id}/home`);
  const relative = useRelativeTime();

  if (home.loading && !home.data) {
    return (
      <div className="grid gap-3 md:grid-cols-2">
        <SkeletonCard lines={4} />
        <SkeletonCard lines={4} />
      </div>
    );
  }
  /*
   * A non-member opening a public community gets a 404 from the home feed by design — the content is
   * members-only even though the community itself is not. That is not a failure, and showing a red
   * "Could not load this community" panel with a Retry button made a normal situation look broken to
   * exactly the student we want to welcome. It is an invitation instead.
   */
  const lockedBecauseNotAMember =
    Boolean(home.error) && !community.myRole && community.joinRequestStatus !== 'pending' && community.visibility === 'public';

  if (lockedBecauseNotAMember) {
    return (
      <EmptyState
        icon={<Users size={20} />}
        title="Join to see what is inside"
        description={`${community.name} is public, but its announcements, doubts and competitions are for members. Joining takes one tap — you can leave whenever you like.`}
        action={
          <Link to={`/communities/${community.slug}`}>
            <Button variant="primary">Back to the join button</Button>
          </Link>
        }
      />
    );
  }

  if (home.error || !home.data) {
    return <ErrorState title="Could not load this community" message={home.error ?? 'Please try again.'} onRetry={() => void home.refresh()} />;
  }

  const data = home.data;
  const nothingYet =
    data.announcements.length === 0 &&
    data.events.length === 0 &&
    data.challenges.length === 0 &&
    data.resources.length === 0 &&
    data.competitions.length === 0;

  return (
    <div className="space-y-6">
      {data.pinnedDiscussions.length ? (
        <Card className="space-y-2 p-4">
          <div className="flex items-center gap-2 text-[13px] font-semibold text-[var(--color-text)]">
            <Pin size={14} className="text-[var(--color-primary)]" /> Pinned
          </div>
          <ul className="space-y-1.5">
            {data.pinnedDiscussions.map((item) => (
              <li key={`${item.kind}-${item.id}`}>
                <button
                  type="button"
                  onClick={() => onNavigate(item.kind === 'doubt' ? 'doubts' : 'chat')}
                  className="vroqn-tap text-left text-[12.5px] text-[var(--color-muted)] hover:text-[var(--color-text)]"
                >
                  {item.kind === 'doubt' ? '❓' : '📌'} {item.title}
                </button>
              </li>
            ))}
          </ul>
        </Card>
      ) : null}

      {nothingYet ? (
        <EmptyState
          icon={<Megaphone size={22} />}
          title="Nothing here yet"
          description="This community has just started. The first announcement, challenge or doubt will show up here."
        />
      ) : null}

      {data.announcements.length ? (
        <CommunitySection
          title="Announcements"
          description="From the community's moderators."
          action={
            <button
              type="button"
              onClick={() => onNavigate('chat')}
              className="vroqn-tap text-[12px] text-[var(--color-primary)] hover:underline"
            >
              Open chat
            </button>
          }
        >
          <div className="space-y-2">
            {data.announcements.map((announcement) => (
              <Card key={announcement.id} className="space-y-1.5 p-4">
                <div className="flex flex-wrap items-center gap-2">
                  <Megaphone size={14} className="text-[var(--color-primary)]" />
                  <h3 className="text-[13.5px] font-semibold text-[var(--color-text)]">{announcement.title}</h3>
                  {announcement.isPinned ? <Badge tone="primary">Pinned</Badge> : null}
                  {announcement.isExpired ? <Badge tone="muted">Expired</Badge> : null}
                </div>
                <p className="whitespace-pre-wrap text-[12.5px] leading-relaxed text-[var(--color-muted)]">{announcement.body}</p>
                <p className="text-[11.5px] text-[var(--color-muted-dim)]">
                  {announcement.authorName} · {relative(announcement.createdAt)}
                </p>
              </Card>
            ))}
          </div>
        </CommunitySection>
      ) : null}

      {(data.events.length || data.competitions.length) ? (
        <div className="grid gap-4 md:grid-cols-2">
          {data.events.length ? (
            <CommunitySection title="Coming up">
              <div className="space-y-2">
                {data.events.map((event) => (
                  <Card key={event.id} className="flex items-start gap-3 p-3">
                    <CalendarClock size={15} className="mt-0.5 shrink-0 text-[var(--color-primary)]" />
                    <div className="min-w-0">
                      <p className="truncate text-[13px] font-medium text-[var(--color-text)]">{event.title}</p>
                      <p className="text-[12px] text-[var(--color-muted)]">
                        {new Date(event.startsAt).toLocaleString(undefined, {
                          weekday: 'short',
                          day: 'numeric',
                          month: 'short',
                          hour: '2-digit',
                          minute: '2-digit',
                        })}
                      </p>
                      <button
                        type="button"
                        onClick={() => onNavigate('events')}
                        className="vroqn-tap mt-1 text-[12px] text-[var(--color-primary)] hover:underline"
                      >
                        {event.isGoing ? 'You are going' : 'RSVP'}
                      </button>
                    </div>
                  </Card>
                ))}
              </div>
            </CommunitySection>
          ) : null}

          {data.competitions.length ? (
            <CommunitySection title="Competitions">
              <div className="space-y-2">
                {data.competitions.map((competition) => (
                  <Card key={competition.id} className="flex items-start gap-3 p-3">
                    <Trophy size={15} className="mt-0.5 shrink-0 text-[var(--color-primary)]" />
                    <div className="min-w-0">
                      <p className="truncate text-[13px] font-medium text-[var(--color-text)]">{competition.title}</p>
                      <p className="text-[12px] text-[var(--color-muted)]">
                        {competition.questionCount} questions · {competition.durationMin} min ·{' '}
                        {new Date(competition.startsAt).toLocaleDateString(undefined, { day: 'numeric', month: 'short' })}
                      </p>
                      <Link to={`/arena/${competition.id}`} className="vroqn-tap mt-1 inline-block text-[12px] text-[var(--color-primary)] hover:underline">
                        Open in Arena
                      </Link>
                    </div>
                  </Card>
                ))}
              </div>
            </CommunitySection>
          ) : null}
        </div>
      ) : null}

      <div className="grid gap-4 md:grid-cols-2">
        {data.challenges.length ? (
          <CommunitySection
            title="Active challenges"
            action={
              <button type="button" onClick={() => onNavigate('challenges')} className="vroqn-tap text-[12px] text-[var(--color-primary)] hover:underline">
                See all
              </button>
            }
          >
            <div className="space-y-2">
              {data.challenges.map((challenge) => (
                <Card key={challenge.id} className="space-y-2 p-3">
                  <p className="text-[13px] font-medium text-[var(--color-text)]">{challenge.title}</p>
                  <p className="text-[12px] text-[var(--color-muted)]">
                    {challenge.completedDays.length} of {challenge.days.length} days done · {challenge.participantCount}{' '}
                    {challenge.participantCount === 1 ? 'participant' : 'participants'}
                  </p>
                  <div className="h-1.5 w-full overflow-hidden rounded-full bg-white/[0.06]">
                    <div
                      className="h-full rounded-full bg-[var(--color-primary)]/70"
                      style={{ width: `${Math.min(Math.max(challenge.progressPercent, 0), 100)}%` }}
                    />
                  </div>
                </Card>
              ))}
            </div>
          </CommunitySection>
        ) : null}

        {data.resources.length ? (
          <CommunitySection
            title="Shared resources"
            action={
              <button type="button" onClick={() => onNavigate('resources')} className="vroqn-tap text-[12px] text-[var(--color-primary)] hover:underline">
                See all
              </button>
            }
          >
            <div className="space-y-2">
              {data.resources.map((resource) => (
                <Card key={resource.id} className="flex items-start gap-3 p-3">
                  <FileText size={15} className="mt-0.5 shrink-0 text-[var(--color-primary)]" />
                  <div className="min-w-0">
                    <p className="truncate text-[13px] font-medium text-[var(--color-text)]">{resource.title}</p>
                    <p className="line-clamp-1 text-[12px] text-[var(--color-muted)]">{resource.description || resource.category}</p>
                  </div>
                </Card>
              ))}
            </div>
          </CommunitySection>
        ) : null}
      </div>

      {data.achievements.length ? (
        <CommunitySection title="Your badges here">
          <div className="flex flex-wrap gap-2">
            {data.achievements.map((badge) => (
              <span
                key={badge.badgeKey}
                className="inline-flex items-center gap-2 rounded-xl border border-[var(--color-border)] bg-[var(--color-card)] px-3 py-2 text-[12.5px] text-[var(--color-text)]"
                title={new Date(badge.earnedAt).toLocaleDateString()}
              >
                <span aria-hidden>{badge.emoji}</span>
                {badge.label}
              </span>
            ))}
          </div>
        </CommunitySection>
      ) : null}

      <Card className="flex flex-wrap items-center gap-3 p-4">
        <HelpCircle size={16} className="text-[var(--color-primary)]" />
        <p className="min-w-0 flex-1 text-[12.5px] text-[var(--color-muted)]">
          Stuck on a question? Post it in Doubts — a good answer can be promoted into this community's knowledge base so the next
          student finds it.
        </p>
        <button type="button" onClick={() => onNavigate('doubts')} className="vroqn-tap text-[12.5px] text-[var(--color-primary)] hover:underline">
          Ask a doubt
        </button>
      </Card>
    </div>
  );
}
