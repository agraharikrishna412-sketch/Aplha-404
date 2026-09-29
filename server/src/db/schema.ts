/**
 * Schema + migrations. Portable between PostgreSQL and SQLite (see db/index.ts).
 * Applied automatically on boot; each migration runs once inside a transaction.
 */
import { getDb, one, nowIso, uuid } from './index.js';

export interface Migration {
  id: string;
  sql: string;
}

const M1_INITIAL = `
CREATE TABLE IF NOT EXISTS users (
  id TEXT PRIMARY KEY,
  email TEXT NOT NULL UNIQUE,
  name TEXT NOT NULL,
  class_level TEXT,
  board TEXT,
  password_hash TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS api_keys (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  provider TEXT NOT NULL,
  label TEXT NOT NULL,
  secret_enc TEXT NOT NULL,
  masked TEXT NOT NULL,
  fingerprint TEXT NOT NULL,
  is_default INTEGER NOT NULL DEFAULT 0,
  enabled INTEGER NOT NULL DEFAULT 1,
  status TEXT NOT NULL DEFAULT 'untested',
  last_checked_at TEXT,
  last_used_at TEXT,
  last_error_type TEXT,
  last_error_message TEXT,
  fail_count INTEGER NOT NULL DEFAULT 0,
  success_count INTEGER NOT NULL DEFAULT 0,
  cooldown_until TEXT,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_api_keys_user_provider ON api_keys (user_id, provider);

CREATE TABLE IF NOT EXISTS user_settings (
  user_id TEXT PRIMARY KEY,
  data TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS conversations (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  title TEXT NOT NULL,
  subject TEXT,
  task_kind TEXT NOT NULL DEFAULT 'general',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_conversations_user ON conversations (user_id, updated_at);

CREATE TABLE IF NOT EXISTS messages (
  id TEXT PRIMARY KEY,
  conversation_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  role TEXT NOT NULL,
  content TEXT NOT NULL,
  meta TEXT,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_messages_conversation ON messages (conversation_id, created_at);

CREATE TABLE IF NOT EXISTS notes (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  title TEXT NOT NULL,
  subject TEXT,
  chapter TEXT,
  content TEXT NOT NULL,
  tags TEXT,
  source TEXT NOT NULL DEFAULT 'manual',
  source_file TEXT,
  starred INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_notes_user ON notes (user_id, updated_at);

CREATE TABLE IF NOT EXISTS uploads (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  note_id TEXT,
  file_name TEXT NOT NULL,
  mime TEXT NOT NULL,
  size INTEGER NOT NULL,
  stored_path TEXT NOT NULL,
  kind TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_uploads_user ON uploads (user_id, created_at);

CREATE TABLE IF NOT EXISTS practice_sets (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  subject TEXT NOT NULL,
  chapter TEXT,
  difficulty TEXT NOT NULL,
  question_type TEXT NOT NULL,
  questions TEXT NOT NULL,
  source_kind TEXT NOT NULL DEFAULT 'generated',
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_practice_sets_user ON practice_sets (user_id, created_at);

CREATE TABLE IF NOT EXISTS practice_attempts (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  set_id TEXT NOT NULL,
  question_id TEXT NOT NULL,
  topic TEXT,
  subject TEXT,
  difficulty TEXT,
  answer TEXT,
  is_correct INTEGER NOT NULL DEFAULT 0,
  skipped INTEGER NOT NULL DEFAULT 0,
  feedback TEXT,
  time_spent_ms INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_attempts_user ON practice_attempts (user_id, created_at);

CREATE TABLE IF NOT EXISTS exams (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  title TEXT NOT NULL,
  subject TEXT NOT NULL,
  chapters TEXT,
  difficulty TEXT NOT NULL,
  duration_min INTEGER NOT NULL,
  questions TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'draft',
  created_at TEXT NOT NULL,
  completed_at TEXT
);
CREATE INDEX IF NOT EXISTS idx_exams_user ON exams (user_id, created_at);

CREATE TABLE IF NOT EXISTS exam_results (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  exam_id TEXT NOT NULL,
  score REAL NOT NULL,
  total INTEGER NOT NULL,
  correct INTEGER NOT NULL,
  accuracy REAL NOT NULL,
  time_spent_ms INTEGER NOT NULL DEFAULT 0,
  answers TEXT NOT NULL,
  weak_topics TEXT,
  strong_topics TEXT,
  analysis TEXT,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_exam_results_user ON exam_results (user_id, created_at);

CREATE TABLE IF NOT EXISTS activity_events (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  kind TEXT NOT NULL,
  subject TEXT,
  topic TEXT,
  duration_ms INTEGER NOT NULL DEFAULT 0,
  correct INTEGER,
  total INTEGER,
  label TEXT NOT NULL,
  meta TEXT,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_activity_user ON activity_events (user_id, created_at);

CREATE TABLE IF NOT EXISTS topic_stats (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  subject TEXT NOT NULL,
  topic TEXT NOT NULL,
  attempted INTEGER NOT NULL DEFAULT 0,
  correct INTEGER NOT NULL DEFAULT 0,
  last_seen_at TEXT NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_topic_stats_unique ON topic_stats (user_id, subject, topic);

CREATE TABLE IF NOT EXISTS code_sessions (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  title TEXT NOT NULL,
  language TEXT NOT NULL,
  code TEXT NOT NULL,
  last_output TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_code_sessions_user ON code_sessions (user_id, updated_at);

CREATE TABLE IF NOT EXISTS schema_migrations (
  id TEXT PRIMARY KEY,
  applied_at TEXT NOT NULL
);
`;

const M2_ARENA = `
ALTER TABLE users ADD COLUMN role TEXT NOT NULL DEFAULT 'student';

CREATE TABLE IF NOT EXISTS arena_competitions (
  id TEXT PRIMARY KEY,
  title TEXT NOT NULL,
  description TEXT NOT NULL,
  category TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'draft',
  registration_opens_at TEXT NOT NULL,
  registration_closes_at TEXT NOT NULL,
  starts_at TEXT NOT NULL,
  ends_at TEXT NOT NULL,
  duration_min INTEGER NOT NULL,
  difficulty TEXT NOT NULL,
  blueprint TEXT NOT NULL,
  rules TEXT,
  instructions TEXT,
  visibility TEXT NOT NULL DEFAULT 'public',
  invite_code TEXT,
  is_demo INTEGER NOT NULL DEFAULT 0,
  created_by TEXT,
  published_at TEXT,
  results_published_at TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_arena_competitions_status ON arena_competitions (status, starts_at);
CREATE INDEX IF NOT EXISTS idx_arena_competitions_invite ON arena_competitions (invite_code);

CREATE TABLE IF NOT EXISTS arena_registrations (
  id TEXT PRIMARY KEY,
  competition_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'registered',
  registered_at TEXT NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_arena_reg_unique ON arena_registrations (competition_id, user_id);
CREATE INDEX IF NOT EXISTS idx_arena_reg_user ON arena_registrations (user_id, registered_at);

CREATE TABLE IF NOT EXISTS arena_questions (
  id TEXT PRIMARY KEY,
  competition_id TEXT NOT NULL,
  position INTEGER NOT NULL,
  prompt TEXT NOT NULL,
  options TEXT,
  correct_answer TEXT NOT NULL,
  explanation TEXT NOT NULL,
  subject TEXT NOT NULL,
  topic TEXT NOT NULL,
  chapter TEXT,
  difficulty TEXT NOT NULL,
  question_type TEXT NOT NULL,
  marks REAL NOT NULL DEFAULT 4,
  negative_marks REAL NOT NULL DEFAULT 1,
  review_status TEXT NOT NULL DEFAULT 'pending',
  review_notes TEXT,
  source TEXT NOT NULL DEFAULT 'ai',
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_arena_questions_comp ON arena_questions (competition_id, position);

CREATE TABLE IF NOT EXISTS arena_attempts (
  id TEXT PRIMARY KEY,
  competition_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  registration_id TEXT,
  started_at TEXT NOT NULL,
  deadline_at TEXT NOT NULL,
  submitted_at TEXT,
  status TEXT NOT NULL DEFAULT 'in_progress',
  score REAL,
  max_score REAL,
  correct INTEGER,
  incorrect INTEGER,
  unanswered INTEGER,
  accuracy REAL,
  time_used_ms INTEGER,
  auto_submitted INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_arena_attempt_unique ON arena_attempts (competition_id, user_id);
CREATE INDEX IF NOT EXISTS idx_arena_attempt_user ON arena_attempts (user_id, created_at);
CREATE INDEX IF NOT EXISTS idx_arena_attempt_status ON arena_attempts (competition_id, status);

CREATE TABLE IF NOT EXISTS arena_answers (
  id TEXT PRIMARY KEY,
  attempt_id TEXT NOT NULL,
  question_id TEXT NOT NULL,
  answer TEXT NOT NULL DEFAULT '',
  is_correct INTEGER NOT NULL DEFAULT 0,
  marks_awarded REAL NOT NULL DEFAULT 0,
  time_spent_ms INTEGER NOT NULL DEFAULT 0,
  flagged INTEGER NOT NULL DEFAULT 0,
  updated_at TEXT NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_arena_answers_unique ON arena_answers (attempt_id, question_id);

CREATE TABLE IF NOT EXISTS arena_results (
  id TEXT PRIMARY KEY,
  attempt_id TEXT NOT NULL UNIQUE,
  competition_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  score REAL NOT NULL,
  max_score REAL NOT NULL,
  correct INTEGER NOT NULL,
  incorrect INTEGER NOT NULL,
  unanswered INTEGER NOT NULL,
  accuracy REAL NOT NULL,
  time_used_ms INTEGER NOT NULL DEFAULT 0,
  percentile REAL,
  rank INTEGER,
  participant_count INTEGER,
  subject_analysis TEXT,
  topic_analysis TEXT,
  difficulty_analysis TEXT,
  type_analysis TEXT,
  time_analysis TEXT,
  computed_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_arena_results_comp ON arena_results (competition_id, score);
CREATE INDEX IF NOT EXISTS idx_arena_results_user ON arena_results (user_id, computed_at);

CREATE TABLE IF NOT EXISTS arena_performance_reports (
  id TEXT PRIMARY KEY,
  attempt_id TEXT NOT NULL UNIQUE,
  user_id TEXT NOT NULL,
  report TEXT NOT NULL,
  provider TEXT,
  model TEXT,
  generated_at TEXT NOT NULL
);
`;

/**
 * Mock Exam timing + answer persistence.
 *
 * Before this migration the countdown lived entirely in the browser: `started_at` was `Date.now()`
 * on every mount, so a refresh handed the student a fresh full-length timer, and answers were lost
 * whenever the tab reloaded. Both the clock and the saved answers now live on the server.
 *
 * `exam_answers` is a per-question upsert table (PK on exam + question) rather than a JSON blob so a
 * single autosave writes one row instead of rewriting the whole paper.
 */
const M3_EXAM_TIMING = `
ALTER TABLE exams ADD COLUMN started_at TEXT;

ALTER TABLE exams ADD COLUMN expires_at TEXT;

CREATE TABLE IF NOT EXISTS exam_answers (
  exam_id TEXT NOT NULL REFERENCES exams(id) ON DELETE CASCADE,
  question_id TEXT NOT NULL,
  answer TEXT NOT NULL DEFAULT '',
  flagged INTEGER NOT NULL DEFAULT 0,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (exam_id, question_id)
);

CREATE INDEX IF NOT EXISTS idx_exam_answers_exam ON exam_answers (exam_id);
`;

const M4_COMMUNITIES = `
CREATE TABLE IF NOT EXISTS communities (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  slug TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  logo_url TEXT,
  banner_url TEXT,
  category TEXT NOT NULL,
  tags TEXT NOT NULL DEFAULT '[]',
  rules TEXT NOT NULL DEFAULT '',
  visibility TEXT NOT NULL DEFAULT 'public',
  member_limit INTEGER,
  join_requirements TEXT NOT NULL DEFAULT '',
  welcome_message TEXT NOT NULL DEFAULT '',
  accent TEXT NOT NULL DEFAULT 'cyan',
  is_verified INTEGER NOT NULL DEFAULT 0,
  is_leaderboard_enabled INTEGER NOT NULL DEFAULT 1,
  status TEXT NOT NULL DEFAULT 'active',
  created_by TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_communities_slug ON communities (slug);
CREATE INDEX IF NOT EXISTS idx_communities_category ON communities (category, visibility, status);
CREATE INDEX IF NOT EXISTS idx_communities_owner ON communities (created_by, created_at);
CREATE INDEX IF NOT EXISTS idx_communities_visibility ON communities (visibility, status);

CREATE TABLE IF NOT EXISTS community_members (
  id TEXT PRIMARY KEY,
  community_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  role TEXT NOT NULL DEFAULT 'member',
  status TEXT NOT NULL DEFAULT 'active',
  contribution_points INTEGER NOT NULL DEFAULT 0,
  helpful_answers INTEGER NOT NULL DEFAULT 0,
  muted_until TEXT,
  mute_reason TEXT,
  joined_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_community_members_unique ON community_members (community_id, user_id);
CREATE INDEX IF NOT EXISTS idx_community_members_user ON community_members (user_id, status);
CREATE INDEX IF NOT EXISTS idx_community_members_role ON community_members (community_id, role, status);

CREATE TABLE IF NOT EXISTS community_join_requests (
  id TEXT PRIMARY KEY,
  community_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  reason TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL DEFAULT 'pending',
  decided_by TEXT,
  decided_at TEXT,
  created_at TEXT NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_join_requests_unique ON community_join_requests (community_id, user_id);
CREATE INDEX IF NOT EXISTS idx_join_requests_pending ON community_join_requests (community_id, status, created_at);

CREATE TABLE IF NOT EXISTS community_invites (
  id TEXT PRIMARY KEY,
  community_id TEXT NOT NULL,
  code TEXT NOT NULL,
  created_by TEXT NOT NULL,
  expires_at TEXT,
  max_uses INTEGER,
  use_count INTEGER NOT NULL DEFAULT 0,
  is_revoked INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_community_invites_code ON community_invites (code);
CREATE INDEX IF NOT EXISTS idx_community_invites_community ON community_invites (community_id, created_at);

CREATE TABLE IF NOT EXISTS community_blocks (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  blocked_user_id TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_community_blocks_unique ON community_blocks (user_id, blocked_user_id);

CREATE TABLE IF NOT EXISTS community_messages (
  id TEXT PRIMARY KEY,
  community_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  body TEXT NOT NULL,
  parent_id TEXT,
  is_pinned INTEGER NOT NULL DEFAULT 0,
  is_announcement INTEGER NOT NULL DEFAULT 0,
  edited_at TEXT,
  deleted_at TEXT,
  deleted_by TEXT,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_community_messages_feed ON community_messages (community_id, created_at);
CREATE INDEX IF NOT EXISTS idx_community_messages_parent ON community_messages (parent_id, created_at);
CREATE INDEX IF NOT EXISTS idx_community_messages_pinned ON community_messages (community_id, is_pinned, created_at);

CREATE TABLE IF NOT EXISTS message_reactions (
  id TEXT PRIMARY KEY,
  message_id TEXT NOT NULL,
  community_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  emoji TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_message_reactions_unique ON message_reactions (message_id, user_id, emoji);
CREATE INDEX IF NOT EXISTS idx_message_reactions_message ON message_reactions (message_id);

CREATE TABLE IF NOT EXISTS community_read_state (
  id TEXT PRIMARY KEY,
  community_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  last_read_at TEXT NOT NULL,
  last_read_message_id TEXT,
  updated_at TEXT NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_community_read_unique ON community_read_state (community_id, user_id);

CREATE TABLE IF NOT EXISTS community_announcements (
  id TEXT PRIMARY KEY,
  community_id TEXT NOT NULL,
  title TEXT NOT NULL,
  body TEXT NOT NULL,
  is_pinned INTEGER NOT NULL DEFAULT 0,
  expires_at TEXT,
  created_by TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_community_announcements_feed ON community_announcements (community_id, is_pinned, created_at);

CREATE TABLE IF NOT EXISTS community_doubts (
  id TEXT PRIMARY KEY,
  community_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  title TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  image_url TEXT,
  subject TEXT,
  topic TEXT,
  status TEXT NOT NULL DEFAULT 'open',
  helpful_answer_id TEXT,
  is_knowledge INTEGER NOT NULL DEFAULT 0,
  is_pinned INTEGER NOT NULL DEFAULT 0,
  answer_count INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_community_doubts_feed ON community_doubts (community_id, status, created_at);
CREATE INDEX IF NOT EXISTS idx_community_doubts_author ON community_doubts (user_id, created_at);

CREATE TABLE IF NOT EXISTS doubt_answers (
  id TEXT PRIMARY KEY,
  doubt_id TEXT NOT NULL,
  community_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  body TEXT NOT NULL,
  is_helpful INTEGER NOT NULL DEFAULT 0,
  edited_at TEXT,
  deleted_at TEXT,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_doubt_answers_doubt ON doubt_answers (doubt_id, created_at);

CREATE TABLE IF NOT EXISTS community_knowledge (
  id TEXT PRIMARY KEY,
  community_id TEXT NOT NULL,
  doubt_id TEXT,
  title TEXT NOT NULL,
  question TEXT NOT NULL,
  answer TEXT NOT NULL,
  ai_explanation TEXT,
  subject TEXT,
  topic TEXT,
  created_by TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_community_knowledge_feed ON community_knowledge (community_id, created_at);

CREATE TABLE IF NOT EXISTS community_resources (
  id TEXT PRIMARY KEY,
  community_id TEXT NOT NULL,
  title TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  category TEXT NOT NULL DEFAULT 'notes',
  kind TEXT NOT NULL DEFAULT 'link',
  url TEXT,
  note_id TEXT,
  subject TEXT,
  created_by TEXT NOT NULL,
  visibility TEXT NOT NULL DEFAULT 'members',
  is_pinned INTEGER NOT NULL DEFAULT 0,
  download_count INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_community_resources_feed ON community_resources (community_id, category, created_at);
CREATE INDEX IF NOT EXISTS idx_community_resources_note ON community_resources (note_id);

CREATE TABLE IF NOT EXISTS community_events (
  id TEXT PRIMARY KEY,
  community_id TEXT NOT NULL,
  title TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  kind TEXT NOT NULL DEFAULT 'study_session',
  starts_at TEXT NOT NULL,
  ends_at TEXT NOT NULL,
  host_id TEXT NOT NULL,
  meeting_url TEXT,
  participant_limit INTEGER,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_community_events_feed ON community_events (community_id, starts_at);

CREATE TABLE IF NOT EXISTS event_participants (
  id TEXT PRIMARY KEY,
  event_id TEXT NOT NULL,
  community_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'going',
  created_at TEXT NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_event_participants_unique ON event_participants (event_id, user_id);
CREATE INDEX IF NOT EXISTS idx_event_participants_user ON event_participants (user_id, created_at);

CREATE TABLE IF NOT EXISTS community_challenges (
  id TEXT PRIMARY KEY,
  community_id TEXT NOT NULL,
  title TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  subject TEXT,
  days TEXT NOT NULL DEFAULT '[]',
  status TEXT NOT NULL DEFAULT 'active',
  starts_at TEXT NOT NULL,
  ends_at TEXT NOT NULL,
  created_by TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_community_challenges_feed ON community_challenges (community_id, status, starts_at);

CREATE TABLE IF NOT EXISTS challenge_progress (
  id TEXT PRIMARY KEY,
  challenge_id TEXT NOT NULL,
  community_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  day_index INTEGER NOT NULL,
  status TEXT NOT NULL DEFAULT 'completed',
  note TEXT NOT NULL DEFAULT '',
  completed_at TEXT NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_challenge_progress_unique ON challenge_progress (challenge_id, user_id, day_index);
CREATE INDEX IF NOT EXISTS idx_challenge_progress_user ON challenge_progress (user_id, challenge_id);

CREATE TABLE IF NOT EXISTS study_plans (
  id TEXT PRIMARY KEY,
  community_id TEXT NOT NULL,
  title TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  subject TEXT,
  created_by TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_study_plans_feed ON study_plans (community_id, created_at);

CREATE TABLE IF NOT EXISTS study_plan_tasks (
  id TEXT PRIMARY KEY,
  plan_id TEXT NOT NULL,
  day_index INTEGER NOT NULL,
  title TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  position INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_study_plan_tasks_plan ON study_plan_tasks (plan_id, day_index, position);

CREATE TABLE IF NOT EXISTS study_plan_progress (
  id TEXT PRIMARY KEY,
  plan_id TEXT NOT NULL,
  task_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'done',
  completed_at TEXT NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_study_plan_progress_unique ON study_plan_progress (task_id, user_id);
CREATE INDEX IF NOT EXISTS idx_study_plan_progress_user ON study_plan_progress (user_id, plan_id);

CREATE TABLE IF NOT EXISTS study_rooms (
  id TEXT PRIMARY KEY,
  community_id TEXT NOT NULL,
  title TEXT NOT NULL,
  topic TEXT NOT NULL DEFAULT '',
  goal TEXT NOT NULL DEFAULT '',
  starts_at TEXT NOT NULL,
  ends_at TEXT NOT NULL,
  created_by TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_study_rooms_feed ON study_rooms (community_id, starts_at);

CREATE TABLE IF NOT EXISTS study_room_participants (
  id TEXT PRIMARY KEY,
  room_id TEXT NOT NULL,
  community_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  checklist TEXT NOT NULL DEFAULT '[]',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_study_room_participants_unique ON study_room_participants (room_id, user_id);

CREATE TABLE IF NOT EXISTS community_polls (
  id TEXT PRIMARY KEY,
  community_id TEXT NOT NULL,
  message_id TEXT,
  question TEXT NOT NULL,
  is_multiple INTEGER NOT NULL DEFAULT 0,
  is_anonymous INTEGER NOT NULL DEFAULT 0,
  expires_at TEXT,
  created_by TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_community_polls_feed ON community_polls (community_id, created_at);

CREATE TABLE IF NOT EXISTS poll_options (
  id TEXT PRIMARY KEY,
  poll_id TEXT NOT NULL,
  label TEXT NOT NULL,
  position INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_poll_options_poll ON poll_options (poll_id, position);

CREATE TABLE IF NOT EXISTS poll_votes (
  id TEXT PRIMARY KEY,
  poll_id TEXT NOT NULL,
  option_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_poll_votes_unique ON poll_votes (poll_id, option_id, user_id);
CREATE INDEX IF NOT EXISTS idx_poll_votes_poll ON poll_votes (poll_id);

CREATE TABLE IF NOT EXISTS community_reports (
  id TEXT PRIMARY KEY,
  community_id TEXT NOT NULL,
  reporter_id TEXT NOT NULL,
  entity_type TEXT NOT NULL,
  entity_id TEXT NOT NULL,
  reason TEXT NOT NULL,
  note TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL DEFAULT 'open',
  action_taken TEXT,
  resolved_by TEXT,
  resolved_at TEXT,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_community_reports_queue ON community_reports (community_id, status, created_at);
CREATE UNIQUE INDEX IF NOT EXISTS idx_community_reports_unique ON community_reports (community_id, reporter_id, entity_type, entity_id);

CREATE TABLE IF NOT EXISTS moderation_actions (
  id TEXT PRIMARY KEY,
  community_id TEXT NOT NULL,
  actor_id TEXT NOT NULL,
  action TEXT NOT NULL,
  target_type TEXT NOT NULL,
  target_id TEXT NOT NULL,
  target_user_id TEXT,
  reason TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_moderation_actions_log ON moderation_actions (community_id, created_at);

CREATE TABLE IF NOT EXISTS community_teams (
  id TEXT PRIMARY KEY,
  community_id TEXT NOT NULL,
  name TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  created_by TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_community_teams_feed ON community_teams (community_id, created_at);

CREATE TABLE IF NOT EXISTS team_members (
  id TEXT PRIMARY KEY,
  team_id TEXT NOT NULL,
  community_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  role TEXT NOT NULL DEFAULT 'member',
  created_at TEXT NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_team_members_unique ON team_members (team_id, user_id);
CREATE INDEX IF NOT EXISTS idx_team_members_user ON team_members (user_id);

CREATE TABLE IF NOT EXISTS community_competitions (
  id TEXT PRIMARY KEY,
  community_id TEXT NOT NULL,
  competition_id TEXT NOT NULL,
  created_by TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_community_competitions_unique ON community_competitions (community_id, competition_id);
CREATE INDEX IF NOT EXISTS idx_community_competitions_competition ON community_competitions (competition_id);
CREATE INDEX IF NOT EXISTS idx_community_competitions_feed ON community_competitions (community_id, created_at);

CREATE TABLE IF NOT EXISTS community_badges (
  id TEXT PRIMARY KEY,
  badge_key TEXT NOT NULL,
  label TEXT NOT NULL,
  emoji TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  criteria TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_community_badges_key ON community_badges (badge_key);

CREATE TABLE IF NOT EXISTS user_badges (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  badge_key TEXT NOT NULL,
  community_id TEXT,
  evidence TEXT NOT NULL DEFAULT '{}',
  earned_at TEXT NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_user_badges_unique ON user_badges (user_id, badge_key, community_id);
CREATE INDEX IF NOT EXISTS idx_user_badges_user ON user_badges (user_id, earned_at);

CREATE TABLE IF NOT EXISTS community_notifications (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  community_id TEXT,
  kind TEXT NOT NULL,
  title TEXT NOT NULL,
  body TEXT NOT NULL DEFAULT '',
  link TEXT,
  is_read INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_community_notifications_feed ON community_notifications (user_id, is_read, created_at);

CREATE TABLE IF NOT EXISTS community_notification_prefs (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  muted_kinds TEXT NOT NULL DEFAULT '[]',
  updated_at TEXT NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_community_notification_prefs_unique ON community_notification_prefs (user_id);

CREATE TABLE IF NOT EXISTS community_profile_settings (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  bio TEXT NOT NULL DEFAULT '',
  interests TEXT NOT NULL DEFAULT '[]',
  is_profile_public INTEGER NOT NULL DEFAULT 1,
  is_activity_visible INTEGER NOT NULL DEFAULT 1,
  is_communities_visible INTEGER NOT NULL DEFAULT 1,
  updated_at TEXT NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_community_profile_settings_unique ON community_profile_settings (user_id);
`;

/*
 * Study-team refinements (0005).
 *
 * 0004 created `community_teams` with only the essentials. Study teams need a goal, a cap and a
 * status so a finished team can be archived without deleting anyone's history, and an updated_at so
 * the lead can edit the team. These are additive ALTERs on a table 0004 itself created, with
 * defaults that satisfy every existing row - no data is rewritten (master prompt §58).
 */
const M5_COMMUNITY_TEAMS = `
ALTER TABLE community_teams ADD COLUMN goal TEXT NOT NULL DEFAULT '';

ALTER TABLE community_teams ADD COLUMN member_limit INTEGER;

ALTER TABLE community_teams ADD COLUMN status TEXT NOT NULL DEFAULT 'active';

ALTER TABLE community_teams ADD COLUMN updated_at TEXT NOT NULL DEFAULT '';

CREATE INDEX IF NOT EXISTS idx_community_teams_status ON community_teams (community_id, status);
`;

/**
 * Community resource files (0006).
 *
 * Until now a resource could only be a link, a note or a formula sheet. This adds the single column
 * needed to point a resource at a file the student uploaded, reusing the existing `uploads` table for
 * storage metadata (name, mime, size, stored path) rather than introducing a second file system.
 * `ALTER TABLE ... ADD COLUMN` is additive on both engines and leaves existing rows untouched.
 */
const M6_COMMUNITY_RESOURCE_FILES = `
ALTER TABLE community_resources ADD COLUMN upload_id TEXT;
`;

/**
 * Exam integrity (0007).
 *
 * Two additive tables that hold the evidence trail for a paper taken online:
 *
 *  - `integrity_events` is an append-only log of what a runner observed (focus lost and regained,
 *    full-screen exits, copy/paste attempts, a blocked context menu, a second display). Nothing here
 *    decides anything by itself — it is a record, with timestamps, that a student or a host can read.
 *  - `integrity_reports` is one aggregate row per paper, recomputed from the log, so a list of papers
 *    can show a risk level without scanning events.
 *
 * `scope` distinguishes an Arena competition (`arena`, keyed by competition id) from a personal mock
 * exam (`exam`, keyed by exam id). One mechanism, one place to fix a bug in it.
 *
 * Both are keyed to attempts that already exist, so an old database is unaffected: the tables are
 * new, nothing is altered, and no backfill is required.
 */
const M7_ARENA_INTEGRITY = `
CREATE TABLE IF NOT EXISTS integrity_events (
  id TEXT PRIMARY KEY,
  scope TEXT NOT NULL DEFAULT 'arena',
  ref_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  kind TEXT NOT NULL,
  detail TEXT NOT NULL DEFAULT '',
  occurred_at TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_integrity_events_ref ON integrity_events (scope, ref_id, occurred_at);
CREATE INDEX IF NOT EXISTS idx_integrity_events_kind ON integrity_events (scope, kind);

CREATE TABLE IF NOT EXISTS integrity_reports (
  id TEXT PRIMARY KEY,
  scope TEXT NOT NULL DEFAULT 'arena',
  ref_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  focus_lost_count INTEGER NOT NULL DEFAULT 0,
  focus_lost_ms INTEGER NOT NULL DEFAULT 0,
  fullscreen_exits INTEGER NOT NULL DEFAULT 0,
  copy_attempts INTEGER NOT NULL DEFAULT 0,
  paste_attempts INTEGER NOT NULL DEFAULT 0,
  menu_attempts INTEGER NOT NULL DEFAULT 0,
  key_blocks INTEGER NOT NULL DEFAULT 0,
  resize_count INTEGER NOT NULL DEFAULT 0,
  extended_display INTEGER NOT NULL DEFAULT 0,
  resume_count INTEGER NOT NULL DEFAULT 0,
  total_events INTEGER NOT NULL DEFAULT 0,
  risk_score INTEGER NOT NULL DEFAULT 0,
  risk_level TEXT NOT NULL DEFAULT 'clean',
  device TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_integrity_reports_ref ON integrity_reports (scope, ref_id);
CREATE INDEX IF NOT EXISTS idx_integrity_reports_level ON integrity_reports (scope, risk_level);
`;

/**
 * Study-room checklists (0008).
 *
 * A room's checklist is its point: everyone works through the same list. The list was being accepted
 * from the host and then discarded, and every joiner received a generic default instead — so the host
 * and the members saw different tasks. The template now lives on the room, and joining copies it.
 */
const M8_ROOM_CHECKLIST = `
ALTER TABLE study_rooms ADD COLUMN checklist TEXT NOT NULL DEFAULT '[]';
`;

/**
 * Profiles and private messaging (0009).
 *
 * Two things live here, both additive:
 *
 *  1. **A student profile.** `community_profile_settings` already holds one row per student (bio,
 *     interests, visibility), so the platform profile extends that table rather than introducing a
 *     second, competing one — no data is copied, no row is rewritten, and an existing bio keeps
 *     working. Added: a public handle, an avatar, an accent, a message policy and a visibility switch
 *     for achievements. `username` is stored lower-cased so uniqueness is case-insensitive on both
 *     engines without a functional index.
 *
 *  2. **Private messaging (DM), deliberately separate from community chat.** Community permissions,
 *     moderation and moderators have *no* access here: a community owner cannot read a student's
 *     private conversations. Message bodies are stored as ciphertext only — the columns are
 *     `ciphertext`, `iv`, `alg` and `key_version`, and there is no plaintext column to accidentally
 *     fill in later.
 *
 *     - `dm_conversations` / `dm_members` are the conversation and its participants.
 *     - `dm_device_keys` holds each browser's public key. The private half never leaves the device.
 *     - `dm_key_envelopes` holds the conversation key wrapped to one device's public key, so a new
 *       device can be given access without the server ever seeing the key itself.
 *     - `dm_messages` holds ciphertext, a reply pointer and edit/delete timestamps.
 *     - `dm_receipts` is the per-member read watermark used for unread counts and read state.
 *
 * Blocks reuse the existing `community_blocks` table: a block is a platform-wide decision about a
 * person, so it must apply to private messages too — a second block list would be a bypass (§8).
 */
const M9_PROFILE_AND_DM = `
ALTER TABLE community_profile_settings ADD COLUMN username TEXT;
ALTER TABLE community_profile_settings ADD COLUMN avatar_url TEXT;
ALTER TABLE community_profile_settings ADD COLUMN accent TEXT NOT NULL DEFAULT '';
ALTER TABLE community_profile_settings ADD COLUMN dm_policy TEXT NOT NULL DEFAULT 'communities';
ALTER TABLE community_profile_settings ADD COLUMN achievements_visibility INTEGER NOT NULL DEFAULT 1;
CREATE UNIQUE INDEX IF NOT EXISTS idx_profile_username ON community_profile_settings (username);
CREATE INDEX IF NOT EXISTS idx_profile_search ON community_profile_settings (username, updated_at);

CREATE TABLE IF NOT EXISTS dm_conversations (
  id TEXT PRIMARY KEY,
  created_by TEXT NOT NULL,
  key_version INTEGER NOT NULL DEFAULT 1,
  last_message_at TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_dm_conversations_recent ON dm_conversations (last_message_at, updated_at);

CREATE TABLE IF NOT EXISTS dm_members (
  id TEXT PRIMARY KEY,
  conversation_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  joined_at TEXT NOT NULL,
  is_muted INTEGER NOT NULL DEFAULT 0,
  is_archived INTEGER NOT NULL DEFAULT 0,
  request_state TEXT NOT NULL DEFAULT 'accepted'
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_dm_members_unique ON dm_members (conversation_id, user_id);
CREATE INDEX IF NOT EXISTS idx_dm_members_user ON dm_members (user_id, conversation_id);

CREATE TABLE IF NOT EXISTS dm_device_keys (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  device_id TEXT NOT NULL,
  public_key TEXT NOT NULL,
  alg TEXT NOT NULL DEFAULT 'ECDH-P256',
  label TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL,
  last_seen_at TEXT NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_dm_device_keys_unique ON dm_device_keys (user_id, device_id);

CREATE TABLE IF NOT EXISTS dm_key_envelopes (
  id TEXT PRIMARY KEY,
  conversation_id TEXT NOT NULL,
  device_id TEXT NOT NULL,
  recipient_user_id TEXT NOT NULL,
  sender_user_id TEXT NOT NULL,
  wrapped_key TEXT NOT NULL,
  iv TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_dm_envelopes_unique ON dm_key_envelopes (conversation_id, device_id);
CREATE INDEX IF NOT EXISTS idx_dm_envelopes_recipient ON dm_key_envelopes (recipient_user_id, device_id);

CREATE TABLE IF NOT EXISTS dm_messages (
  id TEXT PRIMARY KEY,
  conversation_id TEXT NOT NULL,
  sender_id TEXT NOT NULL,
  ciphertext TEXT NOT NULL,
  iv TEXT NOT NULL,
  alg TEXT NOT NULL DEFAULT 'AES-256-GCM',
  key_version INTEGER NOT NULL DEFAULT 1,
  reply_to_id TEXT,
  edited_at TEXT,
  deleted_at TEXT,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_dm_messages_feed ON dm_messages (conversation_id, created_at);
CREATE INDEX IF NOT EXISTS idx_dm_messages_sender ON dm_messages (sender_id, created_at);

CREATE TABLE IF NOT EXISTS dm_reactions (
  id TEXT PRIMARY KEY,
  message_id TEXT NOT NULL,
  conversation_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  reaction TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_dm_reactions_unique ON dm_reactions (message_id, user_id, reaction);

CREATE TABLE IF NOT EXISTS dm_receipts (
  id TEXT PRIMARY KEY,
  conversation_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  last_read_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_dm_receipts_unique ON dm_receipts (conversation_id, user_id);

CREATE TABLE IF NOT EXISTS news_fetch_log (
  id TEXT PRIMARY KEY,
  category TEXT NOT NULL,
  items INTEGER NOT NULL DEFAULT 0,
  fetched_at TEXT NOT NULL,
  ok INTEGER NOT NULL DEFAULT 0
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_news_fetch_log_category ON news_fetch_log (category);
`;

/**
 * Private-chat safety reports.
 *
 * These deliberately do NOT live in `community_reports`: a report about a private conversation must
 * never appear in a community owner's or moderator's queue (§6 — community roles never see DMs).
 * Only platform staff (`requireAdmin`) and the reporter can read a row here, and the row holds no
 * message content — the server cannot decrypt a conversation, so a reporter's own words are all that
 * can exist.
 */
export const M10_DM_SAFETY = `
CREATE TABLE IF NOT EXISTS dm_reports (
  id TEXT PRIMARY KEY,
  reporter_id TEXT NOT NULL,
  conversation_id TEXT,
  message_id TEXT,
  target_user_id TEXT NOT NULL,
  reason TEXT NOT NULL,
  note TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL DEFAULT 'open',
  action_taken TEXT,
  resolved_by TEXT,
  resolved_at TEXT,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_dm_reports_queue ON dm_reports (status, created_at);
CREATE INDEX IF NOT EXISTS idx_dm_reports_reporter ON dm_reports (reporter_id, created_at);
`;

/**
 * Profile visibility becomes a three-way choice (0011).
 *
 * `profile_visibility` — 'public' | 'members' | 'private':
 *   public   anyone signed in sees the profile
 *   members  only students who share an active community see the details
 *   private  the owner only
 *
 * Why a second column rather than reusing `is_profile_public`: the boolean cannot express "my
 * classmates, nobody else", which is the setting most students actually want. It stays in the table
 * — and stays written in step by both writers — because the community layer reads it, and dropping a
 * column other code depends on is how a "small" migration becomes an outage.
 *
 * Backfill maps the old boolean onto the new column so every existing row keeps its current
 * behaviour: public stays public, private stays private.
 */
export const M11_PROFILE_VISIBILITY = `
ALTER TABLE community_profile_settings ADD COLUMN profile_visibility TEXT NOT NULL DEFAULT 'public';
UPDATE community_profile_settings
   SET profile_visibility = CASE WHEN is_profile_public = 1 THEN 'public' ELSE 'private' END
 WHERE profile_visibility IS NULL OR profile_visibility = 'public';
`;

export const MIGRATIONS: Migration[] = [
  { id: '0001_initial', sql: M1_INITIAL },
  { id: '0002_arena', sql: M2_ARENA },
  { id: '0003_exam_timing', sql: M3_EXAM_TIMING },
  /*
   * Vroqn Communities. Purely additive: no existing table is altered, dropped or rewritten, so
   * every row written by migrations 0001-0003 survives untouched (master prompt §58).
   * Arena is not duplicated — community competitions map to existing arena_competitions rows.
   */
  { id: '0004_communities', sql: M4_COMMUNITIES },
  { id: '0005_community_teams', sql: M5_COMMUNITY_TEAMS },
  { id: '0006_community_resource_files', sql: M6_COMMUNITY_RESOURCE_FILES },
  { id: '0007_arena_integrity', sql: M7_ARENA_INTEGRITY },
  { id: '0008_room_checklist', sql: M8_ROOM_CHECKLIST },
  { id: '0009_profile_and_dm', sql: M9_PROFILE_AND_DM },
  { id: '0010_dm_safety', sql: M10_DM_SAFETY },
  { id: '0011_profile_visibility', sql: M11_PROFILE_VISIBILITY },
];

/**
 * Applies pending migrations once, inside a transaction per migration, and records them in
 * `schema_migrations`. Both engines run the same drizzle-free SQL: types are `TEXT`, `INTEGER` and
 * `REAL`, which PostgreSQL accepts as-is, and every `CREATE ... IF NOT EXISTS` is idempotent, so a
 * restart against an existing database is a no-op.
 */
export async function migrate(): Promise<void> {
  const db = await getDb();
  await db.exec(
    'CREATE TABLE IF NOT EXISTS schema_migrations (id TEXT PRIMARY KEY, applied_at TEXT NOT NULL);',
  );
  for (const migration of MIGRATIONS) {
    const existing = await one<{ id: string }>('SELECT id FROM schema_migrations WHERE id = ?', [
      migration.id,
    ]);
    if (existing) continue;
    await db.transaction(async (tx) => {
      const statements = migration.sql
        .split(/;\s*\n/)
        .map((s) => s.trim())
        .filter((s) => s.length && !s.startsWith('--'));
      for (const statement of statements) {
        await runStatement(tx, statement);
      }
      await tx.run('INSERT INTO schema_migrations (id, applied_at) VALUES (?, ?)', [
        migration.id,
        nowIso(),
      ]);
    });
  }
}

/**
 * Executes one DDL statement.
 *
 * A unique index is the one statement that can legitimately fail on a database inherited from an
 * earlier release: if rows already violate it, PostgreSQL raises a duplicate-key error and SQLite
 * reports "UNIQUE constraint failed". Both mean the same thing — the constraint is already doing
 * its job on the data that exists — so they are logged and skipped rather than aborting the boot
 * (which would leave the deployment unable to start at all). Any other error is re-thrown.
 */
async function runStatement(tx: { exec: (sql: string) => Promise<void> }, statement: string): Promise<void> {
  const sql = statement.endsWith(';') ? statement : `${statement};`;
  try {
    await tx.exec(sql);
  } catch (err) {
    const message = String((err as Error)?.message ?? '');
    const isUniqueIndex = /CREATE UNIQUE INDEX/i.test(sql);
    if (isUniqueIndex && /duplicate key|UNIQUE constraint failed|already exists/i.test(message)) {
      console.warn(`[db] skipped unique index (existing rows already satisfy or violate it): ${sql.slice(0, 90)}…`);
      return;
    }
    throw err;
  }
}

export function newId(): string {
  return uuid();
}
