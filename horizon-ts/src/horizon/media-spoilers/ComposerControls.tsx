/*
 * The composer's media spoiler and content warning controls (2J design, 5):
 * the "Mark as spoiler" checkboxes of the image alt text dialog and the
 * video captions dialog, the "Spoiler" badges on flagged thumbnails, the CW
 * toggle in the footer and the CW line above a post's editor. Every control
 * writes the compose store at once; nothing waits for a dialog's Save.
 *
 * The video dialog renders through the web `Portal`, outside the composer's
 * tree, so the video's key is handed over by context on both sides of it:
 * `VideoSpoilerKey` in the composer, `VideoSpoilerKeyProvider` inside the
 * dialog with the value `useVideoSpoilerKey` read before the portal.
 */

import {createContext, useContext, useEffect, useRef} from 'react'
import {type TextInput, View} from 'react-native'
import {Trans, useLingui} from '@lingui/react/macro'

import {type PostDraft} from '#/view/com/composer/state/composer'
import {type TextInputRef} from '#/view/com/composer/text-input/TextInput.types'
import {atoms as a, useTheme} from '#/alf'
import {Button} from '#/components/Button'
import * as TextField from '#/components/forms/TextField'
import * as Toggle from '#/components/forms/Toggle'
import {EyeSlash_Stroke2_Corner0_Rounded as EyeSlashIcon} from '#/components/icons/EyeSlash'
import {TriangleExclamation_Stroke2_Corner2_Rounded as WarningIcon} from '#/components/icons/TriangleExclamation'
import {Text} from '#/components/Typography'
import {IS_WEB} from '#/env'
import {convertAltSpoilers} from '#/horizon/spoilers/alias'
import {
  cutGraphemes,
  CW_LINE_MAX_GRAPHEMES,
} from '#/horizon/spoilers/content-warning'
import {hasSpoilers} from '#/horizon/spoilers/parse'
import {
  contentWarningOf,
  setContentWarning,
  setImageSpoiler,
  setVideoSpoiler,
  takeCwFocus,
  useComposeSpoilers,
} from './compose-store'
import {contentWarningsOn, mediaSpoilersOn} from './switches-read'

const VideoSpoilerKeyContext = createContext<AbortController | undefined>(
  undefined,
)

/**
 * Provides the composer video's key (its `abortController`) to the badge and
 * the captions dialog button below it.
 */
export function VideoSpoilerKey({
  video,
  children,
}: {
  video: {abortController: AbortController}
  children: React.ReactNode
}) {
  return (
    <VideoSpoilerKeyContext.Provider value={video.abortController}>
      {children}
    </VideoSpoilerKeyContext.Provider>
  )
}

/**
 * The video key provided by `VideoSpoilerKey`, if any.
 */
export function useVideoSpoilerKey(): AbortController | undefined {
  return useContext(VideoSpoilerKeyContext)
}

/**
 * Provides a key read before a portal to the content rendered through it.
 */
export function VideoSpoilerKeyProvider({
  value,
  children,
}: {
  value: AbortController | undefined
  children: React.ReactNode
}) {
  return (
    <VideoSpoilerKeyContext.Provider value={value}>
      {children}
    </VideoSpoilerKeyContext.Provider>
  )
}

function SpoilerCheckbox({
  name,
  value,
  onChange,
  description,
}: {
  name: string
  value: boolean
  onChange: (next: boolean) => void
  description: string
}) {
  const t = useTheme()
  const {t: l} = useLingui()
  const label = l({
    message: 'Mark as spoiler',
    comment: 'Checkbox in the composer alt text and captions dialogs',
  })
  return (
    <View style={[a.gap_xs]}>
      <Toggle.Item name={name} label={label} value={value} onChange={onChange}>
        <Toggle.Checkbox />
        <Toggle.LabelText>{label}</Toggle.LabelText>
      </Toggle.Item>
      <Text style={[a.text_sm, t.atoms.text_contrast_medium]}>
        {description}
      </Text>
    </View>
  )
}

/**
 * The image alt text dialog's checkbox.
 */
export function ImageSpoilerCheckbox({imageId}: {imageId: string}) {
  const {t: l} = useLingui()
  const snap = useComposeSpoilers()
  if (!mediaSpoilersOn()) return null
  return (
    <SpoilerCheckbox
      name="horizon-image-spoiler"
      value={snap.images.has(imageId)}
      onChange={next => setImageSpoiler(imageId, next)}
      description={l`Horizon blurs this image until it is clicked. Other apps show it normally.`}
    />
  )
}

/**
 * The video captions and alt text dialog's checkbox, for the video whose key
 * `VideoSpoilerKeyProvider` gives.
 */
export function VideoSpoilerCheckbox() {
  const {t: l} = useLingui()
  const key = useVideoSpoilerKey()
  const snap = useComposeSpoilers()
  if (!key || !mediaSpoilersOn()) return null
  return (
    <SpoilerCheckbox
      name="horizon-video-spoiler"
      value={snap.videos.has(key)}
      onChange={next => setVideoSpoiler(key, next)}
      description={l`Horizon blurs this video until it is clicked, and does not play it on its own. Other apps show it normally.`}
    />
  )
}

function SpoilerBadge({position}: {position: 'image' | 'video'}) {
  const t = useTheme()
  return (
    <View
      pointerEvents="none"
      accessible={false}
      style={[
        a.absolute,
        position === 'image' ? {bottom: 6, right: 6} : [{top: 8, left: 8}],
        position === 'video' && a.z_10,
        a.flex_row,
        a.align_center,
        a.gap_2xs,
        a.px_xs,
        a.py_2xs,
        a.rounded_full,
        {backgroundColor: 'rgba(0, 0, 0, 0.7)'},
      ]}>
      <EyeSlashIcon size="xs" fill={t.palette.white} />
      <Text style={[a.text_xs, a.font_semi_bold, {color: t.palette.white}]}>
        <Trans comment="Badge on a composer thumbnail marked as a spoiler">
          Spoiler
        </Trans>
      </Text>
    </View>
  )
}

/**
 * The badge on a flagged image's composer thumbnail.
 */
export function ComposerImageSpoilerBadge({imageId}: {imageId: string}) {
  const snap = useComposeSpoilers()
  if (!mediaSpoilersOn() || !snap.images.has(imageId)) return null
  return <SpoilerBadge position="image" />
}

/**
 * The badge on a flagged video's composer preview, at its top left.
 */
export function ComposerVideoSpoilerBadge() {
  const key = useVideoSpoilerKey()
  const snap = useComposeSpoilers()
  if (!key || !mediaSpoilersOn() || !snap.videos.has(key)) return null
  return <SpoilerBadge position="video" />
}

/**
 * The footer's CW toggle for the active post, web only (MS-11).
 */
export function ContentWarningButton({postId}: {postId: string}) {
  const {t: l} = useLingui()
  const snap = useComposeSpoilers()
  if (!contentWarningsOn() || !IS_WEB) return null
  const on = contentWarningOf(snap, postId) !== undefined
  return (
    <Button
      testID="contentWarningBtn"
      onPress={() => {
        setContentWarning(postId, on ? undefined : '')
      }}
      label={
        on
          ? l({
              message: 'Remove content warning',
              comment: 'The composer button that turns a content warning off',
            })
          : l({
              message: 'Add content warning',
              comment: 'The composer button that turns a content warning on',
            })
      }
      accessibilityHint={l({
        message:
          'Hides the post behind a warning line and blurs its images and videos',
        comment: 'Screen reader hint of the composer content warning button',
      })}
      accessibilityState={{checked: on}}
      style={a.p_sm}
      variant="ghost"
      shape="round"
      color={on ? 'primary_subtle' : 'primary'}>
      <WarningIcon size="lg" />
    </Button>
  )
}

/**
 * The CW line above a post's editor, shown while the post has a CW.
 */
export function ContentWarningField({
  post,
  textInputRef,
}: {
  post: PostDraft
  textInputRef: React.RefObject<TextInputRef | null> | null
}) {
  const snap = useComposeSpoilers()
  if (!contentWarningsOn()) return null
  const cw = contentWarningOf(snap, post.id)
  if (!cw) return null
  return (
    <ContentWarningFieldInner
      post={post}
      line={cw.line}
      textInputRef={textInputRef}
    />
  )
}

function ContentWarningFieldInner({
  post,
  line,
  textInputRef,
}: {
  post: PostDraft
  line: string
  textInputRef: React.RefObject<TextInputRef | null> | null
}) {
  const t = useTheme()
  const {t: l} = useLingui()
  const inputRef = useRef<React.ComponentRef<typeof TextInput>>(null)
  const postId = post.id

  useEffect(() => {
    // Only a press of the toggle focuses the field, not a restored draft.
    if (takeCwFocus(postId)) inputRef.current?.focus()
  }, [postId])

  const bodyHasSpoilers = hasSpoilers(convertAltSpoilers(post.richtext.text))

  return (
    <View style={[a.mb_sm, a.gap_xs]}>
      <TextField.Root>
        <TextField.Input
          inputRef={inputRef}
          label={l({
            message: 'Content warning',
            comment: 'Label of the composer content warning line',
          })}
          placeholder={l({
            message: 'Content warning (optional)',
            comment: 'Placeholder of the composer content warning line',
          })}
          value={line}
          onChangeText={text =>
            setContentWarning(postId, cutGraphemes(text, CW_LINE_MAX_GRAPHEMES))
          }
          onSubmitEditing={() => {
            textInputRef?.current?.focus()
          }}
          returnKeyType="next"
          testID="contentWarningInput"
        />
      </TextField.Root>
      <Text style={[a.text_xs, t.atoms.text_contrast_medium]}>
        <Trans>
          The post is hidden behind this line, and every image and video in it
          is blurred. Leave it empty to show “Content warning”.
        </Trans>
      </Text>
      {bodyHasSpoilers && (
        <Text style={[a.text_xs, t.atoms.text_contrast_medium]}>
          <Trans>
            Spoilers in the post are shown when the warning is opened.
          </Trans>
        </Text>
      )}
    </View>
  )
}
