/**
 * Routing + providers.
 *
 * Settings/AI context is only mounted once a session exists, so a signed-out visitor never
 * triggers authenticated requests. Every feature route lazy-loads so the first paint on a slow
 * phone stays small (spec §26).
 */
import { Suspense, lazy, useEffect } from 'react';
import { Navigate, Route, Routes, useNavigate } from 'react-router-dom';
import { AppShell } from './components/AppShell';
import { ToastHost } from './components/ToastHost';
import { LoadingState, Spinner } from './components/ui';
import { LogoMark } from './components/Logo';
import { useAuth } from './hooks/useAuth';
import { SettingsProvider } from './hooks/useSettings';
import { AuthPage } from './features/auth/AuthPage';

const DashboardPage = lazy(() => import('./features/dashboard/DashboardPage').then((m) => ({ default: m.DashboardPage })));
const TutorPage = lazy(() => import('./features/tutor/TutorPage').then((m) => ({ default: m.TutorPage })));
const PracticePage = lazy(() => import('./features/practice/PracticePage').then((m) => ({ default: m.PracticePage })));
const ExamsPage = lazy(() => import('./features/exams/ExamsPage').then((m) => ({ default: m.ExamsPage })));
const ExamRunnerPage = lazy(() => import('./features/exams/ExamRunnerPage').then((m) => ({ default: m.ExamRunnerPage })));
const ExamResultPage = lazy(() => import('./features/exams/ExamResultPage').then((m) => ({ default: m.ExamResultPage })));
const NotesPage = lazy(() => import('./features/notes/NotesPage').then((m) => ({ default: m.NotesPage })));
const CodeLabPage = lazy(() => import('./features/code-lab/CodeLabPage').then((m) => ({ default: m.CodeLabPage })));
const ActivityPage = lazy(() => import('./features/activity/ActivityPage').then((m) => ({ default: m.ActivityPage })));
/*
 * Learning Analytics (turn 9): its own route rather than a tab inside Activity, because it is a
 * report — a student opens it to read, not to log — and a separate chunk keeps that report off the
 * critical path for everyone else.
 */
const LearningAnalyticsPage = lazy(() =>
  import('./features/analytics/LearningAnalyticsPage').then((m) => ({ default: m.LearningAnalyticsPage })),
);
const SettingsPage = lazy(() => import('./features/settings/SettingsPage').then((m) => ({ default: m.SettingsPage })));
const ArenaHomePage = lazy(() => import('./features/arena/ArenaHomePage').then((m) => ({ default: m.ArenaHomePage })));
const ArenaCompetitionPage = lazy(() =>
  import('./features/arena/ArenaCompetitionPage').then((m) => ({ default: m.ArenaCompetitionPage })),
);
const ArenaRunnerPage = lazy(() => import('./features/arena/ArenaRunnerPage').then((m) => ({ default: m.ArenaRunnerPage })));
const ArenaResultsPage = lazy(() => import('./features/arena/ArenaResultsPage').then((m) => ({ default: m.ArenaResultsPage })));
const ArenaMyPage = lazy(() => import('./features/arena/ArenaMyPage').then((m) => ({ default: m.ArenaMyPage })));
const ArenaAdminPage = lazy(() => import('./features/arena/ArenaAdminPage').then((m) => ({ default: m.ArenaAdminPage })));
const LandingPage = lazy(() => import('./features/landing/LandingPage').then((m) => ({ default: m.LandingPage })));
/*
 * Communities (§48): one main-nav section. The community page itself is a single route whose tab is
 * held in the URL, so a shared link opens exactly the screen the sender was looking at.
 */
const ExploreCommunitiesPage = lazy(() =>
  import('./features/communities/ExploreCommunitiesPage').then((m) => ({ default: m.ExploreCommunitiesPage })),
);
const CreateCommunityPage = lazy(() =>
  import('./features/communities/CreateCommunityPage').then((m) => ({ default: m.CreateCommunityPage })),
);
const CommunityPage = lazy(() => import('./features/communities/CommunityPage').then((m) => ({ default: m.CommunityPage })));
const CommunityNotificationsPage = lazy(() =>
  import('./features/communities/NotificationsPage').then((m) => ({ default: m.NotificationsPage })),
);
const CommunityProfilePage = lazy(() =>
  import('./features/communities/CommunityProfilePage').then((m) => ({ default: m.CommunityProfilePage })),
);
/*
 * Turn 7 screens: private messaging, the editable profile and the news reader. All three are their own
 * lazy chunks, so a student who never opens Messages never downloads the crypto code for it.
 */
const MessagesPage = lazy(() => import('./features/messages/MessagesPage').then((m) => ({ default: m.MessagesPage })));
const ProfilePage = lazy(() => import('./features/profile/ProfilePage').then((m) => ({ default: m.ProfilePage })));
const NewsPage = lazy(() => import('./features/news/NewsPage').then((m) => ({ default: m.NewsPage })));
const HelpPage = lazy(() => import('./features/help/HelpPage').then((m) => ({ default: m.HelpPage })));

function BootScreen() {
  return (
    <div className="grid min-h-[100dvh] place-items-center bg-[var(--color-bg)]">
      <div className="flex flex-col items-center gap-4">
        <div className="relative">
          <LogoMark size={54} />
          <span className="absolute -inset-1 rounded-2xl animate-[ripple_1.8s_ease-out_infinite] border border-[var(--color-primary)]/40" />
        </div>
        <div
          role="status"
          aria-live="polite"
          className="flex items-center gap-2 text-[12.5px] text-[var(--color-muted)]"
        >
          <Spinner size={14} /> Warming up your workspace…
        </div>
      </div>
    </div>
  );
}

function RouteFallback() {
  // Shown while a page's JavaScript chunk downloads. Named pages load in well under a second on a
  // normal connection, so the message stays deliberately plain rather than inventing detail.
  return <LoadingState message="Loading this page…" className="py-24" />;
}

/** Any 404 inside the app returns the student to somewhere useful. */
function NotFoundRedirect() {
  const navigate = useNavigate();
  useEffect(() => {
    navigate('/', { replace: true });
  }, [navigate]);
  return <RouteFallback />;
}

export function App() {
  const { user, loading } = useAuth();

  useEffect(() => {
    document.documentElement.classList.add('dark');
  }, []);

  if (loading) return <BootScreen />;

  if (!user) {
    return (
      <>
        <Suspense fallback={<BootScreen />}>
          <Routes>
            {/*
              Public surface. The landing page owns "/" for signed-out visitors (a student with no
              session should land on the product explanation, not a login wall), while "/" stays the
              dashboard for anyone signed in — see the branch below.
            */}
            <Route path="/" element={<LandingPage />} />
            <Route path="/login" element={<AuthPage mode="login" />} />
            <Route path="/signup" element={<AuthPage mode="signup" />} />
            <Route path="*" element={<Navigate to="/" replace />} />
          </Routes>
        </Suspense>
        <ToastHost />
      </>
    );
  }

  return (
    <SettingsProvider>
      <AppShell>
        <Suspense fallback={<RouteFallback />}>
          <Routes>
            <Route path="/" element={<DashboardPage />} />
            <Route path="/tutor" element={<TutorPage />} />
            <Route path="/tutor/:conversationId" element={<TutorPage />} />
            <Route path="/practice" element={<PracticePage />} />
            <Route path="/mock-exam" element={<ExamsPage />} />
            <Route path="/mock-exam/:examId" element={<ExamRunnerPage />} />
            <Route path="/mock-exam/results/:resultId" element={<ExamResultPage />} />
            <Route path="/notes" element={<NotesPage />} />
            <Route path="/notes/:noteId" element={<NotesPage />} />
            <Route path="/code-lab" element={<CodeLabPage />} />
            <Route path="/arena" element={<ArenaHomePage />} />
            <Route path="/arena/my-competitions" element={<ArenaMyPage />} />
            <Route path="/arena/admin" element={<ArenaAdminPage />} />
            <Route path="/arena/results/:attemptId" element={<ArenaResultsPage />} />
            <Route path="/arena/:id/start" element={<ArenaRunnerPage />} />
            <Route path="/arena/:id" element={<ArenaCompetitionPage />} />
            {/* Communities. Literal paths are declared before the id/slug route. */}
            <Route path="/communities" element={<ExploreCommunitiesPage />} />
            <Route path="/communities/new" element={<CreateCommunityPage />} />
            <Route path="/communities/notifications" element={<CommunityNotificationsPage />} />
            <Route path="/communities/profile/me" element={<CommunityProfilePage />} />
            <Route path="/communities/profile/:userId" element={<CommunityProfilePage />} />
            <Route path="/communities/:idOrSlug" element={<CommunityPage />} />
            {/* Private messaging. The id is part of the route so a thread can be linked and reloaded. */}
            <Route path="/messages" element={<MessagesPage />} />
            <Route path="/messages/:conversationId" element={<MessagesPage />} />
            {/* Profile: your own, or another student's — messaging starts from any profile. */}
            <Route path="/profile" element={<ProfilePage />} />
            <Route path="/profile/:userId" element={<ProfilePage />} />
            <Route path="/news" element={<NewsPage />} />
            <Route path="/help" element={<HelpPage />} />
            <Route path="/analytics" element={<LearningAnalyticsPage />} />
            <Route path="/activity" element={<ActivityPage />} />
            <Route path="/settings" element={<SettingsPage />} />
            {/* A signed-in student following an old /login or /signup link goes to the dashboard. */}
            <Route path="/login" element={<Navigate to="/" replace />} />
            <Route path="/signup" element={<Navigate to="/" replace />} />
            <Route path="*" element={<NotFoundRedirect />} />
          </Routes>
        </Suspense>
      </AppShell>
      <ToastHost />
    </SettingsProvider>
  );
}
