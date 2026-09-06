// server.js
// ============================================================
// Wildfire Backend Proxy
// GISTDA VIIRS + Alert Endpoint
//
// ระบบเลือกข้อมูลล่าสุดอัตโนมัติ
//
// 1. ลอง 1day
// 2. ถ้าไม่มีข้อมูล -> 3days
// 3. ถ้ายังไม่มี -> 7days
// 4. ดึงข้อมูลหลายหน้า (pagination)
// 5. หา acq_date ที่ใหม่ที่สุดจริง
// 6. ส่งเฉพาะจุดของวันที่ล่าสุดกลับหน้าเว็บ
//
// API Key เก็บไว้ใน .env
// ============================================================

require("dotenv").config({
  path: require("path").join(__dirname, ".env")
});

const express = require("express");
const cors = require("cors");

const app = express();

const PORT = process.env.PORT || 3000;

const GISTDA_API_KEY =
  process.env.GISTDA_API_KEY || "";

// ============================================================
// GISTDA URLs
// ============================================================

const GISTDA_BASE_URL =
  "https://api-gateway.gistda.or.th/api/2.0/resources/features/viirs";

const DATASETS = [
  {
    name: "1day",
    url: `${GISTDA_BASE_URL}/1day`
  },
  {
    name: "3days",
    url: `${GISTDA_BASE_URL}/3days`
  },
  {
    name: "7days",
    url: `${GISTDA_BASE_URL}/7days`
  }
];

// ============================================================
// ตั้งค่าการดึงข้อมูล
// ============================================================

// จำนวนข้อมูลต่อ request
const PAGE_SIZE = 1000;

// ป้องกันการดึงข้อมูลมากเกินไปในครั้งเดียว
const MAX_PAGES = 250;

// เวลารอแต่ละ request
const REQUEST_TIMEOUT = 30000;

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

app.get("/", (req, res) => {
  res.type("text/plain").send(
    "Wildfire Backend Proxy is running"
  );
});

// ============================================================
// Health Check
// ============================================================

app.get("/health", (req, res) => {

  res.json({

    ok: true,

    gistdaKeyConfigured:
      Boolean(GISTDA_API_KEY),

    service:
      "GISTDA VIIRS Proxy",

    autoLatest:
      true

  });

});

// ============================================================
// Helper: sleep
// ============================================================

function sleep(ms) {

  return new Promise(
    resolve => setTimeout(resolve, ms)
  );

}

// ============================================================
// Helper: ดึง features
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
// Helper: ตรวจวันที่
// ============================================================

function normalizeDate(value) {

  if (!value) {
    return null;
  }

  const text =
    String(value).trim();

  if (!text) {
    return null;
  }

  // เช่น
  // 2026-09-03
  // 2026-09-03T04:21:00

  const match =
    text.match(
      /^(\d{4}-\d{2}-\d{2})/
    );

  if (match) {
    return match[1];
  }

  return null;

}

// ============================================================
// Helper: หา acq_date
// ============================================================

function getFeatureDate(feature) {

  const properties =
    feature &&
    feature.properties
      ? feature.properties
      : {};

  return (
    normalizeDate(
      properties.acq_date
    ) ||

    normalizeDate(
      properties.th_date
    ) ||

    normalizeDate(
      properties.date
    ) ||

    null
  );

}

// ============================================================
// Helper: หา latest date
// ============================================================

function getLatestDate(features) {

  let latest = null;

  for (
    const feature of features
  ) {

    const date =
      getFeatureDate(feature);

    if (!date) {
      continue;
    }

    if (
      !latest ||
      date > latest
    ) {

      latest = date;

    }

  }

  return latest;

}

// ============================================================
// Helper: กรองเฉพาะวันที่ต้องการ
// ============================================================

function filterByDate(
  features,
  date
) {

  if (!date) {
    return features;
  }

  return features.filter(
    feature =>
      getFeatureDate(feature) === date
  );

}

// ============================================================
// เรียก GISTDA 1 หน้า
// ============================================================

async function fetchGistdaPage(
  dataset,
  limit,
  offset,
  country
) {

  const target =
    new URL(dataset.url);

  target.search =
    new URLSearchParams({

      limit:
        String(limit),

      offset:
        String(offset),

      ct_tn:
        String(country)

    }).toString();

  console.log("");
  console.log(
    "--------------------------------------"
  );

  console.log(
    "GISTDA REQUEST"
  );

  console.log(
    "Dataset:",
    dataset.name
  );

  console.log(
    "Offset:",
    offset
  );

  console.log(
    "Limit:",
    limit
  );

  try {

    const controller =
      new AbortController();

    const timeout =
      setTimeout(
        () =>
          controller.abort(),
        REQUEST_TIMEOUT
      );

    let response;

    try {

      response =
        await fetch(
          target,
          {

            method: "GET",

            headers: {

              "Accept":
                "application/geo+json, application/json",

              "API-Key":
                GISTDA_API_KEY

            },

            signal:
              controller.signal

          }
        );

    } finally {

      clearTimeout(timeout);

    }

    const text =
      await response.text();

    console.log(
      "HTTP:",
      response.status
    );

    if (!response.ok) {

      console.error(
        "GISTDA ERROR:",
        text
      );

      return {

        ok: false,

        status:
          response.status,

        error:
          text ||
          `HTTP ${response.status}`

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

        error:
          "GISTDA returned invalid JSON"

      };

    }

    return {

      ok: true,

      status:
        response.status,

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

      error:
        error.message

    };

  }

}

// ============================================================
// ดึงข้อมูลทั้งหมดแบบ Pagination
//
// สำคัญ:
// ฟังก์ชันนี้จะดึงหลายหน้าเพื่อให้หา
// วันที่ล่าสุดจริงได้
// ============================================================

async function fetchDatasetAll(
  dataset,
  country
) {

  const allFeatures = [];

  let offset = 0;

  let totalMatched = null;

  let page = 0;

  while (
    page < MAX_PAGES
  ) {

    page++;

    const result =
      await fetchGistdaPage(
        dataset,
        PAGE_SIZE,
        offset,
        country
      );

    if (!result.ok) {

      return {

        ok: false,

        error:
          result.error,

        features:
          allFeatures

      };

    }

    const data =
      result.data;

    const features =
      getFeatures(data);

    console.log(
      `Page ${page}: ${features.length} features`
    );

    // จำนวนทั้งหมดจาก GISTDA
    if (
      Number.isFinite(
        Number(
          data.numberMatched
        )
      )
    ) {

      totalMatched =
        Number(
          data.numberMatched
        );

    }

    allFeatures.push(
      ...features
    );

    // --------------------------------------------------------
    // ไม่มีข้อมูล
    // --------------------------------------------------------

    if (
      features.length === 0
    ) {

      break;

    }

    // --------------------------------------------------------
    // ครบข้อมูลแล้ว
    // --------------------------------------------------------

    if (
      totalMatched !== null &&
      allFeatures.length >=
        totalMatched
    ) {

      break;

    }

    // --------------------------------------------------------
    // ถ้าหน้านี้คืนมาน้อยกว่า PAGE_SIZE
    // มีโอกาสสูงว่าเป็นหน้าสุดท้าย
    // --------------------------------------------------------

    if (
      features.length <
      PAGE_SIZE
    ) {

      break;

    }

    offset +=
      PAGE_SIZE;

    // --------------------------------------------------------
    // กัน request ถี่เกินไป
    // --------------------------------------------------------

    await sleep(50);

  }

  console.log("");
  console.log(
    "Dataset complete:",
    dataset.name
  );

  console.log(
    "Pages:",
    page
  );

  console.log(
    "Features loaded:",
    allFeatures.length
  );

  console.log(
    "GISTDA numberMatched:",
    totalMatched
  );

  return {

    ok: true,

    features:
      allFeatures,

    totalMatched

  };

}

// ============================================================
// หา Dataset ที่มีข้อมูล
//
// 1day -> 3days -> 7days
// ============================================================

async function findBestDataset(
  country
) {

  for (
    const dataset of DATASETS
  ) {

    console.log("");
    console.log(
      "======================================"
    );

    console.log(
      "TRY DATASET:",
      dataset.name
    );

    console.log(
      "======================================"
    );

    const result =
      await fetchDatasetAll(
        dataset,
        country
      );

    if (!result.ok) {

      console.log(
        "Dataset failed:",
        dataset.name
      );

      continue;

    }

    if (
      result.features.length === 0
    ) {

      console.log(
        "Dataset has no features:",
        dataset.name
      );

      continue;

    }

    const latestDate =
      getLatestDate(
        result.features
      );

    console.log(
      "Latest date found:",
      latestDate
    );

    if (!latestDate) {

      console.log(
        "No valid acq_date found"
      );

      continue;

    }

    const latestFeatures =
      filterByDate(
        result.features,
        latestDate
      );

    console.log(
      "Latest-date features:",
      latestFeatures.length
    );

    return {

      ok: true,

      dataset:
        dataset.name,

      latestDate,

      latestFeatures,

      allFeatures:
        result.features,

      totalMatched:
        result.totalMatched

    };

  }

  return {

    ok: false,

    error:
      "No GISTDA VIIRS data available"

  };

}

// ============================================================
// GISTDA API
//
// GET /api/gistda
//
// ตัวอย่าง:
// /api/gistda
// /api/gistda?ct_tn=ราชอาณาจักรไทย
// ============================================================

app.get(
  "/api/gistda",
  async (req, res) => {

    if (!GISTDA_API_KEY) {

      return res.status(500).json({

        error:
          "GISTDA_API_KEY is not configured on backend"

      });

    }

    const country =
      req.query.ct_tn ||
      "ราชอาณาจักรไทย";

    console.log("");
    console.log("");
    console.log(
      "######################################"
    );

    console.log(
      "AUTO LATEST GISTDA MODE"
    );

    console.log(
      "######################################"
    );

    console.log(
      "Country:",
      country
    );

    console.log(
      "Searching latest VIIRS data..."
    );

    try {

      const result =
        await findBestDataset(
          country
        );

      if (!result.ok) {

        return res.json({

          type:
            "FeatureCollection",

          features: [],

          links: [],

          numberMatched: 0,

          numberReturned: 0,

          latestDate: null,

          dataset: null,

          source:
            "GISTDA VIIRS",

          message:
            result.error

        });

      }

      console.log("");
      console.log(
        "######################################"
      );

      console.log(
        "LATEST DATA FOUND"
      );

      console.log(
        "######################################"
      );

      console.log(
        "Dataset:",
        result.dataset
      );

      console.log(
        "Latest date:",
        result.latestDate
      );

      console.log(
        "Points:",
        result.latestFeatures.length
      );

      // ------------------------------------------------------
      // ส่งข้อมูลกลับหน้าเว็บ
      // ------------------------------------------------------

      return res.json({

        type:
          "FeatureCollection",

        features:
          result.latestFeatures,

        links: [],

        numberMatched:
          result.latestFeatures.length,

        numberReturned:
          result.latestFeatures.length,

        latestDate:
          result.latestDate,

        dataset:
          result.dataset,

        source:
          "GISTDA VIIRS",

        timeStamp:
          new Date().toISOString(),

        autoLatest:
          true

      });

    } catch (error) {

      console.error(
        "AUTO GISTDA ERROR:",
        error
      );

      return res.status(502).json({

        error:
          "Cannot get latest GISTDA data",

        detail:
          error.message

      });

    }

  }
);

// ============================================================
// RAW GISTDA
//
// ใช้ตรวจสอบข้อมูลดิบ
//
// /api/gistda/raw?days=1
// /api/gistda/raw?days=3
// /api/gistda/raw?days=7
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

    let dataset =
      DATASETS.find(
        item =>
          item.name ===
          `${days}day`
      );

    if (!dataset) {

      dataset =
        DATASETS.find(
          item =>
            item.name ===
            `${days}days`
        );

    }

    if (!dataset) {

      dataset =
        DATASETS.find(
          item =>
            item.name ===
            "3days"
        );

    }

    const limit =
      Math.min(
        Math.max(
          Number(
            req.query.limit || 100
          ),
          1
        ),
        5000
      );

    const offset =
      Math.max(
        Number(
          req.query.offset || 0
        ),
        0
      );

    const country =
      req.query.ct_tn ||
      "ราชอาณาจักรไทย";

    const result =
      await fetchGistdaPage(
        dataset,
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
          "GISTDA request failed"

      });

    }

    return res.json(
      result.data
    );

  }
);

// ============================================================
// Alert Endpoint
//
// POST /api/alert
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
// 404
// ============================================================

app.use(
  (req, res) => {

    res.status(404).json({

      error:
        "Endpoint not found",

      path:
        req.path

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
      "Auto latest mode: ENABLED"
    );

    console.log(
      "Dataset fallback: 1day -> 3days -> 7days"
    );

    console.log(
      `Page size: ${PAGE_SIZE}`
    );

    console.log(
      `Max pages: ${MAX_PAGES}`
    );

    console.log(
      "======================================"
    );

  }
);