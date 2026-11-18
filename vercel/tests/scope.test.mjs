/**
 * The paths option (0.3.0): the router acts only on the configured paths and
 * below, NORG's own surfaces always stay in scope, and everything else gets the
 * site with no NORG call.
 */

import { strict as assert } from "node:assert";
import { afterEach, test } from "node:test";

import { __test_setFeed } from "../../core/feed.js";
import { createNorgEdge } from "../src/index.js";
import { __test_resetHeartbeat } from "../src/lib/heartbeat.js";
import { inScope, parseScope } from "../src/scope.js";
import {
  CHROME_UA,
  CONTENT_BASE,
  OPTIONS,
  SITE_ID,
  SITE_KEY,
  html,
  norgCalls,
  stubNetwork,
  vercelRequest,
  waitUntilContext,
} from "./helpers.mjs";

const realFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = realFetch;
  __test_setFeed(null);
  __test_resetHeartbeat();
});

const HELP = { ...OPTIONS, paths: ["/help"] };

async function run(requestOptions = {}, network = {}, options = HELP) {
  const { calls } = stubNetwork(network);
  const context = waitUntilContext();
  const result = await createNorgEdge(options)(vercelRequest(requestOptions), context);
  await Promise.all(context.pending);
  return { result, calls };
}

// --- parseScope / inScope --------------------------------------------------

test("parseScope normalises and treats empty or '/' as everywhere", () => {
  assert.deepEqual(parseScope("/help/, /docs"), ["/help", "/docs"]);
  assert.equal(parseScope(""), null);
  assert.equal(parseScope(undefined), null);
  assert.equal(parseScope("/"), null);
  assert.equal(parseScope("help"), null);
});

test("inScope: the configured paths and below, on a path boundary", () => {
  const s = parseScope("/help");
  for (const p of ["/help", "/help/", "/help/edge-routing", "/help/a/b"]) assert.equal(inScope(p, s), true, p);
  for (const p of ["/", "/helpdesk", "/dashboard", "/sitemap.xml", "/api/help"]) assert.equal(inScope(p, s), false, p);
});

test("inScope: NORG's own surfaces are always in scope", () => {
  const s = parseScope("/help");
  for (const p of ["/.norg/theme.css", "/llms.txt", "/agents.md", "/.well-known/mcp.json", "/mcp", "/ai/x"]) {
    assert.equal(inScope(p, s), true, p);
  }
});

test("inScope: a page sibling follows its page", () => {
  const s = parseScope("/help");
  assert.equal(inScope("/help/edge-routing/index.md", s), true);
  assert.equal(inScope("/dashboard/index.md", s), false);
});

test("inScope: no scope means every path", () => {
  for (const p of ["/", "/dashboard", "/help"]) assert.equal(inScope(p, null), true, p);
});

// --- pipeline --------------------------------------------------------------

test("out of scope: a verified agent gets the site and NORG is never called", async () => {
  const { result, calls } = await run({ path: "/widgets/" }, { mirror: () => html("<html></html>") });
  assert.equal(result, undefined);
  assert.equal(norgCalls(calls).length, 0);
});

test("in scope: a verified agent on /help gets the mirror", async () => {
  const { result } = await run({ path: "/help/edge-routing" }, { mirror: () => html("<html>m</html>") });
  assert.equal(result.status, 200);
  assert.equal(result.headers.get("x-norg-edge"), "mirror");
});

test("the theme under /.norg/ is served even when scoped to /help", async () => {
  const { result, calls } = await run(
    { path: "/.norg/theme.css", userAgent: CHROME_UA },
    { mirror: () => new Response("body{}", { headers: { "content-type": "text/css" } }) },
  );
  assert.equal(result.status, 200);
  assert.ok(calls.some((c) => c.url === `${CONTENT_BASE}/${SITE_ID}/.norg/theme.css`));
});

test("NORG_EDGE_PATHS works as a comma-separated string", async () => {
  const opts = { ...OPTIONS, paths: "/docs,/help" };
  const out = await run({ path: "/widgets/" }, {}, opts);
  assert.equal(out.result, undefined);
  assert.equal(norgCalls(out.calls).length, 0);
});

test("the health probe answers on any path, in scope or not", async () => {
  const { result } = await run({ path: "/", userAgent: CHROME_UA, headers: { "x-norg-edge-check": SITE_KEY } });
  const body = await result.json();
  assert.equal(body.version, "0.3.0");
});
