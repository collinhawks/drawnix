const crypto = require('crypto');
const fs = require('fs/promises');
const path = require('path');

const DEFAULT_STATE = () => ({
  version: 1,
  users: [],
  sessions: [],
  documents: {},
});

const clone = (value) => JSON.parse(JSON.stringify(value));

const normalizeUsername = (username) => username.trim().toLowerCase();

const hashPassword = (password, salt) =>
  crypto.pbkdf2Sync(password, salt, 120000, 32, 'sha256').toString('hex');

const createSessionToken = () => crypto.randomUUID();

const toPublicUser = (user) => ({
  id: user.id,
  username: user.username,
  displayName: user.displayName,
  createdAt: user.createdAt,
});

const sanitizeDocument = (document) => {
  if (!document || typeof document !== 'object' || !Array.isArray(document.children)) {
    throw Object.assign(new Error('Document must include a children array.'), {
      code: 'invalid_document',
    });
  }

  return {
    children: document.children,
    viewport: document.viewport ?? null,
    theme: document.theme ?? null,
  };
};

class SyncStore {
  constructor(filePath) {
    this.filePath = filePath;
    this.state = null;
    this.loadPromise = null;
    this.writeQueue = Promise.resolve();
  }

  async ensureLoaded() {
    if (!this.loadPromise) {
      this.loadPromise = this.load();
    }

    await this.loadPromise;
  }

  async load() {
    try {
      const raw = await fs.readFile(this.filePath, 'utf8');
      this.state = JSON.parse(raw);
    } catch (error) {
      if (error && error.code !== 'ENOENT') {
        throw error;
      }

      this.state = DEFAULT_STATE();
      await this.persist();
    }
  }

  async persist() {
    await fs.mkdir(path.dirname(this.filePath), { recursive: true });
    const tmpPath = `${this.filePath}.${process.pid}.tmp`;
    await fs.writeFile(tmpPath, JSON.stringify(this.state, null, 2));
    await fs.rename(tmpPath, this.filePath);
  }

  async mutate(mutator) {
    await this.ensureLoaded();

    const run = async () => {
      const nextState = await mutator(clone(this.state));
      if (nextState) {
        this.state = nextState;
      }
      await this.persist();
      return clone(this.state);
    };

    this.writeQueue = this.writeQueue.then(run, run);
    return this.writeQueue;
  }

  async query(reader) {
    await this.ensureLoaded();
    return reader(clone(this.state));
  }

  async registerUser({ username, password, displayName }) {
    const normalizedUsername = normalizeUsername(username);
    if (!normalizedUsername) {
      throw Object.assign(new Error('Username is required.'), {
        code: 'invalid_username',
      });
    }
    if (typeof password !== 'string' || password.length < 8) {
      throw Object.assign(new Error('Password must be at least 8 characters.'), {
        code: 'invalid_password',
      });
    }

    const savedState = await this.mutate((state) => {
      const existing = state.users.find((user) => user.username === normalizedUsername);
      if (existing) {
        throw Object.assign(new Error('That username is already taken.'), {
          code: 'username_taken',
        });
      }

      const salt = crypto.randomBytes(16).toString('hex');
      const now = new Date().toISOString();
      const user = {
        id: crypto.randomUUID(),
        username: normalizedUsername,
        displayName: displayName?.trim() || normalizedUsername,
        passwordHash: hashPassword(password, salt),
        salt,
        createdAt: now,
      };

      state.users.push(user);
      return state;
    });

    return toPublicUser(savedState.users[savedState.users.length - 1]);
  }

  async loginUser({ username, password }) {
    const normalizedUsername = normalizeUsername(username);
    if (!normalizedUsername || typeof password !== 'string') {
      throw Object.assign(new Error('Username and password are required.'), {
        code: 'invalid_credentials',
      });
    }

    const state = await this.query((currentState) => currentState);
    const user = state.users.find((entry) => entry.username === normalizedUsername);
    if (!user) {
      throw Object.assign(new Error('Invalid username or password.'), {
        code: 'invalid_credentials',
      });
    }

    const passwordHash = hashPassword(password, user.salt);
    if (passwordHash !== user.passwordHash) {
      throw Object.assign(new Error('Invalid username or password.'), {
        code: 'invalid_credentials',
      });
    }

    return toPublicUser(user);
  }

  async createSession(userId) {
    const savedState = await this.mutate((state) => {
      const user = state.users.find((entry) => entry.id === userId);
      if (!user) {
        throw Object.assign(new Error('User not found.'), {
          code: 'user_not_found',
        });
      }

      const now = new Date().toISOString();
      const token = createSessionToken();
      state.sessions.push({
        token,
        userId,
        createdAt: now,
        lastSeenAt: now,
      });

      return state;
    });

    const session = savedState.sessions[savedState.sessions.length - 1];
    const user = savedState.users.find((entry) => entry.id === session.userId);
    return {
      token: session.token,
      user: toPublicUser(user),
      createdAt: session.createdAt,
      lastSeenAt: session.lastSeenAt,
    };
  }

  async revokeSession(token) {
    return this.mutate((state) => {
      state.sessions = state.sessions.filter((session) => session.token !== token);
      return state;
    });
  }

  async getSession(token) {
    const state = await this.query((currentState) => currentState);
    const session = state.sessions.find((entry) => entry.token === token);
    if (!session) {
      return null;
    }

    const user = state.users.find((entry) => entry.id === session.userId);
    if (!user) {
      return null;
    }

    return {
      token: session.token,
      user: toPublicUser(user),
      createdAt: session.createdAt,
      lastSeenAt: session.lastSeenAt,
    };
  }

  async touchSession(token) {
    return this.mutate((state) => {
      const session = state.sessions.find((entry) => entry.token === token);
      if (session) {
        session.lastSeenAt = new Date().toISOString();
      }
      return state;
    });
  }

  async getUserBySession(token) {
    const state = await this.query((currentState) => currentState);
    const session = state.sessions.find((entry) => entry.token === token);
    if (!session) {
      return null;
    }

    const user = state.users.find((entry) => entry.id === session.userId);
    if (!user) {
      return null;
    }

    return {
      token: session.token,
      user: toPublicUser(user),
      createdAt: session.createdAt,
      lastSeenAt: session.lastSeenAt,
    };
  }

  async getDocument(userId) {
    const state = await this.query((currentState) => currentState);
    const document = state.documents[userId] || {
      revision: 0,
      updatedAt: null,
      updatedByDeviceId: null,
      data: sanitizeDocument({ children: [] }),
    };

    return clone(document);
  }

  async saveDocument(userId, document, deviceId) {
    const data = sanitizeDocument(document);

    return this.mutate((state) => {
      const existing = state.documents[userId] || {
        revision: 0,
        updatedAt: null,
        updatedByDeviceId: null,
        data: sanitizeDocument({ children: [] }),
      };

      state.documents[userId] = {
        revision: existing.revision + 1,
        updatedAt: new Date().toISOString(),
        updatedByDeviceId: deviceId || null,
        data,
      };

      return state;
    });
  }
}

module.exports = {
  SyncStore,
  normalizeUsername,
  toPublicUser,
  sanitizeDocument,
};
