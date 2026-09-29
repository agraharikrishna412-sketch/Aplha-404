/**
 * Notes (spec §17).
 * Create · upload (image / PDF / text) · AI clean-up · structured sections · ask-about-notes.
 * The upload path is the important one: messy handwriting in, exam-ready structure out.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import {
  BookOpen,
  Camera,
  FileText,
  ListChecks,
  NotebookPen,
  Pencil,
  Plus,
  Search,
  Sparkles,
  Star,
  Trash2,
  Upload,
  Wand2,
} from 'lucide-react';
import { PageBody, PageHeader } from '../../components/AppShell';
import {
  Badge,
  Button,
  Card,
  CardHeader,
  EmptyState,
  ErrorState,
  Field,
  LoadingState,
  Modal,
  SampleNotice,
  Segmented,
  Spinner,
  TextArea,
  TextInput,
} from '../../components/ui';
import { Markdown } from '../../components/Markdown';
import { api, ApiError } from '../../lib/api';
import { timeAgo } from '../../lib/format';
import { useSettings } from '../../hooks/useSettings';
import { useToast } from '../../hooks/useToast';
import { useConfirm } from '../../components/Confirm';
import type { Note } from '../../types';
import { VroqnFilterSelect } from '../../components/vroqn';

type AskMode = 'summary' | 'keypoints' | 'definitions' | 'questions' | 'explain';

const ASK_MODES: { value: AskMode; label: string }[] = [
  { value: 'summary', label: 'Summary' },
  { value: 'keypoints', label: 'Key points' },
  { value: 'definitions', label: 'Definitions' },
  { value: 'questions', label: 'Questions' },
  { value: 'explain', label: 'Explain hardest idea' },
];

export function NotesPage() {
  const { noteId } = useParams<{ noteId?: string }>();
  const navigate = useNavigate();
  const { push } = useToast();
  const confirm = useConfirm();
  const { hasConnectedKey } = useSettings();

  const [notes, setNotes] = useState<Note[]>([]);
  const [subjects, setSubjects] = useState<string[]>([]);
  const [canReadImages, setCanReadImages] = useState(true);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [search, setSearch] = useState('');
  const [subjectFilter, setSubjectFilter] = useState('');

  const [active, setActive] = useState<Note | null>(null);
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState({ title: '', content: '', subject: '', chapter: '' });
  const [saving, setSaving] = useState(false);

  const [uploadOpen, setUploadOpen] = useState(false);
  const [uploadBusy, setUploadBusy] = useState(false);
  const [uploadMessage, setUploadMessage] = useState<string | null>(null);
  const [uploadError, setUploadError] = useState<string | null>(null);
  const [pasteText, setPasteText] = useState('');
  const [uploadSubject, setUploadSubject] = useState('Physics');
  const fileRef = useRef<HTMLInputElement | null>(null);

  const [askMode, setAskMode] = useState<AskMode>('summary');
  const [askAnswer, setAskAnswer] = useState<string | null>(null);
  const [askBusy, setAskBusy] = useState(false);
  const [askDegraded, setAskDegraded] = useState<string | null>(null);

  const load = useCallback(
    async (options: { keepSelection?: boolean } = {}) => {
      setLoading(true);
      setError(null);
      try {
        const params = new URLSearchParams();
        if (search.trim()) params.set('search', search.trim());
        if (subjectFilter) params.set('subject', subjectFilter);
        const result = await api.get<{ notes: Note[]; subjects: string[]; canReadImages: boolean }>(
          `/notes${params.toString() ? `?${params.toString()}` : ''}`,
        );
        setNotes(result.notes);
        setSubjects(result.subjects);
        setCanReadImages(result.canReadImages);
        if (!options.keepSelection && noteId) {
          const found = result.notes.find((note) => note.id === noteId);
          if (found) setActive(found);
        }
      } catch (err) {
        setError(err instanceof ApiError ? err.message : 'Could not load your notes.');
      } finally {
        setLoading(false);
      }
    },
    [noteId, search, subjectFilter],
  );

  useEffect(() => {
    const timer = window.setTimeout(() => void load(), search ? 320 : 0);
    return () => window.clearTimeout(timer);
  }, [load, search]);

  useEffect(() => {
    if (noteId) {
      const existing = notes.find((note) => note.id === noteId);
      if (existing) {
        setActive(existing);
        return;
      }
      api
        .get<{ note: Note }>(`/notes/${noteId}`)
        .then((result) => setActive(result.note))
        .catch(() => undefined);
    } else {
      setActive(null);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [noteId]);

  useEffect(() => {
    if (active) {
      setDraft({
        title: active.title,
        content: active.content,
        subject: active.subject ?? '',
        chapter: active.chapter ?? '',
      });
      setAskAnswer(null);
      setAskDegraded(null);
    }
  }, [active]);

  /* --------------------------------- actions -------------------------------- */

  const createBlank = async () => {
    try {
      const result = await api.post<{ note: Note }>('/notes', {
        title: 'Untitled note',
        content: '## Summary\n\nWrite your notes here. Markdown is supported — headings, **bold**, lists and formulas.',
        subject: subjectFilter || 'Physics',
      });
      await load({ keepSelection: true });
      setActive(result.note);
      setEditing(true);
      navigate(`/notes/${result.note.id}`);
    } catch (err) {
      push({ tone: 'error', title: 'Could not create note', detail: err instanceof ApiError ? err.message : 'Try again.' });
    }
  };

  const saveNote = async () => {
    if (!active) return;
    setSaving(true);
    try {
      const result = await api.patch<{ note: Note }>(`/notes/${active.id}`, {
        title: draft.title.trim() || 'Untitled note',
        content: draft.content,
        subject: draft.subject.trim() || null,
        chapter: draft.chapter.trim() || null,
      });
      setActive(result.note);
      setEditing(false);
      await load({ keepSelection: true });
      push({ tone: 'success', title: 'Note saved' });
    } catch (err) {
      push({ tone: 'error', title: 'Could not save', detail: err instanceof ApiError ? err.message : 'Try again.' });
    } finally {
      setSaving(false);
    }
  };

  const deleteNote = async (note: Note) => {
    const ok = await confirm({
      title: 'Delete this note?',
      description: 'This cannot be undone.',
      detail: note.title,
      confirmLabel: 'Delete note',
    });
    if (!ok) return;
    await api.del(`/notes/${note.id}`).catch(() => undefined);
    setNotes((current) => current.filter((item) => item.id !== note.id));
    if (active?.id === note.id) {
      setActive(null);
      navigate('/notes');
    }
    push({ tone: 'info', title: 'Note deleted' });
  };

  const toggleStar = async (note: Note) => {
    const result = await api.patch<{ note: Note }>(`/notes/${note.id}`, { starred: !note.starred });
    setNotes((current) => current.map((item) => (item.id === note.id ? result.note : item)));
    if (active?.id === note.id) setActive(result.note);
  };

  const runUpload = async () => {
    const files = fileRef.current?.files;
    if ((!files || !files.length) && !pasteText.trim()) {
      setUploadError('Add a photo or PDF, or paste some text first.');
      return;
    }
    setUploadBusy(true);
    setUploadError(null);
    setUploadMessage(null);
    try {
      const form = new FormData();
      if (files) Array.from(files).forEach((file) => form.append('files', file));
      if (pasteText.trim()) form.append('text', pasteText);
      form.append('subject', uploadSubject);
      const result = await api.postForm<{ note: Note; degraded?: string; demo?: boolean }>('/notes/structure', form);
      setUploadMessage(
        result.degraded ??
          `Notes organised${result.demo ? ' (sample engine)' : ''}. Open them to review the extracted sections.`,
      );
      setPasteText('');
      if (fileRef.current) fileRef.current.value = '';
      await load({ keepSelection: true });
      setActive(result.note);
      navigate(`/notes/${result.note.id}`);
      push({ tone: 'success', title: 'Notes organised', detail: result.note.title });
    } catch (err) {
      setUploadError(err instanceof ApiError ? err.message : 'Could not process that upload.');
    } finally {
      setUploadBusy(false);
    }
  };

  const askAboutNote = async (mode: AskMode) => {
    if (!active) return;
    setAskMode(mode);
    setAskBusy(true);
    setAskAnswer(null);
    setAskDegraded(null);
    try {
      const result = await api.post<{ answer: string; degraded?: string; demo?: boolean }>(`/notes/${active.id}/ask`, { mode });
      setAskAnswer(result.answer);
      setAskDegraded(result.degraded ?? null);
      if (result.demo) setAskDegraded('Sample answer (no AI key connected yet).');
    } catch (err) {
      push({ tone: 'error', title: 'Could not generate that', detail: err instanceof ApiError ? err.message : 'Try again.' });
    } finally {
      setAskBusy(false);
    }
  };

  const wordCount = useMemo(() => (active ? active.content.split(/\s+/).filter(Boolean).length : 0), [active]);

  return (
    <>
      <PageHeader
        title="Notes"
        description="Upload a photo of your notebook or a PDF, and Vroqn Nexus restructures it into clean, exam-ready sections."
        badge={notes.length ? <Badge tone="muted">{notes.length} notes</Badge> : undefined}
        actions={
          <>
            <Button variant="secondary" icon={<Plus size={15} />} onClick={createBlank}>
              New note
            </Button>
            <Button variant="primary" icon={<Upload size={15} />} onClick={() => setUploadOpen(true)}>
              Upload &amp; clean
            </Button>
          </>
        }
      />

      <PageBody className="space-y-5">
        {!hasConnectedKey ? (
          <SampleNotice
            text={
              canReadImages
                ? 'Uploads will be organised locally until a key is verified — add a key in AI Settings for full handwriting extraction and summaries.'
                : 'No vision-capable key is connected, so photos cannot be read yet. Typed text and PDFs still work; add a Gemini (or other) key for handwriting.'
            }
            action={
              <Button size="sm" variant="secondary" onClick={() => navigate('/settings')}>
                AI Settings
              </Button>
            }
          />
        ) : null}

        <div className="grid gap-4 lg:grid-cols-[320px_1fr]">
          {/* --------------------------------- list --------------------------------- */}
          <div className="space-y-3">
            <div className="flex gap-2">
              <div className="relative flex-1">
                <Search size={14} className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-[var(--color-muted-dim)]" />
                <TextInput
                  value={search}
                  onChange={(event) => setSearch(event.target.value)}
                  placeholder="Search notes…"
                  className="pl-9"
                  aria-label="Search notes"
                />
              </div>
              <VroqnFilterSelect
                label="Filter by subject"
                value={subjectFilter}
                onChange={setSubjectFilter}
                placeholder="All subjects"
                className="max-w-[168px]"
                options={[
                  { value: '', label: 'All subjects' },
                  ...subjects.map((subject) => ({ value: subject, label: subject })),
                ]}
              />
            </div>

            {error ? <ErrorState message={error} onRetry={() => void load()} /> : null}

            <Card className="overflow-hidden">
              {loading && !notes.length ? (
                <LoadingState message="Loading your notes…" className="py-10" />
              ) : notes.length ? (
                <ul className="max-h-[62vh] divide-y divide-[var(--color-border)] overflow-y-auto">
                  {notes.map((note) => (
                    <li key={note.id}>
                      <div
                        className={[
                          'flex items-start gap-2 px-3 py-2.5 transition-colors',
                          active?.id === note.id ? 'bg-[var(--color-primary)]/[0.08]' : 'hover:bg-white/[0.03]',
                        ].join(' ')}
                      >
                        <button
                          type="button"
                          onClick={() => navigate(`/notes/${note.id}`)}
                          className="min-w-0 flex-1 text-left"
                        >
                          <span className="flex items-center gap-1.5">
                            {note.source === 'upload' ? (
                              <Camera size={12} className="shrink-0 text-[var(--color-primary-soft)]" />
                            ) : note.source === 'tutor' ? (
                              <Sparkles size={12} className="shrink-0 text-[var(--color-primary-soft)]" />
                            ) : (
                              <FileText size={12} className="shrink-0 text-[var(--color-muted-dim)]" />
                            )}
                            <span className="truncate text-[13px] font-medium">{note.title}</span>
                          </span>
                          <span className="mt-0.5 block truncate text-[11.5px] text-[var(--color-muted)]">
                            {note.subject ?? 'General'}
                            {note.chapter ? ` · ${note.chapter}` : ''} · {timeAgo(note.updatedAt)}
                          </span>
                        </button>
                        <button
                          type="button"
                          onClick={() => void toggleStar(note)}
                          aria-label={note.starred ? 'Remove star' : 'Star this note'}
                          className={[
                            'vroqn-tap grid h-8 w-8 shrink-0 place-items-center rounded-md transition-colors',
                            note.starred
                              ? 'text-[var(--color-warning)]'
                              : 'text-[var(--color-muted-dim)] hover:bg-white/5 hover:text-[var(--color-warning)]',
                          ].join(' ')}
                        >
                          <Star size={14} fill={note.starred ? 'currentColor' : 'none'} />
                        </button>
                      </div>
                    </li>
                  ))}
                </ul>
              ) : (
                <EmptyState
                  icon={<NotebookPen size={18} />}
                  title={search || subjectFilter ? 'No notes match that' : 'No notes yet'}
                  description={
                    search || subjectFilter
                      ? 'Try a different search term, or clear the subject filter.'
                      : 'Upload a photo of your handwritten notes, or paste text to be organised into clean sections.'
                  }
                  action={
                    <Button size="sm" variant="primary" icon={<Upload size={14} />} onClick={() => setUploadOpen(true)}>
                      Upload notes
                    </Button>
                  }
                />
              )}
            </Card>
          </div>

          {/* -------------------------------- viewer -------------------------------- */}
          <div className="min-w-0">
            {active ? (
              <div className="space-y-4">
                <Card>
                  <div className="flex flex-wrap items-start justify-between gap-3 border-b border-[var(--color-border)] px-4 py-3">
                    <div className="min-w-0">
                      {editing ? (
                        <div className="grid gap-2 sm:grid-cols-2">
                          <TextInput
                            value={draft.title}
                            onChange={(event) => setDraft((current) => ({ ...current, title: event.target.value }))}
                            aria-label="Note title"
                            placeholder="Note title"
                          />
                          <div className="flex gap-2">
                            <TextInput
                              value={draft.subject}
                              onChange={(event) => setDraft((current) => ({ ...current, subject: event.target.value }))}
                              aria-label="Subject"
                              placeholder="Subject"
                            />
                            <TextInput
                              value={draft.chapter}
                              onChange={(event) => setDraft((current) => ({ ...current, chapter: event.target.value }))}
                              aria-label="Chapter"
                              placeholder="Chapter"
                            />
                          </div>
                        </div>
                      ) : (
                        <>
                          <h2 className="truncate text-[15.5px] font-semibold">{active.title}</h2>
                          <p className="mt-0.5 flex flex-wrap items-center gap-1.5 text-[11.5px] text-[var(--color-muted)]">
                            <span>{active.subject ?? 'General'}</span>
                            {active.chapter ? <span>· {active.chapter}</span> : null}
                            <span>· {wordCount} words</span>
                            <span>· updated {timeAgo(active.updatedAt)}</span>
                            {active.tags.map((tag) => (
                              <Badge key={tag} tone="muted">
                                {tag}
                              </Badge>
                            ))}
                          </p>
                        </>
                      )}
                    </div>
                    <div className="flex flex-wrap items-center gap-1.5">
                      {editing ? (
                        <>
                          <Button size="sm" variant="primary" loading={saving} onClick={() => void saveNote()}>
                            Save
                          </Button>
                          <Button
                            size="sm"
                            variant="ghost"
                            onClick={() => {
                              setEditing(false);
                              setDraft({
                                title: active.title,
                                content: active.content,
                                subject: active.subject ?? '',
                                chapter: active.chapter ?? '',
                              });
                            }}
                          >
                            Cancel
                          </Button>
                        </>
                      ) : (
                        <>
                          <Button size="sm" variant="secondary" icon={<Pencil size={13} />} onClick={() => setEditing(true)}>
                            Edit
                          </Button>
                          <Button
                            size="sm"
                            variant="secondary"
                            icon={<Star size={13} fill={active.starred ? 'currentColor' : 'none'} />}
                            onClick={() => void toggleStar(active)}
                          >
                            {active.starred ? 'Starred' : 'Star'}
                          </Button>
                          <Button
                            size="icon"
                            variant="ghost"
                            aria-label="Delete note"
                            onClick={() => void deleteNote(active)}
                          >
                            <Trash2 size={15} />
                          </Button>
                        </>
                      )}
                    </div>
                  </div>

                  <div className="p-4">
                    {editing ? (
                      <TextArea
                        value={draft.content}
                        onChange={(event) => setDraft((current) => ({ ...current, content: event.target.value }))}
                        rows={18}
                        className="font-mono text-[12.5px]"
                        aria-label="Note content (markdown)"
                      />
                    ) : (
                      <Markdown content={active.content} />
                    )}
                  </div>
                </Card>

                <Card>
                  <CardHeader
                    title="Study tools for this note"
                    subtitle="Generated from this note only"
                    icon={<Sparkles size={15} />}
                  />
                  <div className="space-y-3 p-4">
                    <Segmented value={askMode} onChange={(value) => void askAboutNote(value)} label="Note tools" options={ASK_MODES} />
                    {askBusy ? (
                      <div className="flex items-center gap-2 text-[12.5px] text-[var(--color-muted)]">
                        <Spinner size={13} /> Working through your notes…
                      </div>
                    ) : null}
                    {askDegraded ? <SampleNotice text={askDegraded} /> : null}
                    {askAnswer ? (
                      <div className="rounded-xl border border-[var(--color-border)] bg-[var(--color-surface)] p-3.5">
                        <Markdown content={askAnswer} />
                        <div className="mt-3 flex flex-wrap gap-2">
                          <Button
                            size="sm"
                            variant="secondary"
                            icon={<ListChecks size={13} />}
                            onClick={() => void navigator.clipboard?.writeText(askAnswer)}
                          >
                            Copy
                          </Button>
                          <Button
                            size="sm"
                            variant="secondary"
                            icon={<BookOpen size={13} />}
                            onClick={() =>
                              void api
                                .post('/notes', {
                                  title: `${active.title} — ${askMode}`,
                                  content: askAnswer,
                                  subject: active.subject,
                                  chapter: active.chapter,
                                  tags: ['study-tool'],
                                })
                                .then(() => load({ keepSelection: true }))
                                .catch(() => undefined)
                            }
                          >
                            Save as new note
                          </Button>
                        </div>
                      </div>
                    ) : null}
                  </div>
                </Card>
              </div>
            ) : (
              <Card>
                <EmptyState
                  icon={<NotebookPen size={20} />}
                  title="Select a note, or start a new one"
                  description="Open any note to read it in a clean format, edit it, or generate a summary, key points, definitions and practice questions from it."
                  action={
                    <div className="flex flex-wrap justify-center gap-2">
                      <Button size="sm" variant="primary" icon={<Upload size={14} />} onClick={() => setUploadOpen(true)}>
                        Upload notes
                      </Button>
                      <Button size="sm" variant="secondary" icon={<Plus size={14} />} onClick={createBlank}>
                        Blank note
                      </Button>
                    </div>
                  }
                />
              </Card>
            )}
          </div>
        </div>
      </PageBody>

      {/* ------------------------------- upload modal ------------------------------ */}
      <Modal
        open={uploadOpen}
        onClose={() => setUploadOpen(false)}
        title="Upload and clean up notes"
        description="Photos of handwritten notes, scanned PDFs, or pasted text — all become structured study notes."
        size="lg"
        footer={
          <>
            <Button variant="ghost" onClick={() => setUploadOpen(false)}>
              Close
            </Button>
            <Button variant="primary" icon={<Wand2 size={15} />} loading={uploadBusy} onClick={() => void runUpload()}>
              {uploadBusy ? 'Organising…' : 'Organise my notes'}
            </Button>
          </>
        }
      >
        <div className="space-y-4">
          <Field
            label="Photo or PDF"
            hint="PNG, JPG, WebP or PDF · up to 8 MB each · you can add up to 5 files"
          >
            <input
              ref={fileRef}
              type="file"
              accept="image/png,image/jpeg,image/webp,application/pdf,text/plain,text/markdown"
              multiple
              className="w-full rounded-[10px] border border-dashed border-[var(--color-border-strong)] bg-[var(--color-surface)] px-3 py-6 text-[13px] file:mr-3 file:rounded-lg file:border-0 file:bg-[var(--color-primary)]/15 file:px-3 file:py-2 file:text-[13px] file:text-[var(--color-primary)]"
              aria-label="Choose notes to upload"
            />
          </Field>

          <Field label="Subject">
            <VroqnFilterSelect
              label="Upload subject"
              value={uploadSubject}
              onChange={setUploadSubject}
              placeholder="Choose a subject"
              options={['Physics', 'Chemistry', 'Biology', 'Mathematics', 'Computer Science', 'English', 'Social Science', 'General Knowledge'].map(
                (option) => ({ value: option, label: option }),
              )}
            />
          </Field>

          <Field label="Or paste text directly" htmlFor="paste" optional>
            <TextArea
              id="paste"
              rows={5}
              value={pasteText}
              onChange={(event) => setPasteText(event.target.value)}
              placeholder="Paste a chapter, a set of definitions, or your messy notes…"
            />
          </Field>

          {uploadError ? <ErrorState message={uploadError} compact /> : null}
          {uploadMessage ? (
            <div className="rounded-lg border border-[var(--color-success)]/35 bg-[var(--color-success)]/[0.07] px-3 py-2 text-[12.5px] text-[#7ee2a8]">
              {uploadMessage}
            </div>
          ) : null}

          <div className="rounded-lg border border-[var(--color-border)] bg-[var(--color-surface)] px-3 py-2.5 text-[12px] leading-relaxed text-[var(--color-muted)]">
            Output sections: <strong className="text-[var(--color-text)]">Summary · Key Concepts · Important Definitions · Formulas · Quick Revision · Practice Questions</strong>.
            Illegible words are marked <span className="font-mono">[unclear]</span> instead of being guessed.
          </div>

          {uploadBusy ? (
            <p className="flex items-center gap-2 text-[12.5px] text-[var(--color-muted)]">
              <Spinner size={13} /> Reading your notes — this can take a few seconds for a photo.
            </p>
          ) : null}
        </div>
      </Modal>
    </>
  );
}

export default NotesPage;
