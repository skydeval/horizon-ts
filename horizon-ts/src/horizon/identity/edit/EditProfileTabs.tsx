/*
 * Edit Profile's two tabs (Phase 5 design 7.2, hook ID-20): "Profile", the
 * stock content, and "Plurality". Mounted by the stock dialog around its
 * body. The stock content stays mounted while the Plurality tab shows, so
 * nothing typed in it is lost. With `PLURAL_EDITING` off, or for another
 * account, the stock body alone.
 */

import {useState} from 'react'
import {View} from 'react-native'
import {useLingui} from '@lingui/react/macro'

import {useSession} from '#/state/session'
import {atoms as a} from '#/alf'
import * as SegmentedControl from '#/components/forms/SegmentedControl'
import {PluralityTab} from '#/horizon/identity/edit/PluralityTab'
import {PLURAL_EDITING} from '#/horizon/switches'

type Tab = 'profile' | 'plurality'

export function EditProfileTabs({
  profile,
  children,
}: {
  profile: {did: string}
  children: React.ReactNode
}) {
  const {t: l} = useLingui()
  const {currentAccount} = useSession()
  const [tab, setTab] = useState<Tab>('profile')
  if (!PLURAL_EDITING || currentAccount?.did !== profile.did) {
    return <>{children}</>
  }
  return (
    <>
      <View style={[a.px_xl, a.py_md]}>
        <SegmentedControl.Root
          type="tabs"
          size="small"
          label={l`Edit profile sections`}
          value={tab}
          onChange={setTab}>
          <SegmentedControl.Item
            testID="editProfileTabProfile"
            value="profile"
            label={l`Profile`}>
            <SegmentedControl.ItemText>{l`Profile`}</SegmentedControl.ItemText>
          </SegmentedControl.Item>
          <SegmentedControl.Item
            testID="editProfileTabPlurality"
            value="plurality"
            label={l`Plurality`}>
            <SegmentedControl.ItemText>
              {l`Plurality`}
            </SegmentedControl.ItemText>
          </SegmentedControl.Item>
        </SegmentedControl.Root>
      </View>
      <View style={tab === 'profile' ? undefined : {display: 'none'}}>
        {children}
      </View>
      {tab === 'plurality' ? <PluralityTab did={profile.did} /> : null}
    </>
  )
}
