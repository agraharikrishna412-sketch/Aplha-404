/**
 * Question-by-question review for a submitted Arena paper.
 * Filters are the three questions a student actually asks: what did I get wrong, what did I skip, and
 * what did I get right (so they can stop re-reading things they already know).
 */
import { useMemo, useState } from 'react';
import { Check, Flag, MinusCircle, X } from 'lucide-react';
import { Badge, Card, EmptyState, Segmented } from '../../components/ui';
import { Markdown } from '../../components/Markdown';
import { compactMs } from '../../lib/arena';
import type { ArenaQuestionReviewItem } from '../../types';

type Filter = 'wrong' | 'skipped' | 'correct' | 'all';

export function ArenaReviewList({ review }: { review: ArenaQuestionReviewItem[] }) {
  const [filter, setFilter] = useState<Filter>('wrong');

  const counts = useMemo(
    () => ({
      wrong: review.filter((item) => !item.isCorrect && item.yourAnswer.trim()).length,
      skipped: review.filter((item) => !item.yourAnswer.trim()).length,
      correct: review.filter((item) => item.isCorrect).length,
      all: review.length,
    }),
    [review],
  );

  const visible = useMemo(() => {
    if (filter === 'all') return review;
    if (filter === 'correct') return review.filter((item) => item.isCorrect);
    if (filter === 'skipped') return review.filter((item) => !item.yourAnswer.trim());
    return review.filter((item) => !item.isCorrect && item.yourAnswer.trim());
  }, [filter, review]);

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <p className="text-[12.5px] text-[var(--color-muted)]">
          Answer key and explanations are shown because this competition has closed.
        </p>
        <Segmented<Filter>
          value={filter}
          size="sm"
          onChange={setFilter}
          label="Filter answers"
          options={[
            { value: 'wrong', label: `Wrong (${counts.wrong})` },
            { value: 'skipped', label: `Skipped (${counts.skipped})` },
            { value: 'correct', label: `Correct (${counts.correct})` },
            { value: 'all', label: `All (${counts.all})` },
          ]}
        />
      </div>

      {visible.length === 0 ? (
        <EmptyState
          icon={<Check size={20} />}
          title={filter === 'wrong' ? 'Nothing wrong in this paper' : 'Nothing to show here'}
          description="Switch the filter to review other questions."
        />
      ) : (
        <ul className="space-y-2.5">
          {visible.map((item) => (
            <Card as="li" key={item.id} className="p-4">
              <div className="mb-2 flex flex-wrap items-center gap-2">
                <Badge tone="neutral">Q{item.position}</Badge>
                <Badge tone={item.isCorrect ? 'success' : item.yourAnswer.trim() ? 'error' : 'warning'}>
                  {item.isCorrect ? 'Correct' : item.yourAnswer.trim() ? 'Wrong' : 'Skipped'}
                </Badge>
                <Badge tone="muted">{item.subject}</Badge>
                <Badge tone={item.difficulty === 'easy' ? 'success' : item.difficulty === 'hard' ? 'error' : 'warning'}>
                  {item.difficulty}
                </Badge>
                {item.marksAwarded !== 0 ? (
                  <span
                    className={`ml-auto text-[12.5px] font-semibold ${
                      item.marksAwarded > 0 ? 'text-[var(--color-success)]' : 'text-[var(--color-error)]'
                    }`}
                  >
                    {item.marksAwarded > 0 ? '+' : ''}
                    {item.marksAwarded} marks
                  </span>
                ) : (
                  <span className="ml-auto text-[12px] text-[var(--color-muted-dim)]">0 marks</span>
                )}
              </div>

              <p className="whitespace-pre-wrap text-[14px] leading-relaxed">{item.prompt}</p>

              <div className="mt-3 grid gap-2 sm:grid-cols-2">
                <AnswerBox
                  tone={item.isCorrect ? 'success' : 'error'}
                  label="Your answer"
                  value={item.yourAnswer.trim() || 'Not attempted'}
                  icon={item.isCorrect ? <Check size={12} /> : item.yourAnswer.trim() ? <X size={12} /> : <MinusCircle size={12} />}
                />
                <AnswerBox tone="primary" label="Correct answer" value={item.correctAnswer} icon={<Flag size={12} />} />
              </div>

              {item.explanation ? (
                <div className="mt-3 rounded-xl border border-[var(--color-border)] bg-[var(--color-surface)] p-3">
                  <p className="mb-1 text-[11.5px] font-semibold uppercase tracking-wide text-[var(--color-muted-dim)]">
                    Why
                  </p>
                  <Markdown content={item.explanation} className="text-[13px]" />
                </div>
              ) : null}

              <p className="mt-2 text-[11.5px] text-[var(--color-muted-dim)]">
                {item.topic} · {compactMs(item.timeSpentMs)} on this question
              </p>
            </Card>
          ))}
        </ul>
      )}
    </div>
  );
}

function AnswerBox({
  tone,
  label,
  value,
  icon,
}: {
  tone: 'success' | 'error' | 'primary';
  label: string;
  value: string;
  icon: React.ReactNode;
}) {
  const border =
    tone === 'success'
      ? 'border-[var(--color-success)]/35 bg-[var(--color-success)]/[0.07]'
      : tone === 'error'
        ? 'border-[var(--color-error)]/35 bg-[var(--color-error)]/[0.07]'
        : 'border-[var(--color-primary)]/35 bg-[var(--color-primary)]/[0.06]';
  return (
    <div className={`rounded-xl border px-3 py-2.5 ${border}`}>
      <p className="mb-1 inline-flex items-center gap-1.5 text-[11.5px] uppercase tracking-wide text-[var(--color-muted)]">
        {icon} {label}
      </p>
      <p className="text-[13.5px] leading-relaxed">{value}</p>
    </div>
  );
}

export default ArenaReviewList;
