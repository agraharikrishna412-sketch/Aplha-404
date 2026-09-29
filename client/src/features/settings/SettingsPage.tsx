/**
 * AI Settings (spec §11, §15, §16).
 *
 * Providers → keys → routing → learning profile → privacy.
 * Keys are write-only from the UI: the plaintext is sent once, stored encrypted, and only the
 * masked form ever comes back.
 */
import { useCallback, useState, type ReactNode } from 'react';
import { useNavigate } from 'react-router-dom';
import {
  AlertTriangle,
  CheckCircle2,
  CircleHelp,
  IdCard,
  Mail,
  UserRound,
  ChevronDown,
  Eye,
  EyeOff,
  ExternalLink,
  KeyRound,
  Plus,
  RefreshCw,
  Route,
  ShieldCheck,
  Sparkles,
  Trash2,
} from 'lucide-react';
import { PageBody, PageHeader } from '../../components/AppShell';
import { VroqnSection } from '../../components/vroqn';
import {
  Badge,
  Button,
  Card,
  CardHeader,
  ErrorState,
  Field,
  SampleNotice,
  Segmented,
  Spinner,
  StatTile,
  StatusDot,
  Switch,
  TextInput,
} from '../../components/ui';
import { useSettings, type SettingsPatch } from '../../hooks/useSettings';
import { useAuth } from '../../hooks/useAuth';
import { useToast } from '../../hooks/useToast';
import { useConfirm } from '../../components/Confirm';
import { api, ApiError } from '../../lib/api';
import { timeAgo } from '../../lib/format';
import type { KeyStatus, ProviderId, TaskKind } from '../../types';
import { VroqnFilterSelect } from '../../components/vroqn';
import { DeleteAccountCard } from './DangerZone';

const STATUS_TONE: Record<KeyStatus, 'success' | 'warning' | 'error' | 'muted'> = {
  connected: 'success',
  untested: 'warning',
  rate_limited: 'warning',
  invalid: 'error',
  error: 'error',
  disabled: 'muted',
};

const STATUS_LABEL: Record<KeyStatus, string> = {
  connected: 'Connected',
  untested: 'Not tested',
  rate_limited: 'Rate limited',
  invalid: 'Key rejected',
  error: 'Error',
  disabled: 'Disabled',
};

const ROUTING_ROWS: { task: TaskKind; label: string; hint: string }[] = [
  { task: 'general', label: 'Default AI', hint: 'Everyday explanations and doubts' },
  { task: 'coding', label: 'Coding AI', hint: 'Code review, explanation and help' },
  { task: 'notes', label: 'Notes AI', hint: 'Cleaning up and summarising notes' },
  { task: 'exam', label: 'Mock Exam AI', hint: 'Question papers and exam analysis' },
  { task: 'practice', label: 'Practice AI', hint: 'Generating practice questions' },
  { task: 'fallback', label: 'Fallback provider', hint: 'Used first when the chosen provider fails' },
];

/**
 * The category rail. Each entry either jumps to a section on this page or opens the screen that owns
 * that setting — no entry exists that does not lead somewhere real.
 */
const SETTINGS_CATEGORIES: {
  id: string;
  label: string;
  detail: string;
  icon: ReactNode;
  href?: string;
}[] = [
  { id: 'providers', label: 'AI providers', detail: 'Gemini, Groq and OpenRouter keys', icon: <KeyRound size={14} /> },
  { id: 'routing', label: 'Task routing', detail: 'Which provider answers which kind of request', icon: <Route size={14} /> },
  { id: 'learning', label: 'Learning profile', detail: 'Explanation level and answer language', icon: <Sparkles size={14} /> },
  { id: 'privacy', label: 'Privacy and data', detail: 'What is stored, and clearing your history', icon: <ShieldCheck size={14} /> },
  { id: 'account', label: 'Account', detail: 'Name, class and board, sign out', icon: <UserRound size={14} /> },
  { id: 'profile', label: 'Profile', detail: 'Bio, photo, accent and visibility', icon: <IdCard size={14} />, href: '/profile' },
  { id: 'messages', label: 'Messages', detail: 'Who may message you, blocked students', icon: <Mail size={14} />, href: '/messages' },
  { id: 'help', label: 'Help', detail: 'How encryption, keys and Arena work', icon: <CircleHelp size={14} />, href: '/help' },
];

export function SettingsPage() {
  const {
    settings,
    providers,
    keys,
    runtime,
    loading,
    error,
    hasAnyKey,
    hasConnectedKey,
    save,
    addKey,
    updateKey,
    removeKey,
    testKey,
    checkAll,
    refreshModels,
    reload,
  } = useSettings();
  const { user, updateProfile, logout } = useAuth();
  const { push } = useToast();
  const confirm = useConfirm();
  const navigate = useNavigate();

  const [testing, setTesting] = useState<string | null>(null);
  const [testingAll, setTestingAll] = useState(false);
  const [addingFor, setAddingFor] = useState<ProviderId | null>(null);
  const [newKey, setNewKey] = useState('');
  const [newKeyLabel, setNewKeyLabel] = useState('');
  const [revealKey, setRevealKey] = useState(false);
  const [addError, setAddError] = useState<string | null>(null);
  const [expandedModels, setExpandedModels] = useState<ProviderId | null>(null);
  const [profile, setProfile] = useState({ name: user?.name ?? '', classLevel: user?.classLevel ?? 'Class 10', board: user?.board ?? 'CBSE' });
  const handleTest = useCallback(
    async (id: string, label: string) => {
      setTesting(id);
      try {
        const result = await testKey(id);
        push({
          tone: result.ok ? 'success' : 'error',
          title: result.ok ? `${label}: connected` : `${label}: not working`,
          detail: result.message,
        });
      } catch (err) {
        push({ tone: 'error', title: 'Test failed', detail: err instanceof ApiError ? err.message : 'Try again.' });
      } finally {
        setTesting(null);
      }
    },
    [push, testKey],
  );

  const handleTestAll = async () => {
    setTestingAll(true);
    try {
      const result = await checkAll();
      push({
        tone: result.healthy ? (result.healthy === result.tested ? 'success' : 'warning') : 'error',
        title: `${result.healthy}/${result.tested} keys healthy`,
        detail: result.tested ? 'Failover will use the healthy keys first.' : 'Add a key to get started.',
      });
    } catch (err) {
      push({ tone: 'error', title: 'Could not run the check', detail: err instanceof ApiError ? err.message : 'Try again.' });
    } finally {
      setTestingAll(false);
    }
  };

  const submitKey = async (provider: ProviderId) => {
    setAddError(null);
    if (!newKey.trim()) {
      setAddError('Paste your API key first.');
      return;
    }
    try {
      await addKey({ provider, key: newKey.trim(), label: newKeyLabel.trim() || undefined });
      push({ tone: 'success', title: 'Key saved', detail: 'It is encrypted at rest. Run Test to verify it.' });
      setNewKey('');
      setNewKeyLabel('');
      setAddingFor(null);
    } catch (err) {
      setAddError(err instanceof ApiError ? err.message : 'Could not save that key.');
    }
  };

  const updateSetting = (patch: SettingsPatch) => {
    void save(patch).catch((err) =>
      push({ tone: 'error', title: 'Could not save setting', detail: err instanceof ApiError ? err.message : 'Try again.' }),
    );
  };

  if (loading && !settings) {
    return (
      <PageBody>
        <div className="flex items-center justify-center gap-2 py-24 text-[13px] text-[var(--color-muted)]">
          <Spinner size={16} /> Loading your AI settings…
        </div>
      </PageBody>
    );
  }

  if (error && !settings) {
    return (
      <PageBody>
        <ErrorState message={error} onRetry={() => void reload()} />
      </PageBody>
    );
  }

  const totalKeys = keys ? Object.values(keys).reduce((total, entry) => total + entry.total, 0) : 0;

  return (
    <>
      <PageHeader
        title="AI Settings"
        description="Bring your own keys for Gemini, Groq and OpenRouter. Vroqn Nexus rotates them automatically when one fails, so a single bad key never stops your work."
        badge={<Badge tone={hasConnectedKey ? 'success' : hasAnyKey ? 'warning' : 'muted'}>{hasConnectedKey ? 'AI connected' : hasAnyKey ? 'Keys not verified' : 'No keys yet'}</Badge>}
        actions={
          <>
            <Button variant="secondary" icon={<RefreshCw size={15} />} loading={testingAll} onClick={() => void handleTestAll()} disabled={!totalKeys}>
              Test all keys
            </Button>
            <Button variant="ghost" icon={<Route size={15} />} onClick={() => navigate('/tutor')}>
              Back to tutor
            </Button>
          </>
        }
      />

      <PageBody className="space-y-5">
        {/*
          Categories (§19–§21). This page holds every setting, which is right for finding things but
          wrong for scanning them, so the rail names the areas and jumps to one. Categories that live
          on their own screen (Messages, Profile) link there instead of duplicating controls — two
          places to change one setting is how a student ends up unsure which one is real.
        */}
        <VroqnSection title="Settings" description="Pick an area, or scroll — everything here is one page.">
          <ul className="grid gap-2 sm:grid-cols-2 lg:grid-cols-4">
            {SETTINGS_CATEGORIES.map((category) => (
              <li key={category.id}>
                <button
                  type="button"
                  onClick={() => {
                    if (category.href) {
                      navigate(category.href);
                      return;
                    }
                    document.getElementById(category.id)?.scrollIntoView({ behavior: 'smooth', block: 'start' });
                  }}
                  className="vroqn-lift flex w-full items-start gap-2.5 rounded-[12px] border border-[var(--color-border)] bg-[var(--color-card)] px-3 py-2.5 text-left transition-colors hover:border-[var(--color-border-strong)]"
                >
                  <span className="mt-0.5 shrink-0 text-[var(--color-primary-soft)]">{category.icon}</span>
                  <span className="min-w-0">
                    <span className="block text-[13px] font-medium">{category.label}</span>
                    <span className="block text-[11.5px] leading-snug text-[var(--color-muted)]">{category.detail}</span>
                  </span>
                </button>
              </li>
            ))}
          </ul>
        </VroqnSection>

        <div className="grid grid-cols-2 gap-2.5 sm:grid-cols-4">
          <StatTile label="Providers configured" value={keys ? Object.values(keys).filter((entry) => entry.enabled > 0).length : 0} sub="of 3 supported" tone="primary" icon={<KeyRound size={14} />} />
          <StatTile label="Keys stored" value={totalKeys} sub="encrypted at rest" icon={<ShieldCheck size={14} />} />
          <StatTile
            label="Keys needing attention"
            value={keys ? Object.values(keys).reduce((total, entry) => total + entry.needsAttention, 0) : 0}
            tone={keys && Object.values(keys).some((entry) => entry.needsAttention) ? 'error' : 'success'}
          />
          <StatTile
            label="Failover attempts"
            value={`${settings?.demoMode ? 'Sample on' : 'Sample off'}`}
            sub={`up to ${runtime?.maxAttempts ?? 8} tries per request`}
            tone="neutral"
          />
        </div>

        {!hasAnyKey ? (
          <SampleNotice
            text="Vroqn Nexus works without keys using its built-in sample engine, but real AI answers need at least one key. Gemini has a generous free tier and is the simplest place to start."
            action={
              <Button size="sm" variant="secondary" onClick={() => setAddingFor('gemini')}>
                Add a Gemini key
              </Button>
            }
          />
        ) : null}

        {/* ------------------------------ AI providers ---------------------------- */}
        {/* (anchor: #providers) */}
        <section className="space-y-4" aria-labelledby="providers">
          <h2 id="providers" className="text-[13px] font-semibold uppercase tracking-wide text-[var(--color-muted-dim)]">
            AI providers
          </h2>

          {providers.map((provider) => {
            const entry = keys?.[provider.id];
            const providerKeys = entry?.keys ?? [];
            return (
              <Card key={provider.id}>
                <CardHeader
                  title={provider.label}
                  subtitle={
                    providerKeys.length
                      ? `${providerKeys.filter((key) => key.enabled).length} enabled · ${providerKeys.filter((key) => key.status === 'connected').length} verified`
                      : 'No key added yet'
                  }
                  icon={<Sparkles size={15} />}
                  right={
                    <>
                      <StatusDot
                        tone={
                          providerKeys.some((key) => key.enabled && key.status === 'connected')
                            ? 'success'
                            : providerKeys.some((key) => key.enabled)
                              ? 'warning'
                              : 'muted'
                        }
                        label={
                          providerKeys.some((key) => key.enabled && key.status === 'connected')
                            ? 'Connected'
                            : providerKeys.some((key) => key.enabled)
                              ? 'Not verified'
                              : 'Not configured'
                        }
                      />
                      <Button
                        size="sm"
                        variant="ghost"
                        onClick={() => setExpandedModels(expandedModels === provider.id ? null : provider.id)}
                        iconRight={<ChevronDown size={13} className={expandedModels === provider.id ? 'rotate-180 transition-transform' : 'transition-transform'} />}
                      >
                        Models
                      </Button>
                    </>
                  }
                />

                <div className="space-y-3 p-4">
                  {/* keys */}
                  {providerKeys.length ? (
                    <ul className="space-y-2">
                      {providerKeys.map((key) => (
                        <li
                          key={key.id}
                          className="flex flex-wrap items-center gap-2.5 rounded-xl border border-[var(--color-border)] bg-[var(--color-surface)] px-3 py-2.5"
                        >
                          <div className="min-w-0 flex-1">
                            <p className="flex flex-wrap items-center gap-2 text-[13px] font-medium">
                              {key.label}
                              {key.isDefault ? <Badge tone="primary">Default</Badge> : null}
                              <Badge tone={STATUS_TONE[key.status]}>{STATUS_LABEL[key.status]}</Badge>
                              {!key.enabled ? <Badge tone="muted">Off</Badge> : null}
                            </p>
                            <p className="mt-1 flex flex-wrap items-center gap-1.5 font-mono text-[11.5px] text-[var(--color-muted)]">
                              {key.masked}
                              <span className="font-sans text-[var(--color-muted-dim)]">
                                {key.lastUsedAt ? `· last used ${timeAgo(key.lastUsedAt)}` : '· never used'}
                                {key.successCount ? ` · ${key.successCount} success` : ''}
                                {key.failCount ? ` · ${key.failCount} fail` : ''}
                              </span>
                            </p>
                            {key.lastErrorMessage && (key.status === 'invalid' || key.status === 'error') ? (
                              <p className="mt-0.5 text-[11.5px] text-[#fca5a5]">{key.lastErrorMessage}</p>
                            ) : null}
                            {key.cooldownUntil && key.status === 'rate_limited' ? (
                              <p className="mt-0.5 text-[11.5px] text-[#fcd28b]">
                                Cooling down until {new Date(key.cooldownUntil).toLocaleTimeString()} — other keys are being used.
                              </p>
                            ) : null}
                          </div>
                          <div className="flex flex-wrap items-center gap-1.5">
                            <Button
                              size="sm"
                              variant="secondary"
                              loading={testing === key.id}
                              onClick={() => void handleTest(key.id, key.label)}
                            >
                              Test
                            </Button>
                            {!key.isDefault ? (
                              <Button size="sm" variant="ghost" onClick={() => void updateKey(key.id, { isDefault: true })}>
                                Make default
                              </Button>
                            ) : null}
                            <Button
                              size="sm"
                              variant="ghost"
                              onClick={() => void updateKey(key.id, { enabled: !key.enabled })}
                              aria-pressed={key.enabled}
                            >
                              {key.enabled ? 'Disable' : 'Enable'}
                            </Button>
                            <Button
                              size="icon"
                              variant="ghost"
                              aria-label={`Remove ${key.label}`}
                              onClick={() => {
                                void (async () => {
                                  const ok = await confirm({
                                    title: 'Remove this API key?',
                                    description:
                                      'Vroqn will stop using it. Your other keys for this provider keep working.',
                                    detail: key.label,
                                    confirmLabel: 'Remove key',
                                  });
                                  if (!ok) return;
                                  await removeKey(key.id).then(() => push({ tone: 'info', title: 'Key removed' }));
                                })();
                              }}
                            >
                              <Trash2 size={14} />
                            </Button>
                          </div>
                        </li>
                      ))}
                    </ul>
                  ) : (
                    <p className="rounded-xl border border-dashed border-[var(--color-border)] px-3.5 py-3 text-[12.5px] leading-relaxed text-[var(--color-muted)]">
                      Add the keys you own for {provider.label}. Multiple keys are supported — Vroqn Nexus tries the next one the
                      moment one hits a rate limit or stops working.
                    </p>
                  )}

                  {/* add key */}
                  {addingFor === provider.id ? (
                    <div className="space-y-3 rounded-xl border border-[var(--color-primary)]/30 bg-[var(--color-primary)]/[0.04] p-3.5">
                      <Field label={`${provider.label} API key`} hint={provider.keyPrefixHint} htmlFor={`key-${provider.id}`}>
                        <div className="flex gap-2">
                          <TextInput
                            id={`key-${provider.id}`}
                            type={revealKey ? 'text' : 'password'}
                            value={newKey}
                            onChange={(event) => setNewKey(event.target.value)}
                            placeholder={provider.keyPrefixHint}
                            autoComplete="off"
                            spellCheck={false}
                            className="font-mono text-[13px]"
                          />
                          <Button
                            variant="ghost"
                            size="icon"
                            aria-label={revealKey ? 'Hide key' : 'Show key'}
                            onClick={() => setRevealKey((value) => !value)}
                          >
                            {revealKey ? <EyeOff size={16} /> : <Eye size={16} />}
                          </Button>
                        </div>
                      </Field>
                      <Field label="Label" optional htmlFor={`label-${provider.id}`} hint="Helps you tell keys apart, e.g. “Personal free key”.">
                        <TextInput
                          id={`label-${provider.id}`}
                          value={newKeyLabel}
                          onChange={(event) => setNewKeyLabel(event.target.value)}
                          placeholder={`${provider.label} Key ${providerKeys.length + 1}`}
                        />
                      </Field>
                      {addError ? <p className="text-[12px] text-[#fca5a5]">{addError}</p> : null}
                      <div className="flex flex-wrap items-center gap-2">
                        <Button variant="primary" icon={<CheckCircle2 size={14} />} onClick={() => void submitKey(provider.id)}>
                          Save key
                        </Button>
                        <Button
                          variant="ghost"
                          onClick={() => {
                            setAddingFor(null);
                            setNewKey('');
                            setNewKeyLabel('');
                            setAddError(null);
                          }}
                        >
                          Cancel
                        </Button>
                        <a
                          href={provider.keyUrl}
                          target="_blank"
                          rel="noreferrer noopener"
                          className="vroqn-tap ml-auto flex items-center gap-1 text-[12px] text-[var(--color-primary-soft)] underline decoration-dotted underline-offset-2"
                        >
                          Get a {provider.label} key <ExternalLink size={12} />
                        </a>
                      </div>
                      <p className="flex items-start gap-1.5 text-[11.5px] leading-relaxed text-[var(--color-muted)]">
                        <ShieldCheck size={12} className="mt-0.5 shrink-0" />
                        Your key is encrypted before it is stored, never written to logs, and only ever sent to {provider.label}. Adding
                        keys does not create extra provider quota — it just lets Vroqn Nexus rotate the keys you already own.
                      </p>
                    </div>
                  ) : (
                    <Button
                      variant="secondary"
                      icon={<Plus size={15} />}
                      onClick={() => {
                        setAddingFor(provider.id);
                        setAddError(null);
                      }}
                    >
                      Add {provider.label} key
                    </Button>
                  )}

                  {/* models */}
                  {expandedModels === provider.id ? (
                    <div className="space-y-2 rounded-xl border border-[var(--color-border)] bg-[var(--color-surface)] p-3.5">
                      <div className="flex flex-wrap items-center justify-between gap-2">
                        <p className="text-[12px] font-semibold uppercase tracking-wide text-[var(--color-muted-dim)]">Available models</p>
                        <Button
                          size="sm"
                          variant="ghost"
                          icon={<RefreshCw size={13} />}
                          onClick={() =>
                            void refreshModels(provider.id).then((result) =>
                              push({
                                tone: result.ok ? 'success' : 'warning',
                                title: result.ok ? 'Model list refreshed' : 'Refresh skipped',
                                detail: result.message,
                              }),
                            )
                          }
                        >
                          Refresh from provider
                        </Button>
                      </div>
                      <ul className="space-y-1.5">
                        {provider.models.map((model) => (
                          <li key={model.id} className="flex flex-wrap items-center gap-2 text-[12.5px]">
                            <span className="min-w-0 flex-1 truncate">
                              <span className="font-medium">{model.label}</span>
                              <span className="ml-2 font-mono text-[11px] text-[var(--color-muted-dim)]">{model.id}</span>
                            </span>
                            <Badge tone="muted">{model.speed}</Badge>
                            {model.vision ? <Badge tone="primary">images</Badge> : null}
                            {model.code ? <Badge tone="muted">code</Badge> : null}
                            {settings?.modelPrefs?.[provider.id] === model.id ? <Badge tone="success">preferred</Badge> : null}
                            <Button
                              size="sm"
                              variant="ghost"
                              onClick={() =>
                                updateSetting({
                                  modelPrefs: { [provider.id]: settings?.modelPrefs?.[provider.id] === model.id ? '' : model.id },
                                })
                              }
                            >
                              {settings?.modelPrefs?.[provider.id] === model.id ? 'Clear' : 'Prefer'}
                            </Button>
                          </li>
                        ))}
                      </ul>
                      <p className="text-[11.5px] leading-relaxed text-[var(--color-muted)]">
                        Capabilities: {provider.capabilities.vision ? 'reads images and PDFs' : 'text only'}
                        {provider.capabilities.json ? ' · structured output' : ''}.
                      </p>
                    </div>
                  ) : null}
                </div>
              </Card>
            );
          })}
        </section>

        {/* ------------------------------- routing ------------------------------- */}
        <span id="routing" aria-hidden="true" className="block scroll-mt-24" />
        <Card>
          <CardHeader
            title="Task routing"
            subtitle="Which provider should handle each kind of work. The fallback chain still applies if it fails."
            icon={<Route size={15} />}
          />
          <div className="grid gap-3 p-4 sm:grid-cols-2">
            {ROUTING_ROWS.map((row) => (
              <Field key={row.task} label={row.label} hint={row.hint}>
                <VroqnFilterSelect
                  label={row.label}
                  value={settings?.routing[row.task] ?? 'gemini'}
                  onChange={(next) => updateSetting({ routing: { [row.task]: next as ProviderId } })}
                  options={providers.map((provider) => ({ value: provider.id, label: provider.label }))}
                />
              </Field>
            ))}
          </div>
          <div className="border-t border-[var(--color-border)] px-4 py-3 text-[12px] leading-relaxed text-[var(--color-muted)]">
            How a request flows: <strong className="text-[var(--color-text)]">task provider → its keys (default first) → other models → fallback
            provider → remaining provider</strong>. Rate limits and temporary errors move to the next key automatically; rejected keys are
            parked and flagged above. Safety refusals are never retried on another provider.
          </div>
        </Card>

        {/* --------------------------- learning profile --------------------------- */}
        <span id="learning" aria-hidden="true" className="block scroll-mt-24" />
        <Card>
          <CardHeader title="Learning profile" subtitle="Shapes how the AI explains things to you" icon={<Sparkles size={15} />} />
          <div className="grid gap-3 p-4 sm:grid-cols-2">
            <Field label="Explanation level" hint="Changes vocabulary, depth and the examples used.">
              <Segmented
                value={settings?.explanationLevel ?? 'class9_10'}
                onChange={(value) => updateSetting({ explanationLevel: value })}
                label="Explanation level"
                options={[
                  { value: 'class6_8' as const, label: 'Class 6–8' },
                  { value: 'class9_10' as const, label: 'Class 9–10' },
                  { value: 'class11_12' as const, label: 'Class 11–12' },
                ]}
              />
            </Field>
            <Field label="Answer language">
              <Segmented
                value={settings?.language ?? 'english'}
                onChange={(value) => updateSetting({ language: value })}
                label="Language"
                options={[
                  { value: 'english' as const, label: 'English' },
                  { value: 'hinglish' as const, label: 'Hinglish' },
                  { value: 'hindi' as const, label: 'हिंदी' },
                ]}
              />
            </Field>
            <Field label="Default subject">
              <VroqnFilterSelect
                label="Default subject"
                value={settings?.subjectDefaults.subject ?? 'Physics'}
                onChange={(next) =>
                  updateSetting({
                    subjectDefaults: {
                      subject: next,
                      chapter: '',
                      difficulty: settings?.subjectDefaults.difficulty ?? 'medium',
                    },
                  })
                }
                options={['Physics', 'Chemistry', 'Biology', 'Mathematics', 'Computer Science', 'English', 'Social Science', 'General Knowledge'].map(
                  (subject) => ({ value: subject, label: subject }),
                )}
              />
            </Field>
            <Field label="Default difficulty">
              <Segmented
                value={(settings?.subjectDefaults.difficulty ?? 'medium') as 'easy' | 'medium' | 'hard'}
                onChange={(value) =>
                  updateSetting({
                    subjectDefaults: {
                      subject: settings?.subjectDefaults.subject ?? 'Physics',
                      chapter: settings?.subjectDefaults.chapter ?? '',
                      difficulty: value,
                    },
                  })
                }
                label="Default difficulty"
                options={[
                  { value: 'easy' as const, label: 'Easy' },
                  { value: 'medium' as const, label: 'Medium' },
                  { value: 'hard' as const, label: 'Hard' },
                ]}
              />
            </Field>
          </div>
        </Card>

        {/* -------------------------------- privacy ------------------------------- */}
        <span id="privacy" aria-hidden="true" className="block scroll-mt-24" />
        <Card>
          <CardHeader title="Privacy and data" subtitle="What is stored, and how to remove it" icon={<ShieldCheck size={15} />} />
          <div className="space-y-4 p-4">
            <Switch
              checked={settings?.demoMode ?? true}
              onChange={(value) => updateSetting({ demoMode: value })}
              label="Allow the built-in sample engine"
              description="When no key works, answer from a built-in library so you are never stuck. Turn this off to see real errors instead."
            />
            <div className="rounded-xl border border-[var(--color-border)] bg-[var(--color-surface)] p-3.5 text-[12px] leading-relaxed text-[var(--color-muted)]">
              <p className="mb-1.5 font-semibold text-[var(--color-text)]">What Vroqn Nexus stores</p>
              <ul className="space-y-1">
                <li>• Your name, email, class and board — to personalise explanations.</li>
                <li>• Your API keys, encrypted with AES-256-GCM before they touch the database and masked everywhere in the UI.</li>
                <li>• Your conversations, notes, practice sets, exams and learning activity — visible only to you.</li>
                <li>• Nothing else: no third-party analytics, no ad trackers, no hidden monitoring.</li>
              </ul>
            </div>
            <div className="flex flex-wrap gap-2">
              <Button variant="secondary" icon={<Eye size={14} />} onClick={() => navigate('/activity')}>
                View my activity data
              </Button>
              <Button
                variant="danger"
                icon={<Trash2 size={14} />}
                onClick={() => {
                  void (async () => {
                    const ok = await confirm({
                      title: 'Erase your learning activity?',
                      description:
                        'This clears your progress history — the streak, subject accuracy and weak-area rankings. Your notes, AI chats and exam papers all stay.',
                      confirmLabel: 'Erase activity',
                    });
                    if (!ok) return;
                    await api
                      .del('/api/settings/activity-data')
                    .then(() => {
                      push({ tone: 'success', title: 'Learning activity cleared' });
                      void reload();
                    })
                      .catch(() => push({ tone: 'error', title: 'Could not clear activity' }));
                  })();
                }}
              >
                Clear learning activity
              </Button>
            </div>
          </div>
        </Card>

        {/* -------------------------------- account ------------------------------- */}
        <span id="account" aria-hidden="true" className="block scroll-mt-24" />
        <Card>
          <CardHeader title="Account" subtitle={user?.email} icon={<KeyRound size={15} />} />
          <div className="grid gap-3 p-4 sm:grid-cols-3">
            <Field label="Name" htmlFor="profile-name">
              <TextInput id="profile-name" value={profile.name} onChange={(event) => setProfile((current) => ({ ...current, name: event.target.value }))} />
            </Field>
            <Field label="Class">
              <VroqnFilterSelect
                label="Class"
                value={profile.classLevel}
                onChange={(next) => setProfile((current) => ({ ...current, classLevel: next }))}
                placeholder="Choose your class"
                options={['Class 6', 'Class 7', 'Class 8', 'Class 9', 'Class 10', 'Class 11', 'Class 12', 'College'].map((option) => ({
                  value: option,
                  label: option,
                }))}
              />
            </Field>
            <Field label="Board">
              <VroqnFilterSelect
                label="Board"
                value={profile.board}
                onChange={(next) => setProfile((current) => ({ ...current, board: next }))}
                placeholder="Choose your board"
                options={['CBSE', 'ICSE', 'State board', 'IB', 'Other'].map((option) => ({ value: option, label: option }))}
              />
            </Field>
            <div className="sm:col-span-3 flex flex-wrap gap-2">
              <Button
                variant="primary"
                icon={<CheckCircle2 size={14} />}
                onClick={() =>
                  void updateProfile(profile)
                    .then(() => push({ tone: 'success', title: 'Profile updated' }))
                    .catch(() => push({ tone: 'error', title: 'Could not update profile' }))
                }
              >
                Save profile
              </Button>
              <Button
                variant="ghost"
                onClick={() => {
                  void logout().then(() => push({ tone: 'info', title: 'Signed out' }));
                }}
              >
                Sign out
              </Button>
            </div>
          </div>
        </Card>

        <p className="flex items-start gap-2 text-[11.5px] leading-relaxed text-[var(--color-muted-dim)]">
          <AlertTriangle size={13} className="mt-0.5 shrink-0" />
          Vroqn Nexus only supports Google Gemini, Groq and OpenRouter keys. Adding more keys does not increase a provider's quota — it
          simply lets the app rotate the keys you already have.
        </p>

        {/* ----------------------------- danger zone ----------------------------- */}
        <span id="danger" aria-hidden="true" className="block scroll-mt-24" />
        <VroqnSection title="Danger zone" description="The one action on this page that cannot be undone.">
          <DeleteAccountCard />
        </VroqnSection>
      </PageBody>
    </>
  );
}

export default SettingsPage;
