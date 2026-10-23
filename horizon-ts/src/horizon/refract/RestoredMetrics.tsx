import {View} from 'react-native'

import {atoms as a, useTheme} from '#/alf'
import {Text} from '#/components/Typography'

/**
 * A restored account's follower, following and post counts as plain text,
 * not links (refract client design 4.1, Q5): the stock lists can't show this
 * account's followers or follows until prism serves them (RF-S3). Same
 * layout as the stock metrics row.
 */
export function RestoredProfileMetrics({
  followers,
  followersLabel,
  following,
  followingLabel,
  posts,
  postsLabel,
}: {
  followers: string
  followersLabel: string
  following: string
  followingLabel: string
  posts: string
  postsLabel: string
}) {
  const t = useTheme()
  const pair = (testID: string, count: string, label: string) => (
    <Text testID={testID} style={[a.font_semi_bold, t.atoms.text, a.text_md]}>
      {count}{' '}
      <Text style={[t.atoms.text_contrast_medium, a.font_normal, a.text_md]}>
        {label}
      </Text>
    </Text>
  )
  return (
    <View
      style={[a.flex_row, a.gap_sm, a.align_center]}
      pointerEvents="box-none">
      {pair('profileHeaderFollowersCount', followers, followersLabel)}
      {pair('profileHeaderFollowsCount', following, followingLabel)}
      {pair('profileHeaderPostsCount', posts, postsLabel)}
    </View>
  )
}
