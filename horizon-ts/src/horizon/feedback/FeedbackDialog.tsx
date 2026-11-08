/*
 * "Send feedback": a bug, an idea or anything else, sent to Horizon's own
 * feedback inbox signed in (`api.ts`). Technical details go only when the
 * box is ticked, and the box says what they are. Opened from the Feedback
 * links in the drawer and the web sidebar.
 */

import {useState} from 'react'
import {View} from 'react-native'
import {Trans, useLingui} from '@lingui/react/macro'
import {countGraphemes} from 'unicode-segmenter/grapheme'

import {atoms as a, useTheme, web} from '#/alf'
import {Admonition} from '#/components/Admonition'
import {Button, ButtonIcon, ButtonText} from '#/components/Button'
import * as Dialog from '#/components/Dialog'
import * as SegmentedControl from '#/components/forms/SegmentedControl'
import * as Toggle from '#/components/forms/Toggle'
import {Loader} from '#/components/Loader'
import * as Toast from '#/components/Toast'
import {Text} from '#/components/Typography'
import {
  FEEDBACK_TEXT_MAX,
  FeedbackError,
  type FeedbackKind,
  sendFeedback,
} from '#/horizon/feedback/api'
import {LimitedField} from '#/horizon/identity/edit/fields'

export function FeedbackDialog({control}: {control: Dialog.DialogControlProps}) {
  const {t: l} = useLingui()
  return (
    <Dialog.Outer control={control}>
      <Dialog.Handle />
      <Dialog.ScrollableInner
        label={l`Send feedback`}
        style={web({maxWidth: 480})}>
        <FeedbackForm onSent={() => control.close()} />
        <Dialog.Close />
      </Dialog.ScrollableInner>
    </Dialog.Outer>
  )
}

/** The form, for the dialog (and tests). `onSent` runs after a send. */
export function FeedbackForm({onSent}: {onSent: () => void}) {
  const t = useTheme()
  const {t: l} = useLingui()
  const [kind, setKind] = useState<FeedbackKind>('bug')
  const [text, setText] = useState('')
  const [includeDetails, setIncludeDetails] = useState(true)
  const [sending, setSending] = useState(false)
  const [error, setError] = useState('')

  const empty = text.trim().length === 0
  const tooLong = countGraphemes(text) > FEEDBACK_TEXT_MAX

  const onSend = async () => {
    if (empty || tooLong || sending) return
    setError('')
    setSending(true)
    try {
      await sendFeedback({kind, text, includeDetails})
      setText('')
      Toast.show(l`Thanks, your feedback was sent`, {type: 'success'})
      onSent()
    } catch (e) {
      setError(
        e instanceof FeedbackError && e.reason === 'rate-limited'
          ? l`You’ve sent a lot of feedback today. Please try again tomorrow.`
          : e instanceof FeedbackError && e.reason === 'signed-out'
            ? l`Sign in to send feedback.`
            : l`Your feedback couldn’t be sent. Please try again.`,
      )
    } finally {
      setSending(false)
    }
  }

  return (
    <View style={[a.gap_lg, a.w_full]}>
      <View style={[a.gap_sm]}>
        <Text style={[a.text_xl, a.font_semi_bold, a.leading_snug]}>
          <Trans>Send feedback</Trans>
        </Text>
        <Text style={[a.text_md, a.leading_snug, t.atoms.text_contrast_medium]}>
          <Trans>
            Tell us what went wrong, or what would make Horizon better. It goes
            to Horizon’s team with your account name, so we can reply.
          </Trans>
        </Text>
      </View>

      <SegmentedControl.Root
        type="radio"
        label={l`What kind of feedback`}
        value={kind}
        onChange={setKind}>
        <SegmentedControl.Item
          testID="feedbackKindBug"
          value="bug"
          label={l({message: 'Bug', comment: 'Feedback kind: something broken'})}>
          <SegmentedControl.ItemText>
            {l({message: 'Bug', comment: 'Feedback kind: something broken'})}
          </SegmentedControl.ItemText>
        </SegmentedControl.Item>
        <SegmentedControl.Item
          testID="feedbackKindIdea"
          value="idea"
          label={l({message: 'Idea', comment: 'Feedback kind: a suggestion'})}>
          <SegmentedControl.ItemText>
            {l({message: 'Idea', comment: 'Feedback kind: a suggestion'})}
          </SegmentedControl.ItemText>
        </SegmentedControl.Item>
        <SegmentedControl.Item
          testID="feedbackKindOther"
          value="other"
          label={l({message: 'Other', comment: 'Feedback kind: anything else'})}>
          <SegmentedControl.ItemText>
            {l({message: 'Other', comment: 'Feedback kind: anything else'})}
          </SegmentedControl.ItemText>
        </SegmentedControl.Item>
      </SegmentedControl.Root>

      <LimitedField
        testID="feedbackText"
        label={
          kind === 'bug'
            ? l`What happened?`
            : kind === 'idea'
              ? l`What’s your idea?`
              : l`What would you like to tell us?`
        }
        value={text}
        onChange={value => {
          setText(value)
          if (error) setError('')
        }}
        max={FEEDBACK_TEXT_MAX}
        multiline
        required
      />

      <Toggle.Item
        label={l`Include technical details`}
        name="feedbackDetails"
        value={includeDetails}
        onChange={setIncludeDetails}>
        <View style={[a.flex_1, a.flex_row, a.align_start, a.gap_sm]}>
          <Toggle.Checkbox />
          <View style={[a.flex_1, a.gap_2xs]}>
            <Toggle.LabelText style={[a.leading_tight]}>
              <Trans>Include technical details</Trans>
            </Toggle.LabelText>
            <Text
              style={[a.text_sm, a.leading_snug, t.atoms.text_contrast_medium]}>
              <Trans>
                Horizon’s version, and your device or browser and its system
                version. Never your posts or messages.
              </Trans>
            </Text>
          </View>
        </View>
      </Toggle.Item>

      {error ? (
        <Admonition type="error">
          <Text accessibilityLiveRegion="polite" aria-live="polite">
            {error}
          </Text>
        </Admonition>
      ) : null}

      <Button
        testID="feedbackSend"
        label={l`Send feedback`}
        size="large"
        color="primary"
        disabled={empty || tooLong || sending}
        onPress={() => void onSend()}>
        <ButtonText>
          <Trans>Send</Trans>
        </ButtonText>
        {sending ? <ButtonIcon icon={Loader} /> : null}
      </Button>
    </View>
  )
}
