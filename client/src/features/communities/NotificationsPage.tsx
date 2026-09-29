/**
 * Notification centre (§37).
 *
 * Everything the communities system has told you, in one list, with the preferences that control it.
 * Notifications are created server-side from real events, and the kinds you mute are filtered before
 * they are ever stored for you — muting is not a client-side hide.
 */
import { useState } from 'react';
import { Link } from 'react-router-dom';
import { Bell, BellOff, CheckCheck, ExternalLink } from 'lucide-react';
import { Badge, Button, Card, EmptyState, ErrorState, LoadingState, Switch } from '../../components/ui';
import { useToast } from '../../hooks/useToast';
import { communitiesApi, type NotificationView } from './api';
import { useAction, useRelativeTime, useRemote } from './useCommunities';

const KIND_LABELS: Record<string, string> = {
  join_request: 'Someone asks to join',
  join_approved: 'Your join request was accepted',
  join_rejected: 'Your join request was declined',
  announcement: 'Announcements',
  competition_start: 'A competition starts',
  competition_end: 'A competition ends',
  result: 'Your results',
  mention: 'When someone mentions you',
  reply: 'Replies to your messages',
  event: 'Events',
  challenge: 'Challenges',
  study_plan: 'Study plans',
  helpful_answer: 'Your answer marked helpful',
  badge: 'Badges you earn',
  moderation: 'Moderation actions',
  moderation_warning: 'Official warnings to you',
  moderation_action: 'Decisions about your account',
  report_received: 'Reports you filed',
  poll: 'New polls',
  team_invite: 'Study team invites',
  team_update: 'Study team updates',
  room: 'Study rooms',
  resource: 'New resources',
  doubt: 'New doubts in your communities',
};

export function NotificationsPage() {
  const [unreadOnly, setUnreadOnly] = useState(false);
  const list = useRemote<{ notifications: NotificationView[]; unread: number }>(
    `/communities/notifications?limit=60${unreadOnly ? '&unreadOnly=true' : ''}`,
    [unreadOnly],
  );
  const preferences = useRemote<{ mutedKinds: string[]; allKinds: string[] }>('/communities/notifications/preferences');
  const { busy, run } = useAction();
  const toast = useToast();
  const relative = useRelativeTime();

  const markRead = async (notification: NotificationView) => {
    if (notification.isRead) return;
    const done = await run(() => communitiesApi.markNotificationRead(notification.id), { failure: 'Could not mark it read' });
    if (done) {
      list.set((current) => ({
        unread: Math.max(0, (current?.unread ?? 1) - 1),
        notifications: (current?.notifications ?? []).map((item) =>
          item.id === notification.id ? { ...item, isRead: true } : item,
        ),
      }));
    }
  };

  const markAll = async () => {
    const result = await run(() => communitiesApi.markAllNotificationsRead(), {
      success: 'All caught up',
      failure: 'Could not mark everything read',
    });
    if (result) {
      toast.push({ tone: 'info', title: `${result.updated} notification${result.updated === 1 ? '' : 's'} cleared` });
      void list.refresh();
    }
  };

  const toggleKind = async (kind: string, muted: boolean) => {
    const current = preferences.data?.mutedKinds ?? [];
    const next = muted ? [...current, kind] : current.filter((value) => value !== kind);
    const saved = await run(() => communitiesApi.saveNotificationPreferences(next), {
      success: muted ? 'Muted' : 'Unmuted',
      failure: 'Could not save that preference',
    });
    if (saved) preferences.set({ allKinds: preferences.data?.allKinds ?? [], mutedKinds: saved.mutedKinds });
  };

  return (
    <div className="mx-auto max-w-3xl space-y-4 px-4 py-5 sm:px-6">
      <header className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="text-[19px] font-semibold text-[var(--color-text)]">Community notifications</h1>
          <p className="mt-0.5 text-[12.5px] text-[var(--color-muted)]">
            {list.data?.unread ? `${list.data.unread} unread` : 'You are up to date'}
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <div className="flex items-center gap-2">
            <Switch checked={unreadOnly} onChange={setUnreadOnly} label="Unread only" />
          </div>
          <Button size="sm" variant="secondary" icon={<CheckCheck size={14} />} loading={busy} onClick={markAll}>
            Mark all read
          </Button>
        </div>
      </header>

      {list.loading && !list.data ? (
        <LoadingState message="Loading notifications…" className="py-12" />
      ) : list.error ? (
        <ErrorState title="Could not load notifications" message={list.error} onRetry={() => void list.refresh()} />
      ) : (list.data?.notifications.length ?? 0) === 0 ? (
        <EmptyState
          icon={<Bell size={22} />}
          title={unreadOnly ? 'Nothing unread' : 'No notifications yet'}
          description="Join a community and you will be told about announcements, competitions, answers to your doubts and results."
        />
      ) : (
        <ul className="space-y-1.5">
          {(list.data?.notifications ?? []).map((notification) => (
            <li key={notification.id}>
              <Card
                className={[
                  'flex items-start gap-3 p-3.5',
                  notification.isRead ? '' : 'border-[var(--color-primary)]/30 bg-[var(--color-primary)]/[0.03]',
                ].join(' ')}
              >
                <span
                  aria-hidden="true"
                  className={[
                    'mt-1.5 h-2 w-2 shrink-0 rounded-full',
                    notification.isRead ? 'bg-[var(--color-muted-dim)]/40' : 'bg-[var(--color-primary)]',
                  ].join(' ')}
                />
                <span className="min-w-0 flex-1">
                  <span className="flex flex-wrap items-center gap-2">
                    <span className="text-[13px] font-medium text-[var(--color-text)]">{notification.title}</span>
                    {notification.communityName ? <Badge tone="muted">{notification.communityName}</Badge> : null}
                    <time className="text-[11px] text-[var(--color-muted-dim)]">{relative(notification.createdAt)}</time>
                  </span>
                  <span className="mt-0.5 block text-[12.5px] text-[var(--color-muted)]">{notification.body}</span>
                  <span className="mt-1.5 flex flex-wrap items-center gap-2">
                    {notification.link ? (
                      <Link
                        to={notification.link}
                        onClick={() => void markRead(notification)}
                        className="inline-flex items-center gap-1 text-[12.5px] font-medium text-[var(--color-primary)] hover:underline"
                      >
                        Open <ExternalLink size={12} />
                      </Link>
                    ) : null}
                    {notification.isRead ? null : (
                      <button
                        type="button"
                        onClick={() => void markRead(notification)}
                        className="text-[12px] text-[var(--color-muted)] hover:text-[var(--color-text)]"
                      >
                        Mark read
                      </button>
                    )}
                  </span>
                </span>
              </Card>
            </li>
          ))}
        </ul>
      )}

      <Card className="space-y-3 p-4">
        <div className="flex items-center gap-2">
          <BellOff size={15} className="text-[var(--color-primary)]" />
          <h2 className="text-[14px] font-semibold text-[var(--color-text)]">What you want to hear about</h2>
        </div>
        <p className="text-[12.5px] text-[var(--color-muted)]">
          Muted kinds are not stored for you at all. Essential things — a moderator's decision about your account, or a competition
          result — always arrive.
        </p>
        {preferences.loading && !preferences.data ? (
          <LoadingState message="Loading preferences…" className="py-6" />
        ) : (
          <div className="grid gap-2 sm:grid-cols-2">
            {(preferences.data?.allKinds ?? []).map((kind) => (
              <div key={kind} className="flex items-center justify-between gap-3 rounded-lg border border-[var(--color-border)] px-3 py-2">
                <span className="min-w-0 truncate text-[12.5px] text-[var(--color-text)]">{KIND_LABELS[kind] ?? kind.replace(/_/g, ' ')}</span>
                <Switch
                  checked={!(preferences.data?.mutedKinds ?? []).includes(kind)}
                  onChange={(on) => void toggleKind(kind, !on)}
                  label={KIND_LABELS[kind] ?? kind}
                />
              </div>
            ))}
          </div>
        )}
      </Card>
    </div>
  );
}
