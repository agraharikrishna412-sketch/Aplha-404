/**
 * Arena grading rules.
 *
 * Marking has to be reproducible and configurable, so these tests pin down:
 *  - the numerical tolerance (default, env override, per-competition blueprint override);
 *  - the sign convention (+marks correct, −negativeMarks wrong, 0 for blank);
 *  - option-letter answers, text answers and exponent notation;
 *  - the benchmark maths that rank and percentile come from.
 */
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import { describe, it } from 'node:test';

process.env.DATA_DIR = path.join(os.tmpdir(), `vroqn-grading-${Date.now()}`);
process.env.JWT_SECRET = 'grading-test-secret-not-used-for-anything-real';
process.env.VROQN_MASTER_KEY = 'c'.repeat(64);
process.env.ARENA_NUMERIC_TOLERANCE_PCT = '2';
process.env.ARENA_NUMERIC_TOLERANCE_ABS = '1e-9';

const { gradeAnswer, numericValue, normalise, resolveTolerance, describeTolerance } = await import(
  '../src/services/arena/grading.js'
);
const { benchmarkFromScores } = await import('../src/services/arena/results.js');

type QuestionLike = Parameters<typeof gradeAnswer>[0];

const numerical = (correct: string, marks = 4, negative = 1): QuestionLike =>
  ({
    question_type: 'numerical',
    correct_answer: correct,
    options: null,
    marks,
    negative_marks: negative,
  }) as QuestionLike;

const mcq = (options: string[], correct: string, marks = 4, negative = 1): QuestionLike =>
  ({
    question_type: 'mcq',
    correct_answer: correct,
    options: JSON.stringify(options),
    marks,
    negative_marks: negative,
  }) as QuestionLike;

describe('numerical tolerance is configuration, not a magic number', () => {
  it('uses the env default when the blueprint says nothing', () => {
    const tolerance = resolveTolerance(null);
    assert.equal(tolerance.pct, 2, 'ARENA_NUMERIC_TOLERANCE_PCT is honoured');
    assert.equal(tolerance.source, 'env');
    assert.match(describeTolerance(tolerance), /server configuration/);
  });

  it('lets a competition blueprint override it', () => {
    const tolerance = resolveTolerance({ numericTolerance: 0.1 });
    assert.equal(tolerance.pct, 0.1);
    assert.equal(tolerance.source, 'blueprint');
    assert.match(describeTolerance(tolerance), /blueprint/);
  });

  it('ignores an out-of-range override rather than mis-marking a paper', () => {
    assert.equal(resolveTolerance({ numericTolerance: 50 }).source, 'env');
    assert.equal(resolveTolerance({ numericTolerance: Number.NaN }).source, 'env');
  });

  it('accepts an answer inside the tolerance and rejects one outside it', () => {
    const question = numerical('100');
    // 2% of 100 = 2 → 102 passes, 103 does not.
    assert.equal(gradeAnswer(question, '101.8').isCorrect, true);
    assert.equal(gradeAnswer(question, '102').isCorrect, true);
    assert.equal(gradeAnswer(question, '103').isCorrect, false);
  });

  it('narrows or widens with a stricter or looser tolerance', () => {
    const question = numerical('100');
    assert.equal(gradeAnswer(question, '101.5', { pct: 0.5, abs: 1e-9, source: 'blueprint' }).isCorrect, false);
    assert.equal(gradeAnswer(question, '101.5', { pct: 5, abs: 1e-9, source: 'blueprint' }).isCorrect, true);
  });

  it('still compares tiny and huge values sensibly', () => {
    const tiny = numerical('1.0e-10');
    assert.equal(gradeAnswer(tiny, '1.0e-10 M').isCorrect, true, 'units are ignored');
    assert.equal(gradeAnswer(tiny, '1.5e-10').isCorrect, false);

    const zero = numerical('0');
    assert.equal(gradeAnswer(zero, '0').isCorrect, true);
    assert.equal(gradeAnswer(zero, '0.5').isCorrect, false, 'a relative tolerance must not make 0 accept anything');
  });

  it('reads units, commas and exponent notation', () => {
    assert.equal(numericValue('9.8 m/s²'), 9.8);
    assert.equal(numericValue('1,250'), 1250);
    assert.equal(numericValue('6.022e23'), 6.022e23);
    assert.equal(numericValue('two'), null);
  });
});

describe('marking convention', () => {
  it('awards full marks, deducts negative marks, and never penalises a blank', () => {
    const question = numerical('50', 4, 1);
    assert.equal(gradeAnswer(question, '50').marks, 4);
    assert.equal(gradeAnswer(question, '900').marks, -1);
    assert.equal(gradeAnswer(question, '').marks, 0, 'skipped questions cost nothing');
    assert.equal(gradeAnswer(question, '   ').marks, 0);
  });

  it('accepts an option letter or the option text for choice questions', () => {
    const question = mcq(['2 m/s', '15 m/s', '20 m/s', '25 m/s'], '15 m/s');
    assert.equal(gradeAnswer(question, '15 m/s').isCorrect, true);
    assert.equal(gradeAnswer(question, 'B').isCorrect, true);
    assert.equal(gradeAnswer(question, 'b').isCorrect, true);
    assert.equal(gradeAnswer(question, '15 m/s.').isCorrect, true, 'trailing punctuation is ignored');
    assert.equal(gradeAnswer(question, 'D').isCorrect, false);
    assert.equal(gradeAnswer(question, 'D').marks, -1);
  });

  it('falls back to text comparison for a symbolic numerical answer', () => {
    const question = numerical('3√2');
    assert.equal(gradeAnswer(question, '3√2').isCorrect, true);
    assert.equal(gradeAnswer(question, '2√3').isCorrect, false);
  });

  it('normalises case and spacing for conceptual answers', () => {
    assert.equal(
      normalise('  Force = mass × acceleration '),
      normalise('force = mass * acceleration'),
      'multiplication glyphs collapse to the same answer',
    );
    const conceptual = {
      question_type: 'conceptual',
      correct_answer: 'inertia',
      options: null,
      marks: 4,
      negative_marks: 1,
    } as QuestionLike;
    assert.equal(gradeAnswer(conceptual, 'Inertia').isCorrect, true);
  });
});

describe('ranking maths', () => {
  it('ranks correctly, uses mid-rank for ties and states the population', () => {
    const scores = [100, 80, 80, 40];
    const top = benchmarkFromScores(scores, 100);
    assert.equal(top.rank, 1);
    assert.equal(top.participantCount, 4);
    assert.equal(top.percentile, 87.5, '(3 below + half of own tie) / 4');
    assert.match(top.populationLabel, /4 valid submitted attempts/);

    const tied = benchmarkFromScores(scores, 80);
    assert.equal(tied.rank, 2, 'tied runners share the better rank');
    // Mid-rank: one score below, one of the two tied counted as half → (1 + 1) / 4.
    assert.equal(tied.percentile, 50);

    const last = benchmarkFromScores(scores, 40);
    assert.equal(last.rank, 4);
    // Mid-rank applies to ties, so the bottom score keeps half of its own tie share (0.5 / 4).
    assert.equal(last.percentile, 12.5);
  });

  it('handles negative totals (negative marking) without breaking percentile', () => {
    const benchmark = benchmarkFromScores([-3, 10, 5], -3);
    assert.equal(benchmark.rank, 3);
    // Last place still earns half of its own tie share rather than a hard zero.
    assert.equal(benchmark.percentile, 16.7);
    assert.ok(benchmark.band.length > 0);
  });

  it('keeps percentile inside 0–100 even with a single attempt', () => {
    const solo = benchmarkFromScores([42], 42);
    assert.equal(solo.rank, 1);
    assert.equal(solo.percentile, 50);
    assert.equal(solo.participantCount, 1);
  });
});
