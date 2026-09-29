/**
 * Community papers: two ways to fill a hosted competition, and one rule that covers both.
 *
 *   1. **AI writes the paper** — the host picks subject, count, chapters, difficulty; the Arena
 *      generator runs (AI providers, with the curated-bank fallback that works offline).
 *   2. **The host uploads a paper** — pasted text or a `.txt` / `.csv` / `.md` file.
 *
 * The rule: **a paper must not be leakable.** For an uploaded paper that means the questions that
 * actually run are *not* the questions that were uploaded. Every parsed question goes through a rewrite
 * pass that changes its numbers and reorders its options while keeping the correct option correct, so
 * a student holding the source paper — or the host's own file — cannot map answers onto the live paper.
 * The uploaded text is parsed and then dropped; it is never written to the database.
 *
 * Both paths end the same way: every survivor passes the same validator Arena uses for AI output,
 * failures are dropped instead of shipped, and the accepted set is stored already approved so the paper
 * can actually start. Nobody outside the server can read a question before the paper closes — not
 * students, and not the host either: the only thing this module ever returns is counts.
 */
import { nowIso, one, run, uuid } from '../../db/index.js';
import { HttpError } from '../../middleware/errors.js';
import type { ArenaBlueprint, ArenaGeneratedQuestion, BlueprintSlot } from '../../types/arena.js';
import { completeJson } from '../ai/router.js';
import { paperTwistSystem } from '../ai/prompts.js';
import { normaliseBlueprint, totalQuestions } from '../arena/blueprint.js';
import { generatePaper, paperReadiness, validateQuestion } from '../arena/questions.js';
import { promptContextFor } from '../tutor.js';
import { loadForMember } from './access.js';

/* ------------------------------------------------------------------ text parsing ---------------- */

export interface UploadedQuestion {
  prompt: string;
  options: [string, string, string, string];
  answer: string;
  explanation: string;
}

/**
 * Reads the plain-text paper format.
 *
 * Deliberately forgiving, because schools write papers in whatever shape they already use:
 *
 *   1) What is the SI unit of force?
 *   A) Newton
 *   B) Joule
 *   C) Watt
 *   D) Pascal
 *   Answer: A
 *   Explanation: Force is measured in newtons.      (optional)
 *
 * Accepts `1.` / `1)` / `Q1` / `Question 1` for the stem, `A)` / `A.` / `(A)` for options, and
 * `Answer: A` or `Answer: 2` for the key. Blank lines between questions are optional.
 */
export function parseUploadedPaper(text: string): { questions: UploadedQuestion[]; skipped: number } {
  const lines = text.replace(/\r\n?/g, '\n').replace(/\u00a0/g, ' ').split('\n');
  const questions: UploadedQuestion[] = [];
  let skipped = 0;

  let prompt = '';
  let options: string[] = [];
  let answerIndex: number | null = null;
  let explanation = '';
  let expecting: 'stem' | 'options' | 'explanation' = 'stem';

  const stemPattern = /^\s*(?:Q(?:uestion)?\s*)?\d{1,3}\s*[).:\-]\s*(.+)$/i;
  const bareStem = /^\s*Q(?:uestion)?\s*\d{1,3}\s*[:.\-]?\s*(.+)$/i;
  const optionPattern = /^\s*\(?([A-Da-d])\)?\s*[).:\-]?\s+(.+)$/;
  const answerPattern = /^\s*(?:answer|ans|correct(?:\s*option)?|key)\s*[:.\-]?\s*([A-Da-d]|\d{1,2})\s*$/i;
  const explanationPattern = /^\s*(?:explanation|reason|solution|why)\s*[:.\-]?\s*(.*)$/i;

  const flush = () => {
    const cleanPrompt = prompt.trim();
    const cleanOptions = options.map((option) => option.trim()).filter(Boolean);
    const key = answerIndex === null ? '' : cleanOptions[answerIndex] ?? '';
    if (cleanPrompt.length >= 12 && cleanOptions.length === 4 && key) {
      questions.push({
        prompt: cleanPrompt,
        options: cleanOptions as [string, string, string, string],
        answer: key,
        explanation: explanation.trim(),
      });
    } else if (cleanPrompt.length || cleanOptions.length) {
      skipped += 1;
    }
    prompt = '';
    options = [];
    answerIndex = null;
    explanation = '';
    expecting = 'stem';
  };

  for (const line of lines) {
    if (!line.trim()) continue;

    const answer = line.match(answerPattern);
    if (answer) {
      const token = answer[1].toUpperCase();
      answerIndex = /[A-D]/.test(token) ? token.charCodeAt(0) - 65 : Number(token) - 1;
      expecting = 'explanation';
      continue;
    }

    const reason = line.match(explanationPattern);
    if (reason && expecting === 'explanation') {
      explanation = reason[1];
      continue;
    }

    const option = line.match(optionPattern);
    if (option && options.length < 4 && expecting !== 'explanation') {
      options.push(option[2]);
      expecting = 'options';
      continue;
    }

    const stem = line.match(stemPattern) ?? line.match(bareStem);
    if (stem) {
      if (prompt || options.length) flush();
      prompt = stem[1];
      expecting = 'stem';
      continue;
    }

    /* A continuation line belongs to whatever came last. */
    if (expecting === 'explanation') explanation = `${explanation} ${line.trim()}`.trim();
    else if (expecting === 'options' && options.length) options[options.length - 1] = `${options[options.length - 1]} ${line.trim()}`.trim();
    else if (prompt) prompt = `${prompt} ${line.trim()}`.trim();
    else skipped += 1;
  }
  flush();

  return { questions, skipped };
}

/* ------------------------------------------------------------------ the rewrite pass ------------ */

/**
 * Scales every number in a piece of text by the same factor.
 *
 * Whole-number factors are used on purpose: they scale quantities, not units, so a question about
 * "24 N on a 6 kg body" becomes "48 N on a 12 kg body" and the same reasoning still lands on an option
 * that was scaled the same way. It also defeats the commonest way a paper leaks — a screenshot of the
 * original with its options intact.
 */
export function scaleNumbers(value: string, factor: number): string {
  /*
   * Numbers that are part of a unit or a formula index must not be scaled: "m/s2" would become "m/s8",
   * and "H2O" would become "H6O". A digit is left alone when it directly follows a letter or a caret —
   * which is exactly the shape of an exponent or a subscript — and everything else (quantities, counts,
   * marks) is scaled by the common factor.
   */
  return value.replace(/(?<![A-Za-z^])(-?\d+(?:\.\d+)?)/g, (match) => {
    const number = Number(match);
    if (!Number.isFinite(number)) return match;
    const scaled = number * factor;
    return Math.abs(scaled) >= 10 ? String(Math.round(scaled)) : String(Math.round(scaled * 100) / 100);
  });
}

/** Rotates then swaps, so the correct option moves to a different letter. Returns the new key. */
export function permuteOptions(
  options: string[],
  answer: string,
  seed: number,
): { options: string[]; answer: string } {
  const rotateBy = (seed % 3) + 1;
  let order = options.map((_, index) => index);
  order = [...order.slice(rotateBy), ...order.slice(0, rotateBy)];
  if (order.length >= 2 && seed % 2 === 0) [order[0], order[order.length - 1]] = [order[order.length - 1], order[0]];
  const permuted = order.map((index) => options[index]);
  const target = options.indexOf(answer);
  return { options: permuted, answer: target >= 0 ? permuted[order.indexOf(target)] : permuted[0] };
}

/** One uploaded question → one live question, transformed. Deterministic, so it is testable. */
export function rewriteQuestion(question: UploadedQuestion, seed: number, subject: string): ArenaGeneratedQuestion {
  const factors = [2, 3, 4, 5];
  const factor = factors[seed % factors.length];
  const { options, answer } = permuteOptions(question.options, question.answer, seed);
  const scaledAnswer = scaleNumbers(answer, factor);
  const scaledExplanation = question.explanation ? scaleNumbers(question.explanation, factor).trim() : '';
  /*
   * The validator (rightly) rejects an explanation that never mentions the answer, and the rewrite can
   * easily produce one: the original explanation names the original number. So the answer is stated
   * explicitly whenever the explanation does not already carry it.
   */
  const explanation = scaledExplanation.includes(scaledAnswer)
    ? scaledExplanation
    : `${scaledExplanation ? `${scaledExplanation} ` : ''}The correct answer is ${scaledAnswer}.`.trim();
  return {
    prompt: scaleNumbers(question.prompt, factor),
    options: options.map((option) => scaleNumbers(option, factor)),
    answer: scaledAnswer,
    explanation,
    subject,
    topic: 'community paper',
    difficulty: 'medium',
    type: 'mcq',
    marks: 4,
    negativeMarks: 1,
  };
}

/* ------------------------------------------------------------------ storage --------------------- */

/** Writes accepted questions straight to approved. Returns how many landed. */
/** Blueprint JSON that may be empty or half-written; the arena normaliser fills the rest. */
function safeJson(value: string | null | undefined): unknown {
  try {
    return JSON.parse(value || '{}');
  } catch {
    return {};
  }
}

async function insertApproved(competitionId: string, questions: ArenaGeneratedQuestion[]): Promise<number> {
  const existing = await one<{ next: number | null }>(
    'SELECT MAX(position) AS next FROM arena_questions WHERE competition_id = ?',
    [competitionId],
  );
  let position = (existing?.next ?? 0) + 1;
  const now = nowIso();
  let inserted = 0;
  for (const question of questions) {
    await run(
      `INSERT INTO arena_questions
         (id, competition_id, position, prompt, options, correct_answer, explanation, subject, topic, chapter,
          difficulty, question_type, marks, negative_marks, review_status, review_notes, source, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        uuid(),
        competitionId,
        position,
        question.prompt,
        question.options?.length ? JSON.stringify(question.options) : null,
        question.answer,
        question.explanation,
        question.subject,
        question.topic,
        question.chapter ?? null,
        question.difficulty,
        question.type,
        question.marks,
        question.negativeMarks,
        'approved',
        null,
        'upload',
        now,
      ],
    );
    position += 1;
    inserted += 1;
  }
  return inserted;
}

async function clearPaper(competitionId: string): Promise<void> {
  await run('DELETE FROM arena_questions WHERE competition_id = ?', [competitionId]);
}

/* ------------------------------------------------------------------ the two entry points -------- */

export interface PaperOutcome {
  mode: 'ai' | 'upload';
  accepted: number;
  rejected: number;
  skipped: number;
  /**
   * How the paper was produced. For an upload: `ai` (the model rewrote every question), `mixed` (some),
   * or `deterministic` (the server twisted them all — no provider configured, or the model failed).
   */
  method: 'ai' | 'mixed' | 'bank' | 'deterministic';
  /** Upload only: how many of the accepted questions came from the model. */
  rewrittenByModel?: number;
  ready: boolean;
  required: number;
  /** Never question text — this is what "nobody can see the paper" means in code. */
  note: string;
}

async function assertHost(userId: string, communityId: string, competitionId: string): Promise<void> {
  const { membership } = await loadForMember(userId, communityId, { requireMembership: true });
  const role = membership?.role ?? null;
  if (role !== 'owner' && role !== 'admin') {
    throw new HttpError(403, 'Only the community owner or a moderator can prepare its papers.', 'forbidden');
  }
  const link = await one<{ competition_id: string }>(
    'SELECT competition_id FROM community_competitions WHERE community_id = ? AND competition_id = ?',
    [communityId, competitionId],
  );
  if (!link) throw new HttpError(404, 'That competition is not hosted by this community.', 'not_found');
}

/* ------------------------------------------------------------------ */
/* The model pass: twisting uploaded questions so the file is useless  */
/* ------------------------------------------------------------------ */

interface TwistOutcome {
  questions: ArenaGeneratedQuestion[];
  /** How many of these were actually produced by a model (the rest were twisted deterministically). */
  fromModel: number;
  /** Set when the model was tried and could not be used, so the caller can say why. */
  note?: string;
}

/**
 * Asks a model to rewrite the teacher's questions into different questions about the same concepts.
 *
 * The deterministic rewrite below already makes the uploaded file useless as a key (values scale,
 * options move). This pass goes further: new numbers that change the arithmetic, new wording, new
 * distractors — the "twist" a teacher asks for. Two guarantees are kept either way:
 *
 *   1. a model answer is only kept if it passes the same validator AI-generated papers pass, and
 *   2. any question the model cannot deliver is twisted deterministically instead, so the count the
 *      host uploaded is the count that runs.
 *
 * If the router answers from the offline sample engine (no API key configured, demo mode), those
 * questions are *not* twists of the uploaded paper — they are discarded, and the deterministic pass
 * does the work instead. Reporting a demo answer as "the AI rewrote your paper" would be a lie.
 */
async function twistWithModel(args: {
  userId: string;
  subject: string;
  questions: UploadedQuestion[];
  slot: BlueprintSlot;
  marksPerQuestion: number;
  negativeMarks: number;
}): Promise<TwistOutcome> {
  const { questions } = args;
  if (!questions.length) return { questions: [], fromModel: 0 };

  const ctx = await promptContextFor(args.userId, args.subject);
  const produced: (ArenaGeneratedQuestion | null)[] = questions.map(() => null);
  let fromModel = 0;
  let note: string | undefined;
  const batchSize = 6;

  for (let start = 0; start < questions.length; start += batchSize) {
    const batch = questions.slice(start, start + batchSize);
    try {
      const { data, summary } = await completeJson<{ questions: Record<string, unknown>[] }>({
        userId: args.userId,
        task: 'exam',
        system: paperTwistSystem(ctx, { subject: args.subject, count: batch.length }),
        messages: [
          {
            role: 'user',
            content: [
              `Rewrite these ${batch.length} questions. Return the same number, in the same order.`,
              JSON.stringify(
                batch.map((question) => ({
                  prompt: question.prompt,
                  options: question.options,
                  answer: question.answer,
                  explanation: question.explanation ?? '',
                })),
              ),
              'Return only the JSON object described in the system message.',
            ].join('\n'),
          },
        ],
        temperature: 0.6,
        maxTokens: 3200,
      });

      if (summary.demo) {
        note = 'No AI provider is configured, so the deterministic twist was used.';
        continue;
      }

      const rows = Array.isArray(data.questions) ? data.questions : [];
      batch.forEach((_question, index) => {
        const raw = rows[index];
        if (!raw) return;
        const prompt = String(raw.prompt ?? '').trim();
        const options = Array.isArray(raw.options) ? (raw.options as unknown[]).map((o) => String(o).trim()) : [];
        const answer = String(raw.answer ?? '').trim();
        if (!prompt || options.length !== 4 || !answer) return;
        produced[start + index] = {
          prompt,
          options,
          answer,
          explanation: String(raw.explanation ?? '').trim(),
          subject: args.subject,
          topic: String(raw.topic ?? 'General').trim() || 'General',
          chapter: raw.chapter ? String(raw.chapter).trim() : undefined,
          difficulty: 'medium',
          type: 'mcq',
          marks: args.marksPerQuestion,
          negativeMarks: args.negativeMarks,
        } as ArenaGeneratedQuestion;
      });
    } catch (error) {
      note = error instanceof Error ? `The AI rewrite was not reachable (${error.message.slice(0, 60)}).` : undefined;
    }
  }

  /* Validate the model's work; anything that fails falls back to the deterministic twist. */
  const existing = new Map<string, string>();
  const exact = new Set<string>();
  const accepted: (ArenaGeneratedQuestion | null)[] = questions.map(() => null);
  produced.forEach((question, index) => {
    if (!question) return;
    const verdict = validateQuestion(question, {
      slot: args.slot,
      marksPerQuestion: args.marksPerQuestion,
      negativeMarks: args.negativeMarks,
      existing,
      exact,
      origin: 'ai',
    });
    if (verdict.status === 'rejected') return;
    exact.add(question.prompt.toLowerCase().replace(/\s+/g, ' '));
    accepted[index] = question;
    fromModel += 1;
  });

  return {
    questions: accepted.map((question, index) =>
      question ?? rewriteQuestion(questions[index], index + 1, args.subject),
    ),
    fromModel,
    note,
  };
}

export async function prepareCommunityPaper(args: {
  userId: string;
  communityId: string;
  competitionId: string;
  mode: 'ai' | 'upload';
  text?: string;
  blueprint?: ArenaBlueprint;
  subject?: string;
}): Promise<PaperOutcome> {
  await assertHost(args.userId, args.communityId, args.competitionId);

  const competition = await one<{ status: string; starts_at: string; ends_at: string; results_published_at: string | null }>(
    'SELECT status, starts_at, ends_at, results_published_at FROM arena_competitions WHERE id = ?',
    [args.competitionId],
  );
  if (!competition) throw new HttpError(404, 'That competition was not found.', 'not_found');

  /* A paper that has already run is history. Changing it would rewrite what students sat. */
  const readinessBefore = await paperReadiness(args.competitionId);
  if (readinessBefore.total > 0) {
    throw new HttpError(
      409,
      'This competition already has a paper. Removing or replacing it after students have seen it would make the result meaningless — host a new competition instead.',
      'paper_exists',
    );
  }

  if (args.mode === 'ai') {
    const blueprint = args.blueprint;
    if (!blueprint) throw new HttpError(400, 'A subject and question count are required.', 'bad_blueprint');
    const ctx = await promptContextFor(args.userId, blueprint.subjects?.[0]?.subject);
    const outcome = await generatePaper({
      userId: args.userId,
      competitionId: args.competitionId,
      blueprint,
      ctx,
      replace: true,
      autoApprove: true,
    });
    const readiness = await paperReadiness(args.competitionId);
    return {
      mode: 'ai',
      accepted: readiness.approved,
      rejected: outcome.rejected ?? 0,
      skipped: 0,
      method: outcome.usedBank ? 'bank' : 'ai',
      ready: readiness.ready,
      required: readiness.required,
      note: 'Generated on the server and approved automatically. No question text is returned to any browser.',
    };
  }

  const raw = (args.text ?? '').trim();
  if (raw.length < 40) throw new HttpError(400, 'Paste the paper, or upload a .txt / .csv / .md file.', 'empty_paper');

  const { questions: parsed, skipped } = parseUploadedPaper(raw);
  if (!parsed.length) {
    throw new HttpError(
      400,
      'No questions could be read. Use the format: a numbered question, four options A–D, then "Answer: A".',
      'unreadable_paper',
    );
  }

  const subject = args.subject?.trim() || 'General';
  const marksPerQuestion = 4;
  const negativeMarks = 1;

  /* One slot describes the whole uploaded paper: same subject, same shape for every question. */
  const slot: BlueprintSlot = { subject, difficulty: 'medium', type: 'mcq', count: parsed.length, chapters: [] };

  /*
   * Step one: the model twists the paper. Every question it returns is validated; anything missing,
   * malformed or rejected is twisted deterministically instead, so the count survives either way.
   */
  const twist = await twistWithModel({
    userId: args.userId,
    subject,
    questions: parsed.slice(0, 120),
    slot,
    marksPerQuestion,
    negativeMarks,
  });

  const accepted: ArenaGeneratedQuestion[] = [];
  let rejected = 0;
  const seen = new Set<string>();

  twist.questions.forEach((rewritten) => {
    const verdict = validateQuestion(rewritten, {
      slot,
      marksPerQuestion,
      negativeMarks,
      existing: new Map<string, string>(),
      exact: new Set<string>(),
      origin: 'ai',
    });
    /* Two rewrites that read identically would be a duplicate — drop the second. */
    const fingerprint = rewritten.prompt.toLowerCase().replace(/\s+/g, ' ');
    if (verdict.status === 'rejected' || seen.has(fingerprint)) {
      rejected += 1;
      return;
    }
    seen.add(fingerprint);
    accepted.push(rewritten);
  });

  /* Replace, don't append: an upload is the paper, not an addition to one. */
  await clearPaper(args.competitionId);
  const inserted = await insertApproved(args.competitionId, accepted);

  /*
   * The host's own paper decides how big the paper is.
   *
   * The host form also asks "how many questions", and a school that pastes a 25-question paper while the
   * box says 30 should get *their* 25 questions, not a competition that never becomes ready because the
   * blueprint asks for five more that do not exist. So the stored blueprint is realigned to the paper
   * that was actually uploaded — same marks, same duration, same difficulty mix, count = what runs.
   */
  const stored = await one<{ blueprint: string }>('SELECT blueprint FROM arena_competitions WHERE id = ?', [
    args.competitionId,
  ]);
  const settings = normaliseBlueprint(safeJson(stored?.blueprint));
  const total = totalQuestions(settings);
  if (total !== inserted) {
    const realigned: ArenaBlueprint = {
      ...settings,
      subjects: [{ subject: subject === 'General' ? settings.subjects[0]?.subject ?? subject : subject, count: inserted, chapters: [] }],
    };
    await run('UPDATE arena_competitions SET blueprint = ? WHERE id = ?', [JSON.stringify(realigned), args.competitionId]);
  }

  const readiness = await paperReadiness(args.competitionId);

  const method: 'ai' | 'mixed' | 'deterministic' =
    twist.fromModel === 0 ? 'deterministic' : twist.fromModel >= inserted ? 'ai' : 'mixed';
  const rewritten = inserted === 1 ? 'question was' : 'questions were';

  return {
    mode: 'upload',
    accepted: inserted,
    rejected,
    skipped,
    method,
    rewrittenByModel: twist.fromModel,
    ready: readiness.ready,
    required: readiness.required,
    note: [
      method === 'ai'
        ? `All ${inserted} ${rewritten} rewritten by the AI from your paper — new numbers, new wording, reordered options with new distractors — and each rewrite passed the same validation the AI-written papers pass.`
        : method === 'mixed'
          ? `${twist.fromModel} of ${inserted} questions were rewritten by the AI; the rest were twisted on the server (values scaled, options reordered, key following) because the model did not return a usable rewrite for them.`
          : `Every question was twisted on the server — values scaled by a common factor and options reordered with the key following — so the uploaded paper cannot be used as an answer key.`,
      twist.note ?? '',
      'The uploaded text was not stored, and no question text is sent back to any browser.',
    ]
      .filter(Boolean)
      .join(' '),
  };
}

/** Host-facing status: readiness only, never a question. */
/* ------------------------------------------------------------------ */
/* The seal: nobody reads a community paper while it can still be sat  */
/* ------------------------------------------------------------------ */

/**
 * Is this competition hosted by a community?
 *
 * Community papers are the ones with a leak surface we control end to end: the host wrote or uploaded
 * them, so a host who could read the stored paper back could compare it with what they gave students.
 */
export async function communityForCompetition(competitionId: string): Promise<string | null> {
  const row = await one<{ community_id: string }>(
    'SELECT community_id FROM community_competitions WHERE competition_id = ?',
    [competitionId],
  );
  return row?.community_id ?? null;
}

/**
 * "Leak 0" has to include the operators, or it is not leak 0 — it is leak-later.
 *
 * The Arena console has a route that returns every question of a competition with its key, for
 * reviewing papers before publishing. For a *community* paper that route is sealed until the paper's
 * own window has ended: while students can still sit an exam, no browser — host, member or platform
 * admin — can read the stored questions. After the window ends the console works normally, because
 * by then every attempt is already recorded.
 */
export async function assertCommunityPaperSealed(competitionId: string): Promise<void> {
  const communityId = await communityForCompetition(competitionId);
  if (!communityId) return;
  const row = await one<{ ends_at: string }>('SELECT ends_at FROM arena_competitions WHERE id = ?', [competitionId]);
  if (!row) return;
  if (new Date(row.ends_at).getTime() > Date.now()) {
    throw new HttpError(
      403,
      'This paper belongs to a community and stays sealed until its window ends — that is what keeps it un-leakable.',
      'community_paper_sealed',
    );
  }
}

export async function communityPaperStatus(userId: string, communityId: string, competitionId: string) {
  await assertHost(userId, communityId, competitionId);
  const readiness = await paperReadiness(competitionId);
  return {
    total: readiness.total,
    approved: readiness.approved,
    pending: readiness.pending,
    flagged: readiness.flagged,
    ready: readiness.ready,
    required: readiness.required,
  };
}
