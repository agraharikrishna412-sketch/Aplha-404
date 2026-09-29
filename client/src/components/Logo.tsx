/**
 * Vroqn Nexus mark: a minimal brain/cylinder hybrid — two stacked chambers with a signal node.
 * Drawn with strokes only, so it stays legible at 20 px (app icon) and 44 px (sidebar).
 */
export function LogoMark({ size = 32, className = '' }: { size?: number; className?: string }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 64 64"
      fill="none"
      className={className}
      role="img"
      aria-label="Vroqn Nexus logo"
    >
      <rect x="1.5" y="1.5" width="61" height="61" rx="14" fill="#080D12" stroke="#1C2A33" strokeWidth="1.5" />
      <g stroke="url(#vroqn-grad)" strokeWidth="3.2" strokeLinecap="round" fill="none">
        <path d="M20 16c0-4.2 3-7.4 7-7.4s7 3.2 7 7.4v32c0 4.2-3 7.4-7 7.4s-7-3.2-7-7.4z" />
        <path d="M34 23c0-3.2 2.6-5.8 5.8-5.8s5.8 2.6 5.8 5.8v18c0 3.2-2.6 5.8-5.8 5.8S34 44.2 34 41z" />
        <path d="M27 25h-4.5M27 39h-4.5" />
      </g>
      <circle cx="40" cy="32" r="2.9" fill="#22D3EE" />
      <defs>
        <linearGradient id="vroqn-grad" x1="16" y1="8" x2="48" y2="56" gradientUnits="userSpaceOnUse">
          <stop stopColor="#00E5FF" />
          <stop offset="1" stopColor="#22D3EE" stopOpacity="0.7" />
        </linearGradient>
      </defs>
    </svg>
  );
}

export function LogoLockup({ size = 30, subtitle }: { size?: number; subtitle?: string }) {
  return (
    <span className="flex items-center gap-2.5">
      <LogoMark size={size} />
      <span className="leading-tight">
        <span className="block text-[15px] font-semibold tracking-tight text-[var(--color-text)]">
          Vroqn <span className="text-[var(--color-primary)]">Nexus</span>
        </span>
        {subtitle ? <span className="block text-[11px] text-[var(--color-muted)]">{subtitle}</span> : null}
      </span>
    </span>
  );
}
