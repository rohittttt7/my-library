import { createServer } from 'node:http';
import { createHash, randomUUID, timingSafeEqual } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { extname, resolve } from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { fileURLToPath } from 'node:url';
import { categories } from './categories.mjs';
import { allowedMime, cleanLink, cleanText, HttpError, itemKinds, validate } from './catalog.mjs';
import { connectLegacy } from './render-legacy.mjs';

const categoryIds = new Set(categories.map(category => category.id));
const inlineMimes = new Set([...allowedMime.values()].filter(type => /^(image|audio|video)\//.test(type) || type === 'application/pdf'));
const cacheHeaders = { 'Cache-Control': 'private, no-store', 'X-Content-Type-Options': 'nosniff' };
const browserHeaders = { ...cacheHeaders, 'X-Frame-Options': 'SAMEORIGIN', 'Referrer-Policy': 'strict-origin-when-cross-origin',
  'Content-Security-Policy': "default-src 'self'; object-src 'none'; base-uri 'none'; form-action 'self'; frame-ancestors 'self'; frame-src 'self' https://www.youtube-nocookie.com; img-src 'self'; style-src 'self'; script-src 'self'; media-src 'self'" };
const assets = new Map(Object.entries({ '/index.html': 'text/html', '/app.js': 'text/javascript', '/style.css': 'text/css' })
  .map(([path, type]) => [path, { type, bytes: readFileSync(new URL(`./public${path}`, import.meta.url)) }]));
const fileLimitMb = 50;
const fileLimit = fileLimitMb * 1024 * 1024;
const jsonLimit = 96 * 1024;

function json(body, status = 200, extra = {}) {
  return Response.json(body, { status, headers: { ...browserHeaders, ...extra } });
}

function digest(value) { return createHash('sha256').update(value).digest(); }

function safeObjectPath(object) {
  const parts = object.split('/');
  validate(parts.every(part => part && part !== '.' && part !== '..'), 404, 'File not found.');
  return parts.map(encodeURIComponent).join('/');
}

export function connectSupabase({ url, key, bucket = 'library-files', allowExistingAccess = false, fetchImpl = fetch }) {
  const base = new URL(url);
  validate(base.protocol === 'https:' && !base.username && !base.password, 500, 'Configure the HTTPS Supabase project URL.');
  validate(typeof key === 'string' && (key.startsWith('sb_secret_') || /^eyJ[\w-]+\.[\w-]+\.[\w-]+$/.test(key)), 500,
    'Configure a server-side Supabase secret or legacy service role key.');
  validate(/^[A-Za-z0-9_-]+$/.test(bucket), 500, 'Configure a valid Supabase bucket name.');
  const authorization = key.startsWith('sb_secret_') ? {} : { Authorization: `Bearer ${key}` };
  async function upstream(path, options = {}) {
    try {
      return await fetchImpl(new URL(path, base.origin), {
        ...options, redirect: 'error', signal: AbortSignal.timeout(30_000),
        headers: { apikey: key, ...authorization, ...options.headers },
      });
    } catch (error) {
      console.error('Supabase request failed:', error.name);
      throw new HttpError(502, 'Supabase is temporarily unavailable. Try again shortly.');
    }
  }
  function rpcResponse(command, data) {
    return upstream(`/rest/v1/rpc/ruby_portal_${command}`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(data),
    });
  }
  async function rpc(command, data) {
    const response = await rpcResponse(command, data);
    if (!response.ok) {
      await response.body?.cancel();
      console.error('Supabase database request failed:', command, response.status);
      throw new HttpError(502, 'The library database could not complete the request.');
    }
    return response.json();
  }
  const legacy = connectLegacy(upstream);
  return {
    legacy: false,
    rpc(command, data) { return this.legacy ? legacy(command, data) : rpc(command, data); },
    async verify() {
      if (!allowExistingAccess) {
        const response = await upstream(`/storage/v1/bucket/${encodeURIComponent(bucket)}`);
        validate(response.ok, 502, 'The Supabase storage bucket could not be reached.');
        validate((await response.json()).public === false, 500, 'Use a private Supabase storage bucket for the library.');
      }
      const category = { p_category: 'english' };
      const probe = await rpcResponse('library', category);
      if (probe.ok) { await probe.body?.cancel(); return; }
      const missingRpc = probe.status === 404 && (await probe.json().catch(() => null))?.code === 'PGRST202';
      validate(allowExistingAccess && missingRpc, 502, 'The Supabase library migration could not be verified.');
      await legacy('library', category);
      this.legacy = true;
    },
    async store(object, file, mime) {
      const response = await upstream(`/storage/v1/object/${encodeURIComponent(bucket)}/${safeObjectPath(object)}`, {
        method: 'POST', headers: { 'Content-Type': mime, 'x-upsert': 'false' }, body: file,
      });
      await response.body?.cancel();
      validate(response.status !== 413, 413, 'The file exceeds the Supabase storage limit.');
      validate(response.ok, 502, 'Supabase storage could not save the file.');
    },
    async remove(object) {
      if (!object) return;
      try {
        const response = await upstream(`/storage/v1/object/${encodeURIComponent(bucket)}`, {
          method: 'DELETE', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ prefixes: [object] }),
        });
        await response.body?.cancel();
        if (!response.ok) console.error('Could not remove the unreferenced Supabase file:', response.status);
      } catch { console.error('Could not remove the unreferenced Supabase file.'); }
    },
    download(object, method, range) {
      return upstream(`/storage/v1/object/authenticated/${encodeURIComponent(bucket)}/${safeObjectPath(object)}`, {
        method, headers: { 'Accept-Encoding': 'identity', ...(range ? { Range: range } : {}) },
      });
    },
  };
}

async function boundedBody(request, limit) {
  validate(Number(request.headers.get('Content-Length') || 0) <= limit, 413, 'This upload exceeds the size limit.');
  const chunks = [];
  let size = 0;
  for await (const bytes of request.body || []) {
    size += bytes.length;
    validate(size <= limit, 413, 'This upload exceeds the size limit.');
    chunks.push(bytes);
  }
  return Buffer.concat(chunks, size);
}

async function readFields(request, allowFile = false) {
  const contentType = request.headers.get('Content-Type') || '';
  const mime = contentType.split(';')[0];
  const multipart = mime === 'multipart/form-data';
  validate(mime === 'application/json' || (allowFile && multipart), 415, 'Send an item or a file upload.');
  const bytes = await boundedBody(request, multipart ? fileLimit + jsonLimit : jsonLimit);
  try {
    if (!multipart) return { fields: JSON.parse(bytes.toString('utf8')) };
    const form = await new Response(bytes, { headers: { 'Content-Type': contentType } }).formData();
    const file = form.get('file');
    validate(file instanceof File && file.size > 0 && file.size <= fileLimit, 400, `Choose a non-empty file up to ${fileLimitMb} MB.`);
    return { fields: JSON.parse(form.get('fields')), file };
  } catch (error) {
    if (error instanceof HttpError) throw error;
    throw new HttpError(400, 'The item could not be read.');
  }
}

function stored(result) {
  if (result?.error) throw new HttpError(result.status || 400, result.error);
  return result;
}

async function saveItem(request, store, id) {
  const { fields, file } = await readFields(request, true);
  validate(fields && typeof fields === 'object', 400, 'Enter the item details.');
  const { category, status, kind } = fields;
  const parent = fields.parent || null;
  const title = cleanText(fields.title, 160);
  const description = cleanText(fields.description ?? '', 1200);
  let body = cleanText(fields.body ?? '', 12000);
  validate(parent === null || typeof parent === 'string', 400, 'Choose a valid folder.');
  validate(title && categoryIds.has(category) && itemKinds.has(kind) && ['draft', 'published'].includes(status), 400,
    'Choose a valid category, content type and status, and enter a title.');
  if (kind === 'youtube' || kind === 'loop') body = cleanLink(body, kind);
  if (kind === 'file' || kind === 'folder') body = '';
  if (kind === 'note') validate(body || status === 'draft', 400, 'Write a note before publishing it.');
  let attachment = null;
  if (file) {
    const filename = Buffer.from(file.name.split(/[\\/]/).at(-1).replace(/[\x00-\x1f\x7f]/g, '').slice(0, 180)).toString();
    const mime = allowedMime.get(extname(filename).toLowerCase());
    validate(kind === 'file' && mime, 400, 'Choose a supported document, image, recording, video, or archive.');
    attachment = { object: randomUUID(), filename, mime };
    await store.store(attachment.object, file, mime);
  }
  const result = await store.rpc('save', { p_id: id || randomUUID(), p_create: !id,
    fields: { category, parent, status, kind, title, description, body }, attachment });
  if (result?.error && attachment) await store.remove(attachment.object);
  stored(result);
  await store.remove(result.remove_object);
  return { id: result.id };
}

async function serveFile(request, store, id) {
  const item = await store.rpc('item', { p_id: id });
  validate(item?.object, 404, 'File not found.');
  const range = request.headers.get('Range');
  validate(!range || /^bytes=(\d+-\d*|-\d+)$/.test(range), 416, 'This file range is invalid.');
  const response = await store.download(item.object, request.method, range);
  if (![200, 206, 416].includes(response.status)) {
    await response.body?.cancel();
    throw new HttpError(response.status === 400 || response.status === 404 ? 404 : 502, 'The file could not be opened.');
  }
  const name = Buffer.from(item.filename || item.title || 'file').toString();
  const filename = encodeURIComponent(name).replace(/['()*]/g, char => `%${char.charCodeAt(0).toString(16)}`);
  const safeMime = inlineMimes.has(item.mime);
  const headers = new Headers({ ...browserHeaders, 'Content-Type': safeMime ? item.mime : 'application/octet-stream',
    'Content-Disposition': `${safeMime ? 'inline' : 'attachment'}; filename*=UTF-8''${filename}` });
  for (const header of ['content-length', 'content-range', 'accept-ranges']) {
    if (response.headers.has(header)) headers.set(header, response.headers.get(header));
  }
  return new Response(request.method === 'HEAD' ? null : response.body, { status: response.status, headers });
}

export function makePortal({ origin, username = 'ruby', password, allowExistingAccess = false, store }) {
  const preserveAccess = allowExistingAccess && !password;
  validate(preserveAccess || (typeof password === 'string' && password.length >= 16 && username.length > 0 && !/[:\r\n]/.test(username)), 500,
    'Set a shared library password of at least 16 characters.');
  const access = preserveAccess ? null : digest(`${username}:${password}`);
  let uploads = 0;
  async function save(request, id) {
    const upload = request.headers.get('Content-Type')?.startsWith('multipart/form-data;');
    validate(!upload || uploads < 2, 503, 'The server is handling other uploads. Try again shortly.');
    if (upload) uploads++;
    try { return await saveItem(request, store, id); }
    finally { if (upload) uploads--; }
  }
  return async function portal(request) {
    const url = new URL(request.url);
    const method = request.method;
    const path = url.pathname;
    if (path === '/healthz' && method === 'GET') return json({ ready: true });
    const credential = request.headers.get('Authorization')?.match(/^Basic ([A-Za-z0-9+/=]+)$/i)?.[1];
    if (access && (!credential || !timingSafeEqual(digest(Buffer.from(credential, 'base64')), access))) {
      return json({ error: 'This library is private.' }, 401, { 'WWW-Authenticate': 'Basic realm="Ruby Signature Library", charset="UTF-8"' });
    }
    try {
      if (method !== 'GET' && method !== 'HEAD') {
        validate(request.headers.get('Origin') === origin, 403, 'Open the library directly in your browser and try again.');
      }
      const asset = assets.get(path === '/' ? '/index.html' : path);
      if (asset && (method === 'GET' || method === 'HEAD')) {
        return new Response(method === 'HEAD' ? null : asset.bytes, { headers: { ...browserHeaders, 'Content-Type': `${asset.type}; charset=utf-8` } });
      }
      if (path === '/api/config' && method === 'GET') return json({ categories, fileExtensions: [...allowedMime.keys()], fileLimitMb, legacy: Boolean(store.legacy) });
      if (path === '/api/library' && method === 'GET') {
        const category = url.searchParams.get('category');
        validate(categoryIds.has(category), 404, 'Category not found.');
        return json(await store.rpc('library', { p_category: category }));
      }
      const file = path.match(/^\/api\/files\/([\w-]+)$/);
      if (file && ['GET', 'HEAD'].includes(method)) return await serveFile(request, store, file[1]);
      const progress = path.match(/^\/api\/progress\/([\w-]+)$/);
      if (progress && method === 'POST') {
        const { fields } = await readFields(request);
        const completed = fields?.completed;
        validate(completed === undefined || typeof completed === 'boolean', 400, 'Choose a completion status.');
        return json(stored(await store.rpc('progress_set', { p_id: progress[1], p_completed: completed ?? null })));
      }
      if (path === '/api/items' && method === 'POST') return json(await save(request, null), 201);
      const item = path.match(/^\/api\/items\/([\w-]+)(\/move)?$/);
      if (item && !item[2] && method === 'PUT') return json(await save(request, item[1]));
      if (item && !item[2] && method === 'DELETE') {
        const result = stored(await store.rpc('delete', { p_id: item[1] }));
        await store.remove(result.remove_object);
        return json({});
      }
      if (item?.[2] && method === 'POST') {
        const { fields } = await readFields(request);
        validate(fields?.direction === 'up' || fields?.direction === 'down', 400, 'Choose a direction.');
        return json(stored(await store.rpc('move', { p_id: item[1], p_direction: fields.direction })));
      }
      throw new HttpError(404, 'Page not found.');
    } catch (error) {
      if (error instanceof HttpError) return json({ error: error.message }, error.code);
      console.error('Portal request failed:', error.name);
      return json({ error: 'Something went wrong. Try again.' }, 500);
    }
  };
}

export async function startRender() {
  const env = process.env;
  const address = new URL(env.PUBLIC_ORIGIN || env.RENDER_EXTERNAL_URL);
  validate(address.protocol === 'https:', 500, 'Configure the HTTPS address of the Render service.');
  const allowExistingAccess = address.origin === 'https://my-library-ilur.onrender.com';
  const store = connectSupabase({ url: env.SUPABASE_URL, key: env.SUPABASE_SECRET_KEY || env.SUPABASE_SERVICE_ROLE_KEY,
    bucket: env.SUPABASE_BUCKET || 'library-files', allowExistingAccess });
  const portal = makePortal({ origin: address.origin, username: env.LIBRARY_ACCESS_USER, password: env.LIBRARY_ACCESS_PASSWORD, allowExistingAccess, store });
  await store.verify();
  createServer(async (req, res) => {
    try {
      validate(req.url.startsWith('/') && !req.url.startsWith('//'), 400, 'Use the portal address.');
      const body = req.method === 'GET' || req.method === 'HEAD' ? undefined : Readable.toWeb(req);
      const request = new Request(address.origin + req.url, { method: req.method, headers: req.headers, body, duplex: 'half' });
      const response = await portal(request);
      res.writeHead(response.status, Object.fromEntries(response.headers));
      if (req.method === 'HEAD' || !response.body) res.end();
      else await pipeline(Readable.fromWeb(response.body), res);
    } catch (error) {
      if (res.headersSent) return res.destroy();
      res.writeHead(error instanceof HttpError ? error.code : 500, { ...cacheHeaders, 'Content-Type': 'text/plain; charset=utf-8' });
      res.end(error instanceof HttpError ? error.message : 'Something went wrong. Try again.');
    }
  }).listen(Number(env.PORT || 10000), '0.0.0.0', () => console.log(`Ruby’s Signature listening on ${address.origin}`));
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  await startRender();
}
