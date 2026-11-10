"use strict";

// Minimal dependency-free server: serves the static weather app and proxies
// weather lookups to OpenWeatherMap, adding the API key server-side so it is
// never delivered to the browser.
//
// Usage: OWM_API_KEY=<your key> node server.js   (optional: PORT=3000)

const http = require("http");
const https = require("https");
const fs = require("fs");
const path = require("path");

const PORT = Number(process.env.PORT) || 3000;
const ROOT = __dirname;
const OWM_API_KEY = process.env.OWM_API_KEY;
const OWM_ENDPOINT = "https://api.openweathermap.org/data/2.5/weather";
const MAX_CITY_LENGTH = 100;

const MIME_TYPES = {
    ".html": "text/html; charset=utf-8",
    ".css": "text/css; charset=utf-8",
    ".js": "application/javascript; charset=utf-8",
    ".png": "image/png",
    ".jpg": "image/jpeg",
    ".jpeg": "image/jpeg",
    ".gif": "image/gif",
    ".svg": "image/svg+xml",
    ".webp": "image/webp",
    ".ico": "image/x-icon",
    ".woff": "font/woff",
    ".woff2": "font/woff2"
};

// Server-side files that must never be served to clients.
const BLOCKED_FILES = new Set(["server.js", "package.json", "package-lock.json"]);

function sendJson(res, status, obj) {
    if (res.headersSent) {
        res.end();
        return;
    }
    res.writeHead(status, {
        "Content-Type": "application/json; charset=utf-8",
        "Cache-Control": "no-store"
    });
    res.end(JSON.stringify(obj));
}

function sendText(res, status, text) {
    res.writeHead(status, { "Content-Type": "text/plain; charset=utf-8" });
    res.end(text);
}

function handleWeather(reqUrl, res) {
    if (!OWM_API_KEY) {
        // Fail closed: never call the provider without server-side configuration.
        sendJson(res, 500, { message: "Weather service is not configured" });
        return;
    }

    const city = reqUrl.searchParams.get("q");
    if (typeof city !== "string" || city.trim() === "" || city.length > MAX_CITY_LENGTH) {
        sendJson(res, 400, { message: "Invalid city name" });
        return;
    }

    const upstream = new URL(OWM_ENDPOINT);
    upstream.searchParams.set("units", "metric");
    upstream.searchParams.set("q", city);
    upstream.searchParams.set("appid", OWM_API_KEY);

    const upReq = https.get(upstream, { timeout: 10000 }, (upRes) => {
        const chunks = [];
        upRes.on("data", (chunk) => chunks.push(chunk));
        upRes.on("end", () => {
            if (res.headersSent) {
                res.end();
                return;
            }
            res.writeHead(upRes.statusCode || 502, {
                "Content-Type": "application/json; charset=utf-8",
                "Cache-Control": "no-store"
            });
            res.end(Buffer.concat(chunks));
        });
        upRes.on("error", () => sendJson(res, 502, { message: "Weather service unavailable" }));
    });

    upReq.on("timeout", () => upReq.destroy(new Error("Upstream timeout")));
    upReq.on("error", () => sendJson(res, 502, { message: "Weather service unavailable" }));
}

function serveStatic(reqUrl, req, res) {
    let pathname;
    try {
        pathname = decodeURIComponent(reqUrl.pathname);
    } catch (e) {
        sendText(res, 400, "Bad request");
        return;
    }
    if (pathname.indexOf("\0") !== -1) {
        sendText(res, 400, "Bad request");
        return;
    }
    if (pathname === "/") {
        pathname = "/index.html";
    }

    const filePath = path.resolve(ROOT, "." + pathname);
    const rel = path.relative(ROOT, filePath);
    if (
        rel === "" ||
        rel.startsWith("..") ||
        path.isAbsolute(rel) ||
        rel.split(path.sep).some((segment) => segment.startsWith(".")) ||
        BLOCKED_FILES.has(rel)
    ) {
        sendText(res, 404, "Not found");
        return;
    }

    const type = MIME_TYPES[path.extname(filePath).toLowerCase()];
    if (!type) {
        sendText(res, 404, "Not found");
        return;
    }

    fs.readFile(filePath, (err, data) => {
        if (err) {
            sendText(res, 404, "Not found");
            return;
        }
        res.writeHead(200, { "Content-Type": type });
        res.end(req.method === "HEAD" ? undefined : data);
    });
}

const server = http.createServer((req, res) => {
    if (req.method !== "GET" && req.method !== "HEAD") {
        res.writeHead(405, { "Allow": "GET, HEAD" });
        res.end();
        return;
    }

    let reqUrl;
    try {
        reqUrl = new URL(req.url, "http://localhost");
    } catch (e) {
        sendText(res, 400, "Bad request");
        return;
    }

    if (reqUrl.pathname === "/api/weather") {
        handleWeather(reqUrl, res);
        return;
    }

    serveStatic(reqUrl, req, res);
});

if (!OWM_API_KEY) {
    console.warn("OWM_API_KEY is not set; /api/weather will return 500 until it is configured.");
}

server.listen(PORT, () => {
    console.log("Weather app listening on http://localhost:" + PORT);
});
