/*
 * The author line of a notification row about someone else's post (Mark 9,
 * 2H design 10.4, H-8): for a private post (a reply, quote or mention
 * written privately) the corner lock at the right end of the line, as on
 * every other private post rendering but the thread anchor. A public post's
 * line is the child alone.
 */

import {View} from 'react-native'
import {AtUri} from '@atproto/syntax'

import {atoms as a} from '#/alf'
import {isPrivateDisplay} from '#/horizon/private/render/controls'
import {PrivateHeaderLock} from '#/horizon/private/render/PrivateBadge'
import {privatePostPath} from '#/horizon/private/uri'

function lockHref(uri: string): string | undefined {
  try {
    const urip = new AtUri(uri)
    return privatePostPath(urip.host, urip.rkey)
  } catch {
    return undefined
  }
}

export function PrivateAuthorRow({
  uri,
  children,
}: {
  uri: string
  children: React.ReactNode
}) {
  const href = isPrivateDisplay(uri) ? lockHref(uri) : undefined
  if (!href) return children
  return (
    <View style={[a.flex_row, a.align_center, a.gap_xs]}>
      <View style={[a.flex_shrink]}>{children}</View>
      <PrivateHeaderLock postHref={href} />
    </View>
  )
}
