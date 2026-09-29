/**
 * Community competitions (§13–§17).
 *
 * This tab hosts competitions, it does not implement them. Entering one hands the student to Arena's
 * existing runner, which owns the clock, the paper, submission and scoring. The copy is explicit that
 * these are Vroqn-created papers and not official JEE/NEET examinations.
 */
import { useState } from 'react';
import { Link } from 'react-router-dom';
import { CalendarClock, Info, Plus, ShieldCheck, Trash2, Trophy, Users } from 'lucide-react';
import { Badge, Button, Card, EmptyState, ErrorState, Modal, SkeletonCard, TextArea, TextInput } from '../../../components/ui';
import { useConfirm } from '../../../components/Confirm';
import { NumberField } from './NumberField';
import {
  datesToWindow,
  defaultDates,
  describeInstant,
  describeLength,
  hoursToWindow,
  scheduleProblem,
} from './schedule';
import { VroqnFilterSelect } from '../../../components/vroqn';
import { useToast } from '../../../hooks/useToast';
import { CommunitySection } from '../components';
import { communitiesApi, type CommunityCompetitionView, type CommunityDetail } from '../api';
import { useAction, useCountdown, useRemote } from '../useCommunities';

export function CompetitionsTab({ community }: { community: CommunityDetail }) {
  const competitions = useRemote<{ competitions: CommunityCompetitionView[] }>(`/communities/${community.id}/competitions`);
  const { busy, run } = useAction();
  const [composerOpen, setComposerOpen] = useState(false);
  const confirm = useConfirm();
  const canHost = Boolean(community.capabilities.create_competition);

  /**
   * Removing a community competition.
   *
   * This was the missing control: the server route existed from the start, the UI never offered it, so
   * a host who scheduled the wrong paper had no way back. It removes the hosting link — the paper row
   * itself stays in Arena, where an organiser can still see it under "manage papers", which is the
   * honest split: a community can stop hosting something without silently deleting an exam that may
   * already have attempts.
   */
  const remove = async (competition: CommunityCompetitionView) => {
    const ok = await confirm({
      title: `Remove "${competition.title}" from ${community.name}?`,
      description:
        'It disappears from this community and nobody else can register. Any attempt already in progress is decided by Arena, not by this. You can host it again from scratch.',
      confirmLabel: 'Remove from community',
      tone: 'danger',
    });
    if (!ok) return;
    const result = await run(() => communitiesApi.removeCompetition(community.id, competition.id), {
      success: 'Removed from this community',
      failure: 'Could not remove it',
    });
    if (result) void competitions.refresh();
  };

  const register = async (competition: CommunityCompetitionView) => {
    const result = await run(() => communitiesApi.registerCompetition(community.id, competition.id), {
      success: 'You are registered',
      failure: 'Could not register you',
    });
    if (result) void competitions.refresh();
  };

  const withdraw = async (competition: CommunityCompetitionView) => {
    const result = await run(() => communitiesApi.withdrawCompetition(community.id, competition.id), {
      success: 'You withdrew from this competition',
      failure: 'Could not withdraw you',
    });
    if (result) void competitions.refresh();
  };

  if (competitions.loading && !competitions.data) {
    return (
      <div className="space-y-2">
        {[0, 1].map((index) => (
          <SkeletonCard key={index} lines={4} />
        ))}
      </div>
    );
  }
  if (competitions.error) {
    return <ErrorState title="Could not load competitions" message={competitions.error} onRetry={() => void competitions.refresh()} />;
  }

  const list = competitions.data?.competitions ?? [];

  return (
    <div className="space-y-4">
      <Card className="flex items-start gap-3 border-[var(--color-border)] p-3.5">
        <Info size={15} className="mt-0.5 shrink-0 text-[var(--color-primary)]" />
        <p className="text-[12.5px] leading-relaxed text-[var(--color-muted)]">
          These are <strong className="font-medium text-[var(--color-text)]">Vroqn-created competitive papers</strong> hosted by
          people in this community. They are practice competitions, not official JEE, NEET or board examinations. Papers are timed
          and scored on the server, answer keys are never sent before you submit, and only one submission is accepted.
        </p>
      </Card>

      <CommunitySection
        title="Hosted competitions"
        description="Enter through Arena. Your result, rank and analysis appear in your Arena history."
        action={
          community.capabilities.create_competition ? (
            <Button size="sm" variant="secondary" icon={<Plus size={14} />} onClick={() => setComposerOpen(true)}>
              Host a competition
            </Button>
          ) : null
        }
      >
        {list.length === 0 ? (
          <EmptyState
            icon={<Trophy size={22} />}
            title="No competitions hosted yet"
            description={
              community.capabilities.create_competition
                ? 'Host one to give the community something to aim at. You choose the subject, the number of questions and the window.'
                : 'When a moderator hosts a competition it will appear here, and you will get a notification.'
            }
          />
        ) : (
          <div className="grid gap-3 md:grid-cols-2">
            {list.map((competition) => (
              <CompetitionCard
                key={competition.id}
                competition={competition}
                community={community}
                busy={busy}
                canManage={canHost}
                onRegister={() => void register(competition)}
                onWithdraw={() => void withdraw(competition)}
                onRemove={() => void remove(competition)}
              />
            ))}
          </div>
        )}
      </CommunitySection>

      <HostCompetition
        community={community}
        open={composerOpen}
        onClose={() => setComposerOpen(false)}
        onCreated={() => {
          setComposerOpen(false);
          void competitions.refresh();
        }}
      />
    </div>
  );
}

function CompetitionCard({
  competition,
  community,
  busy,
  canManage,
  onRegister,
  onWithdraw,
  onRemove,
}: {
  competition: CommunityCompetitionView;
  community: CommunityDetail;
  busy: boolean;
  canManage: boolean;
  onRegister: () => void;
  onWithdraw: () => void;
  onRemove: () => void;
}) {
  const countdown = useCountdown(competition.state === 'UPCOMING' ? competition.startsAt : null);
  const stateLabel =
    competition.state === 'LIVE'
      ? 'Live now'
      : competition.state === 'UPCOMING'
        ? 'Upcoming'
        : competition.state === 'RESULTS_PUBLISHED'
          ? 'Results published'
          : 'Ended';

  return (
    <Card className="space-y-3 p-4">
      <div className="flex flex-wrap items-center gap-2">
        <Badge tone={competition.state === 'LIVE' ? 'success' : competition.state === 'UPCOMING' ? 'primary' : 'muted'}>
          {stateLabel}
        </Badge>
        {competition.isDemo ? <Badge tone="warning">Practice paper</Badge> : null}
        <Badge tone="muted">{competition.difficulty}</Badge>
      </div>

      <div>
        <h3 className="text-[14px] font-semibold text-[var(--color-text)]">{competition.title}</h3>
        <p className="mt-1 line-clamp-2 text-[12.5px] text-[var(--color-muted)]">{competition.description}</p>
      </div>

      <ul className="grid grid-cols-2 gap-1.5 text-[12px] text-[var(--color-muted)]">
        <li className="inline-flex items-center gap-1.5">
          <Trophy size={12} /> {competition.questionCount} questions
        </li>
        <li className="inline-flex items-center gap-1.5">
          <CalendarClock size={12} /> {competition.durationMin} min
        </li>
        <li className="inline-flex items-center gap-1.5">
          <Users size={12} /> {competition.participantCount} registered
        </li>
        <li className="inline-flex items-center gap-1.5">
          <ShieldCheck size={12} /> server-timed
        </li>
      </ul>

      <p className="text-[11.5px] text-[var(--color-muted-dim)]">
        {competition.state === 'UPCOMING'
          ? `Starts ${countdown || new Date(competition.startsAt).toLocaleString()} · registration closes ${new Date(
              competition.startsAt,
            ).toLocaleDateString()}`
          : `Ran ${new Date(competition.startsAt).toLocaleDateString()} — ${new Date(competition.endsAt).toLocaleDateString()}`}
      </p>

      <div className="flex flex-wrap items-center gap-2">
        {competition.state === 'LIVE' && competition.isRegistered ? (
          competition.attemptState === 'submitted' && competition.resultId ? (
            <Link to={`/arena/results/${competition.resultId}`}>
              <Button size="sm" variant="primary">
                See your result
              </Button>
            </Link>
          ) : (
            <Link to={`/arena/${competition.id}/start`}>
              <Button size="sm" variant="primary">
                {competition.attemptState ? 'Continue the paper' : 'Start the paper'}
              </Button>
            </Link>
          )
        ) : competition.state === 'UPCOMING' && competition.isRegistered ? (
          <>
            <Badge tone="success">You are registered</Badge>
            <Button size="sm" variant="ghost" loading={busy} onClick={onWithdraw}>
              Withdraw
            </Button>
          </>
        ) : competition.state === 'UPCOMING' ? (
          <Button size="sm" variant="primary" loading={busy} onClick={onRegister}>
            Register
          </Button>
        ) : (
          <Link to={`/arena/${competition.id}`}>
            <Button size="sm" variant="secondary">
              View in Arena
            </Button>
          </Link>
        )}
        {competition.state === 'ENDED' && !competition.resultId ? (
          <span className="text-[11.5px] text-[var(--color-muted-dim)]">You did not take this paper.</span>
        ) : null}
        {/* Hosts and moderators only: the one control that was missing. */}
        {canManage ? (
          <Button
            size="sm"
            variant="ghost"
            className="ml-auto text-[var(--color-danger,#f87171)]"
            icon={<Trash2 size={13} />}
            onClick={onRemove}
          >
            Remove
          </Button>
        ) : null}
      </div>
      <p className="sr-only">Hosted by {community.name}</p>
    </Card>
  );
}

/**
 * Hosting a competition.
 *
 * The form is deliberately the same shape as Arena's blueprint: subject, question count, difficulty
 * mix, marks and duration. A host chooses the window; everything about how the paper runs is Arena's.
 */
function HostCompetition({
  community,
  open,
  onClose,
  onCreated,
}: {
  community: CommunityDetail;
  open: boolean;
  onClose: () => void;
  onCreated: () => void;
}) {
  const { busy, run } = useAction();
  const toast = useToast();
  const [title, setTitle] = useState('');
  const [subject, setSubject] = useState('Physics');
  const [chapters, setChapters] = useState('');
  const [count, setCount] = useState(10);
  const [durationMin, setDurationMin] = useState(30);
  const [difficulty, setDifficulty] = useState<'easy' | 'medium' | 'hard' | 'mixed'>('mixed');
  const [difficultySplit, setDifficultySplit] = useState({ easy: 35, medium: 45, hard: 20 });
  const [visibility, setVisibility] = useState<'public' | 'private' | 'invite_only'>('private');
  const [startsInHours, setStartsInHours] = useState(48);
  const [windowHours, setWindowHours] = useState(6);
  /*
   * Two ways to set the clock: quick hours from now, or the exact dates a school actually works with
   * ("registration opens Monday 9:00, exam Wednesday 10:00"). The date fields are seeded from the quick
   * values the first time the host switches over, so the switch never loses their schedule.
   */
  const [scheduleMode, setScheduleMode] = useState<'quick' | 'dates'>('quick');
  const [dates, setDates] = useState(() => defaultDates(48, 6));

  const schedule = scheduleMode === 'dates' ? datesToWindow(dates) : hoursToWindow(startsInHours, windowHours);
  /*
   * Two ways to get a paper, and the choice is the host's: let the generator write it, or bring your own.
   * An uploaded paper is rewritten question by question on the server before it runs, so the file the
   * host holds is not the paper students sit.
   */
  const [paperMode, setPaperMode] = useState<'ai' | 'upload'>('ai');
  const [paperText, setPaperText] = useState('');
  const [uploadNotice, setUploadNotice] = useState<string | null>(null);

  const uploadedLooksUsable = paperText.trim().length >= 40 && /answer\s*[:.\-]/i.test(paperText);
  const scheduleIssue = scheduleProblem(schedule);
  const valid =
    title.trim().length >= 4 &&
    count >= 1 &&
    count <= 60 &&
    !scheduleIssue &&
    (paperMode === 'ai' || uploadedLooksUsable);

  const submit = async () => {
    const { opens, closes, starts, ends } = schedule;
    const startsAt = new Date(starts);
    const endsAt = new Date(ends);
    const registrationOpensAt = new Date(opens);
    const registrationClosesAt = new Date(closes);

    const created = await run(
      () =>
        communitiesApi.createCompetition(community.id, {
          title: title.trim(),
          description: `Hosted by ${community.name}.`,
          category: community.category,
          difficulty,
          visibility,
          blueprint: {
            subjects: [
              {
                subject: subject.trim() || 'Physics',
                count,
                chapters: chapters
                  .split(',')
                  .map((chapter) => chapter.trim())
                  .filter(Boolean),
              },
            ],
            difficulty: difficultySplit,
            types: { mcq: 70, numerical: 20, conceptual: 10 },
            marksPerQuestion: 4,
            negativeMarks: 1,
            durationMin,
          },
          registrationOpensAt: registrationOpensAt.toISOString(),
          registrationClosesAt: registrationClosesAt.toISOString(),
          startsAt: startsAt.toISOString(),
          endsAt: endsAt.toISOString(),
        }),
      { failure: 'Could not create the competition' },
    );

    if (created?.id) {
      /*
       * Second step, same dialog: fill the paper. A competition with no questions cannot be started, so
       * leaving this to a later screen was the reason "hosting" felt half-done.
       */
      const outcome = await run(
        () =>
          communitiesApi.preparePaper(community.id, created.id, {
            mode: paperMode,
            text: paperMode === 'upload' ? paperText : undefined,
            subject: subject.trim() || 'Physics',
            blueprint: {
              subjects: [{ subject: subject.trim() || 'Physics', count, chapters: chapters.split(',').map((c) => c.trim()).filter(Boolean) }],
              difficulty: difficultySplit,
              types: { mcq: 70, numerical: 20, conceptual: 10 },
              marksPerQuestion: 4,
              negativeMarks: 1,
              durationMin,
            },
          }),
        { failure: 'The competition was created, but its paper could not be prepared' },
      );

      if (outcome) {
        toast.push({
          tone: outcome.ready ? 'success' : 'warning',
          title: outcome.ready ? `Paper ready — ${outcome.accepted} questions` : `Paper prepared: ${outcome.accepted} of ${outcome.required}`,
          detail: outcome.note,
        });
      }
      onCreated();
    }
  };

  return (
    <Modal
      open={open}
      onClose={onClose}
      title="Host a competition"
      description="A Vroqn-created practice paper, hosted by this community. Students enter it through Arena."
      size="lg"
      footer={
        <div className="flex justify-end gap-2">
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button variant="primary" loading={busy} disabled={!valid} onClick={submit}>
            Create competition
          </Button>
        </div>
      }
    >
      <div className="space-y-3">
        <div>
          <label className="text-[12.5px] text-[var(--color-muted)]" htmlFor="comp-title">
            Title
          </label>
          <TextInput
            id="comp-title"
            value={title}
            onChange={(event) => setTitle(event.target.value)}
            maxLength={140}
            placeholder="Sunday Physics Sprint"
          />
        </div>

        <div className="grid gap-3 sm:grid-cols-3">
          <div>
            <label className="text-[12.5px] text-[var(--color-muted)]" htmlFor="comp-subject">
              Subject
            </label>
            <TextInput id="comp-subject" value={subject} onChange={(event) => setSubject(event.target.value)} />
          </div>
          {/* The clamp-on-keystroke bug lived here: typing "180" produced 1 → 5 → 58 → 240. */}
          <NumberField id="comp-count" label="Questions" value={count} onChange={setCount} min={1} max={60} />
          <NumberField id="comp-duration" label="Duration (minutes)" value={durationMin} onChange={setDurationMin} min={5} max={240} />
        </div>

        <div>
          <label className="text-[12.5px] text-[var(--color-muted)]" htmlFor="comp-chapters">
            Chapters to draw from (optional, comma separated)
          </label>
          <TextInput
            id="comp-chapters"
            value={chapters}
            onChange={(event) => setChapters(event.target.value)}
            placeholder="Motion, Laws of Motion"
          />
        </div>

        {/*
          The paper. Two buttons, and the honest description of what each one means for secrecy.
        */}
        <div className="space-y-2 rounded-xl border border-[var(--color-border)] bg-[var(--color-surface)] p-3">
          <p className="text-[12.5px] font-medium text-[var(--color-text)]">Who writes the paper</p>
          <div className="grid gap-2 sm:grid-cols-2">
            <button
              type="button"
              onClick={() => setPaperMode('ai')}
              aria-pressed={paperMode === 'ai'}
              className={`rounded-lg border p-2.5 text-left text-[12.5px] transition ${
                paperMode === 'ai'
                  ? 'border-[var(--color-primary)] bg-[color-mix(in_srgb,var(--color-primary)_10%,transparent)]'
                  : 'border-[var(--color-border)] hover:border-[var(--color-border-strong)]'
              }`}
            >
              <span className="font-medium text-[var(--color-text)]">Vroqn AI writes it</span>
              <span className="mt-1 block text-[11.5px] text-[var(--color-muted)]">
                {count} questions from {subject.trim() || 'Physics'}
                {chapters.trim() ? ` · ${chapters}` : ''}. Generated and checked on the server.
              </span>
            </button>
            <button
              type="button"
              onClick={() => setPaperMode('upload')}
              aria-pressed={paperMode === 'upload'}
              className={`rounded-lg border p-2.5 text-left text-[12.5px] transition ${
                paperMode === 'upload'
                  ? 'border-[var(--color-primary)] bg-[color-mix(in_srgb,var(--color-primary)_10%,transparent)]'
                  : 'border-[var(--color-border)] hover:border-[var(--color-border-strong)]'
              }`}
            >
              <span className="font-medium text-[var(--color-text)]">I already have a paper</span>
              <span className="mt-1 block text-[11.5px] text-[var(--color-muted)]">
                Paste it (or upload a .txt/.csv/.md file). Every question is rewritten before it runs, so
                the file cannot be used as an answer key.
              </span>
            </button>
          </div>

          {paperMode === 'upload' ? (
            <div className="space-y-2">
              <TextArea
                id="comp-paper"
                value={paperText}
                onChange={(event) => {
                  setPaperText(event.target.value);
                  setUploadNotice(null);
                }}
                rows={6}
                placeholder={'1) What is the SI unit of force?\nA) Newton\nB) Joule\nC) Watt\nD) Pascal\nAnswer: A\n\n2) …'}
              />
              <div className="flex flex-wrap items-center gap-2">
                <label className="inline-flex h-9 cursor-pointer items-center rounded-lg border border-[var(--color-border)] px-3 text-[12.5px]">
                  Choose a file
                  <input
                    type="file"
                    accept=".txt,.csv,.md,text/plain,text/csv,text/markdown"
                    className="sr-only"
                    onChange={async (event) => {
                      const file = event.target.files?.[0];
                      if (!file) return;
                      if (file.size > 400_000) {
                        setUploadNotice('That file is larger than 400 KB — paste the questions instead.');
                        return;
                      }
                      const text = await file.text();
                      setPaperText(text);
                      setUploadNotice(`Read ${file.name} (${Math.round(file.size / 1024)} KB). It will be rewritten on the server.`);
                    }}
                  />
                </label>
                <span className="text-[11.5px] text-[var(--color-muted)]">
                  {uploadedLooksUsable ? 'Looks like a paper — good to go.' : 'Needs at least one “Answer: A” line.'}
                </span>
              </div>
              {uploadNotice ? <p className="text-[11.5px] text-[var(--color-primary)]">{uploadNotice}</p> : null}
            </div>
          ) : null}
        </div>

        <div className="grid gap-3 sm:grid-cols-2">
          <div>
            <span className="mb-1 block text-[12.5px] text-[var(--color-muted)]">When does it run</span>
            <div className="mb-2 inline-flex rounded-lg border border-[var(--color-border)] p-0.5" role="group" aria-label="Schedule mode">
              {(['quick', 'dates'] as const).map((mode) => (
                <button
                  key={mode}
                  type="button"
                  aria-pressed={scheduleMode === mode}
                  onClick={() => {
                    /* Switching to dates starts from whatever the hours currently say, never from stale ones. */
                    if (mode === 'dates') setDates(defaultDates(startsInHours, windowHours));
                    setScheduleMode(mode);
                  }}
                  className={`rounded-md px-3 py-1.5 text-[12.5px] transition-colors ${
                    scheduleMode === mode
                      ? 'bg-[var(--color-primary)] font-medium text-[var(--color-on-primary)]'
                      : 'text-[var(--color-muted)] hover:text-[var(--color-text)]'
                  }`}
                >
                  {mode === 'quick' ? 'In hours' : 'Exact dates'}
                </button>
              ))}
            </div>
          </div>
          <div>
            <span className="mb-1 block text-[12.5px] text-[var(--color-muted)]">Who can enter</span>
            <VroqnFilterSelect
              label="Who can enter"
              value={visibility}
              onChange={setVisibility}
              placeholder="Choose who can enter"
              options={[
                { value: 'private', label: 'Community members only', hint: 'Nobody outside this community sees it' },
                { value: 'public', label: 'Public', hint: 'Listed in Arena for everyone' },
                { value: 'invite_only', label: 'Invite only', hint: 'You share the join code' },
              ]}
            />
          </div>
          {scheduleMode === 'quick' ? (
            <div className="grid grid-cols-2 gap-2">
              <NumberField id="comp-start" label="Starts in (hours)" value={startsInHours} onChange={setStartsInHours} min={1} max={720} />
              <NumberField id="comp-window" label="Open for (hours)" value={windowHours} onChange={setWindowHours} min={1} max={72} />
            </div>
          ) : (
            <div className="space-y-2">
              <div className="grid gap-2 sm:grid-cols-2">
                <label className="block" htmlFor="comp-opens">
                  <span className="text-[12.5px] text-[var(--color-muted)]">Registration opens</span>
                  <TextInput
                    id="comp-opens"
                    type="datetime-local"
                    value={dates.opens}
                    onChange={(event) => setDates((current) => ({ ...current, opens: event.target.value }))}
                  />
                </label>
                <label className="block" htmlFor="comp-closes">
                  <span className="text-[12.5px] text-[var(--color-muted)]">Registration closes</span>
                  <TextInput
                    id="comp-closes"
                    type="datetime-local"
                    value={dates.closes}
                    onChange={(event) => setDates((current) => ({ ...current, closes: event.target.value }))}
                  />
                </label>
                <label className="block" htmlFor="comp-exam-start">
                  <span className="text-[12.5px] text-[var(--color-muted)]">Exam starts</span>
                  <TextInput
                    id="comp-exam-start"
                    type="datetime-local"
                    value={dates.starts}
                    onChange={(event) => setDates((current) => ({ ...current, starts: event.target.value }))}
                  />
                </label>
                <label className="block" htmlFor="comp-exam-end">
                  <span className="text-[12.5px] text-[var(--color-muted)]">Exam ends</span>
                  <TextInput
                    id="comp-exam-end"
                    type="datetime-local"
                    value={dates.ends}
                    onChange={(event) => setDates((current) => ({ ...current, ends: event.target.value }))}
                  />
                </label>
              </div>
              <Button variant="ghost" size="sm" onClick={() => setDates(defaultDates(startsInHours, windowHours))}>
                Reset to {startsInHours}h from now · {windowHours}h window
              </Button>
            </div>
          )}
        </div>

        {/* Both modes read back as the same window, so the host can see exactly what will be saved. */}
        <p className="text-[12px] text-[var(--color-muted)]" data-testid="schedule-summary">
          Registration: {describeInstant(schedule.opens)} → {describeInstant(schedule.closes)} · Exam:{' '}
          {describeInstant(schedule.starts)} · {describeLength(schedule)} window
        </p>
        {scheduleIssue ? (
          <p className="text-[12px] text-[var(--color-danger)]" role="alert">
            {scheduleIssue}
          </p>
        ) : null}

        <div className="space-y-2 rounded-xl border border-[var(--color-border)] bg-[var(--color-surface)] p-3">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <p className="text-[12.5px] font-medium text-[var(--color-text)]">Difficulty mix</p>
            <VroqnFilterSelect
              label="Overall difficulty"
              value={difficulty}
              onChange={setDifficulty}
              size="sm"
              placeholder="Mixed"
              options={[
                { value: 'easy', label: 'Easy' },
                { value: 'medium', label: 'Medium' },
                { value: 'hard', label: 'Hard' },
                { value: 'mixed', label: 'Mix all three' },
              ]}
            />
          </div>
          {(['easy', 'medium', 'hard'] as const).map((level) => (
            <div key={level} className="flex items-center gap-3">
              <label className="w-20 text-[12px] capitalize text-[var(--color-muted)]" htmlFor={`diff-${level}`}>
                {level}
              </label>
              <input
                id={`diff-${level}`}
                type="range"
                min={0}
                max={100}
                step={5}
                value={difficultySplit[level]}
                onChange={(event) => setDifficultySplit((current) => ({ ...current, [level]: Number(event.target.value) }))}
                className="flex-1 accent-[var(--color-primary)]"
              />
              <span className="w-10 text-right text-[12px] text-[var(--color-muted)]">{difficultySplit[level]}%</span>
            </div>
          ))}
          <p className="text-[11.5px] text-[var(--color-muted-dim)]">
            Percentages are normalised by Arena when the paper is generated — the counts always add up to the question count above.
          </p>
        </div>

        <p className="text-[12px] text-[var(--color-muted)]">
          Marking is +4 for correct, −1 for wrong, 0 for unanswered, exactly as Arena runs every other paper. You can see the
          generated paper in Arena and review it before students start if you are a paper reviewer.
        </p>
      </div>
    </Modal>
  );
}
