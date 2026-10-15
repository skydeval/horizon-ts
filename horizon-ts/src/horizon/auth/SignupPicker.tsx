/*
 * The signup picker: choose a server, then create the account there with
 * OAuth (`prompt=create`) where the server offers it, or with the stock
 * password signup otherwise.
 *
 * Adapted from the Witchsky client (MIT), src/screens/Signup/providers.ts
 * (the provider list and its `describeServer` probe) and
 * src/screens/Signup/index.tsx; Horizon's rows are its own.
 */

import {useEffect, useState} from 'react'
import {View} from 'react-native'
import {Trans, useLingui} from '@lingui/react/macro'

import {BSKY_SERVICE} from '#/lib/constants'
import {LoggedOutLayout} from '#/view/com/util/layouts/LoggedOutLayout'
import {atoms as a, useTheme} from '#/alf'
import {Admonition} from '#/components/Admonition'
import {Button, ButtonIcon, ButtonText} from '#/components/Button'
import * as TextField from '#/components/forms/TextField'
import {ChevronRight_Stroke2_Corner0_Rounded as ChevronRightIcon} from '#/components/icons/Chevron'
import {Globe_Stroke2_Corner0_Rounded as GlobeIcon} from '#/components/icons/Globe'
import {Loader} from '#/components/Loader'
import {Text} from '#/components/Typography'
import {startOAuthSignup} from '#/horizon/auth/oauth-signup'
import {
  AURORA_LOCUS_SERVICE,
  normalizeServerUrl,
  oauthSignupErrorMessage,
  probeSignupServer,
  type SignupServerProbe,
  SignupServiceContext,
} from '#/horizon/auth/signup-service'
import {PRODUCT_NAME} from '#/horizon/branding'
import {OAUTH_AVAILABLE} from '#/horizon/session/oauth-client'

type ProbeState = SignupServerProbe | 'loading'

function useServerProbe(
  serviceUrl: string | undefined,
): ProbeState | undefined {
  const [probe, setProbe] = useState<{url: string; state: SignupServerProbe}>()
  useEffect(() => {
    if (!serviceUrl) return
    let cancelled = false
    void probeSignupServer(serviceUrl).then(result => {
      if (!cancelled) setProbe({url: serviceUrl, state: result})
    })
    return () => {
      cancelled = true
    }
  }, [serviceUrl])
  if (!serviceUrl) return undefined
  // Until this address has answered, it is loading.
  return probe && probe.url === serviceUrl ? probe.state : 'loading'
}

function ServerRow({
  name,
  serviceUrl,
  probe,
  onPick,
}: {
  name: string
  serviceUrl: string
  probe: ProbeState | undefined
  onPick: (serviceUrl: string, probe: SignupServerProbe) => void
}) {
  const t = useTheme()
  const {t: l} = useLingui()
  const result = probe === 'loading' ? undefined : probe
  const unavailable = !!result && !result.reachable
  return (
    <Button
      label={l`Create an account on ${name}`}
      disabled={!result || unavailable}
      onPress={() => {
        if (result) onPick(serviceUrl, result)
      }}>
      {({hovered, pressed}) => (
        <View
          style={[
            a.flex_1,
            a.flex_row,
            a.align_center,
            a.gap_md,
            a.p_lg,
            a.rounded_md,
            a.border,
            t.atoms.border_contrast_low,
            (hovered || pressed) && t.atoms.bg_contrast_25,
            unavailable && {opacity: 0.5},
          ]}>
          <View style={[a.flex_1, a.gap_2xs]}>
            <Text style={[a.text_md, a.font_semi_bold]}>{name}</Text>
            <Text style={[a.text_sm, t.atoms.text_contrast_medium]}>
              {new URL(serviceUrl).host}
            </Text>
            {unavailable ? (
              <Text style={[a.text_sm, t.atoms.text_contrast_medium]}>
                <Trans>Unavailable right now</Trans>
              </Text>
            ) : result?.inviteCodeRequired ? (
              <Text style={[a.text_sm, t.atoms.text_contrast_medium]}>
                <Trans>Invite code required</Trans>
              </Text>
            ) : null}
          </View>
          {probe === 'loading' ? (
            <Loader size="sm" />
          ) : (
            <ChevronRightIcon size="md" style={[t.atoms.text_contrast_low]} />
          )}
        </View>
      )}
    </Button>
  )
}

/**
 * The signup step of the signed-out screen. `passwordSignup` is the stock
 * signup; it mounts with the picked server preselected when that server does
 * not offer OAuth account creation.
 */
export function SignupPicker({
  onPressBack,
  passwordSignup,
}: {
  onPressBack: () => void
  passwordSignup: React.ReactNode
}) {
  const {t: l} = useLingui()
  const [passwordServer, setPasswordServer] = useState<string>()
  const [customInput, setCustomInput] = useState('')
  const [customServer, setCustomServer] = useState<string>()
  const [error, setError] = useState('')
  const [isStarting, setIsStarting] = useState(false)

  const locusProbe = useServerProbe(AURORA_LOCUS_SERVICE)
  const blueskyProbe = useServerProbe(BSKY_SERVICE)
  const customProbe = useServerProbe(customServer)

  const checkCustomServer = () => {
    setError('')
    const url = normalizeServerUrl(customInput)
    try {
      setCustomServer(url ? new URL(url).origin : undefined)
    } catch {
      setCustomServer(undefined)
      setError(l`That doesn’t look like a server address.`)
    }
  }

  const onPick = async (serviceUrl: string, probe: SignupServerProbe) => {
    setError('')
    if (!OAUTH_AVAILABLE || !probe.supportsCreatePrompt) {
      setPasswordServer(serviceUrl)
      return
    }
    setIsStarting(true)
    try {
      await startOAuthSignup(serviceUrl)
    } catch (e) {
      setIsStarting(false)
      const message = oauthSignupErrorMessage(e, {
        network: l`Unable to contact your service. Please check your Internet connection.`,
        generic: l`Something went wrong, please try again.`,
      })
      if (message) setError(message)
    }
  }

  if (passwordServer) {
    return (
      <SignupServiceContext value={passwordServer}>
        {passwordSignup}
      </SignupServiceContext>
    )
  }

  return (
    <LoggedOutLayout
      leadin=""
      title={l`Create account`}
      description={l`Choose the server that will host your account.`}
      scrollable>
      <View testID="signupPicker" style={[a.flex_1, a.gap_md, a.px_lg]}>
        <ServerRow
          name={PRODUCT_NAME}
          serviceUrl={AURORA_LOCUS_SERVICE}
          probe={locusProbe}
          onPick={(url, probe) => void onPick(url, probe)}
        />
        <ServerRow
          name={l`Bluesky`}
          serviceUrl={BSKY_SERVICE}
          probe={blueskyProbe}
          onPick={(url, probe) => void onPick(url, probe)}
        />
        <View style={[a.gap_sm]}>
          <TextField.LabelText>
            <Trans>Another server</Trans>
          </TextField.LabelText>
          <View style={[a.flex_row, a.gap_sm, a.align_center]}>
            <View style={[a.flex_1]}>
              <TextField.Root>
                <TextField.Icon icon={GlobeIcon} />
                <TextField.Input
                  testID="signupCustomServerInput"
                  label={l`Server address`}
                  placeholder="example.com"
                  autoCapitalize="none"
                  autoCorrect={false}
                  keyboardType="url"
                  value={customInput}
                  onChangeText={setCustomInput}
                  onSubmitEditing={checkCustomServer}
                />
              </TextField.Root>
            </View>
            <Button
              label={l`Check server`}
              color="secondary"
              size="large"
              onPress={checkCustomServer}>
              <ButtonText>
                <Trans>Check</Trans>
              </ButtonText>
            </Button>
          </View>
          {customServer && (
            <ServerRow
              name={new URL(customServer).host}
              serviceUrl={customServer}
              probe={customProbe}
              onPick={(url, probe) => void onPick(url, probe)}
            />
          )}
        </View>
        {error ? <Admonition type="error">{error}</Admonition> : null}
        <View style={[a.flex_row, a.align_center, a.pt_md]}>
          <Button
            label={l`Back`}
            color="secondary"
            size="large"
            onPress={onPressBack}>
            <ButtonText>
              <Trans>Back</Trans>
            </ButtonText>
          </Button>
          <View style={a.flex_1} />
          {isStarting && (
            <Button
              label={l`Starting signup`}
              color="secondary"
              size="large"
              disabled>
              <ButtonIcon icon={Loader} />
            </Button>
          )}
        </View>
      </View>
    </LoggedOutLayout>
  )
}
