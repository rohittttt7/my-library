const app = document.querySelector('#app');
const dialog = document.querySelector('#dialog');
const notice = document.querySelector('#notice');
const kinds = { file: 'Upload a file', youtube: 'YouTube link', note: 'Note', loop: 'Microsoft Loop link', folder: 'Folder' };
const tones = { english: 'plum', hindi: 'peach', workflows: 'sage', description: 'blue' };
let categories = [];
let fileExtensions = [];
let fileLimitMb;
let state = null;
let keyword = '';
let filter = '';
let revision = 0;
let timer;

const escape = value => String(value ?? '').replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char]);
const current = () => state?.category || categories[0];
const selected = (a, b) => a === b ? ' selected' : '';
const url = (category = 'english', item = '') => `#/${category}${item ? `/${item}` : ''}`;
const here = item => url(current().id, item);
const byId = id => state.items.find(item => item.id === id);
const children = parent => state.items.filter(item => item.parent === (parent ?? null));
const completion = id => Boolean(state.progress.find(row => row.item_id === id)?.completed);
const descriptor = item => item.kind === 'file' && item.filename ? item.filename.split('.').at(-1).toUpperCase() : kinds[item.kind];

async function api(path, method = 'GET', data) {
  const form = data instanceof FormData;
  const response = await fetch(`/api${path}`, {
    method,
    headers: data === undefined || form ? {} : { 'Content-Type': 'application/json' },
    body: data === undefined || form ? data : JSON.stringify(data),
  });
  const result = await response.json();
  if (!response.ok) throw new Error(result.error || 'Something went wrong.');
  return result;
}

function flash(message) {
  clearTimeout(timer);
  notice.textContent = message;
  notice.hidden = false;
  timer = setTimeout(() => { notice.hidden = true; }, 4500);
}

function brand() {
  return '<span class="brand-mark" aria-hidden="true">R</span><span><strong>Ruby’s Signature</strong><small>Learning Portal</small></span>';
}

function icon(category) {
  return `<span class="category-icon ${tones[category.id]}" aria-hidden="true">${escape(category.icon)}</span>`;
}

function shell(category) {
  const navigation = categories.map(entry => `<a class="nav-link${category.id === entry.id ? ' active' : ''}" ${category.id === entry.id ? 'aria-current="page"' : ''} href="${url(entry.id)}">${icon(entry)}<span>${escape(entry.title)}</span></a>`).join('');
  app.innerHTML = `<div class="layout"><aside class="sidebar"><a class="brand" href="${url()}">${brand()}</a>
    <nav aria-label="Categories"><p class="nav-label">LEARNING LIBRARY</p>${navigation}</nav></aside>
    <div class="workspace"><header class="topbar"><a class="brand compact" href="${url()}">${brand()}</a><div class="header-location">Learning Portal</div></header><main id="main" class="main" tabindex="-1"></main></div></div>`;
}

function readRoute() {
  const [, prefix, ...rest] = location.hash.slice(1).split('/');
  const [key, id] = prefix === 'manage' ? rest : [prefix, rest[0]];
  const category = categories.find(entry => entry.id === key) || categories[0];
  return { category, id };
}

async function navigate({ preserveSearch = false, focus = false } = {}) {
  if (!preserveSearch) { keyword = ''; filter = ''; }
  const target = readRoute();
  const load = ++revision;
  shell(target.category);
  document.title = `${target.category.title} | Ruby’s Signature`;
  const main = document.querySelector('#main');
  main.innerHTML = '<p class="loading" role="status">Loading…</p>';
  try {
    const library = await api(`/library?category=${encodeURIComponent(target.category.id)}`);
    if (load !== revision) return;
    state = { ...target, ...library };
    renderLibrary();
    const item = target.id && byId(target.id);
    if (item && item.kind !== 'folder') {
      api(`/progress/${item.id}`, 'POST', {}).catch(() => {});
    }
    if (focus) main.focus({ preventScroll: true });
  } catch (error) {
    if (load === revision) main.innerHTML = `<p class="form-error" role="alert">${escape(error.message)}</p><button class="button" data-action="retry">Try again</button>`;
  }
}

function breadcrumbs(item) {
  const path = [];
  let entry = item;
  while (entry) { path.unshift(entry); entry = byId(entry.parent); }
  return `<nav class="breadcrumbs" aria-label="Breadcrumb"><a href="${url()}">Home</a><span aria-hidden="true">/</span>${path.length ? `<a href="${here()}">${escape(current().title)}</a>` : `<span aria-current="page">${escape(current().title)}</span>`}${path.map((step, index) => `<span aria-hidden="true">/</span>${index === path.length - 1 ? `<span aria-current="page">${escape(step.title)}</span>` : `<a href="${here(step.id)}">${escape(step.title)}</a>`}`).join('')}</nav>`;
}

function learnable(parent = null) {
  return children(parent).flatMap(item => item.kind === 'folder' ? learnable(item.id) : [item]);
}

function progressPanel() {
  if (current().id === 'description') return '';
  const items = learnable();
  const count = items.filter(item => completion(item.id)).length;
  const recent = [...state.progress].sort((a, b) => b.updated - a.updated)[0];
  const last = recent ? byId(recent.item_id) : null;
  const next = last && completion(last.id) ? items.slice(items.indexOf(last) + 1).find(item => !completion(item.id)) : last;
  const resume = next || (recent && items.find(item => !completion(item.id)));
  return `<section class="progress-card" aria-labelledby="progress-title"><div><h2 id="progress-title">Your progress</h2><p>${count} of ${items.length} completed</p></div>
    <progress aria-label="Category progress" max="${items.length || 1}" value="${count}"></progress>${resume ? `<a class="button soft" href="${here(resume.id)}">Continue learning</a>` : ''}</section>`;
}

function renderLibrary() {
  const main = document.querySelector('#main');
  const category = current();
  const item = state.id ? byId(state.id) : null;
  if (state.id && !item) {
    main.innerHTML = `${breadcrumbs()}<section class="empty"><h1>Item unavailable</h1><p>This item may have been moved, removed or unpublished.</p><a class="button" href="${here()}">Back to ${escape(category.title)}</a></section>`;
    return;
  }
  if (item && item.kind !== 'folder') { renderDetail(main, item); return; }
  const progress = item ? '' : progressPanel();
  const title = item?.title || category.title;
  const description = item?.description || (!item ? category.description : '');
  const subhead = item ? 'Folder contents' : category.id === 'description' ? 'About the portal' : category.id === 'workflows' ? 'Workflow library' : 'Lesson library';
  main.innerHTML = `${breadcrumbs(item)}<section class="hero ${tones[category.id]}"><div class="hero-text">${icon(category)}<h1>${escape(title)}</h1>${description ? `<p>${escape(description)}</p>` : ''}</div><div class="book-art" aria-hidden="true"><i></i><i></i><i></i></div></section>
    ${progress}<section class="library" aria-labelledby="library-title"><div class="section-heading"><h2 id="library-title">${subhead}</h2><button class="button primary" data-action="add">+ Add Content</button></div>
    <div class="filters"><label class="search"><span class="sr-only">Search ${escape(category.title)}</span><input type="search" id="search" placeholder="Search this category" value="${escape(keyword)}"></label><label><span class="sr-only">Filter by content type</span><select id="filter"><option value="">Content type</option>${Object.entries(kinds).map(([key, value]) => `<option value="${key}"${selected(filter, key)}>${value}</option>`).join('')}</select></label></div>
    <div id="items" aria-live="polite"></div></section>`;
  renderList();
}

function renderList() {
  const term = keyword.trim().toLowerCase();
  const destination = document.querySelector('#items');
  const parent = state.id || null;
  const siblings = children(parent);
  const candidates = term || filter ? state.items.filter(item => {
    if (!parent) return true;
    let branch = byId(item.parent);
    while (branch && branch.id !== parent) branch = byId(branch.parent);
    return branch?.id === parent;
  }) : siblings;
  const rows = candidates.filter(item => (!filter || item.kind === filter) && `${item.title} ${item.description} ${item.kind === 'note' ? item.body : ''} ${current().title} ${descriptor(item)}`.toLowerCase().includes(term));
  if (!rows.length) {
    destination.innerHTML = `<div class="empty"><span class="empty-icon" aria-hidden="true">≡</span><h3>${term || filter ? 'No matching items' : 'Nothing here yet'}</h3><p>${term || filter ? 'Try a different search or content type.' : 'Add the first item to this category or folder.'}</p>${term || filter ? '<button class="button" data-action="clear">Clear filters</button>' : ''}</div>`;
    return;
  }
  destination.innerHTML = `<ul class="items">${rows.map(item => {
    const siblings = children(item.parent);
    const position = siblings.indexOf(item);
    const folder = byId(item.parent);
    return `<li class="item-row"><a class="item-link" href="${here(item.id)}"><span class="number">${position + 1}</span><span class="item-text"><strong>${escape(item.title)}</strong>${item.description ? `<span>${escape(item.description)}</span>` : ''}<small>${escape(descriptor(item))}${folder && (term || filter) ? ` · ${escape(folder.title)}` : ''}</small></span>${completion(item.id) ? '<span class="tag published">Completed</span>' : ''}</a>
      <div class="item-actions">${item.status === 'draft' ? '<span class="tag draft">Draft</span>' : ''}<button class="button small" data-action="up" data-id="${item.id}" ${position === 0 ? 'disabled' : ''}>Move up</button><button class="button small" data-action="down" data-id="${item.id}" ${position === siblings.length - 1 ? 'disabled' : ''}>Move down</button><button class="button small" data-action="edit" data-id="${item.id}">Edit</button><button class="button small danger" data-action="delete" data-id="${item.id}">Delete</button></div></li>`;
  }).join('')}</ul>`;
}

function viewer(item) {
  if (item.kind === 'note') return `<div class="note">${escape(item.body)}</div>`;
  if (item.kind === 'youtube') return `<iframe class="video" src="https://www.youtube-nocookie.com/embed/${escape(item.body)}" title="${escape(item.title)}" referrerpolicy="strict-origin-when-cross-origin" allow="encrypted-media; picture-in-picture; fullscreen" allowfullscreen></iframe><a class="button" href="https://www.youtube.com/watch?v=${escape(item.body)}" target="_blank" rel="noopener">Open on YouTube</a>`;
  if (item.kind === 'loop') return `<a class="button primary" href="${escape(item.body)}" target="_blank" rel="noopener">Open Microsoft Loop</a><p class="muted">Microsoft may ask you to sign in to open this page.</p>`;
  const src = `/api/files/${item.id}`;
  if (!item.mime) return '<p class="muted">No file attached.</p>';
  if (item.mime.startsWith('image/')) return `<button class="image-button" data-action="enlarge" data-id="${item.id}" aria-label="Enlarge ${escape(item.title)}"><img src="${src}" alt="${escape(item.title)}"></button><button class="button" data-action="enlarge" data-id="${item.id}">Enlarge image</button>`;
  if (item.mime.startsWith('audio/') || item.mime.startsWith('video/')) {
    const player = item.mime.startsWith('audio/') ? 'audio' : 'video';
    return `<${player} src="${src}" controls playsinline preload="metadata"></${player}><a class="button media-download" href="${src}" download="${escape(item.filename)}">Download ${escape(descriptor(item))}</a>`;
  }
  if (item.mime === 'application/pdf') return `<a class="button primary" href="${src}" target="_blank" rel="noopener">Open PDF</a> <a class="button" href="${src}" download="${escape(item.filename)}">Download PDF</a><iframe class="pdf" src="${src}" title="${escape(item.title)}"></iframe>`;
  return `<a class="button primary" href="${src}" download="${escape(item.filename)}">Download ${escape(descriptor(item))}</a>`;
}

function renderDetail(main, item) {
  const sequence = learnable();
  const index = sequence.indexOf(item);
  const before = sequence[index - 1];
  const after = sequence[index + 1];
  const done = completion(item.id);
  const back = item.parent ? here(item.parent) : here();
  const foot = `<div class="lesson-controls"><div>${before ? `<a class="button" href="${here(before.id)}">Previous</a>` : ''}${after ? `<a class="button" href="${here(after.id)}">Next</a>` : ''}</div><button class="button ${done ? 'soft' : 'primary'}" data-action="complete" data-id="${item.id}" aria-pressed="${done}">${done ? 'Completed · Undo' : 'Mark as completed'}</button></div>`;
  main.innerHTML = `${breadcrumbs(item)}<a class="button back" href="${back}">Back</a><article class="detail"><header><span class="tag">${escape(descriptor(item))}</span><h1>${escape(item.title)}</h1>${item.description ? `<p>${escape(item.description)}</p>` : ''}<p class="muted">Item ${index + 1} of ${sequence.length}</p><div class="detail-actions"><button class="button" data-action="edit" data-id="${item.id}">Edit content</button><button class="button danger" data-action="delete" data-id="${item.id}">Delete</button></div></header><div class="viewer">${viewer(item)}</div>${foot}</article>`;
}

function showDialog(title, content, extraClass = '') {
  dialog.className = extraClass;
  dialog.innerHTML = `<div class="dialog-head"><h2 id="dialog-title">${escape(title)}</h2><button class="button icon-button" data-action="close" aria-label="Close">×</button></div>${content}`;
  if (!dialog.open) dialog.showModal();
}

function contentForm(item) {
  const category = current().id;
  const parent = item ? item.parent : state.id || null;
  const parentOptions = state.items.filter(entry => {
    if (entry.kind !== 'folder' || entry.id === item?.id) return false;
    let cursor = byId(entry.parent);
    while (cursor) {
      if (cursor.id === item?.id) return false;
      cursor = byId(cursor.parent);
    }
    return true;
  });
  const folderPath = folder => {
    const path = [folder.title];
    let cursor = byId(folder.parent);
    while (cursor) { path.unshift(cursor.title); cursor = byId(cursor.parent); }
    return path.join(' / ');
  };
  const type = item?.kind || 'file';
  const link = item?.kind === 'youtube' ? `https://www.youtube.com/watch?v=${item.body}` : item?.kind === 'loop' ? item.body : '';
  showDialog(item ? 'Edit content' : 'Add Content', `<form id="content-form" data-id="${item?.id || ''}"><label>Title<input name="title" required maxlength="160" value="${escape(item?.title)}"></label>
    <div class="form-grid"><label>Content type<select name="kind">${Object.entries(kinds).map(([key, value]) => `<option value="${key}"${selected(type, key)}>${value}</option>`).join('')}</select></label>
    <label>Category<select name="category">${categories.map(entry => `<option value="${entry.id}"${selected(category, entry.id)}>${escape(entry.title)}</option>`).join('')}</select></label></div>
    <div class="form-grid"><label>Folder<select name="parent"><option value="">Category root</option>${parentOptions.map(folder => `<option value="${folder.id}"${selected(parent, folder.id)}>${escape(folderPath(folder))}</option>`).join('')}</select></label>
    <label>Status<select name="status"><option value="published"${selected(item?.status, 'published')}>Published</option><option value="draft"${selected(item?.status, 'draft')}>Draft</option></select></label></div>
    <label>Description <span class="optional">(optional)</span><textarea name="description" rows="2" maxlength="1200">${escape(item?.description)}</textarea></label>
    <label data-for="note">Note<textarea name="note" rows="6" maxlength="12000">${escape(item?.kind === 'note' ? item.body : '')}</textarea></label>
    <label data-for="link"><span data-link-label>Link</span><input type="text" inputmode="url" name="link" maxlength="2000" value="${escape(link)}" autocomplete="off" spellcheck="false" aria-describedby="link-hint"><small id="link-hint"></small></label>
    <label data-for="file">${item?.filename ? 'Replace file' : 'File'}<input type="file" name="file" accept="${escape(fileExtensions.join(','))}"><small>${item?.filename ? `Current file: ${escape(item.filename)} · ` : ''}PDFs, images, recordings, videos, Office files and ZIP archives up to ${fileLimitMb} MB.</small></label>
    <p class="form-error" role="alert"></p><div class="form-actions"><button class="button" type="button" data-action="close">Cancel</button><button class="button primary" type="submit">${item ? 'Save changes' : 'Add content'}</button></div></form>`);
  updateKind(dialog.querySelector('form'));
}

function updateKind(form) {
  const type = form.elements.kind.value;
  const isYouTube = type === 'youtube';
  const linkField = form.querySelector('[data-for="link"]');
  const link = form.elements.link;
  form.querySelector('[data-for="note"]').hidden = type !== 'note';
  linkField.hidden = !isYouTube && type !== 'loop';
  linkField.querySelector('[data-link-label]').textContent = isYouTube ? 'YouTube video link' : 'Microsoft Loop link';
  linkField.querySelector('#link-hint').textContent = isYouTube ? 'Paste a YouTube watch, share, Shorts or live link.' : 'Paste the sharing link from Microsoft Loop.';
  link.type = isYouTube ? 'text' : 'url';
  link.placeholder = isYouTube ? 'youtube.com/watch?v=…' : 'https://';
  link.disabled = linkField.hidden;
  link.required = !linkField.hidden;
  form.querySelector('[data-for="file"]').hidden = type !== 'file';
  form.elements.file.disabled = type !== 'file';
}

function confirmRemoval(item) {
  showDialog('Delete content?', `<form id="remove-form" data-id="${item.id}"><p>${escape(item.title)} will be permanently removed.</p><p class="form-error" role="alert"></p><div class="form-actions"><button class="button" type="button" data-action="close">Cancel</button><button class="button danger-solid" type="submit">Delete content</button></div></form>`);
}

async function submit(event) {
  const form = event.target;
  if (!['content-form', 'remove-form'].includes(form.id)) return;
  event.preventDefault();
  const errorText = form.querySelector('.form-error');
  const submit = form.querySelector('[type="submit"]');
  const original = submit.textContent;
  submit.disabled = true;
  submit.textContent = 'Please wait…';
  errorText.textContent = '';
  try {
    const id = form.dataset.id;
    let message;
    let destination;
    if (form.id === 'content-form') {
      const fields = Object.fromEntries(new FormData(form));
      const data = { title: fields.title, category: fields.category, parent: fields.parent, kind: fields.kind, status: fields.status, description: fields.description, body: fields.kind === 'note' ? fields.note : fields.link || '' };
      let payload = data;
      if (fields.kind === 'file' && fields.file?.size) {
        if (fields.file.size > fileLimitMb * 1024 * 1024) throw new Error(`Choose a file up to ${fileLimitMb} MB.`);
        payload = new FormData();
        payload.append('fields', JSON.stringify(data));
        payload.append('file', fields.file);
      }
      await api(id ? `/items/${id}` : '/items', id ? 'PUT' : 'POST', payload);
      message = id ? 'Changes saved.' : 'Content added.';
      if (fields.category !== current().id) destination = url(fields.category, fields.parent);
    } else {
      const item = byId(id);
      await api(`/items/${id}`, 'DELETE');
      message = 'Content deleted.';
      if (state.id === id) destination = here(item.parent);
    }
    dialog.close();
    flash(message);
    if (destination) location.hash = destination;
    else await navigate({ preserveSearch: true });
  } catch (error) {
    errorText.textContent = error.message;
  } finally {
    submit.disabled = false;
    submit.textContent = original;
  }
}

async function click(event) {
  const button = event.target.closest('[data-action]');
  if (!button || button.disabled) return;
  const { action, id } = button.dataset;
  switch (action) {
    case 'close': dialog.close(); return;
    case 'retry': return navigate();
    case 'clear': keyword = ''; filter = ''; renderLibrary(); document.querySelector('#search').focus(); return;
    case 'add': return contentForm();
    case 'edit': return contentForm(byId(id));
    case 'delete': return confirmRemoval(byId(id));
    case 'enlarge': return showDialog(byId(id).title, `<img class="enlarged" alt="${escape(byId(id).title)}" src="/api/files/${id}">`, 'image-dialog');
  }
  button.disabled = true;
  try {
    if (action === 'up' || action === 'down') {
      await api(`/items/${id}/move`, 'POST', { direction: action });
      await navigate({ preserveSearch: true });
      document.querySelector(`[data-action="edit"][data-id="${id}"]`)?.focus();
    } else if (action === 'complete') {
      const completed = !completion(id);
      await api(`/progress/${id}`, 'POST', { completed });
      await navigate({ preserveSearch: true });
      document.querySelector('[data-action="complete"]')?.focus();
    }
  } catch (error) { flash(error.message); }
  finally { button.disabled = false; }
}

document.addEventListener('submit', submit);
document.addEventListener('click', click);
document.addEventListener('input', event => {
  if (event.target.id === 'search') { keyword = event.target.value; renderList(); }
});
document.addEventListener('change', async event => {
  const input = event.target;
  if (input.id === 'filter') { filter = input.value; renderList(); }
  if (input.form?.id !== 'content-form') return;
  if (input.name === 'kind') updateKind(input.form);
  if (input.name === 'file' && input.files[0] && !input.form.elements.title.value.trim()) {
    const filename = input.files[0].name;
    input.form.elements.title.value = (filename.replace(/\.[^.]+$/, '') || filename).slice(0, 160);
  }
  if (input.name === 'category') {
    const folders = input.form.elements.parent;
    const category = input.value;
    folders.replaceChildren(new Option('Category root', ''));
    folders.disabled = true;
    try {
      const { items } = await api(`/library?category=${encodeURIComponent(category)}`);
      if (input.value !== category) return;
      const id = input.form.dataset.id;
      for (const item of items.filter(item => item.kind === 'folder' && item.id !== id)) {
        const path = [item.title];
        let ancestor = items.find(entry => entry.id === item.parent);
        while (ancestor) { path.unshift(ancestor.title); ancestor = items.find(entry => entry.id === ancestor.parent); }
        folders.append(new Option(path.join(' / '), item.id));
      }
    } catch (error) { flash(error.message); }
    finally { if (input.value === category) folders.disabled = false; }
  }
});
window.addEventListener('hashchange', () => { if (categories.length && (!location.hash || location.hash.startsWith('#/'))) navigate({ focus: true }); });

try {
  ({ categories, fileExtensions, fileLimitMb } = await api('/config'));
  await navigate();
} catch (error) { app.innerHTML = `<main id="main" class="loading"><p role="alert">${escape(error.message)}</p><a class="button" href="/">Reload portal</a></main>`; }
