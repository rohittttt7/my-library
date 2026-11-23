const allowedMime = new Map(Object.entries({
  '.pdf': 'application/pdf', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.png': 'image/png', '.webp': 'image/webp',
  '.gif': 'image/gif', '.avif': 'image/avif',
  '.docx': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  '.pptx': 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  '.xlsx': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  '.txt': 'text/plain', '.csv': 'text/csv',
  '.mp3': 'audio/mpeg', '.wav': 'audio/wav', '.m4a': 'audio/mp4', '.aac': 'audio/aac', '.ogg': 'audio/ogg', '.opus': 'audio/ogg', '.amr': 'audio/amr',
  '.mp4': 'video/mp4', '.webm': 'video/webm', '.mov': 'video/quicktime', '.3gp': 'video/3gpp',
  '.zip': 'application/zip', '.7z': 'application/x-7z-compressed', '.rar': 'application/vnd.rar',
}));
const fileLimitMb = 64;
const fileLimit = fileLimitMb * 1024 * 1024;
const itemKinds = new Set(['note', 'youtube', 'loop', 'file', 'folder']);

class HttpError extends Error {
  constructor(code, message) { super(message); this.code = code; }
}

function validate(condition, code, message) {
  if (!condition) throw new HttpError(code, message);
}

function cleanText(value, max) {
  validate(typeof value === 'string' && value.length <= max, 400, `Keep text to ${max} characters or fewer.`);
  return value.trim();
}

const youtubeHosts = new Set(['youtube.com', 'www.youtube.com', 'm.youtube.com', 'music.youtube.com', 'youtube-nocookie.com', 'www.youtube-nocookie.com']);

function youtubeId(body) {
  const message = 'Paste a YouTube video link, such as youtube.com/watch?v=… or youtu.be/…';
  let url;
  try {
    const address = /^[a-z][a-z\d+.-]*:/i.test(body) ? body : `https://${body.replace(/^\/\//, '')}`;
    url = new URL(address);
  } catch {
    throw new HttpError(400, message);
  }
  validate(['http:', 'https:'].includes(url.protocol) && !url.username && !url.password && !url.port, 400, message);
  let id;
  if (url.hostname === 'youtu.be') {
    id = url.pathname.match(/^\/([\w-]+)\/?$/)?.[1];
  } else if (youtubeHosts.has(url.hostname)) {
    id = /^\/watch\/?$/.test(url.pathname) ? url.searchParams.get('v') : url.pathname.match(/^\/(?:embed|shorts|live)\/([\w-]+)\/?$/)?.[1];
  }
  validate(id && /^[\w-]{11}$/.test(id), 400, message);
  return id;
}

function cleanLink(body, kind) {
  if (kind === 'youtube') return youtubeId(body);
  let url;
  try { url = new URL(body); } catch { throw new HttpError(400, 'Paste a valid Microsoft Loop link.'); }
  validate(url.protocol === 'https:' && !url.username && !url.password, 400, 'Paste the HTTPS link from Microsoft Loop.');
  validate(['loop.cloud.microsoft', 'loop.microsoft.com'].includes(url.hostname) || url.hostname.endsWith('.sharepoint.com') || url.hostname === '1drv.ms', 400, 'Use the authorised Microsoft Loop or SharePoint link.');
  return url.href;
}

export { allowedMime, fileLimitMb, fileLimit, itemKinds, HttpError, validate, cleanText, cleanLink };
