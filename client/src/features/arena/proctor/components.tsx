/**
 * Integrity UI for Arena papers: the pre-exam checklist, the in-paper status bar, the "come back"
 * overlay, the student's own record after submitting, and the host's overview.
 *
 * Tone matters here. A student about to sit a timed paper is already anxious; a screen full of red
 * warnings makes them worse at the thing being measured. So the checklist explains what is checked and
 * why, the in-paper bar stays quiet, and the record afterwards is factual rather than accusatory —
 * "you left the paper twice" is a statement, not a verdict.
 */
import { useEffect, useState } from 'react';
import { Activity, AlertTriangle, CheckCircle2, Eye, Info, Laptop, Maximize2, ShieldCheck, Wifi, WifiOff } from 'lucide-react';
import { Badge, Button, Card, ErrorState, LoadingState, ProgressBar } from '../../../components/ui';
import { api } from '../../../lib/api';

export interface IntegrityReport {
  attemptId: string;
  competitionId: string;
  focusLostCount: number;
  focusLostMs: number;
  fullscreenExits: number;
  copyAttempts: number;
  pasteAttempts: number;
  menuAttempts: number;
  keyBlocks: number;
  resizeCount: number;
  extendedDisplay: boolean;
  resumeCount: number;
  totalEvents: number;
  riskScore: number;
  riskLevel: 'clean' | 'minor' | 'notable' | 'high';
  headline: string;
  updatedAt: string;
}

export interface HostIntegrityRow extends IntegrityReport {
  userId: string;
  name: string;
  submitted: boolean;
  submittedAt: string | null;
}

const LEVEL_TONE: Record<IntegrityReport['riskLevel'], 'success' | 'warning' | 'error' | 'muted'> = {
  clean: 'success',
  minor: 'muted',
  notable: 'warning',
  high: 'error',
};

/* ------------------------------------------------------------------ pre-exam checklist ---------- */

export interface PreflightResult {
  browserOk: boolean;
  visibilityApi: boolean;
  fullscreenAvailable: boolean;
  singleDisplay: boolean;
  online: boolean;
  screen: string;
  memory: string | null;
  notes: string[];
}

/**
 * Checks the things that actually break a paper, before it starts — rather than letting a student
 * discover halfway through that their browser cannot go full-screen.
 */
export function runPreflight(): PreflightResult {
  const notes: string[] = [];
  const screenInfo = window.screen as Screen & { isExtended?: boolean };
  const nav = navigator as Navigator & { deviceMemory?: number };
  const singleDisplay = !screenInfo.isExtended;
  if (!singleDisplay) {
    notes.push('More than one display is connected. Disconnect the second screen, or the paper will record that it was present.');
  }
  const fullscreenAvailable = typeof document.documentElement.requestFullscreen === 'function';
  if (!fullscreenAvailable) {
    notes.push('Your browser cannot open papers in full-screen. You can still take the paper; it will run without full-screen enforcement.');
  }
  const visibilityApi = typeof document.visibilityState === 'string' && 'hidden' in document;
  if (!visibilityApi) {
    notes.push('Your browser does not report tab changes, so those cannot be recorded for you.');
  }
  const online = navigator.onLine !== false;
  if (!online) notes.push('You appear to be offline. Reconnect before starting — answers save to the server as you go.');
  if (window.innerWidth < 360) notes.push('This screen is very narrow. Rotate to landscape if answer options are hard to read.');

  return {
    browserOk: true,
    visibilityApi,
    fullscreenAvailable,
    singleDisplay,
    online,
    screen: `${window.screen.width}×${window.screen.height}`,
    memory: nav.deviceMemory ? `${nav.deviceMemory} GB` : null,
    notes,
  };
}

export function IntegrityNotice({
  title,
  rules,
  instructions,
  requireFullscreen,
  onStart,
  starting,
  startLabel = 'Start the paper',
}: {
  title: string;
  rules: string[];
  instructions: string[];
  requireFullscreen: boolean;
  onStart: () => void;
  starting: boolean;
  startLabel?: string;
}) {
  const [preflight, setPreflight] = useState<PreflightResult | null>(null);
  const [accepted, setAccepted] = useState(false);

  useEffect(() => {
    setPreflight(runPreflight());
  }, []);

  const checks = preflight
    ? [
        { label: 'Answers save to the server as you go', ok: true, icon: <CheckCircle2 size={13} /> },
        { label: 'The clock is the server’s, so nothing on this device can extend it', ok: true, icon: <CheckCircle2 size={13} /> },
        { label: 'Tab changes and full-screen exits are recorded', ok: preflight.visibilityApi, icon: <Eye size={13} /> },
        { label: 'One display only', ok: preflight.singleDisplay, icon: <Laptop size={13} /> },
        { label: 'Connected to the internet', ok: preflight.online, icon: preflight.online ? <Wifi size={13} /> : <WifiOff size={13} /> },
      ]
    : [];

  return (
    <Card className="mx-auto max-w-2xl space-y-4 p-5">
      <div className="flex items-start gap-3">
        <ShieldCheck size={20} className="mt-0.5 shrink-0 text-[var(--color-primary)]" />
        <div className="min-w-0">
          <h2 className="text-[16px] font-semibold text-[var(--color-text)]">Before you begin: {title}</h2>
          <p className="mt-1 text-[12.5px] leading-relaxed text-[var(--color-muted)]">
            This is an independent, Vroqn-created competitive paper — not an official JEE, NEET or board examination. To keep the
            result meaningful for everyone taking it, the paper runs in integrity mode.
          </p>
        </div>
      </div>

      {preflight ? (
        <ul className="space-y-1.5">
          {checks.map((check) => (
            <li key={check.label} className="flex items-center gap-2 text-[12.5px]">
              <span className={check.ok ? 'text-[var(--color-success)]' : 'text-[var(--color-warning)]'}>{check.icon}</span>
              <span className={check.ok ? 'text-[var(--color-text)]' : 'text-[var(--color-warning)]'}>{check.label}</span>
            </li>
          ))}
          <li className="flex items-center gap-2 text-[12.5px] text-[var(--color-muted)]">
            <Laptop size={13} /> {preflight.screen}
            {preflight.memory ? ` · ${preflight.memory} memory` : ''}
          </li>
        </ul>
      ) : null}

      {preflight?.notes.length ? (
        <ul className="space-y-1 rounded-xl border border-[var(--color-warning)]/30 bg-[var(--color-warning)]/[0.05] p-3">
          {preflight.notes.map((note) => (
            <li key={note} className="flex items-start gap-2 text-[12px] text-[var(--color-muted)]">
              <AlertTriangle size={13} className="mt-0.5 shrink-0 text-[var(--color-warning)]" />
              {note}
            </li>
          ))}
        </ul>
      ) : null}

      {rules.length ? (
        <div>
          <h3 className="text-[12.5px] font-medium text-[var(--color-text)]">Rules for this paper</h3>
          <ul className="mt-1 space-y-1">
            {rules.map((rule) => (
              <li key={rule} className="flex items-start gap-2 text-[12.5px] text-[var(--color-muted)]">
                <span aria-hidden="true" className="mt-1.5 h-1 w-1 shrink-0 rounded-full bg-[var(--color-muted-dim)]" />
                {rule}
              </li>
            ))}
          </ul>
        </div>
      ) : null}

      {instructions.length ? (
        <div>
          <h3 className="text-[12.5px] font-medium text-[var(--color-text)]">How it works</h3>
          <ul className="mt-1 space-y-1">
            {instructions.map((line) => (
              <li key={line} className="flex items-start gap-2 text-[12.5px] text-[var(--color-muted)]">
                <span aria-hidden="true" className="mt-1.5 h-1 w-1 shrink-0 rounded-full bg-[var(--color-muted-dim)]" />
                {line}
              </li>
            ))}
          </ul>
        </div>
      ) : null}

      <label className="flex items-start gap-3 rounded-xl border border-[var(--color-border)] p-3 text-[12.5px] text-[var(--color-text)]">
        <input
          type="checkbox"
          checked={accepted}
          onChange={(event) => setAccepted(event.target.checked)}
          className="mt-0.5 h-4 w-4 accent-[var(--color-primary)]"
        />
        <span>
          I understand that this paper is not an official examination, that my attempt is timed by the server, and that leaving the
          paper or its full-screen mode will be recorded and shown to the host.
        </span>
      </label>

      <div className="flex flex-wrap items-center gap-2">
        <Button
          variant="primary"
          loading={starting}
          disabled={!accepted}
          icon={requireFullscreen ? <Maximize2 size={15} /> : undefined}
          onClick={onStart}
        >
          {startLabel}
        </Button>
        <span className="text-[11.5px] text-[var(--color-muted-dim)]">
          {requireFullscreen ? 'The paper opens in full-screen.' : 'Full-screen is optional for this paper.'}
        </span>
      </div>

      <p className="flex items-start gap-2 text-[11.5px] leading-relaxed text-[var(--color-muted-dim)]">
        <Info size={12} className="mt-0.5 shrink-0" />
        Software cannot see a second device, a printed sheet or someone else in the room, and Vroqn does not claim otherwise. What
        it can do is keep the clock, the paper and the marking on the server, and record what happened in the browser so a host can
        review a suspicious result.
      </p>
    </Card>
  );
}

/* ------------------------------------------------------------------ in-paper status ------------- */

export function ProctorBar({
  warnings,
  pending,
  offline,
  away,
  fullscreenLost,
  requireFullscreen,
  onReenterFullscreen,
}: {
  warnings: number;
  pending: number;
  offline: boolean;
  away: boolean;
  fullscreenLost: boolean;
  requireFullscreen: boolean;
  onReenterFullscreen: () => void;
}) {
  const calm = warnings === 0 && !offline && !away;
  return (
    <div
      role="status"
      aria-live="polite"
      className={[
        'flex flex-wrap items-center gap-x-3 gap-y-1.5 rounded-xl border px-3 py-2 text-[11.5px]',
        calm
          ? 'border-[var(--color-border)] bg-[var(--color-card)] text-[var(--color-muted)]'
          : 'border-[var(--color-warning)]/35 bg-[var(--color-warning)]/[0.06] text-[var(--color-warning)]',
      ].join(' ')}
    >
      <span className="inline-flex items-center gap-1.5 font-medium">
        <ShieldCheck size={13} /> Integrity mode on
      </span>
      <span className="text-[var(--color-muted-dim)]">
        {warnings === 0 ? 'nothing recorded' : `${warnings} recorded ${warnings === 1 ? 'event' : 'events'}`}
      </span>
      {pending > 0 ? <span className="text-[var(--color-muted-dim)]">syncing…</span> : null}
      {offline ? (
        <span className="inline-flex items-center gap-1.5">
          <WifiOff size={12} /> offline — answers will save when you reconnect
        </span>
      ) : null}
      {away ? <span>the paper is not in front</span> : null}
      {requireFullscreen && fullscreenLost ? (
        <Button size="sm" variant="ghost" onClick={onReenterFullscreen}>
          Return to full-screen
        </Button>
      ) : null}
    </div>
  );
}

/**
 * Shown when focus comes back after being away. It is deliberately one short sentence: the student
 * already knows they left, and a lecture does not improve the paper.
 */
export function AwayNotice({ visible, notice }: { visible: boolean; notice: string | null }) {
  if (!visible) return null;
  return (
    <div className="pointer-events-none fixed inset-x-3 bottom-20 z-40 sm:bottom-6 sm:left-auto sm:right-6 sm:w-96" role="status" aria-live="polite">
      <Card className="pointer-events-auto flex items-start gap-3 border-[var(--color-warning)]/40 p-3.5 shadow-xl">
        <AlertTriangle size={16} className="mt-0.5 shrink-0 text-[var(--color-warning)]" />
        <div className="min-w-0 text-[12.5px]">
          <p className="font-medium text-[var(--color-text)]">The paper was in the background</p>
          <p className="mt-0.5 text-[var(--color-muted)]">
            {notice ?? 'That is recorded, and the clock kept running. Stay on this screen until you submit.'}
          </p>
        </div>
      </Card>
    </div>
  );
}

/* ------------------------------------------------------------------ student's own record ------- */

export function IntegrityPanel({
  scope,
  refId,
}: {
  /** `arena` for a competition attempt, `exam` for a personal mock exam. */
  scope: 'arena' | 'exam';
  refId: string;
}) {
  const [report, setReport] = useState<IntegrityReport | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let mounted = true;
    void (async () => {
      try {
        const path = scope === 'arena' ? `/arena/results/${refId}/integrity` : `/exams/${refId}/integrity`;
        const payload = await api.get<{ report: IntegrityReport }>(path);
        if (mounted) setReport(payload.report);
      } catch (err) {
        if (mounted) setError((err as Error)?.message ?? 'Could not load the integrity record.');
      } finally {
        if (mounted) setLoading(false);
      }
    })();
    return () => {
      mounted = false;
    };
  }, [scope, refId]);

  if (loading) return <LoadingState message="Loading your integrity record…" className="py-8" />;
  if (error) return <ErrorState title="Integrity record unavailable" message={error} />;
  if (!report) return null;

  const rows = [
    { label: 'Times the paper lost focus', value: report.focusLostCount },
    { label: 'Full-screen exits', value: report.fullscreenExits },
    { label: 'Copy attempts', value: report.copyAttempts },
    { label: 'Paste attempts', value: report.pasteAttempts },
    { label: 'Times reopened', value: Math.max(0, report.resumeCount - 1) },
  ];

  return (
    <Card className="space-y-3 p-4">
      <div className="flex flex-wrap items-center gap-2">
        <h2 className="inline-flex items-center gap-2 text-[14px] font-semibold text-[var(--color-text)]">
          <ShieldCheck size={15} className="text-[var(--color-primary)]" /> Integrity record
        </h2>
        <Badge tone={LEVEL_TONE[report.riskLevel]}>{report.riskLevel}</Badge>
        {report.extendedDisplay ? <Badge tone="warning">Second display detected</Badge> : null}
      </div>

      <p className="text-[12.5px] leading-relaxed text-[var(--color-muted)]">{report.headline}</p>

      <ul className="grid gap-1.5 sm:grid-cols-2">
        {rows.map((row) => (
          <li key={row.label} className="flex items-center justify-between gap-3 rounded-lg border border-[var(--color-border)] px-3 py-1.5 text-[12.5px]">
            <span className="text-[var(--color-muted)]">{row.label}</span>
            <span className="font-medium text-[var(--color-text)]">{row.value}</span>
          </li>
        ))}
      </ul>

      {report.focusLostMs > 0 ? (
        <div>
          <div className="flex items-center justify-between text-[11.5px] text-[var(--color-muted)]">
            <span>Time away from the paper</span>
            <span>{Math.round(report.focusLostMs / 1000)}s</span>
          </div>
          <ProgressBar value={Math.min(1, report.focusLostMs / 600_000)} className="mt-1" label="Time away from the paper" />
        </div>
      ) : null}

      <p className="text-[11.5px] leading-relaxed text-[var(--color-muted-dim)]">
        This is the same record the host can see. It is evidence, not a verdict: losing focus because the electricity went, or
        because someone called you, is not cheating, and no result is changed automatically because of it. Your timing, answers and
        score were decided by the server throughout.
      </p>
    </Card>
  );
}

/* ------------------------------------------------------------------ host overview ---------------- */

export function HostIntegrityList({ competitionId }: { competitionId: string }) {
  const [rows, setRows] = useState<HostIntegrityRow[] | null>(null);
  const [flagged, setFlagged] = useState(0);
  const [policy, setPolicy] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let mounted = true;
    void (async () => {
      try {
        const payload = await api.get<{ rows: HostIntegrityRow[]; flagged: number; policy: string }>(
          `/arena/competitions/${competitionId}/integrity`,
        );
        if (mounted) {
          setRows(payload.rows);
          setFlagged(payload.flagged);
          setPolicy(payload.policy);
        }
      } catch (err) {
        if (mounted) setError((err as Error)?.message ?? 'Could not load the integrity overview.');
      } finally {
        if (mounted) setLoading(false);
      }
    })();
    return () => {
      mounted = false;
    };
  }, [competitionId]);

  if (loading) return <LoadingState message="Loading integrity overview…" className="py-8" />;
  if (error) return <ErrorState title="Integrity overview unavailable" message={error} />;
  if (!rows?.length) {
    return (
      <Card className="p-4 text-[12.5px] text-[var(--color-muted)]">
        Nobody has entered this paper yet, so there is nothing to review.
      </Card>
    );
  }

  return (
    <Card className="space-y-3 p-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h2 className="inline-flex items-center gap-2 text-[14px] font-semibold text-[var(--color-text)]">
          <Activity size={15} className="text-[var(--color-primary)]" /> Exam integrity
        </h2>
        <div className="flex items-center gap-2">
          <Badge tone={flagged > 0 ? 'warning' : 'success'}>
            {flagged > 0 ? `${flagged} to review` : 'nothing flagged'}
          </Badge>
          <span className="text-[11.5px] text-[var(--color-muted-dim)]">{rows.length} attempts</span>
        </div>
      </div>

      <p className="text-[12px] text-[var(--color-muted)]">{policy}</p>

      <div className="overflow-x-auto">
        <table className="w-full min-w-[560px] text-left text-[12px]">
          <caption className="sr-only">Integrity signals recorded for each attempt</caption>
          <thead className="text-[11px] uppercase tracking-wide text-[var(--color-muted-dim)]">
            <tr>
              <th scope="col" className="py-1.5 pr-3">
                Student
              </th>
              <th scope="col" className="py-1.5 pr-3">
                Level
              </th>
              <th scope="col" className="py-1.5 pr-3">
                Away
              </th>
              <th scope="col" className="py-1.5 pr-3">
                Full-screen exits
              </th>
              <th scope="col" className="py-1.5 pr-3">
                Copy/paste
              </th>
              <th scope="col" className="py-1.5">
                Submitted
              </th>
            </tr>
          </thead>
          <tbody>
            {rows.map((row) => (
              <tr key={row.userId} className="border-t border-[var(--color-border)]">
                <td className="py-2 pr-3 text-[var(--color-text)]">{row.name}</td>
                <td className="py-2 pr-3">
                  <Badge tone={LEVEL_TONE[row.riskLevel]}>{row.riskLevel}</Badge>
                </td>
                <td className="py-2 pr-3 text-[var(--color-muted)]">
                  {row.focusLostCount}× · {Math.round(row.focusLostMs / 1000)}s
                </td>
                <td className="py-2 pr-3 text-[var(--color-muted)]">{row.fullscreenExits}</td>
                <td className="py-2 pr-3 text-[var(--color-muted)]">
                  {row.copyAttempts}/{row.pasteAttempts}
                </td>
                <td className="py-2 text-[var(--color-muted)]">
                  {row.submitted ? (row.submittedAt ? new Date(row.submittedAt).toLocaleString() : 'yes') : 'in progress'}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <p className="text-[11.5px] text-[var(--color-muted-dim)]">
        Use this as a starting point, not as a score. A high count usually means a distracted student or a flaky device; talk to
        them before drawing a conclusion, and remember that nothing here changes anyone's marks by itself.
      </p>
    </Card>
  );
}
