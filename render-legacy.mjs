import { randomUUID } from 'node:crypto';
import { HttpError } from './catalog.mjs';

const names = new Map([
  ['english', 'english'], ['englishtutorial', 'english'], ['englishtutorials', 'english'], ['categoryyoutubeenglish', 'english'],
  ['hindi', 'hindi'], ['hinditutorial', 'hindi'], ['hinditutorials', 'hindi'], ['categoryyoutubehindi', 'hindi'],
  ['workflow', 'workflows'], ['workflows', 'workflows'], ['categoriesworkflow', 'workflows'],
]);

const categoryFor = value => names.get(String(value ?? '').toLowerCase().replace(/[^a-z]+/g, '')) ?? 'description';
const titles = { english: 'category you tube english', hindi: 'category you tube hindi', workflows: 'categories workflow', description: 'categories detail content' };
const token = () => Date.now();
const error = (status, message) => ({ status, error: message });
const kindFor = type => type === 'text' ? 'note' : type;
const knownKinds = new Set(['note', 'file', 'youtube', 'loop']);

function record(row, includeObject = false) {
  const kind = kindFor(row.type);
  const known = knownKinds.has(kind) ? kind : row.file_path ? 'file' : 'note';
  const youtubeId = /^[\w-]{11}$/.test(row.youtube_id ?? '') ? row.youtube_id : '';
  return { id: String(row.id), title: row.name, category: categoryFor(row.category), parent: null, kind: known, status: 'published',
    description: known === 'note' ? row.url ?? '' : row.text ?? '',
    body: known === 'youtube' ? youtubeId : known === 'loop' ? row.url ?? '' : known === 'note' ? row.text ?? '' : '',
    position: Number(row.number) || 0, mime: row.mime, filename: row.original_filename,
    ...(includeObject ? { object: row.file_path } : {}),
  };
}

export function connectLegacy(upstream) {
  async function rest(query = {}, options = {}) {
    const response = await upstream(`/rest/v1/library_items?${new URLSearchParams(query)}`, {
      ...options,
      headers: { ...(options.body ? { 'Content-Type': 'application/json' } : {}), ...options.headers },
      ...(options.body ? { body: JSON.stringify(options.body) } : {}),
    });
    if (!response.ok) {
      await response.body?.cancel();
      console.error('Existing Supabase library request failed:', options.method || 'GET', response.status);
      throw new HttpError(502, 'The library database could not complete the request.');
    }
    return response.status === 204 ? [] : response.json();
  }

  async function readAll() {
    const rows = [];
    const limit = 200;
    for (let offset = 0;; offset += limit) {
      const page = await rest({ order: 'number.asc,id.asc', limit, offset });
      rows.push(...page);
      if (page.length < limit) return rows;
    }
  }

  async function getItem(id) {
    return (await rest({ id: `eq.${id}`, limit: 1 }))[0];
  }

  async function unreferenced(object) {
    if (!object) return null;
    const references = await rest({ file_path: `eq.${object}`, select: 'id', limit: 1 });
    return references.length ? null : object;
  }

  async function list({ p_category }) {
    return { items: (await readAll()).filter(row => categoryFor(row.category) === p_category).map(row => record(row)), progress: [] };
  }

  async function item({ p_id }) {
    const row = await getItem(p_id);
    return row ? record(row, true) : null;
  }

  async function save({ p_id, p_create, fields, attachment }) {
    if (fields.parent || fields.kind === 'folder' || fields.status !== 'published') {
      return error(400, 'Folders and drafts require the Supabase library migration.');
    }
    const current = p_create ? null : await getItem(p_id);
    if (!p_create && !current) return error(404, 'Item not found.');
    const object = fields.kind === 'file' ? attachment?.object ?? current?.file_path : null;
    if (fields.kind === 'file' && !object) return error(400, 'Choose a file before publishing.');
    const rows = p_create || categoryFor(current.category) !== fields.category ? await readAll() : null;
    const number = rows ? Math.max(0, ...rows.map(row => Number(row.number) || 0)) + 1 : current.number;
    const filename = object ? attachment?.filename ?? current?.original_filename : null;
    const mime = object ? attachment?.mime ?? current?.mime : fields.kind === 'youtube' ? 'text/youtube' : fields.kind === 'note' ? 'text/plain' : null;
    const data = { name: fields.title, category: current && categoryFor(current.category) === fields.category ? current.category : titles[fields.category],
      number, updated_at: Math.max(token(), (Number(current?.updated_at) || 0) + 1), mime,
      extension: filename ? filename.split('.').at(-1).toUpperCase() : fields.kind === 'youtube' ? 'YOUTUBE' : fields.kind === 'note' ? 'TXT' : null,
      type: fields.kind === 'note' ? 'text' : fields.kind,
      text: (fields.kind === 'note' ? fields.body : fields.description) || null,
      youtube_id: fields.kind === 'youtube' ? fields.body : null,
      url: fields.kind === 'youtube' ? `https://www.youtube.com/watch?v=${fields.body}` :
        fields.kind === 'loop' ? fields.body : fields.kind === 'note' ? fields.description || null : null,
      file_path: object ?? null, original_filename: filename ?? null,
    };
    if (p_create) {
      await rest({}, { method: 'POST', headers: { Prefer: 'return=representation' }, body: { ...data, id: p_id || randomUUID(), created_at: token() } });
    } else {
      const changed = await rest({ id: `eq.${p_id}`, updated_at: current.updated_at == null ? 'is.null' : `eq.${current.updated_at}` },
        { method: 'PATCH', headers: { Prefer: 'return=representation' }, body: data });
      if (!changed.length) return error(409, 'This item changed while you were editing it. Reload and try again.');
    }
    return { id: p_id, remove_object: current?.file_path !== object ? await unreferenced(current?.file_path) : null };
  }

  async function remove({ p_id }) {
    const [row] = await rest({ id: `eq.${p_id}` }, { method: 'DELETE', headers: { Prefer: 'return=representation' } });
    return row ? { remove_object: await unreferenced(row.file_path) } : error(404, 'Item not found.');
  }

  async function move({ p_id, p_direction }) {
    const rows = await readAll();
    const row = rows.find(entry => String(entry.id) === p_id);
    if (!row) return error(404, 'Item not found.');
    const siblings = rows.filter(entry => categoryFor(entry.category) === categoryFor(row.category));
    const index = siblings.indexOf(row);
    const neighbor = siblings[index + (p_direction === 'up' ? -1 : 1)];
    if (!neighbor) return {};
    if (row.number === neighbor.number) {
      const [first, second] = p_direction === 'up' ? [row, neighbor] : [neighbor, row];
      first.number = Number(first.number) - 1;
      second.number = Number(second.number) + 1;
    } else [row.number, neighbor.number] = [neighbor.number, row.number];
    await rest({ on_conflict: 'id' }, { method: 'POST', headers: { Prefer: 'resolution=merge-duplicates,return=minimal' },
      body: [row, neighbor].map(entry => ({ ...entry, updated_at: token() })) });
    return {};
  }

  const handlers = { library: list, item, save, delete: remove, move };
  return (command, data) => {
    if (!Object.hasOwn(handlers, command)) throw new HttpError(404, 'Page not found.');
    return handlers[command](data);
  };
}
