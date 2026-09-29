/**
 * Challenges (§21) and Study Plans (§24).
 *
 * Both are the same idea with a different clock: a challenge is a run of days a student ticks off, a
 * plan is an ordered list of tasks. They share one component because the interaction — "open the card,
 * tick today's item" — is identical, and duplicating it would mean two places to fix.
 */
import { useState } from 'react';
import { Flame, ListChecks, Plus, Target, Trash2 } from 'lucide-react';
import { Badge, Button, Card, EmptyState, ErrorState, Modal, ProgressBar, SkeletonCard, TextInput } from '../../../components/ui';
import { useConfirm } from '../../../components/Confirm';
import { CommunitySection } from '../components';
import { communitiesApi, type ChallengeView, type CommunityDetail, type StudyPlanView } from '../api';
import { useAction, useRemote } from '../useCommunities';

export function ChallengesTab({ community, section = 'challenges' }: { community: CommunityDetail; section?: 'challenges' | 'plans' }) {
  return section === 'plans' ? <PlansSection community={community} /> : <ChallengesSection community={community} />;
}

/* ------------------------------------------------------------------ challenges ------------------ */

function ChallengesSection({ community }: { community: CommunityDetail }) {
  const challenges = useRemote<{ challenges: ChallengeView[] }>(`/communities/${community.id}/challenges`);
  const { busy, run } = useAction();
  const confirm = useConfirm();
  const [composerOpen, setComposerOpen] = useState(false);
  const [ticking, setTicking] = useState<string | null>(null);

  const tick = async (challenge: ChallengeView, dayIndex: number, done: boolean) => {
    const key = `${challenge.id}:${dayIndex}`;
    setTicking(key);
    const updated = await run(() => communitiesApi.setChallengeDay(community.id, challenge.id, dayIndex, done), {
      failure: done ? 'Could not save that day' : 'Could not undo that day',
    });
    setTicking(null);
    if (updated) {
      challenges.set((current) => ({
        challenges: (current?.challenges ?? []).map((item) => (item.id === updated.id ? updated : item)),
      }));
    }
  };

  const remove = async (challenge: ChallengeView) => {
    const ok = await confirm({
      title: `Delete “${challenge.title}”?`,
      description: 'Everyone loses their progress on this challenge. This cannot be undone.',
      confirmLabel: 'Delete challenge',
      tone: 'danger',
    });
    if (!ok) return;
    const done = await run(() => communitiesApi.deleteChallenge(community.id, challenge.id), {
      success: 'Challenge deleted',
      failure: 'Could not delete that challenge',
    });
    if (done) void challenges.refresh();
  };

  if (challenges.loading && !challenges.data) {
    return (
      <div className="space-y-2">
        {[0, 1].map((index) => (
          <SkeletonCard key={index} lines={4} />
        ))}
      </div>
    );
  }
  if (challenges.error) {
    return <ErrorState title="Could not load challenges" message={challenges.error} onRetry={() => void challenges.refresh()} />;
  }

  const list = challenges.data?.challenges ?? [];

  return (
    <div className="space-y-4">
      <CommunitySection
        title="Challenges"
        description="A run of days with one thing to do each day. Tick them off as you go — your progress is saved against your own account."
        action={
          <Button size="sm" variant="secondary" icon={<Plus size={14} />} onClick={() => setComposerOpen(true)}>
            Start a challenge
          </Button>
        }
      >
        {list.length === 0 ? (
          <EmptyState
            icon={<Flame size={22} />}
            title="No challenges running"
            description="A 7-day challenge on one chapter is the easiest way to get a group moving. Set one up and invite the community."
          />
        ) : (
          <div className="grid gap-3 md:grid-cols-2">
            {list.map((challenge) => (
              <Card key={challenge.id} className="space-y-3 p-4">
                <div className="flex flex-wrap items-center gap-2">
                  <Badge tone={challenge.status === 'active' ? 'success' : challenge.status === 'draft' ? 'muted' : 'warning'}>
                    {challenge.status === 'active' ? 'Running' : challenge.status === 'draft' ? 'Not started' : 'Finished'}
                  </Badge>
                  {challenge.subject ? <Badge tone="muted">{challenge.subject}</Badge> : null}
                  <span className="text-[11.5px] text-[var(--color-muted-dim)]">
                    {challenge.participantCount} {challenge.participantCount === 1 ? 'student' : 'students'}
                  </span>
                </div>

                <div>
                  <h3 className="text-[14px] font-semibold text-[var(--color-text)]">{challenge.title}</h3>
                  {challenge.description ? (
                    <p className="mt-1 text-[12.5px] text-[var(--color-muted)]">{challenge.description}</p>
                  ) : null}
                </div>

                <div>
                  <div className="flex items-center justify-between text-[11.5px] text-[var(--color-muted)]">
                    <span>
                      {challenge.completedDays.length} of {challenge.days.length} days
                    </span>
                    <span>{challenge.progressPercent}%</span>
                  </div>
                  <ProgressBar value={challenge.progressPercent / 100} className="mt-1.5" label={`${challenge.title} progress`} />
                </div>

                <div className="space-y-1.5">
                  {challenge.days.map((day) => {
                    const done = challenge.completedDays.includes(day.index);
                    return (
                      <label
                        key={day.index}
                        className="flex cursor-pointer items-start gap-2.5 rounded-lg border border-[var(--color-border)] px-2.5 py-2 hover:border-[var(--color-primary)]/40"
                      >
                        <input
                          type="checkbox"
                          checked={done}
                          disabled={!challenge.isJoined || ticking === `${challenge.id}:${day.index}`}
                          onChange={(event) => void tick(challenge, day.index, event.target.checked)}
                          className="mt-0.5 h-4 w-4 accent-[var(--color-primary)]"
                          aria-label={`Day ${day.index}: ${day.title}`}
                        />
                        <span className="min-w-0">
                          <span
                            className={[
                              'block text-[12.5px] font-medium',
                              done ? 'text-[var(--color-muted)] line-through' : 'text-[var(--color-text)]',
                            ].join(' ')}
                          >
                            Day {day.index} · {day.title}
                          </span>
                          {day.description ? (
                            <span className="mt-0.5 block text-[11.5px] text-[var(--color-muted)]">{day.description}</span>
                          ) : null}
                        </span>
                      </label>
                    );
                  })}
                </div>

                {!challenge.isJoined ? (
                  <p className="text-[11.5px] text-[var(--color-muted-dim)]">
                    This challenge has finished or you have not joined it, so the days are read-only.
                  </p>
                ) : null}

                {challenge.canDelete ? (
                  <Button size="sm" variant="ghost" icon={<Trash2 size={13} />} onClick={() => void remove(challenge)}>
                    Delete challenge
                  </Button>
                ) : null}
                {busy ? <span className="sr-only">Saving</span> : null}
              </Card>
            ))}
          </div>
        )}
      </CommunitySection>

      <StartChallenge
        communityId={community.id}
        open={composerOpen}
        onClose={() => setComposerOpen(false)}
        onCreated={() => {
          setComposerOpen(false);
          void challenges.refresh();
        }}
      />
    </div>
  );
}

function StartChallenge({
  communityId,
  open,
  onClose,
  onCreated,
}: {
  communityId: string;
  open: boolean;
  onClose: () => void;
  onCreated: () => void;
}) {
  const { busy, run } = useAction();
  const [title, setTitle] = useState('');
  const [description, setDescription] = useState('');
  const [subject, setSubject] = useState('');
  const [dayCount, setDayCount] = useState(7);
  const [days, setDays] = useState<string[]>(Array.from({ length: 7 }, () => ''));
  const [error, setError] = useState<string | null>(null);

  const resize = (next: number) => {
    const count = Math.min(Math.max(next, 1), 31);
    setDayCount(count);
    setDays((current) => Array.from({ length: count }, (_, index) => current[index] ?? ''));
  };

  const submit = async () => {
    setError(null);
    const filled = days.map((day, index) => ({ title: day.trim() || `Day ${index + 1}`, description: '' }));
    const now = Date.now();
    const created = await run(
      () =>
        communitiesApi.createChallenge(communityId, {
          title: title.trim(),
          description: description.trim(),
          subject: subject.trim() || null,
          startsAt: new Date(now).toISOString(),
          endsAt: new Date(now + dayCount * 86_400_000).toISOString(),
          days: filled.map((day) => ({ title: day.title, description: day.description })),
        }),
      { failure: 'Could not create the challenge' },
    );
    if (created) onCreated();
    else setError('Check the title (at least 4 characters) and try again.');
  };

  return (
    <Modal
      open={open}
      onClose={onClose}
      title="Start a challenge"
      description="One small task a day. Keep it achievable — a challenge people abandon helps nobody."
      size="lg"
      footer={
        <div className="flex justify-end gap-2">
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button variant="primary" loading={busy} disabled={title.trim().length < 4} onClick={submit}>
            Start challenge
          </Button>
        </div>
      }
    >
      <div className="space-y-3">
        <div>
          <label className="text-[12.5px] text-[var(--color-muted)]" htmlFor="challenge-title">
            Title
          </label>
          <TextInput
            id="challenge-title"
            value={title}
            onChange={(event) => setTitle(event.target.value)}
            maxLength={120}
            placeholder="7-day Current Electricity"
          />
        </div>
        <div className="grid gap-3 sm:grid-cols-2">
          <div>
            <label className="text-[12.5px] text-[var(--color-muted)]" htmlFor="challenge-subject">
              Subject (optional)
            </label>
            <TextInput id="challenge-subject" value={subject} onChange={(event) => setSubject(event.target.value)} placeholder="Physics" />
          </div>
          <div>
            <label className="text-[12.5px] text-[var(--color-muted)]" htmlFor="challenge-days">
              Number of days (1–31)
            </label>
            <TextInput
              id="challenge-days"
              value={String(dayCount)}
              inputMode="numeric"
              onChange={(event) => resize(Number(event.target.value.replace(/[^0-9]/g, '')) || 1)}
            />
          </div>
        </div>
        <div>
          <label className="text-[12.5px] text-[var(--color-muted)]" htmlFor="challenge-description">
            What is it for? (optional)
          </label>
          <textarea
            id="challenge-description"
            value={description}
            rows={2}
            maxLength={600}
            onChange={(event) => setDescription(event.target.value)}
            className="w-full rounded-xl border border-[var(--color-border)] bg-[var(--color-card)] px-3 py-2 text-[13px] text-[var(--color-text)]"
          />
        </div>
        <fieldset className="space-y-2">
          <legend className="text-[12.5px] text-[var(--color-muted)]">What to do each day</legend>
          <div className="max-h-64 space-y-2 overflow-y-auto pr-1">
            {days.map((day, index) => (
              <div key={index} className="flex items-center gap-2">
                <span className="w-12 shrink-0 text-[12px] text-[var(--color-muted-dim)]">Day {index + 1}</span>
                <TextInput
                  value={day}
                  maxLength={120}
                  aria-label={`Day ${index + 1} task`}
                  onChange={(event) => setDays((current) => current.map((item, i) => (i === index ? event.target.value : item)))}
                  placeholder="Solve 10 numericals"
                />
              </div>
            ))}
          </div>
        </fieldset>
        {error ? <p className="text-[12.5px] text-[var(--color-error)]">{error}</p> : null}
      </div>
    </Modal>
  );
}

/* ------------------------------------------------------------------ study plans ----------------- */

function PlansSection({ community }: { community: CommunityDetail }) {
  const plans = useRemote<{ plans: StudyPlanView[] }>(`/communities/${community.id}/plans`);
  const { busy, run } = useAction();
  const confirm = useConfirm();
  const [composerOpen, setComposerOpen] = useState(false);

  const toggle = async (plan: StudyPlanView, taskId: string, done: boolean) => {
    const updated = await run(() => communitiesApi.setPlanTask(community.id, plan.id, taskId, done), {
      failure: 'Could not save that',
    });
    if (updated) {
      plans.set((current) => ({ plans: (current?.plans ?? []).map((item) => (item.id === updated.id ? updated : item)) }));
    }
  };

  const remove = async (plan: StudyPlanView) => {
    const ok = await confirm({
      title: `Delete “${plan.title}”?`,
      description: 'Your ticked tasks go with it. This cannot be undone.',
      confirmLabel: 'Delete plan',
      tone: 'danger',
    });
    if (!ok) return;
    const done = await run(() => communitiesApi.deletePlan(community.id, plan.id), {
      success: 'Plan deleted',
      failure: 'Could not delete that plan',
    });
    if (done) void plans.refresh();
  };

  if (plans.loading && !plans.data) {
    return (
      <div className="space-y-2">
        {[0, 1].map((index) => (
          <SkeletonCard key={index} lines={4} />
        ))}
      </div>
    );
  }
  if (plans.error) {
    return <ErrorState title="Could not load study plans" message={plans.error} onRetry={() => void plans.refresh()} />;
  }

  const list = plans.data?.plans ?? [];

  return (
    <div className="space-y-4">
      <CommunitySection
        title="Study plans"
        description="A fixed order to work through, shared by the whole community. Everyone ticks their own copy."
        action={
          <Button size="sm" variant="secondary" icon={<Plus size={14} />} onClick={() => setComposerOpen(true)}>
            Create a plan
          </Button>
        }
      >
        {list.length === 0 ? (
          <EmptyState
            icon={<ListChecks size={22} />}
            title="No study plans yet"
            description="A plan answers “what do I do today?”. Lay out the chapters in the order they should be revised and everyone can follow it."
          />
        ) : (
          <div className="space-y-3">
            {list.map((plan) => (
              <Card key={plan.id} className="space-y-3 p-4">
                <div className="flex flex-wrap items-start justify-between gap-2">
                  <div className="min-w-0">
                    <h3 className="text-[14px] font-semibold text-[var(--color-text)]">{plan.title}</h3>
                    {plan.description ? (
                      <p className="mt-1 text-[12.5px] text-[var(--color-muted)]">{plan.description}</p>
                    ) : null}
                    <p className="mt-1 text-[11.5px] text-[var(--color-muted-dim)]">
                      {plan.authorName}
                      {plan.subject ? ` · ${plan.subject}` : ''} · {plan.tasks.length} tasks
                    </p>
                  </div>
                  <div className="w-32 shrink-0">
                    <p className="text-right text-[11.5px] text-[var(--color-muted)]">{plan.percent}%</p>
                    <ProgressBar value={plan.percent / 100} className="mt-1" label={`${plan.title} progress`} />
                  </div>
                </div>

                <ul className="space-y-1.5">
                  {plan.tasks.map((task) => (
                    <li key={task.id}>
                      <label className="flex cursor-pointer items-start gap-2.5 rounded-lg border border-[var(--color-border)] px-2.5 py-2 hover:border-[var(--color-primary)]/40">
                        <input
                          type="checkbox"
                          checked={task.done}
                          onChange={(event) => void toggle(plan, task.id, event.target.checked)}
                          className="mt-0.5 h-4 w-4 accent-[var(--color-primary)]"
                          aria-label={task.title}
                        />
                        <span className="min-w-0">
                          <span
                            className={[
                              'block text-[12.5px]',
                              task.done ? 'text-[var(--color-muted)] line-through' : 'text-[var(--color-text)]',
                            ].join(' ')}
                          >
                            Day {task.dayIndex} · {task.title}
                          </span>
                          {task.description ? (
                            <span className="mt-0.5 block text-[11.5px] text-[var(--color-muted)]">{task.description}</span>
                          ) : null}
                        </span>
                      </label>
                    </li>
                  ))}
                </ul>

                <div className="flex flex-wrap items-center gap-2">
                  <span className="inline-flex items-center gap-1 text-[11.5px] text-[var(--color-muted-dim)]">
                    <Target size={12} /> {plan.doneCount} of {plan.totalCount} done
                  </span>
                  {plan.canDelete ? (
                    <Button size="sm" variant="ghost" icon={<Trash2 size={13} />} onClick={() => void remove(plan)}>
                      Delete plan
                    </Button>
                  ) : null}
                  {busy ? <span className="sr-only">Saving</span> : null}
                </div>
              </Card>
            ))}
          </div>
        )}
      </CommunitySection>

      <CreatePlan
        communityId={community.id}
        open={composerOpen}
        onClose={() => setComposerOpen(false)}
        onCreated={() => {
          setComposerOpen(false);
          void plans.refresh();
        }}
      />
    </div>
  );
}

function CreatePlan({
  communityId,
  open,
  onClose,
  onCreated,
}: {
  communityId: string;
  open: boolean;
  onClose: () => void;
  onCreated: () => void;
}) {
  const { busy, run } = useAction();
  const [title, setTitle] = useState('');
  const [description, setDescription] = useState('');
  const [subject, setSubject] = useState('');
  const [tasks, setTasks] = useState([{ dayIndex: 1, title: '', description: '' }]);

  const addTask = () =>
    setTasks((current) => [...current, { dayIndex: current.length + 1, title: '', description: '' }]);

  const submit = async () => {
    const cleaned = tasks
      .map((task, index) => ({ dayIndex: index + 1, title: task.title.trim() || `Task ${index + 1}`, description: task.description.trim() }))
      .filter((task) => task.title.length > 0);
    const created = await run(
      () => communitiesApi.createPlan(communityId, { title: title.trim(), description: description.trim(), subject: subject.trim() || null, tasks: cleaned }),
      { failure: 'Could not create the plan' },
    );
    if (created) {
      setTitle('');
      setTasks([{ dayIndex: 1, title: '', description: '' }]);
      onCreated();
    }
  };

  return (
    <Modal
      open={open}
      onClose={onClose}
      title="Create a study plan"
      description="Ordered tasks the community can follow together."
      size="lg"
      footer={
        <div className="flex justify-end gap-2">
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button variant="primary" loading={busy} disabled={title.trim().length < 4} onClick={submit}>
            Create plan
          </Button>
        </div>
      }
    >
      <div className="space-y-3">
        <div>
          <label className="text-[12.5px] text-[var(--color-muted)]" htmlFor="plan-title">
            Title
          </label>
          <TextInput id="plan-title" value={title} onChange={(event) => setTitle(event.target.value)} maxLength={120} placeholder="Class 12 Physics — 30 day revision" />
        </div>
        <div className="grid gap-3 sm:grid-cols-2">
          <div>
            <label className="text-[12.5px] text-[var(--color-muted)]" htmlFor="plan-subject">
              Subject (optional)
            </label>
            <TextInput id="plan-subject" value={subject} onChange={(event) => setSubject(event.target.value)} placeholder="Physics" />
          </div>
          <div>
            <label className="text-[12.5px] text-[var(--color-muted)]" htmlFor="plan-description">
              One line about it (optional)
            </label>
            <TextInput id="plan-description" value={description} onChange={(event) => setDescription(event.target.value)} maxLength={300} />
          </div>
        </div>

        <fieldset className="space-y-2">
          <legend className="text-[12.5px] text-[var(--color-muted)]">Tasks</legend>
          {tasks.map((task, index) => (
            <div key={index} className="flex items-center gap-2">
              <span className="w-12 shrink-0 text-[12px] text-[var(--color-muted-dim)]">Day {index + 1}</span>
              <TextInput
                value={task.title}
                maxLength={140}
                aria-label={`Task ${index + 1}`}
                placeholder="Revise NCERT chapter 3 + 20 MCQs"
                onChange={(event) =>
                  setTasks((current) => current.map((item, i) => (i === index ? { ...item, title: event.target.value } : item)))
                }
              />
              {tasks.length > 1 ? (
                <Button
                  size="sm"
                  variant="ghost"
                  aria-label={`Remove task ${index + 1}`}
                  onClick={() => setTasks((current) => current.filter((_, i) => i !== index))}
                >
                  <Trash2 size={13} />
                </Button>
              ) : null}
            </div>
          ))}
          <Button size="sm" variant="secondary" icon={<Plus size={13} />} onClick={addTask} disabled={tasks.length >= 60}>
            Add a day
          </Button>
        </fieldset>
      </div>
    </Modal>
  );
}
