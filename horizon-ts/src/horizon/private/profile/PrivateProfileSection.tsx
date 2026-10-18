import {useLingui} from '@lingui/react/macro'

import {type FeedDescriptor} from '#/state/queries/post-feed'
import {type ListRef} from '#/view/com/util/List'
import {ProfileFeedSection} from '#/screens/Profile/Sections/Feed'
import {type SectionRef} from '#/screens/Profile/Sections/types'
import {Lock_Stroke2_Corner0_Rounded as LockIcon} from '#/components/icons/Lock'
import {privateTabDescriptor} from '#/horizon/private/feed/keys'

/**
 * A profile's Private tab (6.4): the private posts of `did` that the reader
 * may view, through the stock profile feed section. `ref` is the section's,
 * so the profile's own scroll-to-top handler (soft reset, pressing the
 * selected tab) reaches it like any stock tab.
 */
export function PrivateProfileSection({
  ref,
  did,
  headerHeight,
  isFocused,
  scrollElRef,
  setScrollViewTag,
}: {
  ref?: React.Ref<SectionRef>
  did: string
  headerHeight: number
  isFocused: boolean
  scrollElRef: unknown
  setScrollViewTag: (tag: number | null) => void
}) {
  const {t: l} = useLingui()
  return (
    <ProfileFeedSection
      ref={ref}
      /*
       * Cast here rather than widening the stock `FeedDescriptor`: the stock
       * code reads an `author|` descriptor with any filter safely.
       */
      feed={privateTabDescriptor(did) as FeedDescriptor}
      headerHeight={headerHeight}
      isFocused={isFocused}
      scrollElRef={scrollElRef as ListRef}
      ignoreFilterFor={did}
      setScrollViewTag={setScrollViewTag}
      emptyStateMessage={l`No private posts you can see`}
      emptyStateIcon={LockIcon}
    />
  )
}
