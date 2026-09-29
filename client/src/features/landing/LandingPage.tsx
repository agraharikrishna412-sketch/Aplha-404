/**
 * Public landing page.
 *
 * The first screen a visitor sees before signing in. It explains the loop the product is built
 * around (Learn → Practice → Test → Compete → Benchmark → Diagnose → Improve) and what each part of
 * the workspace does, then offers the two actions that matter: create an account or sign in.
 *
 * Two honesty rules shape the copy:
 *  - No inflated claims. Vroqn Nexus is a learning workspace; it does not promise ranks or marks,
 *    and nothing here says otherwise.
 *  - Arena is described as what it is: an independent competition created *inside Vroqn Nexus*,
 *    never an official examination of any board or examining body.
 *
 * Rendering notes: static markup only (no data fetching), so the page works with no session, no API
 * call and no JavaScript-side loading state. It reuses the app's design tokens and UI kit so it
 * stays consistent with the signed-in workspace.
 */
import { Link } from 'react-router-dom';
import {
  ArrowRight,
  BarChart3,
  BookOpen,
  Brain,
  CheckCircle2,
  Code2,
  GraduationCap,
  ListChecks,
  Lock,
  ShieldCheck,
  Sparkles,
  Target,
  Trophy,
  Users,
} from 'lucide-react';
import { LogoLockup, LogoMark } from '../../components/Logo';
import { Badge } from '../../components/ui';
import { CommunitiesSection } from './CommunitiesSection';
import { KnowledgeCore } from './KnowledgeCore';
import { Reveal } from '../../hooks/useReveal';

/* ------------------------------------------------------------------ content */

const LOOP = [
  { label: 'Learn', detail: 'Ask the AI Tutor' },
  { label: 'Practice', detail: 'Drill one topic' },
  { label: 'Test', detail: 'Sit a mock exam' },
  { label: 'Compete', detail: 'Arena papers' },
  { label: 'Benchmark', detail: 'Percentile & rank' },
  { label: 'Diagnose', detail: 'See weak areas' },
  { label: 'Improve', detail: 'Practise them' },
];

const FEATURES = [
  {
    icon: <Brain size={18} />,
    title: 'AI Tutor',
    detail:
      'Ask a doubt in your own words. Answers come back structured — concept, worked example, and a quick check you can attempt.',
  },
  {
    icon: <ListChecks size={18} />,
    title: 'Practice',
    detail:
      'Choose a subject, chapter and difficulty. Answer one question at a time and read the explanation whether you were right or wrong.',
  },
  {
    icon: <GraduationCap size={18} />,
    title: 'Mock Exam',
    detail:
      'Build your own paper — subject, topics, difficulty, question type, number of questions and duration — then sit it under a timer.',
  },
  {
    icon: <BookOpen size={18} />,
    title: 'Notes',
    detail:
      'Write and organise notes, or paste a messy chapter and get it restructured into summary, key points, definitions and formulas.',
  },
  {
    icon: <Code2 size={18} />,
    title: 'Code Lab',
    detail:
      'Run JavaScript, Python or HTML in a sandboxed runner, then ask the AI to review, explain or debug what you wrote.',
  },
  {
    icon: <Users size={18} />,
    title: 'Vroqn Communities',
    detail:
      'Study with a group: ask doubts, share notes, run study plans and teams, and compete in papers your community hosts.',
    note: 'Moderated groups with reporting and blocking — no unrestricted private messaging.',
  },
  {
    icon: <Trophy size={18} />,
    title: 'Vroqn Arena',
    detail:
      'Independent competitive mocks created inside Vroqn Nexus. Register, sit the paper under a server-controlled clock, and see where you stand.',
    note: 'Arena is a Vroqn-created competition — not an official JEE, NEET or board examination.',
  },
] as const;

const DIAGNOSIS = [
  { label: 'Subject-wise accuracy', detail: 'Which subjects are carrying you and which are lagging' },
  { label: 'Topic weaknesses', detail: 'The exact chapters costing marks, ranked by accuracy' },
  { label: 'Difficulty pattern', detail: 'Whether easy marks or hard questions are the problem' },
  { label: 'Question-type pattern', detail: 'MCQ vs numerical vs conceptual performance' },
  { label: 'Time usage', detail: 'Average time per question and where you slowed down' },
] as const;

/**
 * The seven questions a brand-new student actually asks, answered in order.
 *
 * The rest of the page explains what the product *is*; a first-time visitor also needs to know what
 * to *do first*. Each answer names the exact screen, so the path from landing page to first useful
 * action is a few clicks with no guessing and no documentation.
 */
const START_HERE = [
  {
    question: 'What is Vroqn?',
    answer:
      'One study workspace for school and competitive-exam prep. Tutor, practice, mock exams, notes and code, in one place.',
  },
  {
    question: 'What can I do here?',
    answer:
      'Ask doubts, drill topics, sit timed papers, write and run code, keep notes, and compete in Arena papers.',
  },
  {
    question: 'Where do I start?',
    answer:
      'Create an account, then open the AI Tutor and ask one real doubt about something you are studying right now.',
  },
  {
    question: 'How do I practise?',
    answer:
      'Go to Practice, pick subject, chapter and difficulty, then answer one question at a time — every one comes with an explanation.',
  },
  {
    question: 'What is Arena?',
    answer:
      'An independent timed competition created inside Vroqn Nexus. Sit the same paper as other students and see your percentile.',
  },
  {
    question: 'How do I see my performance?',
    answer:
      'Learning Activity shows your streak, subject-wise accuracy and every attempt. Each mock exam ends with a written analysis.',
  },
  {
    question: 'What should I practise next?',
    answer:
      'Your weak areas are ranked from your own attempts. Open Practice My Weak Areas and Practice is already set up for you.',
  },
] as const;

const TRUST = [
  { icon: <ShieldCheck size={15} />, title: 'Your keys stay yours', detail: 'AI keys are encrypted server-side and never sent to the browser.' },
  { icon: <Target size={15} />, title: 'Real data only', detail: 'Diagnosis is computed from your actual attempts — no invented weaknesses.' },
  { icon: <Lock size={15} />, title: 'Private messages', detail: 'Encrypted on your device before they reach the server — the server stores ciphertext.' },
] as const;

/* -------------------------------------------------------------------- page */

export function LandingPage() {
  return (
    <div className="min-h-[100dvh] bg-[var(--color-bg)] text-[var(--color-text)]">
      <Header />
      <main>
        <Hero />
        <Loop />
        <ProblemSolution />
        <Features />
        <CommunitiesSection />
        <StartHere />
        <Diagnosis />
        <Trust />
        <FinalCta />
      </main>
      <Footer />
    </div>
  );
}

/* ------------------------------------------------------------------ header */

function Header() {
  return (
    <header className="vroqn-glass sticky top-0 z-30 border-b border-[var(--color-border)]">
      <div className="mx-auto flex h-14 w-full max-w-6xl items-center justify-between gap-3 px-4">
        <Link to="/" className="shrink-0 rounded-lg" aria-label="Vroqn Nexus home">
          <LogoLockup size={28} />
        </Link>
        <nav className="flex items-center gap-2">
          <a
            href="#start"
            className="hidden rounded-lg px-3 py-2 text-[13px] text-[var(--color-muted)] transition-colors hover:text-[var(--color-text)] md:block"
          >
            Start here
          </a>
          <a
            href="#features"
            className="hidden rounded-lg px-3 py-2 text-[13px] text-[var(--color-muted)] transition-colors hover:text-[var(--color-text)] sm:block"
          >
            Features
          </a>
          <a
            href="#communities"
            className="hidden rounded-lg px-3 py-2 text-[13px] text-[var(--color-muted)] transition-colors hover:text-[var(--color-text)] md:block"
          >
            Communities
          </a>
          <a
            href="#arena"
            className="hidden rounded-lg px-3 py-2 text-[13px] text-[var(--color-muted)] transition-colors hover:text-[var(--color-text)] sm:block"
          >
            Arena
          </a>
          <Link
            to="/login"
            className="rounded-[10px] px-3 py-2 text-[13px] font-medium text-[var(--color-muted)] transition-colors hover:text-[var(--color-text)]"
          >
            Log in
          </Link>
          <Link
            to="/signup"
            className="inline-flex h-9 items-center gap-1.5 rounded-[10px] bg-[var(--color-primary)] px-3.5 text-[13px] font-semibold text-[#04121a] transition-transform active:scale-[0.98]"
          >
            Get started
            <ArrowRight size={14} />
          </Link>
        </nav>
      </div>
    </header>
  );
}

/* -------------------------------------------------------------------- hero */

function Hero() {
  return (
    <section className="relative overflow-hidden px-4 pb-14 pt-8 sm:pb-20 sm:pt-14 lg:pb-24 lg:pt-16">
      {/*
        A single soft wash behind the hero. The previous version used a 34rem element blurred by
        120px, which is a large layer for a mid-range phone to rasterise; this is smaller and lighter.
        Decoration only — it never wraps content and never receives a pointer event.
      */}
      <div
        aria-hidden="true"
        className="pointer-events-none absolute left-1/2 top-[-12rem] h-[22rem] w-[22rem] -translate-x-1/2 rounded-full bg-[var(--color-primary)]/[0.09] blur-[100px] sm:h-[30rem] sm:w-[30rem]"
      />

      <div className="relative mx-auto grid w-full max-w-6xl items-center gap-8 lg:grid-cols-[1.05fr_0.95fr] lg:gap-6">
        {/*
          Lead with the diagram on phones — it is the fastest way to say "AI, learning, progress"
          without a sentence — then hand over to the headline. On desktop the two sit side by side and
          the text leads, which is the stronger reading order at that width.
        */}
        <div className="order-1 mx-auto w-full max-w-[230px] sm:max-w-[320px] lg:order-2 lg:max-w-[440px] lg:justify-self-end">
          <KnowledgeCore className="aspect-square w-full" />
        </div>

        <div className="order-2 text-center lg:order-1 lg:text-left">
          <Badge tone="primary" icon={<Sparkles size={12} />}>
            AI learning workspace for students
          </Badge>
          <h1 className="vroqn-text-balance mt-5 text-[31px] font-semibold leading-[1.12] tracking-tight sm:text-[42px] sm:leading-[1.08] lg:text-[50px]">
            Study smarter with one workspace that
            <span className="text-[var(--color-primary)]"> learns how you learn</span>
          </h1>
          <p className="vroqn-text-balance mx-auto mt-4 max-w-2xl text-[14.5px] leading-relaxed text-[var(--color-muted)] sm:text-base lg:mx-0">
            Vroqn Nexus brings your tutor, practice, mock exams, notes and coding lab into a single
            place — then measures exactly where you stand and hands you the next thing to work on.
          </p>

          <div className="mt-7 flex flex-col items-center justify-center gap-2.5 sm:flex-row lg:justify-start">
            <Link
              to="/signup"
              className="inline-flex h-12 w-full items-center justify-center gap-2 rounded-xl bg-[var(--color-primary)] px-6 text-[15px] font-semibold text-[#04121a] shadow-[0_10px_30px_-14px_rgba(0,229,255,0.75)] transition-all duration-150 hover:bg-[#4defff] active:scale-[0.985] sm:w-auto"
            >
              Create your free account
              <ArrowRight size={16} />
            </Link>
            <Link
              to="/login"
              className="inline-flex h-12 w-full items-center justify-center rounded-xl border border-[var(--color-border-strong)] px-6 text-[15px] font-medium text-[var(--color-text)] transition-colors hover:border-[var(--color-primary)]/50 hover:bg-white/[0.03] sm:w-auto"
            >
              I already have an account
            </Link>
          </div>

          {/* Three concrete facts, not adjectives — answers "where do I start?" without a wall of text. */}
          <ul className="mt-6 flex flex-wrap items-center justify-center gap-x-5 gap-y-2 text-[12.5px] text-[var(--color-muted-dim)] lg:justify-start">
            <li className="flex items-center gap-1.5">
              <CheckCircle2 size={13} className="text-[var(--color-primary)]" aria-hidden="true" />
              Free to start
            </li>
            <li className="flex items-center gap-1.5">
              <CheckCircle2 size={13} className="text-[var(--color-primary)]" aria-hidden="true" />
              Works on your phone
            </li>
            <li className="flex items-center gap-1.5">
              <CheckCircle2 size={13} className="text-[var(--color-primary)]" aria-hidden="true" />
              Use your own AI key, or explore with sample content
            </li>
          </ul>
        </div>
      </div>
    </section>
  );
}

/* -------------------------------------------------------------------- loop */

function Loop() {
  return (
    <section className="px-4 py-10 sm:py-14">
      <div className="mx-auto w-full max-w-6xl">
        <Reveal>
          <p className="text-center text-[12px] font-medium uppercase tracking-[0.18em] text-[var(--color-muted-dim)]">
            One loop, not eight apps
          </p>
          <p className="mx-auto mt-2 max-w-xl text-center text-[14px] leading-relaxed text-[var(--color-muted)]">
            Every part of Vroqn feeds the next. This is the order to use them in if you are just starting.
          </p>
        </Reveal>
        <ol className="mt-6 grid grid-cols-2 gap-2.5 sm:grid-cols-4 lg:grid-cols-7">
          {LOOP.map((step, index) => (
            <Reveal
              as="li"
              key={step.label}
              className="vroqn-metal relative rounded-[var(--radius-card)] border border-[var(--color-border)] bg-[var(--color-card)] p-3 shadow-[var(--shadow-card)]"
            >
              {/* A connector hint between steps: the loop is a sequence, and the layout should say so. */}
              <span className="text-[11px] font-mono text-[var(--color-primary)] tabular-nums">
                {String(index + 1).padStart(2, '0')}
              </span>
              <p className="mt-1 text-[13.5px] font-semibold">{step.label}</p>
              <p className="mt-0.5 text-[11.5px] leading-snug text-[var(--color-muted)]">{step.detail}</p>
            </Reveal>
          ))}
        </ol>
      </div>
    </section>
  );
}

/* ------------------------------------------------------- problem / solution */

function ProblemSolution() {
  return (
    <section className="px-4 py-10 sm:py-14">
      <div className="mx-auto grid w-full max-w-6xl gap-4 lg:grid-cols-2">
        <Reveal className="rounded-[var(--radius-card)] border border-[var(--color-border)] bg-[var(--color-card)] p-5 shadow-[var(--shadow-card)] sm:p-6">
          <h2 className="text-[17px] font-semibold sm:text-[19px]">The problem</h2>
          <ul className="mt-4 space-y-3">
            {[
              'Study material is scattered across apps, PDFs and videos, with no thread connecting them.',
              'You can read a chapter and still not know whether you actually understood it.',
              'Marks tell you that something went wrong, not which chapter or which habit caused it.',
              'Doubt-clearing tools answer questions one at a time, but nothing remembers the bigger picture.',
            ].map((item) => (
              <li key={item} className="flex gap-2.5 text-[13.5px] leading-relaxed text-[var(--color-muted)]">
                <span className="mt-[7px] h-1.5 w-1.5 shrink-0 rounded-full bg-[var(--color-error)]" />
                {item}
              </li>
            ))}
          </ul>
        </Reveal>
        <Reveal
          className="vroqn-edge rounded-[var(--radius-card)] border border-[var(--color-primary)]/25 bg-[var(--color-card)] p-5 shadow-[var(--shadow-card)] sm:p-6"
        >
          <h2 className="text-[17px] font-semibold sm:text-[19px]">What Vroqn Nexus does about it</h2>
          <ul className="mt-4 space-y-3">
            {[
              'Keeps learning, practice and testing in one workspace, so nothing gets lost between them.',
              'Explains every answer, right or wrong, so understanding is the default outcome.',
              'Reads your own attempt data and reports the specific topics and patterns behind lost marks.',
              'Turns that diagnosis into targeted practice on exactly those topics.',
            ].map((item) => (
              <li key={item} className="flex gap-2.5 text-[13.5px] leading-relaxed text-[var(--color-muted)]">
                <CheckCircle2 size={15} className="mt-[2px] shrink-0 text-[var(--color-primary)]" />
                {item}
              </li>
            ))}
          </ul>
        </Reveal>
      </div>
    </section>
  );
}

/* ---------------------------------------------------------------- features */

function Features() {
  return (
    <section id="features" className="scroll-mt-16 px-4 py-10 sm:py-14">
      <div className="mx-auto w-full max-w-6xl">
        <Reveal className="max-w-2xl">
          <h2 className="text-[22px] font-semibold tracking-tight sm:text-[28px]">Everything in one place</h2>
          <p className="mt-2 text-[14px] leading-relaxed text-[var(--color-muted)]">
            Seven connected tools — close the gap between reading something and being able to do it.
            Start with whichever one matches what you are stuck on today.
          </p>
        </Reveal>
        <div className="mt-6 grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
          {FEATURES.map((feature) => (
            <Reveal
              key={feature.title}
              id={feature.title === 'Vroqn Arena' ? 'arena' : undefined}
              className="vroqn-lift group scroll-mt-16 rounded-[var(--radius-card)] border border-[var(--color-border)] bg-[var(--color-card)] p-4 shadow-[var(--shadow-card)] sm:p-5"
            >
              <span className="inline-flex h-9 w-9 items-center justify-center rounded-[10px] border border-[var(--color-primary)]/25 bg-[var(--color-primary)]/10 text-[var(--color-primary)] transition-transform duration-200 ease-[var(--ease-out)] group-hover:scale-105">
                {feature.icon}
              </span>
              <h3 className="mt-3 text-[15px] font-semibold">{feature.title}</h3>
              <p className="mt-1.5 text-[13px] leading-relaxed text-[var(--color-muted)]">{feature.detail}</p>
              {'note' in feature && feature.note ? (
                <p className="mt-2.5 rounded-lg border border-[var(--color-warning)]/25 bg-[var(--color-warning)]/[0.07] px-2.5 py-2 text-[11.5px] leading-snug text-[var(--color-warning)]">
                  {feature.note}
                </p>
              ) : null}
            </Reveal>
          ))}
        </div>
      </div>
    </section>
  );
}

/* --------------------------------------------------------------- diagnosis */

function Diagnosis() {
  return (
    <Reveal className="block px-4 py-10 sm:py-14">
      <div className="vroqn-edge mx-auto w-full max-w-6xl overflow-hidden rounded-[var(--radius-card)] border border-[var(--color-border)] bg-[var(--color-card)] shadow-[var(--shadow-card)]">
        <div className="grid gap-0 lg:grid-cols-[1.1fr_1fr]">
          <div className="p-5 sm:p-7">
            <Badge tone="primary" icon={<BarChart3 size={12} />}>
              After every test
            </Badge>
            <h2 className="mt-4 text-[20px] font-semibold tracking-tight sm:text-[25px]">
              A diagnosis built from your real attempt
            </h2>
            <p className="mt-2.5 text-[13.5px] leading-relaxed text-[var(--color-muted)]">
              Vroqn Nexus reads the attempt itself — every answer, every topic, every second spent — and
              explains what actually happened. It never invents a weakness you did not show, and if the AI
              is unavailable it falls back to a plain, deterministic report computed from the same numbers.
            </p>
            <div className="mt-5 rounded-xl border border-[var(--color-primary)]/25 bg-[var(--color-primary)]/[0.06] p-3.5">
              <p className="inline-flex items-center gap-2 text-[13px] font-semibold text-[var(--color-primary)]">
                <Target size={14} /> Practice My Weak Areas
              </p>
              <p className="mt-1.5 text-[12.5px] leading-relaxed text-[var(--color-muted)]">
                One tap takes the topics that cost you the most marks and opens Practice pre-filled for
                them — same subject, same chapter, same question type you struggled with.
              </p>
            </div>
          </div>
          <div className="border-t border-[var(--color-border)] bg-[var(--color-surface)]/60 p-5 sm:p-7 lg:border-l lg:border-t-0">
            <p className="text-[12px] font-medium uppercase tracking-[0.16em] text-[var(--color-muted-dim)]">
              What gets analysed
            </p>
            <ul className="mt-4 space-y-3.5">
              {DIAGNOSIS.map((item) => (
                <li key={item.label} className="flex gap-3">
                  <span className="mt-[7px] h-1.5 w-1.5 shrink-0 rounded-full bg-[var(--color-primary)]" />
                  <span>
                    <span className="block text-[13.5px] font-medium">{item.label}</span>
                    <span className="mt-0.5 block text-[12px] leading-snug text-[var(--color-muted)]">
                      {item.detail}
                    </span>
                  </span>
                </li>
              ))}
            </ul>
          </div>
        </div>
      </div>
    </Reveal>
  );
}

/* -------------------------------------------------------------- start here */

function StartHere() {
  return (
    <section id="start" className="scroll-mt-16 px-4 py-10 sm:py-14">
      <div className="mx-auto w-full max-w-6xl">
        <Reveal className="max-w-2xl">
          <p className="text-[12px] font-medium uppercase tracking-[0.18em] text-[var(--color-muted-dim)]">
            New here?
          </p>
          <h2 className="mt-2 text-[22px] font-semibold tracking-tight sm:text-[28px]">
            Seven questions, answered before you sign up
          </h2>
          <p className="mt-2 text-[14px] leading-relaxed text-[var(--color-muted)]">
            No tutorial needed. Each answer points at the screen that does the job.
          </p>
        </Reveal>

        <ol className="mt-6 grid gap-2.5 sm:grid-cols-2">
          {START_HERE.map((item, index) => (
            <Reveal
              as="li"
              key={item.question}
              className="vroqn-metal rounded-[var(--radius-card)] border border-[var(--color-border)] bg-[var(--color-card)] p-4 shadow-[var(--shadow-card)]"
            >
              <div className="flex items-start gap-3">
                <span
                  aria-hidden="true"
                  className="vroqn-tabular mt-0.5 grid h-6 w-6 shrink-0 place-items-center rounded-full border border-[var(--color-primary)]/30 bg-[var(--color-primary)]/10 font-mono text-[11px] text-[var(--color-primary)]"
                >
                  {index + 1}
                </span>
                <div className="min-w-0">
                  <h3 className="text-[13.5px] font-semibold text-[var(--color-text)]">{item.question}</h3>
                  <p className="mt-1 text-[12.5px] leading-relaxed text-[var(--color-muted)]">{item.answer}</p>
                </div>
              </div>
            </Reveal>
          ))}
        </ol>
      </div>
    </section>
  );
}

/* ------------------------------------------------------------------- trust */

function Trust() {
  return (
    <section className="px-4 py-10 sm:py-14">
      <div className="mx-auto grid w-full max-w-6xl gap-3 sm:grid-cols-3">
        {TRUST.map((item) => (
          <Reveal
            key={item.title}
            className="rounded-[var(--radius-card)] border border-[var(--color-border)] bg-[var(--color-card)] p-4 shadow-[var(--shadow-card)]"
          >
            <span className="inline-flex items-center gap-2 text-[13px] font-semibold">
              <span className="text-[var(--color-primary)]">{item.icon}</span>
              {item.title}
            </span>
            <p className="mt-1.5 text-[12.5px] leading-relaxed text-[var(--color-muted)]">{item.detail}</p>
          </Reveal>
        ))}
      </div>
    </section>
  );
}

/* -------------------------------------------------------------- final CTA */

function FinalCta() {
  return (
    <Reveal className="block px-4 pb-14 pt-6 sm:pb-20">
      <div className="vroqn-edge mx-auto w-full max-w-3xl rounded-[var(--radius-card)] border border-[var(--color-primary)]/25 bg-[var(--color-card)] p-6 text-center shadow-[var(--shadow-card)] sm:p-9">
        <h2 className="text-[20px] font-semibold tracking-tight sm:text-[26px]">
          Start with one chapter you find hard
        </h2>
        <p className="mx-auto mt-2.5 max-w-xl text-[13.5px] leading-relaxed text-[var(--color-muted)]">
          Ask a doubt, practise the topic, sit a short mock, and see the diagnosis. That whole loop takes
          less time than scrolling through notes.
        </p>
        <div className="mt-6 flex flex-col items-center justify-center gap-2.5 sm:flex-row">
          <Link
            to="/signup"
            className="inline-flex h-12 w-full items-center justify-center gap-2 rounded-xl bg-[var(--color-primary)] px-6 text-[15px] font-semibold text-[#04121a] transition-transform active:scale-[0.985] sm:w-auto"
          >
            Get started free
            <ArrowRight size={16} />
          </Link>
          <Link
            to="/login"
            className="inline-flex h-12 w-full items-center justify-center rounded-xl border border-[var(--color-border-strong)] px-6 text-[15px] font-medium transition-colors hover:border-[var(--color-primary)]/50 sm:w-auto"
          >
            Log in
          </Link>
        </div>
      </div>
    </Reveal>
  );
}

/* ------------------------------------------------------------------ footer */

function Footer() {
  return (
    <footer className="border-t border-[var(--color-border)] px-4 py-8">
      <div className="mx-auto flex w-full max-w-6xl flex-col gap-5 sm:flex-row sm:items-start sm:justify-between">
        <div className="max-w-sm">
          <LogoLockup size={26} />
          <p className="mt-2.5 text-[12.5px] leading-relaxed text-[var(--color-muted)]">
            An AI-powered learning workspace for students — learn, practise, test, compete, benchmark,
            diagnose and improve in one place.
          </p>
        </div>
        <div className="flex gap-10">
          <div>
            <p className="text-[12px] font-semibold uppercase tracking-[0.14em] text-[var(--color-muted-dim)]">
              Product
            </p>
            <ul className="mt-2.5 space-y-1.5 text-[13px] text-[var(--color-muted)]">
              <li>
                <a className="transition-colors hover:text-[var(--color-text)]" href="#communities">
                  Communities
                </a>
                <a className="transition-colors hover:text-[var(--color-text)]" href="#features">
                  Features
                </a>
              </li>
              <li>
                <a className="transition-colors hover:text-[var(--color-text)]" href="#arena">
                  Vroqn Arena
                </a>
              </li>
            </ul>
          </div>
          <div>
            <p className="text-[12px] font-semibold uppercase tracking-[0.14em] text-[var(--color-muted-dim)]">
              Account
            </p>
            <ul className="mt-2.5 space-y-1.5 text-[13px] text-[var(--color-muted)]">
              <li>
                <Link className="transition-colors hover:text-[var(--color-text)]" to="/login">
                  Log in
                </Link>
              </li>
              <li>
                <Link className="transition-colors hover:text-[var(--color-text)]" to="/signup">
                  Create account
                </Link>
              </li>
            </ul>
          </div>
        </div>
      </div>
      <div className="mx-auto mt-7 flex w-full max-w-6xl flex-col gap-2 border-t border-[var(--color-border)] pt-5 text-[11.5px] leading-relaxed text-[var(--color-muted-dim)] sm:flex-row sm:items-center sm:justify-between">
        <p className="inline-flex items-center gap-2">
          <LogoMark size={16} /> © {new Date().getFullYear()} Vroqn Nexus
        </p>
        <p className="max-w-xl">
          Vroqn Arena competitions are independent mocks created within Vroqn Nexus. They are not official
          JEE, NEET or board examinations, and percentile figures describe performance inside this app only.
        </p>
      </div>
    </footer>
  );
}
