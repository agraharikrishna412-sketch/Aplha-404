/**
 * Vroqn Arena domain types.
 *
 * The Arena is an independent Vroqn competitive mock examination — it is never presented as an
 * official JEE/NEET examination, and nothing here claims to predict a real rank.
 */

/* ------------------------------ competitions ----------------------------- */

/** Lifecycle status stored in the database (set by admins, or by the clock for time-driven states). */
export type CompetitionStatus =
  | 'draft'
  | 'registration_open'
  | 'registration_closed'
  | 'live'
  | 'submission_closed'
  | 'processing'
  | 'results_published'
  | 'archived';

/** State shown in the UI. Derived from stored status + the server clock, never from the device. */
export type CompetitionState =
  | 'UPCOMING'
  | 'REGISTRATION_OPEN'
  | 'LIVE'
  | 'SUBMISSION_CLOSED'
  | 'PROCESSING_RESULTS'
  | 'RESULTS_PUBLISHED'
  | 'ARCHIVED';

export type ArenaVisibility = 'public' | 'private';
export type ArenaDifficulty = 'easy' | 'medium' | 'hard';
/** Concept questions are multiple-choice concept checks so scoring stays objective. */
export type ArenaQuestionType = 'mcq' | 'numerical' | 'conceptual';
export type ArenaQuestionSource = 'ai' | 'demo' | 'manual';
export type ArenaQuestionReview = 'pending' | 'approved' | 'flagged' | 'rejected';
export type ArenaAttemptStatus = 'in_progress' | 'submitted' | 'auto_submitted' | 'invalidated';
export type ArenaRegistrationStatus = 'registered' | 'withdrawn' | 'disqualified';

/* -------------------------------- blueprint ------------------------------- */

export interface BlueprintSubject {
  subject: string;
  count: number;
  chapters?: string[];
}

export interface ArenaBlueprint {
  subjects: BlueprintSubject[];
  /** Percentage split. Values are normalised to 100 across all three. */
  difficulty: Record<ArenaDifficulty, number>;
  types: Record<ArenaQuestionType, number>;
  marksPerQuestion: number;
  /** Marks deducted for a wrong answer (unanswered questions are never penalised). */
  negativeMarks: number;
  /** Duration of the paper in minutes. */
  durationMin: number;
  /**
   * Optional numerical-answer tolerance for this competition, as a percentage of the expected value
   * (0–10). Omitted means "use the server default" (ARENA_NUMERIC_TOLERANCE_PCT).
   */
  numericTolerance?: number;
}

/** One generated question slot: "4 hard numericals of Mathematics". */
export interface BlueprintSlot {
  subject: string;
  difficulty: ArenaDifficulty;
  type: ArenaQuestionType;
  count: number;
  chapters: string[];
}

/* ------------------------------- persistence ------------------------------ */

export interface ArenaCompetitionRow {
  id: string;
  title: string;
  description: string;
  category: string;
  status: CompetitionStatus;
  registration_opens_at: string;
  registration_closes_at: string;
  starts_at: string;
  ends_at: string;
  duration_min: number;
  difficulty: string;
  blueprint: string;
  rules: string | null;
  instructions: string | null;
  visibility: string;
  invite_code: string | null;
  is_demo: number;
  created_by: string | null;
  results_published_at: string | null;
  created_at: string;
  updated_at: string;
}

/** Everything the student-facing UI needs. Never contains answer keys. */
export interface ArenaCompetitionSummary {
  id: string;
  title: string;
  description: string;
  category: string;
  status: CompetitionStatus;
  state: CompetitionState;
  registrationOpensAt: string;
  registrationClosesAt: string;
  startsAt: string;
  endsAt: string;
  durationMin: number;
  questionCount: number;
  difficulty: string;
  categoryLabel: string;
  subjects: string[];
  difficultyMix: Record<ArenaDifficulty, number>;
  typeMix: Record<ArenaQuestionType, number>;
  marksPerQuestion: number;
  negativeMarks: number;
  maxScore: number;
  isDemo: boolean;
  visibility: ArenaVisibility;
  resultsPublishedAt: string | null;
  participantCount: number;
  /** Null when the signed-in student has not registered. */
  registration: {
    id: string;
    status: ArenaRegistrationStatus;
    registeredAt: string;
  } | null;
  /** Only present for the owner/admin. */
  reviewCounts?: { pending: number; flagged: number; approved: number; rejected: number; total: number };
  /**
   * True when the signed-in student created this competition. It lets the host see the integrity
   * overview of their own paper (and only their own) without exposing it to other students.
   */
  isHost: boolean;
}

export interface ArenaCompetitionDetail extends ArenaCompetitionSummary {
  rules: string[];
  instructions: string[];
  /** Server clock, so the client can compute a drift-free countdown. */
  serverNow: string;
}

export interface ArenaBlueprintView {
  subjects: BlueprintSubject[];
  difficulty: Record<ArenaDifficulty, number>;
  types: Record<ArenaQuestionType, number>;
  marksPerQuestion: number;
  negativeMarks: number;
  durationMin: number;
  totalQuestions: number;
  numericTolerance: number;
  numericToleranceSource: 'blueprint' | 'env';
}

/* ------------------------------- questions -------------------------------- */

export interface ArenaQuestionRecord {
  id: string;
  competition_id: string;
  position: number;
  prompt: string;
  options: string | null;
  correct_answer: string;
  explanation: string;
  subject: string;
  topic: string;
  chapter: string | null;
  difficulty: string;
  question_type: string;
  marks: number;
  negative_marks: number;
  review_status: string;
  review_notes: string | null;
  source: string;
  created_at: string;
}

/** The only question shape ever sent to a student taking the paper. */
export interface ArenaQuestionForStudent {
  id: string;
  position: number;
  prompt: string;
  options: string[] | null;
  subject: string;
  topic: string;
  difficulty: ArenaDifficulty;
  type: ArenaQuestionType;
  marks: number;
  negativeMarks: number;
}

/** Post-exam review of the student's own attempt (only after submissions close). */
export interface ArenaQuestionReviewItem extends ArenaQuestionForStudent {
  yourAnswer: string;
  isCorrect: boolean;
  marksAwarded: number;
  correctAnswer: string;
  explanation: string;
  timeSpentMs: number;
}

export interface ArenaGeneratedQuestion {
  prompt: string;
  options?: string[];
  answer: string;
  explanation: string;
  subject: string;
  topic: string;
  chapter?: string;
  difficulty: ArenaDifficulty;
  type: ArenaQuestionType;
  marks: number;
  negativeMarks: number;
}

export interface QuestionValidation {
  status: 'ok' | 'flagged' | 'rejected';
  issues: string[];
}

/* -------------------------------- attempts -------------------------------- */

export interface ArenaAttemptRow {
  id: string;
  competition_id: string;
  user_id: string;
  registration_id: string | null;
  started_at: string;
  deadline_at: string;
  submitted_at: string | null;
  status: ArenaAttemptStatus;
  score: number | null;
  max_score: number | null;
  correct: number | null;
  incorrect: number | null;
  unanswered: number | null;
  accuracy: number | null;
  time_used_ms: number | null;
  auto_submitted: number;
  created_at: string;
}

export interface ArenaAnswerRow {
  id: string;
  attempt_id: string;
  question_id: string;
  answer: string;
  is_correct: number;
  marks_awarded: number;
  time_spent_ms: number;
  flagged: number;
  updated_at: string;
}

export interface ArenaExamPayload {
  attempt: {
    id: string;
    competitionId: string;
    competitionTitle: string;
    startedAt: string;
    /** Absolute deadline computed by the server: min(competition end, start + duration). */
    deadlineAt: string;
    remainingSeconds: number;
    status: ArenaAttemptStatus;
    autoSubmitted: boolean;
  };
  competition: {
    id: string;
    title: string;
    category: string;
    state: CompetitionState;
    durationMin: number;
    marksPerQuestion: number;
    negativeMarks: number;
    maxScore: number;
    isDemo: boolean;
    serverNow: string;
  };
  questions: ArenaQuestionForStudent[];
  answers: Record<string, { answer: string; flagged: boolean; timeSpentMs: number }>;
}

/* --------------------------------- results -------------------------------- */

export interface ArenaBreakdownItem {
  key: string;
  label: string;
  correct: number;
  incorrect: number;
  unanswered: number;
  total: number;
  accuracy: number;
  attempted: number;
}

export interface ArenaTimeAnalysis {
  totalMs: number;
  avgMsPerQuestion: number;
  slowestTopics: { topic: string; avgMs: number }[];
  /** Average time per question in the first vs the last third of the paper. */
  firstThirdAvgMs: number;
  lastThirdAvgMs: number;
  /** True when pace dropped noticeably at the end (evidence for time pressure). */
  timePressure: boolean;
}

export interface ArenaBenchmark {
  percentile: number;
  rank: number;
  participantCount: number;
  /** Label shown next to the numbers so nobody mistakes this for a real exam rank. */
  populationLabel: string;
  band: string;
}

export interface ArenaResultRecord {
  id: string;
  attempt_id: string;
  competition_id: string;
  user_id: string;
  score: number;
  max_score: number;
  correct: number;
  incorrect: number;
  unanswered: number;
  accuracy: number;
  time_used_ms: number;
  percentile: number | null;
  rank: number | null;
  participant_count: number | null;
  subject_analysis: string | null;
  topic_analysis: string | null;
  difficulty_analysis: string | null;
  type_analysis: string | null;
  time_analysis: string | null;
  computed_at: string;
}

export interface ArenaPerformanceReport {
  summary: string;
  strongAreas: string[];
  needsImprovement: string[];
  patterns: { pattern: string; evidence: string; suggestion: string }[];
  recommendations: string[];
  /** 'ai' when a model produced it, 'local' when it was derived from the attempt alone. */
  source: 'ai' | 'local';
  generatedAt: string;
  /**
   * Which provider produced the prose, enforced to be truthful: `'sample'` for the offline sample
   * library, `null` when nothing external was involved. Never a provider id that did not run.
   */
  provider?: string | null;
  /** Model id that produced the prose (`vroqn-sample` for the offline library). */
  model?: string | null;
}

export interface ArenaResultPayload {
  result: {
    id: string;
    attemptId: string;
    competitionId: string;
    competitionTitle: string;
    category: string;
    isDemo: boolean;
    submittedAt: string;
    autoSubmitted: boolean;
    score: number;
    maxScore: number;
    correct: number;
    incorrect: number;
    unanswered: number;
    attempted: number;
    accuracy: number;
    timeUsedMs: number;
    durationMin: number;
  };
  state: CompetitionState;
  benchmark: ArenaBenchmark | null;
  /**
   * The paper's marking rule (marks, negative marks, numerical tolerance) as applied at grading time,
   * so the analysis screen can explain why an answer was judged the way it was.
   */
  blueprint: {
    subjects: { subject: string; count: number; chapters?: string[] }[];
    difficulty: Record<ArenaDifficulty, number>;
    types: Record<ArenaQuestionType, number>;
    marksPerQuestion: number;
    negativeMarks: number;
    durationMin: number;
    totalQuestions: number;
    numericTolerance: number;
    numericToleranceSource: 'blueprint' | 'env';
  };
  subjectAnalysis: ArenaBreakdownItem[];
  topicAnalysis: ArenaBreakdownItem[];
  difficultyAnalysis: ArenaBreakdownItem[];
  typeAnalysis: ArenaBreakdownItem[];
  timeAnalysis: ArenaTimeAnalysis;
  report: ArenaPerformanceReport | null;
  practiceSuggestions: ArenaPracticeSuggestion[];
  /** Published standings among anonymised aspirants — only when results are published. */
  standings: ArenaStanding[] | null;
  review: ArenaQuestionReviewItem[] | null;
  reviewAvailable: boolean;
}

export interface ArenaStanding {
  /** Anonymised: "Aspirant 12" — never a name, email or user id. */
  label: string;
  rank: number;
  score: number;
  percentile: number;
  isYou: boolean;
}

export interface ArenaPracticeSuggestion {
  subject: string;
  chapter: string | null;
  topic: string;
  difficulty: ArenaDifficulty;
  questionType: ArenaQuestionType | 'mixed';
  count: number;
  reason: string;
}

export interface ArenaHistoryEntry {
  attemptId: string;
  competitionId: string;
  title: string;
  category: string;
  isDemo: boolean;
  submittedAt: string;
  score: number;
  maxScore: number;
  accuracy: number;
  percentile: number | null;
  rank: number | null;
  participantCount: number | null;
  resultsPublished: boolean;
  /** Change vs the previous published attempt of the same category, in percentage points. */
  accuracyDelta: number | null;
  scoreDelta: number | null;
}

export interface ArenaCatalog {
  categories: { id: string; label: string; blurb: string }[];
  states: { id: CompetitionState; label: string; tone: string }[];
  difficultyOrder: ArenaDifficulty[];
  questionTypes: { id: ArenaQuestionType; label: string; hint: string }[];
}
