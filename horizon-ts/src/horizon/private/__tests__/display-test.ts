import {afterAll, beforeEach, describe, expect, it, jest} from '@jest/globals'

let mockDisplayOn = true
let mockNotificationsSwitchOn = true

jest.mock('#/horizon/switches', () =>
  Object.defineProperties(
    {...jest.requireActual<object>('#/horizon/switches')},
    {
      PRIVATE_POST_DISPLAY: {get: () => mockDisplayOn, enumerable: true},
      PRIVATE_NOTIFICATIONS_SWITCH: {
        get: () => mockNotificationsSwitchOn,
        enumerable: true,
      },
    },
  ),
)
jest.mock('#/horizon/session/local-store', () => ({
  readLocal: () => undefined,
  writeLocal: () => {},
  subscribeLocal: () => () => {},
}))
jest.mock('#/state/session', () => ({useSession: () => ({})}))
jest.mock('#/horizon/private/membership', () => ({useIsMember: () => true}))

import {
  clearCurrentClients,
  type CurrentClients,
  publishCurrentClients,
} from '../../routing/current-clients'
import {
  answerPrismFeatures,
  loadPrismFeatures,
  resetPrismFeatures,
} from '../../routing/features'
import {
  getNotificationsMode,
  offersNotificationsSwitch,
  setNotificationsMode,
  showsPrivateNotifications,
} from '../notifications/mode'
import {
  hidesDetachQuote,
  hidesGateControls,
  hidesHideReply,
  hidesPrivateStatsRow,
  hideThreadMute,
  isPrivateBadgeHref,
  isPrivateDisplay,
  privateControlsFor,
  proxiesPostLinks,
  threadRepliesCount,
} from '../render/controls'
import {privatePostStyle} from '../render/styles'
import {
  addPendingPost,
  clearPrivateStores,
  type PendingPost,
  setPrivatePostFacts,
} from '../store'
import {DID, OTHER_DID} from './fixtures'

afterAll(() => clearCurrentClients())

const PRIVATE = `at://${DID}/tools.kryphocron.feed.postPrivate/3kpost222222`
const PUBLIC = `at://${DID}/app.bsky.feed.post/3kpost222222`
const PRIVATE_REPLY = `at://${OTHER_DID}/tools.kryphocron.feed.postPrivate/3kreply22222`
const THEME = {palette: {primary_500: '#0070ff'}} as never

beforeEach(() => {
  mockDisplayOn = true
  mockNotificationsSwitchOn = true
  resetPrismFeatures()
  clearPrivateStores()
  publishCurrentClients({did: DID} as unknown as CurrentClients)
})

function countsServedOn(uri: string) {
  setPrivatePostFacts(uri, {isPending: false, countsServed: true})
}

describe('gate controls (Anchor 2, Menu 3)', () => {
  it('are left out on a private post until prism applies the gates', () => {
    expect(hidesGateControls(PRIVATE)).toBe(true)
    expect(hidesGateControls(PUBLIC)).toBe(false)
    answerPrismFeatures(DID, ['private', 'private.gates'])
    expect(hidesGateControls(PRIVATE)).toBe(false)
    answerPrismFeatures(DID, ['private'])
    mockDisplayOn = false
    expect(hidesGateControls(PRIVATE)).toBe(false)
  })

  it('follow the root: a private reply under a public root keeps them out', () => {
    answerPrismFeatures(DID, ['private', 'private.gates'])
    expect(hidesGateControls(PRIVATE_REPLY, PRIVATE)).toBe(false)
    expect(hidesGateControls(PRIVATE_REPLY, PUBLIC)).toBe(true)
    expect(hidesGateControls(PUBLIC, PUBLIC)).toBe(false)
  })

  it("Menu 3 waits for this run's answer; Anchor 2 reads a loaded list", () => {
    loadPrismFeatures(DID, ['private', 'private.gates'])
    expect(hidesGateControls(PRIVATE)).toBe(false)
    expect(hidesGateControls(PRIVATE, PRIVATE, {forWrite: true})).toBe(true)
    expect(hidesDetachQuote(PRIVATE, PRIVATE_REPLY)).toBe(true)
    answerPrismFeatures(DID, ['private', 'private.gates'])
    expect(hidesGateControls(PRIVATE, PRIVATE, {forWrite: true})).toBe(false)
  })

  it('hide reply (hidden replies 5.1): offered under a public root, under a private one once prism applies its gates', () => {
    // A private reply under a public root: the press writes the root's own gate.
    expect(hidesHideReply(PRIVATE_REPLY, PUBLIC)).toBe(false)
    // Under a private root, only once `private.gates` is answered in this run.
    expect(hidesHideReply(PRIVATE_REPLY, PRIVATE)).toBe(true)
    loadPrismFeatures(DID, ['private', 'private.gates'])
    expect(hidesHideReply(PRIVATE_REPLY, PRIVATE)).toBe(true)
    answerPrismFeatures(DID, ['private', 'private.gates'])
    expect(hidesHideReply(PRIVATE_REPLY, PRIVATE)).toBe(false)
    // Public posts are stock.
    expect(hidesHideReply(PUBLIC, PUBLIC)).toBe(false)
    // Who can reply is unchanged: still left out under a public root.
    expect(hidesGateControls(PRIVATE_REPLY, PUBLIC)).toBe(true)
    expect(
      hidesGateControls(PRIVATE_REPLY, PUBLIC, {forWrite: true}),
    ).toBe(true)
  })

  it('hide reply is left out while the post or its root is pending-unwritten', () => {
    answerPrismFeatures(DID, ['private', 'private.gates'])
    addPendingPost({
      uri: PRIVATE,
      did: DID,
      phase: 'sending',
    } as unknown as PendingPost)
    expect(hidesHideReply(PRIVATE_REPLY, PRIVATE)).toBe(true)
    expect(hidesHideReply(PRIVATE, PUBLIC)).toBe(true)
    clearPrivateStores()
    expect(hidesHideReply(PRIVATE_REPLY, PRIVATE)).toBe(false)
    expect(hidesHideReply(PRIVATE, PUBLIC)).toBe(false)
  })

  it('detach quote: only a private quote of a private post, once served', () => {
    expect(hidesDetachQuote(PUBLIC, PRIVATE)).toBe(false)
    expect(hidesDetachQuote(PRIVATE, PRIVATE_REPLY)).toBe(true)
    answerPrismFeatures(DID, ['private', 'private.gates'])
    expect(hidesDetachQuote(PRIVATE, PRIVATE_REPLY)).toBe(false)
    expect(hidesDetachQuote(PRIVATE, PUBLIC)).toBe(true)
    expect(hidesDetachQuote(PRIVATE, undefined)).toBe(true)
    mockDisplayOn = false
    expect(hidesDetachQuote(PRIVATE, PUBLIC)).toBe(false)
  })
})

describe('controls on private posts (Ctl 1-5, Anchor 1, Menu 4)', () => {
  it('hides counts only for a private URI, and never the bookmark (round 2 fix 6)', () => {
    expect(privateControlsFor(PRIVATE)).toEqual({hideCounts: true})
    expect(privateControlsFor(PUBLIC)).toEqual({hideCounts: false})
    expect(privateControlsFor(undefined)).toEqual({hideCounts: false})
  })

  it('returns the counts for a post whose view carried them (by data)', () => {
    countsServedOn(PRIVATE)
    expect(privateControlsFor(PRIVATE).hideCounts).toBe(false)
    expect(privateControlsFor(PRIVATE_REPLY).hideCounts).toBe(true)
  })

  it('the stats row: not served, all zero, and each count', () => {
    const post = {uri: PRIVATE, repostCount: 0, likeCount: 0, quoteCount: 0}
    expect(hidesPrivateStatsRow(post)).toBe(true)
    countsServedOn(PRIVATE)
    expect(hidesPrivateStatsRow(post)).toBe(true)
    expect(hidesPrivateStatsRow({...post, repostCount: 1})).toBe(false)
    expect(hidesPrivateStatsRow({...post, likeCount: 2})).toBe(false)
    expect(hidesPrivateStatsRow({...post, quoteCount: 3})).toBe(false)
    expect(hidesPrivateStatsRow({...post, uri: PUBLIC})).toBe(false)
  })

  it('hides Mute thread only under a private root, until prism answers it serves thread mutes', () => {
    expect(hideThreadMute(PRIVATE)).toBe(true)
    expect(hideThreadMute(PUBLIC)).toBe(false)
    loadPrismFeatures(DID, ['private', 'private.interactions'])
    expect(hideThreadMute(PRIVATE)).toBe(true)
    answerPrismFeatures(DID, ['private', 'private.interactions'])
    expect(hideThreadMute(PRIVATE)).toBe(false)
  })

  it('stops proxying links only in a private post (Proxy 1-7)', () => {
    expect(proxiesPostLinks(PRIVATE)).toBe(false)
    expect(proxiesPostLinks(PUBLIC)).toBe(true)
    expect(proxiesPostLinks(undefined)).toBe(true)
  })

  it('gives every stock answer with the display switch off', () => {
    mockDisplayOn = false
    expect(isPrivateDisplay(PRIVATE)).toBe(false)
    expect(privateControlsFor(PRIVATE)).toEqual({hideCounts: false})
    expect(hideThreadMute(PRIVATE)).toBe(false)
    expect(proxiesPostLinks(PRIVATE)).toBe(true)
    expect(isPrivateBadgeHref(`/profile/${DID}/ppost/3kpost222222`)).toBe(false)
    expect(privatePostStyle(PRIVATE, THEME)).toBe(undefined)
    expect(threadRepliesCount(PRIVATE, undefined, 1, 2)).toBe(0)
  })
})

describe('marks (Mark 1-7)', () => {
  it('locks the header row of a ppost href only', () => {
    expect(isPrivateBadgeHref(`/profile/${DID}/ppost/3kpost222222`)).toBe(true)
    expect(isPrivateBadgeHref(`/profile/${DID}/post/3kpost222222`)).toBe(false)
    expect(isPrivateBadgeHref('')).toBe(false)
  })

  /*
   * No renderer calls the border since round 2 (fix 4, a trial look); the
   * helper stays so it can come back with its call sites.
   */
  it('still builds the border for a private post only (LC 1), uncalled since round 2', () => {
    expect(privatePostStyle(PRIVATE, THEME)).toEqual({
      boxShadow: 'inset 3px 0 0 0 #0070ff',
    })
    expect(privatePostStyle(PUBLIC, THEME)).toBe(undefined)
  })
})

describe('thread reply lines (Thread 3)', () => {
  it('keeps the stock reply count for a public post', () => {
    expect(threadRepliesCount(PUBLIC, 5, 1, 1)).toBe(5)
    expect(threadRepliesCount(PUBLIC, undefined, 1, 2)).toBe(0)
  })

  it('counts a private post as replied to when the next item is deeper', () => {
    expect(threadRepliesCount(PRIVATE, undefined, 1, 2)).toBe(1)
    expect(threadRepliesCount(PRIVATE, undefined, 1, 1)).toBe(0)
    expect(threadRepliesCount(PRIVATE, undefined, 2, undefined)).toBe(0)
  })

  it('uses the served reply count once prism serves counts', () => {
    countsServedOn(PRIVATE)
    expect(threadRepliesCount(PRIVATE, 4, 1, 1)).toBe(4)
    expect(threadRepliesCount(PRIVATE, 0, 1, 2)).toBe(0)
  })
})

describe('the notifications mode (Notif 1-4)', () => {
  it('is Public until the account chooses Private', () => {
    expect(getNotificationsMode(DID)).toBe('public')
    setNotificationsMode(DID, 'private')
    expect(getNotificationsMode(DID)).toBe('private')
    expect(getNotificationsMode(undefined)).toBe('public')
  })

  it('is Public for another account, so an account change resets it', () => {
    setNotificationsMode(DID, 'private')
    expect(getNotificationsMode(OTHER_DID)).toBe('public')
    setNotificationsMode(OTHER_DID, 'public')
    expect(getNotificationsMode(DID)).toBe('public')
  })

  it('shows the Private view to members who chose it, with the switch on', () => {
    expect(showsPrivateNotifications({mode: 'private', isMember: true})).toBe(
      true,
    )
    expect(showsPrivateNotifications({mode: 'private', isMember: false})).toBe(
      false,
    )
    expect(showsPrivateNotifications({mode: 'public', isMember: true})).toBe(
      false,
    )
    expect(offersNotificationsSwitch(true)).toBe(true)
    expect(offersNotificationsSwitch(false)).toBe(false)
    mockNotificationsSwitchOn = false
    expect(showsPrivateNotifications({mode: 'private', isMember: true})).toBe(
      false,
    )
    expect(offersNotificationsSwitch(true)).toBe(false)
  })
})
