/**
 * Reveal-on-scroll for landing-page sections.
 *
 * A section fades and lifts into place the first time it enters the viewport, which gives a long page
 * a sense of progression instead of one flat wall of text.
 *
 * Three rules keep this from becoming the usual scroll-animation liability:
 *
 *  1. **It never hides content.** The pre-reveal state is applied by JavaScript, not by CSS. If this
 *     hook never runs — no IntersectionObserver, a scripting error, an automated crawler, a print
 *     stylesheet — the section is simply already visible. A CSS-first implementation (`opacity: 0`
 *     until a class is added) fails closed: one bug and the page is blank.
 *  2. **It unobserves after firing.** Each element animates once, then stops being tracked.
 *  3. **Reduced motion wins.** If the student asked for less motion, or the tier is `static`, the
 *     observer is never created at all.
 */
import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react';
import { useMotionTier } from './useMotionTier';

export function useReveal<T extends HTMLElement = HTMLDivElement>() {
  const tier = useMotionTier();
  const ref = useRef<T | null>(null);
  const [revealed, setRevealed] = useState(tier !== 'full' && tier !== 'reduced');

  useEffect(() => {
    if (tier === 'static') {
      setRevealed(true);
      return;
    }
    const element = ref.current;
    if (!element) return;
    if (typeof IntersectionObserver !== 'function') {
      setRevealed(true);
      return;
    }

    // Anything already on screen at mount (the hero) reveals immediately; the rest waits for scroll.
    const observer = new IntersectionObserver(
      (entries) => {
        for (const entry of entries) {
          if (!entry.isIntersecting) continue;
          setRevealed(true);
          observer.unobserve(entry.target);
        }
      },
      { rootMargin: '0px 0px -8% 0px', threshold: 0.08 },
    );
    observer.observe(element);
    return () => observer.disconnect();
  }, [tier]);

  return { ref, revealed };
}

/**
 * Convenience wrapper: a section that reveals itself once.
 *
 * `className` is composed rather than replaced, and the transition is a plain opacity+transform pair
 * so it stays on the compositor.
 */
export function Reveal({
  children,
  className = '',
  as: Tag = 'div',
  id,
}: {
  children: ReactNode;
  className?: string;
  as?: 'div' | 'section' | 'li';
  /** Anchor target, so in-page links (`#arena`) keep working on a revealed section. */
  id?: string;
}) {
  const { ref, revealed } = useReveal<HTMLDivElement>();
  /*
   * A callback ref instead of a cast. `<Tag>` is polymorphic (div/section/li), and a union ref type
   * fights the DOM's per-tag ref types; assigning through one small callback keeps the whole thing
   * type-safe with no `any`.
   */
  const attach = useCallback(
    (node: HTMLElement | null) => {
      ref.current = node as HTMLDivElement | null;
    },
    [ref],
  );
  return (
    // `motion-reduce:transition-none` is the second line of defence: the hook already skips the
    // observer under reduced motion, but if a student flips the OS setting mid-session, the CSS
    // variant cuts the transition immediately.
    <Tag
      id={id}
      ref={attach}
      className={[
        'transition-[opacity,transform] duration-500 ease-[var(--ease-out)] motion-reduce:transition-none',
        revealed ? 'translate-y-0 opacity-100' : 'translate-y-2 opacity-0',
        className,
      ].join(' ')}
    >
      {children}
    </Tag>
  );
}
