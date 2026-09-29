/**
 * Offline sample engine.
 *
 * Only ever reaches the student when no provider key is usable (or demo mode is forced).
 * Output is streamed with realistic pacing so loading/streaming states stay exercised, and
 * every reply is explicitly labelled as sample content.
 */
import type { TaskKind } from '../../config/models.js';
import type { RunOptions } from './types.js';
import { demoCodingAnswer, demoQuestions, demoTeachingAnswer } from './demoBank.js';
import { detectConversationLanguage, type StudentLanguage } from './language.js';
import { fallbackLanguageFromSystem } from './prompts.js';

/**
 * The language to answer in.
 *
 * Mirroring the student's own words is the whole point (a Hinglish doubt answered in formal English
 * reads as "this did not understand me"). The conversation decides; the saved setting in the system
 * prompt is consulted only when the conversation so far is language-neutral — for a first message
 * that is nothing but "?" or "ok".
 */
function studentLanguage(opts: RunOptions): StudentLanguage {
  const texts: string[] = [];
  for (const message of opts.messages) {
    if (message.role !== 'user') continue;
    // Content arrives either as a plain string or as parts (`[{type:'text', text}]`), depending on
    // which route built the request. Reading only the string form silently found no text at all, so
    // every request looked language-neutral and fell back to the saved setting: a Hinglish question
    // was still answered in English sample prose.
    texts.push(contentText(message.content));
  }
  return detectConversationLanguage(texts, fallbackLanguageFromSystem(opts.system));
}

/** Flattens a message's content into the text the student actually typed. */
function contentText(content: unknown): string {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content
      .map((part) => (part && typeof part === 'object' && (part as { type?: string }).type === 'text' ? (part as { text?: string }).text ?? '' : ''))
      .join(' ');
  }
  return '';
}

function lastUserText(messages: { role: string; content: unknown }[]): string {
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    const m = messages[i];
    if (m.role !== 'user') continue;
    if (typeof m.content === 'string') return m.content;
    if (Array.isArray(m.content)) {
      const text = m.content
        .map((p: { type?: string; text?: string }) => (p.type === 'text' ? p.text ?? '' : '[image]'))
        .join(' ');
      return text;
    }
  }
  return '';
}

/** Extracts `{"count": n, "subject": "...", ...}` style hints from the prompt we sent. */
function hintsFromPrompt(prompt: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const key of ['subject', 'chapter', 'difficulty', 'questionType', 'count']) {
    const m = new RegExp(`"?${key}"?\\s*[:=]\\s*"?([^"\\n,}]+)`, 'i').exec(prompt);
    if (m) out[key] = m[1].trim();
  }
  return out;
}

function practiceJson(prompt: string): string {
  const hints = hintsFromPrompt(prompt);
  const count = Math.min(Math.max(Number(hints.count ?? 5) || 5, 1), 20);
  const questions = demoQuestions({
    subject: hints.subject,
    chapter: hints.chapter,
    count,
    type: (hints.questionType as never) ?? 'mixed',
  });
  return JSON.stringify({ questions }, null, 0);
}

export function buildDemoText(opts: RunOptions): string {
  const prompt = lastUserText(opts.messages as { role: string; content: unknown }[]);
  const task: TaskKind = opts.task;

  if (opts.json && (task === 'practice' || task === 'exam')) return practiceJson(prompt);

  if (opts.json && task === 'notes') {
    return JSON.stringify(
      {
        title: 'Sample restructured notes',
        subject: 'Physics',
        chapter: 'Motion',
        summary:
          'Motion is described using distance, displacement, speed, velocity and acceleration. Graphs convert motion into visual patterns: the slope of a velocity–time graph gives acceleration and the area under it gives distance.',
        keyPoints: [
          'Distance is the total path length; displacement is the straight-line change in position.',
          'Speed has magnitude only, velocity has both magnitude and direction.',
          'Acceleration = change in velocity ÷ time.',
          'Slope of a velocity–time graph = acceleration; area under it = distance.',
        ],
        definitions: [
          { term: 'Speed', meaning: 'Distance covered per unit time (scalar).' },
          { term: 'Velocity', meaning: 'Displacement per unit time (vector).' },
          { term: 'Acceleration', meaning: 'Rate of change of velocity.' },
        ],
        formulas: ['v = u + at', 's = ut + ½at²', 'v² = u² + 2as'],
        quickRevision: [
          'Always convert km/h to m/s using 5/18.',
          'Check units before substituting into formulas.',
          'On graphs, read the axes first, then slope/area.',
        ],
        practiceQuestions: [
          'A bus travels 90 km in 1.5 h. Find its average speed in m/s.',
          'Sketch a velocity–time graph for constant acceleration and shade the distance.',
        ],
      },
      null,
      0,
    );
  }

  /**
   * Code Lab text modes (explain / ask / build) must not fall through to the physics teaching answer.
   * The mode is carried in the system prompt (see `codeSystem`), so it is read back from there.
   */
  if (task === 'coding' && !opts.json) {
    const system = String(opts.system ?? '');
    const mode = /line by line for a beginner/i.test(system)
      ? 'explain'
      : /Answer the student's question about their code/i.test(system)
        ? 'ask'
        : /build the small web project/i.test(system)
          ? 'build'
          : 'review';
    const language = /Language:\s*(\S+)/i.exec(prompt)?.[1] ?? 'javascript';
    const question = /Student question:\s*([^\n]+)/i.exec(prompt)?.[1]?.trim();
    const output = /Last program output:\n([\s\S]*?)(?:\nCode:|$)/i.exec(prompt)?.[1]?.trim();
    const codeMatch = /```[a-z]*\n([\s\S]*?)```/i.exec(prompt);
    return demoCodingAnswer({
      mode,
      language,
      question,
      code: codeMatch?.[1] ?? '',
      output,
      studentLanguage: studentLanguage(opts),
    });
  }

  if (opts.json && task === 'coding') {
    return JSON.stringify(
      {
        summary: 'Sample code review. Connect an AI key in AI Settings for a real review of your code.',
        issues: [
          { severity: 'info', title: 'No automated review yet', detail: 'The sample engine does not analyse code, but your program still runs in the Output panel.' },
        ],
        improvements: ['Add a key to get line-by-line feedback, complexity notes and bug hunting.'],
        reviewComments: ['Add a key to get line-by-line feedback, complexity notes and bug hunting.'],
        rating: 0,
      },
      null,
      0,
    );
  }

  return demoTeachingAnswer(prompt, studentLanguage(opts));
}

/** Yields the sample answer in small chunks so the UI streams like a real model. */
export async function* streamDemo(opts: RunOptions): AsyncGenerator<string, void, unknown> {
  const text = buildDemoText(opts);
  const chunks = text.match(/[\s\S]{1,18}/g) ?? [text];
  const sink = (opts as { demoDelayMs?: number }).demoDelayMs ?? 12;
  for (const chunk of chunks) {
    if (opts.signal?.aborted) return;
    yield chunk;
    if (sink > 0) await new Promise((resolve) => setTimeout(resolve, sink));
  }
}
