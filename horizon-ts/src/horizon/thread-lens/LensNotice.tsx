/*
 * The notice under the anchor (Phase 4 design 10, 11.3; hook TH-8): the
 * "incomplete" notice from `bridging`, a fallback's note, a gap-only or
 * unverified answer's note, and a failed refetch's note over a kept
 * snapshot (TL-35; with a `limited` or `off` `bridging`, the failure's note
 * first). In the stock admonition style, as a polite live region.
 *
 * It sits inside the anchor's list item, after the anchor, so the web
 * pinning offset (measured above the anchor) is the same with and without
 * it (R1-L6). It holds no timers: the anchor item can be unmounted by list
 * windowing, so the 429 automatic retry and the focus refetch live in the
 * screen hook. "Try again" is the query's `refetch`, disabled while the
 * account's 429 wait runs; the wait's end is a store event (11.5).
 */

import {View} from 'react-native'
import {useLingui} from '@lingui/react/macro'

import {useSession} from '#/state/session'
import {atoms as a} from '#/alf'
import * as Admonition from '#/components/Admonition'
import {ButtonText} from '#/components/Button'
import {THREAD_LENS} from '#/horizon/switches'
import {type LensState} from '#/horizon/thread-lens/adapt'
import {useLensWaiting, useLensWaitUntil} from '#/horizon/thread-lens/api'
import {lensNoticeLines} from '#/horizon/thread-lens/notice'
import {TRY_AGAIN} from '#/horizon/thread-lens/strings'

/** The notice for the screen's lens state, or nothing. */
export function ThreadLensNotice({
  lens,
  onRetry,
}: {
  lens: LensState
  onRetry: () => unknown
}) {
  const {t: l, i18n} = useLingui()
  const {currentAccount} = useSession()
  // Both store reads run on every render (rules of hooks).
  const waiting = useLensWaiting(currentAccount?.did)
  const waitUntil = useLensWaitUntil(currentAccount?.did)
  if (!THREAD_LENS) return null
  const lines = lensNoticeLines(lens)
  if (lines.length === 0) return null
  const retry = lines.some(line => line.retry)
  const tryAgain = i18n._(TRY_AGAIN)
  // The wait is worded by its end, never compared with the clock in render.
  const until = i18n.date(new Date(waitUntil), {timeStyle: 'medium'})
  const waitWord =
    waiting && waitUntil
      ? l({
          message: `Try again after ${until}`,
          comment:
            'Thread Lens: the try again button while Thread Lens is rate limited, with the time the wait ends',
        })
      : tryAgain
  return (
    <View
      accessibilityLiveRegion="polite"
      aria-live="polite"
      style={[a.px_lg, a.pb_md]}>
      <Admonition.Outer type="info">
        <Admonition.Row>
          <Admonition.Icon />
          <Admonition.Content>
            {lines.map(line => (
              <Admonition.Text key={line.text.id}>
                {i18n._(line.text)}
              </Admonition.Text>
            ))}
          </Admonition.Content>
          {retry ? (
            <Admonition.Button
              label={waitWord}
              color="secondary"
              disabled={waiting}
              onPress={() => {
                void onRetry()
              }}>
              <ButtonText>{waiting ? waitWord : tryAgain}</ButtonText>
            </Admonition.Button>
          ) : null}
        </Admonition.Row>
      </Admonition.Outer>
    </View>
  )
}
