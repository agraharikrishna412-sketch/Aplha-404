/** Auth context: session bootstrap, signup/login/logout, profile updates. */
import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from 'react';
import { api, ApiError, onUnauthorized } from '../lib/api';
import type { User } from '../types';

interface AuthContextValue {
  user: User | null;
  loading: boolean;
  error: string | null;
  signup: (input: { name: string; email: string; password: string; classLevel?: string; board?: string }) => Promise<void>;
  login: (input: { email: string; password: string }) => Promise<void>;
  logout: () => Promise<void>;
  updateProfile: (patch: { name?: string; classLevel?: string | null; board?: string | null }) => Promise<void>;
  reload: () => Promise<void>;
}

const AuthContext = createContext<AuthContextValue | null>(null);

export function AuthProvider({ children }: { children: ReactNode }) {
  const [user, setUser] = useState<User | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const reload = useCallback(async () => {
    try {
      const result = await api.get<{ user: User | null }>('/auth/me');
      setUser(result.user);
    } catch {
      setUser(null);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void reload();
  }, [reload]);

  // A 401 from any request means the session is over — drop the stale user so the router returns to
  // the sign-in screen instead of leaving the student on pages that cannot load anything.
  useEffect(
    () =>
      onUnauthorized(() => {
        setUser(null);
        setError('Your session expired. Please sign in again.');
      }),
    [],
  );

  const signup = useCallback<AuthContextValue['signup']>(async (input) => {
    setError(null);
    try {
      const result = await api.post<{ user: User }>('/auth/signup', input);
      setUser(result.user);
    } catch (err) {
      const message = err instanceof ApiError ? err.message : 'Could not create your account.';
      setError(message);
      throw err;
    }
  }, []);

  const login = useCallback<AuthContextValue['login']>(async (input) => {
    setError(null);
    try {
      const result = await api.post<{ user: User }>('/auth/login', input);
      setUser(result.user);
    } catch (err) {
      const message = err instanceof ApiError ? err.message : 'Could not sign you in.';
      setError(message);
      throw err;
    }
  }, []);

  const logout = useCallback(async () => {
    await api.post('/auth/logout').catch(() => undefined);
    setUser(null);
  }, []);

  const updateProfile = useCallback<AuthContextValue['updateProfile']>(async (patch) => {
    const result = await api.patch<{ user: User }>('/auth/me', patch);
    setUser(result.user);
  }, []);

  const value = useMemo(
    () => ({ user, loading, error, signup, login, logout, updateProfile, reload }),
    [user, loading, error, signup, login, logout, updateProfile, reload],
  );

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth(): AuthContextValue {
  const context = useContext(AuthContext);
  if (!context) throw new Error('useAuth must be used inside AuthProvider');
  return context;
}
