/**
 * Create a community (§2).
 *
 * Four short steps rather than one long form: what it is, who may join, how it behaves, then a review.
 * Every default is the safe one — public visibility is explicit, the leaderboard is on, and a brand
 * new community starts with a welcome message that the owner can edit before anyone sees it.
 */
import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { ArrowLeft, ArrowRight, Check, Info } from 'lucide-react';
import { Badge, Button, Card, Field, Segmented, Switch, TextArea, TextInput } from '../../components/ui';
import { useToast } from '../../hooks/useToast';
import { communitiesApi, type CommunityDetail, type CommunityVisibility } from './api';
import { VisibilityBadge } from './components';
import { errorMessage, useAction, useRemote } from './useCommunities';
import { VroqnFilterSelect } from '../../components/vroqn';

const ACCENTS: { value: string; label: string; swatch: string }[] = [
  { value: 'cyan', label: 'Cyan', swatch: '#00E5FF' },
  { value: 'emerald', label: 'Emerald', swatch: '#3DDC97' },
  { value: 'violet', label: 'Violet', swatch: '#7C6CFF' },
  { value: 'amber', label: 'Amber', swatch: '#F5B955' },
  { value: 'rose', label: 'Rose', swatch: '#FF7A90' },
];

export function CreateCommunityPage() {
  const navigate = useNavigate();
  const toast = useToast();
  const catalog = useRemote<{ categories: { value: string; label: string }[] }>('/communities/catalog');
  const { busy, run } = useAction();

  const [step, setStep] = useState(0);
  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  const [category, setCategory] = useState('jee');
  const [tags, setTags] = useState('');
  const [visibility, setVisibility] = useState<CommunityVisibility>('public');
  const [memberLimit, setMemberLimit] = useState('');
  const [joinRequirements, setJoinRequirements] = useState('');
  const [welcomeMessage, setWelcomeMessage] = useState('');
  const [rules, setRules] = useState('');
  const [accent, setAccent] = useState('cyan');
  const [leaderboard, setLeaderboard] = useState(true);
  const [created, setCreated] = useState<CommunityDetail | null>(null);

  const steps = ['Basics', 'Access', 'Culture', 'Review'];

  const tagList = tags
    .split(',')
    .map((tag) => tag.trim())
    .filter(Boolean)
    .slice(0, 8);

  const basicsValid = name.trim().length >= 3 && name.trim().length <= 80;

  const submit = async () => {
    const payload = {
      name: name.trim(),
      description: description.trim(),
      category,
      tags: tagList,
      visibility,
      memberLimit: memberLimit ? Number(memberLimit) : null,
      joinRequirements: joinRequirements.trim(),
      welcomeMessage: welcomeMessage.trim(),
      rules: rules.trim(),
      accent,
      isLeaderboardEnabled: leaderboard,
    };
    const result = await run(() => communitiesApi.create(payload), { failure: 'Could not create the community' });
    if (result) {
      setCreated(result);
      toast.push({ tone: 'success', title: `${result.name} is live`, detail: 'Share the link with your classmates.' });
    }
  };

  if (created) {
    return (
      <div className="mx-auto max-w-2xl space-y-4 py-6">
        <Card className="space-y-3 p-5">
          <div className="flex items-center gap-2 text-[var(--color-success)]">
            <Check size={18} />
            <h1 className="text-[17px] font-semibold text-[var(--color-text)]">{created.name} is ready</h1>
          </div>
          <p className="text-[13px] text-[var(--color-muted)]">
            {created.visibility === 'public'
              ? 'Anyone signed in to Vroqn can find this community in Explore and join straight away.'
              : created.visibility === 'private'
                ? 'Students can find this community and send a join request. You approve who gets in.'
                : 'This community is hidden from Explore. Students can only get in with an invite code you create inside it.'}
          </p>
          <div className="rounded-xl border border-[var(--color-border)] bg-[var(--color-card)] p-3 text-[12.5px] text-[var(--color-muted)]">
            <p className="font-medium text-[var(--color-text)]">Your next steps</p>
            <ul className="mt-1 list-disc space-y-1 pl-4">
              <li>Post a welcome announcement so the first members know what to do.</li>
              <li>Add the rules you want followed — they are shown on the community page.</li>
              <li>Create a challenge or a competition to give the community something to work towards.</li>
            </ul>
          </div>
          <div className="flex flex-wrap gap-2">
            <Button variant="primary" onClick={() => navigate(`/communities/${created.slug}`)}>
              Open the community
            </Button>
            <Button variant="ghost" onClick={() => navigate(`/communities/${created.slug}?tab=manage`)}>
              Go to manage
            </Button>
          </div>
        </Card>
      </div>
    );
  }

  return (
    <div className="mx-auto max-w-2xl space-y-5 pb-10">
      <div className="space-y-2">
        <button
          type="button"
          onClick={() => navigate('/communities')}
          className="vroqn-tap inline-flex items-center gap-1.5 text-[12.5px] text-[var(--color-muted)] hover:text-[var(--color-text)]"
        >
          <ArrowLeft size={13} /> All communities
        </button>
        <h1 className="text-[21px] font-semibold tracking-tight text-[var(--color-text)]">Create a community</h1>
        <p className="text-[13px] text-[var(--color-muted)]">
          A community holds the chat, doubt board, competitions, challenges and study plans for one group of students.
        </p>
      </div>

      <ol className="flex flex-wrap items-center gap-2" aria-label="Progress">
        {steps.map((label, index) => (
          <li key={label}>
            <span
              className={[
                'inline-flex items-center gap-1.5 rounded-full border px-2.5 py-1 text-[11.5px]',
                index === step
                  ? 'border-[var(--color-primary)]/45 bg-[var(--color-primary)]/12 text-[var(--color-primary)]'
                  : index < step
                    ? 'border-[var(--color-border)] text-[var(--color-muted)]'
                    : 'border-[var(--color-border)] text-[var(--color-muted-dim)]',
              ].join(' ')}
            >
              <span aria-hidden>{index < step ? '✓' : index + 1}</span>
              {label}
            </span>
          </li>
        ))}
      </ol>

      <Card className="space-y-4 p-4 sm:p-5">
        {step === 0 ? (
          <>
            <Field label="Community name" hint="3–80 characters. This is what students see first.">
              <TextInput
                value={name}
                onChange={(event) => setName(event.target.value)}
                placeholder="e.g. JEE Physics Warriors"
                maxLength={80}
                autoFocus
              />
            </Field>
            <Field label="What is it for?" hint="One or two lines. Say what members will actually do here.">
              <TextArea
                value={description}
                onChange={(event) => setDescription(event.target.value)}
                rows={3}
                maxLength={600}
                placeholder="Daily problem sets, doubt clearing and weekend competitions for JEE Physics."
              />
            </Field>
            <div className="grid gap-3 sm:grid-cols-2">
              <Field label="Category">
                <VroqnFilterSelect
                  label="Community category"
                  value={category}
                  onChange={setCategory}
                  placeholder="Choose a category"
                  options={(catalog.data?.categories ?? [{ value: 'jee', label: 'JEE' }]).map((entry) => ({
                    value: entry.value,
                    label: entry.label,
                  }))}
                />
              </Field>
              <Field label="Tags" hint="Comma separated, up to 8.">
                <TextInput
                  value={tags}
                  onChange={(event) => setTags(event.target.value)}
                  placeholder="physics, kinematics, jee"
                />
              </Field>
            </div>
            {tagList.length ? (
              <div className="flex flex-wrap gap-1.5">
                {tagList.map((tag) => (
                  <Badge key={tag} tone="muted">
                    #{tag}
                  </Badge>
                ))}
              </div>
            ) : null}
          </>
        ) : null}

        {step === 1 ? (
          <>
            <Field label="Who can join?">
              <Segmented
                value={visibility}
                onChange={(next) => setVisibility(next)}
                options={[
                  { value: 'public', label: 'Public', hint: 'Anyone can join instantly' },
                  { value: 'private', label: 'Private', hint: 'Students request, you approve' },
                  { value: 'invite_only', label: 'Invite only', hint: 'Only with an invite code' },
                ]}
              />
            </Field>
            <div className="flex items-start gap-2 rounded-xl border border-[var(--color-border)] bg-[var(--color-surface)] p-3">
              <Info size={14} className="mt-0.5 shrink-0 text-[var(--color-primary)]" />
              <p className="text-[12.5px] text-[var(--color-muted)]">
                {visibility === 'public'
                  ? 'Public communities appear in Explore. Their chat, doubts and resources are still only visible to members who join.'
                  : visibility === 'private'
                    ? 'A private community appears in Explore, but only its name and description. Everything inside is members-only, and you approve each student.'
                    : 'An invite-only community is hidden from Explore and from search. You create single-use or limited codes and share them yourself.'}
              </p>
            </div>
            <div className="grid gap-3 sm:grid-cols-2">
              <Field label="Member limit" hint="Optional. Leave empty for no limit.">
                <TextInput
                  value={memberLimit}
                  onChange={(event) => setMemberLimit(event.target.value.replace(/[^0-9]/g, ''))}
                  inputMode="numeric"
                  placeholder="e.g. 200"
                />
              </Field>
              <Field label="What you ask joiners" hint="Shown on the join request form.">
                <TextInput
                  value={joinRequirements}
                  onChange={(event) => setJoinRequirements(event.target.value)}
                  maxLength={600}
                  placeholder="Tell us your class and section"
                />
              </Field>
            </div>
          </>
        ) : null}

        {step === 2 ? (
          <>
            <Field label="Welcome message" hint="Shown to a student the moment they join. Tell them where to start.">
              <TextArea
                value={welcomeMessage}
                onChange={(event) => setWelcomeMessage(event.target.value)}
                rows={3}
                maxLength={1000}
                placeholder="Welcome! Start by introducing yourself in chat, then join this week's challenge."
              />
            </Field>
            <Field label="Community rules" hint="Visible on the community page and in the join preview.">
              <TextArea
                value={rules}
                onChange={(event) => setRules(event.target.value)}
                rows={4}
                maxLength={4000}
                placeholder={'1. Be kind.\n2. Search before asking.\n3. No spoilers for live competitions.'}
              />
            </Field>
            <div className="flex flex-wrap items-center justify-between gap-3 rounded-xl border border-[var(--color-border)] bg-[var(--color-surface)] p-3">
              <div className="min-w-0">
                <p className="text-[13px] font-medium text-[var(--color-text)]">Equal-opportunity leaderboard</p>
                <p className="text-[12px] text-[var(--color-muted)]">
                  Ranks members by academic contribution — helpful answers, challenges, resources, competitions. Not by likes or
                  time online. You can turn it off here.
                </p>
              </div>
              <Switch checked={leaderboard} onChange={setLeaderboard} label="Show the contribution leaderboard" />
            </div>
            <Field label="Accent colour" hint="Only used for this community's header. The rest of Vroqn stays cyan.">
              <div className="flex flex-wrap gap-2">
                {ACCENTS.map((entry) => (
                  <button
                    key={entry.value}
                    type="button"
                    onClick={() => setAccent(entry.value)}
                    aria-pressed={accent === entry.value}
                    className={[
                      'vroqn-tap inline-flex items-center gap-2 rounded-lg border px-2.5 py-1.5 text-[12px]',
                      accent === entry.value
                        ? 'border-[var(--color-primary)]/50 text-[var(--color-text)]'
                        : 'border-[var(--color-border)] text-[var(--color-muted)] hover:text-[var(--color-text)]',
                    ].join(' ')}
                  >
                    <span aria-hidden className="h-3 w-3 rounded-full" style={{ backgroundColor: entry.swatch }} />
                    {entry.label}
                  </button>
                ))}
              </div>
            </Field>
          </>
        ) : null}

        {step === 3 ? (
          <div className="space-y-3">
            <h2 className="text-[14px] font-semibold text-[var(--color-text)]">Review</h2>
            <dl className="grid gap-2 text-[12.5px] sm:grid-cols-2">
              <div className="rounded-xl border border-[var(--color-border)] bg-[var(--color-surface)] p-3">
                <dt className="text-[11.5px] uppercase tracking-wide text-[var(--color-muted-dim)]">Name</dt>
                <dd className="mt-0.5 text-[var(--color-text)]">{name || '—'}</dd>
              </div>
              <div className="rounded-xl border border-[var(--color-border)] bg-[var(--color-surface)] p-3">
                <dt className="text-[11.5px] uppercase tracking-wide text-[var(--color-muted-dim)]">Category</dt>
                <dd className="mt-0.5 text-[var(--color-text)]">
                  {catalog.data?.categories.find((entry) => entry.value === category)?.label ?? category}
                </dd>
              </div>
              <div className="rounded-xl border border-[var(--color-border)] bg-[var(--color-surface)] p-3">
                <dt className="text-[11.5px] uppercase tracking-wide text-[var(--color-muted-dim)]">Access</dt>
                <dd className="mt-1">
                  <VisibilityBadge visibility={visibility} />
                </dd>
              </div>
              <div className="rounded-xl border border-[var(--color-border)] bg-[var(--color-surface)] p-3">
                <dt className="text-[11.5px] uppercase tracking-wide text-[var(--color-muted-dim)]">Member limit</dt>
                <dd className="mt-0.5 text-[var(--color-text)]">{memberLimit || 'No limit'}</dd>
              </div>
            </dl>
            <p className="text-[12.5px] text-[var(--color-muted)]">
              You will be the owner. You can invite admins and moderators afterwards, change these settings, or delete the
              community — deleting it removes its content for everyone.
            </p>
          </div>
        ) : null}

        {catalog.error ? (
          <p className="text-[12.5px] text-[var(--color-error)]/90">
            {errorMessage(catalog.error)} The category list may be incomplete.
          </p>
        ) : null}

        <div className="flex flex-wrap items-center justify-between gap-2 border-t border-[var(--color-border)] pt-3">
          <Button variant="ghost" onClick={() => setStep((current) => Math.max(current - 1, 0))} disabled={step === 0}>
            Back
          </Button>
          {step < steps.length - 1 ? (
            <Button
              variant="primary"
              iconRight={<ArrowRight size={15} />}
              onClick={() => setStep((current) => current + 1)}
              disabled={step === 0 && !basicsValid}
            >
              Continue
            </Button>
          ) : (
            <Button variant="primary" loading={busy} onClick={submit} disabled={!basicsValid}>
              Create community
            </Button>
          )}
        </div>
      </Card>
    </div>
  );
}
