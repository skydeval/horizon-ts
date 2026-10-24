/*
 * The member editor (Phase 5 design 7.2), shown in place of the Plurality
 * tab's list: display name (required), pronouns (the set editor, no display
 * mode), description, emoji, colour, roles and member types (two fields,
 * two suggestion lists), age presentation, proxy, avatar and banner (PNG or
 * JPEG under 1 MB; the stock pickers compress). Saves on its own Save,
 * optimistic, over the record read (P5R1-N6). A new member gets a TID from
 * the per-account clock and is created, never put (PP-18).
 */

import {useMemo, useState} from 'react'
import {View} from 'react-native'
import {Trans, useLingui} from '@lingui/react/macro'

import {cleanError} from '#/lib/strings/errors'
import {logger} from '#/logger'
import {EditableUserAvatar} from '#/view/com/util/UserAvatar'
import {UserBanner} from '#/view/com/util/UserBanner'
import {atoms as a, useTheme} from '#/alf'
import {Admonition} from '#/components/Admonition'
import {Button, ButtonIcon, ButtonText} from '#/components/Button'
import {useDialogControl} from '#/components/Dialog'
import * as Toggle from '#/components/forms/Toggle'
import {ArrowLeft_Stroke2_Corner0_Rounded as BackIcon} from '#/components/icons/Arrow'
import {Loader} from '#/components/Loader'
import * as Prompt from '#/components/Prompt'
import * as Toast from '#/components/Toast'
import {Text} from '#/components/Typography'
import {ColorField} from '#/horizon/identity/edit/ColorField'
import {EmojiField} from '#/horizon/identity/edit/EmojiField'
import {ChipsField, LimitedField} from '#/horizon/identity/edit/fields'
import {useOwnEntry, useOwnWriter} from '#/horizon/identity/edit/own'
import {
  MEMBER_PRONOUN_LIMITS,
  type PronounRow,
  rowsFromSets,
  rowsValid,
  setsFromRows,
} from '#/horizon/identity/edit/pronoun-rows'
import {PronounSetsEditor} from '#/horizon/identity/edit/PronounSetsEditor'
import {
  MEMBER_TYPE_SUGGESTIONS,
  ROLE_SUGGESTIONS,
} from '#/horizon/identity/edit/suggestions'
import {memberImageUrl} from '#/horizon/identity/images'
import {type PluralFront, type PluralMember} from '#/horizon/identity/parse'
import {type IdentityAnswer} from '#/horizon/identity/queries'
import {type ListedMember} from '#/horizon/identity/reads'
import {
  createMember,
  deleteMember,
  FrontNotUpdatedError,
  type MemberImages,
  type MemberInput,
  memberProblem,
  type PickedImage,
  updateMember,
} from '#/horizon/identity/writes'

/**
 * The editor for `rkey`, or a new member without one. `onDone` returns to
 * the list.
 */
export function MemberEditor({
  did,
  rkey,
  members,
  front,
  onDone,
}: {
  did: string
  rkey: string | undefined
  /** The account's members, for the proxy choice. */
  members: readonly ListedMember[]
  /** The front as read, so a deleted member leaves it. */
  front: IdentityAnswer<PluralFront> | undefined
  onDone: () => void
}) {
  const {t: l} = useLingui()
  const t = useTheme()
  const entry = useOwnEntry('member', rkey ? {did, rkey} : undefined)
  if (!rkey) {
    return (
      <MemberForm
        key="new"
        did={did}
        members={members}
        front={front}
        onDone={onDone}
      />
    )
  }
  if (entry.state === 'ready' && entry.answer.kind === 'record') {
    return (
      <MemberForm
        key={rkey}
        did={did}
        rkey={rkey}
        previous={{value: entry.answer.value, cid: entry.answer.cid}}
        members={members}
        front={front}
        onDone={onDone}
      />
    )
  }
  return (
    <View style={[a.px_xl, a.py_lg, a.gap_md]}>
      <BackButton onPress={onDone} />
      {entry.state === 'loading' ? (
        <Loader size="lg" />
      ) : entry.state === 'error' ? (
        <>
          <Admonition type="error">
            <Trans>This member couldn’t be loaded.</Trans>
          </Admonition>
          <View style={[a.flex_row]}>
            <Button
              label={l`Try loading this member again`}
              onPress={entry.retry}
              size="small"
              color="secondary">
              <ButtonText>
                <Trans>Try again</Trans>
              </ButtonText>
            </Button>
          </View>
        </>
      ) : (
        <Text style={[a.text_md, t.atoms.text_contrast_medium]}>
          <Trans>This member was removed.</Trans>
        </Text>
      )}
    </View>
  )
}

function BackButton({onPress}: {onPress: () => void}) {
  const {t: l} = useLingui()
  return (
    <View style={[a.flex_row]}>
      <Button
        testID="memberEditorBack"
        label={l`Back to members`}
        onPress={onPress}
        size="small"
        color="secondary">
        <ButtonIcon icon={BackIcon} />
        <ButtonText>
          <Trans>Members</Trans>
        </ButtonText>
      </Button>
    </View>
  )
}

function inputFrom(member: PluralMember | undefined): {
  fields: Omit<MemberInput, 'pronouns'>
  rows: PronounRow[]
} {
  return {
    fields: {
      displayName: member?.displayName ?? '',
      description: member?.description ?? '',
      emoji: member?.emoji ?? '',
      color: member?.color ?? '',
      roles: member?.roles ?? [],
      memberTypes: member?.memberTypes ?? [],
      agePresentation: member?.agePresentation ?? '',
      proxy: member?.proxy
        ? {id: member.proxy.id, note: member.proxy.note ?? ''}
        : null,
    },
    rows: rowsFromSets(member?.pronouns ?? []),
  }
}

/** A user-facing message for a write's problem code. */
function useProblemText() {
  const {t: l} = useLingui()
  return (code: string): string => {
    switch (code) {
      case 'displayNameRequired':
        return l`Give this member a name.`
      case 'colorInvalid':
        return l`Use a hex code like #30A46C for the colour.`
      case 'pronouns':
        return l`Check the pronouns: a form or set is too long.`
      case 'tooManyRoles':
        return l`A member can have up to 10 roles.`
      case 'tooManyMemberTypes':
        return l`A member can have up to 5 member types.`
      default:
        return l`Some of these details are too long.`
    }
  }
}

function MemberForm({
  did,
  rkey,
  previous,
  members,
  front,
  onDone,
}: {
  did: string
  rkey?: string
  previous?: {value: PluralMember; cid?: string}
  members: readonly ListedMember[]
  front: IdentityAnswer<PluralFront> | undefined
  onDone: () => void
}) {
  const t = useTheme()
  const {t: l} = useLingui()
  const writer = useOwnWriter()
  const problemText = useProblemText()
  const deleteControl = useDialogControl()
  // Read once: the form starts from the record and is then the user's.
  const initial = useMemo(() => inputFrom(previous?.value), [previous?.value])
  const [fields, setFields] = useState(initial.fields)
  const [rows, setRows] = useState(initial.rows)
  const [images, setImages] = useState<MemberImages>({})
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState('')

  const set = <K extends keyof typeof fields>(
    key: K,
    value: (typeof fields)[K],
  ) => {
    setError('')
    setFields(current => ({...current, [key]: value}))
  }

  const input: MemberInput = {...fields, pronouns: setsFromRows(rows)}
  const problem = memberProblem(input)
  const pronounsOk = rowsValid(rows, MEMBER_PRONOUN_LIMITS)

  const avatarUrl = shownImage(
    did,
    images.avatar,
    previous?.value.avatar,
    'avatar',
  )
  const bannerUrl = shownImage(
    did,
    images.banner,
    previous?.value.banner,
    'banner',
  )

  const onSave = async () => {
    if (!writer || problem || !pronounsOk) return
    setSaving(true)
    setError('')
    try {
      if (rkey && previous) {
        await updateMember(writer, rkey, previous, input, images)
      } else {
        await createMember(writer, input, images)
      }
      Toast.show(l({message: 'Member saved', context: 'toast'}))
      onDone()
    } catch (e) {
      logger.warn('saving a plural member failed', {
        message: e instanceof Error ? e.message : String(e),
      })
      setError(cleanError(e instanceof Error ? e.message : String(e)))
    } finally {
      setSaving(false)
    }
  }

  const onDelete = async () => {
    if (!writer || !rkey) return
    setSaving(true)
    try {
      await deleteMember(writer, rkey, front)
      Toast.show(l({message: 'Member removed', context: 'toast'}))
      onDone()
    } catch (e) {
      if (e instanceof FrontNotUpdatedError) {
        Toast.show(e.message, {type: 'warning'})
        onDone()
        return
      }
      setError(cleanError(e instanceof Error ? e.message : String(e)))
    } finally {
      setSaving(false)
    }
  }

  const others = members.filter(member => member.rkey !== rkey)

  return (
    <View style={[a.gap_lg, a.pb_2xl]} testID="memberEditor">
      <View style={[a.px_xl]}>
        <BackButton onPress={onDone} />
      </View>
      <View style={[a.relative]}>
        <UserBanner
          banner={bannerUrl}
          onSelectNewBanner={img => {
            setError('')
            setImages(current => ({...current, banner: picked(img)}))
          }}
        />
        <View
          style={[
            a.absolute,
            {
              top: 80,
              left: 20,
              width: 84,
              height: 84,
              borderWidth: 2,
              borderRadius: 42,
              borderColor: t.atoms.bg.backgroundColor,
            },
          ]}>
          <EditableUserAvatar
            size={80}
            avatar={avatarUrl}
            onSelectNewAvatar={img => {
              setError('')
              setImages(current => ({...current, avatar: picked(img)}))
            }}
          />
        </View>
      </View>
      <View style={[a.mt_2xl, a.px_xl, a.gap_xl]}>
        <Text style={[a.text_sm, t.atoms.text_contrast_medium]}>
          <Trans>Images must be PNG or JPEG.</Trans>
        </Text>
        <LimitedField
          testID="memberDisplayNameInput"
          label={l`Display name`}
          value={fields.displayName}
          onChange={value => set('displayName', value)}
          max={64}
          required
        />
        <View style={[a.gap_xs]}>
          <Text style={[a.text_sm, a.font_semi_bold, t.atoms.text]}>
            <Trans>Pronouns</Trans>
          </Text>
          <PronounSetsEditor
            label={l`Pronouns`}
            rows={rows}
            onChange={next => {
              setError('')
              setRows(next)
            }}
            limits={MEMBER_PRONOUN_LIMITS}
            disabled={saving}
            testID="memberPronouns"
          />
        </View>
        <LimitedField
          testID="memberDescriptionInput"
          label={l`Description`}
          value={fields.description}
          onChange={value => set('description', value)}
          max={256}
          multiline
        />
        <EmojiField value={fields.emoji} onChange={v => set('emoji', v)} />
        <ColorField value={fields.color} onChange={v => set('color', v)} />
        <ChipsField
          testID="memberRolesInput"
          label={l`Roles`}
          values={fields.roles}
          onChange={values => set('roles', values)}
          suggestions={ROLE_SUGGESTIONS}
          max={10}
          maxGraphemes={32}
        />
        <ChipsField
          testID="memberTypesInput"
          label={l`Member types`}
          values={fields.memberTypes}
          onChange={values => set('memberTypes', values)}
          suggestions={MEMBER_TYPE_SUGGESTIONS}
          max={5}
          maxGraphemes={32}
        />
        <LimitedField
          testID="memberAgeInput"
          label={l`Age presentation`}
          value={fields.agePresentation}
          onChange={value => set('agePresentation', value)}
          max={32}
          placeholder={l`e.g. adult, ageless`}
        />
        {others.length > 0 ? (
          <View style={[a.gap_sm]}>
            <Text style={[a.text_sm, a.font_semi_bold, t.atoms.text]}>
              <Trans>Proxy</Trans>
            </Text>
            <Text style={[a.text_sm, t.atoms.text_contrast_medium]}>
              <Trans>Another member who speaks for this one.</Trans>
            </Text>
            <Toggle.Group
              type="radio"
              label={l`Proxy`}
              values={[fields.proxy?.id ?? '']}
              onChange={([id]) =>
                set('proxy', id ? {id, note: fields.proxy?.note ?? ''} : null)
              }>
              <View style={[a.gap_sm]}>
                <Toggle.Item name="" label={l`No proxy`}>
                  <Toggle.Radio />
                  <Toggle.LabelText>
                    <Trans>None</Trans>
                  </Toggle.LabelText>
                </Toggle.Item>
                {others.map(member => (
                  <Toggle.Item
                    key={member.rkey}
                    name={member.rkey}
                    label={member.value.displayName}>
                    <Toggle.Radio />
                    <Toggle.LabelText>
                      {member.value.emoji
                        ? `${member.value.emoji} ${member.value.displayName}`
                        : member.value.displayName}
                    </Toggle.LabelText>
                  </Toggle.Item>
                ))}
              </View>
            </Toggle.Group>
            {fields.proxy ? (
              <LimitedField
                testID="memberProxyNoteInput"
                label={l`Proxy note`}
                value={fields.proxy.note}
                onChange={note =>
                  set('proxy', fields.proxy ? {...fields.proxy, note} : null)
                }
                max={64}
                placeholder={l`speaks through`}
              />
            ) : null}
          </View>
        ) : null}

        {problem && problem !== 'displayNameRequired' ? (
          <Admonition type="error">{problemText(problem)}</Admonition>
        ) : null}
        {error ? <Admonition type="error">{error}</Admonition> : null}

        <Button
          testID="memberSaveButton"
          label={rkey ? l`Save member` : l`Add member`}
          color="primary"
          size="large"
          disabled={!writer || saving || !!problem || !pronounsOk}
          onPress={() => void onSave()}>
          <ButtonText>
            {rkey ? <Trans>Save member</Trans> : <Trans>Add member</Trans>}
          </ButtonText>
          {saving && <ButtonIcon icon={Loader} />}
        </Button>
        {problem === 'displayNameRequired' ? (
          <Text style={[a.text_sm, t.atoms.text_contrast_medium]}>
            <Trans>A display name is required.</Trans>
          </Text>
        ) : null}
        {rkey ? (
          <Button
            testID="memberDeleteButton"
            label={l`Delete member`}
            color="negative_subtle"
            size="large"
            disabled={!writer || saving}
            onPress={() => deleteControl.open()}>
            <ButtonText>
              <Trans>Delete member</Trans>
            </ButtonText>
          </Button>
        ) : null}
      </View>

      <Prompt.Basic
        control={deleteControl}
        title={
          fields.displayName.trim()
            ? l`Delete ${fields.displayName.trim()}?`
            : l`Delete this member?`
        }
        description={l`Posts that name this member will show without them.`}
        confirmButtonCta={l`Delete`}
        confirmButtonColor="negative"
        onConfirm={() => void onDelete()}
      />
    </View>
  )
}

function picked(
  img: {path: string; mime: string; size?: number} | null,
): PickedImage | null {
  return img ? {path: img.path, mime: img.mime, size: img.size} : null
}

/** The image the form shows: the new pick, none, or the record's. */
function shownImage(
  did: string,
  next: PickedImage | null | undefined,
  read: {cid: string} | undefined,
  preset: 'avatar' | 'banner',
): string | null | undefined {
  if (next === null) return null
  if (next) return next.path
  return read ? memberImageUrl(did, read, preset) : undefined
}
