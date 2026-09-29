/**
 * Competition question generation + validation.
 *
 * Generation follows the competition blueprint and goes through the existing AI router, so keys,
 * task routing, failover and the sample engine all behave exactly as they do everywhere else.
 *
 * A single model response is never trusted: every question is validated (structure, answer present,
 * options coherent, no duplicates, explanation consistent with the answer, difficulty within the
 * blueprint) before it can be stored. Anything that fails validation is either repaired, flagged for
 * human review, or dropped — a bad question never silently reaches a student.
 */
import { config } from '../../config/env.js';
import * as db from '../../db/index.js';
import { nowIso, uuid } from '../../db/index.js';
import { completeJson } from '../ai/router.js';
import { competitionGenSystem } from '../ai/prompts.js';
import { isNumericAnswer, normaliseAnswer } from '../ai/json.js';
import { demoQuestions } from '../ai/demoBank.js';
import { exactPromptKey, sampleQuestions } from './sampleBank.js';
import { HttpError } from '../../middleware/errors.js';
import type { PromptContext } from '../ai/prompts.js';
import type {
  ArenaBlueprint,
  ArenaDifficulty,
  ArenaGeneratedQuestion,
  ArenaQuestionRecord,
  ArenaQuestionReview,
  ArenaQuestionType,
  BlueprintSlot,
  QuestionValidation,
} from '../../types/arena.js';
import { ARENA_DIFFICULTIES, ARENA_QUESTION_TYPES, expandBlueprint, normaliseBlueprint, totalQuestions } from './blueprint.js';
import { computeState, stateLabel } from './competitions.js';

/* ------------------------------------------------------------------ */
/* Validation                                                          */
/* ------------------------------------------------------------------ */

const MIN_EXPLANATION_CHARS = 25;

/** Coarse token signature used for duplicate detection (cheap, no ML, deterministic). */
function signature(text: string): string {
  return normaliseAnswer(text)
    .replace(/\b\d+(\.\d+)?\b/g, '#')
    .split(/\s+/)
    .filter((word) => word.length > 3)
    .slice(0, 24)
    .sort()
    .join(' ');
}

function jaccard(a: Set<string>, b: Set<string>): number {
  if (!a.size || !b.size) return 0;
  let shared = 0;
  for (const token of a) if (b.has(token)) shared += 1;
  return shared / (a.size + b.size - shared);
}

/**
 * Does the explanation actually state the stored answer?
 *
 * Token coverage rather than a literal substring: "x = 2, 3" and "x = 2 or x = 3" are the same
 * answer written differently, while a genuinely mismatched answer (different numbers entirely) still
 * fails. This is the check that catches an AI pairing option A with the explanation for option C.
 */
function answerIsStated(answerLc: string, explanationLc: string): boolean {
  if (!answerLc) return false;
  if (answerLc.length === 1) {
    return new RegExp(`(^|[^a-z0-9])${answerLc}([^a-z0-9]|$)`, 'i').test(explanationLc);
  }
  if (explanationLc.includes(answerLc)) return true;

  const ignored = new Set(['or', 'and', 'the', 'a', 'of', '=', 'is', 'are']);
  const tokens = answerLc.split(/[^a-z0-9.]+/).filter((token) => token && !ignored.has(token));
  if (!tokens.length) return false;
  const covered = tokens.filter((token) => explanationLc.includes(token)).length;
  return covered / tokens.length >= 0.8;
}

export interface ValidationContext {
  slot: BlueprintSlot;
  marksPerQuestion: number;
  negativeMarks: number;
  /** Numeric-stripped signatures of questions already accepted into this paper. */
  existing: Map<string, string>;
  /** Exact (normalised) prompts already in this paper — the hard duplicate check. */
  exact?: Set<string>;
  /**
   * Where the candidate came from.
   *  - 'ai': model output, so a same-structure/different-numbers question is treated as a duplicate;
   *  - 'bank': curated or parameterised content, where varying the numbers is the point.
   */
  origin?: 'ai' | 'bank';
}

/**
 * Structural + semantic checks for one generated question (spec §8).
 * Returns a verdict plus human-readable issues; the caller decides whether to drop or flag it.
 */
export function validateQuestion(candidate: ArenaGeneratedQuestion, ctx: ValidationContext): QuestionValidation {
  const issues: string[] = [];
  if (!candidate) return { status: 'rejected', issues: ['Empty question.'] };
  const prompt = candidate.prompt?.trim() ?? '';
  const answer = candidate.answer?.trim() ?? '';
  const explanation = candidate.explanation?.trim() ?? '';
  const options = (candidate.options ?? []).map((o) => String(o).trim()).filter(Boolean);

  if (prompt.length < 12) issues.push('Question text is missing or too short.');
  if (prompt.length > 900) issues.push('Question text is unreasonably long.');
  if (!answer) issues.push('No correct answer was provided.');

  const type: ArenaQuestionType = ARENA_QUESTION_TYPES.includes(candidate.type) ? candidate.type : 'mcq';

  if (type === 'mcq' || type === 'conceptual') {
    if (options.length !== 4) issues.push(`Choice questions need exactly 4 options (got ${options.length}).`);
    const unique = new Set(options.map((o) => o.toLowerCase()));
    if (unique.size !== options.length) issues.push('Two options are identical.');
    if (options.some((o) => o.length > 200)) issues.push('An option is unreasonably long.');
    if (options.length >= 2) {
      const lengths = options.map((o) => o.length);
      const longest = Math.max(...lengths);
      const shortest = Math.min(...lengths);
      // A single option that is wildly longer than the rest usually hides the answer.
      if (longest > 90 && longest > shortest * 4) issues.push('One option is far longer than the others (possible reveal).');
    }
    if (options.length && !options.some((o) => normaliseAnswer(o) === normaliseAnswer(answer))) {
      issues.push('The correct answer is not one of the options.');
    }
  } else {
    if (options.length) issues.push('Numerical questions must not include options.');
    if (answer && !isNumericAnswer(answer)) issues.push('A numerical answer should contain a number.');
  }

  if (explanation.length < MIN_EXPLANATION_CHARS) {
    issues.push('Explanation is missing or too short to be useful.');
  } else if (answer && type !== 'numerical') {
    // The explanation must actually reference the stated answer (guards against mismatched pairs).
    const explanationLc = normaliseAnswer(explanation);
    const answerLc = normaliseAnswer(answer);
    const mentionsAnswer = answerIsStated(answerLc, explanationLc);
    const optionLetters = explanationLc.match(/\boption [a-d]\b/g) ?? [];
    if (!mentionsAnswer && !optionLetters.length) {
      issues.push('Explanation never states the correct answer — possible mismatch.');
    }
    if (optionLetters.length && options.length === 4) {
      const claimed = (optionLetters[0] ?? '').replace('option ', '').toUpperCase();
      const claimedText = options[claimed.charCodeAt(0) - 65];
      if (claimedText && normaliseAnswer(claimedText) !== answerLc) {
        issues.push('Explanation points at a different option than the stored answer.');
      }
    }
  }

  if (!ARENA_DIFFICULTIES.includes(candidate.difficulty)) issues.push('Difficulty is not one of easy/medium/hard.');

  const sig = signature(prompt);
  const exactPrompt = exactPromptKey(prompt);
  const exactSeen = ctx.exact?.has(exactPrompt) ?? false;
  if (exactSeen) issues.push('Duplicate question (identical wording already in this paper).');
  if (sig && !exactSeen) {
    if ((ctx.origin ?? 'ai') === 'ai') {
      for (const [, existingSig] of ctx.existing) {
        const similarity = jaccard(new Set(sig.split(' ')), new Set(existingSig.split(' ')));
        if (similarity >= 0.82) {
          issues.push('Nearly identical to another question in this paper.');
          break;
        }
      }
      if (ctx.existing.has(sig)) issues.push('Duplicate question.');
    }
    // Bank/parameterised content is only a duplicate when the wording (including values) matches.
  }

  // Marks and negative marks always come from the blueprint, never from the model.
  candidate.marks = ctx.marksPerQuestion;
  candidate.negativeMarks = ctx.negativeMarks;

  // Word "similar"/"same structure" notes are advisory; the checks below are disqualifying.
  const hard = issues.filter(
    (issue) =>
      /no correct answer|not one of the options|Duplicate question|identical wording|options are identical|need exactly 4 options|must not include options|should contain a number|missing or too short|Explanation (is missing|never states|points at)|Question text/i.test(
        issue,
      ),
  );
  if (hard.length) return { status: 'rejected', issues };
  if (issues.length) return { status: 'flagged', issues };
  return { status: 'ok', issues };
}

/* ------------------------------------------------------------------ */
/* Generation                                                          */
/* ------------------------------------------------------------------ */

function parseGenerated(raw: Record<string, unknown>, slot: BlueprintSlot, index: number): ArenaGeneratedQuestion | null {
  const prompt = String(raw.prompt ?? raw.question ?? '').trim();
  if (!prompt) return null;
  const typeRaw = String(raw.type ?? raw.questionType ?? slot.type).toLowerCase();
  const type: ArenaQuestionType = ARENA_QUESTION_TYPES.includes(typeRaw as ArenaQuestionType)
    ? (typeRaw as ArenaQuestionType)
    : slot.type;
  const difficultyRaw = String(raw.difficulty ?? slot.difficulty).toLowerCase();
  const difficulty: ArenaDifficulty = ARENA_DIFFICULTIES.includes(difficultyRaw as ArenaDifficulty)
    ? (difficultyRaw as ArenaDifficulty)
    : slot.difficulty;

  return {
    prompt,
    options: Array.isArray(raw.options) ? (raw.options as unknown[]).map((o) => String(o).trim()).filter(Boolean) : undefined,
    answer: String(raw.answer ?? raw.correctAnswer ?? '').trim(),
    explanation: String(raw.explanation ?? '').trim(),
    subject: String(raw.subject ?? slot.subject).trim() || slot.subject,
    topic: String(raw.topic ?? 'General').trim().slice(0, 80) || 'General',
    chapter: raw.chapter ? String(raw.chapter).trim().slice(0, 80) : undefined,
    difficulty,
    type,
    marks: 0,
    negativeMarks: 0,
    // internal only — used for logging which slot produced the question
    ...({ slotIndex: index } as Record<string, unknown>),
  } as ArenaGeneratedQuestion;
}

/**
 * Asks the model for one slot's worth of questions.
 * Batches are capped so a large paper becomes several smaller, reliable requests.
 */
async function generateSlot(
  userId: string,
  blueprint: ArenaBlueprint,
  slot: BlueprintSlot,
  ctx: PromptContext,
): Promise<{ questions: ArenaGeneratedQuestion[]; demo: boolean; error?: string }> {
  const questions: ArenaGeneratedQuestion[] = [];
  let demo = false;
  let error: string | undefined;
  const batchSize = 8;

  for (let remaining = slot.count; remaining > 0 && questions.length < slot.count; remaining -= batchSize) {
    const want = Math.min(batchSize, remaining);
    try {
      const { data, summary } = await completeJson<{ questions: Record<string, unknown>[] }>({
        userId,
        task: 'exam',
        system: competitionGenSystem(ctx, {
          blueprint,
          slot,
          count: want,
        }),
        messages: [
          {
            role: 'user',
            content: [
              `Generate ${want} competition questions now.`,
              `subject: ${slot.subject}`,
              `difficulty: ${slot.difficulty}`,
              `questionType: ${slot.type}`,
              slot.chapters.length ? `chapters: ${slot.chapters.join(', ')}` : 'chapters: any from the syllabus',
              'Return only the JSON object described in the system message.',
            ].join('\n'),
          },
        ],
        temperature: 0.7,
        maxTokens: 3200,
      });
      if (summary.demo) demo = true;
      const parsed = (data.questions ?? [])
        .map((raw, index) => parseGenerated(raw, slot, index))
        .filter((q): q is ArenaGeneratedQuestion => Boolean(q));
      questions.push(...parsed.slice(0, want));
    } catch (err) {
      error = err instanceof Error ? err.message : 'Generation failed';
      break;
    }
  }

  return { questions, demo, error };
}

/**
 * Fills a shortfall so a paper is never incomplete.
 *
 * Two sources, in this order:
 *   1. the curated offline bank (verified content), filtered to questions that actually fit the
 *      slot's type and that are not already in this paper;
 *   2. the parameterised sample generator for whatever is still missing.
 * Everything produced here is stored with source = 'demo' and is visible in the admin review queue —
 * it is never passed off as model output.
 */
function fillFromBank(
  slot: BlueprintSlot,
  want: number,
  blueprint: ArenaBlueprint,
  exactPrompts: Set<string>,
  seed: number,
  note?: (message: string) => void,
): ArenaGeneratedQuestion[] {
  const needsOptions = slot.type !== 'numerical';

  const curated: ArenaGeneratedQuestion[] = demoQuestions({
    subject: slot.subject,
    chapter: slot.chapters[0],
    count: want + 6,
    type: slot.type,
    difficulty: slot.difficulty,
  })
    // The curated bank is small and subject-filtered loosely; only exact subject matches are usable
    // here, otherwise a Maths question could end up in a Physics slot. (`subject` exists on the bank
    // items at runtime but is not part of the shared PracticeQuestion type.)
    .filter(
      (q) =>
        String((q as unknown as { subject?: string }).subject ?? '').toLowerCase() === slot.subject.toLowerCase(),
    )
    .map((q) => ({
      prompt: q.prompt,
      options: q.options,
      answer: q.answer,
      explanation: q.explanation,
      subject: slot.subject,
      topic: q.topic,
      difficulty: slot.difficulty,
      type: slot.type,
      marks: blueprint.marksPerQuestion,
      negativeMarks: blueprint.negativeMarks,
    }))
    // A bank question is only usable if it fits the slot's shape.
    .filter((q) => (needsOptions ? (q.options?.length ?? 0) === 4 : !q.options?.length))
    .filter((q) => (needsOptions ? true : /-?\d/.test(q.answer)))
    .filter((q) => !exactPrompts.has(exactPromptKey(q.prompt)));

  const picked = curated.slice(0, want);
  const collected: ArenaGeneratedQuestion[] = [...picked];

  /** One draw from the parameterised bank, filtered to questions that fit the slot and are new. */
  const draw = (
    options: {
      difficulty: ArenaDifficulty;
      type: ArenaQuestionType;
      count: number;
      seed: number;
      chapter?: string;
      /** Widened draws keep each template's own difficulty so nothing is mislabelled. */
      keepTemplateDifficulty?: boolean;
    },
  ): ArenaGeneratedQuestion[] => {
    const wantsOptions = options.type !== 'numerical';
    return sampleQuestions({
      subject: slot.subject,
      difficulty: options.difficulty,
      type: options.type,
      chapters: options.chapter ? [options.chapter] : slot.chapters,
      // Ask for extra: some draws repeat wording that is already in this paper.
      count: options.count + 6,
      seed: options.seed,
      marks: blueprint.marksPerQuestion,
      negativeMarks: blueprint.negativeMarks,
      keepTemplateDifficulty: options.keepTemplateDifficulty,
    })
      .filter((q) => (wantsOptions ? (q.options?.length ?? 0) === 4 : !q.options?.length))
      .filter((q) => (wantsOptions ? true : /-?\d/.test(q.answer)))
      .filter((q) => !exactPrompts.has(exactPromptKey(q.prompt)));
  };

  // Pass 1 — the slot exactly as the blueprint asks for it.
  collected.push(
    ...draw({ difficulty: slot.difficulty, type: slot.type, count: want - collected.length, seed }),
  );

  /**
   * Pass 2 — the blueprint's section is still short, which happens when the offline bank is thin for
   * one subject/difficulty/type combination. Later slots draw on the same questions, so the
   * fallbacks widen one axis at a time (difficulty first, then the question type, which the bank can
   * coerce) rather than leaving the paper incomplete. Every relaxation is reported to the admin in
   * the generation warnings — a short paper is never silently stored.
   */
  if (collected.length < want) {
    const before = collected.length;
    collected.push(
      ...draw({
        difficulty: slot.difficulty,
        type: slot.type,
        count: want - collected.length,
        seed: seed + 104_729,
        keepTemplateDifficulty: true,
      }),
    );
    if (collected.length > before) {
      note?.(
        `${slot.subject}: ${collected.length - before} question(s) drawn from the wider subject pool — the verified bank has no ${slot.difficulty} ${slot.type} content left for this section. Those questions keep their own difficulty label.`,
      );
    }
  }

  if (collected.length < want) {
    const before = collected.length;
    collected.push(
      ...draw({
        difficulty: slot.difficulty,
        type: 'conceptual',
        count: want - collected.length,
        seed: seed + 154_858,
        keepTemplateDifficulty: true,
      }),
    );
    if (collected.length > before) {
      note?.(
        `${slot.subject}: ${collected.length - before} question(s) drawn as conceptual items — the bank could not supply enough ${slot.type} content for this section.`,
      );
    }
  }

  if (collected.length < want) {
    const before = collected.length;
    collected.push(
      ...draw({
        difficulty: slot.difficulty,
        type: 'numerical',
        count: want - collected.length,
        seed: seed + 209_759,
        keepTemplateDifficulty: true,
      }),
    );
    if (collected.length > before) {
      note?.(
        `${slot.subject}: ${collected.length - before} numerical question(s) added — the bank is exhausted for the rest of this section.`,
      );
    }
  }

  return collected.slice(0, want);
}

export interface GenerationOutcome {
  created: number;
  /** Total questions the blueprint asked for (what `created` is measured against). */
  requested: number;
  /** requested − created: non-zero only when even the bank could not fill a section. */
  shortfall: number;
  rejected: number;
  flagged: number;
  demo: boolean;
  usedBank: boolean;
  warnings: string[];
  bySubject: Record<string, number>;
}

/**
 * Generates the full paper for a competition and stores it.
 * Questions land in `arena_questions` with a review status; admins approve/flag/reject before
 * publication, and flagged questions are visible in the review queue rather than hidden.
 */
/**
 * Which lifecycle states make the stored paper immutable. Regenerating a paper while students are
 * writing (or after they wrote it) would change what they see or what they were graded on, so the
 * generator refuses unless the admin explicitly forces it.
 */
export function paperLockedFor(state: string): boolean {
  return state === 'LIVE' || state === 'SUBMISSION_CLOSED' || state === 'PROCESSING_RESULTS' || state === 'RESULTS_PUBLISHED' || state === 'ARCHIVED';
}

export async function generatePaper(args: {
  userId: string;
  competitionId: string;
  blueprint: ArenaBlueprint;
  ctx: PromptContext;
  /** When true the paper is filled from the offline bank only (no AI calls) — used by the seeder. */
  bankOnly?: boolean;
  /** Replaces existing questions for this competition. */
  replace?: boolean;
  /** Overrides the "paper is locked" refusal (see paperLockedFor). */
  force?: boolean;
  /**
   * Marks every generated question approved in one go. Off by default: generated content waits for
   * human review, and a competition cannot start until that review happened.
   */
  autoApprove?: boolean;
}): Promise<GenerationOutcome> {
  const competition = await db.one<{ status: string; starts_at: string; ends_at: string; results_published_at: string | null }>(
    'SELECT status, starts_at, ends_at, results_published_at FROM arena_competitions WHERE id = ?',
    [args.competitionId],
  );
  if (competition) {
    const state = computeState(competition as never);
    if (paperLockedFor(state) && !args.force) {
      throw new HttpError(
        409,
        `The paper for this competition is locked (${stateLabel(state)}). Regenerating it would change what students already received — archive this competition and create a new one instead.`,
        'paper_locked',
      );
    }
  }

  const blueprint = normaliseBlueprint(args.blueprint);
  const slots = expandBlueprint(blueprint);
  const warnings: string[] = [];
  let demo = false;
  let usedBank = false;
  let rejected = 0;
  let flagged = 0;

  const accepted: { question: ArenaGeneratedQuestion; review: ArenaQuestionReview; issues: string[]; source: 'ai' | 'demo' }[] = [];
  const signatures = new Map<string, string>();
  const exactPrompts = new Set<string>();
  let slotSeed = 1;

  for (const slot of slots) {
    slotSeed += 7919;
    const want = slot.count;
    let produced: ArenaGeneratedQuestion[] = [];
    if (!args.bankOnly) {
      const result = await generateSlot(args.userId, blueprint, slot, args.ctx);
      produced = result.questions;
      if (result.demo) demo = true;
      if (result.error) warnings.push(`${slot.subject} · ${slot.difficulty} ${slot.type}: ${result.error}`);
    }

    // Validation happens on everything, including bank questions.
    const validated: ArenaGeneratedQuestion[] = [];
    for (const candidate of produced) {
      const verdict = validateQuestion(candidate, {
        slot,
        marksPerQuestion: blueprint.marksPerQuestion,
        negativeMarks: blueprint.negativeMarks,
        existing: signatures,
        exact: exactPrompts,
        origin: 'ai',
      });
      if (verdict.status === 'rejected') {
        rejected += 1;
        continue;
      }
      if (verdict.status === 'flagged') flagged += 1;
      validated.push(candidate);
      accepted.push({
        question: candidate,
        review: args.autoApprove && verdict.status === 'ok' ? 'approved' : verdict.status === 'ok' ? 'pending' : 'flagged',
        issues: verdict.issues,
        source: demo ? 'demo' : 'ai',
      });
      remember(candidate);
    }

    /**
     * The slot is filled from the verified bank when the model (or the bank-only path) did not
     * produce enough. Validation runs on everything, so a bank candidate can still be rejected —
     * which is why filling is a *loop*: the paper is only allowed to end up short if the bank is
     * genuinely exhausted, and that case is reported instead of hidden.
     */
    const acceptedBefore = accepted.length;
    const acceptedForSlot = () => accepted.length - acceptedBefore;
    if (validated.length < want) {
      const shortfall = want - validated.length;
      warnings.push(
        `${slot.subject}: ${validated.length}/${want} ${slot.difficulty} ${slot.type} questions passed validation — filling ${shortfall} from the verified bank.`,
      );
      usedBank = true;

      const acceptFilled = (candidates: ArenaGeneratedQuestion[]): void => {
        for (const candidate of candidates) {
          const verdict = validateQuestion(candidate, {
            slot,
            marksPerQuestion: blueprint.marksPerQuestion,
            negativeMarks: blueprint.negativeMarks,
            existing: signatures,
            exact: exactPrompts,
            // Bank content is curated/parameterised on purpose, so only identical wording is a duplicate.
            origin: 'bank',
          });
          if (verdict.status === 'rejected') {
            rejected += 1;
            continue;
          }
          if (verdict.status === 'flagged') flagged += 1;
          accepted.push({
            question: candidate,
            review: args.autoApprove && verdict.status === 'ok' ? 'approved' : verdict.status === 'ok' ? 'pending' : 'flagged',
            issues: verdict.issues,
            source: 'demo',
          });
          remember(candidate);
        }
      };

      for (let pass = 0; pass < 4 && acceptedForSlot() < want; pass += 1) {
        const filled = fillFromBank(
          slot,
          want - acceptedForSlot(),
          blueprint,
          exactPrompts,
          slotSeed + pass * 10_007,
          (message) => warnings.push(message),
        );
        if (!filled.length) break;
        acceptFilled(filled);
      }

      if (acceptedForSlot() < want) {
        warnings.push(
          `${slot.subject}: only ${acceptedForSlot()}/${want} ${slot.difficulty} ${slot.type} questions could be produced — the verified bank is exhausted for this section.`,
        );
      }
    }
  }

  /** Records a prompt in both dedupe indexes. */
  function remember(candidate: ArenaGeneratedQuestion): void {
    const sig = signature(candidate.prompt);
    if (sig) signatures.set(sig, sig);
    exactPrompts.add(exactPromptKey(candidate.prompt));
  }

  if (args.replace) {
    await db.run('DELETE FROM arena_questions WHERE competition_id = ?', [args.competitionId]);
  }

  const created: number[] = [];
  let position = 0;
  const bySubject: Record<string, number> = {};
  const now = nowIso();
  for (const entry of accepted) {
    const q = entry.question;
    position += 1;
    const id = uuid();
    await db.run(
      `INSERT INTO arena_questions
         (id, competition_id, position, prompt, options, correct_answer, explanation, subject, topic, chapter,
          difficulty, question_type, marks, negative_marks, review_status, review_notes, source, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        id,
        args.competitionId,
        position,
        q.prompt,
        q.options?.length ? JSON.stringify(q.options) : null,
        q.answer,
        q.explanation,
        q.subject,
        q.topic,
        q.chapter ?? null,
        q.difficulty,
        q.type,
        q.marks,
        q.negativeMarks,
        entry.review,
        entry.issues.length ? entry.issues.join(' | ') : null,
        entry.source,
        now,
      ],
    );
    created.push(position);
    bySubject[q.subject] = (bySubject[q.subject] ?? 0) + 1;
  }

  const requested = slots.reduce((total, slot) => total + slot.count, 0);
  if (created.length < requested && !warnings.some((warning) => warning.includes('short of the blueprint'))) {
    warnings.push(
      `The paper is ${requested - created.length} question(s) short of the blueprint (${created.length}/${requested}) — the bank ran out for those sections.`,
    );
  }
  return {
    created: created.length,
    requested,
    shortfall: Math.max(0, requested - created.length),
    rejected,
    flagged,
    demo,
    usedBank,
    warnings,
    bySubject,
  };
}

/* ------------------------------------------------------------------ */
/* Reading + review                                                    */
/* ------------------------------------------------------------------ */

export function toQuestionRecord(row: ArenaQuestionRecord) {
  return {
    id: row.id,
    position: Number(row.position),
    prompt: row.prompt,
    options: row.options ? (JSON.parse(row.options) as string[]) : null,
    correctAnswer: row.correct_answer,
    explanation: row.explanation,
    subject: row.subject,
    topic: row.topic,
    chapter: row.chapter,
    difficulty: row.difficulty as ArenaDifficulty,
    type: row.question_type as ArenaQuestionType,
    marks: Number(row.marks),
    negativeMarks: Number(row.negative_marks),
    reviewStatus: row.review_status as ArenaQuestionReview,
    reviewNotes: row.review_notes,
    source: row.source,
  };
}

export async function listQuestions(
  competitionId: string,
  opts: { includeKeys?: boolean; onlyApproved?: boolean } = {},
): Promise<ArenaQuestionRecord[]> {
  const clauses = ['competition_id = ?'];
  if (opts.onlyApproved) clauses.push("review_status IN ('approved')");
  return db.all<ArenaQuestionRecord>(
    `SELECT * FROM arena_questions WHERE ${clauses.join(' AND ')} ORDER BY position ASC`,
    [competitionId],
  );
}

/** The student-facing projection. Deliberately omits correct_answer, explanation and review notes. */
export function studentView(row: ArenaQuestionRecord) {
  return {
    id: row.id,
    position: Number(row.position),
    prompt: row.prompt,
    options: row.options ? (JSON.parse(row.options) as string[]) : null,
    subject: row.subject,
    topic: row.topic,
    difficulty: row.difficulty as ArenaDifficulty,
    type: row.question_type as ArenaQuestionType,
    marks: Number(row.marks),
    negativeMarks: Number(row.negative_marks),
  };
}

export async function reviewCounts(competitionId: string): Promise<{
  pending: number;
  flagged: number;
  approved: number;
  rejected: number;
  total: number;
}> {
  const rows = await db.all<{ review_status: string; c: number }>(
    'SELECT review_status, COUNT(*) AS c FROM arena_questions WHERE competition_id = ? GROUP BY review_status',
    [competitionId],
  );
  const out = { pending: 0, flagged: 0, approved: 0, rejected: 0, total: 0 };
  for (const row of rows) {
    const key = row.review_status as keyof typeof out;
    const count = Number(row.c);
    if (key in out) out[key] = count;
    out.total += count;
  }
  return out;
}

export async function updateQuestionReview(
  competitionId: string,
  questionId: string,
  args: { reviewStatus?: ArenaQuestionReview; prompt?: string; answer?: string; explanation?: string; options?: string[] },
): Promise<boolean> {
  const row = await db.one<ArenaQuestionRecord>(
    'SELECT * FROM arena_questions WHERE id = ? AND competition_id = ?',
    [questionId, competitionId],
  );
  if (!row) return false;

  const next = {
    review_status: args.reviewStatus ?? row.review_status,
    prompt: args.prompt?.trim() || row.prompt,
    correct_answer: args.answer?.trim() || row.correct_answer,
    explanation: args.explanation?.trim() || row.explanation,
    options: args.options ? JSON.stringify(args.options.map((o) => o.trim()).filter(Boolean)) : row.options,
  };
  await db.run(
    `UPDATE arena_questions
        SET review_status = ?, review_notes = ?, prompt = ?, correct_answer = ?, explanation = ?, options = ?
      WHERE id = ? AND competition_id = ?`,
    [
      next.review_status,
      args.reviewStatus === 'approved' ? 'Reviewed and approved by staff.' : row.review_notes,
      next.prompt,
      next.correct_answer,
      next.explanation,
      next.options,
      questionId,
      competitionId,
    ],
  );
  return true;
}

export async function deleteQuestion(competitionId: string, questionId: string): Promise<boolean> {
  const row = await db.one<{ id: string }>('SELECT id FROM arena_questions WHERE id = ? AND competition_id = ?', [
    questionId,
    competitionId,
  ]);
  if (!row) return false;
  await db.run('DELETE FROM arena_questions WHERE id = ?', [questionId]);
  return true;
}

/**
 * Totals for the paper students will actually see. Only **approved** questions count: they are the
 * only ones served at exam time and the only ones graded, so counting anything else would advertise
 * a max score the paper cannot reach.
 */
export async function paperTotals(competitionId: string): Promise<{ questions: number; maxScore: number }> {
  const rows = await db.all<{ marks: number }>(
    "SELECT marks FROM arena_questions WHERE competition_id = ? AND review_status = 'approved'",
    [competitionId],
  );
  return {
    questions: rows.length,
    maxScore: rows.reduce((sum, row) => sum + Number(row.marks), 0),
  };
}

export interface PaperReadiness {
  competitorQuestions: number;
  total: number;
  approved: number;
  pending: number;
  flagged: number;
  rejected: number;
  /** How many approved questions the paper needs (blueprint size × required ratio). */
  required: number;
  /** Approved share of the blueprint, 0–1. */
  coverage: number;
  /** True when students may enter: enough approved questions and nothing flagged/unreviewed. */
  ready: boolean;
  /** Plain-language reason shown to admins (and returned when a start is blocked). */
  blocker: string | null;
}

/**
 * Is this paper safe to open? A paper is ready only when every question a student will see has been
 * reviewed and approved — no pending drafts, no flagged rows — and the approved set is big enough
 * to make the advertised paper. This is what gates `start_now`, registration closing into LIVE and
 * every student `start` call, so a half-reviewed paper can never be sat.
 */
export async function paperReadiness(competitionId: string): Promise<PaperReadiness> {
  const blueprintRows = await db.one<{ blueprint: string }>(
    'SELECT blueprint FROM arena_competitions WHERE id = ?',
    [competitionId],
  );
  const blueprint = normaliseBlueprint(JSON.parse(blueprintRows?.blueprint || '{}'));
  const counts = await reviewCounts(competitionId);
  const required = Math.max(1, Math.ceil(totalQuestions(blueprint) * config.arena.requiredApprovalRatio));
  const coverage = required ? counts.approved / required : 0;
  const ready = counts.approved >= required && counts.pending === 0 && counts.flagged === 0;

  let blocker: string | null = null;
  if (!ready) {
    const parts: string[] = [];
    if (counts.approved < required) parts.push(`${counts.approved} of ${required} questions approved`);
    if (counts.pending) parts.push(`${counts.pending} awaiting review`);
    if (counts.flagged) parts.push(`${counts.flagged} flagged`);
    if (counts.pending === 0 && counts.flagged === 0 && counts.total < required) {
      // Everything on the paper is approved, but the paper itself is incomplete: report it as the
      // blueprint shortfall it is rather than as a review problem the admin cannot act on.
      parts.push(
        `the paper itself is ${required - counts.total} question(s) short of the blueprint (${counts.total}/${required}) — regenerate it`,
      );
    }
    blocker = parts.join(', ');
  }

  return {
    competitorQuestions: counts.total,
    total: counts.total,
    approved: counts.approved,
    pending: counts.pending,
    flagged: counts.flagged,
    rejected: counts.rejected,
    required,
    coverage: Math.round(coverage * 1000) / 1000,
    ready,
    blocker,
  };
}

export { totalQuestions };
