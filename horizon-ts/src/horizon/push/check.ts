/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

/*
 * Turn a "check" into notifications for one account: read its notifications
 * (and DMs) with its own sign-in, apply its push settings, and show what is
 * new. Runs in the background tasks, possibly in a JS runtime the app UI
 * never started, so it loads what it needs (stored accounts, language) itself.
 */

import * as Notifications from 'expo-notifications'
import {type Client} from '@atproto/lex'
import BackgroundNotificationHandler from '@bsky.app/expo-background-notification-handler'
import {i18n} from '@lingui/core'

import {sanitizeAppLanguageSetting} from '#/locale/helpers'
import {dynamicActivate} from '#/locale/i18n'
import {logger} from '#/logger'
import * as persisted from '#/state/persisted'
import {nearhorizon} from '#/horizon/lexicons'
import {getPrismClient} from '#/horizon/routing/prism'
import {PRIVATE_NOTIFICATIONS_SWITCH} from '#/horizon/switches'
import {app, chat} from '#/lexicons'
import {device} from '#/storage'
import {openClients} from './clients'
import {
  describe,
  MAX_SINGLE,
  newestShown,
  pickNew,
  type Shown,
  subjectsToFetch,
  summarize,
} from './pick'
import {describeDm, newestDmShown, pickNewDms} from './pick-dm'

type Notif = app.bsky.notification.listNotifications.Notification
type Prefs = app.bsky.notification.defs.Preferences

/** What to look at: public notifications, kryphocron ones (prism), DMs. */
export type CheckWhat = {activity: boolean; private: boolean; dms: boolean}

/** One check at a time per account; asks made meanwhile run once after. */
const running = new Map<string, Promise<void>>()
const pending = new Map<string, CheckWhat>()

/** How long to wait for the AppView when the first read finds nothing new. */
const RETRY_EMPTY_MS = 4_000

export function checkAccount(did: string, what: CheckWhat): Promise<void> {
  const queued = pending.get(did)
  pending.set(did, {
    activity: what.activity || Boolean(queued?.activity),
    private: what.private || Boolean(queued?.private),
    dms: what.dms || Boolean(queued?.dms),
  })
  const current = running.get(did)
  if (current) return current
  const run = (async () => {
    try {
      let next = pending.get(did)
      while (next) {
        pending.delete(did)
        await checkOnce(did, next)
        next = pending.get(did)
      }
    } finally {
      running.delete(did)
    }
  })()
  running.set(did, run)
  return run
}

/**
 * Loads the stored app state. Named apart from `init` because a source guard
 * keeps the OAuth client's session restore out of src/horizon; this is not it.
 */
const loadPersistedState = persisted.init

/** Stored accounts and the app language, loaded if this runtime has not yet. */
export async function ready() {
  if (persisted.get('session').accounts.length === 0) {
    await loadPersistedState()
  }
  if (!i18n.locale) {
    const language = persisted.get('languagePrefs').appLanguage
    await dynamicActivate(sanitizeAppLanguageSetting(language))
  }
}

async function checkOnce(did: string, what: CheckWhat) {
  await ready()
  const account = persisted.get('session').accounts.find(a => a.did === did)
  if (!account) return
  const clients = openClients(account)
  if (!clients) return
  try {
    await Promise.all([
      what.activity ? showActivity(clients.appview, did) : undefined,
      what.private ? showPrivate(clients.pds, did) : undefined,
      what.dms ? showDms(clients.chat, did) : undefined,
    ])
  } finally {
    clients.dispose()
  }
}

async function present(shown: Shown[]) {
  for (const s of shown) {
    await Notifications.scheduleNotificationAsync({
      content: {
        title: s.title,
        body: s.body,
        data: {...s.data, horizonPush: true},
      },
      trigger: {channelId: s.channel},
    })
  }
}

function warn(what: string, e: unknown) {
  logger.warn(`push check: ${what} failed`, {
    message: e instanceof Error ? e.message : String(e),
  })
}

async function showActivity(client: Client, did: string) {
  try {
    const lastShown = device.get(['horizonPushShown'])?.[did]
    const [prefs, first] = await Promise.all([
      client
        .call(app.bsky.notification.getPreferences)
        .then(r => r.preferences)
        .catch(() => undefined),
      client.call(app.bsky.notification.listNotifications, {limit: 30}),
    ])
    let picked = pickNew(first.notifications, {prefs, lastShown, now: Date.now()})
    if (picked.length === 0) {
      // The push can beat the AppView's indexing by a moment: look once more
      await new Promise(r => setTimeout(r, RETRY_EMPTY_MS))
      const again = await client.call(app.bsky.notification.listNotifications, {
        limit: 30,
      })
      picked = pickNew(again.notifications, {prefs, lastShown, now: Date.now()})
    }
    if (picked.length === 0) return

    const shown: Shown[] = []
    if (picked.length > MAX_SINGLE) {
      shown.push(summarize(i18n, picked.length, did))
    } else {
      const texts = await subjectTexts(client, subjectsToFetch(picked))
      for (const n of picked) {
        shown.push(
          describe(i18n, n, did, n.reasonSubject ? texts.get(n.reasonSubject) : undefined),
        )
      }
    }
    await present(shown)
    device.set(['horizonPushShown'], {
      ...device.get(['horizonPushShown']),
      [did]: newestShown(picked, lastShown) ?? '',
    })
  } catch (e) {
    warn('notifications', e)
  }
}

/**
 * kryphocron notifications, read from prism with the account's sign-in;
 * prism checks permissions live on every read, so only what it serves now
 * is shown. An account that is not a member gets an error and nothing shows.
 */
async function showPrivate(pds: Client, did: string) {
  if (!PRIVATE_NOTIFICATIONS_SWITCH) return
  try {
    const prism = getPrismClient(pds)
    const lastShown = device.get(['horizonPushShownPrivate'])?.[did]
    const [prefs, page] = await Promise.all([
      prism
        .call(nearhorizon.privateGetNotificationPreferences)
        .then(r => r.preferences as unknown as Prefs)
        .catch(() => undefined),
      prism.call(nearhorizon.privateListNotifications, {limit: 30}),
    ])
    const picked = pickNew(page.notifications as unknown as Notif[], {
      prefs,
      lastShown,
      now: Date.now(),
    })
    if (picked.length === 0) return
    await present(
      picked.length > MAX_SINGLE
        ? [summarize(i18n, picked.length, did)]
        : picked.map(n => describe(i18n, n, did)),
    )
    device.set(['horizonPushShownPrivate'], {
      ...device.get(['horizonPushShownPrivate']),
      [did]: newestShown(picked, lastShown) ?? '',
    })
  } catch {
    // Not a member, not ready, or prism busy: nothing to show now
  }
}

async function subjectTexts(client: Client, uris: string[]) {
  const texts = new Map<string, string>()
  if (!uris.length) return texts
  try {
    const {posts} = await client.call(app.bsky.feed.getPosts, {
      uris: uris as never,
    })
    for (const post of posts) {
      const text = (post.record as {text?: unknown}).text
      if (typeof text === 'string' && text.trim()) texts.set(post.uri, text)
    }
  } catch {
    // Shown without the post text
  }
  return texts
}

async function showDms(client: Client, did: string) {
  try {
    const lastShown = device.get(['horizonPushShownDm'])?.[did]
    const [prefs, {convos}] = await Promise.all([
      client
        .call(chat.bsky.notification.getPreferences)
        .then(r => r.preferences)
        .catch(() => undefined),
      client.call(chat.bsky.convo.listConvos, {readState: 'unread', limit: 20}),
    ])
    const picked = pickNewDms(convos, {me: did, prefs, lastShown, now: Date.now()})
    if (picked.length === 0) return
    // Bluesky's "play a sound for chat" setting picks the channel
    const sound = await BackgroundNotificationHandler.getBoolAsync('playSoundChat').catch(
      () => true,
    )
    await present(
      picked.map(convo => ({
        ...describeDm(i18n, convo, did),
        channel: sound ? 'chat-messages' : 'chat-messages-muted',
      })),
    )
    device.set(['horizonPushShownDm'], {
      ...device.get(['horizonPushShownDm']),
      [did]: newestDmShown(picked, lastShown) ?? '',
    })
  } catch (e) {
    warn('DMs', e)
  }
}
