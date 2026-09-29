/**
 * Doubts (§10).
 *
 * A doubt board, not a forum: one question, answers underneath, and the asker marks the answer that
 * actually helped. That marked answer is what a moderator can promote into the knowledge base (§11),
 * which is how a community accumulates something reusable instead of an endless scroll of questions.
 */
import { useState } from 'react';
import { ArrowLeft, CheckCircle2, HelpCircle, Plus, Sparkles, Trash2 } from 'lucide-react';
import { Badge, Button, Card, EmptyState, ErrorState, Modal, SkeletonCard, TextInput } from '../../../components/ui';
import { VroqnFilterSelect } from '../../../components/vroqn';
import { useConfirm } from '../../../components/Confirm';
import { useToast } from '../../../hooks/useToast';
import { Composer, CommunitySection, RoleBadge } from '../components';
import { communitiesApi, type CommunityDetail, type DoubtAnswerView, type DoubtView } from '../api';
import { useAction, useDebounced, useRelativeTime, useRemote } from '../useCommunities';

export function DoubtsTab({ community }: { community: CommunityDetail }) {
  const [openDoubtId, setOpenDoubtId] = useState<string | null>(null);
  const [status, setStatus] = useState<'open' | 'solved' | 'all'>('open');
  const [search, setSearch] = useState('');
  const debounced = useDebounced(search, 350);
  const [composeOpen, setComposeOpen] = useState(false);

  const doubts = useRemote<{ doubts: DoubtView[]; total: number }>(
    openDoubtId
      ? null
      : `/communities/${community.id}/doubts?status=${status === 'all' ? '' : status}&search=${encodeURIComponent(debounced)}&limit=30`,
    [status, debounced],
  );

  if (openDoubtId) {
    return <DoubtDetail community={community} doubtId={openDoubtId} onBack={() => setOpenDoubtId(null)} />;
  }

  return (
    <div className="space-y-4">
      <div className="grid gap-2 sm:grid-cols-[1fr_auto_auto]">
        <div>
          <label className="sr-only" htmlFor="doubt-search">
            Search doubts
          </label>
          <TextInput
            id="doubt-search"
            value={search}
            onChange={(event) => setSearch(event.target.value)}
            placeholder="Search this community's doubts…"
          />
        </div>
        {/* §2: no OS picker anywhere in the product — this is the Vroqn filter control. */}
        <VroqnFilterSelect
          label="Filter doubts"
          value={status}
          onChange={setStatus}
          options={[
            { value: 'open', label: 'Unanswered', hint: 'Nobody has answered yet' },
            { value: 'solved', label: 'Answered', hint: 'Has an accepted answer' },
            { value: 'all', label: 'All' },
          ]}
        />
        <Button variant="primary" icon={<Plus size={15} />} onClick={() => setComposeOpen(true)}>
          Ask a doubt
        </Button>
      </div>

      {doubts.loading && !doubts.data ? (
        <div className="space-y-2">
          {[0, 1, 2].map((index) => (
            <SkeletonCard key={index} lines={3} />
          ))}
        </div>
      ) : doubts.error ? (
        <ErrorState title="Could not load doubts" message={doubts.error} onRetry={() => void doubts.refresh()} />
      ) : (doubts.data?.doubts.length ?? 0) === 0 ? (
        <EmptyState
          icon={<HelpCircle size={22} />}
          title={search ? 'No doubts match that search' : 'No doubts here yet'}
          description={
            search
              ? 'Try another word, or switch the filter to “All”.'
              : 'Ask the first question. Someone in this community has probably faced the same one.'
          }
          action={
            <Button variant="primary" icon={<Plus size={15} />} onClick={() => setComposeOpen(true)}>
              Ask a doubt
            </Button>
          }
        />
      ) : (
        <div className="space-y-2">
          {(doubts.data?.doubts ?? []).map((doubt) => (
            <button
              key={doubt.id}
              type="button"
              onClick={() => setOpenDoubtId(doubt.id)}
              className="w-full text-left"
            >
              <Card interactive className="space-y-1.5 p-3.5">
                <div className="flex flex-wrap items-center gap-2">
                  {doubt.status === 'solved' ? (
                    <Badge tone="success">
                      <span className="inline-flex items-center gap-1">
                        <CheckCircle2 size={11} /> Solved
                      </span>
                    </Badge>
                  ) : (
                    <Badge tone="muted">Unanswered</Badge>
                  )}
                  {doubt.subject ? <Badge tone="muted">{doubt.subject}</Badge> : null}
                  {doubt.topic ? <span className="text-[11.5px] text-[var(--color-muted-dim)]">{doubt.topic}</span> : null}
                </div>
                <p className="text-[13.5px] font-medium text-[var(--color-text)]">{doubt.title}</p>
                {doubt.description ? (
                  <p className="line-clamp-2 text-[12.5px] text-[var(--color-muted)]">{doubt.description}</p>
                ) : null}
                <p className="text-[11.5px] text-[var(--color-muted-dim)]">
                  {doubt.authorName} · {doubt.answerCount} {doubt.answerCount === 1 ? 'answer' : 'answers'} ·{' '}
                  {new Date(doubt.createdAt).toLocaleDateString(undefined, { day: 'numeric', month: 'short' })}
                </p>
              </Card>
            </button>
          ))}
        </div>
      )}

      <ComposeDoubt
        communityId={community.id}
        open={composeOpen}
        onClose={() => setComposeOpen(false)}
        onCreated={(created) => {
          setComposeOpen(false);
          void doubts.refresh();
          setOpenDoubtId(created.id);
        }}
      />
    </div>
  );
}

function ComposeDoubt({
  communityId,
  open,
  onClose,
  onCreated,
}: {
  communityId: string;
  open: boolean;
  onClose: () => void;
  onCreated: (doubt: DoubtView) => void;
}) {
  const { busy, run } = useAction();
  const [title, setTitle] = useState('');
  const [description, setDescription] = useState('');
  const [subject, setSubject] = useState('');
  const [topic, setTopic] = useState('');

  const valid = title.trim().length >= 5;

  const submit = async () => {
    const created = await run(
      () =>
        communitiesApi.createDoubt(communityId, {
          title: title.trim(),
          description: description.trim(),
          subject: subject.trim() || null,
          topic: topic.trim() || null,
        }),
      { failure: 'Your doubt was not posted' },
    );
    if (created) {
      setTitle('');
      setDescription('');
      setSubject('');
      setTopic('');
      onCreated(created);
    }
  };

  return (
    <Modal
      open={open}
      onClose={onClose}
      title="Ask a doubt"
      description="Describe where you got stuck, not just the question. That is what gets you a useful answer."
      footer={
        <div className="flex justify-end gap-2">
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button variant="primary" loading={busy} disabled={!valid} onClick={submit}>
            Post doubt
          </Button>
        </div>
      }
    >
      <div className="space-y-3">
        <div>
          <label className="text-[12.5px] text-[var(--color-muted)]" htmlFor="doubt-title">
            Your question
          </label>
          <TextInput
            id="doubt-title"
            value={title}
            onChange={(event) => setTitle(event.target.value)}
            maxLength={200}
            placeholder="Why does a capacitor block DC but pass AC?"
          />
        </div>
        <div>
          <label className="text-[12.5px] text-[var(--color-muted)]" htmlFor="doubt-description">
            What have you tried?
          </label>
          <textarea
            id="doubt-description"
            value={description}
            rows={4}
            maxLength={4000}
            onChange={(event) => setDescription(event.target.value)}
            placeholder="I understand the charging phase but I cannot see why the current keeps flowing."
            className="w-full rounded-xl border border-[var(--color-border)] bg-[var(--color-card)] px-3 py-2 text-[13px] text-[var(--color-text)]"
          />
        </div>
        <div className="grid gap-3 sm:grid-cols-2">
          <div>
            <label className="text-[12.5px] text-[var(--color-muted)]" htmlFor="doubt-subject">
              Subject (optional)
            </label>
            <TextInput id="doubt-subject" value={subject} onChange={(event) => setSubject(event.target.value)} placeholder="Physics" />
          </div>
          <div>
            <label className="text-[12.5px] text-[var(--color-muted)]" htmlFor="doubt-topic">
              Chapter (optional)
            </label>
            <TextInput id="doubt-topic" value={topic} onChange={(event) => setTopic(event.target.value)} placeholder="Current Electricity" />
          </div>
        </div>
      </div>
    </Modal>
  );
}

function DoubtDetail({
  community,
  doubtId,
  onBack,
}: {
  community: CommunityDetail;
  doubtId: string;
  onBack: () => void;
}) {
  const detail = useRemote<{ doubt: DoubtView; answers: DoubtAnswerView[] }>(`/communities/${community.id}/doubts/${doubtId}`);
  const { busy, run } = useAction();
  const toast = useToast();
  const confirm = useConfirm();
  const relative = useRelativeTime();

  const markHelpful = async (answer: DoubtAnswerView) => {
    const done = await run(() => communitiesApi.markHelpful(community.id, doubtId, answer.id), {
      success: 'Marked as the helpful answer',
      failure: 'Could not mark that answer',
    });
    if (done) {
      toast.push({ tone: 'info', title: 'The answerer earned contribution points' });
      void detail.refresh();
    }
  };

  const promote = async () => {
    const ok = await confirm({
      title: 'Add this to the knowledge base?',
      description:
        'The question, the helpful answer and the discussion are copied into the community knowledge base so future students find it. Nothing is removed from Doubts.',
      confirmLabel: 'Add to knowledge',
      tone: 'primary',
    });
    if (!ok) return;
    const created = await run(() => communitiesApi.promoteToKnowledge(community.id, doubtId), {
      success: 'Added to the knowledge base',
      failure: 'Could not add it to the knowledge base',
    });
    if (created) void detail.refresh();
  };

  const removeAnswer = async (answer: DoubtAnswerView) => {
    const ok = await confirm({
      title: 'Delete this answer?',
      description: 'It disappears for everyone and any contribution points it earned are returned.',
      confirmLabel: 'Delete answer',
      tone: 'danger',
    });
    if (!ok) return;
    const done = await run(() => communitiesApi.deleteAnswer(community.id, answer.id), {
      success: 'Answer deleted',
      failure: 'Could not delete that answer',
    });
    if (done) void detail.refresh();
  };

  if (detail.loading && !detail.data) {
    return <SkeletonCard lines={6} />;
  }
  if (detail.error || !detail.data) {
    return (
      <div className="space-y-3">
        <Button variant="ghost" icon={<ArrowLeft size={14} />} onClick={onBack}>
          Back to doubts
        </Button>
        <ErrorState title="Could not open this doubt" message={detail.error ?? 'It may have been removed.'} onRetry={() => void detail.refresh()} />
      </div>
    );
  }

  const { doubt, answers } = detail.data;

  return (
    <div className="space-y-4">
      <Button variant="ghost" icon={<ArrowLeft size={14} />} onClick={onBack}>
        Back to doubts
      </Button>

      <Card className="space-y-2 p-4">
        <div className="flex flex-wrap items-center gap-2">
          {doubt.status === 'solved' ? <Badge tone="success">Solved</Badge> : <Badge tone="muted">Open</Badge>}
          {doubt.subject ? <Badge tone="muted">{doubt.subject}</Badge> : null}
          {doubt.topic ? <span className="text-[11.5px] text-[var(--color-muted-dim)]">{doubt.topic}</span> : null}
        </div>
        <h2 className="text-[16px] font-semibold text-[var(--color-text)]">{doubt.title}</h2>
        {doubt.description ? (
          <p className="whitespace-pre-wrap text-[13px] leading-relaxed text-[var(--color-muted)]">{doubt.description}</p>
        ) : null}
        <p className="text-[11.5px] text-[var(--color-muted-dim)]">
          Asked by {doubt.authorName} · {relative(doubt.createdAt)}
        </p>
      </Card>

      <CommunitySection
        title={`${answers.length} ${answers.length === 1 ? 'answer' : 'answers'}`}
        description="The asker marks the answer that helped. Marked answers can be added to the knowledge base."
        action={
          doubt.helpfulAnswerId && doubt.canModerate ? (
            <Button size="sm" variant="secondary" icon={<Sparkles size={14} />} loading={busy} onClick={promote}>
              Add to knowledge base
            </Button>
          ) : null
        }
      >
        {answers.length === 0 ? (
          <EmptyState
            icon={<HelpCircle size={20} />}
            title="No answers yet"
            description="No answers yet. If you know this one, answering it is the fastest way to help the whole community — and it earns contribution points."
          />
        ) : (
          <div className="space-y-2">
            {answers.map((answer) => (
              <Card
                key={answer.id}
                className={[
                  'space-y-2 p-3.5',
                  answer.isHelpful ? 'border-[var(--color-success)]/35 bg-[var(--color-success)]/[0.05]' : '',
                ].join(' ')}
              >
                <div className="flex flex-wrap items-center gap-2">
                  <span className="text-[12.5px] font-semibold text-[var(--color-text)]">{answer.authorName}</span>
                  <RoleBadge role={answer.authorRole} />
                  {answer.isHelpful ? (
                    <Badge tone="success">
                      <span className="inline-flex items-center gap-1">
                        <CheckCircle2 size={11} /> Helpful answer
                      </span>
                    </Badge>
                  ) : null}
                  <time className="text-[11px] text-[var(--color-muted-dim)]">{relative(answer.createdAt)}</time>
                </div>
                <p className="whitespace-pre-wrap text-[13px] leading-relaxed text-[var(--color-text)]">{answer.body}</p>
                <div className="flex flex-wrap items-center gap-2">
                  {answer.canMarkHelpful && !answer.isHelpful ? (
                    <Button size="sm" variant="secondary" loading={busy} onClick={() => void markHelpful(answer)}>
                      This answered my question
                    </Button>
                  ) : null}
                  {answer.canDelete ? (
                    <Button size="sm" variant="ghost" icon={<Trash2 size={13} />} onClick={() => void removeAnswer(answer)}>
                      Delete
                    </Button>
                  ) : null}
                </div>
              </Card>
            ))}
          </div>
        )}
      </CommunitySection>

      <Card className="p-4">
        <Composer
          placeholder="Write an answer. Explain the idea, not only the final value."
          submitLabel="Post answer"
          maxLength={6000}
          minRows={3}
          busy={busy}
          onSubmit={async (value) => {
            const done = await run(() => communitiesApi.answerDoubt(community.id, doubtId, value), {
              success: 'Answer posted',
              failure: 'Your answer was not posted',
            });
            if (done) void detail.refresh();
          }}
        />
      </Card>
    </div>
  );
}
