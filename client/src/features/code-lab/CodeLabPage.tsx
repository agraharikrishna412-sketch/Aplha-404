/**
 * Code Lab (spec §20).
 *
 * Students write, run and review code. Layout is a real split view on desktop and a tabbed
 * stack on mobile — never a shrunken IDE. Web projects get a sandboxed live preview.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import {
  Bug,
  Code2,
  Eye,
  GraduationCap,
  Hammer,
  Lightbulb,
  MessageSquare,
  Play,
  RotateCcw,
  Save,
  Sparkles,
  Square,
  Terminal,
  Trash2,
} from 'lucide-react';
import { PageBody, PageHeader } from '../../components/AppShell';
import {
  Badge,
  Button,
  Card,
  CardHeader,
  EmptyState,
  ErrorState,
  Field,
  SampleNotice,
  Segmented,
  Spinner,
  TextInput,
} from '../../components/ui';
import { Markdown } from '../../components/Markdown';
import { api, ApiError } from '../../lib/api';
import { timeAgo } from '../../lib/format';
import { useSettings } from '../../hooks/useSettings';
import { useToast } from '../../hooks/useToast';
import type { CodeReview, CodeSession, RunResult } from '../../types';
import { VroqnFilterSelect } from '../../components/vroqn';

type LanguageId = 'javascript' | 'python' | 'html';
type AssistMode = 'review' | 'explain' | 'bugs' | 'improve' | 'ask' | 'build';

const ASSIST_MODES: { value: AssistMode; label: string; icon: React.ReactNode }[] = [
  { value: 'review', label: 'Review', icon: <Sparkles size={13} /> },
  { value: 'explain', label: 'Explain', icon: <GraduationCap size={13} /> },
  { value: 'bugs', label: 'Find bugs', icon: <Bug size={13} /> },
  { value: 'improve', label: 'Improve', icon: <Lightbulb size={13} /> },
  { value: 'build', label: 'Build with me', icon: <Hammer size={13} /> },
];

export function CodeLabPage() {
  const { push } = useToast();
  const { hasConnectedKey, runtime } = useSettings();
  const navigate = useNavigate();

  const [language, setLanguage] = useState<LanguageId>('javascript');
  const [code, setCode] = useState('');
  const [starters, setStarters] = useState<Record<string, string>>({});
  const [running, setRunning] = useState(false);
  const [result, setResult] = useState<RunResult | null>(null);
  const [runError, setRunError] = useState<string | null>(null);

  const [assistMode, setAssistMode] = useState<AssistMode>('review');
  const [assistBusy, setAssistBusy] = useState(false);
  const [assistText, setAssistText] = useState<string | null>(null);
  const [assistReview, setAssistReview] = useState<CodeReview | null>(null);
  const [assistNote, setAssistNote] = useState<string | null>(null);
  const [question, setQuestion] = useState('');
  /**
   * The Code Lab conversation.
   *
   * The mentor used to answer one question at a time with no memory, so "iska matlab kya hai?" was
   * answered as if it were the first thing the student had ever said — which is exactly what reads as
   * "it did not understand me". Turns are kept here, sent with each request, and rendered as a thread.
   */
  const [thread, setThread] = useState<{ id: string; role: 'user' | 'mentor'; text: string; mode: AssistMode; at: string }[]>([]);

  const [sessions, setSessions] = useState<CodeSession[]>([]);
  const [currentSessionId, setCurrentSessionId] = useState<string | null>(null);
  const [title, setTitle] = useState('Untitled snippet');
  const [panelsOpen, setPanelsOpen] = useState<'output' | 'assist' | 'preview'>('output');
  const editorRef = useRef<HTMLTextAreaElement | null>(null);

  /* ------------------------------- bootstrap -------------------------------- */

  useEffect(() => {
    api
      .get<{ starters: Record<string, string>; languages: { id: LanguageId; label: string; runnable: boolean; preview: boolean }[] }>('/code/catalog')
      .then((catalog) => {
        setStarters(catalog.starters);
        setCode(catalog.starters[language] ?? '');
      })
      .catch(() => undefined);
    void loadSessions();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const loadSessions = useCallback(async () => {
    try {
      const response = await api.get<{ sessions: CodeSession[] }>('/code/sessions');
      setSessions(response.sessions);
    } catch {
      /* non-critical */
    }
  }, []);

  const switchLanguage = (next: LanguageId) => {
    setLanguage(next);
    setResult(null);
    setAssistReview(null);
    setAssistText(null);
    setCode(starters[next] ?? '');
    setCurrentSessionId(null);
    setTitle(next === 'python' ? 'Python practice' : next === 'html' ? 'Web mini project' : 'JS practice');
    setPanelsOpen(next === 'html' ? 'preview' : 'output');
  };

  /* --------------------------------- runner --------------------------------- */

  const run = async () => {
    if (!code.trim()) {
      push({ tone: 'warning', title: 'Nothing to run', detail: 'Write a line of code first.' });
      return;
    }
    if (language === 'html') {
      setPanelsOpen('preview');
      setResult({
        ok: true,
        mode: 'preview',
        stdout: '',
        stderr: '',
        exitCode: 0,
        durationMs: 0,
        timedOut: false,
        message: 'Web code runs in the preview panel.',
      });
      return;
    }
    setRunning(true);
    setRunError(null);
    setPanelsOpen('output');
    try {
      const response = await api.post<{ result: RunResult }>('/code/run', { language, code });
      setResult(response.result);
      if (response.result.timedOut) {
        push({ tone: 'warning', title: 'Stopped: possible infinite loop', detail: 'Check your loop condition and try again.' });
      }
    } catch (err) {
      setRunError(err instanceof ApiError ? err.message : 'Could not run your code.');
    } finally {
      setRunning(false);
    }
    void loadSessions();
  };

  const assist = async (mode: AssistMode) => {
    if (!code.trim() && !question.trim()) {
      push({ tone: 'warning', title: 'Add some code first', detail: 'Or ask a question in the box below.' });
      return;
    }
    setAssistMode(mode);
    setAssistBusy(true);
    setAssistReview(null);
    setAssistNote(null);
    setPanelsOpen('assist');

    const asked = question.trim();
    // The student's own turn is echoed immediately so the thread reads like a conversation.
    const askedAt = new Date().toISOString();
    const questionTurn =
      mode === 'ask' && asked
        ? { id: `q-${Date.now()}`, role: 'user' as const, text: asked, mode, at: askedAt }
        : null;
    if (questionTurn) {
      setThread((current) => [...current, questionTurn]);
      setQuestion('');
    }

    try {
      const response = await api.post<{
        text?: string;
        review?: CodeReview;
        degraded?: string;
        demo?: boolean;
      }>('/code/assist', {
        mode,
        language,
        code,
        question: asked || undefined,
        output: [result?.stdout, result?.stderr].filter(Boolean).join('\n'),
        // Bounded on the server too; trim here so the payload stays small on a phone.
        history: thread.slice(-6).map((turn) => ({
          role: turn.role === 'user' ? ('user' as const) : ('assistant' as const),
          content: turn.text,
        })),
      });
      setAssistText(response.text ?? null);
      setAssistReview(response.review ?? null);
      if (response.demo) setAssistNote('Sample response (no AI key connected yet).');
      else if (response.degraded) setAssistNote(response.degraded);

      /*
       * Only prose replies join the thread. Structured modes (review / bugs / improve) render in the
       * panel below and would otherwise push a wall of JSON back into the conversation.
       */
      const reply = response.text?.trim();
      if (reply && (mode === 'ask' || mode === 'explain' || mode === 'build')) {
        setThread((current) => [
          ...current,
          { id: `m-${Date.now()}`, role: 'mentor', text: reply, mode, at: new Date().toISOString() },
        ]);
      }
    } catch (err) {
      setAssistNote(err instanceof ApiError ? err.message : 'The AI review could not be completed. Your code is safe.');
    } finally {
      setAssistBusy(false);
    }
  };

  const saveSession = async () => {
    try {
      const response = await api.post<{ session: CodeSession }>('/code/sessions', {
        id: currentSessionId ?? undefined,
        title,
        language,
        code,
        lastOutput: [result?.stdout, result?.stderr].filter(Boolean).join('\n').slice(0, 4000),
      });
      setCurrentSessionId(response.session.id);
      await loadSessions();
      push({ tone: 'success', title: 'Snippet saved', detail: `"${response.session.title}" is in your snippets.` });
    } catch (err) {
      push({ tone: 'error', title: 'Could not save', detail: err instanceof ApiError ? err.message : 'Try again.' });
    }
  };

  const openSession = async (session: CodeSession) => {
    setCurrentSessionId(session.id);
    setTitle(session.title);
    setLanguage(session.language as LanguageId);
    setCode(session.code);
    setResult(null);
    setAssistReview(null);
    setAssistText(null);
  };

  const deleteSession = async (id: string) => {
    await api.del(`/code/sessions/${id}`).catch(() => undefined);
    setSessions((current) => current.filter((session) => session.id !== id));
    if (currentSessionId === id) setCurrentSessionId(null);
  };

  const lineNumbers = useMemo(() => code.split('\n').length, [code]);
  const executionEnabled = runtime ? runtime.codeRunEnabled : true;

  return (
    <>
      <PageHeader
        title="Code Lab"
        description="Write, run and review code. Web projects render in a live preview — no desktop IDE required."
        badge={<Badge tone="muted">{language === 'html' ? 'Web' : language === 'python' ? 'Python 3' : 'Node'}</Badge>}
        actions={
          <>
            <Button variant="secondary" icon={<Save size={15} />} onClick={() => void saveSession()}>
              Save
            </Button>
            <Button variant="primary" icon={<Play size={15} />} loading={running} onClick={() => void run()}>
              Run
            </Button>
          </>
        }
      />

      <PageBody className="space-y-4">
        {!executionEnabled ? (
          <SampleNotice text="Code execution is disabled on this server (CODE_RUN=off). The editor and AI review still work." />
        ) : null}
        {!hasConnectedKey ? (
          <SampleNotice
            text="No verified AI key yet — code review and explanations fall back to sample responses. Your code still runs."
            action={
              <Button size="sm" variant="secondary" onClick={() => navigate('/settings')}>
                AI Settings
              </Button>
            }
          />
        ) : null}

        <div className="grid gap-4 lg:grid-cols-[minmax(0,1.05fr)_minmax(0,1fr)]">
          {/* --------------------------------- editor -------------------------------- */}
          <Card className="flex min-h-[520px] flex-col overflow-hidden">
            <div className="flex flex-wrap items-center gap-2 border-b border-[var(--color-border)] px-3 py-2.5">
              <VroqnFilterSelect
                label="Language"
                value={language}
                onChange={(next) => switchLanguage(next as LanguageId)}
                size="sm"
                className="w-[168px]"
                options={[
                  { value: 'javascript', label: 'JavaScript (Node)' },
                  { value: 'python', label: 'Python 3' },
                  { value: 'html', label: 'HTML + CSS + JS' },
                ]}
              />
              <TextInput
                value={title}
                onChange={(event) => setTitle(event.target.value)}
                aria-label="Snippet title"
                className="h-9 min-w-[120px] flex-1 py-0"
                placeholder="Snippet title"
              />
              <Button
                size="sm"
                variant="ghost"
                icon={<RotateCcw size={13} />}
                onClick={() => setCode(starters[language] ?? '')}
                title="Reset to the starter snippet"
              >
                Reset
              </Button>
            </div>

            <div className="relative flex-1 bg-[#070C11]">
              <div className="pointer-events-none absolute left-0 top-0 select-none px-2 py-3 text-right font-mono text-[12px] leading-[1.6] text-[var(--color-muted-dim)]/60">
                {Array.from({ length: lineNumbers }, (_, index) => (
                  <div key={index}>{index + 1}</div>
                ))}
              </div>
              <textarea
                ref={editorRef}
                value={code}
                onChange={(event) => setCode(event.target.value)}
                spellCheck={false}
                autoCapitalize="off"
                autoCorrect="off"
                aria-label="Code editor"
                className="h-full min-h-[420px] w-full resize-none bg-transparent py-3 pl-10 pr-3 font-mono text-[13px] leading-[1.6] text-[#cbe9f5] outline-none placeholder:text-[var(--color-muted-dim)]"
                placeholder="Write your code here…"
              />
            </div>

            <div className="flex flex-wrap items-center gap-2 border-t border-[var(--color-border)] px-3 py-2.5">
              <Button variant="primary" icon={running ? <Square size={14} /> : <Play size={14} />} loading={running} onClick={() => void run()}>
                {language === 'html' ? 'Refresh preview' : 'Run code'}
              </Button>
              <span className="text-[11.5px] text-[var(--color-muted-dim)]">
                {language === 'python' ? 'Runs with python3' : language === 'html' ? 'Renders in a sandboxed frame' : 'Runs as a Node module'}
              </span>
            </div>
          </Card>

          {/* ------------------------------ output / AI ------------------------------ */}
          <Card className="flex min-h-[520px] flex-col overflow-hidden">
            <div className="border-b border-[var(--color-border)] px-3 py-2.5">
              <Segmented
                value={panelsOpen}
                onChange={setPanelsOpen}
                size="sm"
                label="Panel"
                options={[
                  { value: 'output' as const, label: 'Output' },
                  { value: 'assist' as const, label: 'AI review' },
                  { value: 'preview' as const, label: 'Preview' },
                ]}
              />
            </div>

            <div className="flex-1 overflow-y-auto">
              {panelsOpen === 'output' ? (
                <div className="space-y-3 p-3.5">
                  {runError ? <ErrorState message={runError} onRetry={() => void run()} /> : null}
                  {result ? (
                    <>
                      <div className="flex flex-wrap items-center gap-2 text-[11.5px] text-[var(--color-muted)]">
                        <Badge tone={result.ok ? 'success' : result.mode === 'preview' ? 'primary' : 'error'}>
                          {result.mode === 'preview' ? 'Preview mode' : result.ok ? 'Exit 0' : `Exit ${result.exitCode ?? '—'}`}
                        </Badge>
                        {result.durationMs ? <span>{result.durationMs} ms</span> : null}
                        {result.timedOut ? <Badge tone="warning">Timed out</Badge> : null}
                      </div>
                      <div>
                        <p className="mb-1 text-[11.5px] font-semibold uppercase tracking-wide text-[var(--color-muted-dim)]">stdout</p>
                        <pre className="vroqn-scroll-x max-h-[220px] overflow-y-auto rounded-lg border border-[var(--color-border)] bg-[#070C11] p-3 font-mono text-[12.5px] leading-relaxed text-[#cbe9f5]">
                          {result.stdout || '(no output)'}
                        </pre>
                      </div>
                      {result.stderr ? (
                        <div>
                          <p className="mb-1 text-[11.5px] font-semibold uppercase tracking-wide text-[var(--color-muted-dim)]">stderr</p>
                          <pre className="vroqn-scroll-x max-h-[180px] overflow-y-auto rounded-lg border border-[var(--color-error)]/35 bg-[var(--color-error)]/[0.07] p-3 font-mono text-[12.5px] leading-relaxed text-[#fca5a5]">
                            {result.stderr}
                          </pre>
                        </div>
                      ) : null}
                      {result.message ? <p className="text-[12px] text-[var(--color-muted)]">{result.message}</p> : null}
                      <div className="flex flex-wrap gap-2">
                        <Button size="sm" variant="secondary" icon={<Sparkles size={13} />} onClick={() => void assist('review')}>
                          Review my code
                        </Button>
                        <Button size="sm" variant="secondary" icon={<Bug size={13} />} onClick={() => void assist('bugs')}>
                          Any bugs?
                        </Button>
                      </div>
                    </>
                  ) : (
                    <EmptyState
                      icon={<Terminal size={18} />}
                      title="Press Run to see output"
                      description="Program output, errors and timing appear here. Nothing leaves your device until you press Run."
                    />
                  )}
                </div>
              ) : null}

              {panelsOpen === 'assist' ? (
                <div className="space-y-3 p-3.5">
                  {thread.length ? (
                    <div className="space-y-2.5 border-b border-[var(--color-border)] pb-3">
                      <div className="flex items-center justify-between gap-2">
                        <p className="text-[11.5px] font-semibold uppercase tracking-wide text-[var(--color-muted-dim)]">
                          Conversation with your code mentor
                        </p>
                        <Button size="sm" variant="ghost" icon={<Trash2 size={12} />} onClick={() => setThread([])}>
                          Clear
                        </Button>
                      </div>
                      <ul
                        aria-label="Conversation with your code mentor"
                        className="max-h-[320px] space-y-3 overflow-y-auto pr-1"
                      >
                        {thread.map((turn) => (
                          <li
                            key={turn.id}
                            aria-label={turn.role === 'user' ? 'Your question' : 'Mentor reply'}
                            className={turn.role === 'user' ? 'flex justify-end' : ''}
                          >
                            <div
                              className={[
                                'max-w-[92%] rounded-[12px] border px-3 py-2 text-[13px] leading-relaxed',
                                turn.role === 'user'
                                  ? 'border-[var(--color-primary)]/25 bg-[var(--color-primary)]/[0.08]'
                                  : 'border-[var(--color-border)] bg-[var(--color-surface)]',
                              ].join(' ')}
                            >
                              {turn.role === 'user' ? (
                                <p className="whitespace-pre-wrap">{turn.text}</p>
                              ) : (
                                <Markdown content={turn.text} />
                              )}
                            </div>
                          </li>
                        ))}
                        {assistBusy && (assistMode === 'ask' || assistMode === 'explain' || assistMode === 'build') ? (
                          <li aria-label="Mentor is replying" className="flex items-center gap-2 text-[12.5px] text-[var(--color-muted)]">
                            <Spinner size={13} /> Your mentor is reading the code…
                          </li>
                        ) : null}
                      </ul>
                    </div>
                  ) : null}

                  <div className="flex flex-wrap gap-1.5">
                    {ASSIST_MODES.map((mode) => (
                      <Button
                        key={mode.value}
                        size="sm"
                        variant={assistMode === mode.value ? 'primary' : 'secondary'}
                        icon={mode.icon}
                        onClick={() => void assist(mode.value)}
                        loading={assistBusy && assistMode === mode.value}
                      >
                        {mode.label}
                      </Button>
                    ))}
                  </div>

                  <Field
                    label={thread.length ? 'Keep asking' : 'Ask your code mentor'}
                    htmlFor="code-question"
                    optional
                    hint="Write in English, Hindi or Hinglish — the answer comes back in the language you used."
                  >
                    <div className="flex gap-2">
                      <TextInput
                        id="code-question"
                        value={question}
                        onChange={(event) => setQuestion(event.target.value)}
                        placeholder={thread.length ? 'iska matlab kya hai?' : 'Why does my loop stop early?'}
                        onKeyDown={(event) => {
                          if (event.key === 'Enter' && question.trim()) void assist('ask');
                        }}
                      />
                      <Button variant="secondary" icon={<MessageSquare size={14} />} onClick={() => void assist('ask')} loading={assistBusy && assistMode === 'ask'}>
                        Ask
                      </Button>
                    </div>
                  </Field>

                  {assistNote ? <SampleNotice text={assistNote} /> : null}
                  {assistBusy && !(assistMode === 'ask' || assistMode === 'explain' || assistMode === 'build') ? (
                    <div className="flex items-center gap-2 text-[12.5px] text-[var(--color-muted)]">
                      <Spinner size={13} /> Reading your code…
                    </div>
                  ) : null}

                  {assistReview ? (
                    <div className="space-y-3">
                      {assistReview.summary ? <Markdown content={assistReview.summary} /> : null}
                      {assistReview.rating ? (
                        <Badge tone={assistReview.rating >= 4 ? 'success' : assistReview.rating >= 3 ? 'warning' : 'error'}>
                          {assistReview.rating}/5 readability
                        </Badge>
                      ) : null}
                      {assistReview.issues?.length ? (
                        <ul className="space-y-2">
                          {assistReview.issues.map((issue, index) => (
                            <li
                              key={index}
                              className={[
                                'rounded-lg border px-3 py-2',
                                issue.severity === 'error'
                                  ? 'border-[var(--color-error)]/40 bg-[var(--color-error)]/[0.06]'
                                  : issue.severity === 'warning'
                                    ? 'border-[var(--color-warning)]/40 bg-[var(--color-warning)]/[0.06]'
                                    : 'border-[var(--color-border)] bg-[var(--color-surface)]',
                              ].join(' ')}
                            >
                              <p className="text-[12.5px] font-semibold">
                                {issue.severity === 'error' ? 'Error · ' : issue.severity === 'warning' ? 'Warning · ' : 'Note · '}
                                {issue.title}
                              </p>
                              {issue.detail ? <p className="mt-0.5 text-[12.5px] leading-relaxed text-[var(--color-muted)]">{issue.detail}</p> : null}
                              {issue.fix ? (
                                <pre className="vroqn-scroll-x mt-1.5 rounded-lg border border-[var(--color-border)] bg-[#070C11] p-2.5 font-mono text-[12px] text-[#a5f3fc]">
                                  {issue.fix}
                                </pre>
                              ) : null}
                            </li>
                          ))}
                        </ul>
                      ) : null}
                      {assistReview.improvements?.length ? (
                        <div>
                          <p className="mb-1 text-[11.5px] font-semibold uppercase tracking-wide text-[var(--color-muted-dim)]">Improvements</p>
                          <ul className="space-y-1 text-[12.5px] text-[var(--color-muted)]">
                            {assistReview.improvements.map((item, index) => (
                              <li key={index}>• {item}</li>
                            ))}
                          </ul>
                        </div>
                      ) : null}
                      {assistReview.reviewComments?.length ? (
                        <ul className="space-y-1.5">
                          {assistReview.reviewComments.map((comment, index) => (
                            <li key={index} className="rounded-lg border border-[var(--color-border)] bg-[var(--color-surface)] px-3 py-2 text-[12.5px] text-[var(--color-muted)]">
                              {comment}
                            </li>
                          ))}
                        </ul>
                      ) : null}
                    </div>
                  ) : null}

                  {assistText ? <Markdown content={assistText} /> : null}

                  {!assistReview && !assistText && !assistBusy && !thread.length ? (
                    <EmptyState
                      icon={<Code2 size={18} />}
                      title="Get feedback on your code"
                      description="Review for correctness and clarity, explain it line by line, hunt for bugs, or simply ask a question and keep the conversation going. Your code is sent only when you press a button or send a question."
                    />
                  ) : null}
                </div>
              ) : null}

              {panelsOpen === 'preview' ? (
                <div className="space-y-2.5 p-3.5">
                  {language === 'html' ? (
                    <>
                      <div className="flex items-center gap-2 text-[11.5px] text-[var(--color-muted)]">
                        <Eye size={13} /> Sandboxed preview — scripts cannot reach this app or its data.
                      </div>
                      <iframe
                        title="Web project preview"
                        srcDoc={code}
                        sandbox="allow-scripts allow-modals allow-forms"
                        className="h-[400px] w-full rounded-lg border border-[var(--color-border)] bg-white"
                      />
                    </>
                  ) : (
                    <EmptyState
                      icon={<Eye size={18} />}
                      title="Preview is for web projects"
                      description="Switch the language to HTML + CSS + JS to build a page and see it render live. JavaScript and Python programs report through the Output panel."
                    />
                  )}
                </div>
              ) : null}
            </div>
          </Card>
        </div>

        {/* -------------------------------- snippets -------------------------------- */}
        <Card>
          <CardHeader
            title="My snippets"
            subtitle="Saved in your workspace"
            icon={<Save size={15} />}
            right={
              <Button size="sm" variant="ghost" icon={<Save size={13} />} onClick={() => void saveSession()}>
                Save current
              </Button>
            }
          />
          {sessions.length ? (
            <ul className="divide-y divide-[var(--color-border)]">
              {sessions.map((session) => (
                <li key={session.id} className="flex items-center gap-3 px-4 py-2.5">
                  <button type="button" onClick={() => void openSession(session)} className="vroqn-tap min-w-0 flex-1 text-left">
                    <span className="block truncate text-[13px] font-medium">{session.title}</span>
                    <span className="block text-[11.5px] text-[var(--color-muted)]">
                      {session.language} · updated {timeAgo(session.updatedAt)}
                    </span>
                  </button>
                  <Button size="icon" variant="ghost" aria-label={`Delete ${session.title}`} onClick={() => void deleteSession(session.id)}>
                    <Trash2 size={14} />
                  </Button>
                </li>
              ))}
            </ul>
          ) : (
            <p className="px-4 py-5 text-center text-[12.5px] text-[var(--color-muted)]">
              Nothing saved yet. Press Save to keep a snippet and come back to it later.
            </p>
          )}
        </Card>
      </PageBody>
    </>
  );
}

export default CodeLabPage;
