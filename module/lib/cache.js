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
 * - `set()` refreshes the key and evicts from the front until **both** caps
 *   hold. An entry cap alone bounds the number of answers, not their size: 50
 *   extracted pages of 1 MiB each is ~100 MB of strings. When `maxBytes` and
 *   `bytesOf` are given, the cache also tracks the weight of what it holds and
 *   evicts under that budget, so one huge page cannot pin the heap.
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
 * @param {{
 *   ttlMs: number,
 *   max?: number,
 *   maxBytes?: number,
 *   bytesOf?: (value: unknown) => number,
 *   now?: () => number,
 * }} options
 *   `maxBytes` + `bytesOf` are optional; without them the cache is entry-capped
 *   only (the behaviour the three API tools rely on).
 */
export function createCache({ ttlMs, max = 50, maxBytes, bytesOf, now = Date.now }) {
  const entries = new Map()
  let bytes = 0

  /** What one value weighs; 0 when no weighing was asked for. */
  const weigh = (value) => {
    if (bytesOf === undefined) return 0
    const weight = bytesOf(value)
    return typeof weight === 'number' && Number.isFinite(weight) && weight > 0 ? weight : 0
  }

  const forget = (key) => {
    const hit = entries.get(key)
    if (hit === undefined) return
    bytes -= hit.bytes
    entries.delete(key)
  }

  return {
    ttlMs,
    max,
    maxBytes,

    /** The live value for `key`, or `undefined` when missing or expired. */
    get(key) {
      const hit = entries.get(key)
      if (hit === undefined) return undefined
      if (now() - hit.at > ttlMs) {
        forget(key)
        return undefined
      }
      entries.delete(key)
      entries.set(key, hit)
      return hit.value
    },

    /** Store a successful answer, evicting the oldest until both caps hold. */
    set(key, value) {
      forget(key)
      const weight = weigh(value)
      entries.set(key, { at: now(), value, bytes: weight })
      bytes += weight
      while (entries.size > max || (maxBytes !== undefined && bytes > maxBytes)) {
        const oldest = entries.keys().next()
        if (oldest.done === true) break
        forget(oldest.value)
      }
    },

    clear() {
      entries.clear()
      bytes = 0
    },

    get size() {
      return entries.size
    },

    /** Total weight of the live entries, in the units `bytesOf` returned. */
    get bytes() {
      return bytes
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
