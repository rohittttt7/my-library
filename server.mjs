import { createServer } from 'node:http';
import { randomUUID } from 'node:crypto';
import { mkdirSync, readFileSync, createReadStream } from 'node:fs';
import { stat, writeFile, unlink } from 'node:fs/promises';
import { dirname, extname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';
import { categories } from './categories.mjs';
import { allowedMime, fileLimitMb, fileLimit, itemKinds, HttpError, validate, cleanText, cleanLink } from './catalog.mjs';

const root = dirname(fileURLToPath(import.meta.url));
const port = Number(process.env.PORT || 3000);
const origin = `http://localhost:${port}`;
const loopbackHosts = new Set(['localhost', '127.0.0.1'].map(name => port === 80 ? name : `${name}:${port}`));
const data = resolve(process.env.DATA_DIR || join(root, 'data'));
const objects = join(data, 'files');
mkdirSync(objects, { recursive: true, mode: 0o700 });
const db = new DatabaseSync(join(data, 'portal.sqlite'), { timeout: 5000 });
db.exec(`
  PRAGMA journal_mode = WAL;
  CREATE TABLE IF NOT EXISTS items (
    id TEXT PRIMARY KEY, category TEXT NOT NULL,
    parent TEXT REFERENCES items(id) ON DELETE CASCADE,
    title TEXT NOT NULL, description TEXT NOT NULL, kind TEXT NOT NULL,
    body TEXT NOT NULL, status TEXT NOT NULL CHECK(status IN ('draft','published')),
    position INTEGER NOT NULL, object TEXT, filename TEXT, mime TEXT
  );
  CREATE INDEX IF NOT EXISTS items_category_parent ON items(category, parent, position);
  CREATE TABLE IF NOT EXISTS library_progress (
    item_id TEXT PRIMARY KEY REFERENCES items(id) ON DELETE CASCADE,
    completed INTEGER NOT NULL DEFAULT 0, updated INTEGER NOT NULL
  );
`);

const query = (sql, ...args) => db.prepare(sql).all(...args);
const get = (sql, ...args) => db.prepare(sql).get(...args);
const run = (sql, ...args) => db.prepare(sql).run(...args);
const categoryIds = new Set(categories.map(category => category.id));
// Carry the original administrator's progress into the local library.
if (get("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'progress'")) {
  db.exec(`INSERT OR IGNORE INTO library_progress (item_id, completed, updated)
    SELECT item_id, completed, updated FROM progress
    WHERE user_id = (SELECT id FROM users WHERE role = 'admin' ORDER BY rowid LIMIT 1)`);
}
function transaction(operation) {
  db.exec('BEGIN IMMEDIATE');
  try {
    const result = operation();
    db.exec('COMMIT');
    return result;
  } catch (error) {
    db.exec('ROLLBACK');
    throw error;
  }
}

function send(res, status, body) {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(body));
}

async function readBody(req, limit) {
  validate(Number(req.headers['content-length'] || 0) <= limit, 413, 'This upload exceeds the size limit.');
  const chunks = [];
  let length = 0;
  for await (const chunk of req.iterator({ destroyOnReturn: false })) {
    length += chunk.length;
    validate(length <= limit, 413, 'This upload exceeds the size limit.');
    chunks.push(chunk);
  }
  return Buffer.concat(chunks, length);
}

async function jsonBody(req) {
  validate(req.headers['content-type']?.split(';')[0] === 'application/json', 415, 'Send a JSON request.');
  try {
    return JSON.parse(await readBody(req, 96 * 1024));
  } catch (error) {
    if (error instanceof HttpError) throw error;
    throw new HttpError(400, 'The request could not be read.');
  }
}

let uploads = 0;
async function itemBody(req) {
  if (!req.headers['content-type']?.startsWith('multipart/form-data;')) return { fields: await jsonBody(req) };
  validate(uploads < 2, 503, 'The server is handling other uploads. Try again shortly.');
  uploads++;
  try {
    const bytes = await readBody(req, fileLimit + 96 * 1024);
    const request = new Request(origin, { method: 'POST', headers: { 'content-type': req.headers['content-type'] }, body: bytes });
    try {
      const form = await request.formData();
      const file = form.get('file');
      validate(file instanceof Blob && file.size > 0 && file.size <= fileLimit, 400, `Choose a non-empty file up to ${fileLimitMb} MB.`);
      return { fields: JSON.parse(form.get('fields')), file };
    } catch (error) {
      if (error instanceof HttpError) throw error;
      throw new HttpError(400, 'The upload could not be read.');
    }
  } finally {
    uploads--;
  }
}

function itemFor(id) {
  return get('SELECT * FROM items WHERE id = ?', id);
}

function publicItem({ object, ...item }) { return item; }

function siblingPosition(category, parent) {
  return get('SELECT COALESCE(MAX(position), 0) + 1 AS next FROM items WHERE category = ? AND parent IS ?', category, parent).next;
}

function validateParent(parent, category, id) {
  if (!parent) return;
  const folder = get("SELECT * FROM items WHERE id = ? AND kind = 'folder' AND category = ?", parent, category);
  validate(folder, 400, 'Choose a folder in this category.');
  const ancestors = get(`WITH RECURSIVE chain AS (
    SELECT id, parent FROM items WHERE id = ? UNION ALL
    SELECT i.id, i.parent FROM items i JOIN chain c ON i.id = c.parent
  ) SELECT COUNT(*) AS depth, SUM(id = ?) AS contains_item FROM chain`, parent, id);
  validate(!ancestors.contains_item && ancestors.depth < 20, 400, 'Choose a folder outside this item’s own tree and within 20 levels.');
}

async function removeObject(object) {
  if (!object) return;
  try { await unlink(join(objects, object)); }
  catch (error) { if (error.code !== 'ENOENT') console.error('Could not remove unreferenced file:', error.code); }
}

async function saveItem(req, id) {
  const { fields, file } = await itemBody(req);
  validate(fields && typeof fields === 'object', 400, 'Enter the item details.');
  const { category, kind, status } = fields;
  const parent = fields.parent || null;
  const title = cleanText(fields.title, 160);
  const description = cleanText(fields.description ?? '', 1200);
  let body = cleanText(fields.body ?? '', 12000);
  validate(title && categoryIds.has(category) && itemKinds.has(kind) && ['draft', 'published'].includes(status), 400, 'Choose a valid category, content type and status, and enter a title.');
  if (kind === 'youtube' || kind === 'loop') body = cleanLink(body, kind);
  if (kind === 'folder' || kind === 'file') body = '';
  if (kind === 'note') validate(body || status === 'draft', 400, 'Write a note before publishing it.');
  const newId = id || randomUUID();
  let incoming;
  if (file) {
    const filename = file.name.split(/[\\/]/).at(-1).replace(/[\x00-\x1f\x7f]/g, '').slice(0, 180).toWellFormed();
    const mime = allowedMime.get(extname(filename).toLowerCase());
    validate(kind === 'file' && mime, 400, 'Choose a supported document, image, recording, video, or archive.');
    incoming = { filename, mime, object: randomUUID() };
    try { await writeFile(join(objects, incoming.object), new Uint8Array(await file.arrayBuffer()), { flag: 'wx', mode: 0o600 }); }
    catch (error) { await removeObject(incoming.object); throw error; }
  }
  let previous;
  try {
    transaction(() => {
      previous = id ? itemFor(id) : null;
      validate(!id || previous, 404, 'Item not found.');
      validateParent(parent, category, newId);
      const hasChildren = previous && get('SELECT 1 FROM items WHERE parent = ?', id);
      validate(!hasChildren || (kind === 'folder' && category === previous.category), 400, 'Move the contents out of this folder before changing its category or type.');
      const retained = kind === 'file' ? incoming || previous : null;
      validate(kind !== 'file' || retained?.object || status === 'draft', 400, 'Choose a file before publishing.');
      const position = previous?.category === category && previous.parent === parent ? previous.position : siblingPosition(category, parent);
      const values = [category, parent, title, description, kind, body, status, position, retained?.object ?? null, retained?.filename ?? null, retained?.mime ?? null];
      if (previous) {
        run('UPDATE items SET category=?, parent=?, title=?, description=?, kind=?, body=?, status=?, position=?, object=?, filename=?, mime=? WHERE id=?', ...values, id);
      } else {
        run('INSERT INTO items VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)', newId, ...values);
      }
    });
  } catch (error) {
    await removeObject(incoming?.object);
    throw error;
  }
  if (previous?.object && (incoming || kind !== 'file')) await removeObject(previous.object);
  return { id: newId };
}

function moveItem(id, direction) {
  validate(direction === 'up' || direction === 'down', 400, 'Choose a direction.');
  transaction(() => {
    const item = itemFor(id);
    validate(item, 404, 'Item not found.');
    const siblings = query('SELECT id, position FROM items WHERE category = ? AND parent IS ? ORDER BY position, id', item.category, item.parent);
    const index = siblings.findIndex(sibling => sibling.id === id);
    const neighbor = siblings[index + (direction === 'up' ? -1 : 1)];
    if (!neighbor) return;
    run('UPDATE items SET position = ? WHERE id = ?', neighbor.position, id);
    run('UPDATE items SET position = ? WHERE id = ?', item.position, neighbor.id);
  });
}

async function deleteItem(id) {
  const deleted = transaction(() => {
    const item = itemFor(id);
    validate(item, 404, 'Item not found.');
    validate(!get('SELECT 1 FROM items WHERE parent = ?', id), 409, 'Move or remove the contents of this folder first.');
    run('DELETE FROM items WHERE id = ?', id);
    return item;
  });
  await removeObject(deleted.object);
}

async function serveFile(req, res, item) {
  validate(item?.object, 404, 'File not found.');
  const path = join(objects, item.object);
  const info = await stat(path).catch(() => null);
  validate(info, 404, 'File not found.');
  let start = 0;
  let end = info.size - 1;
  let status = 200;
  const inline = item.mime === 'application/pdf' || /^(image|audio|video)\//.test(item.mime);
  const headers = {
    'Content-Type': item.mime,
    'Content-Disposition': `${inline ? 'inline' : 'attachment'}; filename*=UTF-8''${encodeURIComponent(item.filename.toWellFormed()).replace(/['()*]/g, char => `%${char.charCodeAt(0).toString(16)}`)}`,
    'Accept-Ranges': 'bytes',
  };
  if (req.headers.range) {
    const match = req.headers.range.match(/^bytes=(\d*)-(\d*)$/);
    if (match?.[1]) { start = Number(match[1]); if (match[2]) end = Math.min(end, Number(match[2])); }
    else if (match?.[2]) start = Math.max(0, info.size - Number(match[2]));
    if (!match || (!match[1] && !match[2]) || start > end) {
      res.writeHead(416, { 'Content-Range': `bytes */${info.size}` });
      return res.end();
    }
    status = 206;
    headers['Content-Range'] = `bytes ${start}-${end}/${info.size}`;
  }
  headers['Content-Length'] = end - start + 1;
  res.writeHead(status, headers);
  if (req.method === 'HEAD') return res.end();
  const stream = createReadStream(path, { start, end });
  stream.on('error', () => res.destroy());
  res.on('close', () => stream.destroy());
  stream.pipe(res);
}

const assetFiles = new Map([
  ['/index.html', 'text/html; charset=utf-8'], ['/app.js', 'text/javascript; charset=utf-8'], ['/style.css', 'text/css; charset=utf-8'],
]);

const server = createServer(async (req, res) => {
  res.setHeader('Cache-Control', 'private, no-store');
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
  res.setHeader('X-Frame-Options', 'SAMEORIGIN');
  res.setHeader('Content-Security-Policy', "default-src 'self'; object-src 'none'; base-uri 'none'; form-action 'self'; frame-ancestors 'self'; frame-src 'self' https://www.youtube-nocookie.com; img-src 'self'; style-src 'self'; script-src 'self'; media-src 'self'");
  try {
    const host = req.headers.host;
    validate(loopbackHosts.has(host), 403, 'Open the portal at its local address.');
    const url = new URL(req.url, `http://${host}`);
    const path = url.pathname;
    const method = req.method;
    if (path.startsWith('/api/')) {
      validate(!['cross-site', 'same-site'].includes(req.headers['sec-fetch-site']), 403, 'Open the portal directly in your browser.');
    }
    if (method !== 'GET' && method !== 'HEAD') {
      validate(req.headers.origin === `http://${host}`, 403, 'Open the portal directly in your browser and try again.');
    }
    if (path === '/api/config' && method === 'GET') return send(res, 200, { categories, fileExtensions: [...allowedMime.keys()], fileLimitMb });
    if (path.startsWith('/api/')) {
      if (path === '/api/library' && method === 'GET') {
        const category = url.searchParams.get('category');
        validate(categoryIds.has(category), 404, 'Category not found.');
        const items = query('SELECT * FROM items WHERE category = ? ORDER BY position, id', category);
        const progress = query('SELECT p.* FROM library_progress p JOIN items i ON i.id = p.item_id WHERE i.category = ?', category);
        return send(res, 200, { items: items.map(publicItem), progress });
      }
      const file = path.match(/^\/api\/files\/([\w-]+)$/);
      if (file && ['GET', 'HEAD'].includes(method)) return await serveFile(req, res, itemFor(file[1]));
      const progress = path.match(/^\/api\/progress\/([\w-]+)$/);
      if (progress && method === 'POST') {
        const { completed } = (await jsonBody(req)) || {};
        const item = itemFor(progress[1]);
        validate(item && item.kind !== 'folder', 404, 'Learning item not found.');
        validate(completed === undefined || typeof completed === 'boolean', 400, 'Choose a completion status.');
        const value = completed === undefined ? null : Number(completed);
        run(`INSERT INTO library_progress VALUES (?, COALESCE(?, 0), ?)
          ON CONFLICT(item_id) DO UPDATE SET completed=COALESCE(?, library_progress.completed), updated=excluded.updated`,
          item.id, value, Date.now(), value);
        return send(res, 200, {});
      }
      if (path === '/api/items' && method === 'POST') return send(res, 201, await saveItem(req, null));
      const item = path.match(/^\/api\/items\/([\w-]+)(\/move)?$/);
      if (item && !item[2] && method === 'PUT') return send(res, 200, await saveItem(req, item[1]));
      if (item && !item[2] && method === 'DELETE') { await deleteItem(item[1]); return send(res, 200, {}); }
      if (item?.[2] && method === 'POST') { moveItem(item[1], (await jsonBody(req))?.direction); return send(res, 200, {}); }
      throw new HttpError(404, 'Page not found.');
    }
    const asset = path === '/' ? '/index.html' : path;
    validate(assetFiles.has(asset) && (method === 'GET' || method === 'HEAD'), 404, 'Page not found.');
    res.writeHead(200, { 'Content-Type': assetFiles.get(asset) });
    res.end(method === 'HEAD' ? undefined : readFileSync(join(root, 'public', asset)));
  } catch (error) {
    if (res.headersSent) return res.destroy();
    if (!(error instanceof HttpError)) console.error(error);
    if (!req.complete) req.resume();
    send(res, error.code >= 400 && error.code < 600 ? error.code : 500, { error: error instanceof HttpError ? error.message : 'Something went wrong. Try again.' });
  }
});

server.listen(port, '127.0.0.1', () => console.log(`Ruby’s Signature listening on ${origin}`));
