/**
 * Arena types — the client-side mirror of server/src/types/arena.ts.
 *
 * Note what is *not* here: competitions never send `correctAnswer` or `explanation` to a student
 * while they can still submit, so the exam shape simply has no field for them.
 */

export type CompetitionState =
  | 'UPCOMING'
  | 'REGISTRATION_OPEN'
  | 'LIVE'
  | 'SUBMISSION_CLOSED'
  | 'PROCESSING_RESULTS'
  | 'RESULTS_PUBLISHED'
  | 'ARCHIVED';

export type ArenaDifficulty = 'easy' | 'medium' | 'hard';
export type ArenaQuestionType = 'mcq' | 'numerical' | 'conceptual';

export interface ArenaBlueprintView {
  subjects: { subject: string; count: number; chapters?: string[] }[];
  difficulty: Record<ArenaDifficulty, number>;
  types: Record<ArenaQuestionType, number>;
  marksPerQuestion: number;
  negativeMarks: number;
  durationMin: number;
  totalQuestions: number;
  /** Active numerical tolerance for this paper, as a percentage. */
  numericTolerance: number;
  numericToleranceSource: 'blueprint' | 'env';
}

export interface ArenaRegistration {
  id: string;
  status: 'registered' | 'withdrawn' | 'disqualified';
  registeredAt: string;
}

export interface ArenaPaperReadiness {
  total: number;
  approved: number;
  pending: number;
  flagged: number;
  rejected: number;
  required: number;
  coverage: number;
  ready: boolean;
  blocker: string | null;
}

export interface ArenaCompetitionSummary {
  id: string;
  title: string;
  description: string;
  category: string;
  categoryLabel: string;
  status: string;
  state: CompetitionState;
  registrationOpensAt: string;
  registrationClosesAt: string;
  startsAt: string;
  endsAt: string;
  durationMin: number;
  questionCount: number;
  difficulty: string;
  subjects: string[];
  difficultyMix: Record<ArenaDifficulty, number>;
  typeMix: Record<ArenaQuestionType, number>;
  marksPerQuestion: number;
  negativeMarks: number;
  maxScore: number;
  isDemo: boolean;
  visibility: 'public' | 'private';
  resultsPublishedAt: string | null;
  participantCount: number;
  registration: ArenaRegistration | null;
  reviewCounts?: { pending: number; flagged: number; approved: number; rejected: number; total: number };
  /** True when this student created the competition, so they can review its integrity record. */
  isHost: boolean;
  readiness?: ArenaPaperReadiness;
}

export interface ArenaCompetitionDetail extends ArenaCompetitionSummary {
  rules: string[];
  instructions: string[];
  serverNow: string;
}

/** Envelope returned by GET /arena/competitions/:id (`paper` is admin-only). */
export interface ArenaCompetitionDetailPayload {
  competition: ArenaCompetitionDetail;
  blueprint: ArenaBlueprintView | null;
  questionCount: number;
  paper: { total: number; bySubject: Record<string, number>; review: unknown } | null;
}

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

export interface ArenaExamPayload {
  attempt: {
    id: string;
    competitionId: string;
    competitionTitle: string;
    startedAt: string;
    deadlineAt: string;
    remainingSeconds: number;
    status: 'in_progress' | 'submitted' | 'auto_submitted' | 'invalidated';
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

export interface ArenaAttemptStatus {
  state: CompetitionState;
  serverNow: string;
  remainingSeconds: number;
  canAnswer: boolean;
  expired: boolean;
  closedReason: 'not_started' | 'not_live' | 'deadline_passed' | 'competition_over' | 'submitted' | null;
  attempt: {
    id: string;
    status: string;
    startedAt: string;
    deadlineAt: string;
    submittedAt: string | null;
    autoSubmitted: boolean;
  } | null;
}

/**
 * One breakdown row (subject / topic / difficulty / type).
 *
 * `accuracy` is a **ratio** (0–1): render it with `percent()` or feed it straight to `ProgressBar`.
 */
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
  firstThirdAvgMs: number;
  lastThirdAvgMs: number;
  timePressure: boolean;
}

export interface ArenaBenchmark {
  percentile: number;
  rank: number;
  participantCount: number;
  populationLabel: string;
  band: string;
}

export interface ArenaPerformanceReport {
  summary: string;
  strongAreas: string[];
  needsImprovement: string[];
  patterns: { pattern: string; evidence: string; suggestion: string }[];
  recommendations: string[];
  source: 'ai' | 'local';
  generatedAt: string;
}

/** A suggestion plus the ready-made Practice deep link the server built for it. */
export interface ArenaPracticeLink extends ArenaPracticeSuggestion {
  url: string;
  /** Only set when Practice actually knows this chapter (otherwise the link omits it). */
  chapter: string | null;
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

export interface ArenaStanding {
  label: string;
  rank: number;
  score: number;
  percentile: number;
  isYou: boolean;
}

export interface ArenaQuestionReviewItem extends ArenaQuestionForStudent {
  yourAnswer: string;
  isCorrect: boolean;
  marksAwarded: number;
  correctAnswer: string;
  explanation: string;
  timeSpentMs: number;
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
  /** Present so the result screen can explain the marking rule that was applied. */
  blueprint?: ArenaBlueprintView;
  subjectAnalysis: ArenaBreakdownItem[];
  topicAnalysis: ArenaBreakdownItem[];
  difficultyAnalysis: ArenaBreakdownItem[];
  typeAnalysis: ArenaBreakdownItem[];
  timeAnalysis: ArenaTimeAnalysis;
  report: ArenaPerformanceReport | null;
  practiceSuggestions: ArenaPracticeSuggestion[];
  standings: ArenaStanding[] | null;
  review: ArenaQuestionReviewItem[] | null;
  reviewAvailable: boolean;
}

/** Shipped by GET /arena/history. */
export interface ArenaHistoryPayload {
  history: ArenaHistoryEntry[];
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
  accuracyDelta: number | null;
  scoreDelta: number | null;
}

export interface ArenaMyCompetitions {
  upcoming: ArenaCompetitionSummary[];
  live: ArenaCompetitionSummary[];
  completed: ArenaCompetitionSummary[];
  attempts: Record<
    string,
    { attemptId: string; status: string; submittedAt: string | null; resultId: string | null; resultsPublished: boolean }
  >;
  serverNow: string;
}

export interface ArenaOverview {
  live: number;
  open: number;
  upcoming: number;
  registered: number;
  completed: number;
  next: ArenaCompetitionSummary | null;
}

export interface ArenaAdminQuestion {
  id: string;
  position: number;
  prompt: string;
  options: string[] | null;
  correctAnswer: string;
  explanation: string;
  subject: string;
  topic: string;
  chapter: string | null;
  difficulty: ArenaDifficulty;
  type: ArenaQuestionType;
  marks: number;
  negativeMarks: number;
  reviewStatus: 'pending' | 'approved' | 'flagged' | 'rejected';
  reviewNotes: string | null;
  source: string;
}
