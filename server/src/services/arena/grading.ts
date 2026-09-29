/**
 * Arena grading — the single place a student's answer is turned into marks.
 *
 * Deliberately deterministic: no AI call, no per-student variation, identical input → identical
 * output. Everything a grader needs comes from the stored question plus the competition's
 * blueprint, so a re-grade (for example after results are republished) produces the same score.
 *
 * Numerical tolerance is configuration, not a magic number:
 *   - `ARENA_NUMERIC_TOLERANCE_PCT` (default 1% of the expected value)
 *   - `ARENA_NUMERIC_TOLERANCE_ABS` (absolute floor, used when the expected value is 0 or tiny)
 *   - an optional `numericTolerance` on the competition blueprint overrides the percentage for that
 *     competition (e.g. a chemistry paper needing exact 3-significant-figure answers).
 */
import { config } from '../../config/env.js';
import type { ArenaQuestionRecord } from '../../types/arena.js';

export interface GradingTolerance {
  /** Percentage of the expected value (0–10). */
  pct: number;
  /** Absolute floor, always applied in addition to the percentage. */
  abs: number;
  /** Where the number came from, for the admin console. */
  source: 'blueprint' | 'env';
}

/** Resolves the tolerance for one competition. */
export function resolveTolerance(blueprint?: { numericTolerance?: number } | null): GradingTolerance {
  const override = blueprint?.numericTolerance;
  if (typeof override === 'number' && Number.isFinite(override) && override >= 0 && override <= 10) {
    return { pct: override, abs: config.arena.numericToleranceAbs, source: 'blueprint' };
  }
  return { pct: config.arena.numericTolerancePct, abs: config.arena.numericToleranceAbs, source: 'env' };
}

/**
 * Reads the first number out of an answer.
 * Exponent notation matters: 1.0e-10 mol/L is a real answer and reading it as "1.0" would mark a
 * correct response wrong. Units and surrounding text are ignored.
 */
export function numericValue(value: string): number | null {
  const match = value.replace(/,/g, '').match(/-?\d+(?:\.\d+)?(?:[eE][-+]?\d+)?/);
  if (!match) return null;
  const number = Number(match[0]);
  return Number.isFinite(number) ? number : null;
}

/** Lowercases and strips decoration so "Force = mass × acceleration" and "force = mass * acceleration" match. */
export function normalise(value: string): string {
  return value
    .toLowerCase()
    .replace(/\s+/g, ' ')
    // Multiplication and minus signs arrive in several glyphs depending on how the paper was typed.
    .replace(/[×✕⋅·]/g, '*')
    .replace(/[−–—]/g, '-')
    .replace(/[^a-z0-9+\-./=%*°²³ ]/g, '')
    .trim()
    // Students end answers with a full stop or a stray comma; internal dots (9.8) stay.
    .replace(/^[.,;:!?]+|[.,;:!?]+$/g, '')
    .trim();
}

export interface GradeResult {
  isCorrect: boolean;
  /** Marks awarded: +marks when correct, −negativeMarks when answered wrong, 0 when blank. */
  marks: number;
  /** How the comparison was made — surfaced in admin review, never to a live student. */
  method: 'numeric' | 'numeric-text' | 'option' | 'text';
  difference?: number;
  tolerance?: number;
}

/**
 * Grades one answer. A blank answer is always 0 marks (never a negative mark), which is what the
 * paper instructions promise.
 */
export function gradeAnswer(
  question: Pick<ArenaQuestionRecord, 'question_type' | 'correct_answer' | 'options' | 'marks' | 'negative_marks'>,
  rawAnswer: string,
  tolerance: GradingTolerance = resolveTolerance(),
): GradeResult {
  const answer = (rawAnswer ?? '').trim();
  const positive = Number(question.marks);
  const negative = -Number(question.negative_marks);
  if (!answer) return { isCorrect: false, marks: 0, method: 'text' };

  const type = String(question.question_type);
  const expected = question.correct_answer.trim();

  if (type === 'numerical') {
    const got = numericValue(answer);
    const want = numericValue(expected);
    if (got === null || want === null) {
      // Neither side is numeric (a symbolic answer such as "3√2"): fall back to text comparison.
      const isCorrect = normalise(answer) === normalise(expected);
      return { isCorrect, marks: isCorrect ? positive : negative, method: 'numeric-text' };
    }
    /**
     * Tolerance rule: a percentage of the expected value, with the absolute floor applied only when
     * the expected value is zero. Using the floor as a general minimum would hand a 50% margin to
     * tiny answers (an expected 1.0e-10 would accept 1.5e-10), which is how a correct-looking
     * configuration silently marks wrong answers right.
     */
    const toleranceValue =
      Math.abs(want) === 0 ? tolerance.abs : Math.abs(want) * (tolerance.pct / 100);
    const difference = Math.abs(got - want);
    const isCorrect = difference <= toleranceValue;
    return {
      isCorrect,
      marks: isCorrect ? positive : negative,
      method: 'numeric',
      difference,
      tolerance: toleranceValue,
    };
  }

  // Choice questions: compare against the option text, or the option letter ("B") if that is given.
  const options = question.options ? (JSON.parse(question.options) as string[]) : [];
  const expectedNorm = normalise(expected);
  let candidate = normalise(answer);
  const letter = /^[a-d]$/i.exec(answer);
  if (letter && options.length >= 4) {
    candidate = normalise(options[letter[0].toUpperCase().charCodeAt(0) - 65] ?? answer);
  }
  const isCorrect = candidate === expectedNorm;
  return { isCorrect, marks: isCorrect ? positive : negative, method: options.length ? 'option' : 'text' };
}

/** Human-readable summary of the active tolerance, used by the admin console and the API docs. */
export function describeTolerance(tolerance: GradingTolerance): string {
  return `±${tolerance.pct}% (plus ${tolerance.abs}) from ${tolerance.source === 'blueprint' ? 'the competition blueprint' : 'server configuration'}`;
}
