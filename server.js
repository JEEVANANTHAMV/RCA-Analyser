import { createServer } from "node:http";
import { readFileSync, existsSync } from "node:fs";
import { join, dirname, parse } from "node:path";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

// `node server.js` does NOT auto-load .env the way `vite dev` does. Load it here,
// before importing the worker bundle (module-level code reads process.env at import time),
// so DATABASE_PATH, JWT_SECRET, AGENT_*, SMTP_*, etc. are populated in production.
const envPath = join(__dirname, ".env");
if (existsSync(envPath)) {
  process.loadEnvFile(envPath);
}

const distServer = join(__dirname, "dist", "server");
const distClient = join(__dirname, "dist", "client");

const indexPath = join(distServer, "index.js");
const serverPath = join(distServer, "server.js");
const workerEntry = existsSync(indexPath) ? indexPath : serverPath;

const { default: worker } = await import(workerEntry);

const MIME_TYPES = {
  ".html": "text/html; charset=utf-8",
  ".js": "application/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".svg": "image/svg+xml",
  ".ico": "image/x-icon",
  ".webp": "image/webp",
  ".avif": "image/avif",
  ".woff": "font/woff",
  ".woff2": "font/woff2",
  ".ttf": "font/ttf",
  ".txt": "text/plain",
  ".map": "application/json",
  ".wasm": "application/wasm",
};

function staticHandler(pathname) {
  if (pathname === "/") pathname = "/index.html";
  const filePath = join(distClient, pathname);
  if (!existsSync(filePath)) return null;
  const ext = parse(filePath).ext;
  const contentType = MIME_TYPES[ext] || "application/octet-stream";
  return {
    status: 200,
    headers: { "content-type": contentType },
    body: readFileSync(filePath),
  };
}

async function pipeWebStreamToNode(responseBody, nodeRes) {
  const reader = responseBody.getReader();
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      nodeRes.write(value);
    }
    nodeRes.end();
  } catch (e) {
    nodeRes.end();
  }
}

const server = createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host}`);
  const filePath = join(distClient, url.pathname);

  if (url.pathname.startsWith("/assets/") || existsSync(filePath)) {
    const staticRes = staticHandler(url.pathname);
    if (staticRes) {
      res.writeHead(staticRes.status, staticRes.headers);
      res.end(staticRes.body);
      return;
    }
  }

  const headers = new Headers();
  for (const [key, value] of Object.entries(req.headers)) {
    if (value) {
      if (Array.isArray(value)) headers.set(key, value.join(", "));
      else headers.set(key, value);
    }
  }
  headers.set("x-forwarded-proto", req.socket.encrypted ? "https" : "http");

  let body = undefined;
  if (req.method !== "GET" && req.method !== "HEAD") {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    body = Buffer.concat(chunks);
  }

  const request = new Request(url.href, {
    method: req.method,
    headers,
    body,
    duplex: "half",
  });

  const response = await worker.fetch(request);

  res.writeHead(response.status, Object.fromEntries(response.headers.entries()));

  if (response.body) {
    await pipeWebStreamToNode(response.body, res);
  } else {
    res.end();
  }
});

const PORT = process.env.PORT || 8080;
server.listen(PORT, "0.0.0.0", () => {
  console.log(`Server running on http://0.0.0.0:${PORT}`);
});