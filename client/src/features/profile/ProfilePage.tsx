/**
 * Profile (§19–§20).
 *
 * One page, two modes:
 *  - `/profile` — your own profile: read it, edit it, set a bio, choose an accent, control what other
 *    students can see, and decide who may message you.
 *  - `/profile/:userId` — someone else's profile: what their privacy allows, plus the actions a
 *    student needs (message, block, report). Neither mode shows anything the server did not send:
 *    a private profile comes back with its fields withheld, not hidden with CSS.
 *
 * The page reads `GET /api/profile/me` or `GET /api/profile/:id`, and every write goes back through
 * the same endpoint the API smoke test covers.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import {
  ArrowLeft,
  BookOpen,
  Flag,
  GraduationCap,
  Lock,
  MessageSquare,
  Save,
  ShieldOff,
  Sparkles,
  Trophy,
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
  Segmented,
  Skeleton,
  Spinner,
  Switch,
  TextArea,
  TextInput,
  VroqnAvatar,
  VroqnIconButton,
  VroqnSection,
  VroqnSelectMenu,
  VroqnSheet,
} from '../../components/vroqn';
import { useAuth } from '../../hooks/useAuth';
import { useToast } from '../../hooks/useToast';
import { messagesApi, profileApi, type DmPolicy, type ProfileView } from '../messages/api';

const ACCENTS = [
  { value: '#00E5FF', label: 'Cyan (default)' },
  { value: '#7C9CFF', label: 'Indigo' },
  { value: '#8BD450', label: 'Green' },
  { value: '#FFB020', label: 'Amber' },
  { value: '#FF7A8A', label: 'Rose' },
  { value: '#B388FF', label: 'Violet' },
];

const CLASS_LEVELS = [
  { value: '6', label: 'Class 6' },
  { value: '7', label: 'Class 7' },
  { value: '8', label: 'Class 8' },
  { value: '9', label: 'Class 9' },
  { value: '10', label: 'Class 10' },
  { value: '11', label: 'Class 11' },
  { value: '12', label: 'Class 12' },
  { value: 'college', label: 'College / other' },
];

const BOARDS = [
  { value: 'CBSE', label: 'CBSE' },
  { value: 'ICSE', label: 'ICSE' },
  { value: 'Bihar Board', label: 'Bihar Board' },
  { value: 'UP Board', label: 'UP Board' },
  { value: 'State Board', label: 'Other state board' },
  { value: 'Other', label: 'Other' },
];

export function ProfilePage() {
  const { userId } = useParams<{ userId?: string }>();
  const { user, reload: reloadSession } = useAuth();
  const navigate = useNavigate();
  const toast = useToast();
  const [profile, setProfile] = useState<ProfileView | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [editing, setEditing] = useState(false);
  const [busy, setBusy] = useState(false);
  const [dmBusy, setDmBusy] = useState(false);
  const fileRef = useRef<HTMLInputElement | null>(null);

  const isSelf = !userId || userId === user?.id;

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const next = isSelf ? await profileApi.me() : await profileApi.person(userId as string);
      setProfile(next);
    } catch (err) {
      setError((err as Error).message ?? 'Could not load this profile.');
    } finally {
      setLoading(false);
    }
  }, [isSelf, userId]);

  useEffect(() => {
    void load();
  }, [load]);

  const canMessage = profile?.viewer.canMessage ?? false;

  const startConversation = async () => {
    if (!profile) return;
    setDmBusy(true);
    try {
      const result = await messagesApi.open(profile.userId);
      navigate(`/messages/${result.conversationId}`);
    } catch (err) {
      toast.push({ tone: 'error', title: 'Cannot start a conversation', detail: (err as Error).message });
    } finally {
      setDmBusy(false);
    }
  };

  const toggleBlock = async () => {
    if (!profile) return;
    try {
      if (profile.viewer.isBlockedByMe) {
        await messagesApi.unblock(profile.userId);
        toast.push({ tone: 'info', title: 'Unblocked' });
      } else {
        await messagesApi.block(profile.userId);
        toast.push({ tone: 'info', title: 'Blocked', detail: 'They can no longer message you.' });
      }
      await load();
    } catch (err) {
      toast.push({ tone: 'error', title: 'Could not update the block', detail: (err as Error).message });
    }
  };

  if (loading) {
    return (
      <div>
        <PageHeader title="Profile" />
        <PageBody className="space-y-3">
          <Skeleton className="h-28 w-full" rounded="lg" />
          <Skeleton className="h-40 w-full" rounded="lg" />
        </PageBody>
      </div>
    );
  }

  if (error || !profile) {
    return (
      <div>
        <PageHeader title="Profile" />
        <PageBody>
          <ErrorState message={error ?? 'That profile could not be found.'} onRetry={() => void load()} />
        </PageBody>
      </div>
    );
  }

  return (
    <div>
      <PageHeader
        title={isSelf ? 'Your profile' : profile.name}
        description={
          isSelf
            ? 'This is what classmates see. Anything you leave blank simply does not appear — nothing here is required.'
            : profile.visibility.profile === 'private'
              ? 'This student keeps their profile private. What you can see is limited to shared communities.'
              : `${profile.classLevel ? `Class ${profile.classLevel}` : 'Student'}${profile.board ? ` · ${profile.board}` : ''}`
        }
        actions={
          isSelf ? (
            <>
              <Button size="sm" variant="secondary" icon={<Save size={14} />} onClick={() => setEditing(true)}>
                Edit profile
              </Button>
              <Button size="sm" variant="ghost" icon={<MessageSquare size={14} />} onClick={() => navigate('/messages')}>
                Messages
              </Button>
            </>
          ) : (
            <>
              <Button
                size="sm"
                variant="primary"
                icon={<MessageSquare size={14} />}
                disabled={!canMessage || dmBusy}
                title={canMessage ? 'Send a private message' : (profile.viewer.messageBlockedReason ?? 'Messaging is not available')}
                onClick={() => void startConversation()}
              >
                {dmBusy ? 'Opening…' : 'Message'}
              </Button>
              <Button
                size="sm"
                variant={profile.viewer.isBlockedByMe ? 'secondary' : 'ghost'}
                icon={<ShieldOff size={14} />}
                onClick={() => void toggleBlock()}
              >
                {profile.viewer.isBlockedByMe ? 'Unblock' : 'Block'}
              </Button>
              <Button size="sm" variant="ghost" icon={<Flag size={14} />} onClick={() => navigate('/messages')}>
                Report
              </Button>
            </>
          )
        }
      />

      <PageBody className="space-y-4">
        {!canMessage && !isSelf ? (
          <Card className="border-[var(--color-border)] p-3.5">
            <p className="flex items-start gap-2 text-[12.5px] leading-relaxed text-[var(--color-muted)]">
              <Lock size={14} className="mt-0.5 shrink-0" />
              {profile.viewer.messageBlockedReason ??
                'You cannot message this student right now. That decision belongs to them and can change at any time.'}
            </p>
          </Card>
        ) : null}

        <Card>
          <div className="flex flex-col gap-4 p-4 sm:flex-row sm:items-start">
            <VroqnAvatar name={profile.name} src={profile.avatarUrl} accent={profile.accent} size="xl" />
            <div className="min-w-0 flex-1 space-y-2">
              <div className="flex flex-wrap items-center gap-2">
                <h2 className="text-[17px] font-semibold tracking-tight">{profile.name}</h2>
                {profile.visibility.profile === 'private' ? <Badge tone="muted">Private</Badge> : null}
                {profile.sharedCommunities ? <Badge tone="primary">{profile.sharedCommunities} shared communities</Badge> : null}
              </div>
              {profile.username ? <p className="text-[12.5px] text-[var(--color-muted)]">@{profile.username}</p> : null}
              <p className="whitespace-pre-wrap text-[13.5px] leading-relaxed text-[var(--color-text)]">
                {profile.bio || (isSelf ? 'Add a short bio so classmates know what you are studying.' : 'No bio yet.')}
              </p>
              {profile.interests?.length ? (
                <div className="flex flex-wrap gap-1.5">
                  {profile.interests.map((interest) => (
                    <Badge key={interest} tone="muted">
                      {interest}
                    </Badge>
                  ))}
                </div>
              ) : null}
              <div className="flex flex-wrap gap-3 pt-1 text-[12px] text-[var(--color-muted)]">
                {profile.classLevel ? (
                  <span className="inline-flex items-center gap-1.5">
                    <GraduationCap size={13} /> Class {profile.classLevel}
                  </span>
                ) : null}
                {profile.board ? <span className="inline-flex items-center gap-1.5">{profile.board}</span> : null}
              </div>
            </div>
          </div>
        </Card>

        {profile.stats && profile.visibility.activity ? (
          <VroqnSection title="Learning activity" description="Shared only because this student chose to show it.">
            <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
              <Stat label="Practice sets" value={profile.stats.practiceSets} icon={<Sparkles size={14} />} />
              <Stat label="Mock exams" value={profile.stats.mockExams} icon={<BookOpen size={14} />} />
              <Stat label="Arena attempts" value={profile.stats.arenaAttempts} icon={<Trophy size={14} />} />
              <Stat label="Notes" value={profile.stats.notes} icon={<BookOpen size={14} />} />
            </div>
          </VroqnSection>
        ) : null}

        {profile.badges?.length ? (
          <VroqnSection title="Badges" description="Earned in communities from real activity.">
            <div className="flex flex-wrap gap-2">
              {profile.badges.map((badge) => (
                <span key={badge.key} className="rounded-full border border-[var(--color-border)] px-3 py-1.5 text-[12.5px]">
                  {badge.label}
                </span>
              ))}
            </div>
          </VroqnSection>
        ) : null}

        {profile.visibility.communities && profile.communities?.length ? (
          <VroqnSection title="Communities" description="Groups this student is part of.">
            <ul className="space-y-1.5">
              {profile.communities.map((community) => (
                <li key={community.id}>
                  <Link
                    to={`/communities/${community.slug}`}
                    className="flex items-center justify-between gap-3 rounded-[10px] border border-[var(--color-border)] px-3 py-2 text-[13px] transition-colors hover:border-[var(--color-border-strong)]"
                  >
                    <span className="truncate">{community.name}</span>
                    <Badge tone="muted">{community.role}</Badge>
                  </Link>
                </li>
              ))}
            </ul>
          </VroqnSection>
        ) : null}

        {isSelf ? (
          <EditProfileSheet
            open={editing}
            profile={profile}
            onClose={() => setEditing(false)}
            onSaved={async (next) => {
              setProfile(next);
              setEditing(false);
              await reloadSession();
              toast.push({ tone: 'success', title: 'Profile saved' });
              setBusy(false);
            }}
          />
        ) : null}

        {/* avatar upload is its own control: it is a file, not a text field */}
        {isSelf ? (
          <Card>
            <CardHeader title="Photo" subtitle="PNG, JPG or WebP up to 2 MB" />
            <div className="flex flex-wrap items-center gap-2 p-4">
              <input
                ref={fileRef}
                type="file"
                accept="image/png,image/jpeg,image/webp"
                className="hidden"
                onChange={async (event) => {
                  const file = event.target.files?.[0];
                  event.target.value = '';
                  if (!file) return;
                  setBusy(true);
                  try {
                    const next = await profileApi.uploadAvatar(file);
                    setProfile(next);
                    toast.push({ tone: 'success', title: 'Photo updated' });
                  } catch (err) {
                    toast.push({ tone: 'error', title: 'Could not upload that photo', detail: (err as Error).message });
                  } finally {
                    setBusy(false);
                  }
                }}
              />
              <Button size="sm" variant="secondary" disabled={busy} onClick={() => fileRef.current?.click()}>
                {busy ? 'Uploading…' : 'Choose a photo'}
              </Button>
              {profile.avatarUrl ? (
                <Button
                  size="sm"
                  variant="ghost"
                  onClick={async () => {
                    setBusy(true);
                    try {
                      setProfile(await profileApi.removeAvatar());
                      toast.push({ tone: 'info', title: 'Photo removed' });
                    } finally {
                      setBusy(false);
                    }
                  }}
                >
                  Remove photo
                </Button>
              ) : null}
              <p className="w-full text-[11.5px] text-[var(--color-muted-dim)]">
                A photo is optional. Initials are used when there is none.
              </p>
            </div>
          </Card>
        ) : null}

        {isSelf ? <PrivacyCard profile={profile} onSaved={setProfile} /> : null}
      </PageBody>
    </div>
  );
}

function Stat({ label, value, icon }: { label: string; value: number; icon: React.ReactNode }) {
  return (
    <div className="rounded-[12px] border border-[var(--color-border)] bg-[var(--color-card)] px-3 py-2.5">
      <p className="flex items-center gap-1.5 text-[11.5px] text-[var(--color-muted-dim)]">
        {icon}
        {label}
      </p>
      <p className="mt-1 text-[18px] font-semibold tabular-nums">{value}</p>
    </div>
  );
}

/** Bio, name, handle, interests, accent — one sheet, one save. */
function EditProfileSheet({
  open,
  profile,
  onClose,
  onSaved,
}: {
  open: boolean;
  profile: ProfileView;
  onClose: () => void;
  onSaved: (next: ProfileView) => Promise<void>;
}) {
  const toast = useToast();
  const [form, setForm] = useState({
    name: profile.name,
    username: profile.username ?? '',
    bio: profile.bio ?? '',
    interests: (profile.interests ?? []).join(', '),
    accent: profile.accent,
    classLevel: profile.classLevel ?? '',
    board: profile.board ?? '',
  });
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    if (!open) return;
    setForm({
      name: profile.name,
      username: profile.username ?? '',
      bio: profile.bio ?? '',
      interests: (profile.interests ?? []).join(', '),
      accent: profile.accent,
      classLevel: profile.classLevel ?? '',
      board: profile.board ?? '',
    });
  }, [open, profile]);

  const interests = useMemo(
    () =>
      form.interests
        .split(',')
        .map((value) => value.trim())
        .filter(Boolean)
        .slice(0, 12),
    [form.interests],
  );

  const save = async () => {
    setSaving(true);
    try {
      const next = await profileApi.update({
        name: form.name.trim(),
        username: form.username.trim() ? form.username.trim() : null,
        bio: form.bio.trim(),
        interests,
        accent: form.accent,
        classLevel: form.classLevel || null,
        board: form.board || null,
      });
      await onSaved(next);
    } catch (err) {
      toast.push({ tone: 'error', title: 'Could not save your profile', detail: (err as Error).message });
    } finally {
      setSaving(false);
    }
  };

  return (
    <VroqnSheet
      open={open}
      onClose={onClose}
      title="Edit profile"
      description="Everything here is optional except your name."
      size="md"
      footer={
        <div className="flex flex-wrap items-center gap-2">
          <Button size="sm" variant="primary" disabled={saving || form.name.trim().length < 2} onClick={() => void save()}>
            {saving ? 'Saving…' : 'Save profile'}
          </Button>
          <Button size="sm" variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <span className="text-[11.5px] text-[var(--color-muted-dim)]">{form.bio.length}/600 characters in your bio</span>
        </div>
      }
    >
      <div className="space-y-4">
        <Field label="Display name" hint="What classmates see on your messages and posts.">
          <TextInput
            value={form.name}
            maxLength={80}
            onChange={(event) => setForm({ ...form, name: event.target.value })}
            autoComplete="name"
          />
        </Field>

        <Field label="Username" hint="Optional. Letters, numbers, dots, dashes and underscores.">
          <TextInput
            value={form.username}
            maxLength={40}
            placeholder="e.g. aarav.k"
            onChange={(event) => setForm({ ...form, username: event.target.value })}
          />
        </Field>

        <Field label="Bio" hint={`${form.bio.length}/600 · what you are studying, what you want help with`}>
          <TextArea
            rows={4}
            maxLength={600}
            value={form.bio}
            placeholder="Class 11, physics and maths. Preparing for JEE, happy to help with organic chemistry."
            onChange={(event) => setForm({ ...form, bio: event.target.value })}
          />
        </Field>

        <Field label="Class" hint="Used to pitch explanations at the right level.">
          <VroqnSelectMenu
            label="Class"
            value={form.classLevel || null}
            options={CLASS_LEVELS}
            onChange={(value) => setForm({ ...form, classLevel: value })}
            placeholder="Choose your class"
          />
        </Field>

        <Field label="Board">
          <VroqnSelectMenu
            label="Board"
            value={form.board || null}
            options={BOARDS}
            onChange={(value) => setForm({ ...form, board: value })}
            placeholder="Choose your board"
          />
        </Field>

        <Field label="Interests" hint="Comma separated, up to 12. Shown as small tags on your profile.">
          <TextInput
            value={form.interests}
            placeholder="Physics, Astronomy, Chess"
            onChange={(event) => setForm({ ...form, interests: event.target.value })}
          />
        </Field>

        <Field label="Accent colour" hint="Used for your avatar ring and profile highlights. Interface colours stay consistent everywhere else.">
          <div className="flex flex-wrap gap-2">
            {ACCENTS.map((accent) => (
              <button
                key={accent.value}
                type="button"
                aria-label={accent.label}
                aria-pressed={form.accent === accent.value}
                onClick={() => setForm({ ...form, accent: accent.value })}
                className={[
                  'vroqn-tap h-10 w-10 rounded-full border-2 transition-transform',
                  form.accent === accent.value ? 'scale-105 border-[var(--color-text)]' : 'border-transparent',
                ].join(' ')}
                style={{ background: accent.value }}
              />
            ))}
          </div>
        </Field>
      </div>
    </VroqnSheet>
  );
}

/** Privacy + messaging controls. Each switch saves immediately — no hidden "Save" to forget. */
function PrivacyCard({ profile, onSaved }: { profile: ProfileView; onSaved: (next: ProfileView) => void }) {
  const toast = useToast();
  const [busy, setBusy] = useState(false);
  const [local, setLocal] = useState(profile);

  useEffect(() => setLocal(profile), [profile]);

  const patch = async (next: Partial<ProfileView> & Record<string, unknown>, successMessage: string) => {
    setBusy(true);
    try {
      const updated = await profileApi.update(next);
      setLocal(updated);
      onSaved(updated);
      toast.push({ tone: 'success', title: successMessage });
    } catch (err) {
      toast.push({ tone: 'error', title: 'Could not save that', detail: (err as Error).message });
    } finally {
      setBusy(false);
    }
  };

  return (
    <Card>
      <CardHeader title="Privacy" subtitle="Who can see what — you decide, per area" />
      <div className="space-y-4 p-4">
        <Field label="Profile visibility" hint="Private profiles hide your bio and details from students you have no community with.">
          <Segmented
            label="Profile visibility"
            value={local.visibility.profile}
            onChange={(value) =>
              void patch(
                { profileVisibility: value },
                value === 'private' ? 'Profile is now private' : value === 'members' ? 'Visible to your communities' : 'Profile is now public',
              )
            }
            options={[
              { value: 'public' as const, label: 'Public', hint: 'Any student can see your bio' },
              { value: 'members' as const, label: 'Communities', hint: 'Only students in a shared community' },
              { value: 'private' as const, label: 'Private', hint: 'Bio and details stay hidden' },
            ]}
          />
        </Field>

        <Switch
          checked={local.visibility.activity}
          onChange={(value) => void patch({ activityVisible: value }, value ? 'Activity visible' : 'Activity hidden')}
          label="Show my learning activity"
          description="Totals from practice, mock exams and Arena. Never shows answers, question content or scores."
        />
        <Switch
          checked={local.visibility.communities}
          onChange={(value) => void patch({ communitiesVisible: value }, value ? 'Communities visible' : 'Communities hidden')}
          label="Show my communities"
          description="Lists the groups you are in. It never reveals anything posted inside a private community."
        />
        <Switch
          checked={local.visibility.achievements}
          onChange={(value) => void patch({ achievementsVisible: value }, value ? 'Badges visible' : 'Badges hidden')}
          label="Show my badges"
          description="Badges earned from real activity in communities."
        />

        <Field label="Who can start a conversation with you" hint="Existing conversations continue either way.">
          <Segmented
            label="Direct message policy"
            value={local.visibility.dmPolicy}
            onChange={(value) =>
              void (async () => {
                try {
                  await messagesApi.setPolicy(value as DmPolicy);
                  const next = { ...local, visibility: { ...local.visibility, dmPolicy: value as DmPolicy } };
                  setLocal(next);
                  onSaved(next);
                  toast.push({ tone: 'success', title: 'Messaging policy updated' });
                } catch (err) {
                  toast.push({ tone: 'error', title: 'Could not save that', detail: (err as Error).message });
                }
              })()
            }
            options={[
              { value: 'everyone' as DmPolicy, label: 'Everyone' },
              { value: 'communities' as DmPolicy, label: 'My communities' },
              { value: 'nobody' as DmPolicy, label: 'Nobody' },
            ]}
          />
        </Field>

        <p className="text-[11.5px] leading-relaxed text-[var(--color-muted-dim)]">
          Private messages are never used for AI, analytics or search, and never shown to community moderators.
          {busy ? ' Saving…' : ''}
        </p>
      </div>
    </Card>
  );
}

/** Small helper used by tests and the "back" affordance in the profile header. */
export function ProfileBackLink() {
  return (
    <Link to="/" className="inline-flex items-center gap-1.5 text-[12.5px] text-[var(--color-muted)] hover:text-[var(--color-text)]">
      <ArrowLeft size={14} /> Home
    </Link>
  );
}

export { VroqnIconButton, EmptyState, Spinner };
