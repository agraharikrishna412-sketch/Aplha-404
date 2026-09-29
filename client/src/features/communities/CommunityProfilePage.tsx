/**
 * Community profile and privacy (§35, §36).
 *
 * The page you get when you tap a name in a member list. It shows what its owner chose to share and
 * nothing more: when activity is hidden the API does not send it, so hiding is not a CSS trick. Your
 * own page is where the switches live, including blocking someone in both directions.
 */
import { useEffect, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { Award, Ban, Flame, Info, Lock, Shield, Users } from 'lucide-react';
import { Badge, Button, Card, EmptyState, ErrorState, LoadingState, Switch, TextArea, TextInput } from '../../components/ui';
import { RoleBadge } from './components';
import { communitiesApi, type ProfileView } from './api';
import { useAction, useRemote } from './useCommunities';

export function CommunityProfilePage() {
  const { userId } = useParams();
  /*
   * `/communities/profile/me` is the SPA's own-profile screen and carries no route parameter, while
   * `/communities/profile/:userId` identifies somebody else. Reading `useParams().userId` into an
   * empty string collapsed both cases into "look up an unnamed student", so a student opening their
   * own community profile got a 404. A missing parameter means "this is me".
   */
  const viewingSelf = !userId || userId === 'me';
  const profile = useRemote<ProfileView>(`/communities/profile/${viewingSelf ? 'me' : encodeURIComponent(userId)}`);
  const blocks = useRemote<{ blocked: string[] }>(viewingSelf ? '/communities/profile/blocks' : null);

  if (profile.loading && !profile.data) return <LoadingState message="Loading profile…" className="py-20" />;
  if (profile.error || !profile.data) {
    return (
      <div className="mx-auto max-w-2xl px-4 py-8">
        <ErrorState title="Could not load this profile" message={profile.error ?? 'That student may have left Vroqn.'} onRetry={() => void profile.refresh()} />
      </div>
    );
  }

  const person = profile.data;
  const isBlocked = (blocks.data?.blocked ?? []).includes(person.userId);

  return (
    <div className="mx-auto max-w-3xl space-y-4 px-4 py-5 sm:px-6">
      <Card className="space-y-3 p-4">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div className="flex items-center gap-3">
            <span className="flex h-12 w-12 items-center justify-center rounded-full bg-[var(--color-surface)] text-[15px] font-semibold text-[var(--color-text)]">
              {person.name.slice(0, 2).toUpperCase()}
            </span>
            <div className="min-w-0">
              <h1 className="truncate text-[17px] font-semibold text-[var(--color-text)]">{person.name}</h1>
              <p className="mt-0.5 flex flex-wrap items-center gap-2 text-[12px] text-[var(--color-muted)]">
                {person.classLevel ? <Badge tone="muted">{person.classLevel}</Badge> : null}
                {person.streakDays > 0 ? (
                  <span className="inline-flex items-center gap-1">
                    <Flame size={12} className="text-[var(--color-warning)]" /> {person.streakDays} day streak
                  </span>
                ) : null}
                {!person.isProfilePublic && !person.isSelf ? (
                  <span className="inline-flex items-center gap-1">
                    <Lock size={12} /> Private profile
                  </span>
                ) : null}
              </p>
            </div>
          </div>
          {person.isSelf ? (
            <Badge tone="primary">This is you</Badge>
          ) : (
            <BlockButton userId={person.userId} name={person.name} blocked={isBlocked} onToggled={() => void blocks.refresh()} />
          )}
        </div>

        {person.bio ? <p className="whitespace-pre-wrap text-[13px] leading-relaxed text-[var(--color-text)]">{person.bio}</p> : null}
        {person.interests.length > 0 ? (
          <div className="flex flex-wrap gap-1.5">
            {person.interests.map((interest) => (
              <Badge key={interest} tone="muted">
                {interest}
              </Badge>
            ))}
          </div>
        ) : null}

        <div className="grid grid-cols-3 gap-2 border-t border-[var(--color-border)] pt-3">
          <Stat label="Communities" value={person.joinedCommunities.length} />
          <Stat label="Created" value={person.createdCommunities.length} />
          <Stat label="Competitions" value={person.competitions.completed} hint={`${person.competitions.participated} entered`} />
        </div>
      </Card>

      {person.badges.length > 0 ? (
        <Card className="space-y-2 p-4">
          <h2 className="inline-flex items-center gap-2 text-[14px] font-semibold text-[var(--color-text)]">
            <Award size={15} className="text-[var(--color-primary)]" /> Badges earned
          </h2>
          <div className="flex flex-wrap gap-2">
            {person.badges.map((badge) => (
              <span key={badge.key} className="inline-flex items-center gap-2 rounded-lg border border-[var(--color-border)] px-2.5 py-1.5">
                <span aria-hidden="true">{badge.emoji}</span>
                <span className="text-[12.5px] text-[var(--color-text)]">{badge.label}</span>
              </span>
            ))}
          </div>
        </Card>
      ) : null}

      <section aria-labelledby="profile-communities" className="space-y-2">
        <h2 id="profile-communities" className="text-[14px] font-semibold text-[var(--color-text)]">
          Communities
        </h2>
        {!person.isCommunitiesVisible && !person.isSelf ? (
          <Card className="flex items-start gap-3 p-3.5">
            <Info size={15} className="mt-0.5 shrink-0 text-[var(--color-primary)]" />
            <p className="text-[12.5px] text-[var(--color-muted)]">This student keeps their community list private.</p>
          </Card>
        ) : person.joinedCommunities.length === 0 && person.createdCommunities.length === 0 ? (
          <EmptyState icon={<Users size={20} />} title="No communities yet" description="Memberships show up here once they join one." />
        ) : (
          <div className="space-y-1.5">
            {person.createdCommunities.map((community) => (
              <Link key={community.id} to={`/communities/${community.slug}`} className="block">
                <Card interactive className="flex items-center justify-between gap-3 p-3">
                  <span className="min-w-0 truncate text-[13px] font-medium text-[var(--color-text)]">{community.name}</span>
                  <span className="shrink-0 text-[11.5px] text-[var(--color-muted-dim)]">
                    {community.memberCount} members · owner
                  </span>
                </Card>
              </Link>
            ))}
            {person.joinedCommunities.map((community) => (
              <Link key={community.id} to={`/communities/${community.slug}`} className="block">
                <Card interactive className="flex items-center justify-between gap-3 p-3">
                  <span className="min-w-0 truncate text-[13px] text-[var(--color-text)]">{community.name}</span>
                  <RoleBadge role={community.role} />
                </Card>
              </Link>
            ))}
          </div>
        )}
      </section>

      {viewingSelf ? <PrivacyCard initial={person} /> : null}
      {viewingSelf && (blocks.data?.blocked.length ?? 0) > 0 ? (
        <Card className="space-y-2 p-4">
          <h2 className="inline-flex items-center gap-2 text-[14px] font-semibold text-[var(--color-text)]">
            <Shield size={15} /> Blocked students ({blocks.data?.blocked.length})
          </h2>
          <p className="text-[12.5px] text-[var(--color-muted)]">
            You will not be notified about them, and they cannot send you study team invites. Their messages stay in community chat,
            because removing someone else's words is a moderator's decision, not yours.
          </p>
          <div className="flex flex-wrap gap-2">
            {(blocks.data?.blocked ?? []).map((id) => (
              <UnblockChip key={id} userId={id} onDone={() => void blocks.refresh()} />
            ))}
          </div>
        </Card>
      ) : null}
    </div>
  );
}

function Stat({ label, value, hint }: { label: string; value: number; hint?: string }) {
  return (
    <div>
      <p className="text-[18px] font-semibold text-[var(--color-text)]">{value}</p>
      <p className="text-[11.5px] text-[var(--color-muted-dim)]">{label}</p>
      {hint ? <p className="text-[11px] text-[var(--color-muted-dim)]">{hint}</p> : null}
    </div>
  );
}

function BlockButton({ userId, name, blocked, onToggled }: { userId: string; name: string; blocked: boolean; onToggled: () => void }) {
  const { busy, run } = useAction();
  return (
    <Button
      size="sm"
      variant={blocked ? 'secondary' : 'ghost'}
      icon={<Ban size={13} />}
      loading={busy}
      onClick={async () => {
        const done = await run(() => (blocked ? communitiesApi.unblock(userId) : communitiesApi.block(userId)), {
          success: blocked ? `${name} is unblocked` : `${name} is blocked`,
          failure: 'Could not change that',
        });
        if (done) onToggled();
      }}
    >
      {blocked ? 'Unblock' : 'Block'}
    </Button>
  );
}

function UnblockChip({ userId, onDone }: { userId: string; onDone: () => void }) {
  const { busy, run } = useAction();
  return (
    <Badge tone="muted">
      <span className="inline-flex items-center gap-2">
        {userId.slice(0, 8)}…
        <button
          type="button"
          disabled={busy}
          onClick={async () => {
            const done = await run(() => communitiesApi.unblock(userId), { success: 'Unblocked', failure: 'Could not unblock' });
            if (done) onDone();
          }}
          className="text-[11px] text-[var(--color-primary)] hover:underline"
        >
          unblock
        </button>
      </span>
    </Badge>
  );
}

function PrivacyCard({ initial }: { initial: ProfileView }) {
  const { busy, run } = useAction();
  const [bio, setBio] = useState(initial.bio);
  const [interests, setInterests] = useState(initial.interests.join(', '));
  const [flags, setFlags] = useState({
    isProfilePublic: initial.isProfilePublic,
    isActivityVisible: initial.isActivityVisible,
    isCommunitiesVisible: initial.isCommunitiesVisible,
  });
  const [saved, setSaved] = useState(false);

  useEffect(() => {
    setBio(initial.bio);
    setInterests(initial.interests.join(', '));
    setFlags({
      isProfilePublic: initial.isProfilePublic,
      isActivityVisible: initial.isActivityVisible,
      isCommunitiesVisible: initial.isCommunitiesVisible,
    });
  }, [initial.bio, initial.interests, initial.isActivityVisible, initial.isCommunitiesVisible, initial.isProfilePublic]);

  return (
    <Card className="space-y-3 p-4">
      <h2 className="text-[14px] font-semibold text-[var(--color-text)]">Privacy and profile</h2>
      <div>
        <label className="text-[12.5px] text-[var(--color-muted)]" htmlFor="profile-bio">
          About you
        </label>
        <TextArea
          id="profile-bio"
          rows={3}
          maxLength={600}
          value={bio}
          onChange={(event) => setBio(event.target.value)}
          placeholder="Class 12, targeting JEE 2027. Currently weak on rotational motion."
        />
      </div>
      <div>
        <label className="text-[12.5px] text-[var(--color-muted)]" htmlFor="profile-interests">
          Interests (comma separated)
        </label>
        <TextInput id="profile-interests" value={interests} onChange={(event) => setInterests(event.target.value)} />
      </div>

      <div className="space-y-2">
        {(
          [
            ['isProfilePublic', 'Anyone on Vroqn can see my profile', 'Off means only people who share a community with you can open it.'],
            ['isActivityVisible', 'Show my learning activity', 'Your streak, badges and competition record on your profile.'],
            ['isCommunitiesVisible', 'Show which communities I am in', 'Turn this off to keep your study groups to yourself.'],
          ] as const
        ).map(([key, label, blurb]) => (
          <div key={key} className="flex items-start justify-between gap-4 rounded-xl border border-[var(--color-border)] p-3">
            <div className="min-w-0">
              <p className="text-[12.5px] font-medium text-[var(--color-text)]">{label}</p>
              <p className="mt-0.5 text-[11.5px] text-[var(--color-muted)]">{blurb}</p>
            </div>
            <Switch checked={flags[key]} onChange={(next) => setFlags((current) => ({ ...current, [key]: next }))} label={label} />
          </div>
        ))}
      </div>

      <p className="text-[11.5px] text-[var(--color-muted-dim)]">
        Never share a phone number, address or personal contact details here or in community chat. Vroqn does not ask for them and
        moderators are trained to remove them.
      </p>

      <div className="flex items-center gap-2">
        <Button
          variant="primary"
          loading={busy}
          onClick={async () => {
            const updated = await run(
              () =>
                communitiesApi.saveProfile({
                  bio: bio.trim(),
                  interests: interests
                    .split(',')
                    .map((value) => value.trim())
                    .filter(Boolean)
                    .slice(0, 12),
                  ...flags,
                }),
              { success: 'Saved', failure: 'Could not save your profile' },
            );
            if (updated) setSaved(true);
          }}
        >
          Save
        </Button>
        {saved && !busy ? <Badge tone="success">Saved</Badge> : null}
      </div>
    </Card>
  );
}
