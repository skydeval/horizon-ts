/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

/*
 * Answer a "check" push for one account: read its notifications and push
 * settings with its own OAuth session, then show what is new. Runs in the
 * background task, possibly in a JS runtime the app UI never started, so it
 * loads what it needs (stored accounts, language) itself.
 */

import * as Notifications from 'expo-notifications'
import {i18n} from '@lingui/core'

import {sanitizeAppLanguageSetting} from '#/locale/helpers'
import {dynamicActivate} from '#/locale/i18n'
import {logger} from '#/logger'
import * as persisted from '#/state/persisted'
import {isOauthAccount, isOAuthSignedOut} from '#/horizon/session/accounts'
import {createOAuthBundle} from '#/horizon/session/oauth-bundle-factory'
import {disposeOAuthBundle} from '#/horizon/session/oauth-bundles'
import {app} from '#/lexicons'
import {device} from '#/storage'
import {
  describe,
  MAX_SINGLE,
  newestShown,
  pickNew,
  type Shown,
  subjectsToFetch,
  summarize,
} from './pick'

/** One check at a time per account; a second asks again after the first. */
const running = new Map<string, Promise<void>>()
const again = new Set<string>()

/** How long to wait for the AppView when the first read finds nothing new. */
const RETRY_EMPTY_MS = 4_000

export function checkAccount(did: string): Promise<void> {
  const current = running.get(did)
  if (current) {
    again.add(did)
    return current
  }
  const run = (async () => {
    try {
      do {
        again.delete(did)
        await checkOnce(did)
      } while (again.has(did))
    } finally {
      running.delete(did)
    }
  })()
  running.set(did, run)
  return run
}

async function ready() {
  if (persisted.get('session').accounts.length === 0) {
    await persisted.init()
  }
  if (!i18n.locale) {
    const language = persisted.get('languagePrefs').appLanguage
    await dynamicActivate(sanitizeAppLanguageSetting(language))
  }
}

async function checkOnce(did: string) {
  await ready()
  const account = persisted.get('session').accounts.find(a => a.did === did)
  if (!account || !isOauthAccount(account) || isOAuthSignedOut(account)) return
  if (!account.service) return

  const bundle = createOAuthBundle({did, service: account.service})
  try {
    const client = bundle.appviewClient
    const lastShown = device.get(['horizonPushShown'])?.[did]
    const [prefs, first] = await Promise.all([
      client
        .call(app.bsky.notification.getPreferences)
        .then(r => r.preferences)
        .catch(() => undefined),
      client.call(app.bsky.notification.listNotifications, {limit: 30}),
    ])
    let list = first.notifications
    let picked = pickNew(list, {prefs, lastShown, now: Date.now()})
    if (picked.length === 0) {
      // The push can beat the AppView's indexing by a moment: look once more
      await new Promise(r => setTimeout(r, RETRY_EMPTY_MS))
      list = (
        await client.call(app.bsky.notification.listNotifications, {limit: 30})
      ).notifications
      picked = pickNew(list, {prefs, lastShown, now: Date.now()})
    }
    if (picked.length === 0) return

    const shown: Shown[] = []
    if (picked.length > MAX_SINGLE) {
      shown.push(summarize(i18n, picked.length, did))
    } else {
      const texts = new Map<string, string>()
      const subjects = subjectsToFetch(picked)
      if (subjects.length) {
        try {
          const {posts} = await client.call(app.bsky.feed.getPosts, {
            uris: subjects as never,
          })
          for (const post of posts) {
            const text = (post.record as {text?: unknown}).text
            if (typeof text === 'string' && text.trim()) texts.set(post.uri, text)
          }
        } catch {
          // Shown without the post text
        }
      }
      for (const n of picked) {
        shown.push(
          describe(
            i18n,
            n,
            did,
            n.reasonSubject ? texts.get(n.reasonSubject) : undefined,
          ),
        )
      }
    }

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
    device.set(['horizonPushShown'], {
      ...device.get(['horizonPushShown']),
      [did]: newestShown(picked, lastShown) ?? '',
    })
  } catch (e) {
    logger.warn('push check failed', {
      message: e instanceof Error ? e.message : String(e),
    })
  } finally {
    disposeOAuthBundle(bundle)
  }
}
