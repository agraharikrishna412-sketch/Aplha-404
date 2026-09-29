/**
 * The Vroqn Knowledge Core — the hero animation.
 *
 * Concept: seven learning nodes arranged around a breathing central core, each connected to it by a
 * line that streams particles inward. A progress arc closes around the outside. Read together it says
 * exactly what the product does: *many things you study, flowing into one place that shows you how far
 * you have come.*
 *
 * Why it is built this way
 * ------------------------
 *  - **No library, no canvas, no WebGL.** It is inline SVG driven entirely by CSS keyframes, so there
 *    is nothing to download, nothing to boot, and no frame loop. The whole component costs a few kB of
 *    markup instead of a 3D runtime.
 *  - **GPU-friendly.** Only `transform` and `opacity` animate, and only on a handful of groups, so the
 *    browser composites instead of repainting.
 *  - **Honest fallback.** Every keyframe ends at its resting state, so with animation disabled the
 *    diagram is complete and legible rather than half-drawn. `useMotionTier` picks `full`, `reduced` or
 *    `static`, and the still version is a clean technical drawing — not a broken one.
 *  - **Never in the way.** `aria-hidden` on the decorative layers and `pointer-events-none` on the
 *    whole graphic, so it can never intercept a tap or add noise to a screen reader.
 *
 * The seven node angles deliberately match the seven steps of the product loop, so the shape is not
 * arbitrary: it is a picture of Learn → Practise → Build → Test → Compete → Benchmark → Improve.
 */
import { useMemo } from 'react';
import { useMotionTier } from '../../hooks/useMotionTier';

const SIZE = 400;
const CENTRE = SIZE / 2;
const NODE_RADIUS = 132;
const ARCS = 12;

/** Seven evenly spaced angles, starting at 12 o'clock and going clockwise. */
const NODE_ANGLES = Array.from({ length: 7 }, (_, index) => (index * 360) / 7);

function polar(angleDeg: number, radius: number) {
  const rad = ((angleDeg - 90) * Math.PI) / 180;
  return { x: CENTRE + radius * Math.cos(rad), y: CENTRE + radius * Math.sin(rad) };
}

/** A gentle curve from the core out to a node, so the lines read as flow rather than spokes. */
function connectorPath(angleDeg: number): string {
  const start = polar(angleDeg + 9, 46);
  const end = polar(angleDeg, NODE_RADIUS - 12);
  const control = polar(angleDeg + 4, (NODE_RADIUS - 12 + 46) / 2);
  return `M ${start.x.toFixed(1)} ${start.y.toFixed(1)} Q ${control.x.toFixed(1)} ${control.y.toFixed(1)} ${end.x.toFixed(1)} ${end.y.toFixed(1)}`;
}

export function KnowledgeCore({ className = '' }: { className?: string }) {
  const tier = useMotionTier();

  /* One tick ring, generated once — 12 machined marks around the outer dial. */
  const ticks = useMemo(
    () =>
      Array.from({ length: ARCS }, (_, index) => {
        const angle = (index * 360) / ARCS;
        const outer = polar(angle, 184);
        const inner = polar(angle, index % 3 === 0 ? 170 : 176);
        return { key: index, x1: inner.x, y1: inner.y, x2: outer.x, y2: outer.y, major: index % 3 === 0 };
      }),
    [],
  );

  const nodes = useMemo(
    () =>
      NODE_ANGLES.map((angle, index) => ({
        angle,
        index,
        point: polar(angle, NODE_RADIUS),
        halo: polar(angle, NODE_RADIUS + 9),
        path: connectorPath(angle),
      })),
    [],
  );

  /* The progress arc: 68% of the circumference drawn, animated once on mount and then held. */
  const arcRadius = 168;
  const arcLength = 2 * Math.PI * arcRadius;
  const arcRest = arcLength * (1 - 0.68);

  return (
    <div
      data-motion={tier}
      className={`pointer-events-none relative select-none ${className}`}
      // Meaningful, not decorative: it is the product loop drawn as a diagram, so it gets a label.
      role="img"
      aria-label="Diagram of the Vroqn learning core: seven learning nodes connected to a central core that measures your progress."
    >
      {/* Ambient wash behind the dial — one paint, no animation, cheap on mobile. */}
      <div
        aria-hidden="true"
        className="absolute left-1/2 top-1/2 h-[78%] w-[78%] -translate-x-1/2 -translate-y-1/2 rounded-full bg-[radial-gradient(circle,rgba(0,229,255,0.16),rgba(0,229,255,0.05)_45%,transparent_70%)]"
      />

      <svg viewBox={`0 0 ${SIZE} ${SIZE}`} className="relative h-full w-full" aria-hidden="true" focusable="false">
        <defs>
          <linearGradient id="core-ring" x1="0" y1="0" x2="1" y2="1">
            <stop offset="0%" stopColor="#00E5FF" stopOpacity="0.55" />
            <stop offset="100%" stopColor="#22D3EE" stopOpacity="0.14" />
          </linearGradient>
          <linearGradient id="core-body" x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stopColor="#12363f" />
            <stop offset="100%" stopColor="#08151b" />
          </linearGradient>
          <linearGradient id="core-arc" x1="0" y1="1" x2="1" y2="0">
            <stop offset="0%" stopColor="#00E5FF" stopOpacity="0.25" />
            <stop offset="55%" stopColor="#00E5FF" />
            <stop offset="100%" stopColor="#7DF9FF" />
          </linearGradient>
          <radialGradient id="core-inner-glow">
            <stop offset="0%" stopColor="#00E5FF" stopOpacity="0.34" />
            <stop offset="100%" stopColor="#00E5FF" stopOpacity="0" />
          </radialGradient>
        </defs>

        {/* ------------------------------------------------ progress arc */}
        <g>
          <circle
            cx={CENTRE}
            cy={CENTRE}
            r={arcRadius}
            fill="none"
            stroke="#1C2A33"
            strokeWidth="2.5"
            strokeLinecap="round"
          />
          <circle
            cx={CENTRE}
            cy={CENTRE}
            r={arcRadius}
            fill="none"
            stroke="url(#core-arc)"
            strokeWidth="2.5"
            strokeLinecap="round"
            transform={`rotate(-90 ${CENTRE} ${CENTRE})`}
            strokeDasharray={arcLength}
            style={
              {
                '--arc-length': `${arcLength}`,
                '--arc-rest': `${arcRest}`,
                strokeDashoffset: arcRest,
                animation: tier === 'static' ? 'none' : 'progress-arc 1.8s cubic-bezier(0.22, 0.61, 0.36, 1) both',
              } as React.CSSProperties
            }
          />
        </g>

        {/* ------------------------------------- rotating mechanical dials */}
        {/* These two carry the movement. Each is one composited transform. */}
        <g className="core-orbit-slow">
          {ticks.map((tick) => (
            <line
              key={tick.key}
              x1={tick.x1}
              y1={tick.y1}
              x2={tick.x2}
              y2={tick.y2}
              stroke="#00E5FF"
              strokeOpacity={tick.major ? 0.42 : 0.18}
              strokeWidth={tick.major ? 2 : 1.2}
              strokeLinecap="round"
            />
          ))}
        </g>

        <g className="core-orbit-mid" opacity="0.5">
          <circle cx={CENTRE} cy={CENTRE} r="152" fill="none" stroke="url(#core-ring)" strokeWidth="1.4" />
          <circle
            cx={CENTRE}
            cy={CENTRE}
            r="152"
            fill="none"
            stroke="#00E5FF"
            strokeOpacity="0.34"
            strokeWidth="6"
            strokeLinecap="round"
            strokeDasharray="2 26"
          />
        </g>

        <g className="core-orbit-fast" opacity="0.7">
          <circle cx={CENTRE} cy={CENTRE} r="96" fill="none" stroke="#22D3EE" strokeOpacity="0.16" strokeWidth="1" />
          <circle
            cx={CENTRE}
            cy={CENTRE}
            r="96"
            fill="none"
            stroke="#22D3EE"
            strokeOpacity="0.34"
            strokeWidth="1.6"
            strokeLinecap="round"
            strokeDasharray="34 84"
          />
        </g>

        {/* ---------------------------------- connections + travelling particles */}
        <g>
          {nodes.map((node) => (
            <path
              key={`line-${node.index}`}
              d={node.path}
              fill="none"
              stroke="#00E5FF"
              strokeOpacity="0.16"
              strokeWidth="1.4"
            />
          ))}
          {/*
            Round dashes read as discrete particles travelling inward toward the core. Only the `full`
            tier gets them: seven extra animated strokes is the one part of this graphic that is worth
            dropping on weak hardware, and the lines above already carry the meaning without them.
          */}
          {tier === 'full' &&
            nodes.map((node) => (
              <path
                key={`flow-${node.index}`}
                d={node.path}
                fill="none"
                stroke="#7DF9FF"
                strokeOpacity="0.85"
                strokeWidth="2.4"
                strokeLinecap="round"
                strokeDasharray="0.1 21.9"
                className="core-flow"
                style={{ animationDelay: `${node.index * 0.42}s` }}
              />
            ))}
        </g>

        {/* ------------------------------------------------------- the nodes */}
        {nodes.map((node) => (
          <g
            key={`node-${node.index}`}
            className="core-node"
            style={{ animationDelay: `${node.index * 0.34}s` }}
          >
            <circle cx={node.halo.x} cy={node.halo.y} r="11" fill="#00E5FF" fillOpacity="0.07" />
            <circle
              cx={node.point.x}
              cy={node.point.y}
              r="5"
              fill="#05070A"
              stroke="#00E5FF"
              strokeOpacity="0.75"
              strokeWidth="1.6"
            />
            <circle cx={node.point.x} cy={node.point.y} r="1.9" fill="#7DF9FF" />
          </g>
        ))}

        {/* ------------------------------------------------------- the core */}
        <g className="core-breathe">
          <circle cx={CENTRE} cy={CENTRE} r="74" fill="url(#core-inner-glow)" className="core-halo" />
          <circle cx={CENTRE} cy={CENTRE} r="52" fill="url(#core-body)" stroke="#00E5FF" strokeOpacity="0.42" strokeWidth="1.6" />
          <circle cx={CENTRE} cy={CENTRE} r="52" fill="none" stroke="#7DF9FF" strokeOpacity="0.22" strokeWidth="4" />

          {/* The Vroqn mark, drawn without its tile so it sits inside the core housing. */}
          <g
            stroke="url(#core-arc)"
            strokeWidth="2.6"
            strokeLinecap="round"
            fill="none"
            transform={`translate(${CENTRE - 32} ${CENTRE - 32}) scale(1)`}
          >
            <path d="M20 16c0-4.2 3-7.4 7-7.4s7 3.2 7 7.4v32c0 4.2-3 7.4-7 7.4s-7-3.2-7-7.4z" />
            <path d="M34 23c0-3.2 2.6-5.8 5.8-5.8s5.8 2.6 5.8 5.8v18c0 3.2-2.6 5.8-5.8 5.8S34 44.2 34 41z" />
            <path d="M27 25h-4.5M27 39h-4.5" />
          </g>
          <circle cx={CENTRE + 8} cy={CENTRE} r="2.6" fill="#22D3EE" />
        </g>
      </svg>
    </div>
  );
}

export default KnowledgeCore;
