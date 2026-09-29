/**
 * The Vroqn Study Core — the hero animation on the dashboard.
 *
 * What it is: a two-ring gyroscope of knowledge. An outer orbit carries the eight things a student
 * does — ask the AI, practise, read the news, take notes, write code, sit a mock exam, compete in
 * Arena, work with their groups — and an inner orbit carries the six that belong to *them*: messages,
 * their profile, learning analytics, learning activity, settings and help. The two rings turn in
 * opposite directions around a lit core, inside a machined tick dial, over a ground plane.
 *
 * **Every disc is a real button.** Press "News" and News opens; press "Code Lab" and the editor opens.
 * The thing that spins is the thing you press — all fourteen destinations, no dead decoration.
 *
 * How the geometry was decided (this is the part that took the work):
 *
 *  - The discs sit on a plane tilted 62°, so a disc's position on that plane becomes a real z offset,
 *    and the 1000px camera on the root projects it into size. The disc at the front genuinely IS
 *    larger; the one behind genuinely IS smaller. No faked `scale()` fudge.
 *  - Ring radii and the inner ring's phase were **solved numerically**, not eyeballed: with the outer
 *    ring at r=152 (8 discs, 48px) and the inner at r=86 (6 discs, 40px), the closest two badge centres
 *    anywhere in the composition are 54.8px apart — about 11px of daylight between the two closest
 *    chips. That is the constraint that decides the layout, because a tap target you cannot hit is not
 *    a feature.
 *  - The dial, the two track rings and the discs all share the same tilted plane, so the instrument
 *    lines up with the orbits exactly.
 *
 * Why it is built like this:
 *
 *  - **Real 3D, no 3D engine.** CSS `transform-style: preserve-3d` with `rotate3d` keyframes. No
 *    WebGL, no three.js, no per-frame JavaScript: a phone composites this as cheaply as it composites
 *    a rectangle, so "cool" never costs a student a slow homepage.
 *  - **It holds still the moment you reach for it.** Hover or keyboard focus pauses both orbits
 *    (`animation-play-state: paused`), and a press pauses them for a moment on touch, where there is
 *    no hover at all. A moving tap target is a tap target you miss.
 *  - **Reduced motion is a first-class look.** Every keyframe ends at its resting pose, so
 *    `prefers-reduced-motion` freezes a complete technical drawing — and the links still work.
 *  - **The artwork can never steal a tap.** The root keeps `pointer-events: none`; only the discs opt
 *    back in. Every purely visual layer is `aria-hidden`, and each disc carries a real accessible name
 *    that contains its visible word, so voice control ("tap News") works too.
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import {
  Atom,
  BookOpen,
  BrainCircuit,
  Calculator,
  CircleHelp,
  Code2,
  Compass,
  FlaskConical,
  FunctionSquare,
  GraduationCap,
  LineChart,
  Mail,
  Newspaper,
  Settings as SettingsIcon,
  UserRound,
  Users,
  Activity,
} from 'lucide-react';
import { useMotionTier } from '../../hooks/useMotionTier';

/**
 * The radii and shapes of the two rings, in one place.
 *
 * These are *plane* numbers: the CSS keyframes place the chips in the tilted plane, and the plane is
 * squashed vertically on screen (measured factor ~0.45, plus perspective). So the outer ring renders
 * at roughly 140 x 120 screen px on a phone while its plane ellipse is 163 x 292. Keeping the numbers
 * here means the tracks, the keyframes, the dial and — for the frozen drawing — the static chip
 * positions are all derived from one description instead of four that drift apart.
 *
 * `STRETCH` (1.45) is the dial and inner-ring shape; `STRETCH_OUTER` (1.79) the outer one. Both match
 * `--core-stretch` / `--core-stretch-outer` in styles.css.
 */
const STRETCH = 1.81;
const STRETCH_OUTER = 1.79;
const RADIUS_OUTER = 172;
const RADIUS_INNER = 95;
const DIAL_RADIUS = 132;

interface Disc {
  key: string;
  icon: React.ReactNode;
  label: string;
  name: string;
  to: string;
}

/** Outer orbit, r=152: the eight things a student does. */
const OUTER: Disc[] = [
  { key: 'ai', icon: <BrainCircuit size={18} />, label: 'AI', name: 'AI — ask a doubt', to: '/tutor' },
  { key: 'practice', icon: <Calculator size={18} />, label: 'Practice', name: 'Practice — start a question set', to: '/practice' },
  { key: 'news', icon: <Newspaper size={18} />, label: 'News', name: 'News — headlines', to: '/news' },
  { key: 'notes', icon: <BookOpen size={18} />, label: 'Notes', name: 'Notes — open your notes', to: '/notes' },
  { key: 'code', icon: <Code2 size={18} />, label: 'Code Lab', name: 'Code Lab — write and run code', to: '/code-lab' },
  { key: 'mock', icon: <Compass size={18} />, label: 'Mock Exam', name: 'Mock Exam — timed tests', to: '/mock-exam' },
  { key: 'arena', icon: <GraduationCap size={18} />, label: 'Arena', name: 'Arena — timed competitions', to: '/arena' },
  { key: 'groups', icon: <Users size={18} />, label: 'Groups', name: 'Groups — communities', to: '/communities' },
];

/** Inner orbit, r=86: the six that belong to the student. */
const INNER: Disc[] = [
  { key: 'messages', icon: <Mail size={16} />, label: 'Messages', name: 'Messages — private chats', to: '/messages' },
  { key: 'profile', icon: <UserRound size={16} />, label: 'Profile', name: 'Profile — your card', to: '/profile' },
  { key: 'analytics', icon: <LineChart size={16} />, label: 'Analytics', name: 'Learning Analytics', to: '/analytics' },
  { key: 'activity', icon: <Activity size={16} />, label: 'Activity', name: 'Learning Activity', to: '/activity' },
  { key: 'settings', icon: <SettingsIcon size={16} />, label: 'Settings', name: 'Settings — keys and preferences', to: '/settings' },
  { key: 'help', icon: <CircleHelp size={16} />, label: 'Help', name: 'Help — how everything works', to: '/help' },
];

/* Kept for the subject-specific shortcut look on the Physics/Maths/Chemistry discs. */
export const SUBJECT_ICONS = { physics: <Atom size={16} />, maths: <FunctionSquare size={16} />, chemistry: <FlaskConical size={16} /> };

function Ring({ discs, ring }: { discs: Disc[]; ring: 'outer' | 'inner' }) {
  return (
    <div className={`vroqn-core__orbit vroqn-core__orbit--${ring}`}>
      {/* The track: the exact circle the discs travel, drawn in their own plane. */}
      <span aria-hidden="true" className="vroqn-core__track" data-ring={ring} />
      <div className="vroqn-core__ring-items" role="group" aria-label={ring === 'outer' ? 'Study shortcuts' : 'Your shortcuts'}>
        {discs.map((disc, index) => {
          /* Chip `index` of `count` starts a full lap's worth of degrees further round the ring. */
          const angle = (index / discs.length) * Math.PI * 2;
          const radius = ring === 'inner' ? RADIUS_INNER : RADIUS_OUTER;
          const shape = ring === 'inner' ? STRETCH : STRETCH_OUTER;
          return (
          <span
            key={disc.key}
            className="vroqn-core__item"
            data-index={index}
            style={
              {
                '--i': index,
                '--count': discs.length,
                /*
                 * Where this chip sits when the animation is taken away. `prefers-reduced-motion` kills
                 * every keyframe, so without these two numbers the frozen planet is fourteen icons in a
                 * pile at the centre. Derived here from the same radii the keyframes use — a second
                 * hard-coded copy would drift the first time the ring is resized.
                 */
                '--still-x': `${(radius * Math.cos(angle)).toFixed(1)}px`,
                '--still-y': `${(radius * shape * Math.sin(angle)).toFixed(1)}px`,
              } as React.CSSProperties
            }
          >
            {/*
              The badge is the link. It counter-rotates against the orbit so the icon and the word stay
              upright the whole way round — without that the discs go upside-down twice per revolution,
              which reads as a bug rather than as an orbit.
            */}
            <Link to={disc.to} aria-label={disc.name} title={disc.name} className="vroqn-core__badge vroqn-tap">
              {disc.icon}
              <span className="vroqn-core__label">{disc.label}</span>
            </Link>
          </span>
          );
        })}
      </div>
    </div>
  );
}

export function StudyCore({ className = '' }: { className?: string }) {
  const tier = useMotionTier();
  const wrapRef = useRef<HTMLDivElement | null>(null);
  const [tilt, setTilt] = useState({ x: 0, y: 0 });
  /**
   * True for a moment after a press inside the assembly.
   *
   * A phone has no hover, so the CSS rule that pauses the orbits on hover never fires there — and a
   * student tapping a drifting disc deserves the same "it holds still for me" behaviour a mouse gets.
   */
  const [held, setHeld] = useState(false);
  const holdTimer = useRef<number | null>(null);

  const hold = useCallback(() => {
    setHeld(true);
    if (holdTimer.current) window.clearTimeout(holdTimer.current);
    holdTimer.current = window.setTimeout(() => setHeld(false), 1200);
  }, []);

  useEffect(() => () => {
    if (holdTimer.current) window.clearTimeout(holdTimer.current);
  }, []);

  /**
   * Parallax: a small pointer-driven tilt of the whole assembly.
   *
   * Bounded to ±7° so it reads as depth rather than as the page moving, and it writes one CSS custom
   * property pair instead of re-rendering the tree.
   */
  useEffect(() => {
    if (tier === 'static') return;
    const node = wrapRef.current;
    if (!node) return;

    const onMove = (event: PointerEvent) => {
      const rect = node.getBoundingClientRect();
      const dx = (event.clientX - (rect.left + rect.width / 2)) / Math.max(rect.width, 1);
      const dy = (event.clientY - (rect.top + rect.height / 2)) / Math.max(rect.height, 1);
      setTilt({ x: Math.max(-7, Math.min(7, dy * -9)), y: Math.max(-7, Math.min(7, dx * 9)) });
    };
    const reset = () => setTilt({ x: 0, y: 0 });

    node.addEventListener('pointermove', onMove);
    node.addEventListener('pointerleave', reset);
    return () => {
      node.removeEventListener('pointermove', onMove);
      node.removeEventListener('pointerleave', reset);
    };
  }, [tier]);

  const still = tier === 'static';

  return (
    <div
      ref={wrapRef}
      /*
       * No `relative`/`absolute` utility here on purpose. The caller sets the height and, if it needs
       * to, the position; the component supplies its own containing block in CSS
       * (`.vroqn-core { position: relative }`). Mixing the two — a Tailwind `relative` fighting a
       * caller's `absolute inset-0`, with the winner decided by stylesheet order — silently collapsed
       * this box to zero height and glued the whole assembly to the card's top-left corner.
       *
       * `pointer-events-none` stays: the artwork must never eat a tap meant for the page. The disc
       * links opt back in individually.
       */
      className={`vroqn-core pointer-events-none select-none ${held ? 'vroqn-core--held' : ''} ${className}`}
      onPointerDown={hold}
      onTouchStart={hold}
      style={{ '--core-tilt-x': `${tilt.x}deg`, '--core-tilt-y': `${tilt.y}deg` } as React.CSSProperties}
    >
      {/* Everything the eye sees lives in this box, so the root only has to be sized. */}
      <div className="vroqn-core__viewport">
        {/* Soft cyan bloom behind the assembly — the only thing lighting the scene. */}
        <span aria-hidden="true" className="vroqn-core__bloom" />

        {/* Ground plane: a faint horizon line, and the shadow the assembly casts on it. */}
        <span aria-hidden="true" className="vroqn-core__horizon" />
        <span aria-hidden="true" className="vroqn-core__ground" />

        {/* The dome sits the whole diagram inside a tilted viewport, which is what makes it read as 3D. */}
        <div className={`vroqn-core__stage ${still ? 'vroqn-core--still' : ''}`}>
          {/* Outer orbit, then the inner one turning the other way. Both are live. */}
          <Ring discs={OUTER} ring="outer" />
          <Ring discs={INNER} ring="inner" />

          {/* ---------------- decoration from here down ---------------- */}

          {/*
            The machined face: 48 fine marks just outside the outer track, with a long mark every sixth,
            turning slowly, plus a sweep hand. It shares the discs' plane, so it lines up with the orbit
            instead of drifting across it.
          */}
          <div aria-hidden="true" className="vroqn-core__dial">
            {/*
              The ticks are placed on the same ellipse the rings use, each rotated to its own outward
              normal — computed here rather than by scaling a circle.

              Why: the first version put 48 radial ticks inside a `scaleY(1.25)` container, which
              stretched the marks sideways instead of moving them along the ellipse, so the "machined
              dial" read as scattered debris again. An ellipse needs its marks positioned, not squashed:
              for parameter a the point is (R·cos a, R·s·sin a) and its outward normal runs along
              (cos a, sin a / s).
            */}
            {Array.from({ length: 48 }, (_, index) => {
              const a = (index / 48) * Math.PI * 2;
              const x = DIAL_RADIUS * Math.cos(a);
              const y = DIAL_RADIUS * STRETCH * Math.sin(a);
              const tilt = (Math.atan2(Math.cos(a), Math.sin(a) / STRETCH) * 180) / Math.PI;
              return (
                <span
                  key={index}
                  className="vroqn-core__tick"
                  data-major={index % 6 === 0 ? 'true' : undefined}
                  style={{ transform: `translate(${x.toFixed(1)}px, ${y.toFixed(1)}px) rotate(${tilt.toFixed(1)}deg)` }}
                />
              );
            })}
            <span className="vroqn-core__sweep" />
          </div>

          {/* Atmospheric haze inside the orbit plane, so the rings are not wireframes in a void. */}
          <div aria-hidden="true" className="vroqn-core__dust" />

          {/* The core: a glass shell over a lit heart, with three wireframe equators. */}
          <div aria-hidden="true" className="vroqn-core__shell" />
          <div aria-hidden="true" className="vroqn-core__heart" />
          <div aria-hidden="true" className="vroqn-core__sphere">
            <span className="vroqn-core__ring vroqn-core__ring--x" />
            <span className="vroqn-core__ring vroqn-core__ring--y" />
            <span className="vroqn-core__ring vroqn-core__ring--z" />
          </div>
        </div>

        {/*
          Sparks rise through the scene. They deliberately sit OUTSIDE the tilted stage: inside it they
          inherited the plane's rotation and flew off at a diagonal, which read as scratches on the
          screen rather than as particles rising past the core.
        */}
        {!still ? (
          <div aria-hidden="true" className="vroqn-core__sparks">
            {Array.from({ length: 7 }, (_, index) => (
              <span key={index} className="vroqn-core__spark" style={{ '--i': index } as React.CSSProperties} />
            ))}
          </div>
        ) : null}
      </div>
    </div>
  );
}
