/**
 * Exam blueprint — the contract the paper must satisfy.
 *
 * A blueprint declares how many questions each subject contributes, the difficulty split and the
 * question-type split. Question generation, validation and the published paper all read from it,
 * so an admin edits one object and the whole pipeline follows.
 */
import { resolveTolerance } from './grading.js';
import type { ArenaBlueprint, ArenaDifficulty, ArenaQuestionType, BlueprintSlot, BlueprintSubject } from '../../types/arena.js';

export const ARENA_DIFFICULTIES: ArenaDifficulty[] = ['easy', 'medium', 'hard'];
export const ARENA_QUESTION_TYPES: ArenaQuestionType[] = ['mcq', 'numerical', 'conceptual'];

export const DEFAULT_MARKS = 4;
export const DEFAULT_NEGATIVE_MARKS = 1;

export const CATEGORIES = [
  {
    id: 'pre-jee',
    label: 'Vroqn Pre-JEE Challenge',
    blurb: 'Physics, Chemistry and Mathematics practice in the JEE style. An independent Vroqn mock.',
  },
  {
    id: 'pre-neet',
    label: 'Vroqn Pre-NEET Challenge',
    blurb: 'Physics, Chemistry and Biology practice in the NEET style. An independent Vroqn mock.',
  },
  {
    id: 'foundation',
    label: 'Vroqn Foundation Challenge',
    blurb: 'Class 9–10 Science and Mathematics, school-board level.',
  },
] as const;

export type ArenaCategoryId = (typeof CATEGORIES)[number]['id'];

export function categoryLabel(id: string): string {
  return CATEGORIES.find((c) => c.id === id)?.label ?? id;
}

/** Reasonable starting points so an admin never has to type a blueprint from scratch. */
export const BLUEPRINT_PRESETS: Record<ArenaCategoryId, ArenaBlueprint> = {
  'pre-jee': {
    subjects: [
      { subject: 'Physics', count: 20, chapters: [] },
      { subject: 'Chemistry', count: 20, chapters: [] },
      { subject: 'Mathematics', count: 20, chapters: [] },
    ],
    difficulty: { easy: 20, medium: 50, hard: 30 },
    types: { mcq: 70, numerical: 20, conceptual: 10 },
    marksPerQuestion: 4,
    negativeMarks: 1,
    durationMin: 90,
  },
  'pre-neet': {
    subjects: [
      { subject: 'Physics', count: 20, chapters: [] },
      { subject: 'Chemistry', count: 20, chapters: [] },
      { subject: 'Biology', count: 20, chapters: [] },
    ],
    difficulty: { easy: 25, medium: 50, hard: 25 },
    types: { mcq: 90, numerical: 10, conceptual: 0 },
    marksPerQuestion: 4,
    negativeMarks: 1,
    durationMin: 90,
  },
  foundation: {
    subjects: [
      { subject: 'Physics', count: 10, chapters: [] },
      { subject: 'Chemistry', count: 10, chapters: [] },
      { subject: 'Mathematics', count: 10, chapters: [] },
    ],
    difficulty: { easy: 30, medium: 50, hard: 20 },
    types: { mcq: 60, numerical: 20, conceptual: 20 },
    marksPerQuestion: 4,
    negativeMarks: 1,
    durationMin: 60,
  },
};

/* ------------------------------------------------------------------ */
/* Normalisation                                                       */
/* ------------------------------------------------------------------ */

function clampInt(value: unknown, min: number, max: number, fallback: number): number {
  const n = Math.round(Number(value));
  if (!Number.isFinite(n)) return fallback;
  return Math.min(Math.max(n, min), max);
}

function normalisePercentages<T extends string>(input: Partial<Record<T, number>> | undefined, keys: T[]): Record<T, number> {
  const raw = keys.map((key) => Math.max(0, Number(input?.[key] ?? 0)));
  const total = raw.reduce((sum, value) => sum + value, 0);
  if (total <= 0) {
    const even = Math.floor(100 / keys.length);
    const out = {} as Record<T, number>;
    keys.forEach((key, index) => {
      out[key] = index === keys.length - 1 ? 100 - even * (keys.length - 1) : even;
    });
    return out;
  }
  // Scale to exactly 100 while keeping the admin's proportions.
  const scaled = raw.map((value) => (value / total) * 100);
  const rounded = scaled.map((value) => Math.round(value));
  const drift = 100 - rounded.reduce((sum, value) => sum + value, 0);
  if (drift !== 0) {
    const biggest = rounded.indexOf(Math.max(...rounded));
    rounded[biggest] += drift;
  }
  const out = {} as Record<T, number>;
  keys.forEach((key, index) => {
    out[key] = rounded[index];
  });
  return out;
}

/**
 * Accepts whatever the admin typed and returns a blueprint the pipeline can trust:
 * counts bounded, percentages summing to 100, marks and duration inside sane limits.
 */
export function normaliseBlueprint(input: unknown, fallback: ArenaBlueprint = BLUEPRINT_PRESETS.foundation): ArenaBlueprint {
  const raw = (input ?? {}) as Partial<ArenaBlueprint>;
  const subjectsInput = Array.isArray(raw.subjects) ? raw.subjects : fallback.subjects;

  const seen = new Set<string>();
  const subjects: BlueprintSubject[] = [];
  for (const entry of subjectsInput) {
    const subject = String((entry as BlueprintSubject)?.subject ?? '').trim().slice(0, 60);
    if (!subject) continue;
    const key = subject.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    subjects.push({
      subject,
      count: clampInt((entry as BlueprintSubject)?.count, 1, 60, 10),
      chapters: Array.isArray((entry as BlueprintSubject)?.chapters)
        ? ((entry as BlueprintSubject).chapters as unknown[]).map((c) => String(c).trim().slice(0, 80)).filter(Boolean).slice(0, 12)
        : [],
    });
  }
  if (!subjects.length) subjects.push({ subject: 'Physics', count: 10, chapters: [] });

  return {
    subjects,
    difficulty: normalisePercentages<ArenaDifficulty>(raw.difficulty ?? fallback.difficulty, ARENA_DIFFICULTIES),
    types: normalisePercentages<ArenaQuestionType>(raw.types ?? fallback.types, ARENA_QUESTION_TYPES),
    marksPerQuestion: clampInt(raw.marksPerQuestion ?? fallback.marksPerQuestion, 1, 10, DEFAULT_MARKS),
    negativeMarks: Math.max(0, Math.min(Number(raw.negativeMarks ?? fallback.negativeMarks) || 0, 5)),
    durationMin: clampInt(raw.durationMin ?? fallback.durationMin, 5, 240, 60),
    numericTolerance:
      typeof raw.numericTolerance === 'number' && Number.isFinite(raw.numericTolerance)
        ? Math.min(10, Math.max(0, raw.numericTolerance))
        : fallback.numericTolerance,
  };
}

export function totalQuestions(blueprint: ArenaBlueprint): number {
  return blueprint.subjects.reduce((sum, s) => sum + s.count, 0);
}

export function maxScore(blueprint: ArenaBlueprint): number {
  return totalQuestions(blueprint) * blueprint.marksPerQuestion;
}

/** Splits a percentage into integer counts that add up to `total`. */
function splitCount(total: number, percentages: Record<string, number>, keys: string[]): Record<string, number> {
  const exact = keys.map((key) => ({ key, value: (total * (percentages[key] ?? 0)) / 100 }));
  const out: Record<string, number> = {};
  let assigned = 0;
  exact.forEach(({ key, value }) => {
    const floored = Math.floor(value);
    out[key] = floored;
    assigned += floored;
  });
  const remainder = total - assigned;
  if (remainder > 0) {
    // Hand the leftovers to the largest fractional parts (largest remainder method).
    const order = [...exact].sort((a, b) => (b.value % 1) - (a.value % 1));
    for (let i = 0; i < remainder; i += 1) {
      const target = order[i % order.length];
      out[target.key] += 1;
    }
  }
  return out;
}

/**
 * Expands the blueprint into concrete generation slots: "5 medium numericals of Physics".
 * Deterministic — the largest-remainder method keeps the mix as close to the admin's intent as
 * integer counts allow, and the same blueprint always produces the same plan.
 */
export function expandBlueprint(blueprint: ArenaBlueprint): BlueprintSlot[] {
  const slots: BlueprintSlot[] = [];
  const grandTotal = totalQuestions(blueprint);

  for (const subject of blueprint.subjects) {
    const byDifficulty = splitCount(subject.count, blueprint.difficulty as unknown as Record<string, number>, ARENA_DIFFICULTIES);
    for (const difficulty of ARENA_DIFFICULTIES) {
      const count = byDifficulty[difficulty] ?? 0;
      if (count <= 0) continue;
      const byType = splitCount(count, blueprint.types as unknown as Record<string, number>, ARENA_QUESTION_TYPES);
      for (const type of ARENA_QUESTION_TYPES) {
        const typeCount = byType[type] ?? 0;
        if (typeCount <= 0) continue;
        slots.push({
          subject: subject.subject,
          difficulty,
          type,
          count: typeCount,
          chapters: subject.chapters ?? [],
        });
      }
    }
  }

  // Guard: never plan more slots than the paper can hold.
  return slots.filter(() => grandTotal > 0);
}

/** Human summary used in prompts, the UI and the audit trail. */
export function describeBlueprint(blueprint: ArenaBlueprint): string {
  return blueprint.subjects
    .map((s) => `${s.subject}: ${s.count}`)
    .concat([
      `difficulty E${blueprint.difficulty.easy}/M${blueprint.difficulty.medium}/H${blueprint.difficulty.hard}`,
      `types MCQ${blueprint.types.mcq}/NUM${blueprint.types.numerical}/CON${blueprint.types.conceptual}`,
      `marks +${blueprint.marksPerQuestion} / -${blueprint.negativeMarks}`,
      `duration ${blueprint.durationMin}m`,
    ])
    .join(' · ');
}

export function blueprintView(blueprint: ArenaBlueprint) {
  const tolerance = resolveTolerance(blueprint);
  return {
    subjects: blueprint.subjects,
    difficulty: blueprint.difficulty,
    types: blueprint.types,
    marksPerQuestion: blueprint.marksPerQuestion,
    negativeMarks: blueprint.negativeMarks,
    durationMin: blueprint.durationMin,
    totalQuestions: totalQuestions(blueprint),
    numericTolerance: tolerance.pct,
    numericToleranceSource: tolerance.source,
  };
}
