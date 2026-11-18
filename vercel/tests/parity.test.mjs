/**
 * Parity with the Cloudflare worker (0.2.0): plain per-page mcp.json paths, the
 * divert_unverified serving policy, and record-only (capture) mode with
 * citation page-views.
 */

import { strict as assert } from "node:assert";
import { afterEach, test } from "node:test";

import { __test_setFeed } from "../../core/feed.js";
import { createNorgEdge } from "../src/index.js";
import { __test_resetHeartbeat } from "../src/lib/heartbeat.js";
import {
  API_URL,
  CHROME_UA,
  CONTENT_BASE,
  FEED,
  GPTBOT_UA,
  OPTIONS,
  SITE_ID,
  SITE_KEY,
  UNVERIFIED_IP,
  html,
  json,
  stubNetwork,
  vercelRequest,
  visitOn,
  waitUntilContext,
} from "./helpers.mjs";

const realFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = realFetch;
  __test_setFeed(null);
  __test_resetHeartbeat();
});

const DEEPSEEK_UA = "Mozilla/5.0 (compatible; DeepSeekBot/1.0)";

const FEED_UNVERIFIED = {
  ...FEED,
  patterns: [
    ...FEED.patterns,
    { pattern: "deepseekbot", company: "deepseek", purpose: "search", serving_policy: "divert_unverified" },
  ],
};

async function run(requestOptions = {}, network = {}, options = OPTIONS) {
  const { calls } = stubNetwork(network);
  const context = waitUntilContext();
  const result = await createNorgEdge(options)(vercelRequest(requestOptions), context);
  await Promise.all(context.pending);
  return { result, calls };
}

const posted = (calls, path) =>
  calls.filter((c) => c.url === `${API_URL}${path}`).map((c) => JSON.parse(c.init.body));

// --- */mcp.json ------------------------------------------------------------

test("a plain */mcp.json path is served from NORG, not the site", async () => {
  const { result, calls } = await run(
    { path: "/help/mcp.json", userAgent: CHROME_UA },
    { mirror: () => json({ mcpVersion: "1" }) },
  );
  assert.equal(result.status, 200);
  const read = calls.find((c) => c.url.startsWith(CONTENT_BASE));
  assert.equal(read.url, `${CONTENT_BASE}/${SITE_ID}/help/mcp.json`);
});

// --- divert_unverified -----------------------------------------------------

test("divert_unverified: an unverifiable agent gets the mirror, tagged apart", async () => {
  const { result, calls } = await run(
    { userAgent: DEEPSEEK_UA, ip: UNVERIFIED_IP },
    { feed: () => json(FEED_UNVERIFIED), mirror: () => html("<html><body>m</body></html>") },
  );
  assert.equal(result.status, 200);
  assert.equal(visitOn(calls).served, "mirror_unverified");
  const read = calls.find((c) => c.url.startsWith(CONTENT_BASE));
  assert.equal(new Headers(read.init.headers).get("x-norg-lazy-render"), null);
});

test("divert_unverified: a miss serves the site and never asks for a render", async () => {
  const { result, calls } = await run(
    { userAgent: DEEPSEEK_UA, ip: UNVERIFIED_IP },
    { feed: () => json(FEED_UNVERIFIED) },
  );
  assert.equal(result, undefined);
  assert.equal(visitOn(calls).served, "mirror_unverified");
  assert.equal(calls.filter((c) => c.url.includes("render")).length, 0);
});

test("a never_divert agent is still never served", async () => {
  const { result } = await run(
    { userAgent: "CCBot/2.0", ip: UNVERIFIED_IP },
    { feed: () => json(FEED_UNVERIFIED), mirror: () => html("<html></html>") },
  );
  assert.equal(result, undefined);
});

// --- capture mode ----------------------------------------------------------

const CAPTURE = { ...OPTIONS, captureOnly: "true" };
const CITATION_FEED = () => json({ ...FEED, citation_tracking_enabled: true });

test("capture: a verified agent gets the site and is reported as capture", async () => {
  const { result, calls } = await run({}, { mirror: () => html("<html></html>") }, CAPTURE);
  assert.equal(result, undefined);
  assert.equal(calls.filter((c) => c.url.startsWith(CONTENT_BASE)).length, 0);
  const [event] = posted(calls, "/api/v1/edge/events");
  assert.equal(event.served, "capture");
  assert.equal(event.verified_source, true);
});

const HAS_WEB_CRYPTO = Boolean(globalThis.crypto && globalThis.crypto.subtle);

test("capture: a person arriving from ChatGPT is recorded as a citation page-view", {
  skip: HAS_WEB_CRYPTO ? false : "no global Web Crypto on this Node version",
}, async () => {
  const { result, calls } = await run(
    { userAgent: CHROME_UA, headers: { referer: "https://chatgpt.com/" } },
    { feed: CITATION_FEED },
    CAPTURE,
  );
  assert.equal(result, undefined);
  const [view] = posted(calls, "/api/v1/edge/page-views");
  assert.equal(view.citation_source, "chatgpt");
  assert.equal(view.country, "AU");
  assert.equal(view.served_surface, "customer_zone");
});

test("capture: without Web Crypto a referred person is skipped, never a crash", {
  skip: HAS_WEB_CRYPTO ? "Web Crypto present" : false,
}, async () => {
  const { result, calls } = await run(
    { userAgent: CHROME_UA, headers: { referer: "https://chatgpt.com/" } },
    { feed: CITATION_FEED },
    CAPTURE,
  );
  assert.equal(result, undefined);
  assert.equal(posted(calls, "/api/v1/edge/page-views").length, 0);
});

test("capture: no page-view without an AI referral, or with tracking off", async () => {
  const plain = await run({ userAgent: CHROME_UA }, { feed: CITATION_FEED }, CAPTURE);
  assert.equal(posted(plain.calls, "/api/v1/edge/page-views").length, 0);
  __test_setFeed(null);
  const off = await run(
    { userAgent: CHROME_UA, headers: { referer: "https://chatgpt.com/" } },
    {},
    CAPTURE,
  );
  assert.equal(posted(off.calls, "/api/v1/edge/page-views").length, 0);
});

test("capture switched on by NORG's feed: the agent gets the site", async () => {
  const { result, calls } = await run(
    {},
    { feed: () => json({ ...FEED, capture_only: true }), mirror: () => html("<html></html>") },
  );
  assert.equal(result, undefined);
  assert.equal(posted(calls, "/api/v1/edge/events")[0].served, "capture");
});

test("the health probe reports capture_only", async () => {
  const { result } = await run(
    { userAgent: CHROME_UA, headers: { "x-norg-edge-check": SITE_KEY } },
    {},
    CAPTURE,
  );
  const body = await result.json();
  assert.equal(body.capture_only, true);
  assert.equal(body.version, "0.2.0");
});
