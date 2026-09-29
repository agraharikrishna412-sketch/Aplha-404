/**
 * Members tab (§32).
 *
 * What you can do to a row is decided by the server and arrives as `canChangeRole` / `canRemove` —
 * the UI never works it out from a role string, and every action is re-checked server-side. The
 * controls appear only where they would actually succeed.
 */
import { useState } from 'react';
import { Crown, Search, ShieldCheck, UserMinus, UserX, VolumeX, Volume2 } from 'lucide-react';
import { Badge, Button, Card, EmptyState, ErrorState, Modal, SkeletonCard, TextInput } from '../../../components/ui';
import { VroqnFilterSelect } from '../../../components/vroqn';
import { useConfirm } from '../../../components/Confirm';
import { CommunitySection, RoleBadge } from '../components';
import { communitiesApi, type CommunityDetail, type CommunityMemberView, type CommunityRole } from '../api';
import { useAction, useDebounced, useRemote } from '../useCommunities';

const ASSIGNABLE: { value: CommunityRole; label: string; blurb: string }[] = [
  { value: 'moderator', label: 'Moderator', blurb: 'Removes messages, mutes and removes members, handles reports.' },
  { value: 'mentor', label: 'Mentor', blurb: 'Guides discussions and can mark helpful answers. No moderation powers.' },
  { value: 'member', label: 'Member', blurb: 'Takes part: chat, doubts, resources, challenges, competitions.' },
];

export function MembersTab({ community }: { community: CommunityDetail }) {
  const [search, setSearch] = useState('');
  const [role, setRole] = useState('');
  const debounced = useDebounced(search, 350);
  const members = useRemote<{ members: CommunityMemberView[]; total: number }>(
    `/communities/${community.id}/members?search=${encodeURIComponent(debounced)}&role=${role}&limit=60`,
    [debounced, role],
  );
  const confirm = useConfirm();
  const { busy, run } = useAction();
  const [managing, setManaging] = useState<CommunityMemberView | null>(null);

  const changeRole = async (member: CommunityMemberView, next: CommunityRole) => {
    const ok = await confirm({
      title: `Make ${member.name} a ${next}?`,
      description:
        next === 'moderator'
          ? 'Moderators can remove messages and members. Only give this to someone you trust to be fair.'
          : 'Their permissions change immediately across the community.',
      confirmLabel: `Set as ${next}`,
      tone: next === 'moderator' ? 'danger' : 'primary',
    });
    if (!ok) return;
    const done = await run(() => communitiesApi.changeRole(community.id, member.userId, next), {
      success: `${member.name} is now a ${next}`,
      failure: 'Could not change that role',
    });
    if (done) {
      setManaging(null);
      void members.refresh();
    }
  };

  /**
   * Hand the community over.
   *
   * The Manage tab used to send students here for a "Make owner" button that did not exist, and the
   * API wrapper had no caller at all — the endpoint worked and nothing in the app could reach it.
   * This is that button: it is only rendered for the owner (the server decides `transfer_ownership`
   * for owners alone), it names the person in the confirmation, and it explains what both people
   * become afterwards.
   */
  const makeOwner = async (member: CommunityMemberView) => {
    const ok = await confirm({
      title: `Make ${member.name} the owner of ${community.name}?`,
      description:
        'They become the owner and can change everything, including deleting the community. You become an admin. Only they can hand ownership back.',
      confirmLabel: 'Transfer ownership',
      tone: 'danger',
    });
    if (!ok) return;
    const done = await run(() => communitiesApi.transfer(community.id, member.userId), {
      success: `${member.name} is now the owner`,
      failure: 'Could not transfer ownership',
    });
    if (done) {
      setManaging(null);
      void members.refresh();
    }
  };

  const remove = async (member: CommunityMemberView) => {
    const ok = await confirm({
      title: `Remove ${member.name}?`,
      description: 'They lose access to this community immediately. Their existing messages stay in place unless you delete them.',
      confirmLabel: 'Remove from community',
      tone: 'danger',
    });
    if (!ok) return;
    const done = await run(() => communitiesApi.kickMember(community.id, member.userId, 'Removed by a moderator'), {
      success: 'Member removed',
      failure: 'Could not remove that member',
    });
    if (done) void members.refresh();
  };

  const toggleMute = async (member: CommunityMemberView) => {
    const done = member.mutedUntil
      ? await run(() => communitiesApi.unmuteMember(community.id, member.userId), { success: 'Unmuted', failure: 'Could not unmute' })
      : await run(() => communitiesApi.muteMember(community.id, member.userId, 24, 'Muted by a moderator'), {
          success: 'Muted for 24 hours',
          failure: 'Could not mute that member',
        });
    if (done) void members.refresh();
  };

  const ban = async (member: CommunityMemberView) => {
    const ok = await confirm({
      title: `Ban ${member.name}?`,
      description:
        'A ban blocks re-joining this community, unlike a removal. Use it only when someone has repeatedly broken the rules after being muted.',
      confirmLabel: 'Ban member',
      tone: 'danger',
    });
    if (!ok) return;
    const done = await run(() => communitiesApi.banMember(community.id, member.userId, true, 'Repeated rule breaking'), {
      success: 'Member banned',
      failure: 'Could not ban that member',
    });
    if (done) void members.refresh();
  };

  if (members.loading && !members.data) {
    return (
      <div className="space-y-2">
        {[0, 1, 2].map((index) => (
          <SkeletonCard key={index} lines={2} />
        ))}
      </div>
    );
  }
  if (members.error) {
    return <ErrorState title="Could not load members" message={members.error} onRetry={() => void members.refresh()} />;
  }

  const list = members.data?.members ?? [];

  return (
    <div className="space-y-4">
      <div className="grid gap-2 sm:grid-cols-[1fr_auto]">
        <div className="relative">
          <Search size={14} className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-[var(--color-muted-dim)]" />
          <label className="sr-only" htmlFor="member-search">
            Search members
          </label>
          <TextInput
            id="member-search"
            value={search}
            onChange={(event) => setSearch(event.target.value)}
            placeholder="Search members by name…"
            className="pl-9"
          />
        </div>
        <VroqnFilterSelect
          label="Filter by role"
          value={role}
          onChange={setRole}
          placeholder="All roles"
          options={[
            { value: '', label: 'All roles' },
            { value: 'owner', label: 'Owner', hint: 'Full control of the community' },
            { value: 'admin', label: 'Admin', hint: 'Manages members and settings' },
            { value: 'moderator', label: 'Moderator', hint: 'Keeps chat and doubts clean' },
            { value: 'mentor', label: 'Mentor', hint: 'Answers doubts' },
            { value: 'member', label: 'Member' },
          ]}
        />
      </div>

      <CommunitySection title={`${members.data?.total ?? list.length} members`} description="Ordered by contribution within each role.">
        {list.length === 0 ? (
          <EmptyState icon={<UserMinus size={20} />} title="No members match" description="Nobody matches that search. Try clearing the filter." />
        ) : (
          <div className="space-y-1.5">
            {list.map((member) => (
              <Card key={member.userId} className="flex flex-wrap items-center gap-3 p-3">
                <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-[var(--color-surface)] text-[12.5px] font-semibold text-[var(--color-text)]">
                  {member.name.slice(0, 2).toUpperCase()}
                </span>
                <span className="min-w-0 flex-1">
                  <span className="flex flex-wrap items-center gap-2">
                    <span className="truncate text-[13px] font-medium text-[var(--color-text)]">{member.name}</span>
                    <RoleBadge role={member.role} />
                    {member.isSelf ? <Badge tone="primary">You</Badge> : null}
                    {member.status === 'muted' ? <Badge tone="warning">Muted</Badge> : null}
                    {member.status === 'banned' ? <Badge tone="error">Banned</Badge> : null}
                  </span>
                  <span className="mt-0.5 block text-[11.5px] text-[var(--color-muted-dim)]">
                    {member.contributionPoints} points · {member.helpfulAnswers} helpful · joined{' '}
                    {new Date(member.joinedAt).toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric' })}
                  </span>
                </span>
                {member.canChangeRole || member.canRemove ? (
                  <span className="flex flex-wrap items-center gap-1.5">
                    {member.canChangeRole ? (
                      <Button size="sm" variant="secondary" icon={<ShieldCheck size={13} />} onClick={() => setManaging(member)}>
                        Role
                      </Button>
                    ) : null}
                    {member.canRemove ? (
                      <Button size="sm" variant="ghost" icon={<VolumeX size={13} />} onClick={() => void toggleMute(member)}>
                        {member.mutedUntil ? 'Unmute' : 'Mute'}
                      </Button>
                    ) : null}
                    {community.myRole === 'owner' && !member.isSelf && member.role !== 'owner' && member.status === 'active' ? (
                      <Button
                        size="sm"
                        variant="ghost"
                        icon={<Crown size={13} />}
                        onClick={() => void makeOwner(member)}
                        disabled={busy}
                      >
                        Make owner
                      </Button>
                    ) : null}
                    {member.canRemove ? (
                      <Button size="sm" variant="ghost" icon={<UserX size={13} />} onClick={() => void remove(member)}>
                        Remove
                      </Button>
                    ) : null}
                  </span>
                ) : null}
              </Card>
            ))}
          </div>
        )}
      </CommunitySection>

      {community.myRole === 'owner' || community.myRole === 'admin' ? (
        <Card className="flex items-start gap-3 p-3.5">
          <Volume2 size={15} className="mt-0.5 shrink-0 text-[var(--color-primary)]" />
          <p className="text-[12.5px] leading-relaxed text-[var(--color-muted)]">
            Removing someone takes away their access. Banning additionally blocks them from re-joining. If a member is simply posting
            too fast, mute first — it is reversible and does not end their membership.
          </p>
        </Card>
      ) : null}

      <Modal
        open={Boolean(managing)}
        onClose={() => setManaging(null)}
        title={managing ? `Change ${managing.name}'s role` : 'Change role'}
        description="Roles decide what someone may do here. Everything is checked on the server."
      >
        <div className="space-y-2">
          {ASSIGNABLE.map((option) => (
            <button
              key={option.value}
              type="button"
              disabled={busy}
              onClick={() => managing && void changeRole(managing, option.value)}
              className={[
                'w-full rounded-xl border px-3 py-2.5 text-left transition',
                managing?.role === option.value
                  ? 'border-[var(--color-primary)]/50 bg-[var(--color-primary)]/[0.06]'
                  : 'border-[var(--color-border)] hover:border-[var(--color-primary)]/40',
              ].join(' ')}
            >
              <span className="flex items-center gap-2">
                <span className="text-[13px] font-medium capitalize text-[var(--color-text)]">{option.label}</span>
                {managing?.role === option.value ? <Badge tone="primary">Current</Badge> : null}
              </span>
              <span className="mt-0.5 block text-[12px] text-[var(--color-muted)]">{option.blurb}</span>
            </button>
          ))}
          <Button
            variant="ghost"
            className="w-full"
            disabled={busy}
            onClick={() => {
              if (managing) void ban(managing);
            }}
          >
            Ban this member instead
          </Button>
        </div>
      </Modal>
    </div>
  );
}
