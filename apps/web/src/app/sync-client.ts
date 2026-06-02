import localforage from 'localforage';
import {
  EMPTY_DOCUMENT,
  DrawnixDocument,
  SyncDocumentResponse,
  SyncSession,
  SyncUser,
} from './sync-types';

const SESSION_STORAGE_KEY = 'drawnix.sync.session';
const GUEST_DRAFT_KEY = 'drawnix.sync.draft.guest';
const USER_DRAFT_KEY_PREFIX = 'drawnix.sync.draft.user.';
const DEVICE_ID_KEY = 'drawnix.sync.device-id';
const API_ROOT = '/api';

localforage.config({
  name: 'DrawnixSync',
  storeName: 'drawnix_sync_store',
  driver: [localforage.INDEXEDDB, localforage.LOCALSTORAGE],
});

const normalizeUsername = (value: string) => value.trim().toLowerCase();

const requestJson = async <T>(
  path: string,
  init: RequestInit = {},
  token?: string
): Promise<T> => {
  if (typeof fetch !== 'function') {
    throw new Error('Fetch is not available.');
  }

  const response = await fetch(`${API_ROOT}${path}`, {
    ...init,
    headers: {
      'Content-Type': 'application/json',
      ...(init.headers || {}),
      ...(token ? { Authorization: 'Bearer ' + token } : {}),
      ...(init.method && init.method !== 'GET'
        ? { 'X-Drawnix-Device-Id': getOrCreateDeviceId() }
        : {}),
    },
  });

  if (!response.ok) {
    const payload = (await response.json().catch(() => null)) as
      | { message?: string; error?: string }
      | null;
    throw new Error(payload?.message || payload?.error || 'Request failed.');
  }

  return (await response.json()) as T;
};

export const isServerReachable = async () => {
  if (typeof fetch !== 'function') {
    return false;
  }

  try {
    const response = await fetch(`${API_ROOT}/health`);
    return response.ok;
  } catch {
    return false;
  }
};

export const getOrCreateDeviceId = () => {
  if (typeof window === 'undefined') {
    return 'server';
  }

  const existing = window.localStorage.getItem(DEVICE_ID_KEY);
  if (existing) {
    return existing;
  }

  const next =
    (typeof crypto !== 'undefined' && 'randomUUID' in crypto && crypto.randomUUID()) ||
    `${Date.now()}-${Math.random().toString(16).slice(2)}`;
  window.localStorage.setItem(DEVICE_ID_KEY, next);
  return next;
};

export const getDraftKey = (userId?: string | null) =>
  userId ? `${USER_DRAFT_KEY_PREFIX}${userId}` : GUEST_DRAFT_KEY;

export const loadStoredSession = (): SyncSession | null => {
  if (typeof window === 'undefined') {
    return null;
  }

  const raw = window.localStorage.getItem(SESSION_STORAGE_KEY);
  if (!raw) {
    return null;
  }

  try {
    return JSON.parse(raw) as SyncSession;
  } catch {
    return null;
  }
};

export const storeSession = (session: SyncSession) => {
  if (typeof window === 'undefined') {
    return;
  }

  window.localStorage.setItem(SESSION_STORAGE_KEY, JSON.stringify(session));
};

export const clearStoredSession = () => {
  if (typeof window === 'undefined') {
    return;
  }

  window.localStorage.removeItem(SESSION_STORAGE_KEY);
};

export const loadDraft = async (userId?: string | null) => {
  const draft = (await localforage.getItem<DrawnixDocument>(getDraftKey(userId))) || EMPTY_DOCUMENT();
  return {
    children: Array.isArray(draft.children) ? draft.children : [],
    viewport: draft.viewport ?? null,
    theme: draft.theme ?? null,
  };
};

export const saveDraft = async (document: DrawnixDocument, userId?: string | null) => {
  await localforage.setItem(getDraftKey(userId), {
    children: document.children,
    viewport: document.viewport ?? null,
    theme: document.theme ?? null,
  });
};

export const registerAccount = async (input: {
  username: string;
  password: string;
  displayName?: string;
}) => {
  const payload = await requestJson<{ token: string; user: SyncUser }>(
    '/auth/register',
    {
      method: 'POST',
      body: JSON.stringify({
        username: normalizeUsername(input.username),
        password: input.password,
        displayName: input.displayName,
      }),
    }
  );

  const session = { token: payload.token, user: payload.user };
  storeSession(session);
  return session;
};

export const loginAccount = async (input: { username: string; password: string }) => {
  const payload = await requestJson<{ token: string; user: SyncUser }>('/auth/login', {
    method: 'POST',
    body: JSON.stringify({
      username: normalizeUsername(input.username),
      password: input.password,
    }),
  });

  const session = { token: payload.token, user: payload.user };
  storeSession(session);
  return session;
};

export const logoutAccount = async (token?: string) => {
  if (token) {
    await requestJson('/auth/logout', { method: 'POST' }, token).catch(() => undefined);
  }

  clearStoredSession();
};

export const loadRemoteDocument = async (token: string) => {
  return requestJson<SyncDocumentResponse>('/me/document', { method: 'GET' }, token);
};

export const saveRemoteDocument = async (token: string, document: DrawnixDocument) => {
  return requestJson<SyncDocumentResponse>(
    '/me/document',
    {
      method: 'PUT',
      body: JSON.stringify({ document }),
    },
    token
  );
};

export const loadCurrentUser = async (token: string) => {
  return requestJson<SyncSession>('/me', { method: 'GET' }, token);
};

export const getLocalModeHint = (available: boolean) =>
  available
    ? 'Sign in to sync your board across devices.'
    : 'Sync server unavailable, using local-only storage.';
