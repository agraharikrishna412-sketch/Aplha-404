/**
 * Vroqn Communities on the landing page (§49).
 *
 * The section has one job: show the loop a community adds — students → knowledge → practice →
 * competition → progress — and say what a student gets out of it, in one screen, without turning the
 * landing page into a product tour.
 *
 * Rendering notes:
 *  - Static markup. Nothing here fetches, so it renders the same for a visitor with no session and it
 *    cannot show an empty or errored state.
 *  - The flow diagram is CSS-only: five static nodes and a single travelling highlight. It is switched
 *    off (not merely slowed) under `prefers-reduced-motion` and on low-power devices via the app's
 *    `data-motion` attribute, leaving a still, complete diagram rather than a frozen frame.
 *  - No new colours: the community accent is the same primary cyan used everywhere else.
 */
import { ArrowRight, BookMarked, CalendarClock, MessagesSquare, ShieldCheck, Target, Trophy, Users } from 'lucide-react';
import { Link } from 'react-router-dom';
import { Badge } from '../../components/ui';
import { Reveal } from '../../hooks/useReveal';

/** The five beats of the loop, in the order a student actually moves through them. */
const FLOW = [
  { label: 'Students', detail: 'A group with the same goal', icon: <Users size={15} /> },
  { label: 'Knowledge', detail: 'Doubts answered, kept, searchable', icon: <BookMarked size={15} /> },
  { label: 'Practice', detail: 'Shared plans, resources and teams', icon: <Target size={15} /> },
  { label: 'Competition', detail: 'Papers hosted by the community', icon: <Trophy size={15} /> },
  { label: 'Progress', detail: 'Rankings and weak areas, measured', icon: <MessagesSquare size={15} /> },
] as const;

const INSIDE = [
  'Ask a doubt and get answers from people studying the same chapters — the best ones are saved into the community knowledge base.',
  'Share notes, formula sheets and links, or run a study plan and a team working through it together.',
  'Take part in competitions your community hosts, with the same timed papers and integrity rules as everything else in Arena.',
  'See where you stand on the community leaderboard and which topics the group is finding hard.',
] as const;

export function CommunitiesSection() {
  return (
    <section id="communities" className="scroll-mt-16 px-4 py-10 sm:py-14">
      <div className="mx-auto w-full max-w-6xl">
        <Reveal className="max-w-2xl">
          <Badge tone="primary" icon={<Users size={12} />}>
            Vroqn Communities
          </Badge>
          <h2 className="vroqn-text-balance mt-4 text-[22px] font-semibold tracking-tight sm:text-[28px]">
            Learn Together. Compete Together. Improve Together.
          </h2>
          <p className="mt-3 text-[14.5px] leading-relaxed text-[var(--color-muted)]">
            Join communities, discuss concepts, compete in challenges and turn your preparation into
            measurable progress.
          </p>
        </Reveal>

        {/* The loop. Horizontal on wide screens, a vertical run of five cards on a phone. */}
        <Reveal className="mt-7">
          <ol className="vroqn-community-flow relative grid gap-2.5 sm:grid-cols-5 sm:gap-3">
            {FLOW.map((step, index) => (
              <li
                key={step.label}
                className="vroqn-metal relative rounded-[var(--radius-card)] border border-[var(--color-border)] bg-[var(--color-card)] p-3.5 shadow-[var(--shadow-card)]"
              >
                <div className="flex items-center gap-2">
                  <span className="flex h-7 w-7 shrink-0 items-center justify-center rounded-lg bg-[var(--color-primary)]/10 text-[var(--color-primary)]">
                    {step.icon}
                  </span>
                  <span className="text-[13.5px] font-semibold">{step.label}</span>
                </div>
                <p className="mt-2 text-[12px] leading-snug text-[var(--color-muted)]">{step.detail}</p>
                {/* Step order, so the sequence reads even with the animation switched off. */}
                <span className="vroqn-tabular absolute right-3 top-3 text-[11px] font-mono text-[var(--color-muted-dim)]">
                  {String(index + 1).padStart(2, '0')}
                </span>
              </li>
            ))}
            {/* Decoration only: the travelling highlight that makes the order obvious at a glance. */}
            <span aria-hidden="true" className="vroqn-community-sweep" />
          </ol>
        </Reveal>

        <div className="mt-4 grid gap-4 lg:grid-cols-[1.15fr_0.85fr]">
          <Reveal className="rounded-[var(--radius-card)] border border-[var(--color-border)] bg-[var(--color-card)] p-5 shadow-[var(--shadow-card)] sm:p-6">
            <h3 className="text-[15px] font-semibold">What happens inside a community</h3>
            <ul className="mt-4 space-y-3">
              {INSIDE.map((item) => (
                <li key={item} className="flex gap-2.5 text-[13.5px] leading-relaxed text-[var(--color-muted)]">
                  <span className="mt-[7px] h-1.5 w-1.5 shrink-0 rounded-full bg-[var(--color-primary)]" />
                  {item}
                </li>
              ))}
            </ul>
          </Reveal>

          <Reveal className="flex flex-col gap-3">
            <div className="rounded-[var(--radius-card)] border border-[var(--color-border)] bg-[var(--color-card)] p-5 shadow-[var(--shadow-card)]">
              <h3 className="text-[15px] font-semibold">Starting a community</h3>
              <p className="mt-2 text-[13.5px] leading-relaxed text-[var(--color-muted)]">
                Open one for your school batch, your coaching group or a chapter you are all stuck on.
                Choose whether it is open to everyone, approved by you, or invite-only — and you can
                change that later.
              </p>
            </div>
            <div className="rounded-[var(--radius-card)] border border-[var(--color-border)] bg-[var(--color-card)] p-5 shadow-[var(--shadow-card)]">
              <h3 className="flex items-center gap-2 text-[15px] font-semibold">
                <ShieldCheck size={15} className="text-[var(--color-primary)]" aria-hidden="true" />
                Kept civil
              </h3>
              <p className="mt-2 text-[13.5px] leading-relaxed text-[var(--color-muted)]">
                Every community has moderators, and you can report, mute or block in a tap. Groups are
                for academic discussion — there is no unrestricted private messaging, and nobody can
                see your contact details.
              </p>
            </div>
            <div className="flex flex-col gap-2 sm:flex-row">
              <Link
                to="/signup"
                className="inline-flex h-11 flex-1 items-center justify-center gap-2 rounded-xl bg-[var(--color-primary)] px-5 text-[14px] font-semibold text-[#04121a] transition-transform active:scale-[0.985]"
              >
                Explore communities
                <ArrowRight size={15} />
              </Link>
              <a
                href="#arena"
                className="inline-flex h-11 flex-1 items-center justify-center gap-2 rounded-xl border border-[var(--color-border-strong)] px-5 text-[14px] font-medium transition-colors hover:border-[var(--color-primary)]/50 hover:bg-white/[0.03]"
              >
                <CalendarClock size={15} />
                How Arena papers work
              </a>
            </div>
          </Reveal>
        </div>
      </div>
    </section>
  );
}
