/*
 * Account operations that need the account password. Under an OAuth session
 * the gate asks for the password and converts the session to a password
 * session in place; the operation then runs over it.
 *
 * Adapted from the Witchsky client (MIT),
 * src/components/dialogs/LegacyAuthRequiredDialog.tsx
 * (`LegacyAuthRequiredDialogContent`: the password and 2FA form and its error
 * mapping).
 */

import {useEffect, useRef, useState, useSyncExternalStore} from 'react'
import {View} from 'react-native'
import {LexAuthFactorError} from '@atproto/lex-password-session'
import {Trans, useLingui} from '@lingui/react/macro'
import {useQueryClient} from '@tanstack/react-query'

import {cleanError, isNetworkError} from '#/lib/strings/errors'
import {logger} from '#/logger'
import {type SessionAccount, useSession, useSessionApi} from '#/state/session'
import {atoms as a, useTheme, web} from '#/alf'
import {Admonition} from '#/components/Admonition'
import {Button, ButtonIcon, ButtonText} from '#/components/Button'
import * as Dialog from '#/components/Dialog'
import * as TextField from '#/components/forms/TextField'
import {Lock_Stroke2_Corner0_Rounded as LockIcon} from '#/components/icons/Lock'
import {Ticket_Stroke2_Corner0_Rounded as TicketIcon} from '#/components/icons/Ticket'
import {Loader} from '#/components/Loader'
import * as Prompt from '#/components/Prompt'
import {Text} from '#/components/Typography'
import {isOauthAccount} from '#/horizon/session/accounts'
import {revokeOAuthGrant} from '#/horizon/session/sign-out'

/**
 * The password form. On success the session is a password session for the
 * same DID (the tree does not remount), and the old OAuth grant is revoked
 * and deleted.
 */
function PasswordGateForm({
  heading = 'plain',
  onConverted,
}: {
  heading?: 'plain' | 'prompt'
  onConverted?: () => void
}) {
  const t = useTheme()
  const {t: l} = useLingui()
  const {currentAccount} = useSession()
  const {login} = useSessionApi()
  const queryClient = useQueryClient()
  const passwordRef = useRef('')
  const [isProcessing, setIsProcessing] = useState(false)
  const [error, setError] = useState('')
  const [needs2fa, setNeeds2fa] = useState(false)
  const [authFactorToken, setAuthFactorToken] = useState('')

  const onSubmit = async () => {
    if (!currentAccount || isProcessing) return
    const password = passwordRef.current
    if (!password) {
      setError(l`Please enter your password`)
      return
    }
    const did = currentAccount.did
    setError('')
    setIsProcessing(true)
    try {
      await login(
        {
          service: currentAccount.pdsUrl ?? currentAccount.service,
          identifier: currentAccount.handle,
          password,
          authFactorToken: authFactorToken.trim(),
        },
        'Settings',
      )
      void revokeOAuthGrant(did)
      /*
       * A gated screen may have fetched before the gate (its query sits
       * outside it) and failed under OAuth; the same DID means the tree does
       * not remount, so retry every failed query over the password session.
       */
      void queryClient.refetchQueries({
        predicate: query => query.state.status === 'error',
      })
      onConverted?.()
    } catch (err) {
      setIsProcessing(false)
      const message = String(err)
      if (err instanceof LexAuthFactorError) {
        setNeeds2fa(true)
        return
      }
      if (message.includes('Token is invalid')) {
        setError(l`Invalid 2FA confirmation code.`)
      } else if (
        message.includes('Authentication Required') ||
        message.includes('Invalid identifier or password')
      ) {
        setError(l`Incorrect password`)
      } else if (isNetworkError(err)) {
        logger.warn('password gate: network error', {error: message})
        setError(
          l`Unable to contact your service. Please check your Internet connection.`,
        )
      } else {
        logger.warn('password gate: sign-in failed', {error: message})
        setError(cleanError(err))
      }
    }
  }

  const title = <Trans>Enter your password</Trans>
  const description = (
    <Trans>
      You're signed in with OAuth. This needs your account password; entering it
      switches this session to a password session.
    </Trans>
  )

  return (
    <View style={[a.gap_md, a.w_full]}>
      {heading === 'prompt' ? (
        <View>
          <Prompt.TitleText>{title}</Prompt.TitleText>
          <Prompt.DescriptionText>{description}</Prompt.DescriptionText>
        </View>
      ) : (
        <View style={[a.gap_sm]}>
          <Text style={[a.text_xl, a.font_semi_bold, a.leading_snug]}>
            {title}
          </Text>
          <Text
            style={[a.text_md, a.leading_snug, t.atoms.text_contrast_medium]}>
            {description}
          </Text>
        </View>
      )}

      {error ? <Admonition type="error">{error}</Admonition> : null}

      <View>
        <TextField.LabelText>
          <Trans>Password</Trans>
        </TextField.LabelText>
        <TextField.Root isInvalid={!!error && !needs2fa}>
          <TextField.Icon icon={LockIcon} />
          <TextField.Input
            testID="passwordGateInput"
            label={l`Password`}
            placeholder={null}
            autoCapitalize="none"
            autoCorrect={false}
            autoComplete="current-password"
            returnKeyType={needs2fa ? 'next' : 'done'}
            secureTextEntry
            editable={!isProcessing}
            onChangeText={value => {
              passwordRef.current = value
              if (error) setError('')
            }}
            onSubmitEditing={() => {
              if (!needs2fa) void onSubmit()
            }}
          />
        </TextField.Root>
      </View>

      {needs2fa ? (
        <View>
          <TextField.LabelText>
            <Trans>2FA confirmation code</Trans>
          </TextField.LabelText>
          <TextField.Root>
            <TextField.Icon icon={TicketIcon} />
            <TextField.Input
              testID="passwordGate2faInput"
              label={l`2FA confirmation code`}
              placeholder={null}
              autoCapitalize="none"
              autoCorrect={false}
              autoComplete="one-time-code"
              returnKeyType="done"
              editable={!isProcessing}
              value={authFactorToken}
              onChangeText={value => {
                setAuthFactorToken(value)
                if (error) setError('')
              }}
              onSubmitEditing={() => void onSubmit()}
            />
          </TextField.Root>
          <Text style={[a.text_sm, a.mt_sm, t.atoms.text_contrast_medium]}>
            <Trans>
              Check your email for a sign in code and enter it here.
            </Trans>
          </Text>
        </View>
      ) : null}

      <Button
        testID="passwordGateSubmitButton"
        label={l`Continue with password`}
        size="large"
        color="primary"
        disabled={isProcessing}
        onPress={() => void onSubmit()}>
        <ButtonText>
          <Trans>Continue with password</Trans>
        </ButtonText>
        {isProcessing && <ButtonIcon icon={Loader} />}
      </Button>
    </View>
  )
}

/**
 * Render `children` for a password session. For an OAuth session, render the
 * password form in their place; once the session is converted, `children`
 * render over the password session.
 *
 * - `container="prompt"`: directly under a `Prompt.Outer` (whose inner
 *   container is already there), with prompt heading styles.
 * - `container="dialog"`: directly under a `Dialog.Outer`; the form gets its
 *   own inner container and close button.
 * - `inline`: inside an existing inner container; the form alone.
 * - neither: on a screen, padded.
 */
export function PasswordSessionGate({
  children,
  container,
  inline = false,
}: {
  children: React.ReactNode
  container?: 'prompt' | 'dialog'
  inline?: boolean
}) {
  const {t: l} = useLingui()
  const {currentAccount} = useSession()
  if (!isOauthAccount(currentAccount)) return <>{children}</>

  if (inline) return <PasswordGateForm />
  if (container === 'prompt') return <PasswordGateForm heading="prompt" />
  if (container === 'dialog') {
    return (
      <Dialog.ScrollableInner
        label={l`Enter your password`}
        style={web({maxWidth: 400})}>
        <PasswordGateForm />
        <Dialog.Close />
      </Dialog.ScrollableInner>
    )
  }
  return (
    <View style={[a.p_lg, a.w_full, web({maxWidth: 480})]}>
      <PasswordGateForm />
    </View>
  )
}

let accountSnapshot: SessionAccount | undefined
let dialogRequested = false
const dialogListeners = new Set<() => void>()

function setDialogRequested(value: boolean) {
  dialogRequested = value
  dialogListeners.forEach(listener => listener())
}

function subscribeDialog(listener: () => void) {
  dialogListeners.add(listener)
  return () => {
    dialogListeners.delete(listener)
  }
}

/**
 * Wrap a button handler that needs a password session. Under an OAuth session
 * pressing it opens the password dialog instead; after converting, the user
 * presses again. Otherwise the handler runs as before.
 */
export function guardPasswordSession<Args extends unknown[]>(
  handler: (...args: Args) => unknown,
): (...args: Args) => void {
  return (...args) => {
    if (isOauthAccount(accountSnapshot)) {
      setDialogRequested(true)
      return
    }
    void handler(...args)
  }
}

/**
 * The dialog `guardPasswordSession` opens, mounted once by `HorizonHost`. It
 * also keeps the account snapshot the guard reads at press time.
 */
export function PasswordGateDialog() {
  const {t: l} = useLingui()
  const {currentAccount} = useSession()
  const control = Dialog.useDialogControl()
  const requested = useSyncExternalStore(subscribeDialog, () => dialogRequested)

  useEffect(() => {
    accountSnapshot = currentAccount
  }, [currentAccount])

  useEffect(() => {
    if (requested) control.open()
  }, [requested, control])

  return (
    <Dialog.Outer control={control} onClose={() => setDialogRequested(false)}>
      <Dialog.Handle />
      <Dialog.ScrollableInner
        label={l`Enter your password`}
        style={web({maxWidth: 400})}>
        <PasswordGateForm onConverted={() => control.close()} />
        <Dialog.Close />
      </Dialog.ScrollableInner>
    </Dialog.Outer>
  )
}
