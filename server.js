// server.js
// Fire Watch Backend
// GISTDA VIIRS + Login Roles + LINE Alert + ESP32 Multi-Board + DEMO

require("dotenv").config();

const express = require("express");
const cors = require("cors");
const crypto = require("crypto");
const path = require("path");
const { execFile } = require("child_process");

const app = express();
const PORT = process.env.PORT || 3000;

// =====================================================
// CONFIG
// =====================================================

const GISTDA_API_KEY =
  process.env.GISTDA_API_KEY || "";

const GISTDA_URLS = [
  "https://api-gateway.gistda.or.th/api/2.0/resources/features/viirs/1day",
  "https://api-gateway.gistda.or.th/api/2.0/resources/features/viirs/3days",
  "https://api-gateway.gistda.or.th/api/2.0/resources/features/viirs/7days"
];

const AUTH_SECRET =
  process.env.AUTH_SECRET || "change-this-secret";

const OFFICER_USERNAME =
  process.env.OFFICER_USERNAME || "officer";

const OFFICER_PASSWORD =
  process.env.OFFICER_PASSWORD || "";

const DEMO_USERNAME =
  process.env.DEMO_USERNAME || "demo";

const DEMO_PASSWORD =
  process.env.DEMO_PASSWORD || "";

// LINE token
// ห้ามใส่ Token จริงใน source code
const LINE_CHANNEL_ACCESS_TOKEN =
  process.env.LINE_CHANNEL_ACCESS_TOKEN || "";

// กลุ่มประชาชน
const LINE_CITIZEN_TO =
  process.env.LINE_CITIZEN_TO ||
  process.env.LINE_TO ||
  "";

// กลุ่มเจ้าหน้าที่
const LINE_OFFICER_TO =
  process.env.LINE_OFFICER_TO || "";

// =====================================================
// ESP32 BOARDS
// =====================================================
//
// เพิ่มบอร์ดได้ เช่น:
//
// {
//   board_id: "CR02",
//   name: "ESP32 Board 02",
//   lat: 19.8500,
//   lng: 99.9000,
//   radius_km: 20
// }
//
// board_id ต้องไม่ซ้ำกัน
//

const ESP32_BOARDS = [
  {
    board_id: "CR01",
    name: "ESP32 Board 01",
    lat: 19.9105,
    lng: 99.8406,
    radius_km: 20
  }

  // ตัวอย่างบอร์ดที่ 2
  // {
  //   board_id: "CR02",
  //   name: "ESP32 Board 02",
  //   lat: 19.8500,
  //   lng: 99.9000,
  //   radius_km: 20
  // }
];

// =====================================================
// GISTDA CACHE
// =====================================================
//
// ลดการเรียก GISTDA ซ้ำ
// ใช้ข้อมูลเดิมไม่เกิน 60 วินาที
//

const GISTDA_CACHE_MS = 60 * 1000;

let gistdaCache = {
  data: null,
  timestamp: 0
};

// =====================================================
// DEMO FIRE STATE
// =====================================================
// เก็บสถานะไฟจำลองให้ ESP32 Polling จาก Render เห็น
// หมดอายุอัตโนมัติหลัง 5 นาที

const DEMO_FIRE_MS = 5 * 60 * 1000;

let demoFireState = {
  active: false,
  data: null,
  timestamp: 0
};

// =====================================================
// MIDDLEWARE
// =====================================================

app.use(cors());

app.use(
  express.json({
    limit: "1mb"
  })
);

// =====================================================
// SIMPLE AUTH SESSION
// =====================================================

const sessions = new Map();

function createSession(role, username) {
  const token =
    crypto.randomBytes(32).toString("hex");

  sessions.set(token, {
    role,
    username,
    createdAt: Date.now()
  });

  return token;
}

function getSession(req) {
  const auth =
    req.headers.authorization || "";

  if (!auth.startsWith("Bearer ")) {
    return null;
  }

  const token =
    auth.slice(7);

  return (
    sessions.get(token) || null
  );
}

function requireLogin(
  req,
  res,
  next
) {
  const session =
    getSession(req);

  if (!session) {
    return res.status(401).json({
      ok: false,
      error: "Login required"
    });
  }

  req.session = session;

  next();
}

function requireOfficerOrDemo(
  req,
  res,
  next
) {
  const session =
    getSession(req);

  if (!session) {
    return res.status(401).json({
      ok: false,
      error: "Login required"
    });
  }

  if (
    session.role !== "officer" &&
    session.role !== "demo"
  ) {
    return res.status(403).json({
      ok: false,
      error:
        "Officer or Demo role required"
    });
  }

  req.session = session;

  next();
}

// =====================================================
// LOGIN
// =====================================================

app.post(
  "/api/login",
  (req, res) => {
    const {
      role,
      username = "",
      password = ""
    } = req.body || {};

    // -----------------------------------------
    // PUBLIC
    // -----------------------------------------

    if (role === "public") {
      const token =
        createSession(
          "public",
          "public"
        );

      return res.json({
        ok: true,
        role: "public",
        token
      });
    }

    // -----------------------------------------
    // OFFICER
    // -----------------------------------------

    if (role === "officer") {
      if (!OFFICER_PASSWORD) {
        return res.status(500).json({
          ok: false,
          error:
            "OFFICER_PASSWORD is not configured"
        });
      }

      if (
        username !== OFFICER_USERNAME ||
        password !== OFFICER_PASSWORD
      ) {
        return res.status(401).json({
          ok: false,
          error:
            "ชื่อผู้ใช้หรือรหัสผ่านไม่ถูกต้อง"
        });
      }

      const token =
        createSession(
          "officer",
          username
        );

      return res.json({
        ok: true,
        role: "officer",
        token
      });
    }

    // -----------------------------------------
    // DEMO
    // -----------------------------------------

    if (role === "demo") {
      if (!DEMO_PASSWORD) {
        return res.status(500).json({
          ok: false,
          error:
            "DEMO_PASSWORD is not configured"
        });
      }

      if (
        username !== DEMO_USERNAME ||
        password !== DEMO_PASSWORD
      ) {
        return res.status(401).json({
          ok: false,
          error:
            "ชื่อผู้ใช้หรือรหัสผ่านไม่ถูกต้อง"
        });
      }

      const token =
        createSession(
          "demo",
          username
        );

      return res.json({
        ok: true,
        role: "demo",
        token
      });
    }

    return res.status(400).json({
      ok: false,
      error: "Invalid role"
    });
  }
);

// =====================================================
// LOGOUT
// =====================================================

app.post(
  "/api/logout",
  (req, res) => {
    const auth =
      req.headers.authorization || "";

    if (auth.startsWith("Bearer ")) {
      const token =
        auth.slice(7);

      sessions.delete(token);
    }

    res.json({
      ok: true
    });
  }
);

// =====================================================
// CURRENT USER
// =====================================================

app.get(
  "/api/me",
  requireLogin,
  (req, res) => {
    res.json({
      ok: true,
      role: req.session.role,
      username:
        req.session.username
    });
  }
);

// =====================================================
// HOME
// =====================================================

app.get(
  "/",
  (req, res) => {
    res.sendFile(
      path.join(
        __dirname,
        "index.html"
      )
    );
  }
);

// =====================================================
// HEALTH
// =====================================================

app.get(
  "/health",
  (req, res) => {
    res.json({
      ok: true,

      gistdaKeyConfigured:
        Boolean(GISTDA_API_KEY),

      lineConfigured:
        Boolean(
          LINE_CHANNEL_ACCESS_TOKEN
        ),

      citizenLineConfigured:
        Boolean(
          LINE_CHANNEL_ACCESS_TOKEN &&
          LINE_CITIZEN_TO
        ),

      officerLineConfigured:
        Boolean(
          LINE_CHANNEL_ACCESS_TOKEN &&
          LINE_OFFICER_TO
        ),

      officerConfigured:
        Boolean(OFFICER_PASSWORD),

      demoConfigured:
        Boolean(DEMO_PASSWORD),

      esp32Boards:
        ESP32_BOARDS.length
    });
  }
);

// =====================================================
// GISTDA REQUEST
// =====================================================


function requestGistda(
  url,
  limit,
  offset,
  country
) {
  return new Promise(
    async (resolve, reject) => {

      const target =
        new URL(url);

      target.search =
        new URLSearchParams({
          limit: String(limit),
          offset: String(offset),
          ct_tn: String(country)
        }).toString();

      let response;

      try {

        console.log(
          "GISTDA REQUEST:",
          target.toString()
        );

        response =
          await fetch(
            target.toString(),
            {
              method: "GET",

              headers: {
                "API-Key":
                  GISTDA_API_KEY,

                "Accept":
                  "application/json"
              }
            }
          );

      } catch (error) {

        console.error(
          "GISTDA FETCH ERROR:",
          error
        );

        console.error(
          "GISTDA FETCH CAUSE:",
          error?.cause
        );

        return reject(error);
      }

      const text =
        await response.text();

      console.log(
        "GISTDA HTTP STATUS:",
        response.status
      );

      if (!response.ok) {

        console.error(
          "GISTDA RESPONSE:",
          text.slice(0, 500)
        );

        return reject(
          new Error(
            `GISTDA HTTP ${response.status}: ${text.slice(0, 500)}`
          )
        );
      }

      try {

        const json =
          JSON.parse(text);

        resolve({
          json,

          url:
            target.toString()
        });

      } catch (error) {

        console.error(
          "GISTDA JSON ERROR:",
          error
        );

        console.error(
          "GISTDA RAW RESPONSE:",
          text.slice(0, 500)
        );

        reject(
          new Error(
            "GISTDA returned invalid JSON"
          )
        );
      }
    }
  );
}
// =====================================================
// GISTDA API PROXY
// =====================================================

app.get(
  "/api/gistda",
  async (req, res) => {
    if (!GISTDA_API_KEY) {
      return res.status(500).json({
        error:
          "GISTDA_API_KEY is not configured on backend"
      });
    }

    const limit =
      req.query.limit || "1000";

    const offset =
      req.query.offset || "0";

    const country =
      req.query.ct_tn ||
      "ราชอาณาจักรไทย";

    const requestedUrl =
      req.query.apiUrl ||
      GISTDA_URLS[0];

    try {
      const target =
        new URL(requestedUrl);

      if (
        target.hostname !==
        "api-gateway.gistda.or.th"
      ) {
        return res.status(400).json({
          error:
            "Only api-gateway.gistda.or.th is allowed"
        });
      }

      const result =
        await requestGistda(
          target.toString(),
          limit,
          offset,
          country
        );

      res.type(
        "application/geo+json"
      );

      return res.json(
        result.json
      );

    } catch (error) {
      console.error(
        "GISTDA error:",
        error.message
      );

      return res.status(502).json({
        error:
          "Cannot reach GISTDA API",
        detail:
          error.message
      });
    }
  }
);

// =====================================================
// GISTDA AUTO LATEST
// 1day -> 3days -> 7days
// =====================================================

async function getLatestGistdaData() {
  if (!GISTDA_API_KEY) {
    throw new Error(
      "GISTDA_API_KEY is not configured"
    );
  }

  const now =
    Date.now();

  if (
    gistdaCache.data &&
    now -
      gistdaCache.timestamp <
      GISTDA_CACHE_MS
  ) {
    return gistdaCache.data;
  }

  let lastError = null;

  for (
    const url of GISTDA_URLS
  ) {
    try {
      console.log(
        "Trying GISTDA:",
        url
      );

      const result =
        await requestGistda(
          url,
          1000,
          0,
          "ราชอาณาจักรไทย"
        );

      gistdaCache = {
        data: result.json,
        timestamp: Date.now()
      };

      return result.json;

    } catch (error) {
      lastError =
        error;

      console.error(
        "GISTDA dataset failed:",
        error.message
      );
    }
  }

  throw (
    lastError ||
    new Error(
      "All GISTDA datasets failed"
    )
  );
}

// =====================================================
// HAVERSINE DISTANCE
// =====================================================

function haversineKm(
  lat1,
  lng1,
  lat2,
  lng2
) {
  const R = 6371;

  const dLat =
    (lat2 - lat1) *
    Math.PI /
    180;

  const dLng =
    (lng2 - lng1) *
    Math.PI /
    180;

  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(
      lat1 *
      Math.PI /
      180
    ) *
    Math.cos(
      lat2 *
      Math.PI /
      180
    ) *
    Math.sin(dLng / 2) ** 2;

  return (
    R *
    2 *
    Math.atan2(
      Math.sqrt(a),
      Math.sqrt(1 - a)
    )
  );
}

// =====================================================
// FIND RESPONSIBLE ESP32 BOARD
// =====================================================

function findResponsibleBoard(
  fireLat,
  fireLng
) {
  let bestBoard = null;

  for (
    const board of ESP32_BOARDS
  ) {
    const distance =
      haversineKm(
        board.lat,
        board.lng,
        fireLat,
        fireLng
      );

    if (
      distance >
      board.radius_km
    ) {
      continue;
    }

    if (
      !bestBoard ||
      distance <
        bestBoard.distance_km
    ) {
      bestBoard = {
        ...board,
        distance_km:
          distance
      };
    }
  }

  return bestBoard;
}

// =====================================================
// LIST ESP32 BOARDS
// =====================================================

app.get(
  "/api/esp32/boards",
  (req, res) => {
    return res.json({
      ok: true,

      boards:
        ESP32_BOARDS.map(
          board => ({
            board_id:
              board.board_id,

            name:
              board.name,

            lat:
              board.lat,

            lng:
              board.lng,

            radius_km:
              board.radius_km
          })
        )
    });
  }
);

// =====================================================
// RESPONSIBLE BOARD API
// =====================================================

app.get(
  "/api/esp32/responsible-board",
  (req, res) => {
    const fireLat =
      Number(req.query.lat);

    const fireLng =
      Number(req.query.lng);

    if (
      !Number.isFinite(
        fireLat
      ) ||
      !Number.isFinite(
        fireLng
      )
    ) {
      return res.status(400).json({
        ok: false,
        error:
          "Invalid fire coordinates"
      });
    }

    const board =
      findResponsibleBoard(
        fireLat,
        fireLng
      );

    if (!board) {
      return res.json({
        ok: true,
        responsible: false,
        board: null
      });
    }

    return res.json({
      ok: true,

      responsible: true,

      board: {
        board_id:
          board.board_id,

        name:
          board.name,

        lat:
          board.lat,

        lng:
          board.lng,

        radius_km:
          board.radius_km,

        distance_km:
          Number(
            board.distance_km.toFixed(
              3
            )
          )
      }
    });
  }
);

// =====================================================
// FEATURE LOCATION
// =====================================================

function getFeatureLatLng(
  feature
) {
  const geometry =
    feature?.geometry;

  if (
    !geometry ||
    !geometry.coordinates
  ) {
    return null;
  }

  const coordinates =
    geometry.coordinates;

  if (
    geometry.type === "Point" &&
    coordinates.length >= 2
  ) {
    return {
      lng:
        Number(
          coordinates[0]
        ),

      lat:
        Number(
          coordinates[1]
        )
    };
  }

  return null;
}

// =====================================================
// FEATURE DATE
// =====================================================

function getFeatureDate(
  feature
) {
  const p =
    feature?.properties || {};

  return (
    p.acq_date ||
    p.date ||
    p.datetime ||
    p.acq_datetime ||
    ""
  );
}

// =====================================================
// FEATURE TIME
// =====================================================

function getFeatureTime(
  feature
) {
  const p =
    feature?.properties || {};

  return (
    p.acq_time ||
    p.time ||
    ""
  );
}

// =====================================================
// FEATURE AREA
// =====================================================

function getFeatureArea(
  feature
) {
  const p =
    feature?.properties || {};

  return {
    province:
      p.province ||
      p.prov_nam_t ||
      p.province_name ||
      p.changwat ||
      p.changwat_t ||
      "",

    district:
      p.district ||
      p.district_name ||
      p.amphoe ||
      p.amphoe_t ||
      "",

    subdistrict:
      p.subdistrict ||
      p.subdistrict_name ||
      p.tambon ||
      p.tambon_t ||
      ""
  };
}

// =====================================================
// FIND NEAREST FIRE FOR BOARD
// =====================================================

function findNearestFireForBoard(
  features,
  board
) {
  let nearest = null;

  for (
    const feature of features
  ) {
    const point =
      getFeatureLatLng(
        feature
      );

    if (!point) {
      continue;
    }

    const distance =
      haversineKm(
        board.lat,
        board.lng,
        point.lat,
        point.lng
      );

    if (
      distance >
      board.radius_km
    ) {
      continue;
    }

    if (
      !nearest ||
      distance <
        nearest.distance_km
    ) {
      nearest = {
        feature,
        lat:
          point.lat,
        lng:
          point.lng,
        distance_km:
          distance
      };
    }
  }

  return nearest;
}

// =====================================================
// BUILD ESP32 RESPONSE
// =====================================================

function makeEsp32FireResponse(
  nearest,
  board
) {
  // -----------------------------------------
  // ไม่มีไฟในพื้นที่รับผิดชอบ
  // -----------------------------------------

  if (!nearest) {
    return {
      ok: true,

      fire: false,

      board_id:
        board.board_id,

      board_name:
        board.name,

      distance_km:
        null,

      lat:
        null,

      lng:
        null,

      source:
        "GISTDA VIIRS",

      // ไม่มีจุดไฟจริง
      // จึงไม่ใส่พื้นที่ปลอม
      province:
        "",

      district:
        "",

      subdistrict:
        "",

      date:
        "",

      time:
        "",

      radius_km:
        board.radius_km
    };
  }

  const properties =
    nearest.feature.properties ||
    {};

  const area =
    getFeatureArea(
      nearest.feature
    );

  return {
    ok: true,

    fire: true,

    board_id:
      board.board_id,

    board_name:
      board.name,

    distance_km:
      Number(
        nearest.distance_km.toFixed(
          2
        )
      ),

    lat:
      nearest.lat,

    lng:
      nearest.lng,

    source:
      "GISTDA VIIRS",

    province:
      area.province ||
      properties.name ||
      "",

    district:
      area.district,

    subdistrict:
      area.subdistrict,

    date:
      getFeatureDate(
        nearest.feature
      ),

    time:
      getFeatureTime(
        nearest.feature
      ),

    radius_km:
      board.radius_km
  };
}

// =====================================================
// ESP32 STATUS
// =====================================================
//
// แบบใหม่:
// /api/esp32/status?board_id=CR01
//
// แบบเดิม:
// /api/esp32/status?lat=...&lng=...&radius=20
//
// แบบ board_id แนะนำสำหรับระบบหลายบอร์ด
//

app.get(
  "/api/esp32/status",
  async (req, res) => {
    const boardId =
      String(
        req.query.board_id || ""
      );

    let board = null;

    // -----------------------------------------
    // BOARD ID
    // -----------------------------------------

    if (boardId) {
      board =
        ESP32_BOARDS.find(
          item =>
            item.board_id ===
            boardId
        );

      if (!board) {
        return res.status(404).json({
          ok: false,
          error:
            "ESP32 board not found"
        });
      }
    }

    // -----------------------------------------
    // CUSTOM BOARD
    // -----------------------------------------

    if (!board) {
      const boardLat =
        Number(
          req.query.lat
        );

      const boardLng =
        Number(
          req.query.lng
        );

      const radius =
        Number(
          req.query.radius ||
          20
        );

      if (
        !Number.isFinite(
          boardLat
        ) ||
        !Number.isFinite(
          boardLng
        )
      ) {
        return res.status(400).json({
          ok: false,
          error:
            "Invalid board coordinates"
        });
      }

      board = {
        board_id:
          "CUSTOM",

        name:
          "Custom ESP32 Board",

        lat:
          boardLat,

        lng:
          boardLng,

        radius_km:
          radius
      };
    }

    // -----------------------------------------
    // DEMO FIRE STATE
    // ถ้ามี DEMO ที่ยังไม่หมดอายุ ให้ ESP32 เห็นไฟทันที
    // โดยไม่ต้องรอ GISTDA
    // -----------------------------------------

    if (
      demoFireState.active &&
      demoFireState.data &&
      Date.now() - demoFireState.timestamp < DEMO_FIRE_MS &&
      (
        demoFireState.data.board_id === board.board_id ||
        demoFireState.data.board_id === "-"
      )
    ) {
      console.log(
        `ESP32 DEMO FIRE: ${board.board_id}`
      );

      return res.json({
        ok: true,
        fire: true,
        board_id: board.board_id,
        board_name: board.name,
        distance_km:
          Number.isFinite(
            Number(demoFireState.data.distance_km)
          )
            ? Number(
                Number(
                  demoFireState.data.distance_km
                ).toFixed(2)
              )
            : null,
        lat: demoFireState.data.lat,
        lng: demoFireState.data.lng,
        source: "DEMO",
        province:
          demoFireState.data.province || "",
        district:
          demoFireState.data.district || "",
        subdistrict:
          demoFireState.data.subdistrict || "",
        date:
          demoFireState.data.date || "",
        time:
          demoFireState.data.time || "",
        radius_km: board.radius_km
      });
    }

    // หมดอายุแล้ว ล้างสถานะ DEMO
    if (
      demoFireState.active &&
      Date.now() - demoFireState.timestamp >= DEMO_FIRE_MS
    ) {
      console.log("DEMO FIRE STATE: EXPIRED");

      demoFireState = {
        active: false,
        data: null,
        timestamp: 0
      };
    }

    try {
      const data =
        await getLatestGistdaData();

      const features =
        Array.isArray(
          data?.features
        )
          ? data.features
          : [];

      const nearest =
        findNearestFireForBoard(
          features,
          board
        );

      return res.json(
        makeEsp32FireResponse(
          nearest,
          board
        )
      );

      } catch (error) {
      console.error(
        "ESP32 status error:",
        error.message
      );

      return res.status(502).json({
        ok: false,
        error:
          "Cannot get GISTDA data",
        detail:
          error.message
      });
    }
  }
);

// =====================================================
// FIND RESPONSIBLE BOARD FROM FIRE
// =====================================================

app.get(
  "/api/esp32/check-fire",
  async (req, res) => {
    const fireLat =
      Number(
        req.query.lat
      );

    const fireLng =
      Number(
        req.query.lng
      );

    if (
      !Number.isFinite(
        fireLat
      ) ||
      !Number.isFinite(
        fireLng
      )
    ) {
      return res.status(400).json({
        ok: false,
        error:
          "Invalid fire coordinates"
      });
    }

    const board =
      findResponsibleBoard(
        fireLat,
        fireLng
      );

    if (!board) {
      return res.json({
        ok: true,
        responsible:
          false,
        board: null
      });
    }

    return res.json({
      ok: true,

      responsible:
        true,

      board: {
        board_id:
          board.board_id,

        name:
          board.name,

        lat:
          board.lat,

        lng:
          board.lng,

        radius_km:
          board.radius_km,

        distance_km:
          Number(
            board.distance_km.toFixed(
              2
            )
          )
      }
    });
  }
);

// =====================================================
// LINE HELPERS
// =====================================================

async function sendLineTextTo(
  target,
  text
) {
  if (
    !LINE_CHANNEL_ACCESS_TOKEN
  ) {
    throw new Error(
      "LINE_CHANNEL_ACCESS_TOKEN is not configured"
    );
  }

  if (!target) {
    throw new Error(
      "LINE target is not configured"
    );
  }

  const response =
    await fetch(
      "https://api.line.me/v2/bot/message/push",
      {
        method: "POST",

        headers: {
          "Content-Type":
            "application/json",

          Authorization:
            `Bearer ${LINE_CHANNEL_ACCESS_TOKEN}`
        },

        body:
          JSON.stringify({
            to: target,

            messages: [
              {
                type:
                  "text",

                text
              }
            ]
          })
      }
    );

  if (!response.ok) {
    const body =
      await response.text();

    throw new Error(
      `LINE API ${response.status}: ${body}`
    );
  }

  return true;
}

// =====================================================
// BACKWARD COMPATIBILITY
// =====================================================

async function sendLineText(
  text
) {
  return sendLineTextTo(
    LINE_CITIZEN_TO,
    text
  );
}

// =====================================================
// OFFICER LINE MESSAGE
// =====================================================

function makeOfficerLineMessage(
  data
) {
  const lat =
    Number(data.lat);

  const lng =
    Number(data.lng);

  const distance =
    Number(data.distance_km);

  const mapsUrl =
    "https://www.google.com/maps/dir/?api=1&destination=" +
    lat +
    "," +
    lng;

  return [
    "🚨 FIRE WATCH - OFFICER ALERT",
    "",
    "ตรวจพบจุดความร้อนจาก GISTDA VIIRS",
    "",
    `🔥 พิกัด: ${lat.toFixed(5)}, ${lng.toFixed(5)}`,
    `📏 ระยะจากบอร์ด: ${Number.isFinite(distance) ? distance.toFixed(2) : "-"} km`,
    `🛰️ บอร์ดรับผิดชอบ: ${data.board_id || "-"}`,
    `📍 จังหวัด: ${data.province || "-"}`,
    `📍 อำเภอ: ${data.district || "-"}`,
    `📍 ตำบล: ${data.subdistrict || "-"}`,
    `📅 วันที่: ${data.date || "-"}`,
    `⏰ เวลา: ${data.time || "-"}`,
    "",
    `🗺️ Google Maps: ${mapsUrl}`
  ].join("\n");
}

// =====================================================
// CITIZEN LINE MESSAGE
// =====================================================
//
// ไม่ส่งพิกัดละเอียด
// ไม่ส่ง Google Maps
// เน้นพื้นที่
//

function makeCitizenLineMessage(
  data
) {
  const province =
    data.province || "";

  const district =
    data.district || "";

  const subdistrict =
    data.subdistrict || "";

  const areaParts = [];

  if (subdistrict) {
    areaParts.push(
      `ตำบล${subdistrict}`
    );
  }

  if (district) {
    areaParts.push(
      `อำเภอ${district}`
    );
  }

  if (province) {
    areaParts.push(
      `จังหวัด${province}`
    );
  }

  const area =
    areaParts.length
      ? areaParts.join(" ")
      : "อยู่ระหว่างตรวจสอบพื้นที่";

  return [
    "🔥 FIRE WATCH",
    "",
    "ระบบตรวจพบจุดความร้อนจาก GISTDA VIIRS",
    "",
    `📍 พื้นที่: ${area}`,
    "",
    "ข้อมูลนี้เป็นจุดความร้อนจากระบบดาวเทียม",
    "ไม่ใช่การยืนยันว่าเป็นไฟป่าในพื้นที่จริง",
    "",
    "ประชาชนในพื้นที่ใกล้เคียงสามารถติดตามสถานการณ์จากหน่วยงานที่เกี่ยวข้อง"
  ].join("\n");
}

// =====================================================
// LINE TEST
// =====================================================

app.post(
  "/api/line/test",
  requireOfficerOrDemo,
  async (req, res) => {
    try {
      const prefix =
        req.session.role === "demo"
          ? "🧪 DEMO TEST\n\n"
          : "";

      if (LINE_OFFICER_TO) {
        await sendLineTextTo(
          LINE_OFFICER_TO,
          prefix +
          "🚨 FIRE WATCH\nระบบแจ้งเตือน LINE สำหรับเจ้าหน้าที่ทำงานปกติ"
        );
      }

      if (LINE_CITIZEN_TO) {
        await sendLineTextTo(
          LINE_CITIZEN_TO,
          prefix +
          "🔥 FIRE WATCH\nระบบแจ้งเตือน LINE สำหรับประชาชนทำงานปกติ"
        );
      }

      return res.json({
        ok: true,

        officerSent:
          Boolean(
            LINE_OFFICER_TO
          ),

        citizenSent:
          Boolean(
            LINE_CITIZEN_TO
          )
      });

    } catch (error) {
      console.error(
        "LINE test error:",
        error.message
      );

      return res.status(502).json({
        ok: false,

        error:
          "ส่ง LINE ไม่สำเร็จ",

        detail:
          error.message
      });
    }
  }
);

// =====================================================
// SEND NORMAL FIRE ALERT
// =====================================================

app.post(
  "/api/fire-alert",
  requireOfficerOrDemo,
  async (req, res) => {
    const {
      lat,
      lng,
      distance_km,
      province,
      district,
      subdistrict,
      date,
      time,
      source
    } = req.body || {};

    const fireLat =
      Number(lat);

    const fireLng =
      Number(lng);

    if (
      !Number.isFinite(
        fireLat
      ) ||
      !Number.isFinite(
        fireLng
      )
    ) {
      return res.status(400).json({
        ok: false,
        error:
          "Invalid fire coordinates"
      });
    }

    // Server เป็นผู้ตัดสินเองว่า
    // บอร์ดไหนรับผิดชอบ
    const responsibleBoard =
      findResponsibleBoard(
        fireLat,
        fireLng
      );

    if (!responsibleBoard) {
      return res.json({
        ok: true,

        responsible:
          false,

        board: null,

        lineSent: false
      });
    }

    const data = {
      lat:
        fireLat,

      lng:
        fireLng,

      distance_km:
        Number.isFinite(
          Number(distance_km)
        )
          ? Number(distance_km)
          : responsibleBoard.distance_km,

      board_id:
        responsibleBoard.board_id,

      province:
        province || "",

      district:
        district || "",

      subdistrict:
        subdistrict || "",

      date:
        date || "",

      time:
        time || "",

      source:
        source ||
        "GISTDA VIIRS"
    };

    let officerSent =
      false;

    let citizenSent =
      false;

    let lineError =
      null;

    try {

      // -----------------------------------------
      // OFFICER GROUP
      // -----------------------------------------

      if (LINE_OFFICER_TO) {
        await sendLineTextTo(
          LINE_OFFICER_TO,
          makeOfficerLineMessage(
            data
          )
        );

        officerSent =
          true;
      }

      // -----------------------------------------
      // CITIZEN GROUP
      // -----------------------------------------

      if (LINE_CITIZEN_TO) {
        await sendLineTextTo(
          LINE_CITIZEN_TO,
          makeCitizenLineMessage(
            data
          )
        );

        citizenSent =
          true;
      }

    } catch (error) {
      lineError =
        error.message;

      console.error(
        "Fire LINE error:",
        error.message
      );
    }

    return res.json({
      ok: true,

      responsible:
        true,

      board: {
        board_id:
          responsibleBoard.board_id,

        name:
          responsibleBoard.name,

        distance_km:
          Number(
            responsibleBoard.distance_km.toFixed(
              2
            )
          )
      },

      officerSent,

      citizenSent,

      lineError
    });
  }
);

// =====================================================
// DEMO ALERT
// =====================================================
//
// DEMO ใช้ข้อมูลจำลอง
// ไม่อ้างว่าเป็นข้อมูล GISTDA จริง
//

app.post(
  "/api/demo/alert",
  requireOfficerOrDemo,
  async (req, res) => {
    const {
      lat,
      lng,
      board_lat,
      board_lng,
      distance_km
    } = req.body || {};

    const demoLat =
      Number(lat);

    const demoLng =
      Number(lng);

    const boardLat =
      Number(board_lat);

    const boardLng =
      Number(board_lng);

    const distance =
      Number(distance_km);

    if (
      !Number.isFinite(
        demoLat
      ) ||
      !Number.isFinite(
        demoLng
      )
    ) {
      return res.status(400).json({
        ok: false,
        error:
          "Invalid demo coordinates"
      });
    }

    // -----------------------------------------
    // หา board ที่รับผิดชอบ
    // -----------------------------------------

    const responsibleBoard =
      findResponsibleBoard(
        demoLat,
        demoLng
      );

    const mapsUrl =
      `https://www.google.com/maps/dir/?api=1&destination=${demoLat},${demoLng}`;

    // -----------------------------------------
    // ข้อมูลพื้นที่ DEMO
    // -----------------------------------------
    //
    // ใช้สำหรับการสาธิตเท่านั้น
    //

    const data = {
      lat:
        demoLat,

      lng:
        demoLng,

      distance_km:
        Number.isFinite(
          distance
        )
          ? distance
          : responsibleBoard
            ? responsibleBoard.distance_km
            : null,

      board_id:
        responsibleBoard
          ? responsibleBoard.board_id
          : "-",

      province:
        "เชียงราย",

      district:
        "เมืองเชียงราย",

      subdistrict:
        "รอบเวียง",

      date:
        new Date().toLocaleDateString(
          "th-TH"
        ),

      time:
        new Date().toLocaleTimeString(
          "th-TH"
        ),

      source:
        "DEMO"
    };

    // -----------------------------------------
    // เปิดสถานะ DEMO ให้ ESP32 Polling เห็น
    // -----------------------------------------
    demoFireState = {
      active: true,
      data,
      timestamp: Date.now()
    };

    console.log(
      "DEMO FIRE STATE: ACTIVE"
    );

    console.log(
      "================================="
    );

    console.log(
      "DEMO ALERT"
    );

    console.log(
      JSON.stringify(
        req.body,
        null,
        2
      )
    );

    console.log(
      "Responsible board:",
      responsibleBoard
        ? responsibleBoard.board_id
        : "NONE"
    );

    console.log(
      "================================="
    );

    let officerSent =
      false;

    let citizenSent =
      false;

    let lineError =
      null;

    try {

      // -----------------------------------------
      // OFFICER GROUP
      // -----------------------------------------

      if (LINE_OFFICER_TO) {

        const officerMessage = [
          "🧪 DEMO - FIRE WATCH",
          "",
          "นี่คือข้อมูลจำลองสำหรับการสาธิต",
          "ไม่ใช่ข้อมูลไฟป่าจริงจาก GISTDA",
          "",
          `🔥 จุดจำลอง: ${demoLat.toFixed(5)}, ${demoLng.toFixed(5)}`,
          `🛰️ บอร์ดรับผิดชอบ: ${data.board_id}`,
          `📍 จุดบอร์ด: ${
            Number.isFinite(boardLat)
              ? boardLat.toFixed(5)
              : "-"
          }, ${
            Number.isFinite(boardLng)
              ? boardLng.toFixed(5)
              : "-"
          }`,
          `📏 ระยะห่าง: ${
            Number.isFinite(
              data.distance_km
            )
              ? Number(
                  data.distance_km
                ).toFixed(2)
              : "-"
          } km`,
          "",
          `🗺️ Google Maps: ${mapsUrl}`
        ].join("\n");

        await sendLineTextTo(
          LINE_OFFICER_TO,
          officerMessage
        );

        officerSent =
          true;
      }

      // -----------------------------------------
      // CITIZEN GROUP
      // -----------------------------------------

      if (LINE_CITIZEN_TO) {

        const citizenMessage = [
  "🧪 DEMO - FIRE WATCH",
  "",
  "นี่คือการแจ้งเตือนจำลองสำหรับการสาธิต",
  "",
  `📍 พื้นที่เกิดเหตุ: ตำบล${data.subdistrict} อำเภอ${data.district} จังหวัด${data.province}`,
  "",
  "ระบบจำลองพบจุดความร้อนในพื้นที่",
  "ข้อมูลนี้เป็นข้อมูลจำลอง",
  "ไม่ใช่ข้อมูลไฟป่าจริงจาก GISTDA"
].join("\n");

        await sendLineTextTo(
          LINE_CITIZEN_TO,
          citizenMessage
        );

        citizenSent =
          true;
      }

    } catch (error) {

      lineError =
        error.message;

      console.error(
        "DEMO LINE error:",
        error.message
      );
    }

    return res.json({
      ok: true,

      demo: true,

      responsible:
        Boolean(
          responsibleBoard
        ),

      board:
        responsibleBoard
          ? {
              board_id:
                responsibleBoard.board_id,

              name:
                responsibleBoard.name,

              distance_km:
                Number(
                  responsibleBoard.distance_km.toFixed(
                    2
                  )
                )
            }
          : null,

      officerSent,

      citizenSent,

      lineError,

      demoFireState: {
        active: true,
        expiresInSeconds:
          Math.max(
            0,
            Math.ceil(
              (
                DEMO_FIRE_MS -
                (Date.now() - demoFireState.timestamp)
              ) / 1000
            )
          )
      }
    });
  }
);

// =====================================================
// NORMAL ALERT
// =====================================================
//
// รับข้อมูลจาก ESP32/frontend
//

app.post(
  "/api/alert",
  requireLogin,
  (req, res) => {
    console.log(
      "ALERT:",
      JSON.stringify(
        req.body
      )
    );

    res.json({
      ok: true,

      received:
        req.body
    });
  }
);

// =====================================================
// STATIC WEBSITE
// =====================================================

app.use(
  express.static(
    __dirname
  )
);

// =====================================================
// START SERVER
// =====================================================

app.listen(
  PORT,
  () => {
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
      `GISTDA key configured: ${
        Boolean(
          GISTDA_API_KEY
        )
      }`
    );

    console.log(
      "VIIRS auto latest mode: ENABLED"
    );

    console.log(
      "Fallback datasets: 1day -> 3days -> 7days"
    );

    console.log(
      `LINE token configured: ${
        Boolean(
          LINE_CHANNEL_ACCESS_TOKEN
        )
      }`
    );

    console.log(
      `Citizen LINE configured: ${
        Boolean(
          LINE_CHANNEL_ACCESS_TOKEN &&
          LINE_CITIZEN_TO
        )
      }`
    );

    console.log(
      `Officer LINE configured: ${
        Boolean(
          LINE_CHANNEL_ACCESS_TOKEN &&
          LINE_OFFICER_TO
        )
      }`
    );

    console.log(
      `Officer login configured: ${
        Boolean(
          OFFICER_PASSWORD
        )
      }`
    );

    console.log(
      `Demo login configured: ${
        Boolean(
          DEMO_PASSWORD
        )
      }`
    );

    console.log(
      `ESP32 boards configured: ${
        ESP32_BOARDS.length
      }`
    );

    for (
      const board of ESP32_BOARDS
    ) {
      console.log(
        `- ${board.board_id}: ${board.name} @ ${board.lat}, ${board.lng} / radius ${board.radius_km} km`
      );
    }

    console.log(
      "GISTDA cache: 60 seconds"
    );

    console.log(
      "======================================"
    );
  }
);