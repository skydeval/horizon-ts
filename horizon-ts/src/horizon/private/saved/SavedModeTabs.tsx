import {useLingui} from '@lingui/react/macro'

import {useSession} from '#/state/session'
import * as Layout from '#/components/Layout'
import {useIsMember} from '#/horizon/private/membership'
import {
  offersSavedSwitch,
  type SavedMode,
  setSavedMode,
  useSavedMode,
} from '#/horizon/private/saved/mode'
import {FolderTabs} from '#/horizon/private/tabs/FolderTabs'

/**
 * The Public | Private folder tabs under the Saved header (Bkm 2, 9.2).
 * Members only; nothing renders for anyone else.
 *
 * Saved mounts them straight in `Layout.Screen`, which does not centre its
 * children (the header and the list each centre themselves), so the tabs sit
 * in `Layout.Center` to take the centre column, as the header does. Without
 * it they spanned the window from its left edge, under the left nav.
 */
export function SavedModeTabs() {
  const {t: l} = useLingui()
  const {currentAccount} = useSession()
  const isMember = useIsMember()
  const mode = useSavedMode()

  if (!currentAccount || !offersSavedSwitch(isMember)) return null

  return (
    <Layout.Center>
      <FolderTabs<SavedMode>
        testID="savedModeTabs"
        tabs={[
          {key: 'public', label: l`Public`},
          {key: 'private', label: l`Private`},
        ]}
        selected={mode}
        onSelect={next => setSavedMode(currentAccount.did, next)}
      />
    </Layout.Center>
  )
}
