/** Sign in / create account. One screen, mobile-first, with a real error state. */
import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { ArrowRight, BookOpen, Brain, KeyRound, ShieldCheck, Sparkles } from 'lucide-react';
import { LogoLockup, LogoMark } from '../../components/Logo';
import { Badge, Button, Card, ErrorState, Field, TextInput } from '../../components/ui';
import { VroqnFilterSelect } from '../../components/vroqn';
import { useAuth } from '../../hooks/useAuth';
import { useToast } from '../../hooks/useToast';
import { ApiError } from '../../lib/api';

const HIGHLIGHTS = [
  { icon: <Brain size={15} />, title: 'Understand, don’t memorise', detail: 'Structured explanations with worked examples and a quick check.' },
  { icon: <BookOpen size={15} />, title: 'Practice that adapts', detail: 'Generated question sets, a mock exam, and honest analysis of what to fix.' },
  { icon: <KeyRound size={15} />, title: 'Bring your own AI key', detail: 'Gemini, Groq or OpenRouter — with automatic key failover.' },
  { icon: <ShieldCheck size={15} />, title: 'Private by design', detail: 'Your keys are encrypted. Learning activity is visible only to you.' },
];

export function AuthPage({ mode: initialMode = 'login' }: { mode?: 'login' | 'signup' }) {
  const [mode, setMode] = useState<'login' | 'signup'>(initialMode);
  const [form, setForm] = useState({ name: '', email: '', password: '', classLevel: 'Class 10', board: 'CBSE' });
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const { login, signup } = useAuth();
  const { push } = useToast();
  const navigate = useNavigate();

  const update = (key: keyof typeof form) => (event: React.ChangeEvent<HTMLInputElement | HTMLSelectElement>) =>
    setForm((current) => ({ ...current, [key]: event.target.value }));

  /** Same write path as `update`, for controls that hand back a plain value instead of an event. */
  const setField = (key: keyof typeof form) => (value: string) => setForm((current) => ({ ...current, [key]: value }));

  const submit = async (event: React.FormEvent) => {
    event.preventDefault();
    setSubmitting(true);
    setError(null);
    try {
      if (mode === 'signup') {
        await signup({
          name: form.name,
          email: form.email,
          password: form.password,
          classLevel: form.classLevel,
          board: form.board,
        });
        push({ tone: 'success', title: 'Welcome to Vroqn Nexus', detail: 'Add an AI key any time from AI Settings.' });
      } else {
        await login({ email: form.email, password: form.password });
      }
      navigate('/', { replace: true });
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Something went wrong. Please try again.');
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div className="grid min-h-[100dvh] lg:grid-cols-[1.05fr_1fr]">
      {/* ------------------------------ brand panel ----------------------------- */}
      <div className="vroqn-grid-bg relative hidden flex-col justify-between border-r border-[var(--color-border)] p-10 lg:flex">
        <LogoLockup size={34} subtitle="AI learning workspace" />
        <div className="max-w-lg">
          <Badge tone="primary" icon={<Sparkles size={12} />}>
            Learn → Practise → Build → Test → Analyse
          </Badge>
          <h1 className="mt-4 text-[34px] font-semibold leading-tight tracking-tight">
            One workspace for everything you are <span className="text-[var(--color-primary)]">actually</span> trying to learn.
          </h1>
          <p className="mt-3 text-[14px] leading-relaxed text-[var(--color-muted)]">
            Explain a concept, generate practice, sit a mock exam, analyse your mistakes, clean your notes, run code — and
            see it all come together in your Learning Activity.
          </p>
          <ul className="mt-6 space-y-3">
            {HIGHLIGHTS.map((item) => (
              <li key={item.title} className="flex gap-3">
                <span className="mt-0.5 grid h-7 w-7 shrink-0 place-items-center rounded-lg border border-[var(--color-border)] bg-[var(--color-card)] text-[var(--color-primary)]">
                  {item.icon}
                </span>
                <span>
                  <span className="block text-[13.5px] font-medium">{item.title}</span>
                  <span className="block text-[12.5px] text-[var(--color-muted)]">{item.detail}</span>
                </span>
              </li>
            ))}
          </ul>
        </div>
        <p className="text-[11.5px] text-[var(--color-muted-dim)]">
          No AI key required to explore — Vroqn Nexus runs on a built-in sample engine until you connect one.
        </p>
      </div>

      {/* ------------------------------- auth form ------------------------------ */}
      <div className="flex flex-col justify-center px-4 py-8 sm:px-8 lg:px-12">
        <div className="mx-auto w-full max-w-md">
          <div className="mb-6 flex items-center gap-3 lg:hidden">
            <LogoMark size={38} />
            <div>
              <p className="text-[15px] font-semibold">
                Vroqn <span className="text-[var(--color-primary)]">Nexus</span>
              </p>
              <p className="text-[11.5px] text-[var(--color-muted)]">AI learning workspace</p>
            </div>
          </div>

          <Card className="p-5">
            <div className="mb-4 flex rounded-[10px] border border-[var(--color-border)] bg-[var(--color-surface)] p-1">
              {(['login', 'signup'] as const).map((value) => (
                <button
                  key={value}
                  type="button"
                  onClick={() => {
                    setMode(value);
                    setError(null);
                  }}
                  aria-pressed={mode === value}
                  className={[
                    'flex-1 rounded-lg py-2 text-[13px] transition-colors',
                    mode === value
                      ? 'bg-[var(--color-primary)]/15 font-semibold text-[var(--color-primary)] ring-1 ring-inset ring-[var(--color-primary)]/40'
                      : 'text-[var(--color-muted)] hover:text-[var(--color-text)]',
                  ].join(' ')}
                >
                  {value === 'login' ? 'Sign in' : 'Create account'}
                </button>
              ))}
            </div>

            <h1 className="text-[18px] font-semibold">
              {mode === 'login' ? 'Welcome back' : 'Start learning in a minute'}
            </h1>
            <p className="mt-0.5 text-[13px] text-[var(--color-muted)]">
              {mode === 'login'
                ? 'Sign in to continue your learning journey.'
                : 'We only need your name, email and class — nothing else.'}
            </p>

            {error ? <div className="mt-4"><ErrorState title="Could not continue" message={error} compact /></div> : null}

            <form onSubmit={submit} className="mt-4 space-y-3.5">
              {mode === 'signup' ? (
                <Field label="Your name" htmlFor="name">
                  <TextInput
                    id="name"
                    name="name"
                    autoComplete="name"
                    placeholder="Aarav Sharma"
                    value={form.name}
                    onChange={update('name')}
                    required
                    minLength={2}
                  />
                </Field>
              ) : null}

              <Field label="Email" htmlFor="email">
                <TextInput
                  id="email"
                  name="email"
                  type="email"
                  inputMode="email"
                  autoComplete="email"
                  placeholder="you@example.com"
                  value={form.email}
                  onChange={update('email')}
                  required
                />
              </Field>

              <Field
                label="Password"
                htmlFor="password"
                hint={mode === 'signup' ? 'At least 8 characters, with a letter and a number.' : undefined}
              >
                <TextInput
                  id="password"
                  name="password"
                  type="password"
                  autoComplete={mode === 'signup' ? 'new-password' : 'current-password'}
                  placeholder="••••••••"
                  value={form.password}
                  onChange={update('password')}
                  required
                  minLength={mode === 'signup' ? 8 : 1}
                />
              </Field>

              {/*
                * Class and Board are one decision, so they sit side by side — but only once there is
                * room. On a 360px phone a half-width select clips "State board", so they stack.
                */}
              {mode === 'signup' ? (
                <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
                  <Field label="Class">
                    <VroqnFilterSelect
                      label="Class"
                      value={form.classLevel}
                      onChange={setField('classLevel')}
                      placeholder="Choose your class"
                      options={['Class 6', 'Class 7', 'Class 8', 'Class 9', 'Class 10', 'Class 11', 'Class 12', 'College'].map((option) => ({
                        value: option,
                        label: option,
                      }))}
                    />
                  </Field>
                  <Field label="Board">
                    <VroqnFilterSelect
                      label="Board"
                      value={form.board}
                      onChange={setField('board')}
                      placeholder="Choose your board"
                      options={['CBSE', 'ICSE', 'State board', 'IB', 'Other'].map((option) => ({ value: option, label: option }))}
                    />
                  </Field>
                </div>
              ) : null}

              <Button type="submit" variant="primary" size="lg" block loading={submitting} iconRight={<ArrowRight size={16} />}>
                {mode === 'login' ? 'Sign in' : 'Create my workspace'}
              </Button>
            </form>

            <p className="mt-4 text-center text-[12px] leading-relaxed text-[var(--color-muted-dim)]">
              By continuing you agree that your learning activity is stored to power your own progress view — nothing else,
              and you can erase it any time from AI Settings.
            </p>
          </Card>
        </div>
      </div>
    </div>
  );
}
