/**
 * Study teams and group-vs-group challenges (§22, §30).
 *
 * A team is a small standing group inside a community — the thing that actually keeps a student
 * coming back. The standings table is computed from real competition results; when no competition
 * has been played the table says so instead of showing invented numbers.
 */
import { useState } from 'react';
import { Plus, Swords, UserPlus, Users } from 'lucide-react';
import { Badge, Button, Card, EmptyState, ErrorState, Modal, SkeletonCard, TextInput } from '../../../components/ui';
import { VroqnFilterSelect } from '../../../components/vroqn';
import { useConfirm } from '../../../components/Confirm';
import { CommunitySection } from '../components';
import { communitiesApi, type CommunityDetail, type CommunityCompetitionView, type TeamView } from '../api';
import { useAction, useRemote } from '../useCommunities';

interface StandingsRow {
  teamId: string;
  name: string;
  averageScore: number;
  bestScore: number;
  participants: number;
}

export function TeamsTab({ community }: { community: CommunityDetail }) {
  const teams = useRemote<{ teams: TeamView[] }>(`/communities/${community.id}/teams`);
  const competitions = useRemote<{ competitions: CommunityCompetitionView[] }>(`/communities/${community.id}/competitions`);
  const { busy, run } = useAction();
  const confirm = useConfirm();
  const [createOpen, setCreateOpen] = useState(false);
  const [inviteTeam, setInviteTeam] = useState<TeamView | null>(null);

  const finished = (competitions.data?.competitions ?? []).filter(
    (competition) => competition.state === 'RESULTS_PUBLISHED' || competition.state === 'ENDED',
  );
  const [standingsFor, setStandingsFor] = useState<string>('');
  const activeCompetitionId = standingsFor || finished[0]?.id || '';
  const standings = useRemote<{ standings: StandingsRow[] }>(
    activeCompetitionId ? `/communities/${community.id}/teams/standings?competitionId=${activeCompetitionId}` : null,
    [activeCompetitionId],
  );

  const toggleMembership = async (team: TeamView) => {
    const done = await run(() => (team.isMember ? communitiesApi.leaveTeam(community.id, team.id) : communitiesApi.joinTeam(community.id, team.id)), {
      success: team.isMember ? 'You left the team' : 'You joined the team',
      failure: 'Could not update your team',
    });
    if (done) void teams.refresh();
  };

  const removeTeam = async (team: TeamView) => {
    const ok = await confirm({
      title: `Delete “${team.name}”?`,
      description: 'The team and its roster are removed. This cannot be undone.',
      confirmLabel: 'Delete team',
      tone: 'danger',
    });
    if (!ok) return;
    const done = await run(() => communitiesApi.removeTeam(community.id, team.id), {
      success: 'Team deleted',
      failure: 'Could not delete that team',
    });
    if (done) void teams.refresh();
  };

  return (
    <div className="space-y-4">
      <CommunitySection
        title="Study teams"
        description="A small standing group you study with. Teams take part in group-vs-group competitions and can invite members into the group."
        action={
          <Button size="sm" variant="secondary" icon={<Plus size={14} />} onClick={() => setCreateOpen(true)}>
            Create a team
          </Button>
        }
      >
        {teams.loading && !teams.data ? (
          <div className="space-y-2">
            {[0, 1].map((index) => (
              <SkeletonCard key={index} lines={3} />
            ))}
          </div>
        ) : teams.error ? (
          <ErrorState title="Could not load teams" message={teams.error} onRetry={() => void teams.refresh()} />
        ) : (teams.data?.teams.length ?? 0) === 0 ? (
          <EmptyState
            icon={<Users size={22} />}
            title="No teams yet"
            description="Teams of three to five work best. Create one, invite two friends, and use it to prepare together instead of alone."
          />
        ) : (
          <div className="grid gap-3 md:grid-cols-2">
            {(teams.data?.teams ?? []).map((team) => (
              <Card key={team.id} className="space-y-2.5 p-4">
                <div className="flex flex-wrap items-center gap-2">
                  <h3 className="text-[14px] font-semibold text-[var(--color-text)]">{team.name}</h3>
                  {team.isMember ? <Badge tone="success">You are in this team</Badge> : null}
                </div>
                {team.description ? <p className="text-[12.5px] text-[var(--color-muted)]">{team.description}</p> : null}
                {team.goal ? <p className="text-[12px] text-[var(--color-muted-dim)]">Goal: {team.goal}</p> : null}
                <p className="text-[11.5px] text-[var(--color-muted-dim)]">
                  {team.memberCount}
                  {team.memberLimit ? ` / ${team.memberLimit}` : ''} members · led by {team.leadName}
                </p>
                <div className="flex flex-wrap items-center gap-2">
                  <Button
                    size="sm"
                    variant={team.isMember ? 'secondary' : 'primary'}
                    loading={busy}
                    disabled={!team.isMember && team.memberLimit > 0 && team.memberCount >= team.memberLimit}
                    onClick={() => void toggleMembership(team)}
                  >
                    {team.isMember ? 'Leave team' : team.memberLimit > 0 && team.memberCount >= team.memberLimit ? 'Team is full' : 'Join team'}
                  </Button>
                  {team.isMember ? (
                    <Button size="sm" variant="ghost" icon={<UserPlus size={13} />} onClick={() => setInviteTeam(team)}>
                      Invite members
                    </Button>
                  ) : null}
                  {team.canManage ? (
                    <Button size="sm" variant="ghost" onClick={() => void removeTeam(team)}>
                      Delete
                    </Button>
                  ) : null}
                </div>
              </Card>
            ))}
          </div>
        )}
      </CommunitySection>

      <CommunitySection
        title="Group vs group"
        description="Each team's own competition results, averaged. Nothing here is estimated — a team without results simply has no row."
        action={
          finished.length > 1 ? (
            <VroqnFilterSelect
              label="Competition standings"
              value={activeCompetitionId}
              onChange={setStandingsFor}
              size="sm"
              placeholder="Choose a competition"
              options={finished.map((competition) => ({ value: competition.id, label: competition.title }))}
            />
          ) : null
        }
      >
        {finished.length === 0 ? (
          <EmptyState
            icon={<Swords size={22} />}
            title="No finished competition yet"
            description="Once a hosted competition has ended and results are published, the standings for each team appear here."
          />
        ) : standings.loading && !standings.data ? (
          <SkeletonCard lines={4} />
        ) : standings.error ? (
          <ErrorState title="Could not load standings" message={standings.error} onRetry={() => void standings.refresh()} />
        ) : (standings.data?.standings.length ?? 0) === 0 ? (
          <EmptyState
            icon={<Swords size={22} />}
            title="No team took part"
            description="Nobody from a team attempted this competition, so there is no result to compare. Nothing is filled in to make the table look busier."
          />
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full min-w-[420px] text-left text-[12.5px]">
              <caption className="sr-only">Team standings for the selected competition</caption>
              <thead className="text-[11.5px] uppercase tracking-wide text-[var(--color-muted-dim)]">
                <tr>
                  <th scope="col" className="py-2 pr-3">
                    #
                  </th>
                  <th scope="col" className="py-2 pr-3">
                    Team
                  </th>
                  <th scope="col" className="py-2 pr-3">
                    Members who attempted
                  </th>
                  <th scope="col" className="py-2 pr-3">
                    Average score
                  </th>
                  <th scope="col" className="py-2">
                    Best score
                  </th>
                </tr>
              </thead>
              <tbody>
                {(standings.data?.standings ?? []).map((row, index) => (
                  <tr key={row.teamId} className="border-t border-[var(--color-border)]">
                    <td className="py-2 pr-3 text-[var(--color-muted-dim)]">{index + 1}</td>
                    <td className="py-2 pr-3 font-medium text-[var(--color-text)]">{row.name}</td>
                    <td className="py-2 pr-3 text-[var(--color-muted)]">{row.participants}</td>
                    <td className="py-2 pr-3 text-[var(--color-muted)]">{row.averageScore.toFixed(1)}</td>
                    <td className="py-2 text-[var(--color-muted)]">{row.bestScore.toFixed(1)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </CommunitySection>

      <CreateTeam
        communityId={community.id}
        open={createOpen}
        onClose={() => setCreateOpen(false)}
        onCreated={() => {
          setCreateOpen(false);
          void teams.refresh();
        }}
      />
      <InviteMembers
        communityId={community.id}
        team={inviteTeam}
        onClose={() => setInviteTeam(null)}
        onInvited={() => void teams.refresh()}
      />
    </div>
  );
}

function CreateTeam({
  communityId,
  open,
  onClose,
  onCreated,
}: {
  communityId: string;
  open: boolean;
  onClose: () => void;
  onCreated: () => void;
}) {
  const { busy, run } = useAction();
  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  const [goal, setGoal] = useState('');
  const [memberLimit, setMemberLimit] = useState(5);
  const [error, setError] = useState<string | null>(null);

  const submit = async () => {
    setError(null);
    const created = await run(
      () =>
        communitiesApi.createTeam(communityId, {
          name: name.trim(),
          description: description.trim(),
          goal: goal.trim(),
          memberLimit,
        }),
      { failure: 'Could not create the team' },
    );
    if (created) {
      setName('');
      setDescription('');
      setGoal('');
      onCreated();
    } else {
      setError('A team name of at least 3 characters is required, and you can lead three teams at most.');
    }
  };

  return (
    <Modal
      open={open}
      onClose={onClose}
      title="Create a study team"
      description="You will be the team lead and can invite members from this community."
      footer={
        <div className="flex justify-end gap-2">
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button variant="primary" loading={busy} disabled={name.trim().length < 3} onClick={submit}>
            Create team
          </Button>
        </div>
      }
    >
      <div className="space-y-3">
        <div>
          <label className="text-[12.5px] text-[var(--color-muted)]" htmlFor="team-name">
            Team name
          </label>
          <TextInput id="team-name" value={name} onChange={(event) => setName(event.target.value)} maxLength={60} placeholder="Circuit Breakers" />
        </div>
        <div>
          <label className="text-[12.5px] text-[var(--color-muted)]" htmlFor="team-goal">
            What is the team working towards? (optional)
          </label>
          <TextInput id="team-goal" value={goal} onChange={(event) => setGoal(event.target.value)} maxLength={160} placeholder="Finish Class 12 physics revision before November" />
        </div>
        <div>
          <label className="text-[12.5px] text-[var(--color-muted)]" htmlFor="team-description">
            How do you work? (optional)
          </label>
          <textarea
            id="team-description"
            value={description}
            rows={3}
            maxLength={600}
            onChange={(event) => setDescription(event.target.value)}
            className="w-full rounded-xl border border-[var(--color-border)] bg-[var(--color-card)] px-3 py-2 text-[13px] text-[var(--color-text)]"
          />
        </div>
        <div>
          <label className="text-[12.5px] text-[var(--color-muted)]" htmlFor="team-limit">
            Maximum members
          </label>
          <TextInput
            id="team-limit"
            value={String(memberLimit)}
            inputMode="numeric"
            onChange={(event) => setMemberLimit(Math.min(Math.max(Number(event.target.value.replace(/[^0-9]/g, '')) || 2, 2), 20))}
          />
          <p className="mt-1 text-[11.5px] text-[var(--color-muted-dim)]">Between 2 and 20. Small teams finish more.</p>
        </div>
        {error ? <p className="text-[12.5px] text-[var(--color-error)]">{error}</p> : null}
      </div>
    </Modal>
  );
}

/** Invites community members to a team the caller leads. Only real members are offered. */
function InviteMembers({
  communityId,
  team,
  onClose,
  onInvited,
}: {
  communityId: string;
  team: TeamView | null;
  onClose: () => void;
  onInvited: () => void;
}) {
  const { busy, run } = useAction();
  const [selected, setSelected] = useState<string[]>([]);
  const members = useRemote<{ members: { userId: string; name: string; role: string }[] }>(
    team ? `/communities/${communityId}/members?limit=60` : null,
    [team?.id],
  );

  const submit = async () => {
    if (!team) return;
    const result = await run(() => communitiesApi.inviteToTeam(communityId, team.id, selected), {
      success: 'Invites sent',
      failure: 'Could not send those invites',
    });
    if (result) {
      setSelected([]);
      onInvited();
      onClose();
    }
  };

  return (
    <Modal
      open={Boolean(team)}
      onClose={() => {
        setSelected([]);
        onClose();
      }}
      title={team ? `Invite members to ${team.name}` : 'Invite members'}
      description="Invited members get a notification and can accept from the team card."
      footer={
        <div className="flex justify-end gap-2">
          <Button
            variant="ghost"
            onClick={() => {
              setSelected([]);
              onClose();
            }}
          >
            Cancel
          </Button>
          <Button variant="primary" loading={busy} disabled={selected.length === 0} onClick={submit}>
            Send {selected.length > 0 ? `${selected.length} ` : ''}invite{selected.length === 1 ? '' : 's'}
          </Button>
        </div>
      }
    >
      {members.loading && !members.data ? (
        <SkeletonCard lines={4} />
      ) : (members.data?.members.length ?? 0) === 0 ? (
        <EmptyState icon={<Users size={20} />} title="Nobody to invite yet" description="There is nobody else in this community to invite yet." />
      ) : (
        <ul className="max-h-72 space-y-1 overflow-y-auto">
          {(members.data?.members ?? []).map((member) => (
            <li key={member.userId}>
              <label className="flex items-center gap-2.5 rounded-lg px-2 py-1.5 text-[13px] text-[var(--color-text)] hover:bg-[var(--color-surface)]">
                <input
                  type="checkbox"
                  checked={selected.includes(member.userId)}
                  onChange={(event) =>
                    setSelected((current) =>
                      event.target.checked ? [...current, member.userId] : current.filter((id) => id !== member.userId),
                    )
                  }
                  className="h-4 w-4 accent-[var(--color-primary)]"
                />
                <span className="min-w-0 truncate">{member.name}</span>
                <span className="text-[11.5px] text-[var(--color-muted-dim)]">{member.role}</span>
              </label>
            </li>
          ))}
        </ul>
      )}
    </Modal>
  );
}
