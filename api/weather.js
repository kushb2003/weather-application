// Server-side proxy for OpenWeatherMap. The API key never reaches the browser.
// Requires Node 18+ (global fetch) and the OPENWEATHER_API_KEY environment variable.

const UPSTREAM = "https://api.openweathermap.org/data/2.5/weather";
const CITY_PATTERN = /^[\p{L}\p{M} .,'-]{1,100}$/u;
const WINDOW_MS = 60 * 1000;
const MAX_REQUESTS_PER_WINDOW = 30;
const hits = new Map();

function send(res, status, body) {
    res.statusCode = status;
    res.setHeader("Content-Type", "application/json");
    res.setHeader("Cache-Control", "no-store");
    res.end(JSON.stringify(body));
}

function clientId(req) {
    const fwd = req.headers && req.headers["x-forwarded-for"];
    if (typeof fwd === "string" && fwd.length > 0) {
        return fwd.split(",")[0].trim();
    }
    return (req.socket && req.socket.remoteAddress) || "unknown";
}

function rateLimited(id) {
    const now = Date.now();
    for (const [key, entry] of hits) {
        if (now - entry.start > WINDOW_MS) {
            hits.delete(key);
        }
    }
    const entry = hits.get(id);
    if (!entry) {
        hits.set(id, { start: now, count: 1 });
        return false;
    }
    entry.count += 1;
    return entry.count > MAX_REQUESTS_PER_WINDOW;
}

module.exports = async function handler(req, res) {
    if (req.method !== "GET") {
        res.setHeader("Allow", "GET");
        return send(res, 405, { error: "Method not allowed" });
    }

    const apiKey = process.env.OPENWEATHER_API_KEY;
    if (typeof apiKey !== "string" || apiKey.length === 0) {
        return send(res, 500, { error: "Weather service is not configured" });
    }

    if (rateLimited(clientId(req))) {
        res.setHeader("Retry-After", String(Math.ceil(WINDOW_MS / 1000)));
        return send(res, 429, { error: "Too many requests" });
    }

    let city;
    try {
        city = new URL(req.url, "http://localhost").searchParams.get("city");
    } catch (e) {
        return send(res, 400, { error: "Invalid request" });
    }
    if (typeof city !== "string" || !CITY_PATTERN.test(city.trim())) {
        return send(res, 400, { error: "Invalid city" });
    }

    const url = UPSTREAM + "?units=metric&q=" + encodeURIComponent(city.trim()) +
        "&appid=" + encodeURIComponent(apiKey);

    let upstream;
    let data;
    try {
        upstream = await fetch(url);
        data = await upstream.json();
    } catch (e) {
        return send(res, 502, { error: "Weather service unavailable" });
    }

    if (!upstream.ok || !data || !data.main || !data.wind || !Array.isArray(data.weather) || data.weather.length === 0) {
        return send(res, upstream.status === 404 ? 404 : 502, { error: "City not found" });
    }

    return send(res, 200, {
        name: data.name,
        main: { temp: data.main.temp, humidity: data.main.humidity },
        wind: { speed: data.wind.speed },
        weather: [{ main: data.weather[0].main }]
    });
};
