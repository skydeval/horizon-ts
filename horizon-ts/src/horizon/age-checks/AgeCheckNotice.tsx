/*
 * Why adult content is locked off by the app's age check, by the adult
 * content setting (Moderation), with the way to change it where there is
 * one. Nothing where no age check applies or adult content is open.
 */

import {View} from 'react-native'
import {Trans, useLingui} from '@lingui/react/macro'

import {atoms as a, type ViewStyleProp} from '#/alf'
import {Admonition} from '#/components/Admonition'
import {Button, ButtonIcon, ButtonText} from '#/components/Button'
import {Loader} from '#/components/Loader'
import {
  blocksApp,
  checkAgeAgain,
  locksAdultContent,
  useAgeCheck,
} from '#/horizon/age-checks'
import {openInStore} from '#/horizon/age-checks/store-link'

export function AgeCheckNotice({style}: ViewStyleProp) {
  const {t: l} = useLingui()
  const check = useAgeCheck()
  if (!check) return null
  const {outcome, region, checking} = check
  if (!locksAdultContent(outcome) || blocksApp(outcome)) return null
  const state = region.name

  const message =
    outcome === 'teen' ? (
      <Trans>
        Adult content is off. Google Play says you’re under 18, and apps in{' '}
        {state} must follow the age a phone’s app store reports.
      </Trans>
    ) : outcome === 'parentPending' ? (
      <Trans>
        Adult content is off until a parent or guardian approves Horizon’s
        latest update in Google Play.
      </Trans>
    ) : outcome === 'verify' ? (
      <Trans>
        Adult content is off until you confirm your age in Google Play. Apps in{' '}
        {state} must follow the age a phone’s app store reports.
      </Trans>
    ) : outcome === 'unknown' ? (
      <Trans>
        Adult content is off because Google Play didn’t share an age range.
        Apps in {state} must follow the age a phone’s app store reports.
      </Trans>
    ) : (
      <Trans>
        Adult content is off until you share your age range through Google
        Play. Apps in {state} must follow the age a phone’s app store reports.
      </Trans>
    )

  const showShare = outcome === 'unshared' || outcome === 'unknown'
  const showStore = outcome === 'verify' || outcome === 'parentPending'

  return (
    <View style={[a.gap_md, style]}>
      <Admonition type="info">{message}</Admonition>
      <View style={[a.flex_row, a.flex_wrap, a.gap_sm]}>
        {showShare && (
          <Button
            label={l`Share my age range through Google Play`}
            size="small"
            color="primary"
            disabled={checking}
            onPress={() => void checkAgeAgain({prompt: true})}>
            {checking && <ButtonIcon icon={Loader} />}
            <ButtonText>
              <Trans>Share age range</Trans>
            </ButtonText>
          </Button>
        )}
        {showStore && (
          <>
            <Button
              label={l`Open Horizon in Google Play`}
              size="small"
              color="primary"
              onPress={() => void openInStore()}>
              <ButtonText>
                <Trans>Open Google Play</Trans>
              </ButtonText>
            </Button>
            <Button
              label={l`Check my age again`}
              size="small"
              color="secondary"
              disabled={checking}
              onPress={() => void checkAgeAgain({prompt: true})}>
              {checking && <ButtonIcon icon={Loader} />}
              <ButtonText>
                <Trans>Check again</Trans>
              </ButtonText>
            </Button>
          </>
        )}
      </View>
    </View>
  )
}
