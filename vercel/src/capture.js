/**
 * Record-only (capture) mode: the site answers every request untouched, and
 * what NORG would have seen is reported afterwards.
 *
 * AI agents (verified or not; the verdict travels as verified_source) are
 * reported to /edge/events with served "capture". People who arrive from an
 * AI answer are reported to /edge/page-views when NORG has citation tracking
 * on for the site. Nothing here runs before the response: it is handed to the
 * platform's keep-alive and never awaited on the visitor's path.
 */
import { detectCitationReferral } from "../../workers/lib/referral.mjs";
import { buildPageViewPayload } from "../../workers/lib/page-view.mjs";

import { binding } from "../../core/config.js";
import { classifyAgent, verifiedSource } from "../../core/agent.js";
import { getBotFeed, isCaptureOnly } from "../../core/feed.js";
import { isStaticAssetPath } from "../../core/paths.js";
import { fireEdgeEvent, postControl } from "../../core/telemetry.js";

import { maybeHeartbeat } from "./lib/heartbeat.js";
import { clientIp, edgeRegion } from "./lib/request.js";

/**
 * Is record-only mode on? Either switch turns it on.
 *
 * The NORG_CAPTURE_ONLY setting is read with no NORG call; the feed's
 * capture_only covers an install whose owner never set it, once a feed is held.
 *
 * @param {Object} env Install config.
 * @returns {boolean} True when capture mode applies.
 */
export function captureActive(env) {
  return binding(env, "CAPTURE_ONLY") === "true" || isCaptureOnly();
}

/**
 * Report one visit seen in capture mode. Never throws.
 *
 * @param {Request} request Incoming request.
 * @param {Object} env Install config.
 * @param {Object} options Factory options (client-IP trust).
 * @returns {Promise<void>}
 */
export async function recordCapture(request, env, options) {
  try {
    const feed = await getBotFeed(env);
    if (!feed.entitled) return;
    maybeHeartbeat(env, "traffic", edgeRegion(request));
    const url = new URL(request.url);
    if (isStaticAssetPath(url.pathname)) return;
    const classification = classifyAgent(request.headers.get("user-agent") || "", feed.patterns);
    if (classification.is_ai_bot) {
      const verified = verifiedSource(clientIp(request, options), feed.cidrRanges, classification);
      await fireEdgeEvent(env, request, classification, "capture", { verified_source: verified });
      return;
    }
    if (!feed.citationTrackingEnabled) return;
    const detection = detectCitationReferral(request, url, url.hostname);
    if (!detection) return;
    const payload = await buildPageViewPayload(request, url, url.hostname, detection, "customer_zone", true);
    await postControl(env, "/api/v1/edge/page-views", payload);
  } catch (e) {
    console.error("norg edge capture report failed", e);
  }
}

/**
 * Start the capture report behind the response and let the site answer.
 *
 * @param {Request} request Incoming request.
 * @param {Object} env Install config.
 * @param {Object} options Factory options.
 * @returns {null} Always null: the site serves the request.
 */
export function handleCapture(request, env, options) {
  const done = recordCapture(request, env, options);
  if (typeof env.EDGE_KEEPALIVE === "function") env.EDGE_KEEPALIVE(done);
  return null;
}
