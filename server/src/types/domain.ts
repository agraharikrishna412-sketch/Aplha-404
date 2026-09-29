/** Shared domain types (mirrored on the client in client/src/types/index.ts). */
import type { ProviderId, TaskKind } from '../config/models.js';

export interface User {
  id: string;
  email: string;
  name: string;
  classLevel: string | null;
  board: string | null;
  createdAt: string;
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

export interface UserSettings {
  /** Task → provider preferences (spec §15). */
  routing: Record<TaskKind, ProviderId>;
  /** Preferred model id per provider ('' = automatic). */
  modelPrefs: Partial<Record<ProviderId, string>>;
  /** Let the server fall back to the offline sample engine when no key works. */
  demoMode: boolean;
  /** Learning preferences */
  explanationLevel: 'class6_8' | 'class9_10' | 'class11_12' | 'beginner_college';
  language: 'english' | 'hinglish' | 'hindi';
  subjectDefaults: { subject: string; chapter: string; difficulty: string };
}

export const DEFAULT_SETTINGS: UserSettings = {
  routing: {
    general: 'gemini',
    coding: 'groq',
    notes: 'gemini',
    exam: 'gemini',
    practice: 'gemini',
    vision: 'gemini',
    grading: 'groq',
    fallback: 'openrouter',
  },
  modelPrefs: {},
  demoMode: true,
  explanationLevel: 'class9_10',
  language: 'english',
  subjectDefaults: { subject: 'Physics', chapter: '', difficulty: 'medium' },
};

export interface Conversation {
  id: string;
  title: string;
  subject: string | null;
  taskKind: TaskKind;
  createdAt: string;
  updatedAt: string;
  messageCount?: number;
}

export interface ChatMessageRecord {
  id: string;
  conversationId: string;
  role: 'user' | 'assistant' | 'system';
  content: string;
  meta: MessageMeta | null;
  createdAt: string;
}

export interface MessageMeta {
  provider?: ProviderId;
  model?: string;
  task?: TaskKind;
  attempts?: number;
  fellBack?: boolean;
  demo?: boolean;
  keyLabel?: string;
  attachments?: string[];
  visuals?: VisualSuggestion[];
  followUps?: string[];
  usage?: { inputTokens?: number; outputTokens?: number };
  degradedReason?: string;
}

export interface VisualSuggestion {
  title: string;
  kind: 'diagram' | 'illustration' | 'map' | 'chart' | 'photo';
  description: string;
  query: string;
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

export interface UploadRecord {
  id: string;
  noteId: string | null;
  fileName: string;
  mime: string;
  size: number;
  kind: 'image' | 'pdf' | 'text' | 'audio';
  createdAt: string;
}

export type QuestionType = 'mcq' | 'short' | 'numerical' | 'conceptual';

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

export type QuestionTypeChoice = QuestionType | 'mixed';

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

export interface ExamRecord {
  id: string;
  title: string;
  subject: string;
  chapters: string[];
  difficulty: string;
  durationMin: number;
  questions: PracticeQuestion[];
  status: 'draft' | 'in_progress' | 'completed';
  createdAt: string;
  completedAt: string | null;
  /** Server clock: set when the student first opens the paper, not when they create it. */
  startedAt: string | null;
  /** `startedAt + durationMin`. The runner trusts this, never its own countdown. */
  expiresAt: string | null;
}

export interface ExamAnalysis {
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
}

export interface ExamResult extends ExamAnalysis {
  id: string;
  examId: string;
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

export interface TopicStat {
  subject: string;
  topic: string;
  attempted: number;
  correct: number;
  lastSeenAt: string;
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
  weakTopics: { subject: string; topic: string; accuracy: number; attempted: number }[];
  strongTopics: { subject: string; topic: string; accuracy: number; attempted: number }[];
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
