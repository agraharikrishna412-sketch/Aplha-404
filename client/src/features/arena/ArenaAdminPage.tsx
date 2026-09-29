/**
 * Arena admin console.
 *
 * Deliberately small and operational: schedule a competition, generate the paper (AI-assisted with a
 * bank-only fallback that works offline), review the generated questions, then drive the lifecycle —
 * open registration → start → close submissions → publish results → archive.
 * Visible only to organisers — accounts flagged as staff in the database, or on the
 * ARENA_ADMIN_EMAILS allowlist. Either way the server enforces it; the nav entry is only a shortcut.
 * `npm run make:admin -- <email>` grants the flag.
 */
import { useEffect, useMemo, useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import {
  AlertTriangle,
  ArrowLeft,
  CheckCircle2,
  Clock,
  Flag,
  Play,
  RefreshCw,
  Send,
  Settings2,
  ShieldAlert,
  Sparkles,
  Trash2,
  Trophy,
  Unlock,
} from 'lucide-react';
import { PageBody, PageHeader } from '../../components/AppShell';
import {
  Badge,
  Button,
  Card,
  CardHeader,
  ErrorState,
  Field,
  LoadingState,
  Modal,
  Segmented,
  StatTile,
  TextArea,
  TextInput,
} from '../../components/ui';
import { useToast } from '../../hooks/useToast';
import { formatDateTimeLong, stateMeta } from '../../lib/arena';
import { api } from '../../lib/api';
import { useAdminCompetitions, useAdminQuestions } from './useArena';
import { StateBadge } from './components';
import type { ArenaAdminQuestion, ArenaCompetitionSummary } from '../../types';
import { VroqnFilterSelect } from '../../components/vroqn';

interface PresetEntry {
  id: string;
  label: string;
}

export function ArenaAdminPage() {
  const { data, loading, error, refresh } = useAdminCompetitions();
  const { push } = useToast();
  const [params, setParams] = useSearchParams();
  const [selected, setSelected] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [createOpen, setCreateOpen] = useState(false);
  const [extendOpen, setExtendOpen] = useState(false);
  const [extendMinutes, setExtendMinutes] = useState(15);
  const [bankOnly, setBankOnly] = useState(false);

  // "Create a competition" on the Arena home links here with ?create=1 so the two entry points agree
  // on what the organiser meant. The param is dropped right after, so refresh/back does not re-open it.
  useEffect(() => {
    if (params.get('create') !== '1') return;
    setCreateOpen(true);
    const next = new URLSearchParams(params);
    next.delete('create');
    setParams(next, { replace: true });
  }, [params, setParams]);

  const competitions = data?.competitions ?? [];
  const active = competitions.find((item) => item.id === selected) ?? null;
  const presets: PresetEntry[] = useMemo(
    () => [
      { id: 'foundation', label: 'Foundation (Class 9–10)' },
      { id: 'pre-jee', label: 'Pre-JEE' },
      { id: 'pre-neet', label: 'Pre-NEET' },
      { id: 'olympiad', label: 'Olympiad' },
      { id: 'custom', label: 'Custom (edit below)' },
    ],
    [],
  );

  async function action(competition: ArenaCompetitionSummary, name: string, extra: Record<string, unknown> = {}) {
    setBusy(`${name}-${competition.id}`);
    try {
      const result = await api.post<{ note: string; recalculated?: number }>(
        `/arena/admin/competitions/${competition.id}/action`,
        { action: name, ...extra },
      );
      push({
        tone: 'success',
        title: 'Action applied',
        detail: result.recalculated ? `${result.note} · ${result.recalculated} benchmark(s) recalculated.` : result.note,
      });
      await refresh();
    } catch (err) {
      push({ tone: 'error', title: 'Action failed', detail: (err as Error).message });
    } finally {
      setBusy(null);
    }
  }

  async function generate(competition: ArenaCompetitionSummary) {
    setBusy(`generate-${competition.id}`);
    try {
      const result = await api.post<{
        created: number;
        rejected: number;
        flagged: number;
        usedBank: boolean;
        totals: { total: number };
      }>(`/arena/admin/competitions/${competition.id}/generate`, { bankOnly, replace: true });
      push({
        tone: result.created ? 'success' : 'warning',
        title: `Paper generated: ${result.created} questions`,
        detail: `${result.rejected} rejected by validation · ${result.flagged} flagged for review · source: ${
          result.usedBank ? 'curated bank' : 'AI providers'
        }`,
      });
      await refresh();
    } catch (err) {
      push({ tone: 'error', title: 'Generation failed', detail: (err as Error).message });
    } finally {
      setBusy(null);
    }
  }

  if (loading && !data) {
    return (
      <PageBody>
        <LoadingState message="Loading the question queue…" />
      </PageBody>
    );
  }

  return (
    <>
      <PageHeader
        title="Arena console"
        badge={<Badge tone="warning">Admin</Badge>}
        description="Schedule competitions, generate and review papers, then run the lifecycle. Every window is enforced by the server clock."
        actions={
          <div className="flex flex-wrap items-center gap-2">
            <Link
              to="/arena"
              className="inline-flex h-10 items-center gap-1.5 rounded-[10px] border border-[var(--color-border)] bg-[var(--color-card)] px-3.5 text-sm hover:border-[var(--color-border-strong)]"
            >
              <ArrowLeft size={15} /> Student view
            </Link>
            <Button variant="primary" icon={<Settings2 size={15} />} onClick={() => setCreateOpen(true)}>
              New competition
            </Button>
          </div>
        }
      />

      <PageBody className="space-y-5">
        {error ? <ErrorState message={error} onRetry={() => void refresh()} /> : null}

        <Card className="p-4">
          <p className="text-[13px] font-semibold">Creating a competition, in order</p>
          <ol className="mt-3 grid gap-2 text-[12.5px] leading-relaxed text-[var(--color-muted)] lg:grid-cols-3">
            <li className="rounded-lg border border-[var(--color-border)] p-2.5">
              <span className="font-semibold text-[var(--color-text)]">1 · New competition.</span> Title, class level,
              duration, marks per question and the registration / exam / results windows. Saved as a draft — students
              see nothing yet.
            </li>
            <li className="rounded-lg border border-[var(--color-border)] p-2.5">
              <span className="font-semibold text-[var(--color-text)]">2 · Generate, then review.</span> Pick the paper in
              the list, generate questions (AI with a curated-bank fallback), then approve, flag or delete each one.
              Answers never reach a student before the paper closes.
            </li>
            <li className="rounded-lg border border-[var(--color-border)] p-2.5">
              <span className="font-semibold text-[var(--color-text)]">3 · Drive the lifecycle.</span> Open registration →
              start → close submissions → publish results → archive. The actions live on the selected competition; the
              server clock enforces every window, so a published state cannot be faked by the client.
            </li>
          </ol>
        </Card>

        <div className="grid gap-3 sm:grid-cols-3">
          <StatTile label="Competitions" value={competitions.length} icon={<Trophy size={15} />} />
          <StatTile
            label="Live"
            value={competitions.filter((item) => item.state === 'LIVE').length}
            icon={<Play size={15} />}
            tone="success"
          />
          <StatTile
            label="Awaiting review"
            value={competitions.reduce((sum, item) => sum + (item.reviewCounts?.pending ?? 0), 0)}
            icon={<Flag size={15} />}
            tone="warning"
            sub="Generated questions with no decision yet"
          />
        </div>

        <Card>
          <CardHeader
            title="Competitions"
            subtitle="Select one to generate its paper, review questions and move the lifecycle forward."
            right={
              <Button size="sm" variant="ghost" icon={<RefreshCw size={13} />} onClick={() => void refresh()}>
                Refresh
              </Button>
            }
          />
          <div className="overflow-x-auto px-4 pb-4">
            <table className="w-full min-w-[720px] border-separate border-spacing-y-2 text-left text-[13px]">
              <thead className="text-[11.5px] uppercase tracking-wide text-[var(--color-muted-dim)]">
                <tr>
                  <th className="px-2">Competition</th>
                  <th className="px-2">State</th>
                  <th className="px-2">Paper</th>
                  <th className="px-2">Starts</th>
                  <th className="px-2">Participants</th>
                  <th className="px-2">Review</th>
                </tr>
              </thead>
              <tbody>
                {competitions.map((competition) => (
                  <tr
                    key={competition.id}
                    className={[
                      'cursor-pointer bg-[var(--color-surface)] transition-colors hover:bg-[var(--color-card-hover)]',
                      selected === competition.id ? 'ring-1 ring-[var(--color-primary)]/50' : '',
                    ].join(' ')}
                    onClick={() => setSelected(competition.id)}
                  >
                    <td className="rounded-l-lg px-2 py-2.5">
                      <p className="font-medium">{competition.title}</p>
                      <p className="text-[11.5px] text-[var(--color-muted)]">
                        {competition.categoryLabel}
                        {competition.isDemo ? ' · demo' : ''}
                      </p>
                    </td>
                    <td className="px-2 py-2.5">
                      <StateBadge state={competition.state} />
                    </td>
                    <td className="px-2 py-2.5">
                      <span className={competition.questionCount ? '' : 'text-[var(--color-warning)]'}>
                        {competition.questionCount} questions
                      </span>
                    </td>
                    <td className="px-2 py-2.5 text-[12px] text-[var(--color-muted)]">
                      {formatDateTimeLong(competition.startsAt)}
                    </td>
                    <td className="px-2 py-2.5">{competition.participantCount}</td>
                    <td className="rounded-r-lg px-2 py-2.5">
                      {competition.reviewCounts ? (
                        <span className="flex flex-wrap items-center gap-1.5 text-[12px] text-[var(--color-muted)]">
                          <span>
                            {competition.reviewCounts.approved}✓ / {competition.reviewCounts.pending}? /{' '}
                            {competition.reviewCounts.flagged}⚑
                          </span>
                          {competition.readiness ? (
                            <Badge tone={competition.readiness.ready ? 'success' : 'warning'}>
                              {competition.readiness.ready
                                ? 'paper ready'
                                : `${competition.readiness.approved}/${competition.readiness.required} approved`}
                            </Badge>
                          ) : null}
                        </span>
                      ) : (
                        <span className="text-[12px] text-[var(--color-muted-dim)]">—</span>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </Card>

        {active ? (
          <>
            <Card>
              <CardHeader
                title={active.title}
                subtitle={`${stateMeta(active.state).label} · ${active.questionCount} questions · ${active.participantCount} participants`}
                icon={<Settings2 size={16} />}
                right={
                  <div className="flex flex-wrap items-center gap-2">
                    <Button
                      size="sm"
                      variant="secondary"
                      icon={<Unlock size={13} />}
                      loading={busy === `open_registration-${active.id}`}
                      onClick={() => void action(active, 'open_registration')}
                    >
                      Open registration
                    </Button>
                    <Button
                      size="sm"
                      variant="secondary"
                      icon={<Play size={13} />}
                      loading={busy === `start_now-${active.id}`}
                      onClick={() => void action(active, 'start_now')}
                    >
                      Start now
                    </Button>
                    <Button
                      size="sm"
                      variant="ghost"
                      icon={<Clock size={13} />}
                      disabled={active.state !== 'LIVE'}
                      onClick={() => setExtendOpen(true)}
                    >
                      Extend window
                    </Button>
                    <Button
                      size="sm"
                      variant="secondary"
                      icon={<Send size={13} />}
                      loading={busy === `close_submissions-${active.id}`}
                      onClick={() => void action(active, 'close_submissions')}
                    >
                      Close submissions
                    </Button>
                    <Button
                      size="sm"
                      variant="primary"
                      icon={<Trophy size={13} />}
                      loading={busy === `publish_results-${active.id}`}
                      onClick={() => void action(active, 'publish_results')}
                    >
                      Publish results
                    </Button>
                    <Button
                      size="sm"
                      variant="ghost"
                      loading={busy === `archive-${active.id}`}
                      onClick={() => void action(active, 'archive')}
                    >
                      Archive
                    </Button>
                  </div>
                }
              />
              <div className="grid gap-3 px-4 pb-4 sm:grid-cols-2">
                <div className="rounded-xl border border-[var(--color-border)] bg-[var(--color-surface)] p-3 text-[12.5px]">
                  <p className="mb-1.5 font-semibold">Schedule</p>
                  <p className="text-[var(--color-muted)]">Registration closes: {formatDateTimeLong(active.registrationClosesAt)}</p>
                  <p className="text-[var(--color-muted)]">Starts: {formatDateTimeLong(active.startsAt)}</p>
                  <p className="text-[var(--color-muted)]">Ends: {formatDateTimeLong(active.endsAt)}</p>
                  <p className="mt-1.5 text-[var(--color-muted)]">
                    Marking: +{active.marksPerQuestion} / −{active.negativeMarks} · {active.durationMin} min · max{' '}
                    {active.maxScore}
                  </p>
                </div>
                <div className="rounded-xl border border-[var(--color-border)] bg-[var(--color-surface)] p-3">
                  <p className="mb-1.5 text-[12.5px] font-semibold">Paper</p>
                  <p className="text-[12.5px] text-[var(--color-muted)]">
                    {active.subjects.join(' · ')} · {active.questionCount} questions generated
                  </p>
                  <label className="mt-2 flex items-center gap-2 text-[12.5px] text-[var(--color-muted)]">
                    <input
                      type="checkbox"
                      checked={bankOnly}
                      onChange={(event) => setBankOnly(event.target.checked)}
                      className="h-4 w-4 accent-[var(--color-primary)]"
                    />
                    Bank-only (offline, no AI provider used)
                  </label>
                  <div className="mt-2 flex flex-wrap gap-2">
                    <Button
                      size="sm"
                      variant="primary"
                      icon={<Sparkles size={13} />}
                      loading={busy === `generate-${active.id}`}
                      onClick={() => void generate(active)}
                    >
                      Generate / regenerate paper
                    </Button>
                  </div>
                  {active.readiness && !active.readiness.ready ? (
                    <p className="mt-2 inline-flex items-start gap-1.5 text-[12px] text-[var(--color-warning)]">
                      <AlertTriangle size={12} className="mt-0.5 shrink-0" />
                      <span>
                        This paper cannot start yet — {active.readiness.blocker}. Students are blocked from entering
                        until every question is approved.
                      </span>
                    </p>
                  ) : active.readiness ? (
                    <p className="mt-2 inline-flex items-center gap-1.5 text-[12px] text-[var(--color-success)]">
                      <CheckCircle2 size={12} /> Paper ready — {active.readiness.approved} approved questions.
                    </p>
                  ) : null}
                </div>
              </div>
            </Card>

            <ArenaQuestionReview competitionId={active.id} onChanged={() => void refresh()} />
          </>
        ) : (
          <Card className="p-4 text-[13px] text-[var(--color-muted)]">
            Select a competition above to manage it.
          </Card>
        )}
      </PageBody>

      <CreateCompetitionModal
        open={createOpen}
        presets={presets}
        onClose={() => setCreateOpen(false)}
        onCreated={() => {
          setCreateOpen(false);
          void refresh();
        }}
      />

      <Modal
        open={extendOpen}
        onClose={() => setExtendOpen(false)}
        title="Extend the writing window"
        description="Extends how long the competition stays open, so students who have not started yet still can. A paper already in progress keeps the deadline it was given when it started, so nobody gains time mid-exam."
        footer={
          <div className="flex flex-col gap-2 sm:flex-row sm:justify-end">
            <Button variant="ghost" onClick={() => setExtendOpen(false)}>
              Cancel
            </Button>
            <Button
              variant="primary"
              loading={busy === `extend-${active?.id}`}
              onClick={() => {
                if (!active) return;
                void action(active, 'start_now', { extendMinutes });
                setExtendOpen(false);
              }}
            >
              Extend by {extendMinutes} min
            </Button>
          </div>
        }
      >
        <Field label="Minutes to add" hint="Up to 120 minutes per action. Applies to the competition window.">
          <TextInput
            type="number"
            min={1}
            max={120}
            value={extendMinutes}
            onChange={(event) => setExtendMinutes(Number(event.target.value))}
          />
        </Field>
      </Modal>
    </>
  );
}

function ArenaQuestionReview({ competitionId, onChanged }: { competitionId: string; onChanged: () => void }) {
  const { data, loading, error, refresh } = useAdminQuestions(competitionId);
  const { push } = useToast();
  const [filter, setFilter] = useState<'all' | 'pending' | 'flagged' | 'rejected'>('pending');
  const [busy, setBusy] = useState<string | null>(null);

  const questions: ArenaAdminQuestion[] = data?.questions ?? [];
  const visible = useMemo(() => {
    if (filter === 'all') return questions;
    return questions.filter((question) => question.reviewStatus === filter);
  }, [filter, questions]);

  async function setStatus(question: ArenaAdminQuestion, reviewStatus: ArenaAdminQuestion['reviewStatus']) {
    setBusy(`${question.id}-${reviewStatus}`);
    try {
      await api.patch(`/arena/admin/questions/${question.id}?competitionId=${competitionId}`, { reviewStatus });
      await refresh();
    } catch (err) {
      push({ tone: 'error', title: 'Could not update question', detail: (err as Error).message });
    } finally {
      setBusy(null);
    }
  }

  async function remove(question: ArenaAdminQuestion) {
    setBusy(`${question.id}-delete`);
    try {
      await api.del(`/arena/admin/questions/${question.id}?competitionId=${competitionId}`);
      push({ tone: 'success', title: 'Question removed from paper' });
      await refresh();
      onChanged();
    } catch (err) {
      push({ tone: 'error', title: 'Could not remove question', detail: (err as Error).message });
    } finally {
      setBusy(null);
    }
  }

  return (
    <Card>
      <CardHeader
        title="Question review"
        subtitle={`${questions.length} questions in this paper`}
        icon={<ShieldAlert size={16} />}
        right={
          <Segmented<'all' | 'pending' | 'flagged' | 'rejected'>
            value={filter}
            size="sm"
            label="Filter questions"
            onChange={setFilter}
            options={[
              { value: 'pending', label: 'Pending' },
              { value: 'flagged', label: 'Flagged' },
              { value: 'rejected', label: 'Rejected' },
              { value: 'all', label: 'All' },
            ]}
          />
        }
      />
      <div className="space-y-2.5 px-4 pb-4">
        {loading && !data ? <LoadingState message="Loading the question queue…" className="py-8" /> : null}
        {error ? <ErrorState message={error} onRetry={() => void refresh()} /> : null}
        {!loading && !visible.length ? (
          <p className="rounded-lg border border-[var(--color-border)] bg-[var(--color-surface)] p-3 text-[13px] text-[var(--color-muted)]">
            Nothing with status “{filter}”.
          </p>
        ) : null}

        {visible.map((question) => (
          <div key={question.id} className="rounded-xl border border-[var(--color-border)] bg-[var(--color-surface)] p-3">
            <div className="mb-2 flex flex-wrap items-center gap-2">
              <Badge tone="neutral">Q{question.position}</Badge>
              <Badge tone="muted">{question.subject}</Badge>
              <Badge tone={question.difficulty === 'easy' ? 'success' : question.difficulty === 'hard' ? 'error' : 'warning'}>
                {question.difficulty}
              </Badge>
              <Badge tone="muted">{question.source}</Badge>
              <Badge
                tone={
                  question.reviewStatus === 'approved'
                    ? 'success'
                    : question.reviewStatus === 'flagged'
                      ? 'warning'
                      : question.reviewStatus === 'rejected'
                        ? 'error'
                        : 'muted'
                }
              >
                {question.reviewStatus}
              </Badge>
              <span className="ml-auto text-[11.5px] text-[var(--color-muted-dim)]">{question.topic}</span>
            </div>

            <p className="text-[13.5px] leading-relaxed">{question.prompt}</p>

            {question.options?.length ? (
              <ul className="mt-2 grid gap-1 text-[12.5px] sm:grid-cols-2">
                {question.options.map((option) => (
                  <li
                    key={option}
                    className={
                      option === question.correctAnswer
                        ? 'rounded-lg border border-[var(--color-success)]/40 bg-[var(--color-success)]/[0.08] px-2.5 py-1.5'
                        : 'rounded-lg border border-[var(--color-border)] px-2.5 py-1.5 text-[var(--color-muted)]'
                    }
                  >
                    {option}
                  </li>
                ))}
              </ul>
            ) : (
              <p className="mt-2 rounded-lg border border-[var(--color-success)]/40 bg-[var(--color-success)]/[0.08] px-2.5 py-1.5 text-[12.5px]">
                Answer: {question.correctAnswer}
              </p>
            )}

            <p className="mt-2 text-[12.5px] leading-relaxed text-[var(--color-muted)]">{question.explanation}</p>
            {question.reviewNotes ? (
              <p className="mt-1.5 text-[12px] text-[var(--color-warning)]">Note: {question.reviewNotes}</p>
            ) : null}

            <div className="mt-2.5 flex flex-wrap gap-2">
              <Button
                size="sm"
                variant="success"
                icon={<CheckCircle2 size={13} />}
                loading={busy === `${question.id}-approved`}
                onClick={() => void setStatus(question, 'approved')}
              >
                Approve
              </Button>
              <Button
                size="sm"
                variant="secondary"
                icon={<Flag size={13} />}
                loading={busy === `${question.id}-flagged`}
                onClick={() => void setStatus(question, 'flagged')}
              >
                Flag
              </Button>
              <Button
                size="sm"
                variant="danger"
                icon={<AlertTriangle size={13} />}
                loading={busy === `${question.id}-rejected`}
                onClick={() => void setStatus(question, 'rejected')}
              >
                Reject
              </Button>
              <Button
                size="sm"
                variant="ghost"
                icon={<Trash2 size={13} />}
                loading={busy === `${question.id}-delete`}
                onClick={() => void remove(question)}
              >
                Remove from paper
              </Button>
            </div>
          </div>
        ))}
      </div>
    </Card>
  );
}

function CreateCompetitionModal({
  open,
  presets,
  onClose,
  onCreated,
}: {
  open: boolean;
  presets: PresetEntry[];
  onClose: () => void;
  onCreated: () => void;
}) {
  const { push } = useToast();
  const [busy, setBusy] = useState(false);
  const now = new Date();
  const plus = (minutes: number) => new Date(now.getTime() + minutes * 60_000).toISOString().slice(0, 16);

  const [form, setForm] = useState({
    title: '',
    category: presets[0]?.id ?? 'foundation',
    description: '',
    registrationOpensAt: plus(0),
    registrationClosesAt: plus(60 * 24),
    startsAt: plus(60 * 25),
    endsAt: plus(60 * 27),
    visibility: 'public' as 'public' | 'private',
    inviteCode: '',
  });

  function update<K extends keyof typeof form>(key: K, value: (typeof form)[K]) {
    setForm((current) => ({ ...current, [key]: value }));
  }

  async function submit() {
    setBusy(true);
    try {
      await api.post('/arena/admin/competitions', {
        title: form.title,
        description: form.description || 'A Vroqn Arena competition.',
        category: form.category,
        registrationOpensAt: new Date(form.registrationOpensAt).toISOString(),
        registrationClosesAt: new Date(form.registrationClosesAt).toISOString(),
        startsAt: new Date(form.startsAt).toISOString(),
        endsAt: new Date(form.endsAt).toISOString(),
        visibility: form.visibility,
        inviteCode: form.visibility === 'private' ? form.inviteCode || undefined : undefined,
      });
      push({
        tone: 'success',
        title: 'Competition created',
        detail: 'Generate its paper next, then move it through the lifecycle.',
      });
      onCreated();
    } catch (err) {
      push({ tone: 'error', title: 'Could not create competition', detail: (err as Error).message });
    } finally {
      setBusy(false);
    }
  }

  return (
    <Modal
      open={open}
      onClose={onClose}
      title="New competition"
      description="The blueprint preset fixes subjects, counts, difficulty and marking. Everything stays editable later."
      footer={
        <div className="flex flex-col gap-2 sm:flex-row sm:justify-end">
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button variant="primary" loading={busy} disabled={form.title.trim().length < 4} onClick={() => void submit()}>
            Create competition
          </Button>
        </div>
      }
    >
      <div className="space-y-3">
        <Field label="Title" hint="Shown to students. Keep it short.">
          <TextInput value={form.title} onChange={(event) => update('title', event.target.value)} placeholder="Unit Test — Physics" />
        </Field>
        <Field label="Blueprint preset">
          <VroqnFilterSelect
            label="Blueprint preset"
            value={form.category}
            onChange={(next) => update('category', next)}
            placeholder="Choose a preset"
            options={presets.map((preset) => ({ value: preset.id, label: preset.label }))}
          />
        </Field>
        <Field label="Description">
          <TextArea
            rows={2}
            value={form.description}
            onChange={(event) => update('description', event.target.value)}
            placeholder="What this paper covers and who should take it."
          />
        </Field>
        <div className="grid gap-3 sm:grid-cols-2">
          <Field label="Registration opens">
            <TextInput
              type="datetime-local"
              value={form.registrationOpensAt}
              onChange={(event) => update('registrationOpensAt', event.target.value)}
            />
          </Field>
          <Field label="Registration closes">
            <TextInput
              type="datetime-local"
              value={form.registrationClosesAt}
              onChange={(event) => update('registrationClosesAt', event.target.value)}
            />
          </Field>
          <Field label="Paper starts">
            <TextInput type="datetime-local" value={form.startsAt} onChange={(event) => update('startsAt', event.target.value)} />
          </Field>
          <Field label="Paper ends">
            <TextInput type="datetime-local" value={form.endsAt} onChange={(event) => update('endsAt', event.target.value)} />
          </Field>
        </div>
        <Field label="Visibility">
          <VroqnFilterSelect
            label="Visibility"
            value={form.visibility}
            onChange={(next) => update('visibility', next)}
            options={[
              { value: 'public', label: 'Public', hint: 'Anyone can register' },
              { value: 'private', label: 'Invite only', hint: 'Needs a code' },
            ]}
          />
        </Field>
        {form.visibility === 'private' ? (
          <Field label="Invite code" hint="4–24 characters. Share it only with the intended students.">
            <TextInput value={form.inviteCode} onChange={(event) => update('inviteCode', event.target.value)} />
          </Field>
        ) : null}
      </div>
    </Modal>
  );
}

export default ArenaAdminPage;
