const http = require("http");
const fs = require("fs");
const path = require("path");

const PORT = process.env.PORT || 3000;
const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, "data");
const UPLOAD_DIR = process.env.UPLOAD_DIR || path.join(DATA_DIR, "uploads");
const DATA_FILE = path.join(DATA_DIR, "library.json");
const MAX_UPLOAD_SIZE = 100 * 1024 * 1024;

fs.mkdirSync(UPLOAD_DIR, { recursive: true });
if (!fs.existsSync(DATA_FILE)) fs.writeFileSync(DATA_FILE, "[]");

function readItems() {
  try {
    const items = JSON.parse(fs.readFileSync(DATA_FILE, "utf8"));
    const sorted = items.sort((a, b) => (Number(a.number) || 0) - (Number(b.number) || 0));
    let changed = false;
    sorted.forEach((item, index) => {
      if (item.number !== index + 1) {
        item.number = index + 1;
        changed = true;
      }
    });
    if (changed) fs.writeFileSync(DATA_FILE, JSON.stringify(sorted, null, 2));
    return sorted;
  } catch {
    return [];
  }
}

function writeItems(items) {
  fs.writeFileSync(DATA_FILE, JSON.stringify(items, null, 2));
}

function sendJson(response, status, value) {
  response.writeHead(status, {
    "Content-Type": "application/json",
    "Cache-Control": "no-store"
  });
  response.end(JSON.stringify(value));
}

function sendFile(response, filePath) {
  fs.stat(filePath, (error, stats) => {
    if (error || !stats.isFile()) {
      response.writeHead(404);
      response.end("Not found");
      return;
    }
    const extension = path.extname(filePath).toLowerCase();
    const types = {
      ".html": "text/html", ".css": "text/css", ".js": "text/javascript",
      ".json": "application/json", ".pdf": "application/pdf",
      ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg",
      ".gif": "image/gif", ".webp": "image/webp", ".aac": "audio/aac",
      ".mp3": "audio/mpeg", ".mp4": "video/mp4", ".txt": "text/plain"
    };
    response.writeHead(200, {
      "Content-Type": types[extension] || "application/octet-stream",
      "Content-Length": stats.size
    });
    fs.createReadStream(filePath).pipe(response);
  });
}

function parseJson(request) {
  return new Promise((resolve, reject) => {
    let body = "";
    request.on("data", (chunk) => {
      body += chunk;
      if (body.length > 1_000_000) {
        request.destroy();
        reject(new Error("Request too large"));
      }
    });
    request.on("end", () => {
      try { resolve(body ? JSON.parse(body) : {}); }
      catch { reject(new Error("Invalid JSON")); }
    });
  });
}

function parseMultipart(request) {
  return new Promise((resolve, reject) => {
    const contentType = request.headers["content-type"] || "";
    const match = contentType.match(/boundary=(?:"([^"]+)"|([^;]+))/i);
    if (!match) return reject(new Error("Missing multipart boundary"));
    const boundary = Buffer.from(`--${match[1] || match[2]}`);
    const chunks = [];
    let size = 0;
    request.on("data", (chunk) => {
      size += chunk.length;
      if (size > MAX_UPLOAD_SIZE) {
        request.destroy();
        return reject(new Error("Upload exceeds 100 MB"));
      }
      chunks.push(chunk);
    });
    request.on("end", () => {
      try {
        const buffer = Buffer.concat(chunks);
        const parts = splitBuffer(buffer, boundary);
        const fields = {};
        const files = [];
        for (const part of parts) {
          if (!part.length) continue;
          let body = part;
          if (body.subarray(0, 2).toString() === "\r\n") body = body.subarray(2);
          if (body.subarray(body.length - 2).toString() === "\r\n") body = body.subarray(0, body.length - 2);
          const separator = body.indexOf(Buffer.from("\r\n\r\n"));
          if (separator < 0) continue;
          const headers = body.subarray(0, separator).toString();
          const data = body.subarray(separator + 4);
          const nameMatch = headers.match(/name="([^"]+)"/);
          if (!nameMatch) continue;
          const name = nameMatch[1];
          const filenameMatch = headers.match(/filename="([^"]*)"/);
          if (filenameMatch) {
            if (filenameMatch[1]) files.push({ name, filename: filenameMatch[1], data });
          } else {
            fields[name] = data.toString("utf8");
          }
        }
        resolve({ fields, files });
      } catch (error) {
        reject(error);
      }
    });
  });
}

function splitBuffer(buffer, separator) {
  const result = [];
  let start = 0;
  while (true) {
    const index = buffer.indexOf(separator, start);
    if (index < 0) break;
    if (start > 0) result.push(buffer.subarray(start, index));
    start = index + separator.length;
  }
  return result;
}

function safeFilename(filename) {
  const base = path.basename(filename).replace(/[^a-zA-Z0-9._-]/g, "_");
  return `${Date.now()}-${Math.random().toString(36).slice(2, 8)}-${base}`;
}

function nextNumber(items) {
  return items.length ? Math.max(...items.map((item) => Number(item.number) || 0)) + 1 : 1;
}

function removeUploadedFile(item) {
  if (!item.filePath) return;
  const fullPath = path.resolve(UPLOAD_DIR, item.filePath);
  if (fullPath.startsWith(path.resolve(UPLOAD_DIR) + path.sep) && fs.existsSync(fullPath)) {
    fs.unlinkSync(fullPath);
  }
}

const server = http.createServer(async (request, response) => {
  const url = new URL(request.url, `http://${request.headers.host || "localhost"}`);
  const pathname = decodeURIComponent(url.pathname);

  if (pathname === "/api/items" && request.method === "GET") {
    return sendJson(response, 200, readItems());
  }

  if (pathname === "/api/items/text" && request.method === "POST") {
    try {
      const body = await parseJson(request);
      if (!body.name?.trim()) return sendJson(response, 400, { error: "Title is required" });
      const items = readItems();
      const item = {
        id: String(Date.now()),
        name: body.name.trim(),
        category: body.category?.trim() || "General",
        number: nextNumber(items),
        createdAt: Date.now(),
        updatedAt: Date.now(),
        mime: "text/plain",
        extension: "TEXT",
        type: "text",
        text: body.text || ""
      };
      items.push(item);
      writeItems(items);
      return sendJson(response, 201, item);
    } catch (error) {
      return sendJson(response, 400, { error: error.message });
    }
  }

  if (pathname === "/api/items/youtube" && request.method === "POST") {
    try {
      const body = await parseJson(request);
      const id = getYouTubeId(body.url || "");
      if (!id) return sendJson(response, 400, { error: "A valid YouTube link is required" });
      const items = readItems();
      const item = {
        id: String(Date.now()),
        name: body.name?.trim() || "YouTube video",
        category: body.category?.trim() || "General",
        number: nextNumber(items),
        createdAt: Date.now(),
        updatedAt: Date.now(),
        mime: "text/youtube",
        extension: "YOUTUBE",
        type: "youtube",
        youtubeId: id,
        url: body.url.trim()
      };
      items.push(item);
      writeItems(items);
      return sendJson(response, 201, item);
    } catch (error) {
      return sendJson(response, 400, { error: error.message });
    }
  }

  if (pathname === "/api/items/file" && request.method === "POST") {
    try {
      const { fields, files } = await parseMultipart(request);
      if (!files.length) return sendJson(response, 400, { error: "Choose at least one file" });
      const items = readItems();
      const created = [];
      for (const file of files) {
        const storedName = safeFilename(file.filename);
        fs.writeFileSync(path.join(UPLOAD_DIR, storedName), file.data);
        const item = {
          id: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
          name: fields.name?.trim() || file.filename,
          category: fields.category?.trim() || "General",
          number: nextNumber(items),
          createdAt: Date.now(),
          updatedAt: Date.now(),
          mime: getMime(file.filename),
          extension: path.extname(file.filename).slice(1).toUpperCase() || "FILE",
          type: "file",
          filePath: storedName,
          originalFilename: file.filename
        };
        items.push(item);
        created.push(item);
      }
      writeItems(items);
      return sendJson(response, 201, created);
    } catch (error) {
      return sendJson(response, 400, { error: error.message });
    }
  }

  if (pathname === "/api/items/reorder" && request.method === "PUT") {
    try {
      const body = await parseJson(request);
      if (!Array.isArray(body.ids)) return sendJson(response, 400, { error: "Item order is required" });
      const items = readItems();
      const byId = new Map(items.map((item) => [item.id, item]));
      const reordered = body.ids.map((id) => byId.get(id)).filter(Boolean);
      items.forEach((item) => {
        if (!body.ids.includes(item.id)) reordered.push(item);
      });
      reordered.forEach((item, index) => {
        item.number = index + 1;
        item.updatedAt = Date.now();
      });
      writeItems(reordered);
      return sendJson(response, 200, reordered);
    } catch (error) {
      return sendJson(response, 400, { error: error.message });
    }
  }

  const itemMatch = pathname.match(/^\/api\/items\/([^/]+)$/);
  if (itemMatch) {
    const id = itemMatch[1];
    if (request.method === "PUT") {
      try {
        const body = await parseJson(request);
        const items = readItems();
        const index = items.findIndex((item) => item.id === id);
        if (index < 0) return sendJson(response, 404, { error: "Item not found" });
        const item = items[index];
        item.name = body.name?.trim() || item.name;
        item.category = body.category?.trim() || "General";
        item.number = Number(body.number) || item.number;
        item.updatedAt = Date.now();
        if (item.type === "text") item.text = body.text || "";
        if (item.type === "youtube") {
          const youtubeId = getYouTubeId(body.url || item.url);
          if (!youtubeId) return sendJson(response, 400, { error: "A valid YouTube link is required" });
          item.youtubeId = youtubeId;
          item.url = body.url || item.url;
        }
        const requestedNumber = Number(body.number);
        if (requestedNumber > 0) {
          const sorted = items.sort((a, b) => a.number - b.number);
          const moved = sorted.findIndex((entry) => entry.id === id);
          if (moved >= 0) {
            sorted.splice(moved, 1);
            sorted.splice(Math.min(requestedNumber - 1, sorted.length), 0, item);
            sorted.forEach((entry, index) => { entry.number = index + 1; });
          }
        } else {
          const sorted = items.sort((a, b) => a.number - b.number);
          sorted.forEach((entry, index) => { entry.number = index + 1; });
        }
        writeItems(items);
        return sendJson(response, 200, item);
      } catch (error) {
        return sendJson(response, 400, { error: error.message });
      }
    }

    if (request.method === "DELETE") {
      const items = readItems();
      const item = items.find((entry) => entry.id === id);
      if (!item) return sendJson(response, 404, { error: "Item not found" });
      removeUploadedFile(item);
      const remaining = items.filter((entry) => entry.id !== id).sort((a, b) => a.number - b.number);
      remaining.forEach((entry, index) => { entry.number = index + 1; });
      writeItems(remaining);
      return sendJson(response, 200, { ok: true });
    }
  }

  if (pathname.startsWith("/uploads/")) {
    const filename = path.basename(pathname);
    return sendFile(response, path.join(UPLOAD_DIR, filename));
  }

  const relativePath = pathname === "/" ? "index.html" : pathname.replace(/^\/+/, "");
  const safePath = path.resolve(__dirname, relativePath);
  if (safePath.startsWith(__dirname + path.sep)) return sendFile(response, safePath);
  response.writeHead(404);
  response.end("Not found");
});

function getYouTubeId(url) {
  try {
    const parsed = new URL(url);
    const host = parsed.hostname.replace(/^www\./, "").replace(/^m\./, "");
    if (host === "youtu.be") return parsed.pathname.slice(1).split("/")[0];
    if (host === "youtube.com" || host.endsWith(".youtube.com")) {
      if (parsed.pathname === "/watch") return parsed.searchParams.get("v");
      const parts = parsed.pathname.split("/").filter(Boolean);
      if (["embed", "shorts", "live"].includes(parts[0])) return parts[1];
    }
  } catch {}
  return null;
}

function getMime(filename) {
  const extension = path.extname(filename).toLowerCase();
  const types = {
    ".pdf": "application/pdf", ".png": "image/png", ".jpg": "image/jpeg",
    ".jpeg": "image/jpeg", ".gif": "image/gif", ".webp": "image/webp",
    ".txt": "text/plain", ".mp4": "video/mp4", ".mp3": "audio/mpeg",
    ".aac": "audio/aac", ".doc": "application/msword",
    ".docx": "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    ".xls": "application/vnd.ms-excel",
    ".xlsx": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    ".ppt": "application/vnd.ms-powerpoint",
    ".pptx": "application/vnd.openxmlformats-officedocument.presentationml.presentation"
  };
  return types[extension] || "application/octet-stream";
}

server.listen(PORT, () => console.log(`My Library running at http://localhost:${PORT}`));
