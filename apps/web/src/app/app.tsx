import { useCallback, useEffect, useRef, useState, type FormEvent } from 'react';
import { Drawnix } from '@drawnix/drawnix';
import styles from './app.module.scss';
import {
  clearStoredSession,
  getLocalModeHint,
  getOrCreateDeviceId,
  isServerReachable,
  loadCurrentUser,
  loadDraft,
  loadRemoteDocument,
  loadStoredSession,
  loginAccount,
  logoutAccount,
  registerAccount,
  saveDraft,
  saveRemoteDocument,
  storeSession,
} from './sync-client';
import { DrawnixDocument, EMPTY_DOCUMENT, isEmptyDocument, SyncSession } from './sync-types';

const EMPTY_FORM = {
  username: '',
  password: '',
  displayName: '',
};

export function App() {
  const [document, setDocument] = useState<DrawnixDocument>(EMPTY_DOCUMENT());
  const [session, setSession] = useState<SyncSession | null>(null);
  const [authMode, setAuthMode] = useState<'login' | 'register'>('login');
  const [form, setForm] = useState(EMPTY_FORM);
  const [status, setStatus] = useState('Checking sync service...');
  const [authError, setAuthError] = useState<string | null>(null);
  const [isOnline, setIsOnline] = useState(false);
  const [isLocalOnly, setIsLocalOnly] = useState(false);
  const [isDirty, setIsDirty] = useState(false);
  const [isSaving, setIsSaving] = useState(false);
  const [tutorial, setTutorial] = useState(false);

  const documentRef = useRef(document);
  const sessionRef = useRef(session);
  const dirtyRef = useRef(false);
  const revisionRef = useRef(0);

  // eslint-disable-next-line react-hooks/exhaustive-deps
  /* eslint-disable react-hooks/exhaustive-deps */
  useEffect(() => {
    documentRef.current = document;
  }, [document]);

  useEffect(() => {
    sessionRef.current = session;
  }, [session]);

  useEffect(() => {
    dirtyRef.current = isDirty;
  }, [isDirty]);

  const applyDocument = useCallback((nextDocument: DrawnixDocument, revision = 0) => {
    revisionRef.current = revision;
    setDocument(nextDocument);
    setTutorial(isEmptyDocument(nextDocument));
    setIsDirty(false);
  }, []);

  /* eslint-disable react-hooks/exhaustive-deps */
  useEffect(() => {
    let cancelled = false;

    const bootstrap = async () => {
      const online = await isServerReachable();
      if (cancelled) {
        return;
      }

      setIsOnline(online);

      if (!online) {
        setIsLocalOnly(true);
        const localDocument = await loadDraft(null);
        if (!cancelled) {
          applyDocument(localDocument);
          setStatus(getLocalModeHint(false));
        }
        return;
      }

      const storedSession = loadStoredSession();
      if (!storedSession) {
        setStatus(getLocalModeHint(true));
        return;
      }

      try {
        const currentSession = await loadCurrentUser(storedSession.token);
        const remoteDocument = await loadRemoteDocument(storedSession.token);
        const guestDraft = await loadDraft(null);
        const userDraft = await loadDraft(currentSession.user.id);
        const nextDocument =
          !isEmptyDocument(remoteDocument.data)
            ? remoteDocument.data
            : !isEmptyDocument(userDraft)
              ? userDraft
              : !isEmptyDocument(guestDraft)
                ? guestDraft
                : remoteDocument.data;

        if (cancelled) {
          return;
        }

        const hydratedSession = { ...currentSession, token: storedSession.token };
        setSession(hydratedSession);
        storeSession(hydratedSession);
        applyDocument(nextDocument, remoteDocument.revision);
        await saveDraft(nextDocument, currentSession.user.id);

        if (isEmptyDocument(remoteDocument.data) && !isEmptyDocument(nextDocument)) {
          const saved = await saveRemoteDocument(hydratedSession.token, nextDocument);
          revisionRef.current = saved.revision;
        }

        setStatus(`Signed in as ${currentSession.user.displayName}.`);
      } catch {
        clearStoredSession();
        if (!cancelled) {
          setStatus(getLocalModeHint(true));
        }
      }
    };

    void bootstrap();
    return () => {
      cancelled = true;
    };
  }, []);
  /* eslint-enable react-hooks/exhaustive-deps */

  useEffect(() => {
    if (!session || !isDirty) {
      return;
    }

    const timeout = window.setTimeout(() => {
      void (async () => {
        try {
          setIsSaving(true);
          const saved = await saveRemoteDocument(session.token, documentRef.current);
          revisionRef.current = saved.revision;
          await saveDraft(documentRef.current, session.user.id);
          setIsDirty(false);
          setStatus(`Synced for ${session.user.displayName}.`);
        } catch {
          setStatus('Waiting to retry sync...');
        } finally {
          setIsSaving(false);
        }
      })();
    }, 2500);

    return () => window.clearTimeout(timeout);
  }, [isDirty, session]);

  useEffect(() => {
    if (!session) {
      return;
    }

    const interval = window.setInterval(() => {
      void (async () => {
        if (dirtyRef.current) {
          return;
        }

        try {
          const remoteDocument = await loadRemoteDocument(session.token);
          if (remoteDocument.revision > revisionRef.current) {
            revisionRef.current = remoteDocument.revision;
            applyDocument(remoteDocument.data, remoteDocument.revision);
            await saveDraft(remoteDocument.data, session.user.id);
            setStatus(`Updated from ${session.user.displayName}'s other device.`);
          }
        } catch {
          setStatus('Sync server unavailable; retrying.');
        }
      })();
    }, 15000);

    return () => window.clearInterval(interval);
  }, [applyDocument, session]);

  useEffect(() => {
    const beforeUnload = () => {
      if (sessionRef.current && dirtyRef.current) {
        void saveDraft(documentRef.current, sessionRef.current.user.id);
      }
    };

    window.addEventListener('beforeunload', beforeUnload);
    return () => window.removeEventListener('beforeunload', beforeUnload);
  }, []);

  const handleBoardChange = (value: unknown) => {
    const nextDocument = value as DrawnixDocument;
    setDocument(nextDocument);
    setTutorial(isEmptyDocument(nextDocument));
    setIsDirty(true);
    void saveDraft(nextDocument, sessionRef.current?.user.id || null);
  };

  const handleAuthSubmit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    setAuthError(null);

    if (!form.username.trim() || !form.password.trim()) {
      setAuthError('Username and password are required.');
      return;
    }

    try {
      const nextSession =
        authMode === 'register'
          ? await registerAccount({
              username: form.username,
              password: form.password,
              displayName: form.displayName || form.username,
            })
          : await loginAccount({
              username: form.username,
              password: form.password,
            });

      const currentSession = await loadCurrentUser(nextSession.token);
      const remoteDocument = await loadRemoteDocument(nextSession.token);
      const guestDraft = await loadDraft(null);
      const nextDocument =
        !isEmptyDocument(remoteDocument.data)
          ? remoteDocument.data
          : !isEmptyDocument(guestDraft)
            ? guestDraft
            : remoteDocument.data;

      const hydratedSession = { ...currentSession, token: nextSession.token };
      setSession(hydratedSession);
      storeSession(hydratedSession);
      applyDocument(nextDocument, remoteDocument.revision);
      await saveDraft(nextDocument, currentSession.user.id);

      if (isEmptyDocument(remoteDocument.data) && !isEmptyDocument(nextDocument)) {
        const saved = await saveRemoteDocument(nextSession.token, nextDocument);
        revisionRef.current = saved.revision;
      }

      setStatus(`Signed in as ${currentSession.user.displayName}.`);
    } catch (error) {
      setAuthError(error instanceof Error ? error.message : 'Unable to sign in.');
    }
  };

  const handleLogout = async () => {
    if (session?.token) {
      await logoutAccount(session.token);
    } else {
      if (isLocalOnly) {
        await saveDraft(EMPTY_DOCUMENT(), null);
      }
      clearStoredSession();
    }

    setSession(null);
    setForm(EMPTY_FORM);
    setStatus(getLocalModeHint(isOnline));
    if (isLocalOnly) {
      applyDocument(await loadDraft(null));
    }
  };

  const readyToDraw = isLocalOnly || session !== null;

  if (!readyToDraw) {
    return (
      <div className={styles.authShell}>
        <form className={styles.authCard} onSubmit={handleAuthSubmit}>
          <h1>Drawnix sync</h1>
          <p>{status}</p>

          <label>
            Username
            <input
              value={form.username}
              onChange={(event) => setForm({ ...form, username: event.target.value })}
              autoComplete="username"
            />
          </label>

          {authMode === 'register' && (
            <label>
              Display name
              <input
                value={form.displayName}
                onChange={(event) => setForm({ ...form, displayName: event.target.value })}
                autoComplete="name"
              />
            </label>
          )}

          <label>
            Password
            <input
              type="password"
              value={form.password}
              onChange={(event) => setForm({ ...form, password: event.target.value })}
              autoComplete={authMode === 'register' ? 'new-password' : 'current-password'}
            />
          </label>

          {authError && <p className={styles.error}>{authError}</p>}

          <div className={styles.authActions}>
            <button type="submit">{authMode === 'register' ? 'Create account' : 'Sign in'}</button>
            <button
              type="button"
              className={styles.secondaryButton}
              onClick={() => setAuthMode(authMode === 'register' ? 'login' : 'register')}
            >
              {authMode === 'register' ? 'I already have an account' : 'Create account'}
            </button>
          </div>
        </form>
      </div>
    );
  }

  return (
    <div className={styles.shell}>
      <div className={styles.statusBar}>
        <span>{status}</span>
        <div className={styles.statusActions}>
          {session && <span>{session.user.displayName}</span>}
          <span>{isOnline ? 'online' : 'offline'}</span>
          <span>{getOrCreateDeviceId().slice(0, 8)}</span>
          <button type="button" className={styles.secondaryButton} onClick={handleLogout}>
            {session ? 'Sign out' : 'Clear local data'}
          </button>
        </div>
      </div>
      <Drawnix
        value={document.children}
        viewport={document.viewport || undefined}
        theme={document.theme || undefined}
        onChange={handleBoardChange}
        tutorial={tutorial}
        afterInit={() => {
          setStatus((current) => (current === 'Checking sync service...' ? 'Ready.' : current));
        }}
      />
      {!session && isLocalOnly && <div className={styles.localBanner}>{getLocalModeHint(false)}</div>}
      {isSaving && <div className={styles.syncPulse}>Saving…</div>}
    </div>
  );
}

export default App;
