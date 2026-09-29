/**
 * Help.
 *
 * Written as the page a new student actually needs: what to do first, how the AI keys work, what is
 * private and what is not, and what to do when something looks wrong. Every statement here matches
 * what the code does — pages that promise features the product does not have are worse than no help
 * page at all.
 */
import { useState } from 'react';
import { Link } from 'react-router-dom';
import { BookOpen, ChevronDown, KeyRound, Lock, MessagesSquare, ShieldCheck, Sparkles, Trophy } from 'lucide-react';
import { PageBody, PageHeader } from '../../components/AppShell';
import { Badge, Card, CardHeader, VroqnSection } from '../../components/vroqn';

interface Topic {
  id: string;
  icon: React.ReactNode;
  title: string;
  summary: string;
  points: React.ReactNode[];
}

const TOPICS: Topic[] = [
  {
    id: 'start',
    icon: <Sparkles size={15} />,
    title: 'Getting started',
    summary: 'The four things worth doing in your first ten minutes.',
    points: [
      <>
        Start on <strong>Home</strong> — it tells you what to do next instead of showing a wall of empty boxes.
      </>,
      <>
        Ask your first doubt in <strong>AI</strong>. Answers arrive as concept, explanation, example, practice and a quick check.
      </>,
      <>
        Generate a <strong>Practice</strong> set for the chapter you are on, then a <strong>Mock Exam</strong> when you feel ready.
      </>,
      <>
        Join a <strong>Group</strong> to study with others. Group chat, doubts and competitions live there.
      </>,
    ],
  },
  {
    id: 'keys',
    icon: <KeyRound size={15} />,
    title: 'AI keys',
    summary: 'Vroqn Nexus brings your own key — Gemini, Groq or OpenRouter.',
    points: [
      <>Add a key in <strong>Settings → Providers</strong>. Keys are encrypted on the server and never sent back to the browser.</>,
      <>If no key is added, the app can answer with the offline sample engine so you can still see how everything works.</>,
      <>If a provider refuses or rate-limits a request, the next key or provider is tried automatically. Refusals are never bypassed.</>,
      <>Nothing is charged by Vroqn Nexus. Any provider quota is between you and that provider.</>,
    ],
  },
  {
    id: 'privacy',
    icon: <Lock size={15} />,
    title: 'Privacy and encryption',
    summary: 'What we can and cannot see — stated plainly.',
    points: [
      <>
        <strong>Private messages are encrypted on your device.</strong> The server stores ciphertext, who is in the conversation and when
        messages were sent — not what they say.
      </>,
      <>Private messages are never used for AI, analytics, search or training, and are never shown to community moderators.</>,
      <>Your browsing activity is visible only to you. Profile visibility, activity visibility, communities and badges each have their own switch.</>,
      <>Brave claim, careful wording: this is not yet <em>verified</em> encryption — there is no safety-number comparison between two students, so a compromised device stays a risk.</>,
    ],
  },
  {
    id: 'groups',
    icon: <MessagesSquare size={15} />,
    title: 'Groups and messages',
    summary: 'Communities, chat and private conversations.',
    points: [
      <>Every community has roles: owner, admin, moderator, mentor and member. What you can do is decided by the server, not by what the screen shows.</>,
      <>If a community turns a section off, the section disappears for everyone in it and its data is kept — it comes back exactly as it was.</>,
      <>You can message any student whose inbox policy allows it. Blocking stops messages both ways immediately.</>,
      <>Use the report action on any message. Private-chat reports go to the platform safety team, never to community moderators.</>,
    ],
  },
  {
    id: 'arena',
    icon: <Trophy size={15} />,
    title: 'Arena',
    summary: 'Timed competitive papers, with honest analysis afterwards.',
    points: [
      <>Arena is a practice competition among students. It is <strong>not</strong> an official JEE, NEET or board examination.</>,
      <>One attempt per paper. Integrity signals (tab switches, focus loss) are recorded for the attempt and shown to you; they never fail a paper automatically.</>,
      <>Private competition links only open for the people they were shared with.</>,
      <>Poor connectivity? Your work is saved as you go, so a dropped connection does not cost your attempt.</>,
    ],
  },
  {
    id: 'problems',
    icon: <ShieldCheck size={15} />,
    title: 'When something looks wrong',
    summary: 'The fastest way back to a working screen.',
    points: [
      <>A page that fails always shows a retry control. Retrying is safe: nothing is submitted twice.</>,
      <>If the app says you are offline, check your connection — your typed answer is kept in the box until it sends.</>,
      <>If a message cannot be read on this device, it means the conversation key has not arrived here yet. Open the conversation and use <strong>Send keys to this device</strong>.</>,
      <>Seeing “Sample mode”? That means no AI key is connected. Add one in Settings for real answers.</>,
      <>Genuinely stuck? Send the exact wording of the message you saw — it is written to be readable, not a code.</>,
    ],
  },
];

export function HelpPage() {
  const [open, setOpen] = useState<string | null>('start');

  return (
    <div>
      <PageHeader
        title="Help"
        description="How Vroqn Nexus works, what is private, and what to do when something looks broken."
        badge={<Badge tone="muted">Straight answers</Badge>}
      />
      <PageBody className="max-w-3xl space-y-3">
        <Card>
          <CardHeader title="Start here" subtitle="Pick a topic" icon={<BookOpen size={15} />} />
          <ul className="divide-y divide-[var(--color-border)]">
            {TOPICS.map((topic) => {
              const expanded = open === topic.id;
              return (
                <li key={topic.id}>
                  <button
                    type="button"
                    aria-expanded={expanded}
                    onClick={() => setOpen(expanded ? null : topic.id)}
                    className="vroqn-tap flex w-full items-center gap-3 px-4 py-3 text-left transition-colors hover:bg-white/[0.03]"
                  >
                    <span className="grid h-8 w-8 shrink-0 place-items-center rounded-full border border-[var(--color-border)] text-[var(--color-primary)]">
                      {topic.icon}
                    </span>
                    <span className="min-w-0 flex-1">
                      <span className="block text-[13.5px] font-medium">{topic.title}</span>
                      <span className="block truncate text-[12px] text-[var(--color-muted)]">{topic.summary}</span>
                    </span>
                    <ChevronDown size={16} className={`shrink-0 text-[var(--color-muted)] transition-transform ${expanded ? 'rotate-180' : ''}`} />
                  </button>
                  {expanded ? (
                    <ul className="space-y-2 px-4 pb-4 pl-[60px] text-[12.5px] leading-relaxed text-[var(--color-muted)]">
                      {topic.points.map((point, index) => (
                        <li key={index} className="list-disc">
                          {point}
                        </li>
                      ))}
                    </ul>
                  ) : null}
                </li>
              );
            })}
          </ul>
        </Card>

        <VroqnSection title="Shortcuts" description="The screens students use most.">
          <div className="grid gap-2 sm:grid-cols-2">
            {[
              { to: '/', label: 'Home', hint: 'What to do next' },
              { to: '/tutor', label: 'AI', hint: 'Ask a doubt' },
              { to: '/practice', label: 'Practice', hint: 'Topic-wise sets' },
              { to: '/messages', label: 'Messages', hint: 'Private conversations' },
              { to: '/profile', label: 'Profile', hint: 'Bio, photo, privacy' },
              { to: '/settings', label: 'Settings', hint: 'Keys, level, language' },
            ].map((link) => (
              <Link
                key={link.to}
                to={link.to}
                className="vroqn-tap flex items-center justify-between gap-2 rounded-[10px] border border-[var(--color-border)] px-3 py-2.5 text-[13px] transition-colors hover:border-[var(--color-border-strong)]"
              >
                <span>{link.label}</span>
                <span className="text-[11.5px] text-[var(--color-muted-dim)]">{link.hint}</span>
              </Link>
            ))}
          </div>
        </VroqnSection>
      </PageBody>
    </div>
  );
}
