/**
 * Home (§4). The one screen that must answer "what should I do next?".
 *
 * Ordering is the whole design:
 *  1. Namaste + a one-line status built from real numbers (streak, today's questions, next class).
 *  2. One primary action — continue the thing that is actually unfinished, or start the first thing.
 *  3. A first-run path for a brand-new student: three real steps instead of a wall of zero-valued
 *     cards that make a new account look broken.
 *
 * What home deliberately does NOT carry any more: the profile card, the analytics preview, the
 * "Start here" quick actions, the "Everything in Vroqn" destination grid, the communities block,
 * "Today's Learning", "What to do next" and "Your AI connections". Every one of those screens still
 * exists and is still one tap away in the header menu — nothing was deleted, only uncluttered from
 * this page. Home is now the hero, the search box, the top communities and the news.
 */
import { useEffect, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import {
  Activity,
  ArrowRight,
  BookOpen,
  Compass,
  Flame,
  LineChart,
  MessageSquare,
  Target,
  Trophy,
} from 'lucide-react';
import { PageBody, PageHeader } from '../../components/AppShell';
import { Badge, Button, Card, ErrorState, SampleNotice } from '../../components/ui';
import { VroqnSection } from '../../components/vroqn';
import { SearchOverlay } from '../../components/SearchOverlay';
import { NewsStrip, SearchLauncher, TopCommunities } from './DashboardHub';
import { StudyCore } from './StudyCore';
import { api, ApiError } from '../../lib/api';
import { timeAgo } from '../../lib/format';
import { useAuth } from '../../hooks/useAuth';
import { useSettings } from '../../hooks/useSettings';
import type { DashboardPayload, ArenaOverview } from '../../types';

export function DashboardPage() {
  const { user } = useAuth();
  const { hasAnyKey, hasConnectedKey } = useSettings();
  const navigate = useNavigate();
  const [data, setData] = useState<DashboardPayload | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  // Arena nudge: only fetched so the dashboard can offer a live/open competition when there is one.
  const [arena, setArena] = useState<ArenaOverview | null>(null);
  /** The same search sheet the header opens — here it is also a field students can tap directly. */
  const [searchOpen, setSearchOpen] = useState(false);

  const load = async () => {
    setLoading(true);
    setError(null);
    try {
      const result = await api.get<DashboardPayload>('/dashboard');
      setData(result);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Could not load your dashboard.');
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    void load();
    void api
      .get<ArenaOverview>('/arena/overview')
      .then(setArena)
      .catch(() => setArena(null));
  }, []);

  const summary = data?.summary;

  /* ------------------------------------------------------------------ home hero */

  /**
   * Status line: real numbers only. "Nothing recorded yet today" is a more useful statement than
   * "0 min" repeated three times.
   */
  const statusLine = (() => {
    if (loading && !data) return null;
    const parts: string[] = [];
    if (summary?.streakDays) parts.push(`${summary.streakDays}-day streak`);
    if (summary?.questionsAttempted) parts.push(`${summary.questionsCorrect}/${summary.questionsAttempted} questions today`);
    if (summary?.minutes) parts.push(`${summary.minutes} min studied`);
    const upcoming = data?.suggestions.find((suggestion) => suggestion.id.startsWith('exam-'));
    if (upcoming) parts.push(upcoming.title.replace('Finish "', 'Finish ').replace('"', ''));
    return parts.length ? parts.join(' · ') : 'Nothing recorded yet today — a small start counts.';
  })();

  const unfinishedExam = data?.recent.exams.find((exam) => exam.status !== 'completed') ?? null;
  const lastConversation = data?.recent.conversations[0] ?? null;

  /**
   * The primary action is whatever is genuinely next: finish an open paper, resume a chat, or start.
   */
  const primaryAction = unfinishedExam
    ? {
        label: `Resume ${unfinishedExam.title}`,
        href: `/mock-exam/${unfinishedExam.id}`,
        secondary: { label: 'Ask the AI', href: '/tutor', icon: <MessageSquare size={15} /> },
      }
    : lastConversation
      ? {
          label: 'Continue with AI',
          href: `/tutor/${lastConversation.id}`,
          secondary: { label: 'New practice set', href: '/practice', icon: <Target size={15} /> },
        }
      : {
          label: 'Ask your first doubt',
          href: '/tutor',
          secondary: { label: 'Explore groups', href: '/communities', icon: <Trophy size={15} /> },
        };

  const continueItems = [
    ...(data?.recent.exams ?? [])
      .filter((exam) => exam.status !== 'completed')
      .slice(0, 1)
      .map((exam) => ({
        id: `exam-${exam.id}`,
        label: exam.title,
        detail: `Mock exam · ${exam.questionCount} questions · unfinished`,
        href: `/mock-exam/${exam.id}`,
        when: timeAgo(exam.createdAt),
        icon: <Compass size={15} />,
      })),
    ...(data?.recent.conversations ?? []).slice(0, 2).map((conversation) => ({
      id: `chat-${conversation.id}`,
      label: conversation.title,
      detail: 'AI conversation',
      href: `/tutor/${conversation.id}`,
      when: timeAgo(conversation.updatedAt),
      icon: <MessageSquare size={15} />,
    })),
    ...(data?.recent.notes ?? []).slice(0, 2).map((note) => ({
      id: `note-${note.id}`,
      label: note.title,
      detail: 'Note',
      href: `/notes/${note.id}`,
      when: timeAgo(note.updatedAt),
      icon: <BookOpen size={15} />,
    })),
  ].slice(0, 3);

  const isNewHere =
    !loading &&
    !data?.recent.conversations.length &&
    !data?.recent.practiceSets.length &&
    !data?.recent.exams.length &&
    !(summary?.questionsAttempted ?? 0);

  const onboarding = [
    {
      id: 'ask',
      kicker: 'Understand',
      title: 'Ask one doubt in your own words',
      detail: 'You get a structured answer — concept, worked example, and a quick check you can attempt.',
      href: '/tutor',
      cta: 'Open AI',
    },
    {
      id: 'practice',
      kicker: 'Practise',
      title: 'Generate a topic-wise practice set',
      detail: 'Pick a subject and chapter; the set is generated at your level and marked instantly.',
      href: '/practice',
      cta: 'Open Practice',
    },
    {
      id: 'group',
      kicker: 'Together',
      title: 'Join a group and introduce yourself',
      detail: 'Groups have chat, doubts, shared notes and competitions. Start by saying hello.',
      href: '/communities',
      cta: 'Browse groups',
    },
  ];

  return (
    <>
      <PageHeader
        title={data?.greeting ?? `Namaste, ${user?.name?.split(' ')[0] ?? 'student'}`}
        badge={
          summary?.streakDays ? (
            <Badge tone="warning" icon={<Flame size={12} />} title="Days in a row with recorded learning activity">
              {summary.streakDays}-day streak
            </Badge>
          ) : undefined
        }
        description="Ready to learn something new? Pick up where you left off, or start something fresh."
        actions={
          <>
            <Button variant="secondary" icon={<LineChart size={15} />} onClick={() => navigate('/analytics')}>
              Learning Analytics
            </Button>
            <Button variant="secondary" icon={<Activity size={15} />} onClick={() => navigate('/activity')}>
              Learning Activity
            </Button>
            <Button variant="primary" icon={<MessageSquare size={15} />} onClick={() => navigate('/tutor')}>
              Ask AI Tutor
            </Button>
          </>
        }
      />

      <PageBody className="space-y-5">
        {/* -------------------------- AI connection state ------------------------- */}
        {!hasConnectedKey ? (
          <SampleNotice
            text={
              hasAnyKey
                ? 'Your API keys have not been verified yet. Run a quick test so Vroqn Nexus can rotate them safely when one is rate limited.'
                : 'No AI key connected yet — Vroqn Nexus is answering from its built-in sample library. Add a free Gemini, Groq or OpenRouter key for real model answers.'
            }
            action={
              <Button size="sm" variant="secondary" onClick={() => navigate('/settings')}>
                {hasAnyKey ? 'Test keys' : 'Add a key'}
              </Button>
            }
          />
        ) : null}

        {/* ------------------------------- hero -------------------------------- */}
        <Card className="relative overflow-hidden border-[var(--color-primary)]/20 bg-gradient-to-b from-[var(--color-primary)]/[0.06] to-transparent">
          {/*
            Decoration, kept inside the hero card so it can never tint the content below it: a faint
            instrument grid and one cyan aurora, both static. The grid is drawn with gradients rather
            than an image so it costs no request and stays crisp on every screen density.
          */}
          <span aria-hidden="true" className="vroqn-hero-decor" />

          <div className="relative grid gap-2 lg:grid-cols-[minmax(0,1.08fr)_minmax(0,0.92fr)] lg:items-center">
            {/* Words: second on a phone (the animation greets you first), first on a laptop. */}
            <div className="order-2 space-y-3 p-4 sm:p-5 lg:order-1">
            <div className="space-y-1.5">
              <h2 className="text-[15px] font-semibold tracking-tight">What should I do next?</h2>
              {/*
                The status line used to be squeezed onto the badge row, where it wrapped under a phone
                and read as dim filler. It is real information — streak, today's answers, minutes — so
                it gets its own line at a readable size and weight.
              */}
              {statusLine ? (
                <p className="text-[12.5px] leading-relaxed text-[var(--color-muted)]">{statusLine}</p>
              ) : null}
              <div className="flex flex-wrap items-center gap-2">
                <Badge tone={hasConnectedKey ? 'success' : hasAnyKey ? 'warning' : 'muted'}>
                  {hasConnectedKey ? 'AI connected' : hasAnyKey ? 'Keys not tested' : 'Sample mode — add a key in Settings'}
                </Badge>
              </div>
            </div>

            <div className="flex flex-wrap items-center gap-2">
              <Button
                variant="primary"
                icon={<ArrowRight size={15} />}
                onClick={() => navigate(primaryAction.href)}
              >
                {primaryAction.label}
              </Button>
              {primaryAction.secondary ? (
                <Button variant="secondary" icon={primaryAction.secondary.icon} onClick={() => navigate(primaryAction.secondary!.href)}>
                  {primaryAction.secondary.label}
                </Button>
              ) : null}
            </div>

            {continueItems.length ? (
              <div className="border-t border-[var(--color-border)] pt-3">
                <p className="mb-1.5 text-[11px] font-semibold uppercase tracking-wide text-[var(--color-muted-dim)]">
                  Continue learning
                </p>
                <ul className="space-y-1">
                  {continueItems.map((item) => (
                    <li key={item.id}>
                      <button
                        type="button"
                        onClick={() => navigate(item.href)}
                        className="vroqn-tap flex w-full items-center gap-2.5 rounded-[10px] px-2 py-2 text-left transition-colors hover:bg-white/[0.04]"
                      >
                        <span className="shrink-0 text-[var(--color-primary-soft)]">{item.icon}</span>
                        <span className="min-w-0 flex-1">
                          <span className="block truncate text-[13px]">{item.label}</span>
                          <span className="block truncate text-[11.5px] text-[var(--color-muted)]">{item.detail}</span>
                        </span>
                        <span className="shrink-0 text-[11px] text-[var(--color-muted-dim)]">{item.when}</span>
                      </button>
                    </li>
                  ))}
                </ul>
              </div>
            ) : null}
            </div>

            {/*
              The Study Core. Decorative by contract: `aria-hidden`, no pointer events, and the
              sentence above it ("What should I do next?" plus the primary action) carries the meaning.
              It is the only heavy-looking thing on the page and it costs no JavaScript per frame.
            */}
            <div className="order-1 px-2 pt-3 lg:order-2 lg:pb-0">
              <StudyCore className="h-[380px] w-full sm:h-[420px] lg:h-[500px]" />
            </div>
          </div>
        </Card>

        {/* ------------------------------- search ------------------------------- */}
        <SearchLauncher onOpen={() => setSearchOpen(true)} />

        {/* --------------------------- top communities --------------------------- */}
        <TopCommunities />

        {/* Headlines, full width: the only "outside world" content on the page. */}
        <NewsStrip />

        {/* --------------------------- first-run path ---------------------------- */}
        {isNewHere ? (
          <VroqnSection
            title="Your first three steps"
            description="Nothing here yet — that is normal for a new account. Each step below opens a real screen."
          >
            <ol className="grid gap-2.5 sm:grid-cols-3">
              {onboarding.map((step, index) => (
                <li key={step.id}>
                  <Link
                    to={step.href}
                    className="vroqn-lift flex h-full flex-col gap-2 rounded-[var(--radius-card)] border border-[var(--color-border)] bg-[var(--color-card)] p-3.5 transition-colors hover:border-[var(--color-primary)]/45"
                  >
                    <span className="flex items-center gap-2 text-[11px] font-semibold uppercase tracking-wide text-[var(--color-muted-dim)]">
                      <span className="grid h-5 w-5 place-items-center rounded-full border border-[var(--color-primary)]/40 text-[11px] text-[var(--color-primary)]">
                        {index + 1}
                      </span>
                      {step.kicker}
                    </span>
                    <span className="text-[13.5px] font-semibold">{step.title}</span>
                    <span className="text-[12px] leading-relaxed text-[var(--color-muted)]">{step.detail}</span>
                    <span className="mt-auto inline-flex items-center gap-1 text-[12px] text-[var(--color-primary)]">
                      {step.cta} <ArrowRight size={13} />
                    </span>
                  </Link>
                </li>
              ))}
            </ol>
          </VroqnSection>
        ) : null}

        {error ? <ErrorState message={error} onRetry={load} /> : null}

        {arena && (arena.live > 0 || arena.open > 0 || arena.next) ? (
          <section aria-labelledby="arena-nudge">
            <h2 id="arena-nudge" className="sr-only">
              Arena
            </h2>
            <Card className="flex flex-wrap items-center gap-3 border-[var(--color-primary)]/25 bg-[var(--color-primary)]/[0.05] p-3.5">
              <span className="grid h-9 w-9 shrink-0 place-items-center rounded-[10px] border border-[var(--color-primary)]/40 bg-[var(--color-primary)]/10 text-[var(--color-primary)]">
                <Trophy size={16} />
              </span>
              <div className="min-w-0 flex-1">
                <p className="text-[13.5px] font-medium">
                  {arena.live > 0
                    ? `${arena.live} Arena competition${arena.live > 1 ? 's are' : ' is'} live now`
                    : arena.open > 0
                      ? `${arena.open} Arena competition${arena.open > 1 ? 's are' : ' is'} open for registration`
                      : 'Arena: your next competition'}
                </p>
                <p className="mt-0.5 truncate text-[12px] text-[var(--color-muted)]">
                  {arena.live > 0
                    ? 'Write the paper under a real clock — you get a benchmark and a full analysis afterwards.'
                    : arena.open > 0
                      ? 'Register now; the paper opens at the scheduled time.'
                      : `Next up: ${arena.next?.title ?? 'a new competition'} · ${arena.next ? new Date(arena.next.startsAt).toLocaleString(undefined, { day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit' }) : ''}`}
                </p>
              </div>
              <div className="flex items-center gap-2">
                {arena.completed > 0 ? (
                  <Badge tone="neutral">
                    {arena.completed} completed · {arena.registered} registered
                  </Badge>
                ) : null}
                <Button size="sm" variant="primary" onClick={() => navigate('/arena')}>
                  Open Arena
                </Button>
              </div>
            </Card>
          </section>
        ) : null}

      </PageBody>

      <SearchOverlay open={searchOpen} onClose={() => setSearchOpen(false)} />
    </>
  );
}

export default DashboardPage;
