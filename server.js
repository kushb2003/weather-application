"use strict";
// Minimal dependency-free server: serves the static weather app and proxies
// weather lookups to OpenWeatherMap so the API key stays server-side.
// Usage: OWM_API_KEY=<key> node server.js   (optional: PORT=3000)
const http = require("http");
const https = require("https");
const fs = require("fs");
const path = require("path");

const OWM_API_KEY = process.env.OWM_API_KEY;
if (!OWM_API_KEY) {
  console.error("OWM_API_KEY environment variable is required");
  process.exit(1);
}
const PORT = Number(process.env.PORT) || 3000;
const ROOT = __dirname;

const RATE_LIMIT_WINDOW_MS = 60 * 1000;
const RATE_LIMIT_MAX = 30;
const MAX_UPSTREAM_BYTES = 1024 * 1024;
const hits = new Map();

function rateLimited(ip) {
  const now = Date.now();
  let entry = hits.get(ip);
  if (!entry || now - entry.start >= RATE_LIMIT_WINDOW_MS) {
    entry = { start: now, count: 0 };
    hits.set(ip, entry);
  }
  entry.count++;
  return entry.count > RATE_LIMIT_MAX;
}

setInterval(() => {
  const now = Date.now();
  for (const [ip, entry] of hits) {
    if (now - entry.start >= RATE_LIMIT_WINDOW_MS) hits.delete(ip);
  }
}, RATE_LIMIT_WINDOW_MS).unref();

const MIME = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".svg": "image/svg+xml",
  ".ico": "image/x-icon"
};

function sendJson(res, status, obj) {
  if (res.headersSent) {
    res.end();
    return;
  }
  res.writeHead(status, { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" });
  res.end(JSON.stringify(obj));
}

function handleWeather(req, res, url) {
  const ip = req.socket.remoteAddress || "unknown";
  if (rateLimited(ip)) {
    sendJson(res, 429, { message: "Too many requests" });
    return;
  }
  const q = url.searchParams.get("q");
  if (typeof q !== "string" || q.trim() === "" || q.length > 100) {
    sendJson(res, 400, { message: "Invalid city" });
    return;
  }
  const upstream = new URL("https://api.openweathermap.org/data/2.5/weather");
  upstream.searchParams.set("units", "metric");
  upstream.searchParams.set("q", q);
  upstream.searchParams.set("appid", OWM_API_KEY);

  let finished = false;
  const upReq = https.get(upstream, { timeout: 10000 }, (upRes) => {
    let body = "";
    upRes.setEncoding("utf8");
    upRes.on("data", (chunk) => {
      body += chunk;
      if (body.length > MAX_UPSTREAM_BYTES) {
        upReq.destroy(new Error("Upstream response too large"));
      }
    });
    upRes.on("end", () => {
      if (finished) return;
      finished = true;
      res.writeHead(upRes.statusCode || 502, { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" });
      res.end(body);
    });
  });
  upReq.on("timeout", () => {
    upReq.destroy(new Error("Upstream timeout"));
  });
  upReq.on("error", () => {
    if (finished) return;
    finished = true;
    sendJson(res, 502, { message: "Weather service unavailable" });
  });
}

function serveStatic(req, res, url) {
  let pathname;
  try {
    pathname = decodeURIComponent(url.pathname);
  } catch (e) {
    res.writeHead(400);
    res.end();
    return;
  }
  if (pathname === "/") pathname = "/index.html";
  if (pathname.includes("\0")) {
    res.writeHead(400);
    res.end();
    return;
  }
  const filePath = path.resolve(ROOT, "." + path.posix.normalize(pathname));
  const rel = path.relative(ROOT, filePath);
  const ext = path.extname(filePath).toLowerCase();
  if (
    rel === "" ||
    rel.startsWith("..") ||
    path.isAbsolute(rel) ||
    rel.split(path.sep).some((seg) => seg.startsWith(".")) ||
    rel === "server.js" ||
    !Object.prototype.hasOwnProperty.call(MIME, ext)
  ) {
    res.writeHead(404);
    res.end("Not found");
    return;
  }
  fs.readFile(filePath, (err, data) => {
    if (err) {
      res.writeHead(404);
      res.end("Not found");
      return;
    }
    res.writeHead(200, { "Content-Type": MIME[ext] });
    res.end(data);
  });
}

const server = http.createServer((req, res) => {
  let url;
  try {
    url = new URL(req.url, "http://localhost");
  } catch (e) {
    res.writeHead(400);
    res.end();
    return;
  }
  if (req.method !== "GET" && req.method !== "HEAD") {
    res.writeHead(405, { Allow: "GET, HEAD" });
    res.end();
    return;
  }
  if (url.pathname === "/api/weather") {
    if (req.method !== "GET") {
      res.writeHead(405, { Allow: "GET" });
      res.end();
      return;
    }
    handleWeather(req, res, url);
    return;
  }
  serveStatic(req, res, url);
});

server.listen(PORT, () => {
  console.log("Weather app listening on port " + PORT);
});
