/**
 * Resources (§18).
 *
 * Links, notes and files shared by the community. Everything that reaches the browser is sanitised on
 * the server first; external links open with `noopener` and file downloads go through an authenticated
 * same-origin URL rather than a public path.
 */
import { useMemo, useRef, useState } from 'react';
import { Download, ExternalLink, FileText, Link2, Plus, Trash2, Upload } from 'lucide-react';
import { Badge, Button, Card, EmptyState, ErrorState, Modal, SkeletonCard, TextInput } from '../../../components/ui';
import { VroqnFilterSelect } from '../../../components/vroqn';
import { useConfirm } from '../../../components/Confirm';
import { api } from '../../../lib/api';
import { communitiesApi, type CommunityDetail, type ResourceView } from '../api';
import { useAction, useDebounced, useRemote } from '../useCommunities';

const CATEGORIES = ['notes', 'formula_sheet', 'question_bank', 'video', 'article', 'tool', 'other'] as const;

export function ResourcesTab({ community }: { community: CommunityDetail }) {
  const [search, setSearch] = useState('');
  const [category, setCategory] = useState<string>('');
  const debounced = useDebounced(search, 350);
  const [composerOpen, setComposerOpen] = useState(false);
  const { busy, run } = useAction();
  const confirm = useConfirm();

  const resources = useRemote<{ resources: ResourceView[]; total: number }>(
    `/communities/${community.id}/resources?search=${encodeURIComponent(debounced)}&category=${encodeURIComponent(category)}&limit=40`,
    [debounced, category],
  );

  const remove = async (resource: ResourceView) => {
    const ok = await confirm({
      title: 'Remove this resource?',
      description: `“${resource.title}” will no longer be available to members. This cannot be undone.`,
      confirmLabel: 'Remove resource',
      tone: 'danger',
    });
    if (!ok) return;
    const done = await run(() => communitiesApi.deleteResource(community.id, resource.id), {
      success: 'Resource removed',
      failure: 'Could not remove that resource',
    });
    if (done) void resources.refresh();
  };

  if (resources.loading && !resources.data) {
    return (
      <div className="space-y-2">
        {[0, 1, 2].map((index) => (
          <SkeletonCard key={index} lines={3} />
        ))}
      </div>
    );
  }
  if (resources.error) {
    return <ErrorState title="Could not load resources" message={resources.error} onRetry={() => void resources.refresh()} />;
  }

  const list = resources.data?.resources ?? [];

  return (
    <div className="space-y-4">
      <div className="grid gap-2 sm:grid-cols-[1fr_auto_auto]">
        <div>
          <label className="sr-only" htmlFor="resource-search">
            Search resources
          </label>
          <TextInput
            id="resource-search"
            value={search}
            onChange={(event) => setSearch(event.target.value)}
            placeholder="Search resources…"
          />
        </div>
        <VroqnFilterSelect
          label="Filter by category"
          value={category}
          onChange={setCategory}
          placeholder="All categories"
          options={[
            { value: '', label: 'All categories' },
            ...CATEGORIES.map((value) => ({ value, label: value.replace('_', ' ') })),
          ]}
        />
        <Button variant="primary" icon={<Plus size={15} />} onClick={() => setComposerOpen(true)}>
          Share a resource
        </Button>
      </div>

      {list.length === 0 ? (
        <EmptyState
          icon={<FileText size={22} />}
          title={search || category ? 'Nothing matches those filters' : 'No resources shared yet'}
          description={
            search || category
              ? 'Clear the filters to see everything the community has shared.'
              : 'Share the notes or the paper that actually helped you. A link and one line about why it is useful is enough.'
          }
          action={
            <Button variant="primary" icon={<Plus size={15} />} onClick={() => setComposerOpen(true)}>
              Share a resource
            </Button>
          }
        />
      ) : (
        <div className="grid gap-3 md:grid-cols-2">
          {list.map((resource) => (
            <Card key={resource.id} className="flex flex-col gap-2 p-4">
              <div className="flex flex-wrap items-center gap-2">
                <Badge tone="muted" className="capitalize">
                  {resource.kind === 'file' ? 'file' : resource.category.replace('_', ' ')}
                </Badge>
                {resource.subject ? <Badge tone="muted">{resource.subject}</Badge> : null}
                <span className="text-[11.5px] text-[var(--color-muted-dim)]">
                  {resource.authorName} · {new Date(resource.createdAt).toLocaleDateString()}
                </span>
              </div>

              <div className="min-w-0">
                <h3 className="truncate text-[13.5px] font-semibold text-[var(--color-text)]">{resource.title}</h3>
                {resource.description ? (
                  <p className="mt-1 line-clamp-2 text-[12.5px] text-[var(--color-muted)]">{resource.description}</p>
                ) : null}
                {resource.kind === 'link' && resource.url ? (
                  <p className="mt-1 truncate text-[11.5px] text-[var(--color-muted-dim)]">{resource.url}</p>
                ) : (
                  <p className="mt-1 text-[11.5px] text-[var(--color-muted-dim)]">
                    {resource.fileName} · {formatBytes(resource.fileSize)}
                  </p>
                )}
              </div>

              <div className="mt-auto flex flex-wrap items-center gap-2">
                {resource.url ? (
                  <a href={resource.url} target="_blank" rel="noopener noreferrer nofollow" className="inline-flex">
                    <Button size="sm" variant="secondary" icon={<ExternalLink size={13} />}>
                      Open link
                    </Button>
                  </a>
                ) : resource.uploadId ? (
                  <DownloadButton communityId={community.id} resource={resource} />
                ) : (
                  <Badge tone="warning">File unavailable</Badge>
                )}
                {resource.canDelete ? (
                  <Button size="sm" variant="ghost" icon={<Trash2 size={13} />} onClick={() => void remove(resource)}>
                    Remove
                  </Button>
                ) : null}
              </div>
            </Card>
          ))}
        </div>
      )}

      <ShareResource
        community={community}
        open={composerOpen}
        onClose={() => setComposerOpen(false)}
        onCreated={() => {
          setComposerOpen(false);
          void resources.refresh();
        }}
      />
      {busy ? <span className="sr-only">Working</span> : null}
    </div>
  );
}

/** Downloads through the API (authenticated, counted) instead of a public /uploads path. */
function DownloadButton({ communityId, resource }: { communityId: string; resource: ResourceView }) {
  const [loading, setLoading] = useState(false);
  return (
    <Button
      size="sm"
      variant="secondary"
      icon={<Download size={13} />}
      loading={loading}
      onClick={async () => {
        setLoading(true);
        try {
          const { blob, filename } = await api.download(
            `/communities/${communityId}/resources/${resource.id}/download`,
          );
          const href = URL.createObjectURL(blob);
          const anchor = document.createElement('a');
          anchor.href = href;
          anchor.download = filename ?? resource.fileName ?? resource.title;
          document.body.appendChild(anchor);
          anchor.click();
          anchor.remove();
          URL.revokeObjectURL(href);
        } finally {
          setLoading(false);
        }
      }}
    >
      Download
    </Button>
  );
}

function ShareResource({
  community,
  open,
  onClose,
  onCreated,
}: {
  community: CommunityDetail;
  open: boolean;
  onClose: () => void;
  onCreated: () => void;
}) {
  const { busy, run } = useAction();
  const fileInput = useRef<HTMLInputElement | null>(null);
  const [mode, setMode] = useState<'link' | 'file'>('link');
  const [title, setTitle] = useState('');
  const [url, setUrl] = useState('');
  const [description, setDescription] = useState('');
  const [category, setCategory] = useState<string>('notes');
  const [subject, setSubject] = useState('');
  const [file, setFile] = useState<File | null>(null);
  const [uploading, setUploading] = useState(false);

  const valid = title.trim().length >= 3 && (mode === 'link' ? /^https?:\/\//i.test(url.trim()) : Boolean(file));

  const submit = async () => {
    if (mode === 'file' && file) {
      setUploading(true);
      try {
        const created = await run(
          () =>
            communitiesApi.uploadResource(community.id, {
              title: title.trim(),
              description: description.trim(),
              category,
              subject: subject.trim() || null,
              file,
            }),
          { failure: 'Could not share that file' },
        );
        if (created) reset();
      } finally {
        setUploading(false);
      }
      return;
    }

    const created = await run(
      () =>
        communitiesApi.createResource(community.id, {
          title: title.trim(),
          description: description.trim(),
          category,
          subject: subject.trim() || null,
          kind: 'link',
          url: url.trim(),
        }),
      { failure: 'Could not share that link' },
    );
    if (created) reset();
  };

  const reset = () => {
    setTitle('');
    setUrl('');
    setDescription('');
    setSubject('');
    setFile(null);
    onCreated();
  };

  const tabs = useMemo(
    () => [
      { id: 'link' as const, label: 'A link', icon: <Link2 size={13} /> },
      { id: 'file' as const, label: 'A file', icon: <Upload size={13} /> },
    ],
    [],
  );

  return (
    <Modal
      open={open}
      onClose={onClose}
      title="Share a resource"
      description="Someone in this community is stuck on exactly what this explains."
      footer={
        <div className="flex justify-end gap-2">
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button variant="primary" loading={busy || uploading} disabled={!valid} onClick={submit}>
            Share
          </Button>
        </div>
      }
    >
      <div className="space-y-3">
        <div className="flex gap-2" role="tablist" aria-label="Resource type">
          {tabs.map((tab) => (
            <Button
              key={tab.id}
              size="sm"
              variant={mode === tab.id ? 'primary' : 'secondary'}
              icon={tab.icon}
              onClick={() => setMode(tab.id)}
              role="tab"
              aria-selected={mode === tab.id}
            >
              {tab.label}
            </Button>
          ))}
        </div>

        <div>
          <label className="text-[12.5px] text-[var(--color-muted)]" htmlFor="resource-title">
            Title
          </label>
          <TextInput
            id="resource-title"
            value={title}
            onChange={(event) => setTitle(event.target.value)}
            maxLength={160}
            placeholder="Rotational motion — one-page summary"
          />
        </div>

        {mode === 'link' ? (
          <div>
            <label className="text-[12.5px] text-[var(--color-muted)]" htmlFor="resource-url">
              Link (https://…)
            </label>
            <TextInput
              id="resource-url"
              value={url}
              onChange={(event) => setUrl(event.target.value)}
              inputMode="url"
              placeholder="https://…"
            />
          </div>
        ) : (
          <div>
            <label className="text-[12.5px] text-[var(--color-muted)]" htmlFor="resource-file">
              File (PDF, image, notes)
            </label>
            <input
              id="resource-file"
              ref={fileInput}
              type="file"
              onChange={(event) => setFile(event.target.files?.[0] ?? null)}
              className="block w-full text-[12.5px] text-[var(--color-muted)] file:mr-3 file:rounded-lg file:border-0 file:bg-[var(--color-surface)] file:px-3 file:py-2 file:text-[12.5px] file:text-[var(--color-text)]"
            />
            <p className="mt-1 text-[11.5px] text-[var(--color-muted-dim)]">
              Keep it under 8 MB. Files are private to this community.
            </p>
          </div>
        )}

        <div>
          <label className="text-[12.5px] text-[var(--color-muted)]" htmlFor="resource-description">
            Why is it useful? (optional)
          </label>
          <textarea
            id="resource-description"
            value={description}
            rows={3}
            maxLength={1000}
            onChange={(event) => setDescription(event.target.value)}
            className="w-full rounded-xl border border-[var(--color-border)] bg-[var(--color-card)] px-3 py-2 text-[13px] text-[var(--color-text)]"
          />
        </div>

        <div className="grid gap-3 sm:grid-cols-2">
          <div>
            <span className="mb-1 block text-[12.5px] text-[var(--color-muted)]">Category</span>
            <VroqnFilterSelect
              label="Category"
              value={category}
              onChange={setCategory}
              size="sm"
              placeholder="Choose a category"
              options={CATEGORIES.map((value) => ({ value, label: value.replace('_', ' ') }))}
            />
          </div>
          <div>
            <label className="text-[12.5px] text-[var(--color-muted)]" htmlFor="resource-subject">
              Subject (optional)
            </label>
            <TextInput
              id="resource-subject"
              value={subject}
              onChange={(event) => setSubject(event.target.value)}
              placeholder={community.category}
            />
          </div>
        </div>
      </div>
    </Modal>
  );
}

function formatBytes(bytes: number | null): string {
  if (!bytes) return 'unknown size';
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}
