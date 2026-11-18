/**
 * Path scope: limit the router to part of a site.
 *
 * Set with the `paths` option or NORG_EDGE_PATHS (comma-separated). Unset, the
 * router runs on every path, exactly as before. Set, it acts only on those
 * paths and below; every other request goes straight to the site with no NORG
 * call. NORG's own surfaces stay in scope whatever is set, because the pages
 * NORG serves link to them: the reserved assets (/.norg/*, the mirror's
 * theme), the discovery files, the MCP surface, the OpenAI feeds and the
 * agentic subtree. A per-page sibling (index.md, mcp.json, ...) follows its
 * page.
 */
import { isAgenticPath } from "../../workers/lib/r2-content.mjs";
import { knownAgenticPathPrefix } from "../../core/feed.js";
import { isNorgOwnedArtifactPath, isSiblingArtifactPath, siblingPageOf } from "../../core/paths.js";

/**
 * Parse the configured scope into normalised path prefixes.
 *
 * @param {?string} raw Comma-separated paths, e.g. "/help,/docs".
 * @returns {?string[]} Prefixes without a trailing slash, or null for "everywhere".
 */
export function parseScope(raw) {
  if (!raw) return null;
  const prefixes = String(raw)
    .split(",")
    .map((p) => p.trim())
    .filter((p) => p.startsWith("/"))
    .map((p) => (p.length > 1 ? p.replace(/\/+$/, "") : p));
  if (prefixes.length === 0 || prefixes.includes("/")) return null;
  return prefixes;
}

/**
 * Is this pathname one of the prefixes, or below one?
 *
 * @param {string} pathname Request pathname.
 * @param {string[]} prefixes Normalised prefixes.
 * @returns {boolean} True on an exact or path-boundary match.
 */
function underAny(pathname, prefixes) {
  return prefixes.some((p) => pathname === p || pathname.startsWith(`${p}/`));
}

/**
 * May the router act on this path?
 *
 * @param {string} pathname Request pathname.
 * @param {?string[]} prefixes Scope from parseScope (null = everywhere).
 * @returns {boolean} True when in scope.
 */
export function inScope(pathname, prefixes) {
  if (!prefixes) return true;
  if (isSiblingArtifactPath(pathname) && !isNorgOwnedArtifactPath(pathname)) {
    return underAny(siblingPageOf(pathname), prefixes);
  }
  if (isNorgOwnedArtifactPath(pathname)) return true;
  if (isAgenticPath(pathname, knownAgenticPathPrefix())) return true;
  return underAny(pathname, prefixes);
}
