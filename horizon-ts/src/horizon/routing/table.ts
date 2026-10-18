/*
 * Where each kind of call goes (umbrella design §6.2), as data.
 *
 * Callers pick their client from this table (`usePrismClient`, the stock
 * hooks); stock calls keep their own clients and per-call overrides. There is
 * deliberately no fetch wrapper that rewrites `atproto-proxy` by NSID: it
 * would be invisible at the call site and fight the stock overrides.
 */

/**
 * A destination for a call.
 * - `prism`: Horizon's AppView, proxied through the PDS (signed in) or direct
 *   (signed out, public reads only).
 * - `public`: the public AppView (Bluesky's by default, switchable).
 * - `pds`: the account's own PDS, no proxy.
 * - `chat`: Bluesky's chat service.
 * - `bluesky`: Bluesky's own AppView, whatever the public AppView is.
 * - `video`: Bluesky's video service.
 * - `notif`: Bluesky's notification service.
 * - `labeler`: the moderation service a report goes to.
 */
export type Destination =
  | 'prism'
  | 'public'
  | 'pds'
  | 'chat'
  | 'bluesky'
  | 'video'
  | 'notif'
  | 'labeler'

/**
 * One row of the routing table.
 */
export type Route = {
  /** What the row covers. */
  calls: string
  destination: Destination
  /** The phase that brings the row's first Horizon caller; 0 when stock. */
  firstCallerPhase: number
}

/**
 * The routing table.
 */
export const ROUTES: readonly Route[] = [
  {calls: 'app.nearhorizon.*', destination: 'prism', firstCallerPhase: 2},
  {
    calls:
      'calls about a private post; private bookmarks, search, notifications',
    destination: 'prism',
    firstCallerPhase: 2,
  },
  {
    calls:
      'membership probe (app.nearhorizon.actor.getMembership; app.bsky.feed.getTimeline on a prism without it)',
    destination: 'prism',
    firstCallerPhase: 1,
  },
  {
    calls: 'tools.kryphocron.* procedures',
    destination: 'pds',
    firstCallerPhase: 2,
  },
  {
    calls: 'custom feeds, network-wide search',
    destination: 'bluesky',
    firstCallerPhase: 0,
  },
  {calls: 'video upload', destination: 'video', firstCallerPhase: 0},
  {calls: 'push registration', destination: 'notif', firstCallerPhase: 0},
  {calls: 'reports', destination: 'labeler', firstCallerPhase: 0},
  {
    calls: 'preferences, repo reads and writes',
    destination: 'pds',
    firstCallerPhase: 0,
  },
  {calls: 'chat.bsky.*', destination: 'chat', firstCallerPhase: 0},
  {
    calls: 'every other app.bsky.*',
    destination: 'public',
    firstCallerPhase: 0,
  },
]
