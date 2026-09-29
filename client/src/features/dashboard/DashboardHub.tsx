/**
 * The pieces that make the dashboard the hub of the product.
 *
 * This turn removed the persistent navigation bar and asked the home screen to carry everything
 * instead: search, news, the student's own profile and communities, in one place. These blocks are
 * the answer to that — each one is a real door to a real screen, driven by real data:
 *
 *   · `SearchLauncher`  — one field for students and groups (opens the same search sheet as the header)
 *   · `SectionsLauncher`— every destination in the product, generated from the navigation definition so
 *                         a new screen can never be added to the router and forgotten here
 *   · `NewsStrip`       — the latest four headlines from the publisher feeds the News screen uses
 *   · `ProfileCard`     — who you are, what others can see, and the two things people do most often
 */
import { useCallback, useEffect, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { ArrowRight, ExternalLink, LineChart, Lock, Newspaper, Pencil, Plus, Search, Sparkles, Users } from 'lucide-react';
import { Badge, Button, Card, CardHeader, Skeleton } from '../../components/ui';
import { api } from '../../lib/api';
import { useToast } from '../../hooks/useToast';
import { initials, timeAgo } from '../../lib/format';
import { useAuth } from '../../hooks/useAuth';
import { NAV_ITEMS } from '../../components/AppShell';
import type { ProfileView } from '../messages/api';

/* ------------------------------------------------------------------ search ---------------------- */

/**
 * The search field on the home screen.
 *
 * It is a button, not an input: typing here would open a sheet anyway (the results need the whole
 * screen on a phone), and a fake input that steals keystrokes and then moves them elsewhere is worse
 * than an honest button. `Cmd/Ctrl+K` and the header button open the same sheet.
 */
export function SearchLauncher({ onOpen }: { onOpen: () => void }) {
  return (
    <button
      type="button"
      onClick={onOpen}
      className="vroqn-tap group flex w-full items-center gap-3 rounded-[var(--radius-card)] border border-[var(--color-border)] bg-[var(--color-card)] px-3.5 py-3 text-left transition-colors hover:border-[var(--color-primary)]/45"
    >
      <span className="grid h-9 w-9 shrink-0 place-items-center rounded-[10px] border border-[var(--color-border)] bg-[var(--color-surface)] text-[var(--color-muted)]">
        <Search size={16} />
      </span>
      <span className="min-w-0 flex-1">
        <span className="block text-[13.5px] font-medium text-[var(--color-text)]">Find a student or a group</span>
        <span className="block truncate text-[11.5px] text-[var(--color-muted)]">
          Type a name, a handle, a subject — results show people and communities together
        </span>
      </span>
      <kbd className="hidden shrink-0 rounded-md border border-[var(--color-border)] bg-[var(--color-surface)] px-1.5 py-0.5 text-[11.5px] text-[var(--color-muted-dim)] sm:block">
        ⌘K
      </kbd>
    </button>
  );
}

/* --------------------------------------------------------------- all sections ------------------- */

/**
 * Every screen in the product, on one grid.
 *
 * Generated from `NAV_ITEMS` — the same list the shell's drawer renders — so this cannot drift out of
 * date, and a student who never opens the menu still sees every destination that exists.
 */
export function SectionsLauncher() {
  const items = NAV_ITEMS.filter((item) => item.to !== '/');
  return (
    <section aria-labelledby="all-sections">
      <div className="mb-2.5 flex items-baseline justify-between gap-2">
        <h2 id="all-sections" className="text-[13px] font-semibold uppercase tracking-wide text-[var(--color-muted-dim)]">
          Everything in Vroqn
        </h2>
        <span className="text-[11.5px] text-[var(--color-muted-dim)]">{items.length} destinations</span>
      </div>
      <ul className="grid grid-cols-2 gap-2.5 sm:grid-cols-3 lg:grid-cols-4">
        {items.map((item) => (
          <li key={item.to}>
            <Link
              to={item.to}
              title={item.hint}
              className="vroqn-lift flex h-full items-center gap-3 rounded-[var(--radius-card)] border border-[var(--color-border)] bg-[var(--color-card)] p-3 transition-colors hover:border-[var(--color-primary)]/45 hover:bg-[var(--color-card-hover)]"
            >
              <span className="grid h-9 w-9 shrink-0 place-items-center rounded-[10px] border border-[var(--color-border)] bg-[var(--color-surface)] text-[var(--color-primary-soft)]">
                {item.icon}
              </span>
              <span className="min-w-0">
                <span className="block truncate text-[13px] font-medium text-[var(--color-text)]">{item.label}</span>
                <span className="block truncate text-[11.5px] text-[var(--color-muted)]">{item.hint}</span>
              </span>
            </Link>
          </li>
        ))}
      </ul>
    </section>
  );
}

/* ------------------------------------------------------------------- news ----------------------- */

interface NewsItem {
  id: string;
  title: string;
  link: string;
  source: string;
  publishedAt: string;
  summary: string | null;
}

interface NewsFeed {
  label: string;
  items: NewsItem[];
  stale: boolean;
}

/**
 * Latest headlines on the home screen.
 *
 * Deliberately a strip, not a feed: four headlines, the publisher's name, and a door to the News
 * screen for the rest. Every link opens the publisher in a new tab — Vroqn never reprints an article,
 * so the card says so rather than silently taking the click.
 */
export function NewsStrip() {
  const [feed, setFeed] = useState<NewsFeed | null>(null);
  const [failed, setFailed] = useState(false);
  const navigate = useNavigate();

  useEffect(() => {
    let cancelled = false;
    api
      .get<NewsFeed>('/news?category=top')
      .then((result) => {
        if (!cancelled) setFeed(result);
      })
      .catch(() => {
        if (!cancelled) setFailed(true);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const items = (feed?.items ?? []).slice(0, 4);

  return (
    <Card>
      <CardHeader
        title="In the news"
        subtitle="Headlines from publishers' own feeds — every card opens the publisher"
        icon={<Newspaper size={15} />}
        right={
          <Button size="sm" variant="ghost" icon={<ArrowRight size={13} />} onClick={() => navigate('/news')}>
            All news
          </Button>
        }
      />
      <div className="p-3.5 pt-0">
        {!feed && !failed ? (
          <div className="space-y-2" role="status" aria-live="polite">
            <span className="sr-only">Loading headlines…</span>
            {[0, 1, 2].map((index) => (
              <Skeleton key={index} className="h-[46px]" rounded="lg" />
            ))}
          </div>
        ) : failed || !items.length ? (
          <p className="rounded-[10px] border border-dashed border-[var(--color-border)] px-3 py-4 text-center text-[12.5px] text-[var(--color-muted)]">
            {failed ? 'News is unavailable right now.' : 'No headlines came back this time.'}{' '}
            <Link to="/news" className="text-[var(--color-primary)] underline-offset-2 hover:underline">
              Open the news screen
            </Link>
          </p>
        ) : (
          <ul className="divide-y divide-[var(--color-border)]">
            {items.map((item) => (
              <li key={item.id}>
                <a
                  href={item.link}
                  target="_blank"
                  rel="noreferrer noopener"
                  className="vroqn-tap group flex items-start gap-3 py-2.5"
                >
                  <span className="min-w-0 flex-1">
                    <span className="line-clamp-2 text-[13.5px] font-medium leading-snug text-[var(--color-text)] group-hover:text-[var(--color-primary)]">
                      {item.title}
                    </span>
                    <span className="mt-0.5 block truncate text-[11.5px] text-[var(--color-muted)]">
                      {item.source} · {timeAgo(item.publishedAt)}
                    </span>
                  </span>
                  <ExternalLink size={13} className="mt-1 shrink-0 text-[var(--color-muted-dim)]" />
                </a>
              </li>
            ))}
          </ul>
        )}
      </div>
    </Card>
  );
}

/* ----------------------------------------------------------------- profile ---------------------- */

const VISIBILITY_LABEL: Record<string, string> = {
  public: 'Anyone on Vroqn',
  members: 'My communities only',
  private: 'Only you',
};

/**
 * The student's own card, on their own home screen.
 *
 * It shows what *other people* can currently see (the profile-visibility setting, in plain words),
 * because that is the question a student actually has when looking at their own card — not "what is my
 * bio", but "who can read it".
 */
export function ProfileCard() {
  const { user } = useAuth();
  const [profile, setProfile] = useState<ProfileView | null>(null);
  const navigate = useNavigate();

  useEffect(() => {
    let cancelled = false;
    api
      .get<ProfileView>('/profile/me')
      .then((result) => {
        if (!cancelled) setProfile(result);
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, []);

  const name = profile?.name ?? user?.name ?? 'Student';
  const visibility = profile?.visibility.profile ?? 'public';

  return (
    <Card className="flex h-full flex-col">
      <CardHeader
        title="Your profile"
        subtitle="What classmates see"
        icon={<Sparkles size={15} />}
        right={
          <Button size="sm" variant="secondary" icon={<Pencil size={13} />} onClick={() => navigate('/profile')}>
            Edit
          </Button>
        }
      />
      <div className="flex flex-1 flex-col gap-3 p-3.5 pt-0">
        <div className="flex items-center gap-3">
          <span className="grid h-12 w-12 shrink-0 place-items-center rounded-full border border-[var(--color-border)] bg-[var(--color-surface)] text-[15px] font-semibold text-[var(--color-text)]">
            {initials(name)}
          </span>
          <div className="min-w-0">
            <p className="truncate text-[14.5px] font-semibold text-[var(--color-text)]">{name}</p>
            <p className="truncate text-[11.5px] text-[var(--color-muted)]">
              {profile?.username ? `@${profile.username} · ` : ''}
              {[profile?.classLevel, profile?.board].filter(Boolean).join(' · ') || 'Add your class and board'}
            </p>
          </div>
        </div>

        <p className="line-clamp-2 text-[12.5px] leading-relaxed text-[var(--color-muted)]">
          {profile?.bio?.trim() ? profile.bio : 'Add a short bio so classmates know what you are studying.'}
        </p>

        <div className="flex flex-wrap items-center gap-1.5">
          <Badge tone={visibility === 'public' ? 'success' : visibility === 'members' ? 'primary' : 'muted'} icon={<Lock size={11} />}>
            {VISIBILITY_LABEL[visibility] ?? visibility}
          </Badge>
          {profile?.stats ? (
            <Badge tone="neutral">
              {profile.stats.practiceSets} practice set{profile.stats.practiceSets === 1 ? '' : 's'} ·{' '}
              {profile.stats.mockExams} mock exam{profile.stats.mockExams === 1 ? '' : 's'}
            </Badge>
          ) : null}
        </div>

        <div className="mt-auto flex flex-wrap gap-2 pt-1">
          <Button size="sm" variant="primary" icon={<Pencil size={13} />} onClick={() => navigate('/profile')}>
            Edit profile
          </Button>
          <Button size="sm" variant="secondary" icon={<Users size={13} />} onClick={() => navigate('/communities')}>
            My groups
          </Button>
        </div>
      </div>
    </Card>
  );
}

/* --------------------------------------------------------------- analytics --------------------- */

interface AnalyticsPoint {
  date: string;
  minutes: number;
  questions: number;
  correct: number;
}

interface AnalyticsSnapshot {
  totals: {
    minutes: number;
    questions: number;
    correct: number;
    accuracy: number;
    activeDays: number;
    quietDays: number;
    streakDays: number;
    sessions: number;
  };
  trend: AnalyticsPoint[];
  subjects: { subject: string; questions: number; accuracy: number; provisional: boolean }[];
  topics: {
    weak: { subject: string; topic: string; attempts: number; accuracy: number }[];
    strong: { subject: string; topic: string; attempts: number; accuracy: number }[];
  };
}

/**
 * The analytics door on the dashboard.
 *
 * It shows three real numbers and a sparkline, then hands over to the full Learning Analytics screen.
 * The numbers come from the same endpoint that screen uses, so the promise on the card ("this is what
 * the full report shows") is literally true rather than a decoration.
 */
export function AnalyticsPreview({ onOpen }: { onOpen: () => void }) {
  const [data, setData] = useState<AnalyticsSnapshot | null>(null);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    let cancelled = false;
    api
      .get<AnalyticsSnapshot>('/activity/analytics?days=30')
      .then((result) => {
        if (!cancelled) setData(result);
      })
      .catch(() => {
        if (!cancelled) setFailed(true);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const trend = data?.trend ?? [];
  // A flat week would divide by zero; one minute keeps the sparkline on its baseline.
  const peak = Math.max(1, ...trend.map((point) => point.minutes));

  return (
    <Card className="flex h-full flex-col">
      <CardHeader
        title="Learning analytics"
        subtitle="Last 30 days, from your own attempts"
        icon={<LineChart size={15} />}
        right={
          <Button size="sm" variant="ghost" icon={<ArrowRight size={13} />} onClick={onOpen}>
            Full report
          </Button>
        }
      />
      <div className="flex flex-1 flex-col gap-3 p-3.5 pt-0">
        {!data && !failed ? (
          <div className="space-y-2" role="status" aria-live="polite">
            <span className="sr-only">Loading your analytics…</span>
            <Skeleton className="h-[68px]" rounded="lg" />
            <Skeleton className="h-[40px]" rounded="lg" />
          </div>
        ) : failed ? (
          <p className="rounded-[10px] border border-dashed border-[var(--color-border)] px-3 py-4 text-center text-[12.5px] text-[var(--color-muted)]">
            Analytics could not load right now.{' '}
            <button type="button" onClick={onOpen} className="text-[var(--color-primary)] underline-offset-2 hover:underline">
              Try the full report
            </button>
          </p>
        ) : (
          <>
            <dl className="grid grid-cols-3 gap-2.5">
              {[
                { label: 'Accuracy', value: data?.totals.questions ? `${Math.round(data.totals.accuracy * 100)}%` : '—', hint: 'across every answer' },
                { label: 'Questions', value: String(data?.totals.questions ?? 0), hint: 'attempted' },
                { label: 'Study time', value: `${data?.totals.minutes ?? 0}m`, hint: 'recorded' },
              ].map((item) => (
                <div key={item.label} className="rounded-[10px] border border-[var(--color-border)] bg-[var(--color-surface)] p-2.5">
                  <dt className="text-[11px] uppercase tracking-wide text-[var(--color-muted-dim)]">{item.label}</dt>
                  <dd className="vroqn-tabular mt-0.5 text-[16px] font-semibold text-[var(--color-text)]">{item.value}</dd>
                  <dd className="text-[11px] text-[var(--color-muted-dim)]">{item.hint}</dd>
                </div>
              ))}
            </dl>

            {/* Sparkline: minutes per day. One polyline, no chart library. */}
            {trend.length > 1 ? (
              <svg viewBox="0 0 260 54" className="h-[54px] w-full" role="img" aria-label="Study minutes per day over the last 30 days">
                <polyline
                  points={trend
                    .map((point, index) => {
                      const x = (index / Math.max(1, trend.length - 1)) * 256 + 2;
                      const y = 50 - (point.minutes / peak) * 44;
                      return `${x.toFixed(1)},${y.toFixed(1)}`;
                    })
                    .join(' ')}
                  fill="none"
                  stroke="var(--color-primary)"
                  strokeWidth="1.6"
                  strokeLinejoin="round"
                  strokeLinecap="round"
                />
              </svg>
            ) : (
              <p className="text-[12.5px] text-[var(--color-muted)]">
                Not enough activity yet for a trend — one practice set starts it.
              </p>
            )}

            <div className="mt-auto flex flex-wrap gap-2 pt-1">
              <Button size="sm" variant="primary" icon={<LineChart size={13} />} onClick={onOpen}>
                Open analytics
              </Button>
              {data?.topics.weak.length ? (
                <Badge tone="warning">
                  {data.topics.weak.length} topic{data.topics.weak.length === 1 ? '' : 's'} need work
                </Badge>
              ) : null}
            </div>
          </>
        )}
      </div>
    </Card>
  );
}

/* ------------------------------------------------------------ top communities ------------------ */

interface CommunitySummary {
  id: string;
  name: string;
  slug: string;
  description: string;
  category: string;
  memberCount: number;
  visibility?: string;
  /** Present when the caller is already in the community — then the card offers "Open", not "Join". */
  myRole?: string | null;
  joinRequestStatus?: string | null;
}

/**
 * The top communities on the home screen.
 *
 * "Popular" is a real, checkable sort: most members first, then newest — the same ordering the
 * Groups screen exposes as "Most members". Nothing here is a curated or paid placement, and the
 * section says what it is sorting by so the order is never mysterious.
 */
export function TopCommunities() {
  const [items, setItems] = useState<CommunitySummary[] | null>(null);
  const [failed, setFailed] = useState(false);
  const [joining, setJoining] = useState<string | null>(null);
  const [justJoined, setJustJoined] = useState<Set<string>>(new Set());
  const { push } = useToast();
  const navigate = useNavigate();

  const load = useCallback(async () => {
    try {
      const result = await api.get<{ communities: CommunitySummary[] }>('/communities/discover?sort=popular&limit=6');
      setItems(result.communities ?? []);
    } catch {
      setFailed(true);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  /**
   * Join straight from the home screen.
   *
   * The cards used to be links and nothing more, so a student who found a group on their own dashboard
   * had to open it, find the Join button in the header, and come back — the request the user actually
   * made was "there is no button to join any community". Public communities join in one tap here; the
   * ones that need approval still hand off to the community's own page, where the reason can be typed.
   *
   * A denied join is never swallowed: the server's own words are shown in a toast.
   */
  const join = async (community: CommunitySummary) => {
    if (community.visibility && community.visibility !== 'public') {
      navigate(`/communities/${community.slug}`);
      return;
    }
    setJoining(community.id);
    try {
      const result = await api.post<{ status: string }>(`/communities/${community.id}/join`, {});
      if (result.status === 'joined') {
        setJustJoined((previous) => new Set(previous).add(community.id));
        push({ tone: 'success', title: `You joined ${community.name}`, detail: 'Open it to see the chat, doubts and resources.' });
      } else if (result.status === 'requested') {
        push({ tone: 'info', title: 'Request sent', detail: `${community.name} reviews every request.` });
      } else if (result.status === 'invite_required') {
        navigate(`/communities/${community.slug}`);
      }
      await load();
    } catch (err) {
      push({
        tone: 'error',
        title: `Could not join ${community.name}`,
        detail: err instanceof Error ? err.message : 'Please try again.',
      });
    } finally {
      setJoining(null);
    }
  };

  return (
    <section aria-labelledby="top-communities">
      <div className="mb-2.5 flex items-baseline justify-between gap-2">
        <h2 id="top-communities" className="text-[13px] font-semibold uppercase tracking-wide text-[var(--color-muted-dim)]">
          Top communities
        </h2>
        <Link
          to="/communities"
          className="vroqn-tap inline-flex items-center rounded-md px-1.5 text-[11.5px] text-[var(--color-primary)] underline-offset-2 hover:underline"
        >
          See all
        </Link>
      </div>
      {!items && !failed ? (
        <div className="grid gap-2.5 sm:grid-cols-2 lg:grid-cols-3" role="status" aria-live="polite">
          <span className="sr-only">Loading communities…</span>
          {[0, 1, 2].map((index) => (
            <Skeleton key={index} className="h-[74px]" rounded="lg" />
          ))}
        </div>
      ) : failed || !items?.length ? (
        <p className="rounded-[10px] border border-dashed border-[var(--color-border)] px-3 py-4 text-center text-[12.5px] text-[var(--color-muted)]">
          {failed ? 'Communities could not load right now.' : 'No public communities yet — be the first to start one.'}{' '}
          <Link to="/communities" className="text-[var(--color-primary)] underline-offset-2 hover:underline">
            Open groups
          </Link>
        </p>
      ) : (
        <ul className="grid gap-2.5 sm:grid-cols-2 lg:grid-cols-3">
          {items.map((community) => {
            const joined = justJoined.has(community.id);
            return (
              <li key={community.id}>
                <div className="flex h-full items-stretch gap-2 rounded-[var(--radius-card)] border border-[var(--color-border)] bg-[var(--color-card)] p-3 transition-colors hover:border-[var(--color-primary)]/45 hover:bg-[var(--color-card-hover)]">
                  <Link to={`/communities/${community.slug}`} className="flex min-w-0 flex-1 items-center gap-3">
                    <span className="grid h-10 w-10 shrink-0 place-items-center rounded-[11px] bg-[var(--color-primary)]/12 text-[13px] font-semibold text-[var(--color-primary)]">
                      {initials(community.name)}
                    </span>
                    <span className="min-w-0">
                      <span className="block truncate text-[13.5px] font-medium text-[var(--color-text)]">{community.name}</span>
                      <span className="block truncate text-[11.5px] text-[var(--color-muted)]">
                        {community.memberCount} member{community.memberCount === 1 ? '' : 's'} ·{' '}
                        {community.description?.trim() || community.category}
                      </span>
                    </span>
                  </Link>
                  {joined || community.myRole ? (
                    <Link
                      to={`/communities/${community.slug}`}
                      className="vroqn-tap grid shrink-0 place-items-center self-center rounded-[10px] border border-[var(--color-primary)]/40 px-2 py-1 text-[11.5px] text-[var(--color-primary)]"
                    >
                      Open
                    </Link>
                  ) : (
                    <Button
                      size="sm"
                      variant={community.visibility === 'public' ? 'primary' : 'secondary'}
                      loading={joining === community.id}
                      disabled={joining !== null}
                      onClick={() => void join(community)}
                      className="shrink-0 self-center"
                    >
                      {community.visibility === 'public' ? 'Join' : community.visibility === 'private' ? 'Ask' : 'Code'}
                    </Button>
                  )}
                </div>
              </li>
            );
          })}
          {/*
            A short list gets a real action next to it rather than a hole in the row. Only shown when
            there is room — on a full grid it would be clutter, and the Groups screen already carries
            the same button.
          */}
          {items.length < 3 ? (
            <li>
              <Link
                to="/communities/new"
                className="vroqn-lift flex h-full items-center gap-3 rounded-[var(--radius-card)] border border-dashed border-[var(--color-border)] p-3 transition-colors hover:border-[var(--color-primary)]/45"
              >
                <span className="grid h-10 w-10 shrink-0 place-items-center rounded-[11px] border border-[var(--color-border)] text-[var(--color-primary)]">
                  <Plus size={16} />
                </span>
                <span className="min-w-0">
                  <span className="block text-[13.5px] font-medium">Start a community</span>
                  <span className="block text-[11.5px] text-[var(--color-muted)]">Your class, your subject, your rules</span>
                </span>
              </Link>
            </li>
          ) : null}
        </ul>
      )}
    </section>
  );
}
