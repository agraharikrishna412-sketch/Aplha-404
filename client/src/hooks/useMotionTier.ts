/**
 * Decides how much ambient motion this device should get.
 *
 * The hero animation is pure CSS, so the *cost* is bounded — but "bounded" is not "free", and a
 * low-end phone should not pay for decoration. Three tiers:
 *
 *  - `full`    — everything: orbiting rings, travelling particles, breathing core.
 *  - `reduced` — the orbit and the core pulse stay (they are one composited transform each), but the
 *                per-connection particle streams are dropped. Used on clearly weak hardware.
 *  - `static`  — no ambient animation at all. Used when the OS asks for reduced motion, when the
 *                device reports very little memory, or when the user has enabled data saver.
 *
 * The tier is mirrored onto a `data-motion` attribute by the components that use it so the CSS and
 * the markup cannot drift apart.
 *
 * Nothing here is load-bearing: if every signal is missing (an old browser, a privacy extension) each
 * check simply falls through, and the worst case is the `full` tier on a device that would have
 * preferred less — never a broken or invisible hero.
 */
import { useEffect, useState } from 'react';

export type MotionTier = 'full' | 'reduced' | 'static';

/** Non-standard hints; present in Chromium, absent elsewhere. Read defensively. */
interface DeviceHints {
  deviceMemory?: number;
  hardwareConcurrency?: number;
  connection?: { saveData?: boolean; effectiveType?: string };
}

function prefersReducedMotion(): boolean {
  if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return true;
  try {
    return window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  } catch {
    return false;
  }
}

function detect(): MotionTier {
  if (typeof window === 'undefined' || typeof navigator === 'undefined') return 'static';
  if (prefersReducedMotion()) return 'static';

  const hints = navigator as Navigator & DeviceHints;

  // Data saver: the student has asked us to be frugal. Honour it.
  if (hints.connection?.saveData === true) return 'static';
  // Very low memory (< 2 GB reported) or a single core: a still picture is the kinder default.
  if (typeof hints.deviceMemory === 'number' && hints.deviceMemory > 0 && hints.deviceMemory < 2) {
    return 'static';
  }
  if (typeof hints.hardwareConcurrency === 'number' && hints.hardwareConcurrency > 0 && hints.hardwareConcurrency <= 2) {
    return 'reduced';
  }
  // A 2G/3G connection is a reasonable proxy for an older handset in a low-bandwidth area.
  if (hints.connection?.effectiveType === 'slow-2g' || hints.connection?.effectiveType === '2g') {
    return 'reduced';
  }
  return 'full';
}

export function useMotionTier(): MotionTier {
  const [tier, setTier] = useState<MotionTier>(detect);

  /*
   * Follow the OS setting live. A student who switches on "reduce motion" mid-session (or plugs in
   * and unplugs a low-power mode) should not have to reload the page for it to take effect.
   */
  useEffect(() => {
    if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return;
    let query: MediaQueryList;
    try {
      query = window.matchMedia('(prefers-reduced-motion: reduce)');
    } catch {
      return;
    }
    const onChange = () => setTier(detect());
    query.addEventListener?.('change', onChange);
    return () => query.removeEventListener?.('change', onChange);
  }, []);

  return tier;
}
