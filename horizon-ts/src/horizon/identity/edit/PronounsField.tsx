/*
 * The pronouns field in Edit Profile (Phase 5 design 7.1, hooks ID-21 and
 * ID-22). Its state lives in `useIdentityEditParts`, which the stock dialog
 * holds, so the stock Save writes it as one more write and the stock dirty
 * check includes it.
 *
 * - **No "Remove"** (PP-22). Clearing every row writes empty `sets`, which
 *   shows nothing and blocks Bluesky's short field.
 * - **The short field, for context.** With no pronouns record and the
 *   Bluesky short field set, a note shows what readers see now, with "Show
 *   no pronouns", which writes a record with empty `sets` on Save. Read from
 *   the profile view the dialog already holds; never written (Q7).
 * - **Untouched rows keep their forms as read**, and the record is spread
 *   under the edit (P5R1-N6).
 */

import {useMemo, useState} from 'react'
import {View} from 'react-native'
import {Trans, useLingui} from '@lingui/react/macro'

import {useSession} from '#/state/session'
import {atoms as a, useTheme} from '#/alf'
import {Admonition} from '#/components/Admonition'
import {Button, ButtonText} from '#/components/Button'
import * as SegmentedControl from '#/components/forms/SegmentedControl'
import * as TextField from '#/components/forms/TextField'
import {Loader} from '#/components/Loader'
import {Text} from '#/components/Typography'
import {useOwnEntry, useOwnWriter} from '#/horizon/identity/edit/own'
import {
  ACCOUNT_PRONOUN_LIMITS,
  type PronounRow,
  rowsFromSets,
  rowsValid,
  sameSets,
  setsFromRows,
} from '#/horizon/identity/edit/pronoun-rows'
import {PronounSetsEditor} from '#/horizon/identity/edit/PronounSetsEditor'
import {type DisplayMode} from '#/horizon/identity/parse'
import {savePronouns} from '#/horizon/identity/writes'
import {PRONOUNS} from '#/horizon/switches'

type Edited = {rows: PronounRow[]; displayMode: DisplayMode; showNone: boolean}

/** The pronouns editor's state, for the stock Edit Profile dialog. */
export type IdentityEditParts = ReturnType<typeof useIdentityEditParts>

/**
 * The state of the pronouns field for `profile` (the account's own).
 * `dirty` ors into the stock dirty check, `invalid` holds the stock Save,
 * and `save()` is called from the stock save path; it writes only when
 * dirty and throws when the write fails (the field shows why).
 */
export function useIdentityEditParts(profile: {
  did: string
  pronouns?: string
}) {
  const {currentAccount} = useSession()
  const enabled = PRONOUNS && currentAccount?.did === profile.did
  const entry = useOwnEntry(
    'pronouns',
    enabled ? {did: profile.did} : undefined,
  )
  const writer = useOwnWriter()
  const [edited, setEdited] = useState<Edited>()
  const [error, setError] = useState('')
  const [saving, setSaving] = useState(false)

  const read = entry.state === 'ready' ? entry.answer : undefined
  const record = read?.kind === 'record' ? read.value : undefined
  // Stable rows for the record read, so their keys survive re-renders.
  const baseRows = useMemo(() => rowsFromSets(record?.sets ?? []), [record])
  const baseMode: DisplayMode = record?.displayMode ?? 'all'

  const rows = edited?.rows ?? baseRows
  const displayMode = edited?.displayMode ?? baseMode
  const showNone = edited?.showNone ?? false
  const sets = setsFromRows(rows)

  let dirty = false
  if (enabled && read && edited) {
    dirty = record
      ? !sameSets(sets, record.sets) || displayMode !== baseMode
      : sets.length > 0 || showNone
  }
  const invalid =
    enabled && !!edited && !rowsValid(rows, ACCOUNT_PRONOUN_LIMITS)

  const edit = (next: Partial<Edited>) => {
    setError('')
    setEdited({rows, displayMode, showNone, ...next})
  }

  const save = async () => {
    if (!dirty) return
    if (!writer || !read) throw new Error('Pronouns are not ready to save')
    setSaving(true)
    try {
      await savePronouns(writer, read, {sets, displayMode})
      setEdited(undefined)
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
      throw e
    } finally {
      setSaving(false)
    }
  }

  return {
    enabled,
    entry,
    rows,
    displayMode,
    showNone,
    hasRecord: !!record,
    hadSets: (record?.sets.length ?? 0) > 0,
    shortField: profile.pronouns?.trim() || undefined,
    dirty,
    invalid,
    saving,
    error,
    setRows: (next: PronounRow[]) => edit({rows: next}),
    setDisplayMode: (next: DisplayMode) => edit({displayMode: next}),
    setShowNone: (next: boolean) => edit({showNone: next}),
    save,
  }
}

/** The "Pronouns" field, after the description in the Profile tab. */
export function PronounsField({parts}: {parts: IdentityEditParts}) {
  const t = useTheme()
  const {t: l} = useLingui()
  if (!parts.enabled) return null
  const {entry} = parts
  const empty = setsFromRows(parts.rows).length === 0

  return (
    <View style={[a.gap_sm]} testID="pronounsField">
      <TextField.LabelText>
        <Trans>Pronouns</Trans>
      </TextField.LabelText>
      {entry.state === 'loading' ? (
        <View style={[a.flex_row, a.align_center, a.gap_sm]}>
          <Loader size="sm" />
          <Text style={[a.text_sm, t.atoms.text_contrast_medium]}>
            <Trans>Loading your pronouns…</Trans>
          </Text>
        </View>
      ) : entry.state === 'error' ? (
        <View style={[a.gap_sm]}>
          <Admonition type="error">
            <Trans>Your pronouns couldn’t be loaded.</Trans>
          </Admonition>
          <View style={[a.flex_row]}>
            <Button
              label={l`Try loading your pronouns again`}
              onPress={entry.retry}
              size="small"
              color="secondary">
              <ButtonText>
                <Trans>Try again</Trans>
              </ButtonText>
            </Button>
          </View>
        </View>
      ) : (
        <>
          <PronounSetsEditor
            label={l`Pronouns`}
            rows={parts.rows}
            onChange={parts.setRows}
            limits={ACCOUNT_PRONOUN_LIMITS}
            disabled={parts.saving}
          />
          {empty && !parts.hasRecord && parts.shortField ? (
            <View
              style={[a.gap_xs, a.p_md, a.rounded_sm, t.atoms.bg_contrast_25]}
              testID="pronounsShortFieldNote">
              <Text style={[a.text_sm, a.leading_snug]}>
                <Trans>Your Bluesky profile shows: {parts.shortField}</Trans>
              </Text>
              {parts.showNone ? (
                <Text
                  style={[
                    a.text_sm,
                    a.leading_snug,
                    t.atoms.text_contrast_medium,
                  ]}>
                  <Trans>No pronouns will show once you save.</Trans>
                </Text>
              ) : null}
              <View style={[a.flex_row]}>
                <Button
                  testID="pronounsShowNone"
                  label={
                    parts.showNone
                      ? l`Show your Bluesky pronouns`
                      : l`Show no pronouns`
                  }
                  accessibilityHint={
                    parts.showNone
                      ? undefined
                      : l`Readers will see no pronouns once you save`
                  }
                  onPress={() => parts.setShowNone(!parts.showNone)}
                  size="small"
                  color="secondary">
                  <ButtonText>
                    {parts.showNone ? (
                      <Trans>Undo</Trans>
                    ) : (
                      <Trans>Show no pronouns</Trans>
                    )}
                  </ButtonText>
                </Button>
              </View>
            </View>
          ) : null}
          {empty && parts.hadSets ? (
            <Text style={[a.text_sm, t.atoms.text_contrast_medium]}>
              <Trans>No pronouns will show once you save.</Trans>
            </Text>
          ) : null}
          {!empty ? (
            <SegmentedControl.Root
              type="radio"
              size="small"
              label={l`How many sets to show`}
              value={parts.displayMode}
              onChange={parts.setDisplayMode}>
              <SegmentedControl.Item
                testID="pronounsShowAll"
                value="all"
                label={l`Show all`}>
                <SegmentedControl.ItemText>
                  {l`Show all`}
                </SegmentedControl.ItemText>
              </SegmentedControl.Item>
              <SegmentedControl.Item
                testID="pronounsShowFirst"
                value="firstOnly"
                label={l`Show first only`}>
                <SegmentedControl.ItemText>
                  {l`Show first only`}
                </SegmentedControl.ItemText>
              </SegmentedControl.Item>
            </SegmentedControl.Root>
          ) : null}
          {parts.error ? (
            <Admonition type="error">{parts.error}</Admonition>
          ) : null}
        </>
      )}
    </View>
  )
}
