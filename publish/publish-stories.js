/*
 * 每日限時動態自動發布：IG 限動 + FB 粉絲團限動（官方 Graph API）。
 *
 *   node publish/publish-stories.js                      試跑：印出「今天」會發什麼，不發
 *   node publish/publish-stories.js --date 2027-01-01    指定日期試跑
 *   node publish/publish-stories.js --check-url          試跑並檢查圖片網址能不能打開
 *   node publish/publish-stories.js --publish            真的發（IG + FB）
 *   node publish/publish-stories.js --publish --platform ig   只發 IG（或 fb）
 *
 * 預設「試跑」。只有明確加 --publish 才會對外發布。
 * 已成功發過的 日期×平台 記在 publish/posted.json，重跑不會重複發（--force 可略過）。
 *
 * 設定：publish/config.json（圖片公開網址）、.env（權杖，別進版控）。見 publish/README.md。
 */
const fs = require("fs");
const path = require("path");

const ROOT = path.join(__dirname, "..");
const CONFIG = JSON.parse(fs.readFileSync(path.join(__dirname, "config.json"), "utf8"));
const LOG_PATH = path.join(__dirname, "posted.json");

// ── .env（不用額外套件）────────────────────────────────────────
function loadEnv() {
  const p = path.join(__dirname, ".env");
  if (!fs.existsSync(p)) return;
  for (const line of fs.readFileSync(p, "utf8").split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/);
    if (m && !(m[1] in process.env)) process.env[m[1]] = m[2].replace(/^["']|["']$/g, "");
  }
}

function args() {
  const a = process.argv.slice(2);
  const get = (k) => (a.includes(k) ? a[a.indexOf(k) + 1] : null);
  return {
    publish: a.includes("--publish"),
    force: a.includes("--force"),
    checkUrl: a.includes("--check-url"),
    date: get("--date"),
    platform: get("--platform") || "both",
  };
}

/** 台灣時區的今天（YYYY-MM-DD），不依賴主機時區。 */
function todayTaipei() {
  return new Intl.DateTimeFormat("sv-SE", { timeZone: "Asia/Taipei" }).format(new Date());
}

const readLog = () => (fs.existsSync(LOG_PATH) ? JSON.parse(fs.readFileSync(LOG_PATH, "utf8")) : {});
const writeLog = (log) => fs.writeFileSync(LOG_PATH, JSON.stringify(log, null, 2));

async function graph(method, endpoint, params) {
  const url = `https://graph.facebook.com/${CONFIG.graphVersion}/${endpoint}`;
  const body = new URLSearchParams(params);
  const res = await fetch(method === "GET" ? `${url}?${body}` : url, {
    method,
    ...(method === "GET" ? {} : { body }),
  });
  const json = await res.json().catch(() => ({}));
  if (!res.ok || json.error) {
    throw new Error(`Graph API ${endpoint} 失敗：${JSON.stringify(json.error || json)}`);
  }
  return json;
}

// ── IG 限動：建立容器 → 等處理完 → 發布 ────────────────────────
async function postIgStory(imageUrl) {
  const { IG_USER_ID, META_PAGE_TOKEN } = process.env;
  const created = await graph("POST", `${IG_USER_ID}/media`, {
    image_url: imageUrl,
    media_type: "STORIES",
    access_token: META_PAGE_TOKEN,
  });
  for (let i = 0; i < 20; i++) {
    const st = await graph("GET", created.id, { fields: "status_code", access_token: META_PAGE_TOKEN });
    if (st.status_code === "FINISHED") break;
    if (st.status_code === "ERROR" || st.status_code === "EXPIRED") throw new Error(`IG 容器狀態 ${st.status_code}`);
    await new Promise((r) => setTimeout(r, 3000));
  }
  const pub = await graph("POST", `${IG_USER_ID}/media_publish`, {
    creation_id: created.id,
    access_token: META_PAGE_TOKEN,
  });
  return pub.id;
}

// ── FB 粉絲團限動：先上傳（不公開）→ photo_stories ─────────────
async function postFbStory(imageUrl) {
  const { FB_PAGE_ID, META_PAGE_TOKEN } = process.env;
  const photo = await graph("POST", `${FB_PAGE_ID}/photos`, {
    url: imageUrl,
    published: "false",
    access_token: META_PAGE_TOKEN,
  });
  const story = await graph("POST", `${FB_PAGE_ID}/photo_stories`, {
    photo_id: photo.id,
    access_token: META_PAGE_TOKEN,
  });
  return story.post_id || story.id || JSON.stringify(story);
}

async function main() {
  loadEnv();
  const o = args();
  const date = o.date || todayTaipei();
  const year = date.slice(0, 4);

  const storiesDir = process.env.STORIES_DIR ? path.resolve(process.env.STORIES_DIR) : path.join(ROOT, "out", "stories");
  const file = path.join(storiesDir, `${date}.png`);
  const imageUrl = `${CONFIG.imageBaseUrl.replace(/\/$/, "")}/${date}.png`;
  const platforms = o.platform === "both" ? ["ig", "fb"] : [o.platform];

  console.log(`日期　${date}（台灣時區）　模式　${o.publish ? "★ 真的發布" : "試跑（不發）"}`);
  console.log(`本機圖　${file}  ${fs.existsSync(file) ? "✓" : "✗ 找不到（本機要先 render-stories；雲端要先把圖 sync 上去）"}`);
  console.log(`公開網址　${imageUrl}`);
  if (!fs.existsSync(file)) process.exit(1);

  if (o.checkUrl || o.publish) {
    try {
      const r = await fetch(imageUrl, { method: "HEAD" });
      console.log(`網址檢查　HTTP ${r.status} ${r.headers.get("content-type") || ""}`);
      if (!r.ok) throw new Error("圖片網址打不開");
    } catch (e) {
      console.error(`✗ ${e.message}：IG／FB 是自己去抓這個網址，打不開就發不出去。`);
      if (o.publish) process.exit(1);
    }
  }

  const need = { ig: ["IG_USER_ID", "META_PAGE_TOKEN"], fb: ["FB_PAGE_ID", "META_PAGE_TOKEN"] };
  const log = readLog();
  let failed = false;

  for (const p of platforms) {
    const label = p === "ig" ? "IG 限動" : "FB 限動";
    const missing = need[p].filter((k) => !process.env[k]);
    const done = log[date]?.[p];

    if (done && !o.force) { console.log(`${label}　已發過（${done.at}），略過`); continue; }
    if (!o.publish) {
      console.log(`${label}　將發出這張圖${missing.length ? `　（尚缺設定：${missing.join("、")}）` : "　（設定齊全）"}`);
      continue;
    }
    if (missing.length) { console.error(`✗ ${label}　缺設定：${missing.join("、")}`); failed = true; continue; }

    try {
      const id = p === "ig" ? await postIgStory(imageUrl) : await postFbStory(imageUrl);
      (log[date] ||= {})[p] = { id, at: new Date().toISOString() };
      writeLog(log);
      console.log(`✓ ${label}　已發布（${id}）`);
    } catch (e) {
      console.error(`✗ ${label}　${e.message}`);
      failed = true;
    }
  }
  if (failed) process.exit(1);
}

main().catch((e) => { console.error(e); process.exit(1); });
