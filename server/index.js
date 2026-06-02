const http = require('http');
const fs = require('fs/promises');
const path = require('path');
const { SyncStore } = require('./storage');

const ROOT_DIR = path.resolve(__dirname, '..');
const PUBLIC_DIR = path.join(ROOT_DIR, 'dist', 'apps', 'web');
const DATA_DIR = process.env.DRAWNIX_DATA_DIR || path.join(ROOT_DIR, 'data');
const PORT = Number(process.env.DRAWNIX_PORT || 3000);
const HOST = process.env.DRAWNIX_HOST || '0.0.0.0';

const store = new SyncStore(path.join(DATA_DIR, 'drawnix-sync.json'));

const MIME_TYPES = {
  '.css': 'text/css; charset=utf-8',
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.map': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
};

const readJson = async (request) => {
  const chunks = [];
  let length = 0;
  for await (const chunk of request) {
    length += chunk.length;
    if (length > 25 * 1024 * 1024) {
      const error = new Error('Request body too large.');
      error.code = 'body_too_large';
      throw error;
    }
    chunks.push(chunk);
  }

  if (chunks.length === 0) {
    return {};
  }

  return JSON.parse(Buffer.concat(chunks).toString('utf8'));
};

const sendJson = (response, statusCode, payload) => {
  response.writeHead(statusCode, {
    'Content-Type': 'application/json; charset=utf-8',
  });
  response.end(JSON.stringify(payload));
};

const withCors = (response) => {
  response.setHeader('Access-Control-Allow-Origin', '*');
  response.setHeader('Access-Control-Allow-Methods', 'GET,POST,PUT,DELETE,OPTIONS');
  response.setHeader(
    'Access-Control-Allow-Headers',
    'Content-Type, Authorization, X-Drawnix-Device-Id'
  );
};

const getToken = (request) => {
  const header = request.headers.authorization || '';
  const [scheme, token] = header.split(' ');
  if (scheme === 'Bearer' && token) {
    return token;
  }
  return null;
};

const requireAuth = async (request, response) => {
  const token = getToken(request);
  if (!token) {
    sendJson(response, 401, { error: 'missing_auth' });
    return null;
  }

  const session = await store.getUserBySession(token);
  if (!session) {
    sendJson(response, 401, { error: 'invalid_session' });
    return null;
  }

  await store.touchSession(token);
  return session;
};

const serveStatic = async (request, response, pathname) => {
  const resolvedPath = path.resolve(PUBLIC_DIR, `.${pathname}`);
  if (!resolvedPath.startsWith(PUBLIC_DIR)) {
    sendJson(response, 400, { error: 'invalid_path' });
    return;
  }

  let filePath = resolvedPath;
  let stat = null;
  try {
    stat = await fs.stat(filePath);
    if (stat.isDirectory()) {
      filePath = path.join(filePath, 'index.html');
      stat = await fs.stat(filePath);
    }
  } catch (error) {
    if (pathname !== '/' && pathname !== '/index.html') {
      filePath = path.join(PUBLIC_DIR, 'index.html');
      try {
        stat = await fs.stat(filePath);
      } catch {
        sendJson(response, 500, { error: 'missing_build', message: 'Run npm run build first.' });
        return;
      }
    } else {
      sendJson(response, 500, { error: 'missing_build', message: 'Run npm run build first.' });
      return;
    }
  }

  const extension = path.extname(filePath).toLowerCase();
  response.writeHead(200, {
    'Content-Type': MIME_TYPES[extension] || 'application/octet-stream',
    'Content-Length': stat.size,
  });
  if (request.method === 'HEAD') {
    response.end();
    return;
  }
  response.end(await fs.readFile(filePath));
};

const handleApi = async (request, response, pathname) => {
  if (request.method === 'OPTIONS') {
    response.writeHead(204);
    response.end();
    return;
  }

  try {
    if (pathname === '/api/health' && request.method === 'GET') {
      sendJson(response, 200, { ok: true });
      return;
    }

    if (pathname === '/api/auth/register' && request.method === 'POST') {
      const body = await readJson(request);
      const user = await store.registerUser(body);
      const session = await store.createSession(user.id);
      sendJson(response, 201, {
        token: session.token,
        user: session.user,
      });
      return;
    }

    if (pathname === '/api/auth/login' && request.method === 'POST') {
      const body = await readJson(request);
      const user = await store.loginUser(body);
      const session = await store.createSession(user.id);
      sendJson(response, 200, {
        token: session.token,
        user: session.user,
      });
      return;
    }

    if (pathname === '/api/auth/logout' && request.method === 'POST') {
      const token = getToken(request);
      if (token) {
        await store.revokeSession(token);
      }
      sendJson(response, 200, { ok: true });
      return;
    }

    if (pathname === '/api/me' && request.method === 'GET') {
      const session = await requireAuth(request, response);
      if (!session) {
        return;
      }
      sendJson(response, 200, session);
      return;
    }

    if (pathname === '/api/me/document' && request.method === 'GET') {
      const session = await requireAuth(request, response);
      if (!session) {
        return;
      }

      const document = await store.getDocument(session.user.id);
      sendJson(response, 200, document);
      return;
    }

    if (pathname === '/api/me/document' && request.method === 'PUT') {
      const session = await requireAuth(request, response);
      if (!session) {
        return;
      }

      const body = await readJson(request);
      const savedDocument = await store.saveDocument(
        session.user.id,
        body.document || body,
        request.headers['x-drawnix-device-id']
      );
      sendJson(response, 200, savedDocument);
      return;
    }

    sendJson(response, 404, { error: 'not_found' });
  } catch (error) {
    const statusCode =
      error.code === 'invalid_username' ||
      error.code === 'invalid_password' ||
      error.code === 'invalid_credentials' ||
      error.code === 'username_taken' ||
      error.code === 'invalid_document' ||
      error.code === 'body_too_large'
        ? 400
        : 500;

    sendJson(response, statusCode, {
      error: error.code || 'server_error',
      message: error.message || 'Unexpected error',
    });
  }
};

const main = async () => {
  await store.ensureLoaded();
  await fs.mkdir(DATA_DIR, { recursive: true });

  const server = http.createServer(async (request, response) => {
    withCors(response);

    const url = new URL(request.url, `http://${request.headers.host || HOST}`);
    const pathname = url.pathname;

    if (pathname.startsWith('/api/')) {
      await handleApi(request, response, pathname);
      return;
    }

    if (request.method !== 'GET' && request.method !== 'HEAD') {
      sendJson(response, 405, { error: 'method_not_allowed' });
      return;
    }

    await serveStatic(request, response, pathname);
  });

  server.listen(PORT, HOST, () => {
    // eslint-disable-next-line no-console
    console.log(`Drawnix sync server listening on http://${HOST}:${PORT}`);
    // eslint-disable-next-line no-console
    console.log(`Data directory: ${DATA_DIR}`);
  });
};

main().catch((error) => {
  // eslint-disable-next-line no-console
  console.error(error);
  process.exit(1);
});
