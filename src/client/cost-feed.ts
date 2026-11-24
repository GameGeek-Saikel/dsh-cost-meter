/**
 * Shared `/cost-meter` feed: one polling request per (session, currency) key,
 * shared by every surface that reads the balance and the pricebook.
 *
 * Five surfaces read that route — the composer-dock readout, the header pill,
 * every per-reply chip, the Cost tab, and the settings page — and each used to
 * poll it on its own. Every reply therefore added one more full pricebook
 * transfer per minute, and a reconnect or a resumed machine restarted all of
 * them at once against a browser's small per-host connection budget; a single
 * failed or stalled request then left the surface on "balance unavailable"
 * until its next tick.
 *
 * The feed collapses them into one request per interval per key and makes
 * recovery explicit:
 *
 * - every request carries an abort deadline, so a stalled transport cannot
 *   leave the surface waiting forever;
 * - a failure retries after {@link RETRY_MS} rather than a whole minute, and a
 *   successful poll keeps the last good payload, so a transient failure never
 *   blanks a balance the browser already had;
 * - the browser's `online`, `visibilitychange`, and `focus` signals force a
 *   reload, so waking the computer or reconnecting recovers immediately
 *   instead of on the next scheduled tick.
 *
 * @module @gamegeek-saikel/dsh-cost-meter/client/cost-feed
 */

import { useCallback, useMemo, useSyncExternalStore } from 'react'
import type { ConversationCostResponse, Currency } from '../types.ts'

/** Host route serving the balance snapshot and the pricebook view. */
export const ENDPOINT = '/cost-meter'
/** Polling interval in milliseconds. */
export const REFRESH_MS = 60_000
/** Retry delay after a failed poll, in milliseconds. */
export const RETRY_MS = 5_000
/** Per-request abort deadline, in milliseconds. */
export const TIMEOUT_MS = 20_000
/** How stale a payload may be before a wake signal forces a reload. */
const STALE_MS = 5_000

/** What one feed currently knows. */
export interface CostFeedState {
  /** Last good payload; kept across failed polls. */
  readonly response: ConversationCostResponse | null
  /** Whether the most recent poll failed. */
  readonly failed: boolean
  /** Detail of the most recent failure, for logs. */
  readonly error: string | null
}

/** A feed state plus the manual reload the surfaces may trigger. */
export interface CostFeedValue extends CostFeedState {
  /** Reload now, ignoring the current schedule. */
  readonly reload: () => void
}

const EMPTY_STATE: CostFeedState = { response: null, failed: false, error: null }

interface Feed {
  readonly endpoint: string
  state: CostFeedState
  readonly listeners: Set<() => void>
  timer: ReturnType<typeof setTimeout> | undefined
  controller: AbortController | undefined
  inflight: boolean
  lastAttemptAt: number
  subscribe: (listener: () => void) => () => void
  reload: () => void
}

/** How many inactive feeds stay cached so switching back does not refetch. */
const FEED_CACHE_LIMIT = 8

/** Live feeds, keyed by `<sessionId>|<currency>`, in creation order. */
const feeds = new Map<string, Feed>()

/** The route URL for one key. */
function endpointOf(sessionId: string | undefined, currency: Currency): string {
  const session = sessionId === undefined ? '' : `session=${encodeURIComponent(sessionId)}&`
  return `${ENDPOINT}?${session}currency=${currency}`
}

/** Replace the published state and notify listeners when something changed. */
function update(feed: Feed, patch: Partial<CostFeedState>): void {
  const next = { ...feed.state, ...patch }
  if (next.response === feed.state.response && next.failed === feed.state.failed && next.error === feed.state.error) return
  feed.state = next
  for (const listener of feed.listeners) listener()
}

/** (Re)schedule the next poll, replacing any pending one. */
function schedule(feed: Feed, delay: number): void {
  if (feed.timer !== undefined) clearTimeout(feed.timer)
  feed.timer = setTimeout(() => {
    feed.timer = undefined
    void load(feed)
  }, delay)
}

/** One poll: fetch, publish, and schedule the next attempt. */
async function load(feed: Feed): Promise<void> {
  if (feed.inflight) return
  feed.inflight = true
  feed.lastAttemptAt = Date.now()
  const controller = new AbortController()
  feed.controller = controller
  const deadline = setTimeout(() => controller.abort(), TIMEOUT_MS)
  try {
    const response = await fetch(feed.endpoint, { cache: 'no-store', signal: controller.signal })
    if (!response.ok) throw new Error(`HTTP ${response.status}`)
    const data = await response.json() as ConversationCostResponse
    update(feed, { response: data, failed: false, error: null })
    if (feed.listeners.size > 0) schedule(feed, REFRESH_MS)
  } catch (error) {
    update(feed, {
      failed: true,
      error: error instanceof Error ? error.message : String(error),
    })
    if (feed.listeners.size > 0) schedule(feed, RETRY_MS)
  } finally {
    clearTimeout(deadline)
    feed.inflight = false
    if (feed.controller === controller) feed.controller = undefined
  }
}

/** Stop polling one feed: cancel its timer and abort the request in flight. */
function stop(feed: Feed): void {
  if (feed.timer !== undefined) {
    clearTimeout(feed.timer)
    feed.timer = undefined
  }
  feed.controller?.abort()
  feed.controller = undefined
}

let wakeListenersAttached = false

/**
 * Reload the feeds a resumed page or a reconnected browser left behind: a
 * failed feed always reloads, and every other feed reloads when its payload is
 * older than {@link STALE_MS} (a sleep can outlast any interval).
 */
function reloadStale(): void {
  const now = Date.now()
  for (const feed of feeds.values()) {
    if (feed.listeners.size === 0) continue
    if (feed.state.failed || feed.state.response === null || now - feed.lastAttemptAt >= STALE_MS) feed.reload()
  }
}

/** Attach the wake signals once, on the first feed. */
function ensureWakeListeners(): void {
  if (wakeListenersAttached || typeof window === 'undefined') return
  wakeListenersAttached = true
  window.addEventListener('online', reloadStale)
  window.addEventListener('focus', reloadStale)
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') reloadStale()
  })
}

/** Create and register the feed for one key. */
function createFeed(sessionId: string | undefined, currency: Currency): Feed {
  const feed: Feed = {
    endpoint: endpointOf(sessionId, currency),
    state: EMPTY_STATE,
    listeners: new Set(),
    timer: undefined,
    controller: undefined,
    inflight: false,
    lastAttemptAt: 0,
    reload: () => {},
    subscribe: () => () => {},
  }
  feed.reload = () => {
    void load(feed)
  }
  feed.subscribe = (listener: () => void) => {
    feed.listeners.add(listener)
    if (feed.listeners.size === 1) {
      ensureWakeListeners()
      if (feed.state.response !== null && Date.now() - feed.lastAttemptAt < REFRESH_MS) {
        schedule(feed, REFRESH_MS - (Date.now() - feed.lastAttemptAt))
      } else {
        void load(feed)
      }
    }
    return () => {
      feed.listeners.delete(listener)
      if (feed.listeners.size === 0) stop(feed)
    }
  }
  feeds.set(`${sessionId ?? ''}|${currency}`, feed)
  pruneFeeds()
  return feed
}

/**
 * Drop the oldest inactive feeds once the cache is over its cap. A feed with
 * listeners is never dropped; the cap only bounds the payload a session switch
 * leaves behind.
 */
function pruneFeeds(): void {
  for (const [key, feed] of feeds) {
    if (feeds.size <= FEED_CACHE_LIMIT) return
    if (feed.listeners.size > 0) continue
    stop(feed)
    feeds.delete(key)
  }
}

/** The (cached) feed for one key. */
function feedFor(sessionId: string | undefined, currency: Currency): Feed {
  return feeds.get(`${sessionId ?? ''}|${currency}`) ?? createFeed(sessionId, currency)
}

/**
 * Publish a payload the caller obtained another way (the settings page's
 * manual refresh over POST) into the shared feed, so every surface picks it up
 * without waiting for the next poll.
 * @param response - the fresh route payload.
 * @param currency - payload currency.
 * @param sessionId - the session the payload was requested for; omit for the session-less view.
 */
export function publishCostFeed(response: ConversationCostResponse, currency: Currency = 'CNY', sessionId?: string): void {
  const feed = feeds.get(`${sessionId ?? ''}|${currency}`)
  if (feed === undefined) return
  update(feed, { response, failed: false, error: null })
  schedule(feed, REFRESH_MS)
}

/**
 * Drop every feed and its timers. Tests call this between cases; the running
 * page never needs it, because a feed retires when its last listener leaves.
 */
export function resetCostFeed(): void {
  for (const feed of feeds.values()) stop(feed)
  feeds.clear()
}

/**
 * Subscribe one surface to the feed for its session and currency. A `null`
 * session disables the feed (the surface asks for no data at all).
 * @param sessionId - the session to aggregate, `undefined` for the session-less view, `null` to opt out.
 * @param currency - display/pricing currency.
 * @returns the current payload state plus a manual reload.
 */
export function useCostFeed(sessionId: string | null | undefined, currency: Currency): CostFeedValue {
  const enabled = sessionId !== null
  const feed = useMemo(
    () => (enabled ? feedFor(sessionId ?? undefined, currency) : undefined),
    [enabled, sessionId, currency],
  )
  const subscribe = useCallback(
    (listener: () => void) => (feed === undefined ? () => {} : feed.subscribe(listener)),
    [feed],
  )
  const getSnapshot = useCallback(() => feed?.state ?? EMPTY_STATE, [feed])
  const state = useSyncExternalStore(subscribe, getSnapshot, getSnapshot)
  const reload = useCallback(() => {
    feed?.reload()
  }, [feed])
  return { ...state, reload }
}
