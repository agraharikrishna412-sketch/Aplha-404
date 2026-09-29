/**
 * Application shell.
 *
 * Desktop: fixed sidebar + workspace, optional right column handled per page.
 * Mobile: compact sticky header, slide-in drawer, 5-slot bottom navigation (spec §23).
 * Both share the same tokens and components, so nothing feels "ported".
 */
import { useEffect, useState, type ReactNode } from 'react';
import { NavLink, useLocation, useNavigate } from 'react-router-dom';
import {
  Activity,
  ArrowLeft,
  BookOpen,
  CircleHelp,
  Code2,
  Compass,
  Home,
  LineChart,
  LogOut,
  Mail,
  Menu,
  MessageSquare,
  Newspaper,
  Search,
  Settings,
  ShieldCheck,
  Target,
  Trophy,
  UserRound,
  Users,
  X,
} from 'lucide-react';
import { LogoLockup, LogoMark } from './Logo';
import { Badge, Button, StatusDot } from './ui';
import { useAuth } from '../hooks/useAuth';
import { useUnreadCount } from '../features/messages/usePrivateChat';
import { useSettings } from '../hooks/useSettings';
import { SearchOverlay } from './SearchOverlay';
import { useToast } from '../hooks/useToast';
import { initials } from '../lib/format';

export interface NavItem {
  to: string;
  label: string;
  shortLabel?: string;
  icon: ReactNode;
  hint: string;
  primary?: boolean;
}

export const NAV_ITEMS: NavItem[] = [
  { to: '/', label: 'Home', shortLabel: 'Home', icon: <Home size={18} />, hint: 'What should I do next?', primary: true },
  { to: '/tutor', label: 'AI', shortLabel: 'AI', icon: <MessageSquare size={18} />, hint: 'Ask a doubt, get it explained', primary: true },
  { to: '/practice', label: 'Practice', shortLabel: 'Practice', icon: <Target size={18} />, hint: 'Topic-wise question sets', primary: true },
  { to: '/arena', label: 'Arena', shortLabel: 'Arena', icon: <Trophy size={18} />, hint: 'Timed competitions and analysis', primary: true },
  {
    to: '/communities',
    label: 'Groups',
    shortLabel: 'Groups',
    icon: <Users size={18} />,
    hint: 'Study, share and compete together',
    primary: true,
  },
  /*
   * Everything else lives behind "More" — five reachable destinations in the mobile bar rather than
   * nine cramped ones (§5, §23). Note `primary` is deliberately absent on the items below.
   */
  { to: '/messages', label: 'Messages', icon: <Mail size={18} />, hint: 'Private, encrypted conversations' },
  { to: '/news', label: 'News', icon: <Newspaper size={18} />, hint: 'Headlines from publishers’ own feeds' },
  { to: '/mock-exam', label: 'Mock Exam', icon: <Compass size={18} />, hint: 'Timed tests with analysis' },
  { to: '/notes', label: 'Notes', icon: <BookOpen size={18} />, hint: 'Organise and clean your notes' },
  { to: '/code-lab', label: 'Code Lab', icon: <Code2 size={18} />, hint: 'Write, run and review code' },
  { to: '/profile', label: 'Profile', icon: <UserRound size={18} />, hint: 'Your bio, photo and privacy' },
  {
    to: '/analytics',
    label: 'Learning Analytics',
    shortLabel: 'Analytics',
    icon: <LineChart size={18} />,
    hint: 'Trends, subject accuracy and study rhythm',
  },
  { to: '/activity', label: 'Learning Activity', shortLabel: 'Activity', icon: <Activity size={18} />, hint: 'Your progress and weak areas' },
  { to: '/settings', label: 'Settings', icon: <Settings size={18} />, hint: 'AI keys, level, language, privacy' },
  { to: '/help', label: 'Help', icon: <CircleHelp size={18} />, hint: 'How everything works' },
];

/**
 * Staff-only destination: review and approve Arena papers before they can go live.
 * Kept out of NAV_ITEMS so it never appears for students (the API enforces the same rule).
 */
export const ADMIN_NAV_ITEM: NavItem = {
  to: '/arena/admin',
  label: 'Paper Review',
  shortLabel: 'Papers',
  icon: <ShieldCheck size={18} />,
  hint: 'Review, approve and publish competition papers',
};

function NavItemLink({
  item,
  onNavigate,
  collapsed,
  unread = 0,
}: {
  item: NavItem;
  onNavigate?: () => void;
  collapsed?: boolean;
  unread?: number;
}) {
  return (
    <NavLink
      to={item.to}
      onClick={onNavigate}
      title={item.hint}
      className={({ isActive }) =>
        [
          'group flex items-center gap-3 rounded-[10px] px-3 py-2.5 text-[13.5px] transition-colors',
          isActive
            ? 'bg-[var(--color-primary)]/12 text-[var(--color-primary)] ring-1 ring-inset ring-[var(--color-primary)]/25'
            : 'text-[var(--color-muted)] hover:bg-white/[0.04] hover:text-[var(--color-text)]',
        ].join(' ')
      }
    >
      <span className="shrink-0">{item.icon}</span>
      {!collapsed ? <span className="truncate font-medium">{item.label}</span> : null}
      {!collapsed && item.to === '/messages' && unread > 0 ? (
        <span className="ml-auto rounded-full bg-[var(--color-primary)] px-1.5 text-[11px] font-semibold text-black">{unread}</span>
      ) : null}
    </NavLink>
  );
}

/** Compact AI connection indicator — honest about whether real AI is answering. */
function AIStatusPill() {
  const { hasAnyKey, hasConnectedKey, keys, settings, loading } = useSettings();
  const navigate = useNavigate();

  if (loading || !settings) return null;
  const attention = keys
    ? Object.values(keys)
        .flatMap((entry) => entry.keys)
        .filter((key) => key.status === 'invalid' || key.status === 'error').length
    : 0;

  const tone = hasConnectedKey ? 'success' : hasAnyKey ? 'warning' : settings.demoMode ? 'muted' : 'error';
  const label = hasConnectedKey ? 'AI connected' : hasAnyKey ? 'Keys need testing' : settings.demoMode ? 'Sample mode' : 'No AI key';

  return (
    <button
      type="button"
      onClick={() => navigate('/settings')}
      className="vroqn-tap flex items-center gap-2 rounded-full border border-[var(--color-border)] bg-[var(--color-surface)] px-2.5 py-1.5 text-[11.5px] text-[var(--color-muted)] transition-colors hover:border-[var(--color-border-strong)] hover:text-[var(--color-text)]"
      title={attention ? `${attention} key(s) need attention — open AI Settings` : 'Open AI Settings'}
    >
      <StatusDot tone={tone} label={label} />
      {attention ? <span className="text-[#fcd28b]">· {attention} to fix</span> : null}
    </button>
  );
}

export function AppShell({ children }: { children: ReactNode }) {
  const [drawerOpen, setDrawerOpen] = useState(false);
  const [searchOpen, setSearchOpen] = useState(false);
  const { pathname } = useLocation();
  const { user, logout } = useAuth();
  const { push } = useToast();
  const navigate = useNavigate();

  useEffect(() => {
    setDrawerOpen(false);
    setSearchOpen(false);
  }, [pathname]);

  /*
   * Cmd/Ctrl+K opens search from anywhere — the keyboard habit most students already have from other
   * apps, and the fastest way to reach a classmate or a group from a screen they are already on.
   */
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'k') {
        event.preventDefault();
        setSearchOpen(true);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  useEffect(() => {
    document.body.style.overflow = drawerOpen ? 'hidden' : '';
    return () => {
      document.body.style.overflow = '';
    };
  }, [drawerOpen]);

  // Staff see one extra destination. Students never render it, and the API rejects them anyway.
  const navItems = user?.role === 'admin' ? [...NAV_ITEMS, ADMIN_NAV_ITEM] : NAV_ITEMS;
  /*
   * The dashboard is home; every other screen is a place you can arrive at and leave. On those
   * screens the header's leading button goes back to where the student came from, so nothing is a
   * dead end now that the bottom bar is gone. The full navigation menu is still one tap away on the
   * dashboard, and inside every page's own actions.
   */
  const onHome = pathname === '/';
  // One small request, no conversation payload: the count on the Messages item.
  const unreadMessages = useUnreadCount();
  const badgeFor = (to: string) => (to === '/messages' && unreadMessages > 0 ? unreadMessages : 0);
  // The Arena exam runner owns the whole screen: no sidebar, no bottom bar, no accidental taps.
  const examFocusMode = /^\/arena\/[^/]+\/start$/.test(pathname);

  if (examFocusMode) {
    return (
      <div className="min-h-[100dvh] w-full bg-[var(--color-bg)]">
        <main id="main" className="min-h-[100dvh]">
          {children}
        </main>
      </div>
    );
  }

  return (
    <div className="flex min-h-[100dvh] w-full bg-[var(--color-bg)]">
      {/* ---------------------------- desktop sidebar ---------------------------- */}
      <aside className="hidden w-[248px] shrink-0 flex-col border-r border-[var(--color-border)] bg-[var(--color-surface)] lg:flex xl:w-[264px]">
        <div className="flex items-center px-4 py-4">
          <LogoLockup subtitle="Learn · Practise · Build · Test" />
        </div>

        <nav className="flex-1 space-y-1 overflow-y-auto px-3 pb-4" aria-label="Main">
          {navItems.map((item) => (
            <NavItemLink key={item.to} item={item} unread={badgeFor(item.to)} />
          ))}
        </nav>

        <div className="space-y-3 border-t border-[var(--color-border)] px-3 py-3">
          <AIStatusPill />
          <div className="flex items-center gap-2.5 rounded-[10px] border border-[var(--color-border)] bg-[var(--color-card)] px-2.5 py-2">
            <span className="grid h-8 w-8 shrink-0 place-items-center rounded-full bg-[var(--color-primary)]/12 text-[12px] font-semibold text-[var(--color-primary)]">
              {initials(user?.name ?? 'Student')}
            </span>
            <div className="min-w-0 flex-1">
              <p className="truncate text-[12.5px] font-medium text-[var(--color-text)]">{user?.name ?? 'Student'}</p>
              <p className="truncate text-[11px] text-[var(--color-muted-dim)]">
                {user?.classLevel ? `${user.classLevel}${user.board ? ` · ${user.board}` : ''}` : user?.email}
              </p>
            </div>
            <Button
              variant="ghost"
              size="icon"
              aria-label="Sign out"
              title="Sign out"
              onClick={() => {
                void logout().then(() => push({ tone: 'info', title: 'Signed out', detail: 'See you soon!' }));
              }}
            >
              <LogOut size={16} />
            </Button>
          </div>
          <p className="flex items-center gap-1.5 px-1 text-[11.5px] leading-snug text-[var(--color-muted-dim)]">
            <ShieldCheck size={12} /> Activity is stored only for your own progress view.
          </p>
        </div>
      </aside>

      {/* ------------------------------- workspace ------------------------------- */}
      <div className="flex min-w-0 flex-1 flex-col">
        {/* mobile header */}
        {/*
          Solid, not translucent. The glass treatment relied on `backdrop-filter`, which is not
          guaranteed to run (older Android WebViews, some headless builds, reduced-transparency
          settings); when it does not, the page scrolls *through* the header and the title collides
          with whatever is underneath. A sticky header that can become unreadable is not worth the
          blur, so this one is opaque on every device.
        */}
        <header className="sticky top-0 z-30 flex items-center gap-2 border-b border-[var(--color-border)] bg-[var(--color-surface)] px-3 py-2.5 lg:hidden safe-top">
          {/*
            On the dashboard the leading button opens the full menu; on every other screen it goes
            back. The dashboard is the hub (§ turn 8), so it is the one screen that does not sit
            "inside" anything, and every other screen needs a way out that is not the browser button.
          */}
          {onHome ? (
            <button
              type="button"
              onClick={() => setDrawerOpen(true)}
              aria-label="Open navigation menu"
              className="grid h-10 w-10 shrink-0 place-items-center rounded-[10px] border border-[var(--color-border)] bg-[var(--color-surface)] text-[var(--color-muted)]"
            >
              <Menu size={18} />
            </button>
          ) : (
            <button
              type="button"
              onClick={() => navigate(-1)}
              aria-label="Go back"
              className="grid h-10 w-10 shrink-0 place-items-center rounded-[10px] border border-[var(--color-border)] bg-[var(--color-surface)] text-[var(--color-muted)]"
            >
              <ArrowLeft size={18} />
            </button>
          )}
          <div className="min-w-0 flex-1">
            <LogoLockup size={24} />
          </div>
          <button
            type="button"
            onClick={() => setSearchOpen(true)}
            /* Distinct from the field's own name: "Open search" is an action, not the same control. */
            aria-label="Open search"
            className="grid h-10 w-10 shrink-0 place-items-center rounded-[10px] border border-[var(--color-border)] bg-[var(--color-surface)] text-[var(--color-muted)]"
          >
            <Search size={18} />
          </button>
          <AIStatusPill />
        </header>

        {/*
          The `key` re-mounts this wrapper per route, which is what replays the entrance animation.
          A short lift-and-fade (not a fade alone) reads as "a new page arrived" rather than "the
          previous one dimmed", and it costs one composited transform.
        */}
        {/* No bottom bar any more (§ turn 8): the dashboard is the hub, the header keeps a menu. */}
        <main id="main" className="min-w-0 flex-1 pb-8">
          <div key={pathname} className="vroqn-page-enter">
            {children}
          </div>
        </main>
      </div>

      {/* ------------------------------ mobile drawer ---------------------------- */}
      {drawerOpen ? (
        <div className="fixed inset-0 z-50 lg:hidden" role="dialog" aria-modal="true" aria-label="Navigation">
          <button className="absolute inset-0 bg-black/70 backdrop-blur-sm" aria-label="Close navigation" onClick={() => setDrawerOpen(false)} />
          <div className="relative flex h-full w-[80%] max-w-[300px] flex-col border-r border-[var(--color-border)] bg-[var(--color-surface)] animate-[rise_0.2s_ease-out]">
            <div className="flex items-center justify-between px-4 py-3.5">
              <LogoLockup size={26} />
              <Button variant="ghost" size="icon" aria-label="Close navigation" onClick={() => setDrawerOpen(false)}>
                <X size={18} />
              </Button>
            </div>
            <nav className="flex-1 space-y-1 overflow-y-auto px-3 pb-4" aria-label="All sections">
              {navItems.map((item) => (
                <NavItemLink key={item.to} item={item} unread={badgeFor(item.to)} onNavigate={() => setDrawerOpen(false)} />
              ))}
            </nav>
            <div className="space-y-3 border-t border-[var(--color-border)] px-3 py-3">
              <AIStatusPill />
              <div className="flex items-center gap-2.5 rounded-[10px] border border-[var(--color-border)] bg-[var(--color-card)] px-2.5 py-2">
                <span className="grid h-8 w-8 shrink-0 place-items-center rounded-full bg-[var(--color-primary)]/12 text-[12px] font-semibold text-[var(--color-primary)]">
                  {initials(user?.name ?? 'Student')}
                </span>
                <div className="min-w-0 flex-1">
                  <p className="truncate text-[12.5px] font-medium">{user?.name}</p>
                  <p className="truncate text-[11px] text-[var(--color-muted-dim)]">{user?.email}</p>
                </div>
                <Button
                  variant="ghost"
                  size="icon"
                  aria-label="Sign out"
                  onClick={() => {
                    setDrawerOpen(false);
                    void logout();
                  }}
                >
                  <LogOut size={16} />
                </Button>
              </div>
            </div>
          </div>
        </div>
      ) : null}

      {/* Search is a sheet on every screen, so "find a classmate" is one tap from anywhere. */}
      <SearchOverlay open={searchOpen} onClose={() => setSearchOpen(false)} />
    </div>
  );
}

/** Page header used by every feature page for consistent hierarchy. */
export function PageHeader({
  title,
  description,
  actions,
  badge,
  children,
}: {
  title: string;
  description?: string;
  actions?: ReactNode;
  badge?: ReactNode;
  children?: ReactNode;
}) {
  return (
    <div className="border-b border-[var(--color-border)] bg-gradient-to-b from-[var(--color-surface)] to-transparent px-4 pb-4 pt-5 sm:px-6 sm:pb-5 sm:pt-6">
      <div className="mx-auto flex max-w-6xl flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-2">
            <h1 className="text-[20px] font-semibold tracking-tight sm:text-[23px]">{title}</h1>
            {badge}
          </div>
          {description ? <p className="mt-1 max-w-2xl text-[13px] leading-relaxed text-[var(--color-muted)]">{description}</p> : null}
        </div>
        {actions ? <div className="flex shrink-0 flex-wrap items-center gap-2">{actions}</div> : null}
      </div>
      {children ? <div className="mx-auto mt-4 max-w-6xl">{children}</div> : null}
    </div>
  );
}

export function PageBody({ children, className = '' }: { children: ReactNode; className?: string }) {
  return <div className={`mx-auto max-w-6xl px-4 py-5 sm:px-6 sm:py-6 ${className}`}>{children}</div>;
}

export { LogoMark, Badge };
