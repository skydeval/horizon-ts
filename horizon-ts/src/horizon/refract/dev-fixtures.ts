/*
 * The development fixtures (refract client design 11.3): with
 * `REFRACT_DEV_FIXTURES` on in a development build, the seven refract methods
 * are answered from the synthetic fixtures, so the screens can be checked
 * without reading any real account. Never on in a shipped build
 * (`devFixturesActive`).
 */

import {
  RF_DID,
  rfAuthorFeedPage,
  rfFillAnswer,
  rfPost,
  rfProfile,
  rfThread,
  rfUri,
} from '#/horizon/refract/fixtures'
import {type RefractMethod} from '#/horizon/refract/lexicon'

function stringsOf(value: unknown): string[] {
  if (Array.isArray(value)) {
    return value.filter((item): item is string => typeof item === 'string')
  }
  return typeof value === 'string' ? [value] : []
}

/** Answer one call from the fixtures. */
export function answerDevFixture(
  method: RefractMethod,
  params: Record<string, unknown>,
): Promise<{body: unknown; proxied: boolean}> {
  return Promise.resolve(answerOf(method, params))
}

function answerOf(
  method: RefractMethod,
  params: Record<string, unknown>,
): {body: unknown; proxied: boolean} {
  switch (method) {
    case 'app.nearhorizon.refract.fill': {
      const dids = stringsOf(params.dids)
      const uris = stringsOf(params.uris)
      return {
        body: rfFillAnswer({
          profiles: dids.includes(RF_DID) ? [rfProfile()] : [],
          posts: uris
            .filter(uri => uri.startsWith(`at://${RF_DID}/`))
            .map(uri => rfPost(uri.split('/').pop() ?? 'rf1')),
          withheld: [],
          servedAs: 'member',
        }),
        proxied: false,
      }
    }
    case 'app.nearhorizon.refract.getAuthorFeed':
      return {body: rfAuthorFeedPage(), proxied: false}
    case 'app.nearhorizon.refract.getPostThread':
      return {body: rfThread(), proxied: false}
    case 'app.nearhorizon.refract.getReplies':
      return {
        body: {
          posts: [
            rfPost('rfreply', {
              reply: {parent: rfUri('rf1'), root: rfUri('rf1')},
            }),
          ],
        },
        proxied: false,
      }
    case 'app.nearhorizon.refract.getTimeline':
      return {body: {feed: []}, proxied: false}
    case 'app.nearhorizon.refract.listNotifications':
      return {body: {notifications: []}, proxied: false}
    case 'app.nearhorizon.refract.getUnreadCount':
      return {body: {count: 0}, proxied: false}
  }
}
