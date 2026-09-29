/**
 * The Communities block on the dashboard and the homepage (§48).
 *
 * Deliberately small: a heading, one line of copy, the student's own communities if they have any,
 * and one action. The full discovery surface is `/communities` — this is a door, not a second
 * community page, because a dashboard that tries to be everything stops being a dashboard.
 */
import { Link } from 'react-router-dom';
import { ArrowRight, Compass, Plus, Users } from 'lucide-react';
import { Badge, Button, Card, SkeletonCard } from '../../components/ui';
import { COMMUNITIES_SUBLINE, COMMUNITIES_TAGLINE, type CommunitySummary } from './api';
import { useRemote } from './useCommunities';
import { CommunityAvatar, VisibilityBadge } from './components';

export function CommunitiesHomeBlock({ compact = false }: { compact?: boolean }) {
  const dashboard = useRemote<{
    communities: CommunitySummary[];
    totalCommunities: number;
    upcoming: { id: string; title: string; community_id: string; community_name: string; starts_at: string }[];
    unreadNotifications: number;
    moderationQueue: number;
  }>('/communities/dashboard');

  if (dashboard.loading && !dashboard.data) {
    return <SkeletonCard lines={3} />;
  }
  if (dashboard.error) {
    /*
     * A dashboard block is not allowed to become an error wall. If Communities cannot be read, the
     * block says nothing and the rest of the page carries on; the full page reports the problem.
     */
    return null;
  }

  const mine = dashboard.data?.communities ?? [];
  const more = Math.max(0, (dashboard.data?.totalCommunities ?? 0) - mine.length);
  const upcoming = dashboard.data?.upcoming ?? [];
  const unread = dashboard.data?.unreadNotifications ?? 0;

  return (
    <section aria-labelledby="communities-block" className="space-y-2.5">
      <div className="flex flex-wrap items-end justify-between gap-2">
        <div className="min-w-0">
          <h2 id="communities-block" className="text-[13px] font-semibold uppercase tracking-wide text-[var(--color-muted-dim)]">
            Vroqn Communities
          </h2>
          <p className="mt-1 text-[13px] font-medium text-[var(--color-text)]">{COMMUNITIES_TAGLINE}</p>
          {!compact ? <p className="mt-0.5 text-[12.5px] text-[var(--color-muted)]">{COMMUNITIES_SUBLINE}</p> : null}
        </div>
        <div className="flex flex-wrap items-center gap-2">
          {unread > 0 ? (
            <Link to="/communities/notifications">
              <Badge tone="primary">{unread} new</Badge>
            </Link>
          ) : null}
          <Link to="/communities">
            {/* Full-size controls: these are the block's primary actions and a 32px tap target is
                uncomfortable on a phone (§51, §55). */}
            <Button variant="secondary" icon={<Compass size={14} />}>
              Explore
            </Button>
          </Link>
          <Link to="/communities/new">
            <Button variant="ghost" icon={<Plus size={14} />}>
              Create
            </Button>
          </Link>
        </div>
      </div>

      {mine.length === 0 ? (
        <Card className="flex flex-wrap items-center justify-between gap-3 p-3.5">
          <p className="min-w-0 text-[12.5px] text-[var(--color-muted)]">
            You are not in a community yet. Join one and your group's doubts, resources and challenges show up right here.
          </p>
          <Link to="/communities" className="shrink-0">
            <Button variant="primary" icon={<Users size={14} />}>
              Find a community
            </Button>
          </Link>
        </Card>
      ) : (
        <div className="grid gap-2.5 sm:grid-cols-2 lg:grid-cols-3">
          {mine.map((community) => (
            <Link key={community.id} to={`/communities/${community.slug}`} className="group block">
              <Card interactive className="flex items-center gap-3 p-3">
                <CommunityAvatar community={community} size={36} />
                <span className="min-w-0 flex-1">
                  <span className="flex items-center gap-1.5">
                    <span className="truncate text-[13px] font-medium text-[var(--color-text)]">{community.name}</span>
                    {community.isVerified ? <Badge tone="primary">Verified</Badge> : null}
                  </span>
                  <span className="mt-0.5 block truncate text-[11.5px] text-[var(--color-muted)]">
                    {community.memberCount} members · {community.myRole ?? 'member'}
                  </span>
                </span>
                <VisibilityBadge visibility={community.visibility} />
              </Card>
            </Link>
          ))}
          {more > 0 ? (
            <Link to="/communities?tab=mine" className="block">
              <Card interactive className="flex h-full items-center justify-center gap-2 p-3 text-[12.5px] text-[var(--color-muted)]">
                {more} more <ArrowRight size={13} />
              </Card>
            </Link>
          ) : null}
        </div>
      )}

      {upcoming.length > 0 ? (
        <ul className="space-y-1.5">
          {upcoming.map((item) => (
            <li key={item.id}>
              <Link to={`/communities/${item.community_id}?tab=competitions`}>
                <Card interactive className="flex flex-wrap items-center justify-between gap-2 p-3">
                  <span className="min-w-0">
                    <span className="block truncate text-[12.5px] font-medium text-[var(--color-text)]">{item.title}</span>
                    <span className="block text-[11.5px] text-[var(--color-muted-dim)]">{item.community_name}</span>
                  </span>
                  <Badge tone="primary">
                    {new Date(item.starts_at).toLocaleDateString(undefined, { day: 'numeric', month: 'short' })}
                  </Badge>
                </Card>
              </Link>
            </li>
          ))}
        </ul>
      ) : null}
    </section>
  );
}
