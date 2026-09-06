// server.js
// ============================================================
// Wildfire Backend Proxy
// GISTDA VIIRS + Alert Endpoint
//
// ระบบเลือกข้อมูลล่าสุดอัตโนมัติ:
//
// 1. ลอง VIIRS 1day
// 2. ถ้าไม่มีข้อมูล -> 3days
// 3. ถ้ายังไม่มี -> 7days
// 4. หา acq_date ที่ใหม่ที่สุด
// 5. ส่งเฉพาะจุดของวันที่ใหม่ที่สุดกลับหน้าเว็บ
//
// API Key เก็บไว้ใน .env
// ============================================================

require("dotenv").config({
  path: require("path").join(__dirname, ".env")
});

const express = require("express");
const cors = require("cors");
const crypto = require("crypto");

const app = express();

const PORT = process.env.PORT || 3000;

const GISTDA_API_KEY =
  process.env.GISTDA_API_KEY || "";

// ============================================================
// AUTH + LINE
// ============================================================
const AUTH_SECRET =
  process.env.AUTH_SECRET || crypto.randomBytes(32).toString("hex");

const OFFICER_USERNAME =
  process.env.OFFICER_USERNAME || "officer";
const OFFICER_PASSWORD =
  process.env.OFFICER_PASSWORD || "";
const DEMO_USERNAME =
  process.env.DEMO_USERNAME || "demo";
const DEMO_PASSWORD =
  process.env.DEMO_PASSWORD || "";

const LINE_CHANNEL_ACCESS_TOKEN =
  process.env.LINE_CHANNEL_ACCESS_TOKEN || "";
const LINE_TO =
  process.env.LINE_TO || "";

let lastLineAlertKey = null;

// ============================================================
// GISTDA
// ============================================================

const GISTDA_BASE_URL =
  "https://api-gateway.gistda.or.th/api/2.0/resources/features/viirs";

const GISTDA_ENDPOINTS = [
  {
    name: "1day",
    path: `${GISTDA_BASE_URL}/1day`
  },
  {
    name: "3days",
    path: `${GISTDA_BASE_URL}/3days`
  },
  {
    name: "7days",
    path: `${GISTDA_BASE_URL}/7days`
  }
];

// ============================================================
// Middleware
// ============================================================

app.use(cors());

app.use(
  express.json({
    limit: "1mb"
  })
);

// ============================================================
// หน้าแรก
// ============================================================

app.use(express.static(__dirname));

app.get("/", (req, res) => {
  res.sendFile(
    require("path").join(__dirname, "index.html")
  );
});

// ============================================================
// Simple signed login session (no database required)
// ============================================================
function makeSession(role) {
  const payload = Buffer.from(JSON.stringify({
    role,
    exp: Date.now() + 8 * 60 * 60 * 1000
  })).toString("base64url");

  const sig = crypto
    .createHmac("sha256", AUTH_SECRET)
    .update(payload)
    .digest("base64url");

  return `${payload}.${sig}`;
}

function readSession(req) {
  const raw = req.headers.cookie || "";
  const match = raw.match(/(?:^|;\\s*)fw_session=([^;]+)/);

  if (!match) return null;

  const token = decodeURIComponent(match[1]);
  const [payload, sig] = token.split(".");
  if (!payload || !sig) return null;

  const expected = crypto
    .createHmac("sha256", AUTH_SECRET)
    .update(payload)
    .digest("base64url");

  if (sig.length !== expected.length) return null;

  if (!crypto.timingSafeEqual(
    Buffer.from(sig),
    Buffer.from(expected)
  )) return null;

  try {
    const data = JSON.parse(
      Buffer.from(payload, "base64url").toString("utf8")
    );
    if (!data.exp || Date.now() > data.exp) return null;
    return data;
  } catch {
    return null;
  }
}

function requireRole(...roles) {
  return (req, res, next) => {
    const session = readSession(req);
    if (!session || !roles.includes(session.role)) {
      return res.status(401).json({
        ok: false,
        error: "Unauthorized"
      });
    }
    req.session = session;
    next();
  };
}

app.post("/api/login", (req, res) => {
  const role = String(req.body?.role || "public");
  const username = String(req.body?.username || "").trim();
  const password = String(req.body?.password || "");

  if (role === "public") {
    const token = makeSession("public");
    res.setHeader(
      "Set-Cookie",
      `fw_session=${encodeURIComponent(token)}; Path=/; HttpOnly; SameSite=Lax; Max-Age=28800`
    );
    return res.json({ ok: true, role: "public" });
  }

  if (
    role === "officer" &&
    OFFICER_PASSWORD &&
    username === OFFICER_USERNAME &&
    password === OFFICER_PASSWORD
  ) {
    const token = makeSession("officer");
    res.setHeader(
      "Set-Cookie",
      `fw_session=${encodeURIComponent(token)}; Path=/; HttpOnly; SameSite=Lax; Max-Age=28800`
    );
    return res.json({ ok: true, role: "officer" });
  }

  if (
    role === "demo" &&
    DEMO_PASSWORD &&
    username === DEMO_USERNAME &&
    password === DEMO_PASSWORD
  ) {
    const token = makeSession("demo");
    res.setHeader(
      "Set-Cookie",
      `fw_session=${encodeURIComponent(token)}; Path=/; HttpOnly; SameSite=Lax; Max-Age=28800`
    );
    return res.json({ ok: true, role: "demo" });
  }

  return res.status(401).json({
    ok: false,
    error: "ชื่อผู้ใช้หรือรหัสผ่านไม่ถูกต้อง หรือยังไม่ได้ตั้งค่าใน Render"
  });
});

app.post("/api/logout", (req, res) => {
  res.setHeader(
    "Set-Cookie",
    "fw_session=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0"
  );
  res.json({ ok: true });
});

app.get("/api/me", (req, res) => {
  const session = readSession(req);
  res.json({
    ok: true,
    loggedIn: Boolean(session),
    role: session?.role || null
  });
});

// ============================================================
// LINE Messaging API
// ============================================================
async function sendLineText(text) {
  if (!LINE_CHANNEL_ACCESS_TOKEN || !LINE_TO) {
    return {
      ok: false,
      skipped: true,
      reason: "LINE environment variables are not configured"
    };
  }

  try {
    const response = await fetch(
      "https://api.line.me/v2/bot/message/push",
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Authorization": `Bearer ${LINE_CHANNEL_ACCESS_TOKEN}`
        },
        body: JSON.stringify({
          to: LINE_TO,
          messages: [
            {
              type: "text",
              text: String(text).slice(0, 5000)
            }
          ]
        })
      }
    );

    const body = await response.text();
    if (!response.ok) {
      console.error("LINE API ERROR:", response.status, body);
      return { ok: false, status: response.status, body };
    }

    return { ok: true };
  } catch (error) {
    console.error("LINE SEND ERROR:", error.message);
    return { ok: false, error: error.message };
  }
}

function makeFireLineMessage(fire) {
  const mapUrl =
    `https://www.google.com/maps/dir/?api=1&destination=${encodeURIComponent(fire.lat)},${encodeURIComponent(fire.lng)}`;

  return [
    "🚨 FIRE WATCH ALERT 🚨",
    "",
    "🔥 ตรวจพบจุดความร้อน",
    `📍 จังหวัด: ${fire.province || "-"}`,
    `📏 ระยะห่าง: ${Number(fire.distance_km).toFixed(2)} km`,
    `📅 วันที่: ${fire.date || "-"}`,
    `🕐 เวลา: ${fire.time || "-"}`,
    `📡 แหล่งข้อมูล: ${fire.source || "GISTDA VIIRS"}`,
    "",
    `🧭 นำทาง: ${mapUrl}`
  ].join("\\n");
}

app.post(
  "/api/line/test",
  requireRole("officer", "demo"),
  async (req, res) => {
    const result = await sendLineText(
      "🧪 FIRE WATCH TEST\nระบบ LINE แจ้งเตือนทำงานแล้ว"
    );
    res.status(result.ok ? 200 : 502).json(result);
  }
);

// ============================================================
// Health Check
// ============================================================

app.get("/health", (req, res) => {
  res.json({
    ok: true,
    gistdaKeyConfigured: Boolean(GISTDA_API_KEY),
    service: "GISTDA VIIRS Proxy"
  });
});

// ============================================================
// ฟังก์ชันเรียก GISTDA
// ============================================================

async function fetchGistdaData(
  endpoint,
  limit,
  offset,
  country
) {

  const target =
    new URL(endpoint.path);

  target.search =
    new URLSearchParams({
      limit: String(limit),
      offset: String(offset),
      ct_tn: String(country)
    }).toString();

  console.log("");
  console.log("======================================");
  console.log("GISTDA REQUEST");
  console.log("======================================");

  console.log(
    "Dataset:",
    endpoint.name
  );

  console.log(
    "URL:",
    target.origin + target.pathname
  );

  console.log(
    "limit:",
    limit
  );

  console.log(
    "offset:",
    offset
  );

  console.log(
    "country:",
    country
  );

  try {

    const response =
      await fetch(
        target,
        {
          method: "GET",

          headers: {
            "Accept":
              "application/geo+json, application/json",

            "API-Key":
              GISTDA_API_KEY
          }
        }
      );

    const text =
      await response.text();

    console.log(
      "GISTDA HTTP:",
      response.status
    );

    if (!response.ok) {

      console.error(
        "GISTDA ERROR:",
        text
      );

      return {
        ok: false,
        status: response.status,
        text
      };

    }

    let data;

    try {

      data =
        JSON.parse(text);

    } catch {

      return {
        ok: false,
        status: 502,
        text:
          "GISTDA returned invalid JSON"
      };

    }

    return {
      ok: true,
      status: response.status,
      data
    };

  } catch (error) {

    console.error(
      "GISTDA fetch error:",
      error.message
    );

    return {
      ok: false,
      status: 502,
      error: error.message
    };

  }
}

// ============================================================
// ดึง Features
// ============================================================

function getFeatures(data) {

  if (
    data &&
    Array.isArray(data.features)
  ) {
    return data.features;
  }

  return [];
}

// ============================================================
// หา วันที่ล่าสุด
// ============================================================

function getLatestDate(features) {

  const dates =
    features
      .map(feature => {

        const properties =
          feature &&
          feature.properties
            ? feature.properties
            : {};

        return (
          properties.acq_date ||
          properties.th_date ||
          null
        );

      })
      .filter(Boolean)
      .map(date => {

        // รองรับทั้ง
        // 2026-09-03
        // 2026-09-03T00:00:00

        return String(date)
          .substring(0, 10);

      });

  if (!dates.length) {
    return null;
  }

  dates.sort();

  return dates[dates.length - 1];
}

// ============================================================
// กรองเฉพาะวันที่ล่าสุด
// ============================================================

function filterLatestDate(
  features,
  latestDate
) {

  if (!latestDate) {
    return features;
  }

  return features.filter(feature => {

    const properties =
      feature &&
      feature.properties
        ? feature.properties
        : {};

    const date =
      properties.acq_date ||
      properties.th_date ||
      "";

    return String(date)
      .substring(0, 10) === latestDate;

  });
}

// ============================================================
// GISTDA API
// ============================================================

app.get(
  "/api/gistda",
  async (req, res) => {

    // --------------------------------------------------------
    // ตรวจ API Key
    // --------------------------------------------------------

    if (!GISTDA_API_KEY) {

      return res.status(500).json({
        error:
          "GISTDA_API_KEY is not configured on backend"
      });

    }

    // --------------------------------------------------------
    // Parameters
    // --------------------------------------------------------

    const requestedLimit =
      Number(req.query.limit || 1000);

    const requestedOffset =
      Number(req.query.offset || 0);

    const country =
      req.query.ct_tn ||
      "ราชอาณาจักรไทย";

    // จำกัดค่าเพื่อป้องกัน request แปลก ๆ
    const limit =
      Number.isFinite(requestedLimit) &&
      requestedLimit > 0
        ? Math.min(requestedLimit, 5000)
        : 1000;

    const offset =
      Number.isFinite(requestedOffset) &&
      requestedOffset >= 0
        ? requestedOffset
        : 0;

    // --------------------------------------------------------
    // ถ้าหน้าเว็บส่ง apiUrl มา
    //
    // เราจะไม่ยอมให้เปลี่ยน host
    // และจะใช้เฉพาะ path VIIRS ที่กำหนดไว้
    // --------------------------------------------------------

    console.log("");
    console.log(
      "######################################"
    );

    console.log(
      "AUTO LATEST VIIRS MODE"
    );

    console.log(
      "######################################"
    );

    // --------------------------------------------------------
    // ลอง 1day -> 3days -> 7days
    // --------------------------------------------------------

    let selectedDataset = null;
    let selectedData = null;
    let lastError = null;

    for (
      const endpoint of GISTDA_ENDPOINTS
    ) {

      console.log("");
      console.log(
        "Trying dataset:",
        endpoint.name
      );

      const result =
        await fetchGistdaData(
          endpoint,
          limit,
          offset,
          country
        );

      if (!result.ok) {

        lastError =
          result.error ||
          result.text ||
          "Unknown GISTDA error";

        console.log(
          "Dataset failed:",
          endpoint.name
        );

        continue;
      }

      const features =
        getFeatures(result.data);

      console.log(
        "Features received:",
        features.length
      );

      // ------------------------------------------------------
      // ถ้ามีข้อมูล ให้ใช้ชุดนี้
      // ------------------------------------------------------

      if (features.length > 0) {

        selectedDataset =
          endpoint.name;

        selectedData =
          result.data;

        break;

      }

      console.log(
        "No data in:",
        endpoint.name
      );

    }

    // --------------------------------------------------------
    // ถ้าทุก dataset ไม่มีข้อมูล
    // --------------------------------------------------------

    if (!selectedData) {

      console.log("");
      console.log(
        "No VIIRS data found"
      );

      return res.json({

        type:
          "FeatureCollection",

        features: [],

        links: [],

        numberMatched: 0,

        numberReturned: 0,

        latestDate: null,

        dataset: null,

        message:
          "No VIIRS hotspot data available"

      });

    }

    // --------------------------------------------------------
    // Features
    // --------------------------------------------------------

    const allFeatures =
      getFeatures(selectedData);

    // --------------------------------------------------------
    // หา latest date
    // --------------------------------------------------------

    const latestDate =
      getLatestDate(
        allFeatures
      );

    console.log("");
    console.log(
      "Selected dataset:",
      selectedDataset
    );

    console.log(
      "Latest acquisition date:",
      latestDate
    );

    console.log(
      "Total features:",
      allFeatures.length
    );

    // --------------------------------------------------------
    // กรองเฉพาะวันที่ล่าสุด
    // --------------------------------------------------------

    const latestFeatures =
      filterLatestDate(
        allFeatures,
        latestDate
      );

    console.log(
      "Latest-date features:",
      latestFeatures.length
    );

    // --------------------------------------------------------
    // ส่งกลับหน้าเว็บ
    // --------------------------------------------------------

    return res.json({

      type:
        "FeatureCollection",

      features:
        latestFeatures,

      links:
        selectedData.links ||
        [],

      numberMatched:
        latestFeatures.length,

      numberReturned:
        latestFeatures.length,

      latestDate:
        latestDate,

      dataset:
        selectedDataset,

      source:
        "GISTDA VIIRS",

      timeStamp:
        selectedData.timeStamp ||
        new Date().toISOString()

    });

  }
);

// ============================================================
// Endpoint ดูข้อมูลดิบจาก dataset ที่ระบุ
//
// ตัวอย่าง:
//
// /api/gistda/raw?days=3
// /api/gistda/raw?days=7
//
// ใช้สำหรับตรวจสอบระบบ
// ============================================================

app.get(
  "/api/gistda/raw",
  async (req, res) => {

    if (!GISTDA_API_KEY) {

      return res.status(500).json({
        error:
          "GISTDA_API_KEY is not configured on backend"
      });

    }

    const days =
      String(
        req.query.days || "3"
      );

    let endpoint =
      GISTDA_ENDPOINTS.find(
        item =>
          item.name ===
          `${days}day` ||
          item.name ===
          `${days}days`
      );

    if (!endpoint) {

      endpoint =
        GISTDA_ENDPOINTS.find(
          item =>
            item.name === "3days"
        );

    }

    const limit =
      Number(req.query.limit || 100);

    const offset =
      Number(req.query.offset || 0);

    const country =
      req.query.ct_tn ||
      "ราชอาณาจักรไทย";

    const result =
      await fetchGistdaData(
        endpoint,
        limit,
        offset,
        country
      );

    if (!result.ok) {

      return res.status(
        result.status || 502
      ).json({
        error:
          result.error ||
          result.text ||
          "GISTDA request failed"
      });

    }

    return res.json(
      result.data
    );

  }
);

// ============================================================
// ESP32 STATUS API
// ESP32 polls Render over HTTPS; no local IP is required.
// ============================================================
function haversineKm(lat1, lon1, lat2, lon2) {
  const R = 6371;
  const dLat = (lat2 - lat1) * Math.PI / 180;
  const dLon = (lon2 - lon1) * Math.PI / 180;
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(lat1 * Math.PI / 180) *
    Math.cos(lat2 * Math.PI / 180) *
    Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(a));
}

app.get("/api/esp32/status", async (req, res) => {
  const lat = Number(req.query.lat ?? 19.9105);
  const lng = Number(req.query.lng ?? 99.8406);
  const radius = Number(req.query.radius ?? 20);
  const country = req.query.ct_tn || "ราชอาณาจักรไทย";

  if (![lat, lng, radius].every(Number.isFinite) || radius <= 0) {
    return res.status(400).json({
      ok: false,
      error: "Invalid lat/lng/radius"
    });
  }

  let selected = null;

  for (const endpoint of GISTDA_ENDPOINTS) {
    const result = await fetchGistdaData(
      endpoint,
      1000,
      0,
      country
    );

    if (!result.ok) continue;

    const features = getFeatures(result.data);
    if (features.length) {
      selected = {
        endpoint,
        features
      };
      break;
    }
  }

  if (!selected) {
    return res.json({
      ok: true,
      fire: false,
      distance_km: null,
      lat: null,
      lng: null,
      province: null,
      date: null,
      time: null,
      source: "GISTDA VIIRS",
      dataset: null,
      latestDate: null
    });
  }

  const latestDate = getLatestDate(selected.features);
  const latestFeatures = selected.features.filter(feature => {
    const props = feature?.properties || {};
    const date = String(
      props.acq_date || props.th_date || ""
    ).substring(0, 10);
    return !latestDate || date === latestDate;
  });

  let nearest = null;

  for (const feature of latestFeatures) {
    const coords = feature?.geometry?.coordinates;
    const props = feature?.properties || {};

    if (!Array.isArray(coords) || coords.length < 2) continue;

    const fireLng = Number(coords[0]);
    const fireLat = Number(coords[1]);
    if (!Number.isFinite(fireLat) || !Number.isFinite(fireLng)) continue;

    const distance = haversineKm(
      lat,
      lng,
      fireLat,
      fireLng
    );

    if (
      distance <= radius &&
      (!nearest || distance < nearest.distance_km)
    ) {
      nearest = {
        distance_km: distance,
        lat: fireLat,
        lng: fireLng,
        province:
          props.changwat ||
          props.province ||
          props.changwat_t ||
          "-",
        date:
          props.acq_date ||
          latestDate ||
          "-",
        time:
          props.acq_time ||
          "-"
      };
    }
  }

  const payload = {
    ok: true,
    fire: Boolean(nearest),
    distance_km: nearest ? Number(nearest.distance_km.toFixed(3)) : null,
    lat: nearest?.lat ?? null,
    lng: nearest?.lng ?? null,
    province: nearest?.province ?? null,
    date: nearest?.date ?? latestDate ?? null,
    time: nearest?.time ?? null,
    source: "GISTDA VIIRS",
    dataset: selected.endpoint.name,
    latestDate
  };

  // Send LINE only once for the same detected hotspot.
  if (nearest) {
    const alertKey = [
      latestDate,
      nearest.lat.toFixed(5),
      nearest.lng.toFixed(5)
    ].join("|");

    if (alertKey !== lastLineAlertKey) {
      lastLineAlertKey = alertKey;
      sendLineText(
        makeFireLineMessage({
          ...nearest,
          source: "GISTDA VIIRS"
        })
      ).catch(() => {});
    }
  } else {
    lastLineAlertKey = null;
  }

  return res.json(payload);
});

// Demo notification for competition mode.
app.post(
  "/api/demo/alert",
  requireRole("demo", "officer"),
  async (req, res) => {
    const lat = Number(req.body?.lat ?? 19.9105);
    const lng = Number(req.body?.lng ?? 99.8406);
    const distance = Number(req.body?.distance_km ?? 2);

    const result = await sendLineText([
      "🧪 FIRE WATCH DEMO",
      "",
      "🔥 จำลองเหตุการณ์ไฟป่า",
      `📍 ${lat.toFixed(6)}, ${lng.toFixed(6)}`,
      `📏 ระยะจำลอง: ${distance.toFixed(2)} km`,
      "",
      "ข้อมูลนี้เป็น DEMO สำหรับการนำเสนอ/การแข่งขัน"
    ].join("\\n"));

    res.status(result.ok ? 200 : 502).json(result);
  }
);

// ============================================================
// รับ Alert จากหน้าเว็บ / ESP32
// ============================================================

app.post(
  "/api/alert",
  (req, res) => {

    console.log("");
    console.log(
      "======================================"
    );

    console.log(
      "ALERT RECEIVED"
    );

    console.log(
      "======================================"
    );

    console.log(
      JSON.stringify(
        req.body,
        null,
        2
      )
    );

    res.json({

      ok: true,

      received:
        req.body

    });

  }
);

// ============================================================
// Error Handler
// ============================================================

app.use(
  (
    err,
    req,
    res,
    next
  ) => {

    console.error(
      "SERVER ERROR:",
      err
    );

    res.status(500).json({

      error:
        "Internal server error",

      detail:
        err.message

    });

  }
);

// ============================================================
// Start Server
// ============================================================

app.listen(
  PORT,
  () => {

    console.log("");
    console.log(
      "======================================"
    );

    console.log(
      "Wildfire Backend Proxy"
    );

    console.log(
      "======================================"
    );

    console.log(
      `Backend running on port ${PORT}`
    );

    console.log(
      `GISTDA key configured: ${Boolean(
        GISTDA_API_KEY
      )}`
    );

    console.log(
      "VIIRS auto latest mode: ENABLED"
    );

    console.log(
      "Fallback datasets: 1day -> 3days -> 7days"
    );

    console.log(
      `LINE configured: ${Boolean(LINE_CHANNEL_ACCESS_TOKEN && LINE_TO)}`
    );

    console.log(
      `Officer login configured: ${Boolean(OFFICER_PASSWORD)}`
    );

    console.log(
      `Demo login configured: ${Boolean(DEMO_PASSWORD)}`
    );

    console.log(
      "======================================"
    );

  }
);