/**
 * Explore Communities (§8, §38).
 *
 * One page with three jobs, deliberately separated by a segmented control rather than three separate
 * destinations: discover something to join, see what I am already in, and start a new community.
 *
 * Search is server-side and debounced. Filters are the fixed educational taxonomy, not free text, so
 * the list stays navigable as it grows.
 */
import { useMemo, useState } from 'react';
import { Link, useNavigate, useSearchParams } from 'react-router-dom';
import { Compass, Plus, Search, Sparkles, Users } from 'lucide-react';
import { Badge, Button, Card, EmptyState, ErrorState, Segmented, SkeletonCard, TextInput } from '../../components/ui';
import { useToast } from '../../hooks/useToast';
import { communitiesApi, type CommunitySummary } from './api';
import { CommunityCard, CommunitySection, VisibilityBadge } from './components';
import { useAction, useDebounced, useRemote } from './useCommunities';
import { VroqnFilterSelect } from '../../components/vroqn';

type Tab = 'discover' | 'mine';

export function ExploreCommunitiesPage() {
  const navigate = useNavigate();
  const toast = useToast();
  const [params, setParams] = useSearchParams();
  const tab: Tab = params.get('tab') === 'mine' ? 'mine' : 'discover';
  const [term, setTerm] = useState(params.get('q') ?? '');
  const [category, setCategory] = useState(params.get('category') ?? '');
  const [sort, setSort] = useState<'popular' | 'recent'>('popular');
  const debouncedTerm = useDebounced(term, 350);
  const { busy, run } = useAction();
  const [joiningId, setJoiningId] = useState<string | null>(null);
  const [codeFor, setCodeFor] = useState<CommunitySummary | null>(null);
  const [inviteCode, setInviteCode] = useState('');
  const [requestReason, setRequestReason] = useState('');

  const catalog = useRemote<{ categories: { value: string; label: string }[] }>('/communities/catalog');

  const query = useMemo(() => {
    const search = new URLSearchParams();
    if (debouncedTerm.trim()) search.set('search', debouncedTerm.trim());
    if (category) search.set('category', category);
    if (sort) search.set('sort', sort);
    search.set('limit', '24');
    return search.toString();
  }, [debouncedTerm, category, sort]);

  const discover = useRemote<{ communities: CommunitySummary[]; total: number }>(`/communities/discover?${query}`, [query]);
  const mine = useRemote<{ communities: CommunitySummary[] }>(tab === 'mine' ? '/communities/mine' : null);

  const updateParams = (next: Partial<{ tab: Tab; q: string; category: string }>) => {
    const search = new URLSearchParams(params);
    for (const [key, value] of Object.entries(next)) {
      if (value) search.set(key, value);
      else search.delete(key);
    }
    setParams(search, { replace: true });
  };

  const joinPublic = async (community: CommunitySummary) => {
    if (community.visibility !== 'public') {
      setCodeFor(community);
      setInviteCode('');
      setRequestReason('');
      return;
    }
    setJoiningId(community.id);
    await run(() => communitiesApi.join(community.id), {
      success: `You joined ${community.name}.`,
      onSuccess: () => {
        void discover.refresh();
        void mine.refresh();
        navigate(`/communities/${community.slug}`);
      },
    });
    setJoiningId(null);
  };

  const submitJoinFlow = async () => {
    if (!codeFor) return;
    setJoiningId(codeFor.id);
    const result = await run(
      () =>
        communitiesApi.join(codeFor.id, {
          inviteCode: codeFor.visibility === 'invite_only' ? inviteCode.trim() : undefined,
          reason: codeFor.visibility === 'private' ? requestReason.trim() : undefined,
        }),
      {
        onSuccess: (joined) => {
          if (joined.status === 'joined') {
            toast.push({ tone: 'success', title: `You joined ${codeFor.name}.` });
            navigate(`/communities/${codeFor.slug}`);
          } else if (joined.status === 'requested') {
            toast.push({
              tone: 'info',
              title: 'Request sent',
              detail: 'An admin of that community will review it. You will get a notification.',
            });
          } else if (joined.status === 'invite_required') {
            toast.push({ tone: 'warning', title: 'That community needs an invite code', detail: 'Ask a member for one.' });
          }
          void discover.refresh();
        },
      },
    );
    if (result) {
      setCodeFor(null);
      setInviteCode('');
      setRequestReason('');
    }
    setJoiningId(null);
  };

  const list = tab === 'mine' ? (mine.data?.communities ?? []) : (discover.data?.communities ?? []);
  const loading = tab === 'mine' ? mine.loading : discover.loading;
  const error = tab === 'mine' ? mine.error : discover.error;
  const refresh = tab === 'mine' ? mine.refresh : discover.refresh;

  return (
    <div className="space-y-6 pb-8">
      <header className="space-y-3">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div className="min-w-0">
            <h1 className="text-[22px] font-semibold tracking-tight text-[var(--color-text)] sm:text-[24px]">
              Vroqn Communities
            </h1>
            <p className="mt-1 text-[13px] text-[var(--color-muted)]">
              Learn Together. Compete Together. Improve Together.
            </p>
          </div>
          <Link to="/communities/new">
            <Button variant="primary" icon={<Plus size={15} />}>
              Create community
            </Button>
          </Link>
        </div>

        <Segmented
          value={tab}
          onChange={(next) => updateParams({ tab: next as Tab })}
          options={[
            { value: 'discover', label: 'Discover' },
            { value: 'mine', label: 'My communities' },
          ]}
        />
      </header>

      {tab === 'discover' ? (
        <div className="grid gap-2 sm:grid-cols-[1fr_auto_auto]">
          <div className="relative">
            <Search size={15} className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-[var(--color-muted-dim)]" />
            <label className="sr-only" htmlFor="community-search">
              Search communities
            </label>
            <TextInput
              id="community-search"
              value={term}
              onChange={(event) => {
                setTerm(event.target.value);
                updateParams({ q: event.target.value });
              }}
              placeholder="Search by name, tag or topic…"
              className="pl-9"
            />
          </div>
          <VroqnFilterSelect
            label="Category"
            value={category}
            placeholder="All categories"
            onChange={(next) => {
              setCategory(next);
              updateParams({ category: next });
            }}
            options={[
              { value: '', label: 'All categories' },
              ...(catalog.data?.categories ?? []).map((entry) => ({ value: entry.value, label: entry.label })),
            ]}
          />
          <VroqnFilterSelect
            label="Sort communities"
            value={sort}
            onChange={setSort}
            options={[
              { value: 'popular', label: 'Most members' },
              { value: 'recent', label: 'Newest' },
            ]}
          />
        </div>
      ) : null}

      <CommunitySection
        title={tab === 'mine' ? 'Communities you are in' : 'Explore communities'}
        description={
          tab === 'mine'
            ? 'Everything you have joined, with your role and any upcoming activity.'
            : 'Study groups, doubt boards, competitions and study plans — created by students and educators.'
        }
        action={
          tab === 'discover' ? (
            <span className="text-[12px] text-[var(--color-muted)]">
              {discover.data ? `${list.length} shown` : ''}
            </span>
          ) : null
        }
      >
        {loading ? (
          <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
            {[0, 1, 2, 3, 4, 5].map((index) => (
              <SkeletonCard key={index} lines={4} />
            ))}
          </div>
        ) : error ? (
          <ErrorState title="Could not load communities" message={error} onRetry={() => void refresh()} />
        ) : list.length === 0 ? (
          tab === 'mine' ? (
            <EmptyState
              icon={<Users size={22} />}
              title="You have not joined a community yet"
              description="Communities are where doubt-solving, competitions and study plans live. Find one to join — or start your own."
              action={
                <Button variant="primary" onClick={() => updateParams({ tab: 'discover' })} icon={<Compass size={15} />}>
                  Explore communities
                </Button>
              }
            />
          ) : (
            <EmptyState
              icon={<Search size={22} />}
              title="No communities match that search"
              description="Try a different word, or clear the category filter. You can also start the community you were looking for."
              action={
                <div className="flex flex-wrap justify-center gap-2">
                  <Button
                    onClick={() => {
                      setTerm('');
                      setCategory('');
                      updateParams({ q: '', category: '' });
                    }}
                  >
                    Clear filters
                  </Button>
                  <Link to="/communities/new">
                    <Button variant="primary" icon={<Plus size={15} />}>
                      Create community
                    </Button>
                  </Link>
                </div>
              }
            />
          )
        ) : (
          <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
            {list.map((community) => (
              <CommunityCard
                key={community.id}
                community={community}
                joining={joiningId === community.id && busy}
                onJoin={tab === 'discover' ? joinPublic : undefined}
                footer={
                  tab === 'mine' && community.myRole === 'owner' ? (
                    <Link to={`/communities/${community.slug}?tab=manage`}>
                      <Button size="sm" variant="ghost">
                        Manage
                      </Button>
                    </Link>
                  ) : null
                }
              />
            ))}
          </div>
        )}
      </CommunitySection>

      {tab === 'discover' ? (
        <Card className="flex flex-wrap items-center gap-3 p-4">
          <Sparkles size={18} className="text-[var(--color-primary)]" />
          <div className="min-w-0 flex-1">
            <p className="text-[13.5px] font-medium text-[var(--color-text)]">Start a community for your class or subject</p>
            <p className="text-[12.5px] text-[var(--color-muted)]">
              Public, private or invite-only. A private community needs an admin approval to join; an invite-only one needs a
              code you share yourself.
            </p>
          </div>
          <Link to="/communities/new">
            <Button variant="primary" size="sm" icon={<Plus size={14} />}>
              Create
            </Button>
          </Link>
        </Card>
      ) : null}

      {codeFor ? (
        <Card className="space-y-3 p-4">
          <div className="flex flex-wrap items-center gap-2">
            <h3 className="text-[14px] font-semibold text-[var(--color-text)]">{codeFor.name}</h3>
            <VisibilityBadge visibility={codeFor.visibility} />
          </div>
          {codeFor.visibility === 'invite_only' ? (
            <>
              <p className="text-[12.5px] text-[var(--color-muted)]">
                This community only accepts students with an invite code. Enter the code you were given.
              </p>
              <label className="sr-only" htmlFor="invite-code">
                Invite code
              </label>
              <TextInput
                id="invite-code"
                value={inviteCode}
                onChange={(event) => setInviteCode(event.target.value.toUpperCase())}
                placeholder="INVITE CODE"
                autoComplete="off"
              />
            </>
          ) : (
            <>
              <p className="text-[12.5px] text-[var(--color-muted)]">
                {codeFor.description
                  ? codeFor.description
                  : 'Tell the admins who you are. This message is only shown to them.'}
              </p>
              <label className="sr-only" htmlFor="request-reason">
                Why you want to join
              </label>
              <TextInput
                id="request-reason"
                value={requestReason}
                onChange={(event) => setRequestReason(event.target.value)}
                placeholder="For example: Class 12, section B, preparing for JEE 2027"
                maxLength={400}
              />
            </>
          )}
          <div className="flex flex-wrap gap-2">
            <Button
              variant="primary"
              loading={busy && joiningId === codeFor.id}
              onClick={submitJoinFlow}
              disabled={codeFor.visibility === 'invite_only' && !inviteCode.trim()}
            >
              {codeFor.visibility === 'invite_only' ? 'Join with code' : 'Send request'}
            </Button>
            <Button variant="ghost" onClick={() => setCodeFor(null)}>
              Cancel
            </Button>
            {codeFor.visibility === 'invite_only' ? (
              <Badge tone="muted">Codes are created by the community owner</Badge>
            ) : null}
          </div>
        </Card>
      ) : null}
    </div>
  );
}
