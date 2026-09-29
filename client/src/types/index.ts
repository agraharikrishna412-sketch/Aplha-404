/** Client-side types. Mirrors server/src/types/domain.ts (kept hand-written so the client has no build coupling). */

export type ProviderId = 'gemini' | 'groq' | 'openrouter';
export type TaskKind = 'general' | 'coding' | 'notes' | 'exam' | 'practice' | 'vision' | 'grading' | 'fallback';

export interface User {
  id: string;
  email: string;
  name: string;
  /** 'admin' unlocks the Arena paper-review screen. Everyone else is a student. */
  role?: 'student' | 'admin';
  classLevel: string | null;
  board: string | null;
}

export type KeyStatus = 'untested' | 'connected' | 'rate_limited' | 'invalid' | 'error' | 'disabled';

export interface ApiKeyPublic {
  id: string;
  provider: ProviderId;
  label: string;
  masked: string;
  isDefault: boolean;
  enabled: boolean;
  status: KeyStatus;
  lastCheckedAt: string | null;
  lastUsedAt: string | null;
  lastErrorType: string | null;
  lastErrorMessage: string | null;
  failCount: number;
  successCount: number;
  cooldownUntil: string | null;
  createdAt: string;
}

export interface ModelSpec {
  id: string;
  label: string;
  speed: 'fast' | 'balanced' | 'deep';
  vision: boolean;
  code: boolean;
  contextK: number;
  note?: string;
}

export interface ProviderCatalogueEntry {
  id: ProviderId;
  label: string;
  keyUrl: string;
  keyPrefixHint: string;
  docsUrl: string;
  capabilities: {
    streaming: boolean;
    vision: boolean;
    pdf: boolean;
    json: boolean;
  };
  models: ModelSpec[];
}

export interface KeyOverviewEntry {
  total: number;
  enabled: number;
  connected: number;
  needsAttention: number;
  keys: ApiKeyPublic[];
}

export interface UserSettings {
  routing: Record<TaskKind, ProviderId>;
  modelPrefs: Partial<Record<ProviderId, string>>;
  demoMode: boolean;
  explanationLevel: 'class6_8' | 'class9_10' | 'class11_12' | 'beginner_college';
  language: 'english' | 'hinglish' | 'hindi';
  subjectDefaults: { subject: string; chapter: string; difficulty: string };
}

export interface VisualSuggestion {
  title: string;
  kind: 'diagram' | 'illustration' | 'map' | 'chart' | 'photo';
  description: string;
  query: string;
}

export interface MessageMeta {
  provider?: ProviderId;
  model?: string;
  task?: TaskKind;
  attempts?: number;
  fellBack?: boolean;
  demo?: boolean;
  keyLabel?: string;
  latencyMs?: number;
  attachments?: string[];
  visuals?: VisualSuggestion[];
  followUps?: string[];
  degradedReason?: string;
}

export interface ChatMessageRecord {
  id: string;
  conversationId: string;
  role: 'user' | 'assistant' | 'system';
  content: string;
  meta: MessageMeta | null;
  createdAt: string;
}

export interface Conversation {
  id: string;
  title: string;
  subject: string | null;
  taskKind: TaskKind;
  createdAt: string;
  updatedAt: string;
  messageCount?: number;
}

export interface Note {
  id: string;
  title: string;
  subject: string | null;
  chapter: string | null;
  content: string;
  tags: string[];
  source: 'manual' | 'upload' | 'tutor' | 'ai';
  sourceFile: string | null;
  starred: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface StructuredNote {
  title: string;
  subject: string;
  chapter: string;
  summary: string;
  keyPoints: string[];
  definitions: { term: string; meaning: string }[];
  formulas: string[];
  quickRevision: string[];
  practiceQuestions: string[];
}

export type QuestionType = 'mcq' | 'short' | 'numerical' | 'conceptual';
export type QuestionTypeChoice = QuestionType | 'mixed';

export interface PracticeQuestion {
  id: string;
  topic: string;
  type: QuestionType;
  prompt: string;
  options?: string[];
  answer: string;
  explanation: string;
  steps?: string[];
  marks: number;
  hint?: string;
}

export interface PracticeSet {
  id: string;
  subject: string;
  chapter: string | null;
  difficulty: string;
  questionType: QuestionTypeChoice;
  questions: PracticeQuestion[];
  sourceKind: 'generated' | 'demo' | 'seed';
  createdAt: string;
}

export interface AttemptFeedback {
  isCorrect: boolean;
  verdict: string;
  explanation: string;
  steps?: string[];
  correctAnswer: string;
  topic: string;
}

export interface PracticeAttempt {
  id: string;
  setId: string;
  questionId: string;
  topic: string | null;
  subject: string | null;
  difficulty: string | null;
  answer: string | null;
  isCorrect: boolean;
  skipped: boolean;
  feedback: AttemptFeedback | null;
  timeSpentMs: number;
  createdAt: string;
}

export interface ExamSummary {
  id: string;
  title: string;
  subject: string;
  chapters: string[];
  difficulty: string;
  durationMin: number;
  questions: number;
  status: 'draft' | 'in_progress' | 'completed';
  createdAt: string;
  completedAt: string | null;
}

export interface ExamDetail {
  id: string;
  title: string;
  subject: string;
  chapters: string[];
  difficulty: string;
  durationMin: number;
  status: 'draft' | 'in_progress' | 'completed';
  createdAt: string;
  completedAt: string | null;
  questions: PracticeQuestion[];
  /** Server-anchored timing: the deadline the runner counts down to (null before the paper is opened). */
  startedAt?: string | null;
  expiresAt?: string | null;
  /** Milliseconds left per the server clock — the source of truth, not the browser's counter. */
  remainingMs?: number;
  expired?: boolean;
  durationMs?: number;
  /** Answers autosaved by the server, restored when an attempt is resumed. */
  savedAnswers?: Record<string, string>;
  flagged?: string[];
}

export interface ExamResult {
  id: string;
  examId: string;
  score: number;
  total: number;
  correct: number;
  accuracy: number;
  timeSpentMs: number;
  weakTopics: string[];
  strongTopics: string[];
  recommendedRevision: string[];
  perTopic: { topic: string; correct: number; total: number }[];
  summary: string;
  createdAt: string;
  answers: { questionId: string; answer: string; isCorrect: boolean; timeMs: number }[];
}

export type ActivityKind = 'tutor' | 'practice' | 'exam' | 'notes' | 'code' | 'upload';

export interface ActivityEvent {
  id: string;
  kind: ActivityKind;
  subject: string | null;
  topic: string | null;
  durationMs: number;
  correct: number | null;
  total: number | null;
  label: string;
  meta: Record<string, unknown> | null;
  createdAt: string;
}

export interface TopicMastery {
  subject: string;
  topic: string;
  attempted: number;
  correct: number;
  accuracy: number;
}

export interface LearningSummary {
  date: string;
  minutes: number;
  questionsAttempted: number;
  questionsCorrect: number;
  accuracy: number;
  notesOrganized: number;
  codeMinutes: number;
  tutorMinutes: number;
  examsTaken: number;
  bestExam: { score: number; total: number; subject: string } | null;
  weakTopics: TopicMastery[];
  strongTopics: TopicMastery[];
  streakDays: number;
  bySubject: { subject: string; minutes: number; attempted: number; correct: number }[];
  timeline: { day: string; minutes: number; questions: number }[];
}

export interface CodeSession {
  id: string;
  title: string;
  language: string;
  code: string;
  lastOutput: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface RunResult {
  ok: boolean;
  mode: 'run' | 'preview' | 'disabled';
  stdout: string;
  stderr: string;
  exitCode: number | null;
  durationMs: number;
  timedOut: boolean;
  message?: string;
}

export interface CodeReview {
  summary?: string;
  rating?: number;
  issues?: { severity?: string; title?: string; detail?: string; fix?: string }[];
  improvements?: string[];
  reviewComments?: string[];
}

/* ------------------------- AI router event protocol ------------------------ */

export type RouterEvent =
  | {
      type: 'plan';
      plan: {
        task: TaskKind;
        steps: { provider: ProviderId; providerLabel: string; models: string[]; keyLabels: string[] }[];
        reason: string;
        demoAllowed: boolean;
      };
    }
  | {
      type: 'attempt';
      provider: ProviderId | string;
      providerLabel: string;
      model: string;
      keyLabel: string;
      attempt: number;
      maxAttempts: number;
    }
  | {
      type: 'attempt_failed';
      provider: ProviderId | string;
      providerLabel: string;
      model: string;
      keyLabel: string;
      failure: string;
      message: string;
      willRetry: boolean;
      attemptedPartial: boolean;
    }
  | { type: 'restart'; reason: string; attempt: number }
  | { type: 'delta'; text: string }
  | {
      type: 'done';
      provider: ProviderId;
      model: string;
      keyLabel: string;
      attempts: number;
      fellBack: boolean;
      demo: boolean;
      latencyMs: number;
      text: string;
    }
  | { type: 'error'; failure: string; message: string; attempts: number; hint?: string };

export interface DashboardPayload {
  user: { name: string; classLevel: string | null; board: string | null };
  greeting: string;
  summary: LearningSummary;
  activity: ActivityEvent[];
  suggestions: { id: string; title: string; detail: string; cta: string; href: string; tone: string }[];
  recent: {
    conversations: Conversation[];
    notes: Note[];
    practiceSets: { id: string; subject: string; chapter: string | null; questions: number; createdAt: string }[];
    exams: { id: string; title: string; subject: string; questionCount: number; status: string; createdAt: string }[];
    results: ExamResult[];
  };
  ai: {
    configuredProviders: string[];
    connectedProviders: string[];
    needsAttention: { provider: string; label: string; status: string }[];
    totalKeys: number;
    demoMode: boolean;
    routing: Record<TaskKind, ProviderId>;
  };
}


/* Arena (competitive exams) — see types/arena.ts. */
export * from './arena';
