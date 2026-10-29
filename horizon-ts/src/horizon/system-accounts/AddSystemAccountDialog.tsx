/*
 * "Add an account" and re-verify ("Sign in on this device", "Sign in
 * again"), system accounts design 4.3, 4.4, 4.6.
 *
 * Its own sign-in step (SA-5): it never imports the switcher's sign-in form
 * or paths. Web, in a browser tab: the server's sign-in in a popup, or an
 * app password. The Android app: the server's sign-in in the system's
 * browser sheet, or an app password. An installed web app on a phone or
 * tablet, and the iOS app (no OAuth client): the app password only (SA-17). The registration lives in `register.ts`'s
 * registry, so closing this dialog does not end a popup's wait; an outcome
 * after it closed is spoken by the shell announcer.
 */

import {useEffect, useRef, useState, useSyncExternalStore} from 'react'
import {View} from 'react-native'
import {Trans, useLingui} from '@lingui/react/macro'

import {isNetworkError} from '#/lib/strings/errors'
import {logger} from '#/logger'
import {atoms as a, useTheme, web} from '#/alf'
import {Button, ButtonIcon, ButtonText} from '#/components/Button'
import * as Dialog from '#/components/Dialog'
import * as TextField from '#/components/forms/TextField'
import {At_Stroke2_Corner0_Rounded as AtIcon} from '#/components/icons/At'
import {Lock_Stroke2_Corner0_Rounded as LockIcon} from '#/components/icons/Lock'
import {Loader} from '#/components/Loader'
import {Text} from '#/components/Typography'
import {OAUTH_AVAILABLE} from '#/horizon/session/oauth-client'
import {announce} from './announce'
import {
  resolveAccount,
  ServerIdentifierError,
  UnresolvedIdentifierError,
} from './identity'
import {isInstalledMobileWebApp} from './installed-app'
import {getList} from './list-store'
import {
  abandonPendingAttempt,
  addSwitcherAccount,
  atCap,
  beginRegistration,
  clearRegistration,
  getRegistration,
  getRegistrationVersion,
  hasPendingAttempt,
  isUsableSwitcherAccount,
  outcomeMessage,
  pressSignIn,
  type Registration,
  registrationDialogOpened,
  retryAdd,
  signInWithAppPassword,
  startAgain,
  startAgainAt,
  subscribeRegistration,
} from './register'
import {accountName, AlertMessage, StatusMessageText} from './ui'

type Step = 'identify' | 'confirm' | 'signIn' | 'password'

type Target = {did: string; handle?: string; pdsUrl?: string}

/**
 * Whether this window can use the server's sign-in (SA-17): in a popup on
 * web, in the system's browser sheet in the Android app.
 */
function popupAvailable(): boolean {
  return OAUTH_AVAILABLE && !isInstalledMobileWebApp()
}

/*
 * The registration is one mutable object (its outcome changes in place), so
 * the components reading it opt out of React Compiler: memoised reads would
 * keep the first value (`undefined`) and the dialog went blank after Next.
 */
function useRegistration(): Registration | undefined {
  'use no memo'
  useSyncExternalStore(subscribeRegistration, getRegistrationVersion)
  return getRegistration()
}

export function AddSystemAccountDialog({
  control,
  registrar,
  reverify,
  onDone,
}: {
  control: Dialog.DialogControlProps
  /** The current account, whose list this is. */
  registrar: string
  /** Re-verify this listed account instead of adding one (4.4). */
  reverify?: Target
  /** After the dialog closed with the account added or signed in. */
  onDone?: (did: string) => void
}) {
  return (
    <Dialog.Outer control={control} nativeOptions={{preventExpansion: true}}>
      <Dialog.Handle />
      <Inner
        control={control}
        registrar={registrar}
        reverify={reverify}
        onDone={onDone}
      />
    </Dialog.Outer>
  )
}

function Inner({
  control,
  registrar,
  reverify,
  onDone,
}: {
  control: Dialog.DialogControlProps
  registrar: string
  reverify?: Target
  onDone?: (did: string) => void
}) {
  'use no memo'
  const t = useTheme()
  const {t: l} = useLingui()
  const reg = useRegistration()
  const [target, setTarget] = useState<Target | undefined>(reverify)
  const [step, setStep] = useState<Step>(() =>
    reverify ? (popupAvailable() ? 'signIn' : 'password') : 'identify',
  )
  const [identifier, setIdentifier] = useState('')
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)
  const [startedAgain, setStartedAgain] = useState(false)
  const closing = useRef(false)

  // While open, outcomes are shown and read here (4.6).
  useEffect(() => {
    const closed = registrationDialogOpened()
    return () => {
      closed()
      clearRegistration(getRegistration())
    }
  }, [])

  // A re-verify starts its registration at once, and learns the PDS.
  useEffect(() => {
    if (!reverify) return
    beginRegistration(reverify, 'reverify')
    if (reverify.pdsUrl) return
    resolveAccount(reverify.did).then(
      found => {
        const current = getRegistration()
        if (current?.did === reverify.did && !current.pdsUrl) {
          current.pdsUrl = found.pdsUrl
        }
        setTarget(prev => (prev ? {...prev, pdsUrl: found.pdsUrl} : prev))
      },
      () => {},
    )
  }, [reverify])

  const mine = reg && target && reg.did === target.did ? reg : undefined
  const otherPending =
    !!reg && !!target && reg.did !== target.did && hasPendingAttempt(reg)
  const pending = hasPendingAttempt(mine)

  // **Start again** is offered 5 seconds after the press.
  const againAt = startAgainAt(mine ?? (otherPending ? reg : undefined))
  const [againReady, setAgainReady] = useState<number>()
  useEffect(() => {
    if (againAt === undefined) return
    const timer = setTimeout(
      () => setAgainReady(againAt),
      Math.max(0, againAt - Date.now()),
    )
    return () => clearTimeout(timer)
  }, [againAt])
  const canStartAgain = againAt !== undefined && againReady === againAt

  // Success closes the dialog; the outcome is then spoken by the shell.
  const outcome = mine?.outcome.kind
  useEffect(() => {
    if (!mine || closing.current) return
    if (
      outcome !== 'added' &&
      outcome !== 'signedIn' &&
      outcome !== 'signedInFor'
    )
      return
    closing.current = true
    const message = outcomeMessage(mine)
    const did = mine.did
    control.close(() => {
      if (message) announce(message.text, message.kind)
      onDone?.(did)
    })
  }, [mine, outcome, control, onDone])

  const lala = target ? accountName(target.handle, target.did) : ''
  const message = mine ? outcomeMessage(mine) : undefined
  const failure = message && message.kind === 'alert' ? message.text : undefined

  // A step with no registration behind it must never render blank.
  const lost = step !== 'identify' && !mine && !otherPending
  const lostText = l`Something went wrong. Start again.`
  useEffect(() => {
    if (!lost) return
    logger.error('system accounts: dialog step has no registration', {
      step,
      hasRegistration: !!getRegistration(),
      reverify: !!reverify,
    })
  }, [lost, step, reverify])
  const restart = () => {
    setError('')
    if (reverify) {
      beginRegistration(reverify, 'reverify')
    } else {
      setTarget(undefined)
      setStep('identify')
    }
  }

  const onNext = async () => {
    if (busy) return
    setError('')
    const value = identifier.trim()
    if (!value) {
      setError(l`Enter the account’s handle`)
      return
    }
    setBusy(true)
    try {
      const found = await resolveAccount(value)
      const name = accountName(found.handle, found.did)
      if (found.did === registrar) {
        setError(l`That’s the account you’re signed in as.`)
        return
      }
      if (getList(registrar)?.accounts.some(x => x.did === found.did)) {
        setError(l`${name} is already one of your system accounts`)
        return
      }
      if (atCap(registrar)) {
        setError(l`Up to 31 system accounts`)
        return
      }
      const next: Target = {
        did: found.did,
        handle: found.handle,
        pdsUrl: found.pdsUrl,
      }
      setTarget(next)
      beginRegistration(next, 'add')
      if (isUsableSwitcherAccount(found.did)) setStep('confirm')
      else setStep(popupAvailable() ? 'signIn' : 'password')
    } catch (e) {
      if (e instanceof ServerIdentifierError) {
        setError(l`Enter the account’s handle`)
      } else if (e instanceof UnresolvedIdentifierError) {
        setError(l`That account couldn’t be found. Check the handle.`)
      } else if (isNetworkError(e)) {
        setError(
          l`Couldn’t look up that account. Check your connection and try again.`,
        )
      } else {
        setError(l`That account couldn’t be found. Check the handle.`)
      }
    } finally {
      setBusy(false)
    }
  }

  const title = reverify ? l`Sign in as ${lala}` : l`Add an account`

  return (
    <Dialog.ScrollableInner label={title} style={web({maxWidth: 440})}>
      <View style={[a.gap_lg]}>
        <Text style={[a.text_xl, a.font_bold]}>{title}</Text>

        {step === 'identify' ? (
          <View style={[a.gap_md]}>
            <Text
              style={[a.text_md, a.leading_snug, t.atoms.text_contrast_medium]}>
              <Trans>
                Enter the handle of another account in your system. You’ll sign
                in as it to show it’s yours.
              </Trans>
            </Text>
            <View>
              <TextField.LabelText>
                <Trans>Handle or DID</Trans>
              </TextField.LabelText>
              <TextField.Root isInvalid={!!error}>
                <TextField.Icon icon={AtIcon} />
                <TextField.Input
                  testID="systemAccountsIdentifier"
                  label={l`Handle or DID`}
                  placeholder={null}
                  autoCapitalize="none"
                  autoCorrect={false}
                  autoFocus
                  returnKeyType="next"
                  editable={!busy}
                  value={identifier}
                  onChangeText={value => {
                    setIdentifier(value)
                    if (error) setError('')
                  }}
                  onSubmitEditing={() => void onNext()}
                />
              </TextField.Root>
            </View>
            {error ? (
              <AlertMessage testID="systemAccountsIdentifyError">
                {error}
              </AlertMessage>
            ) : null}
            <Button
              testID="systemAccountsNext"
              label={l`Next`}
              color="primary"
              size="large"
              disabled={busy}
              onPress={() => void onNext()}>
              <ButtonText>
                <Trans>Next</Trans>
              </ButtonText>
              {busy ? <ButtonIcon icon={Loader} /> : null}
            </Button>
          </View>
        ) : null}

        {otherPending && reg ? (
          <View style={[a.gap_md]}>
            <StatusMessageText testID="systemAccountsOtherPending">
              {l`Finish signing in to ${accountName(reg.handle, reg.did)} first, or start again.`}
            </StatusMessageText>
            <Button
              label={l`Show the sign-in window`}
              color="primary"
              size="large"
              onPress={() => {
                pressSignIn()
              }}>
              <ButtonText>
                <Trans>Show the sign-in window</Trans>
              </ButtonText>
            </Button>
            {canStartAgain && target ? (
              <Button
                label={l`Start again`}
                color="secondary"
                size="large"
                onPress={() => {
                  startAgain({...target, mode: reverify ? 'reverify' : 'add'})
                  setStartedAgain(true)
                }}>
                <ButtonText>
                  <Trans>Start again</Trans>
                </ButtonText>
              </Button>
            ) : null}
          </View>
        ) : null}

        {!otherPending && step === 'confirm' && mine ? (
          <View style={[a.gap_md]}>
            <Text style={[a.text_md, a.leading_snug]}>
              <Trans>
                {lala} is signed in on this device. Add it to your system
                accounts?
              </Trans>
            </Text>
            {failure ? <AlertMessage>{failure}</AlertMessage> : null}
            {mine.outcome.kind === 'adding' ? (
              <StatusMessageText>{l`Adding…`}</StatusMessageText>
            ) : null}
            <Button
              testID="systemAccountsConfirmAdd"
              label={l`Add ${lala} to your system accounts`}
              color="primary"
              size="large"
              disabled={mine.outcome.kind === 'adding'}
              onPress={() => {
                if (mine.outcome.kind === 'addFailed') void retryAdd()
                else void addSwitcherAccount(mine)
              }}>
              <ButtonText>
                {mine.outcome.kind === 'addFailed' ? (
                  <Trans>Try again</Trans>
                ) : (
                  <Trans>Add</Trans>
                )}
              </ButtonText>
            </Button>
          </View>
        ) : null}

        {!otherPending && step === 'signIn' && mine ? (
          <View style={[a.gap_md]}>
            <Text style={[a.text_md, a.font_semi_bold]}>{lala}</Text>
            <Text
              style={[a.text_sm, a.leading_snug, t.atoms.text_contrast_medium]}>
              <Trans>
                Your server’s page will ask to allow email and chat. Horizon
                asks for the same access as a normal sign-in, and doesn’t use
                email or chat for Posting as.
              </Trans>
            </Text>
            <Text
              style={[a.text_sm, a.leading_snug, t.atoms.text_contrast_medium]}>
              <Trans>
                You’ll have 5 minutes at your server. If you need longer, use an
                app password.
              </Trans>
            </Text>
            {pending ? (
              <StatusMessageText testID="systemAccountsWaiting">
                {l`Waiting for the sign-in window at your server.`}
              </StatusMessageText>
            ) : null}
            {mine.outcome.kind === 'adding' ? (
              <StatusMessageText>{l`Adding…`}</StatusMessageText>
            ) : null}
            {failure ? (
              <AlertMessage testID="systemAccountsSignInError">
                {failure}
              </AlertMessage>
            ) : null}
            {mine.outcome.kind === 'addFailed' ? (
              <Button
                testID="systemAccountsTryAgain"
                label={l`Try adding ${lala} again`}
                color="primary"
                size="large"
                onPress={() => void retryAdd()}>
                <ButtonText>
                  <Trans>Try again</Trans>
                </ButtonText>
              </Button>
            ) : (
              <Button
                testID="systemAccountsSignIn"
                label={
                  pending
                    ? l`Show the sign-in window`
                    : l`Sign in at your server`
                }
                accessibilityHint={l`Opens your server’s sign-in`}
                color="primary"
                size="large"
                disabled={mine.outcome.kind === 'adding'}
                onPress={() => {
                  setStartedAgain(false)
                  pressSignIn()
                }}>
                <ButtonText>
                  {pending ? (
                    <Trans>Show the sign-in window</Trans>
                  ) : (
                    <Trans>Sign in at your server</Trans>
                  )}
                </ButtonText>
              </Button>
            )}
            {pending && canStartAgain ? (
              <View style={[a.gap_sm]}>
                <Text
                  style={[
                    a.text_sm,
                    a.leading_snug,
                    t.atoms.text_contrast_medium,
                  ]}>
                  <Trans>
                    If you can’t see the sign-in window, or you closed it,
                    choose Start again.
                  </Trans>
                </Text>
                <Button
                  testID="systemAccountsStartAgain"
                  label={l`Start again`}
                  color="secondary"
                  size="large"
                  onPress={() => {
                    startAgain()
                    setStartedAgain(true)
                  }}>
                  <ButtonText>
                    <Trans>Start again</Trans>
                  </ButtonText>
                </Button>
              </View>
            ) : null}
            {startedAgain && pending ? (
              <StatusMessageText>
                {l`If the old sign-in window is still open, close it.`}
              </StatusMessageText>
            ) : null}
            <Button
              testID="systemAccountsUseAppPassword"
              label={l`Use an app password instead`}
              color="secondary"
              size="large"
              onPress={() => {
                abandonPendingAttempt()
                setStep('password')
              }}>
              <ButtonText>
                <Trans>Use an app password instead</Trans>
              </ButtonText>
            </Button>
          </View>
        ) : null}

        {lost ? (
          <View style={[a.gap_md]}>
            <AlertMessage testID="systemAccountsLost">{lostText}</AlertMessage>
            <Button
              testID="systemAccountsRestart"
              label={l`Start again`}
              color="primary"
              size="large"
              onPress={restart}>
              <ButtonText>
                <Trans>Start again</Trans>
              </ButtonText>
            </Button>
          </View>
        ) : null}

        {!otherPending && step === 'password' && mine ? (
          <AppPasswordStep reg={mine} lala={lala} failure={failure} />
        ) : null}
      </View>
      <Dialog.Close />
    </Dialog.ScrollableInner>
  )
}

function AppPasswordStep({
  reg,
  lala,
  failure,
}: {
  reg: Registration
  lala: string
  failure: string | undefined
}) {
  'use no memo'
  const t = useTheme()
  const {t: l} = useLingui()
  const [password, setPassword] = useState('')
  const [code, setCode] = useState('')
  const [busy, setBusy] = useState(false)
  const needsCode = reg.outcome.kind === 'needsAuthFactor' || !!code
  const installed = isInstalledMobileWebApp()

  const submit = async () => {
    if (busy || !password) return
    setBusy(true)
    try {
      if (reg.outcome.kind === 'addFailed') {
        await retryAdd()
      } else {
        await signInWithAppPassword({
          password,
          authFactorToken: code || undefined,
        })
      }
    } finally {
      setBusy(false)
    }
  }

  return (
    <View style={[a.gap_md]}>
      <Text style={[a.text_md, a.font_semi_bold]}>{lala}</Text>
      {installed ? (
        <Text style={[a.text_sm, a.leading_snug, t.atoms.text_contrast_medium]}>
          <Trans>
            In the installed app, add system accounts with an app password. To
            use your server’s sign-in page instead, open Horizon in your
            browser.
          </Trans>
        </Text>
      ) : null}
      <Text style={[a.text_sm, a.leading_snug, t.atoms.text_contrast_medium]}>
        <Trans>
          Use an app password. Horizon keeps it only on this device. You can
          revoke it at your server at any time.
        </Trans>
      </Text>
      <View>
        <TextField.LabelText>
          <Trans>App password</Trans>
        </TextField.LabelText>
        <TextField.Root isInvalid={!!failure}>
          <TextField.Icon icon={LockIcon} />
          <TextField.Input
            testID="systemAccountsAppPassword"
            label={l`App password for ${lala}`}
            placeholder={null}
            autoCapitalize="none"
            autoCorrect={false}
            autoComplete="password"
            secureTextEntry
            returnKeyType="done"
            editable={!busy}
            value={password}
            onChangeText={setPassword}
            onSubmitEditing={() => void submit()}
          />
        </TextField.Root>
      </View>
      {needsCode ? (
        <View>
          <TextField.LabelText>
            <Trans>Sign-in code</Trans>
          </TextField.LabelText>
          <TextField.Root>
            <TextField.Input
              testID="systemAccountsAuthCode"
              label={l`Sign-in code from your email`}
              placeholder={null}
              autoCapitalize="none"
              autoCorrect={false}
              autoComplete="one-time-code"
              returnKeyType="done"
              editable={!busy}
              value={code}
              onChangeText={setCode}
              onSubmitEditing={() => void submit()}
            />
          </TextField.Root>
        </View>
      ) : null}
      {reg.outcome.kind === 'needsAuthFactor' ? (
        <StatusMessageText>
          {l`Enter the code your server sent you to finish signing in.`}
        </StatusMessageText>
      ) : null}
      {reg.outcome.kind === 'adding' ? (
        <StatusMessageText>{l`Adding…`}</StatusMessageText>
      ) : null}
      {failure ? (
        <AlertMessage testID="systemAccountsPasswordError">
          {failure}
        </AlertMessage>
      ) : null}
      <Button
        testID="systemAccountsAppPasswordSubmit"
        label={
          reg.outcome.kind === 'addFailed'
            ? l`Try adding ${lala} again`
            : l`Sign in as ${lala}`
        }
        color="primary"
        size="large"
        disabled={busy || !password || reg.outcome.kind === 'adding'}
        onPress={() => void submit()}>
        <ButtonText>
          {reg.outcome.kind === 'addFailed' ? (
            <Trans>Try again</Trans>
          ) : (
            <Trans>Sign in</Trans>
          )}
        </ButtonText>
        {busy ? <ButtonIcon icon={Loader} /> : null}
      </Button>
    </View>
  )
}
