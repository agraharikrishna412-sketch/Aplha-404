/**
 * Delete my account.
 *
 * The rule this screen follows: nobody should be able to destroy an account without understanding
 * exactly what disappears. So it says it in the student's own numbers — how many notes, chats,
 * answers and messages go — lists any community that would block the deletion (with a link straight
 * to it), and then asks for two independent confirmations: the account password, and the word DELETE
 * typed by hand.
 *
 * The preview comes from the server (`GET /api/auth/deletion-preview`), which counts with the exact
 * same predicates the deletion uses. It re-checks everything again server-side, so this screen can be
 * informative but can never be the thing that decides.
 */
import { useCallback, useEffect, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { AlertTriangle, ShieldAlert, Trash2 } from 'lucide-react';
import { Badge, Button, Modal, TextInput } from '../../components/ui';
import { api, ApiError } from '../../lib/api';
import { useAuth } from '../../hooks/useAuth';
import { useToast } from '../../hooks/useToast';

interface DeletionPreview {
  blocking: { id: string; name: string; slug: string; otherMembers: number }[];
  solo: { id: string; name: string; slug: string; otherMembers: number }[];
  counts: { label: string; rows: number }[];
  total: number;
}

/** The labels come from the server; these are the ones worth naming on screen, in student language. */
const HEADLINE: { match: RegExp; text: string }[] = [
  { match: /^notes$/, text: 'notes' },
  { match: /^ai chats$/, text: 'AI conversations' },
  { match: /^ai conversations$/, text: 'AI messages' },
  { match: /^practice sets$/, text: 'practice sets' },
  { match: /^practice attempts$/, text: 'practice answers' },
  { match: /^mock exams$/, text: 'mock exams' },
  { match: /^mock exam results$/, text: 'exam results' },
  { match: /^arena (attempts|registrations|results)$/, text: 'Arena entries' },
  { match: /^code sessions$/, text: 'Code Lab sessions' },
  { match: /^learning activity$|^activity$/, text: 'activity records' },
  { match: /^community messages$/, text: 'community messages' },
  { match: /^dm messages$|^dm messages in own conversations$/, text: 'private messages' },
  { match: /^uploads$/, text: 'uploaded files' },
];

export function DeleteAccountCard() {
  const { user, reload } = useAuth();
  const { push } = useToast();
  const navigate = useNavigate();
  const [preview, setPreview] = useState<DeletionPreview | null>(null);
  const [open, setOpen] = useState(false);
  const [password, setPassword] = useState('');
  const [confirmText, setConfirmText] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const loadPreview = useCallback(() => {
    void api
      .get<DeletionPreview>('/auth/deletion-preview')
      .then(setPreview)
      .catch(() => setPreview(null));
  }, []);

  useEffect(loadPreview, [loadPreview]);

  /** Only the interesting line items, so the screen is a summary rather than a database dump. */
  const headline = (() => {
    if (!preview) return [];
    const parts: { text: string; rows: number }[] = [];
    for (const rule of HEADLINE) {
      const rows = preview.counts.filter((entry) => rule.match.test(entry.label)).reduce((sum, entry) => sum + entry.rows, 0);
      if (rows > 0 && !parts.some((part) => part.text === rule.text)) parts.push({ text: rule.text, rows });
    }
    return parts;
  })();

  const blocked = (preview?.blocking.length ?? 0) > 0;
  const ready = password.length > 0 && confirmText === 'DELETE' && !blocked;

  const destroy = async () => {
    setBusy(true);
    setError(null);
    try {
      await api.post('/auth/delete-account', { password, confirm: confirmText });
      /* The session cookie is cleared by the response; refresh so the app returns to the front door. */
      await reload();
      push({ tone: 'success', title: 'Your account has been deleted', detail: 'Everything listed on this screen is gone for good.' });
      navigate('/');
    } catch (err) {
      const message = err instanceof ApiError ? err.message : 'Could not delete your account.';
      setError(message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="rounded-[var(--radius-card)] border border-[var(--color-error)]/35 bg-[var(--color-error)]/[0.04] p-4">
      <div className="flex items-start gap-3">
        <span className="grid h-9 w-9 shrink-0 place-items-center rounded-[10px] border border-[var(--color-error)]/40 bg-[var(--color-error)]/10 text-[#fca5a5]">
          <ShieldAlert size={16} />
        </span>
        <div className="min-w-0 flex-1">
          <p className="text-[13.5px] font-semibold">Delete my account</p>
          <p className="mt-0.5 text-[12.5px] leading-relaxed text-[var(--color-muted)]">
            This removes your account and everything in it: notes, AI conversations, practice, mock exams, Arena entries, Code Lab sessions,
            your community posts and your private messages. Private chats are deleted for the other person too. It cannot be undone.
          </p>

          {headline.length ? (
            <p className="mt-2 text-[12px] text-[var(--color-muted-dim)]">
              Right now that is{' '}
              {headline.map((part, index) => (
                <span key={part.text}>
                  {index > 0 ? (index === headline.length - 1 ? ' and ' : ', ') : ''}
                  <span className="text-[var(--color-text)]">
                    {part.rows} {part.text}
                  </span>
                </span>
              ))}
              .
            </p>
          ) : null}

          {preview?.solo.length ? (
            <p className="mt-2 text-[12px] text-[var(--color-muted-dim)]">
              {preview.solo.length === 1 ? 'One community is' : `${preview.solo.length} communities are`} yours alone and will be deleted with you:{' '}
              {preview.solo.map((community) => community.name).join(', ')}.
            </p>
          ) : null}

          {blocked ? (
            <div className="mt-2.5 rounded-[10px] border border-[var(--color-warning)]/40 bg-[var(--color-warning)]/10 p-3">
              <p className="flex items-start gap-2 text-[12.5px] leading-relaxed text-[#fcd28b]">
                <AlertTriangle size={14} className="mt-0.5 shrink-0" />
                <span>
                  You cannot delete your account while you own {preview!.blocking.length === 1 ? 'a community' : 'communities'} other students are
                  still in. Hand ownership over or delete {preview!.blocking.length === 1 ? 'it' : 'them'} first — nobody else should lose their
                  group because one person left.
                </span>
              </p>
              <ul className="mt-2 space-y-1.5">
                {preview!.blocking.map((community) => (
                  <li key={community.id}>
                    <Link
                      to={`/communities/${community.slug}?tab=manage`}
                      className="vroqn-tap inline-flex items-center gap-2 rounded-md border border-[var(--color-border)] bg-[var(--color-surface)] px-2.5 py-1.5 text-[12.5px] hover:border-[var(--color-primary)]/50"
                    >
                      {community.name}
                      <Badge tone="muted">{community.otherMembers} other member{community.otherMembers === 1 ? '' : 's'}</Badge>
                    </Link>
                  </li>
                ))}
              </ul>
            </div>
          ) : (
            <Button
              variant="danger"
              className="mt-3"
              icon={<Trash2 size={14} />}
              onClick={() => {
                setOpen(true);
                setError(null);
                loadPreview();
              }}
            >
              Delete my account
            </Button>
          )}
        </div>
      </div>

      <Modal
        open={open}
        onClose={() => (busy ? undefined : setOpen(false))}
        title="Delete your account?"
        description="Two things are required, because this cannot be undone."
        footer={
          <div className="flex flex-wrap items-center justify-end gap-2">
            <Button variant="ghost" onClick={() => setOpen(false)} disabled={busy}>
              Cancel
            </Button>
            <Button variant="danger" icon={<Trash2 size={14} />} loading={busy} disabled={!ready} onClick={() => void destroy()}>
              Delete permanently
            </Button>
          </div>
        }
      >
        <div className="space-y-3 p-4 text-[12.5px]">
          <div className="rounded-[10px] border border-[var(--color-border)] bg-[var(--color-surface)] p-3">
            <p className="font-medium text-[var(--color-text)]">This deletes {user?.email} and everything in it</p>
            <p className="mt-1 leading-relaxed text-[var(--color-muted)]">
              {preview ? `${preview.total} row(s) of your data` : 'Your data'} — notes, AI conversations, practice, mock exams, Arena entries, Code
              Lab sessions, community posts and private messages. Private chats are deleted for the other person as well.
            </p>
          </div>

          <label className="block">
            <span className="mb-1 block font-medium">
              Your password <span className="text-[var(--color-muted-dim)]">— proves it is really you</span>
            </span>
            <TextInput
              type="password"
              value={password}
              autoComplete="current-password"
              onChange={(event) => setPassword(event.target.value)}
              placeholder="Account password"
            />
          </label>

          <label className="block">
            <span className="mb-1 block font-medium">
              Type <span className="font-mono text-[var(--color-error)]">DELETE</span> to confirm
            </span>
            <TextInput value={confirmText} onChange={(event) => setConfirmText(event.target.value)} placeholder="DELETE" aria-label="Type DELETE to confirm" />
          </label>

          {error ? (
            <p className="rounded-[10px] border border-[var(--color-error)]/40 bg-[var(--color-error)]/10 p-2.5 text-[#fca5a5]" role="alert">
              {error}
            </p>
          ) : null}
        </div>
      </Modal>
    </div>
  );
}
