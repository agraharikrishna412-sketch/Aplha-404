/**
 * Events (§23) and study rooms (§29).
 *
 * An event is a scheduled session with a time and an RSVP; a study room is the same shape but with a
 * checklist the group works through. Rooms live in this tab rather than their own because they are
 * both "we are meeting at this time" — a separate tab would be one more thing to check.
 */
import { useState } from 'react';
import { CalendarPlus, Clock, MapPin, Plus, Users, Video } from 'lucide-react';
import { Badge, Button, Card, EmptyState, ErrorState, Modal, SkeletonCard, TextInput } from '../../../components/ui';
import { VroqnFilterSelect } from '../../../components/vroqn';
import { useConfirm } from '../../../components/Confirm';
import { CommunitySection } from '../components';
import { communitiesApi, type CommunityDetail, type EventView, type StudyRoomView } from '../api';
import { useAction, useRemote } from '../useCommunities';

const EVENT_KINDS = ['doubt_session', 'revision', 'workshop', 'meetup', 'exam_discussion', 'other'] as const;

export function EventsTab({ community }: { community: CommunityDetail }) {
  const [includePast, setIncludePast] = useState(false);
  const events = useRemote<{ events: EventView[] }>(
    `/communities/${community.id}/events${includePast ? '?includePast=true' : ''}`,
    [includePast],
  );
  const { busy, run } = useAction();
  const confirm = useConfirm();
  const [composerOpen, setComposerOpen] = useState(false);

  const rsvp = async (event: EventView) => {
    const updated = await run(() => communitiesApi.rsvp(community.id, event.id, !event.isGoing), {
      success: event.isGoing ? 'You are no longer going' : 'You are going',
      failure: 'Could not update your RSVP',
    });
    if (updated) void events.refresh();
  };

  const cancelEvent = async (event: EventView) => {
    const ok = await confirm({
      title: `Cancel “${event.title}”?`,
      description: 'Everyone who said they were going is removed from the list. This cannot be undone.',
      confirmLabel: 'Cancel event',
      tone: 'danger',
    });
    if (!ok) return;
    const done = await run(() => communitiesApi.deleteEvent(community.id, event.id), {
      success: 'Event cancelled',
      failure: 'Could not cancel that event',
    });
    if (done) void events.refresh();
  };

  return (
    <div className="space-y-4">
      <CommunitySection
        title="Events"
        description="Live sessions, revision meetups and doubt-clearing calls. Times are shown in your own timezone."
        action={
          <div className="flex items-center gap-2">
            <Button size="sm" variant="ghost" onClick={() => setIncludePast((current) => !current)}>
              {includePast ? 'Hide past events' : 'Show past events'}
            </Button>
            <Button size="sm" variant="secondary" icon={<Plus size={14} />} onClick={() => setComposerOpen(true)}>
              Schedule an event
            </Button>
          </div>
        }
      >
        {events.loading && !events.data ? (
          <div className="space-y-2">
            {[0, 1].map((index) => (
              <SkeletonCard key={index} lines={3} />
            ))}
          </div>
        ) : events.error ? (
          <ErrorState title="Could not load events" message={events.error} onRetry={() => void events.refresh()} />
        ) : (events.data?.events.length ?? 0) === 0 ? (
          <EmptyState
            icon={<CalendarPlus size={22} />}
            title={includePast ? 'No events have happened yet' : 'Nothing scheduled'}
            description="A weekly doubt session is usually the easiest one to keep going. Pick a time and see who turns up."
          />
        ) : (
          <div className="space-y-2">
            {(events.data?.events ?? []).map((event) => (
              <Card key={event.id} className="space-y-2 p-4">
                <div className="flex flex-wrap items-center gap-2">
                  <Badge tone={event.hasEnded ? 'muted' : event.isGoing ? 'success' : 'primary'}>
                    {event.hasEnded ? 'Ended' : event.isGoing ? 'You are going' : event.kind.replace('_', ' ')}
                  </Badge>
                  {event.isFull && !event.hasEnded ? <Badge tone="warning">Full</Badge> : null}
                  <span className="text-[11.5px] text-[var(--color-muted-dim)]">hosted by {event.hostName}</span>
                </div>

                <div className="min-w-0">
                  <h3 className="text-[14px] font-semibold text-[var(--color-text)]">{event.title}</h3>
                  {event.description ? (
                    <p className="mt-1 whitespace-pre-wrap text-[12.5px] text-[var(--color-muted)]">{event.description}</p>
                  ) : null}
                </div>

                <ul className="flex flex-wrap gap-x-4 gap-y-1 text-[12px] text-[var(--color-muted)]">
                  <li className="inline-flex items-center gap-1.5">
                    <Clock size={12} /> {formatRange(event.startsAt, event.endsAt)}
                  </li>
                  <li className="inline-flex items-center gap-1.5">
                    <Users size={12} /> {event.participantCount}
                    {event.participantLimit ? ` / ${event.participantLimit}` : ''} going
                  </li>
                  {event.meetingUrl ? (
                    <li className="inline-flex items-center gap-1.5">
                      <MapPin size={12} /> online
                    </li>
                  ) : null}
                </ul>

                <div className="flex flex-wrap items-center gap-2">
                  {event.hasEnded ? null : (
                    <Button
                      size="sm"
                      variant={event.isGoing ? 'secondary' : 'primary'}
                      loading={busy}
                      disabled={event.isFull && !event.isGoing}
                      onClick={() => void rsvp(event)}
                    >
                      {event.isGoing ? 'I cannot attend' : event.isFull ? 'Full' : 'I will attend'}
                    </Button>
                  )}
                  {event.isGoing && event.meetingUrl && !event.hasEnded ? (
                    <a href={event.meetingUrl} target="_blank" rel="noopener noreferrer" className="inline-flex">
                      <Button size="sm" variant="secondary" icon={<Video size={13} />}>
                        Join the call
                      </Button>
                    </a>
                  ) : null}
                  {event.canCancel ? (
                    <Button size="sm" variant="ghost" onClick={() => void cancelEvent(event)}>
                      Cancel event
                    </Button>
                  ) : null}
                </div>
              </Card>
            ))}
          </div>
        )}
      </CommunitySection>

      <RoomsSection community={community} />

      <ScheduleEvent
        communityId={community.id}
        open={composerOpen}
        onClose={() => setComposerOpen(false)}
        onCreated={() => {
          setComposerOpen(false);
          void events.refresh();
        }}
      />
    </div>
  );
}

function ScheduleEvent({
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
  const [title, setTitle] = useState('');
  const [description, setDescription] = useState('');
  const [kind, setKind] = useState<string>('doubt_session');
  const [date, setDate] = useState(() => new Date(Date.now() + 86_400_000).toISOString().slice(0, 10));
  const [time, setTime] = useState('18:00');
  const [durationMin, setDurationMin] = useState(60);
  const [meetingUrl, setMeetingUrl] = useState('');
  const [limit, setLimit] = useState('');
  const [error, setError] = useState<string | null>(null);

  const submit = async () => {
    setError(null);
    const startsAt = new Date(`${date}T${time}:00`);
    if (Number.isNaN(startsAt.getTime())) {
      setError('Choose a valid date and time.');
      return;
    }
    if (startsAt.getTime() < Date.now()) {
      setError('Pick a time in the future — students cannot attend a meeting that already passed.');
      return;
    }
    if (meetingUrl.trim() && !/^https?:\/\//i.test(meetingUrl.trim())) {
      setError('The meeting link must start with http:// or https://');
      return;
    }
    const created = await run(
      () =>
        communitiesApi.createEvent(communityId, {
          title: title.trim(),
          description: description.trim(),
          kind,
          startsAt: startsAt.toISOString(),
          endsAt: new Date(startsAt.getTime() + durationMin * 60_000).toISOString(),
          meetingUrl: meetingUrl.trim() || null,
          participantLimit: limit ? Number(limit) : null,
        }),
      { failure: 'Could not schedule that event' },
    );
    if (created) {
      setTitle('');
      setDescription('');
      onCreated();
    } else {
      setError('Check the details and try again. A title of at least 4 characters is required.');
    }
  };

  return (
    <Modal
      open={open}
      onClose={onClose}
      title="Schedule an event"
      description="Members get a notification when you schedule it."
      size="lg"
      footer={
        <div className="flex justify-end gap-2">
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button variant="primary" loading={busy} disabled={title.trim().length < 4} onClick={submit}>
            Schedule event
          </Button>
        </div>
      }
    >
      <div className="space-y-3">
        <div>
          <label className="text-[12.5px] text-[var(--color-muted)]" htmlFor="event-title">
            Title
          </label>
          <TextInput
            id="event-title"
            value={title}
            onChange={(event) => setTitle(event.target.value)}
            maxLength={140}
            placeholder="Sunday doubt session — Rotational motion"
          />
        </div>
        <div>
          <label className="text-[12.5px] text-[var(--color-muted)]" htmlFor="event-description">
            What will you cover? (optional)
          </label>
          <textarea
            id="event-description"
            value={description}
            rows={3}
            maxLength={1500}
            onChange={(event) => setDescription(event.target.value)}
            className="w-full rounded-xl border border-[var(--color-border)] bg-[var(--color-card)] px-3 py-2 text-[13px] text-[var(--color-text)]"
          />
        </div>
        <div className="grid gap-3 sm:grid-cols-3">
          <div>
            <span className="mb-1 block text-[12.5px] text-[var(--color-muted)]">Type</span>
            <VroqnFilterSelect
              label="Event type"
              value={kind}
              onChange={setKind}
              size="sm"
              placeholder="Choose a type"
              options={EVENT_KINDS.map((value) => ({ value, label: value.replace('_', ' ') }))}
            />
          </div>
          <div>
            <label className="text-[12.5px] text-[var(--color-muted)]" htmlFor="event-date">
              Date
            </label>
            <TextInput id="event-date" type="date" value={date} onChange={(event) => setDate(event.target.value)} />
          </div>
          <div>
            <label className="text-[12.5px] text-[var(--color-muted)]" htmlFor="event-time">
              Start time
            </label>
            <TextInput id="event-time" type="time" value={time} onChange={(event) => setTime(event.target.value)} />
          </div>
        </div>
        <div className="grid gap-3 sm:grid-cols-3">
          <div>
            <label className="text-[12.5px] text-[var(--color-muted)]" htmlFor="event-duration">
              Length (minutes)
            </label>
            <TextInput
              id="event-duration"
              value={String(durationMin)}
              inputMode="numeric"
              onChange={(event) => setDurationMin(Math.min(Math.max(Number(event.target.value.replace(/[^0-9]/g, '')) || 30, 10), 480))}
            />
          </div>
          <div className="sm:col-span-2">
            <label className="text-[12.5px] text-[var(--color-muted)]" htmlFor="event-link">
              Meeting link (optional)
            </label>
            <TextInput
              id="event-link"
              value={meetingUrl}
              onChange={(event) => setMeetingUrl(event.target.value)}
              inputMode="url"
              placeholder="https://meet.example.com/…"
            />
          </div>
        </div>
        <div>
          <label className="text-[12.5px] text-[var(--color-muted)]" htmlFor="event-limit">
            Maximum attendees (optional)
          </label>
          <TextInput
            id="event-limit"
            value={limit}
            inputMode="numeric"
            onChange={(event) => setLimit(event.target.value.replace(/[^0-9]/g, ''))}
            placeholder="Leave empty for no limit"
          />
        </div>
        {error ? <p className="text-[12.5px] text-[var(--color-error)]">{error}</p> : null}
      </div>
    </Modal>
  );
}

/* ------------------------------------------------------------------ study rooms ----------------- */

function RoomsSection({ community }: { community: CommunityDetail }) {
  const rooms = useRemote<{ rooms: StudyRoomView[] }>(`/communities/${community.id}/rooms`);
  const { busy, run } = useAction();
  const [composerOpen, setComposerOpen] = useState(false);

  const toggleJoin = async (room: StudyRoomView) => {
    const updated = await run(() => communitiesApi.joinRoom(community.id, room.id, !room.isJoined), {
      success: room.isJoined ? 'You left the room' : 'You joined the room',
      failure: 'Could not update the room',
    });
    if (updated) void rooms.refresh();
  };

  const toggleItem = async (room: StudyRoomView, itemId: string, done: boolean) => {
    const updated = await run(() => communitiesApi.setRoomChecklist(community.id, room.id, itemId, done), {
      failure: 'Could not save that',
    });
    if (updated) void rooms.refresh();
  };

  return (
    <CommunitySection
      title="Study rooms"
      description="Sit down together at a fixed time with a shared checklist. Whoever is there when it starts works through the list."
      action={
        <Button size="sm" variant="secondary" icon={<Plus size={14} />} onClick={() => setComposerOpen(true)}>
          Open a room
        </Button>
      }
    >
      {rooms.loading && !rooms.data ? (
        <SkeletonCard lines={3} />
      ) : rooms.error ? (
        <ErrorState title="Could not load study rooms" message={rooms.error} onRetry={() => void rooms.refresh()} />
      ) : (rooms.data?.rooms.length ?? 0) === 0 ? (
        <EmptyState
          icon={<Users size={22} />}
          title="No study rooms open"
          description="A room is a named slot: “Tonight 8pm — Thermodynamics numericals”. Anyone who joins sees the same checklist."
        />
      ) : (
        <div className="space-y-2">
          {(rooms.data?.rooms ?? []).map((room) => (
            <Card key={room.id} className="space-y-2.5 p-4">
              <div className="flex flex-wrap items-center gap-2">
                <Badge tone={room.hasEnded ? 'muted' : 'primary'}>{room.hasEnded ? 'Finished' : 'Open'}</Badge>
                <span className="text-[11.5px] text-[var(--color-muted-dim)]">
                  {room.participantCount} in the room · hosted by {room.hostName}
                </span>
              </div>
              <div>
                <h3 className="text-[13.5px] font-semibold text-[var(--color-text)]">{room.title}</h3>
                {room.topic ? <p className="mt-0.5 text-[12.5px] text-[var(--color-muted)]">{room.topic}</p> : null}
                {room.goal ? <p className="mt-0.5 text-[12px] text-[var(--color-muted-dim)]">Goal: {room.goal}</p> : null}
              </div>
              <p className="text-[12px] text-[var(--color-muted)]">
                <Clock size={12} className="mr-1 inline" />
                {formatRange(room.startsAt, room.endsAt)}
              </p>
              {room.checklist.length > 0 ? (
                <ul className="space-y-1">
                  {room.checklist.map((item) => (
                    <li key={item.id}>
                      <label className="flex items-center gap-2 text-[12.5px] text-[var(--color-text)]">
                        <input
                          type="checkbox"
                          checked={item.done}
                          disabled={!room.isJoined}
                          onChange={(event) => void toggleItem(room, item.id, event.target.checked)}
                          className="h-4 w-4 accent-[var(--color-primary)]"
                        />
                        <span className={item.done ? 'text-[var(--color-muted)] line-through' : ''}>{item.label}</span>
                      </label>
                    </li>
                  ))}
                </ul>
              ) : null}
              <Button size="sm" variant={room.isJoined ? 'secondary' : 'primary'} loading={busy} onClick={() => void toggleJoin(room)}>
                {room.isJoined ? 'Leave the room' : room.hasEnded ? 'Room closed' : 'Join the room'}
              </Button>
            </Card>
          ))}
        </div>
      )}

      <OpenRoom
        communityId={community.id}
        open={composerOpen}
        onClose={() => setComposerOpen(false)}
        onCreated={() => {
          setComposerOpen(false);
          void rooms.refresh();
        }}
      />
    </CommunitySection>
  );
}

function OpenRoom({
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
  const [title, setTitle] = useState('');
  const [topic, setTopic] = useState('');
  const [goal, setGoal] = useState('');
  const [startsAt, setStartsAt] = useState(() => new Date(Date.now() + 3_600_000).toISOString().slice(0, 16));
  const [minutes, setMinutes] = useState(90);
  const [checklist, setChecklist] = useState('');

  const submit = async () => {
    const start = new Date(startsAt);
    if (Number.isNaN(start.getTime())) return;
    const created = await run(
      () =>
        communitiesApi.createRoom(communityId, {
          title: title.trim(),
          topic: topic.trim(),
          goal: goal.trim(),
          startsAt: start.toISOString(),
          endsAt: new Date(start.getTime() + minutes * 60_000).toISOString(),
          checklist: checklist
            .split('\n')
            .map((line) => line.trim())
            .filter(Boolean),
        }),
      { failure: 'Could not open that room' },
    );
    if (created) onCreated();
  };

  return (
    <Modal
      open={open}
      onClose={onClose}
      title="Open a study room"
      description="Give it a time and a checklist. Small, specific sessions work best."
      footer={
        <div className="flex justify-end gap-2">
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button variant="primary" loading={busy} disabled={title.trim().length < 4} onClick={submit}>
            Open room
          </Button>
        </div>
      }
    >
      <div className="space-y-3">
        <div>
          <label className="text-[12.5px] text-[var(--color-muted)]" htmlFor="room-title">
            Title
          </label>
          <TextInput id="room-title" value={title} onChange={(event) => setTitle(event.target.value)} maxLength={120} placeholder="Tonight 8pm — Thermodynamics numericals" />
        </div>
        <div className="grid gap-3 sm:grid-cols-2">
          <div>
            <label className="text-[12.5px] text-[var(--color-muted)]" htmlFor="room-topic">
              Topic (optional)
            </label>
            <TextInput id="room-topic" value={topic} onChange={(event) => setTopic(event.target.value)} maxLength={120} />
          </div>
          <div>
            <label className="text-[12.5px] text-[var(--color-muted)]" htmlFor="room-goal">
              Goal (optional)
            </label>
            <TextInput id="room-goal" value={goal} onChange={(event) => setGoal(event.target.value)} maxLength={160} placeholder="Finish 20 numericals" />
          </div>
        </div>
        <div className="grid gap-3 sm:grid-cols-2">
          <div>
            <label className="text-[12.5px] text-[var(--color-muted)]" htmlFor="room-start">
              Starts
            </label>
            <TextInput id="room-start" type="datetime-local" value={startsAt} onChange={(event) => setStartsAt(event.target.value)} />
          </div>
          <div>
            <label className="text-[12.5px] text-[var(--color-muted)]" htmlFor="room-minutes">
              Length (minutes)
            </label>
            <TextInput
              id="room-minutes"
              value={String(minutes)}
              inputMode="numeric"
              onChange={(event) => setMinutes(Math.min(Math.max(Number(event.target.value.replace(/[^0-9]/g, '')) || 30, 15), 480))}
            />
          </div>
        </div>
        <div>
          <label className="text-[12.5px] text-[var(--color-muted)]" htmlFor="room-checklist">
            Checklist — one item per line
          </label>
          <textarea
            id="room-checklist"
            value={checklist}
            rows={4}
            maxLength={1200}
            onChange={(event) => setChecklist(event.target.value)}
            placeholder={'Revise the three gas laws\nSolve 10 numericals\nCompare answers'}
            className="w-full rounded-xl border border-[var(--color-border)] bg-[var(--color-card)] px-3 py-2 text-[13px] text-[var(--color-text)]"
          />
        </div>
      </div>
    </Modal>
  );
}

function formatRange(startsAt: string, endsAt: string): string {
  const start = new Date(startsAt);
  const end = new Date(endsAt);
  const sameDay = start.toDateString() === end.toDateString();
  const date = start.toLocaleDateString(undefined, { weekday: 'short', day: 'numeric', month: 'short' });
  const from = start.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' });
  const to = end.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' });
  return sameDay ? `${date}, ${from} – ${to}` : `${start.toLocaleString()} – ${end.toLocaleString()}`;
}
