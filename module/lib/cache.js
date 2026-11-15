/**
 * One small in-memory cache, shared by every tool that needs one.
 *
 * Three tools keep answers for a few minutes so a model that re-asks the same
 * question does not burn a public quota on it. The policy is identical each
 * time (TTL, entry cap, LRU eviction, successful answers only), so it lives
 * here instead of being copy-pasted per tool:
 *
 * - `get()` drops an expired entry and returns `undefined`; a live entry is
 *   re-inserted so `Map` iteration order stays least-recently-used first.
 * - `set()` refreshes the key and evicts from the front until the cap holds.
 * - Callers cache **answers**, never errors: a dead backend or an exhausted
 *   quota must not be hidden behind a hit.
 *
 * Each tool owns its own instance, so a stack.search entry can never be
 * served to github.issues. The map is per worker process and dies with it;
 * there is no disk state.
 *
 * @module z1-web/cache
 */

/**
 * @param {{ ttlMs: number, max?: number, now?: () => number }} options
 */
export function createCache({ ttlMs, max = 50, now = Date.now }) {
  const entries = new Map()

  return {
    ttlMs,
    max,

    /** The live value for `key`, or `undefined` when missing or expired. */
    get(key) {
      const hit = entries.get(key)
      if (hit === undefined) return undefined
      if (now() - hit.at > ttlMs) {
        entries.delete(key)
        return undefined
      }
      entries.delete(key)
      entries.set(key, hit)
      return hit.value
    },

    /** Store a successful answer, evicting the oldest entries past the cap. */
    set(key, value) {
      entries.delete(key)
      entries.set(key, { at: now(), value })
      while (entries.size > max) {
        const oldest = entries.keys().next()
        if (oldest.done === true) break
        entries.delete(oldest.value)
      }
    },

    clear() {
      entries.clear()
    },

    get size() {
      return entries.size
    },
  }
}

/**
 * Build a cache key from an ordered parameter list. `\u0000` cannot appear in
 * a URL, a query or a tag, so no two different parameter sets can collide.
 */
export function cacheKey(parts) {
  return parts.map((part) => String(part ?? '')).join('\u0000')
}
