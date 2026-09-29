/**
 * Manage tab (§32–§34, §39, §40, §45).
 *
 * Everything an owner, admin or moderator needs, in one place, split into sections they can reach:
 * settings, join requests, invites, roles and moderation queue, analytics. Each section is only
 * rendered when the server said the caller has that capability, and every one of these actions is
 * authorised again on the server — hiding a button is not the protection.
 */
import { useState } from 'react';
import {
  BarChart3,
  Check,
  Copy,
  Crown,
  Minus,
  Settings2,
  ShieldAlert,
  Ticket,
  UserCheck,
  X,
} from 'lucide-react';
import {
  Badge,
  Button,
  Card,
  EmptyState,
  ErrorState,
  Field,
  LoadingState,
  Modal,
  Skeleton,
  ProgressBar,
  Segmented,
  StatTile,
  Switch,
  TextArea,
  TextInput,
} from '../../../components/ui';
import { VroqnFilterSelect } from '../../../components/vroqn';
import { useConfirm } from '../../../components/Confirm';
import { useToast } from '../../../hooks/useToast';
import { CommunitySection, VisibilityBadge } from '../components';
import {
  communitiesApi,
  type CommunityAnalytics,
  type CommunityDetail,
  type ReportView,
} from '../api';
import { useAction, useRemote } from '../useCommunities';

type Section = 'settings' | 'requests' | 'invites' | 'roles' | 'queue' | 'insights';

const CATEGORIES = [
  'ai',
  'coding',
  'jee',
  'neet',
  'mathematics',
  'physics',
  'chemistry',
  'school',
  'class_9',
  'class_10',
  'class_11',
  'class_12',
  'competitive_exams',
  'projects',
  'programming',
];

export function ManageTab({
  community,
  onOpenMembers,
}: {
  community: CommunityDetail;
  /** Takes the owner to the Members tab, which is where a new owner is actually chosen. */
  onOpenMembers: () => void;
}) {
  const [section, setSection] = useState<Section>(community.capabilities.manage_join_requests ? 'requests' : 'settings');

  const sections: { id: Section; label: string }[] = [
    ...(community.capabilities.update_community ? [{ id: 'settings' as Section, label: 'Settings' }] : []),
    ...(community.capabilities.manage_join_requests ? [{ id: 'requests' as Section, label: 'Join requests' }] : []),
    ...(community.capabilities.manage_invites ? [{ id: 'invites' as Section, label: 'Invites' }] : []),
    ...(community.capabilities.manage_roles ? [{ id: 'roles' as Section, label: 'Roles & rules' }] : []),
    ...(community.capabilities.moderate_reports || community.capabilities.moderate_messages
      ? [{ id: 'queue' as Section, label: 'Moderation' }]
      : []),
    ...(community.capabilities.view_analytics ? [{ id: 'insights' as Section, label: 'Insights' }] : []),
  ];

  if (sections.length === 0) {
    return (
      <EmptyState
        icon={<ShieldAlert size={22} />}
        title="Nothing to manage here"
        description="You do not have moderation or administration permissions in this community."
      />
    );
  }

  return (
    <div className="space-y-4">
      <Segmented
        label="Management sections"
        value={section}
        onChange={(next) => setSection(next as Section)}
        options={sections.map((entry) => ({ value: entry.id, label: entry.label }))}
      />

      {section === 'settings' ? <SettingsSection community={community} onOpenMembers={onOpenMembers} /> : null}
      {section === 'requests' ? <RequestsSection community={community} /> : null}
      {section === 'invites' ? <InvitesSection community={community} /> : null}
      {section === 'roles' ? <RolesSection community={community} /> : null}
      {section === 'queue' ? <QueueSection community={community} /> : null}
      {section === 'insights' ? <InsightsSection community={community} /> : null}
    </div>
  );
}

/* ------------------------------------------------------------------ settings -------------------- */

function SettingsSection({
  community,
  onOpenMembers,
}: {
  community: CommunityDetail;
  onOpenMembers: () => void;
}) {
  const { busy, run } = useAction();
  const confirm = useConfirm();
  const toast = useToast();
  const [form, setForm] = useState({
    name: community.name,
    description: community.description,
    category: community.category,
    visibility: community.visibility,
    rules: community.rules,
    joinRequirements: community.joinRequirements,
    welcomeMessage: community.welcomeMessage,
    memberLimit: community.memberLimit ? String(community.memberLimit) : '',
    isLeaderboardEnabled: community.isLeaderboardEnabled,
    tags: community.tags.join(', '),
  });
  const [saved, setSaved] = useState(false);

  const save = async () => {
    const updated = await run(
      () =>
        communitiesApi.update(community.id, {
          name: form.name.trim(),
          description: form.description.trim(),
          category: form.category,
          visibility: form.visibility,
          rules: form.rules,
          joinRequirements: form.joinRequirements,
          welcomeMessage: form.welcomeMessage,
          memberLimit: form.memberLimit ? Number(form.memberLimit) : null,
          isLeaderboardEnabled: form.isLeaderboardEnabled,
          tags: form.tags
            .split(',')
            .map((tag) => tag.trim())
            .filter(Boolean),
        }),
      { success: 'Settings saved', failure: 'Could not save the settings' },
    );
    if (updated) setSaved(true);
  };

  const destroy = async () => {
    const ok = await confirm({
      title: `Delete “${community.name}”?`,
      description:
        'The community, its chat, doubts, resources, challenges and memberships are removed for everyone. This cannot be undone.',
      confirmLabel: 'Delete this community',
      tone: 'danger',
    });
    if (!ok) return;
    const done = await run(() => communitiesApi.remove(community.id), { failure: 'Could not delete the community' });
    if (done) window.location.assign('/communities');
  };

  /**
   * The button that used to talk instead of act.
   *
   * It showed a confirmation, then a toast telling the student to find a "Make owner" control on the
   * Members tab — a control that did not exist, because nothing ever called the transfer endpoint. It
   * now goes straight to the place where the choice is made, and the gesture there does the work.
   */
  const transfer = () => {
    toast.push({
      tone: 'info',
      title: 'Choose the new owner from the Members list',
      detail: 'Open Members and use “Make owner” on the person taking over.',
    });
    onOpenMembers();
  };

  return (
    <div className="space-y-4">
      <CommunitySection title="Community details" description="These are what a student sees before joining.">
        <div className="grid gap-3">
          <Field label="Name">
            <TextInput value={form.name} maxLength={80} onChange={(event) => setForm({ ...form, name: event.target.value })} />
          </Field>
          <Field label="Description" hint="What is this community for? One or two clear sentences.">
            <TextArea rows={3} value={form.description} maxLength={600} onChange={(event) => setForm({ ...form, description: event.target.value })} />
          </Field>
          <div className="grid gap-3 sm:grid-cols-3">
            <Field label="Category">
              <VroqnFilterSelect
                label="Category"
                value={form.category}
                onChange={(next) => setForm({ ...form, category: next })}
                placeholder="Choose a category"
                options={CATEGORIES.map((value) => ({ value, label: value.replace('_', ' ') }))}
              />
            </Field>
            <Field label="Who can join">
              <VroqnFilterSelect
                label="Who can join"
                value={form.visibility}
                onChange={(next) => setForm({ ...form, visibility: next })}
                placeholder="Choose who can join"
                options={[
                  { value: 'public', label: 'Public', hint: 'Anyone joins instantly' },
                  { value: 'private', label: 'Private', hint: 'You approve each request' },
                  { value: 'invite_only', label: 'Invite only', hint: 'A join code is needed' },
                ]}
              />
            </Field>
            <Field label="Member limit" hint="Empty means no limit.">
              <TextInput
                value={form.memberLimit}
                inputMode="numeric"
                onChange={(event) => setForm({ ...form, memberLimit: event.target.value.replace(/[^0-9]/g, '') })}
              />
            </Field>
          </div>
          <Field label="Tags" hint="Comma separated. They help students find you.">
            <TextInput value={form.tags} onChange={(event) => setForm({ ...form, tags: event.target.value })} />
          </Field>
        </div>
      </CommunitySection>

      <CommunitySection title="Rules, welcome and culture" description="New members see the welcome note once, and the rules are always one tap away.">
        <div className="grid gap-3">
          <Field label="Rules">
            <TextArea rows={5} value={form.rules} maxLength={4000} onChange={(event) => setForm({ ...form, rules: event.target.value })} />
          </Field>
          <Field label="Join requirements" hint="Shown on private communities so people know what to write.">
            <TextArea
              rows={3}
              value={form.joinRequirements}
              maxLength={1000}
              onChange={(event) => setForm({ ...form, joinRequirements: event.target.value })}
            />
          </Field>
          <Field label="Welcome message">
            <TextArea
              rows={3}
              value={form.welcomeMessage}
              maxLength={1000}
              onChange={(event) => setForm({ ...form, welcomeMessage: event.target.value })}
            />
          </Field>
          <div className="flex items-start justify-between gap-4 rounded-xl border border-[var(--color-border)] p-3">
            <div className="min-w-0">
              <p className="text-[13px] font-medium text-[var(--color-text)]">Show the contribution leaderboard</p>
              <p className="mt-0.5 text-[12px] text-[var(--color-muted)]">
                When off, no ranking is computed at all. Some communities are healthier without one.
              </p>
            </div>
            <Switch
              checked={form.isLeaderboardEnabled}
              onChange={(next) => setForm({ ...form, isLeaderboardEnabled: next })}
              label="Leaderboard"
            />
          </div>
        </div>
      </CommunitySection>

      <div className="flex flex-wrap items-center gap-2">
        <Button variant="primary" loading={busy} onClick={save}>
          Save changes
        </Button>
        {saved && !busy ? <Badge tone="success">Saved</Badge> : null}
      </div>

      <CommunitySection title="Ownership" description="Ownership transfer and deletion are irreversible, so both ask for confirmation.">
        <div className="flex flex-wrap items-center gap-2">
          <VisibilityBadge visibility={community.visibility} />
          <Button variant="secondary" icon={<Crown size={14} />} onClick={transfer}>
            Transfer ownership
          </Button>
          <Button variant="danger" onClick={() => void destroy()}>
            Delete community
          </Button>
        </div>
      </CommunitySection>
    </div>
  );
}

/* ------------------------------------------------------------------ join requests --------------- */

function RequestsSection({ community }: { community: CommunityDetail }) {
  const requests = useRemote<{
    requests: { id: string; userId: string; name: string; classLevel: string | null; reason: string; createdAt: string }[];
  }>(`/communities/${community.id}/join-requests`);
  const { busy, run } = useAction();

  const decide = async (requestId: string, approve: boolean, name: string) => {
    const done = await run(() => communitiesApi.decideRequest(community.id, requestId, approve), {
      success: approve ? `${name} is now a member` : 'Request declined',
      failure: 'Could not record that decision',
    });
    if (done) void requests.refresh();
  };

  if (requests.loading && !requests.data) return <LoadingState message="Loading requests…" className="py-10" />;
  if (requests.error) return <ErrorState title="Could not load join requests" message={requests.error} onRetry={() => void requests.refresh()} />;

  const list = requests.data?.requests ?? [];

  return (
    <CommunitySection
      title={`${list.length} pending ${list.length === 1 ? 'request' : 'requests'}`}
      description="People waiting to join. Their answers to your join requirements are shown so you can decide fairly."
    >
      {list.length === 0 ? (
        <EmptyState icon={<UserCheck size={20} />} title="No pending requests" description="Nothing is waiting. New requests appear here and in your notifications." />
      ) : (
        <div className="space-y-2">
          {list.map((request) => (
            <Card key={request.id} className="space-y-2 p-3.5">
              <div className="flex flex-wrap items-center gap-2">
                <span className="text-[13px] font-medium text-[var(--color-text)]">{request.name}</span>
                {request.classLevel ? <Badge tone="muted">{request.classLevel}</Badge> : null}
                <time className="text-[11.5px] text-[var(--color-muted-dim)]">
                  asked {new Date(request.createdAt).toLocaleDateString(undefined, { day: 'numeric', month: 'short' })}
                </time>
              </div>
              {request.reason ? (
                <p className="whitespace-pre-wrap rounded-lg bg-[var(--color-surface)] p-2.5 text-[12.5px] text-[var(--color-muted)]">
                  {request.reason}
                </p>
              ) : (
                <p className="text-[12px] italic text-[var(--color-muted-dim)]">No reason given.</p>
              )}
              <div className="flex flex-wrap items-center gap-2">
                <Button size="sm" variant="primary" icon={<Check size={13} />} loading={busy} onClick={() => void decide(request.id, true, request.name)}>
                  Approve
                </Button>
                <Button size="sm" variant="ghost" icon={<X size={13} />} loading={busy} onClick={() => void decide(request.id, false, request.name)}>
                  Decline
                </Button>
              </div>
            </Card>
          ))}
        </div>
      )}
    </CommunitySection>
  );
}

/* ------------------------------------------------------------------ invites --------------------- */

function InvitesSection({ community }: { community: CommunityDetail }) {
  const invites = useRemote<{
    invites: { id: string; code: string; expiresAt: string | null; maxUses: number | null; useCount: number; isRevoked: boolean; isExpired: boolean; createdAt: string }[];
  }>(`/communities/${community.id}/invites`);
  const { busy, run } = useAction();
  const confirm = useConfirm();
  const toast = useToast();
  const [maxUses, setMaxUses] = useState('10');
  const [days, setDays] = useState('14');
  const [creating, setCreating] = useState(false);

  const create = async () => {
    const expiresAt = days ? new Date(Date.now() + Number(days) * 86_400_000).toISOString() : null;
    const created = await run(
      () => communitiesApi.createInvite(community.id, { maxUses: maxUses ? Number(maxUses) : null, expiresAt }),
      { success: 'Invite code created', failure: 'Could not create an invite' },
    );
    if (created) {
      setCreating(false);
      void invites.refresh();
      toast.push({ tone: 'info', title: `Code ${created.code}`, detail: 'Copy it and share it only with the people you want in.' });
    }
  };

  const revoke = async (id: string) => {
    const ok = await confirm({
      title: 'Revoke this invite code?',
      description: 'Anyone who has not used it yet will no longer be able to join with it. Members who already joined stay.',
      confirmLabel: 'Revoke code',
      tone: 'danger',
    });
    if (!ok) return;
    const done = await run(() => communitiesApi.revokeInvite(community.id, id), {
      success: 'Invite revoked',
      failure: 'Could not revoke that invite',
    });
    if (done) void invites.refresh();
  };

  const copy = async (code: string) => {
    try {
      await navigator.clipboard.writeText(code);
      toast.push({ tone: 'success', title: 'Code copied' });
    } catch {
      toast.push({ tone: 'info', title: 'Copy it manually', detail: code });
    }
  };

  return (
    <CommunitySection
      title="Invite links"
      description="Codes are single-purpose: set how many people may use one and when it stops working."
      action={
        <Button size="sm" variant="secondary" icon={<Ticket size={14} />} onClick={() => setCreating(true)}>
          New invite code
        </Button>
      }
    >
      {invites.loading && !invites.data ? (
        <LoadingState message="Loading invites…" className="py-8" />
      ) : invites.error ? (
        <ErrorState title="Could not load invites" message={invites.error} onRetry={() => void invites.refresh()} />
      ) : (invites.data?.invites.length ?? 0) === 0 ? (
        <EmptyState
          icon={<Ticket size={20} />}
          title="No invite codes"
          description="No codes yet. An invite-only community stays closed until you create one."
        />
      ) : (
        <div className="space-y-2">
          {(invites.data?.invites ?? []).map((invite) => {
            const dead = invite.isRevoked || invite.isExpired || (invite.maxUses !== null && invite.useCount >= invite.maxUses);
            return (
              <Card key={invite.id} className="flex flex-wrap items-center gap-3 p-3">
                <code className="rounded-lg bg-[var(--color-surface)] px-2.5 py-1.5 text-[13px] tracking-wider text-[var(--color-text)]">
                  {invite.code}
                </code>
                <span className="min-w-0 flex-1 text-[11.5px] text-[var(--color-muted-dim)]">
                  used {invite.useCount}
                  {invite.maxUses !== null ? ` / ${invite.maxUses}` : ''} times
                  {invite.expiresAt ? ` · expires ${new Date(invite.expiresAt).toLocaleDateString()}` : ' · no expiry'}
                </span>
                {dead ? <Badge tone="muted">No longer usable</Badge> : <Badge tone="success">Active</Badge>}
                <Button size="sm" variant="ghost" icon={<Copy size={13} />} onClick={() => void copy(invite.code)}>
                  Copy
                </Button>
                {invite.isRevoked ? null : (
                  <Button size="sm" variant="ghost" onClick={() => void revoke(invite.id)}>
                    Revoke
                  </Button>
                )}
              </Card>
            );
          })}
        </div>
      )}

      <Modal
        open={creating}
        onClose={() => setCreating(false)}
        title="New invite code"
        description="Limit it. A code with no limit and no expiry is the same as making the community public."
        footer={
          <div className="flex justify-end gap-2">
            <Button variant="ghost" onClick={() => setCreating(false)}>
              Cancel
            </Button>
            <Button variant="primary" loading={busy} onClick={create}>
              Create code
            </Button>
          </div>
        }
      >
        <div className="grid gap-3 sm:grid-cols-2">
          <Field label="Maximum uses" hint="Empty for unlimited.">
            <TextInput value={maxUses} inputMode="numeric" onChange={(event) => setMaxUses(event.target.value.replace(/[^0-9]/g, ''))} />
          </Field>
          <Field label="Expires in (days)" hint="Empty for never.">
            <TextInput value={days} inputMode="numeric" onChange={(event) => setDays(event.target.value.replace(/[^0-9]/g, ''))} />
          </Field>
        </div>
      </Modal>
    </CommunitySection>
  );
}

/* ------------------------------------------------------------------ roles & rules --------------- */

function RolesSection({ community }: { community: CommunityDetail }) {
  /*
   * The matrix is read from the server rather than hand-written here: `GET /:id/permissions` renders
   * the same table the route guards consult, so what this screen says a role can do is exactly what
   * the server will allow. That matters more than an editable grid would — a permission table that
   * drifts from enforcement is worse than no table at all, and the brief's escalation rules (§13) are
   * safest with one fixed matrix.
   */
  const permissions = useRemote<{
    groups: { id: string; label: string; capabilities: { capability: string; label: string; description: string }[] }[];
    roles: string[];
    matrix: Record<string, Record<string, boolean>>;
    mine: { role: string; capabilities: Record<string, boolean> };
  }>(community.capabilities.manage_roles ? `/communities/${community.id}/permissions` : null);

  const roleLabel = (role: string) => role.charAt(0).toUpperCase() + role.slice(1);
  const canManage = community.capabilities.manage_roles;
  const data = permissions.data;
  const mineAllowed = data
    ? data.groups
        .flatMap((group) => group.capabilities)
        .filter((entry) => data.mine.capabilities[entry.capability])
        .map((entry) => entry.label)
    : [];

  return (
    <div className="space-y-4">
      <CommunitySection
        title="Your effective permissions"
        description={
          community.myRole
            ? `As ${roleLabel(community.myRole)} in this community, the server currently allows you ${mineAllowed.length} action${mineAllowed.length === 1 ? '' : 's'}.`
            : 'You are not a member of this community.'
        }
      >
        {!canManage ? (
          <p className="text-[12.5px] leading-relaxed text-[var(--color-muted)]">
            Only owners and admins can see the full role table. What your own role can do is decided by the server every time you
            act — hiding a button never grants anything.
          </p>
        ) : permissions.loading ? (
          <Skeleton className="h-24 w-full" rounded="lg" />
        ) : permissions.error ? (
          <ErrorState message={permissions.error} onRetry={() => void permissions.refresh()} />
        ) : data ? (
          <ul className="grid gap-1.5 sm:grid-cols-2">
            {mineAllowed.map((label) => (
              <li key={label} className="flex items-center gap-2 rounded-[10px] border border-[var(--color-border)] px-3 py-2 text-[12.5px]">
                <Check size={14} className="shrink-0 text-[var(--color-success)]" />
                {label}
              </li>
            ))}
          </ul>
        ) : null}
      </CommunitySection>

      {canManage && data ? (
        <CommunitySection
          title="What each role can do"
          description="Fixed by Vroqn Nexus and enforced on the server. There are no per-community overrides, so a role cannot be given more than it has here."
        >
          <div className="space-y-4">
            {data.groups.map((group) => (
              <div key={group.id} className="space-y-2">
                <p className="text-[11.5px] font-semibold uppercase tracking-wide text-[var(--color-muted-dim)]">{group.label}</p>
                <div className="overflow-x-auto">
                  <table className="w-full min-w-[560px] text-left text-[12.5px]">
                    <caption className="sr-only">{group.label} permissions by role</caption>
                    <thead className="text-[11px] uppercase tracking-wide text-[var(--color-muted-dim)]">
                      <tr>
                        <th scope="col" className="py-2 pr-3">Action</th>
                        {data.roles.map((role) => (
                          <th key={role} scope="col" className="py-2 pr-3 text-center">
                            {roleLabel(role)}
                          </th>
                        ))}
                      </tr>
                    </thead>
                    <tbody>
                      {group.capabilities.map((entry) => (
                        <tr key={entry.capability} className="border-t border-[var(--color-border)]">
                          <th scope="row" className="py-2 pr-3 text-left font-normal align-top">
                            <span className="block text-[12.5px] font-medium text-[var(--color-text)]">{entry.label}</span>
                            <span className="block text-[11.5px] leading-snug text-[var(--color-muted)]">{entry.description}</span>
                          </th>
                          {data.roles.map((role) => {
                            const allowed = Boolean(data.matrix[role]?.[entry.capability]);
                            return (
                              <td key={role} className="py-2 pr-3 text-center align-top">
                                {allowed ? (
                                  <Check size={15} className="mx-auto text-[var(--color-success)]" aria-label="Allowed" />
                                ) : (
                                  <Minus size={15} className="mx-auto text-[var(--color-muted-dim)]" aria-label="Not allowed" />
                                )}
                              </td>
                            );
                          })}
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </div>
            ))}
          </div>
        </CommunitySection>
      ) : null}

      <CommunitySection title="Your rules" description="Members can read these from the community header at any time.">
        {community.rules ? (
          <p className="whitespace-pre-wrap text-[13px] leading-relaxed text-[var(--color-text)]">{community.rules}</p>
        ) : (
          <p className="text-[12.5px] italic text-[var(--color-muted-dim)]">
            No rules written yet. A short, specific list prevents most moderation work later.
          </p>
        )}
      </CommunitySection>
    </div>
  );
}

/* ------------------------------------------------------------------ moderation queue ----------- */

function QueueSection({ community }: { community: CommunityDetail }) {
  const [status, setStatus] = useState<'open' | 'resolved' | 'dismissed'>('open');
  const reports = useRemote<{ reports: ReportView[] }>(`/communities/${community.id}/reports?status=${status}`, [status]);
  const log = useRemote<{
    actions: { id: string; action: string; reason: string; targetType: string; targetId: string; createdAt: string; actorName: string; targetName: string | null }[];
  }>(`/communities/${community.id}/moderation`);
  const { busy, run } = useAction();
  const [note, setNote] = useState('');

  const resolve = async (report: ReportView, action: 'dismiss' | 'remove_content' | 'warn' | 'mute' | 'remove_member') => {
    const done = await run(() => communitiesApi.resolveReport(community.id, report.id, { action, note }), {
      success: 'Moderation action recorded',
      failure: 'Could not record that action',
    });
    if (done) {
      setNote('');
      void reports.refresh();
      void log.refresh();
    }
  };

  return (
    <div className="space-y-4">
      <CommunitySection
        title="Reports"
        description="Students report messages, doubts, answers, resources and profiles. Every decision is written to the audit trail below."
        action={
          <VroqnFilterSelect
            label="Report status"
            value={status}
            onChange={setStatus}
            size="sm"
            options={[
              { value: 'open', label: 'Open', hint: 'Waiting for a moderator' },
              { value: 'resolved', label: 'Resolved', hint: 'Action was taken' },
              { value: 'dismissed', label: 'Dismissed', hint: 'No action needed' },
            ]}
          />
        }
      >
        {reports.loading && !reports.data ? (
          <LoadingState message="Loading the queue…" className="py-8" />
        ) : reports.error ? (
          <ErrorState title="Could not load reports" message={reports.error} onRetry={() => void reports.refresh()} />
        ) : (reports.data?.reports.length ?? 0) === 0 ? (
          <EmptyState icon={<ShieldAlert size={20} />} title={`No ${status} reports`} description={`No ${status} reports. That is a good sign.`} />
        ) : (
          <div className="space-y-2">
            {(reports.data?.reports ?? []).map((report) => (
              <Card key={report.id} className="space-y-2 p-3.5">
                <div className="flex flex-wrap items-center gap-2">
                  <Badge tone={report.status === 'open' ? 'warning' : report.status === 'resolved' ? 'success' : 'muted'}>{report.status}</Badge>
                  <Badge tone="muted">{report.targetType}</Badge>
                  <Badge tone="muted">{report.reason.replace('_', ' ')}</Badge>
                  <span className="text-[11.5px] text-[var(--color-muted-dim)]">
                    by {report.reporterName} · {new Date(report.createdAt).toLocaleString()}
                  </span>
                </div>
                {report.preview ? (
                  <p className="rounded-lg bg-[var(--color-surface)] p-2.5 text-[12.5px] text-[var(--color-muted)]">{report.preview}</p>
                ) : null}
                {report.details ? <p className="text-[12.5px] text-[var(--color-muted)]">{report.details}</p> : null}
                {report.status === 'open' ? (
                  <div className="space-y-2">
                    <TextArea
                      rows={2}
                      value={note}
                      maxLength={400}
                      onChange={(event) => setNote(event.target.value)}
                      placeholder="Note for the audit trail (optional)"
                    />
                    <div className="flex flex-wrap gap-2">
                      <Button size="sm" variant="secondary" loading={busy} onClick={() => void resolve(report, 'dismiss')}>
                        Dismiss
                      </Button>
                      <Button size="sm" variant="secondary" loading={busy} onClick={() => void resolve(report, 'warn')}>
                        Warn the author
                      </Button>
                      <Button size="sm" variant="danger" loading={busy} onClick={() => void resolve(report, 'remove_content')}>
                        Remove the content
                      </Button>
                      <Button size="sm" variant="danger" loading={busy} onClick={() => void resolve(report, 'mute')}>
                        Mute 24 hours
                      </Button>
                      <Button size="sm" variant="danger" loading={busy} onClick={() => void resolve(report, 'remove_member')}>
                        Remove from community
                      </Button>
                    </div>
                  </div>
                ) : (
                  <p className="text-[12px] text-[var(--color-muted-dim)]">
                    {report.resolution ? `Decision: ${report.resolution}` : 'No note recorded.'}
                  </p>
                )}
              </Card>
            ))}
          </div>
        )}
      </CommunitySection>

      <CommunitySection title="Audit trail" description="Who did what, and why. Read-only — nothing here can be edited or deleted from the app.">
        {log.loading && !log.data ? (
          <LoadingState message="Loading the audit trail…" className="py-8" />
        ) : (log.data?.actions.length ?? 0) === 0 ? (
          <EmptyState icon={<ShieldAlert size={20} />} title="Nothing in the audit trail" description="No moderation actions have been taken yet." />
        ) : (
          <ul className="space-y-1.5">
            {(log.data?.actions ?? []).map((action) => (
              <li key={action.id} className="flex flex-wrap items-center gap-2 border-b border-[var(--color-border)] pb-1.5 text-[12.5px] last:border-0">
                <Badge tone="muted">{action.action.replace('_', ' ')}</Badge>
                <span className="text-[var(--color-text)]">
                  {action.actorName} → {action.targetName ?? action.targetType}
                </span>
                <span className="text-[var(--color-muted-dim)]">{action.reason || 'no reason recorded'}</span>
                <time className="ml-auto text-[11px] text-[var(--color-muted-dim)]">{new Date(action.createdAt).toLocaleString()}</time>
              </li>
            ))}
          </ul>
        )}
      </CommunitySection>
    </div>
  );
}

/* ------------------------------------------------------------------ insights ------------------- */

function InsightsSection({ community }: { community: CommunityDetail }) {
  const analytics = useRemote<CommunityAnalytics>(`/communities/${community.id}/analytics`);

  if (analytics.loading && !analytics.data) return <LoadingState message="Working out the numbers…" className="py-12" />;
  if (analytics.error) return <ErrorState title="Could not load analytics" message={analytics.error} onRetry={() => void analytics.refresh()} />;
  if (!analytics.data) return <EmptyState icon={<BarChart3 size={20} />} title="No analytics yet" description="Numbers appear once members start taking part." />;

  const { summary, growth, digest, trend } = analytics.data;
  const peak = Math.max(1, ...trend.map((day) => day.messages + day.doubts + day.answers + day.resources + day.challengeDays));

  return (
    <div className="space-y-4">
      <div className="grid gap-2 sm:grid-cols-3">
        <StatTile label="Members" value={summary.totalMembers} sub={`${summary.newMembers7d} joined this week`} />
        <StatTile label="Active this week" value={summary.activeMembers} sub="Wrote, answered or took part" />
        <StatTile
          label="Challenge completion"
          value={summary.challengeCompletionPercent === null ? '—' : `${summary.challengeCompletionPercent}%`}
          sub={summary.challengeCompletionPercent === null ? 'No challenge days ticked yet' : 'Average across participants'}
        />
        <StatTile label="Helpful answers" value={summary.helpfulAnswerCount} sub="Marked by the students who asked" />
        <StatTile label="Doubts" value={summary.doubtCount} sub={`${summary.resourceCount} resources shared`} />
        <StatTile label="Competitions" value={summary.competitionParticipation} sub={`${summary.eventParticipation} event RSVPs`} />
      </div>

      <CommunitySection title="Last 14 days" description="Aggregate activity only. This view never lists who did what.">
        {trend.length === 0 ? (
          <EmptyState icon={<BarChart3 size={20} />} title="Nothing has happened yet" description="Activity from the last fortnight would be charted here." />
        ) : (
          <div className="space-y-1.5">
            {trend.map((day) => {
              const total = day.messages + day.doubts + day.answers + day.resources + day.challengeDays;
              return (
                <div key={day.day} className="flex items-center gap-3">
                  <span className="w-20 shrink-0 text-[11.5px] text-[var(--color-muted-dim)]">
                    {new Date(day.day).toLocaleDateString(undefined, { day: 'numeric', month: 'short' })}
                  </span>
                  <ProgressBar value={total / peak} label={`Activity on ${day.day}`} />
                  <span className="w-10 shrink-0 text-right text-[11.5px] text-[var(--color-muted)]">{total}</span>
                </div>
              );
            })}
          </div>
        )}
      </CommunitySection>

      <div className="grid gap-3 md:grid-cols-2">
        <CommunitySection title="Growth" description={`${growth.joins30d} joined and ${growth.leaves30d} left in the last 30 days.`}>
          <ul className="space-y-1.5 text-[12.5px] text-[var(--color-muted)]">
            <li>
              Active: <strong className="text-[var(--color-text)]">{growth.active}</strong> · muted {growth.muted} · banned {growth.banned}
            </li>
            <li>
              Member limit: {growth.memberLimit === null ? 'none' : growth.memberLimit}
              {growth.memberLimit !== null ? ` · ${Math.max(0, growth.memberLimit - growth.total)} places left` : ''}
            </li>
            <li>Leaderboard: {growth.isLeaderboardEnabled ? 'on' : 'off'}</li>
          </ul>
        </CommunitySection>

        <CommunitySection title="Weekly digest" description="What a member would notice this week.">
          <div className="space-y-2 text-[12.5px]">
            <div>
              <p className="text-[11.5px] uppercase tracking-wide text-[var(--color-muted-dim)]">Top contributors</p>
              {digest.topContributors.length === 0 ? (
                <p className="text-[var(--color-muted)]">Nobody has contributed yet.</p>
              ) : (
                <ul className="mt-1 space-y-0.5">
                  {digest.topContributors.map((person) => (
                    <li key={person.name} className="flex items-center justify-between gap-2">
                      <span className="truncate text-[var(--color-text)]">{person.name}</span>
                      <span className="text-[var(--color-muted)]">
                        {person.contributionPoints} pts · {person.helpfulAnswers} helpful
                      </span>
                    </li>
                  ))}
                </ul>
              )}
            </div>
            <div>
              <p className="text-[11.5px] uppercase tracking-wide text-[var(--color-muted-dim)]">Coming up</p>
              {digest.upcoming.length === 0 ? (
                <p className="text-[var(--color-muted)]">Nothing scheduled.</p>
              ) : (
                <ul className="mt-1 space-y-0.5">
                  {digest.upcoming.map((item, index) => (
                    <li key={`${item.title}-${index}`} className="flex items-center justify-between gap-2">
                      <span className="truncate text-[var(--color-text)]">{item.title}</span>
                      <span className="text-[var(--color-muted)]">{new Date(item.at).toLocaleDateString()}</span>
                    </li>
                  ))}
                </ul>
              )}
            </div>
          </div>
        </CommunitySection>
      </div>

      <Card className="flex items-start gap-3 p-3.5">
        <Settings2 size={15} className="mt-0.5 shrink-0 text-[var(--color-primary)]" />
        <p className="text-[12.5px] leading-relaxed text-[var(--color-muted)]">
          These numbers are aggregated for the whole community. There is no per-student activity feed for moderators to browse,
          because running a study group is not a reason to follow individual students around.
        </p>
      </Card>
    </div>
  );
}
