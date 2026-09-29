/**
 * Community page (§5).
 *
 * One route, one shell, one active tab. The tab strip is driven by `detail.tabs`, which the server
 * computes: a tab only appears when the feature has content or the caller can create some. That is
 * what keeps a brand-new community from opening on eight empty screens.
 *
 * The URL owns the tab (`?tab=chat`) so a link into a community's doubt board is shareable and the
 * back button behaves.
 */
import { Suspense, lazy, useCallback, useEffect, useMemo, useState } from 'react';
import { Link, useNavigate, useParams, useSearchParams } from 'react-router-dom';
import { Bell, BellOff, Check, LogOut, Settings2, ShieldCheck } from 'lucide-react';
import { Badge, Button, Card, ErrorState, LoadingState } from '../../components/ui';
import { useConfirm } from '../../components/Confirm';
import { useToast } from '../../hooks/useToast';
import { communitiesApi, type CommunityDetail } from './api';
import { CommunityAvatar, MemberCount, RoleBadge, VerifiedMark, VisibilityBadge } from './components';
import { isNotFound, useAction, useRemote } from './useCommunities';

const HomeTab = lazy(() => import('./tabs/HomeTab').then((m) => ({ default: m.HomeTab })));
const ChatTab = lazy(() => import('./tabs/ChatTab').then((m) => ({ default: m.ChatTab })));
const DoubtsTab = lazy(() => import('./tabs/DoubtsTab').then((m) => ({ default: m.DoubtsTab })));
const CompetitionsTab = lazy(() => import('./tabs/CompetitionsTab').then((m) => ({ default: m.CompetitionsTab })));
const ResourcesTab = lazy(() => import('./tabs/ResourcesTab').then((m) => ({ default: m.ResourcesTab })));
const ChallengesTab = lazy(() => import('./tabs/ChallengesTab').then((m) => ({ default: m.ChallengesTab })));
const EventsTab = lazy(() => import('./tabs/EventsTab').then((m) => ({ default: m.EventsTab })));
const LeaderboardTab = lazy(() => import('./tabs/LeaderboardTab').then((m) => ({ default: m.LeaderboardTab })));
const MembersTab = lazy(() => import('./tabs/MembersTab').then((m) => ({ default: m.MembersTab })));
const TeamsTab = lazy(() => import('./tabs/TeamsTab').then((m) => ({ default: m.TeamsTab })));
const KnowledgeTab = lazy(() => import('./tabs/KnowledgeTab').then((m) => ({ default: m.KnowledgeTab })));
const ManageTab = lazy(() => import('./tabs/ManageTab').then((m) => ({ default: m.ManageTab })));

const TAB_LABELS: Record<string, string> = {
  home: 'Home',
  chat: 'Chat',
  doubts: 'Doubts',
  competitions: 'Competitions',
  resources: 'Resources',
  challenges: 'Challenges',
  plans: 'Study Plans',
  events: 'Events',
  teams: 'Study teams',
  leaderboard: 'Leaderboard',
  members: 'Members',
  knowledge: 'Knowledge',
  manage: 'Manage',
};

export function CommunityPage() {
  const { idOrSlug = '' } = useParams();
  const [params, setParams] = useSearchParams();
  const navigate = useNavigate();
  const toast = useToast();
  const confirm = useConfirm();
  const { busy, run } = useAction();
  const [requestReason, setRequestReason] = useState('');
  const [inviteCode, setInviteCode] = useState('');
  const [showJoinPanel, setShowJoinPanel] = useState(false);

  const detail = useRemote<CommunityDetail>(`/communities/${encodeURIComponent(idOrSlug)}`);
  const community = detail.data;

  const tab = params.get('tab') ?? 'home';

  const tabs = useMemo(() => {
    if (!community) return [];
    const list = [...community.tabs];
    // "Manage" is not a feature tab — it is the owner/admin control room and only appears for them.
    if (community.capabilities.edit_community || community.capabilities.handle_reports) list.push('manage');
    return list;
  }, [community]);

  useEffect(() => {
    if (!community) return;
    if (!tabs.includes(tab)) {
      const next = new URLSearchParams(params);
      next.set('tab', tabs[0] ?? 'home');
      setParams(next, { replace: true });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [community, tabs, tab]);

  const setTab = useCallback(
    (next: string) => {
      const search = new URLSearchParams(params);
      search.set('tab', next);
      setParams(search, { replace: true });
    },
    [params, setParams],
  );

  const join = async () => {
    if (!community) return;
    if (community.visibility !== 'public') {
      setShowJoinPanel(true);
      return;
    }
    const result = await run(() => communitiesApi.join(community.id), {});
    if (result?.status === 'joined') {
      toast.push({ tone: 'success', title: `Welcome to ${community.name}` });
      await detail.refresh();
    } else if (result?.status === 'requested') {
      toast.push({ tone: 'info', title: 'Request sent', detail: 'An admin will review it.' });
      await detail.refresh();
    }
  };

  const submitJoinRequest = async () => {
    if (!community) return;
    const result = await run(
      () =>
        communitiesApi.join(community.id, {
          inviteCode: community.visibility === 'invite_only' ? inviteCode.trim() : undefined,
          reason: community.visibility === 'private' ? requestReason.trim() : undefined,
        }),
      {},
    );
    if (result?.status === 'joined') {
      toast.push({ tone: 'success', title: `Welcome to ${community.name}` });
      setShowJoinPanel(false);
      await detail.refresh();
    } else if (result?.status === 'requested') {
      toast.push({ tone: 'info', title: 'Request sent', detail: 'An admin will review it.' });
      setShowJoinPanel(false);
      await detail.refresh();
    } else {
      toast.push({ tone: 'warning', title: 'That code was not accepted' });
    }
  };

  const leave = async () => {
    if (!community) return;
    const okToLeave = await confirm({
      title: `Leave ${community.name}?`,
      description:
        community.myRole === 'owner'
          ? 'You are the owner — transfer ownership before leaving.'
          : 'You will stop seeing its chat, doubts and resources. You can join again unless an admin has removed you.',
      confirmLabel: 'Leave community',
      tone: 'danger',
    });
    if (!okToLeave) return;
    const result = await run(() => communitiesApi.leave(community.id), {});
    if (result) {
      toast.push({ tone: 'info', title: `You left ${community.name}` });
      await detail.refresh();
      navigate('/communities');
    }
  };

  if (detail.loading && !community) {
    return <LoadingState message="Opening community…" className="py-24" />;
  }

  if (detail.error || !community) {
    const missing = isNotFound({ status: detail.errorCode === 'not_found' ? 404 : 0 } as never) || detail.errorCode === 'not_found';
    if (missing) {
      return (
        <div className="mx-auto max-w-xl py-16">
          <ErrorState
            title="This community is not available to you"
            message="It may be private or invite-only, or the link may be out of date. If you were given an invite code, ask the owner to resend the link."
            onRetry={() => void detail.refresh()}
            hint="Vroqn never shows the contents of a private community to students who are not members."
          />
          <div className="mt-4 text-center">
            <Link to="/communities">
              <Button variant="secondary">Back to Explore</Button>
            </Link>
          </div>
        </div>
      );
    }
    return (
      <div className="py-16">
        <ErrorState title="Could not open this community" message={detail.error ?? 'Please try again.'} onRetry={() => void detail.refresh()} />
      </div>
    );
  }

  const isMember = Boolean(community.myRole);
  const isPending = community.joinRequestStatus === 'pending';

  return (
    <div className="space-y-5 pb-10">
      {/* ---------------------------------------------------------------- header */}
      <Card className="overflow-hidden p-0">
        <div
          className="h-24 w-full sm:h-28"
          style={
            community.bannerUrl
              ? { backgroundImage: `url(${community.bannerUrl})`, backgroundSize: 'cover', backgroundPosition: 'center' }
              : undefined
          }
          aria-hidden={community.bannerUrl ? undefined : true}
        >
          {community.bannerUrl ? null : (
            <div className="h-full w-full bg-gradient-to-r from-[var(--color-primary)]/15 via-[var(--color-card)] to-transparent" />
          )}
        </div>

        <div className="space-y-3 p-4 sm:p-5">
          <div className="flex flex-wrap items-start gap-3">
            <CommunityAvatar community={community} size={56} />
            <div className="min-w-0 flex-1">
              <div className="flex flex-wrap items-center gap-2">
                <h1 className="text-[19px] font-semibold tracking-tight text-[var(--color-text)] sm:text-[21px]">
                  {community.name}
                </h1>
                <VerifiedMark show={community.isVerified} />
                {community.myRole ? <RoleBadge role={community.myRole} /> : null}
              </div>
              <div className="mt-1.5 flex flex-wrap items-center gap-2">
                <Badge tone="muted">{community.categoryLabel}</Badge>
                <MemberCount count={community.memberCount} limit={community.memberLimit} />
                <VisibilityBadge visibility={community.visibility} />
                {isPending ? <Badge tone="warning">Request pending</Badge> : null}
              </div>
            </div>

            <div className="flex flex-wrap items-center gap-2">
              {isMember ? (
                <>
                  {community.capabilities.edit_community || community.capabilities.handle_reports ? (
                    <Button size="sm" icon={<Settings2 size={14} />} onClick={() => setTab('manage')}>
                      Manage
                    </Button>
                  ) : null}
                  <Button
                    size="sm"
                    variant="ghost"
                    icon={<LogOut size={14} />}
                    onClick={leave}
                    disabled={busy}
                  >
                    {community.myRole === 'owner' ? 'Owner' : 'Leave'}
                  </Button>
                </>
              ) : isPending ? (
                <Badge tone="warning">Waiting for approval</Badge>
              ) : (
                <Button size="sm" variant="primary" onClick={join} loading={busy}>
                  {community.visibility === 'public' ? 'Join' : 'Ask to join'}
                </Button>
              )}
            </div>
          </div>

          <p className="max-w-3xl text-[13px] leading-relaxed text-[var(--color-muted)]">
            {community.description || 'This community has not added a description yet.'}
          </p>

          {community.tags.length ? (
            <div className="flex flex-wrap gap-1.5">
              {community.tags.map((tag) => (
                <span key={tag} className="rounded-full bg-[var(--color-surface)] px-2 py-0.5 text-[11px] text-[var(--color-muted-dim)]">
                  #{tag}
                </span>
              ))}
            </div>
          ) : null}

          {!isMember ? (
            <div className="rounded-xl border border-[var(--color-border)] bg-[var(--color-surface)] p-3">
              {community.visibility === 'public' ? (
                <p className="text-[12.5px] text-[var(--color-muted)]">
                  Join to read the chat, ask doubts, share notes and take part in competitions hosted by this community.
                </p>
              ) : (
                <p className="text-[12.5px] text-[var(--color-muted)]">
                  {community.joinRequirements ||
                    (community.visibility === 'private'
                      ? 'This community approves every member. Send a request and an admin will review it.'
                      : 'You need an invite code from the owner to enter this community.')}
                </p>
              )}
            </div>
          ) : null}

          {community.rules ? (
            <details className="rounded-xl border border-[var(--color-border)] bg-[var(--color-surface)] p-3">
              <summary className="cursor-pointer text-[12.5px] font-medium text-[var(--color-text)]">
                Community rules
              </summary>
              <p className="mt-2 whitespace-pre-wrap text-[12.5px] leading-relaxed text-[var(--color-muted)]">{community.rules}</p>
            </details>
          ) : null}

          {showJoinPanel && !isMember ? (
            <div className="space-y-2 rounded-xl border border-[var(--color-primary)]/35 bg-[var(--color-primary)]/[0.06] p-3">
              {community.visibility === 'invite_only' ? (
                <>
                  <label className="text-[12.5px] text-[var(--color-muted)]" htmlFor="join-code">
                    Invite code
                  </label>
                  <input
                    id="join-code"
                    value={inviteCode}
                    onChange={(event) => setInviteCode(event.target.value.toUpperCase())}
                    placeholder="INVITE CODE"
                    className="h-10 w-full rounded-lg border border-[var(--color-border)] bg-[var(--color-card)] px-3 text-[13px] tracking-[0.12em] text-[var(--color-text)] focus:border-[var(--color-primary)]/60 focus:outline-none"
                  />
                </>
              ) : (
                <>
                  <label className="text-[12.5px] text-[var(--color-muted)]" htmlFor="join-reason">
                    Message to the admins
                  </label>
                  <input
                    id="join-reason"
                    value={requestReason}
                    onChange={(event) => setRequestReason(event.target.value)}
                    placeholder="Class, section, why you want to join"
                    maxLength={400}
                    className="h-10 w-full rounded-lg border border-[var(--color-border)] bg-[var(--color-card)] px-3 text-[13px] text-[var(--color-text)] focus:border-[var(--color-primary)]/60 focus:outline-none"
                  />
                </>
              )}
              <div className="flex flex-wrap gap-2">
                <Button
                  size="sm"
                  variant="primary"
                  loading={busy}
                  onClick={submitJoinRequest}
                  disabled={community.visibility === 'invite_only' && !inviteCode.trim()}
                >
                  {community.visibility === 'invite_only' ? 'Join with code' : 'Send request'}
                </Button>
                <Button size="sm" variant="ghost" onClick={() => setShowJoinPanel(false)}>
                  Cancel
                </Button>
              </div>
            </div>
          ) : null}
        </div>
      </Card>

      {/* ---------------------------------------------------------------- tabs */}
      {/*
        No negative margin here. `-mx-1` widened the page by 4px on a 390px phone — the tab row already
        scrolls horizontally inside its own container, so the extra bleeding only bought a sideways
        scrollbar on the whole page (§51).
      */}
      <div className="sticky top-[52px] z-20 bg-[var(--color-bg)]/95 py-2 backdrop-blur sm:top-0">
        <nav aria-label="Community sections" className="overflow-x-auto">
          <div className="flex min-w-max gap-1">
            {tabs.map((entry) => {
              const active = entry === tab;
              return (
                <button
                  key={entry}
                  type="button"
                  aria-current={active ? 'page' : undefined}
                  onClick={() => setTab(entry)}
                  className={[
                    'vroqn-tap rounded-lg px-3 py-2 text-[12.5px] transition-colors',
                    active
                      ? 'bg-[var(--color-primary)]/15 font-semibold text-[var(--color-primary)]'
                      : 'text-[var(--color-muted)] hover:bg-white/5 hover:text-[var(--color-text)]',
                  ].join(' ')}
                >
                  {TAB_LABELS[entry] ?? entry}
                  {entry === 'chat' && community.unreadCount > 0 ? (
                    <span className="ml-1.5 rounded-full bg-[var(--color-primary)]/25 px-1.5 py-0.5 text-[11px] text-[var(--color-primary)]">
                      {community.unreadCount}
                    </span>
                  ) : null}
                </button>
              );
            })}
          </div>
        </nav>
      </div>

      <Suspense fallback={<LoadingState message={`Loading ${TAB_LABELS[tab] ?? 'section'}…`} className="py-16" />}>
        {tab === 'home' ? <HomeTab community={community} onNavigate={setTab} /> : null}
        {tab === 'chat' ? <ChatTab community={community} /> : null}
        {tab === 'doubts' ? <DoubtsTab community={community} /> : null}
        {tab === 'competitions' ? <CompetitionsTab community={community} /> : null}
        {tab === 'resources' ? <ResourcesTab community={community} /> : null}
        {tab === 'challenges' ? <ChallengesTab community={community} /> : null}
        {tab === 'plans' ? <ChallengesTab community={community} section="plans" /> : null}
        {tab === 'events' ? <EventsTab community={community} /> : null}
        {tab === 'teams' ? <TeamsTab community={community} /> : null}
        {tab === 'leaderboard' ? <LeaderboardTab community={community} /> : null}
        {tab === 'members' ? <MembersTab community={community} /> : null}
        {tab === 'knowledge' ? <KnowledgeTab community={community} /> : null}
        {tab === 'manage' ? <ManageTab community={community} onOpenMembers={() => setTab('members')} /> : null}
      </Suspense>

      {isMember && community.welcomeMessage ? <WelcomeNote community={community} /> : null}
    </div>
  );
}

/**
 * Shown once per visit to the Home tab, not as a modal — a welcome that blocks the screen is exactly
 * the kind of moment a student clicks past without reading.
 */
function WelcomeNote({ community }: { community: CommunityDetail }) {
  const storageKey = `vroqn:community-welcome:${community.id}`;
  const [visible, setVisible] = useState(() => {
    try {
      return window.localStorage.getItem(storageKey) !== 'seen';
    } catch {
      return true;
    }
  });
  if (!visible) return null;
  return (
    <Card className="flex flex-wrap items-center gap-3 border-[var(--color-primary)]/35 bg-[var(--color-primary)]/[0.05] p-4">
      <ShieldCheck size={18} className="text-[var(--color-primary)]" />
      <div className="min-w-0 flex-1">
        <p className="text-[13px] font-medium text-[var(--color-text)]">Welcome from {community.ownerName}</p>
        <p className="mt-0.5 text-[12.5px] whitespace-pre-wrap text-[var(--color-muted)]">{community.welcomeMessage}</p>
      </div>
      <Button
        size="sm"
        variant="ghost"
        icon={<Check size={14} />}
        onClick={() => {
          try {
            window.localStorage.setItem(storageKey, 'seen');
          } catch {
            /* private mode — the note simply shows again */
          }
          setVisible(false);
        }}
      >
        Got it
      </Button>
    </Card>
  );
}

/** Re-exported so the notification centre can reuse the same bell semantics. */
export const NotificationBellIcon = { Bell, BellOff };
