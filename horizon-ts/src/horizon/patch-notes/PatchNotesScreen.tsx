/*
 * Patch notes: what changed in each release, newest first. The same notes
 * as the Android download page, from patch-notes/*.md. Open without
 * signing in (nearhorizon.app/patch-notes).
 */

import {View} from 'react-native'
import {Trans, useLingui} from '@lingui/react/macro'

import {
  type CommonNavigatorParams,
  type NativeStackScreenProps,
} from '#/lib/routes/types'
import {atoms as a, useTheme} from '#/alf'
import * as Layout from '#/components/Layout'
import {H2, H3, Text} from '#/components/Typography'
import {PATCH_NOTES} from './notes.generated'
import {type PatchNote, type PatchNoteKind} from './types'

type Props = NativeStackScreenProps<CommonNavigatorParams, 'PatchNotes'>

export function PatchNotesScreen(_props: Props) {
  return (
    <Layout.Screen testID="patchNotesScreen">
      <Layout.Header.Outer>
        <Layout.Header.BackButton />
        <Layout.Header.Content>
          <Layout.Header.TitleText>
            <Trans>Patch notes</Trans>
          </Layout.Header.TitleText>
        </Layout.Header.Content>
        <Layout.Header.Slot />
      </Layout.Header.Outer>
      <Layout.Content>
        <View style={[a.px_lg, a.py_lg, a.gap_2xl]}>
          {PATCH_NOTES.map(note => (
            <Release key={`${note.version}-${note.build}`} note={note} />
          ))}
        </View>
      </Layout.Content>
    </Layout.Screen>
  )
}

function Release({note}: {note: PatchNote}) {
  const t = useTheme()
  const {i18n} = useLingui()
  // Noon UTC, so the date reads the same in every time zone
  const date = i18n.date(new Date(`${note.date}T12:00:00Z`), {
    dateStyle: 'long',
    timeZone: 'UTC',
  })
  return (
    <View style={[a.gap_md]}>
      <View style={[a.gap_xs]}>
        <H2 style={[a.text_xl, a.font_bold]}>
          <Trans>
            Version {note.version}, build {note.build}
          </Trans>
        </H2>
        <Text style={[a.text_sm, t.atoms.text_contrast_medium]}>{date}</Text>
        {note.summary ? (
          <Text style={[a.text_md, a.leading_snug]}>{note.summary}</Text>
        ) : null}
      </View>
      {note.sections.map(section => (
        <Section
          key={section.kind}
          kind={section.kind}
          items={section.items}
        />
      ))}
    </View>
  )
}

function Section({kind, items}: {kind: PatchNoteKind; items: string[]}) {
  const t = useTheme()
  return (
    <View style={[a.gap_sm]}>
      <H3 style={[a.text_md, a.font_semi_bold, t.atoms.text_contrast_high]}>
        <SectionTitle kind={kind} />
      </H3>
      <View role="list" style={[a.gap_sm]}>
        {items.map((item, i) => (
          <View key={i} role="listitem" style={[a.flex_row, a.gap_sm]}>
            <Text
              aria-hidden
              importantForAccessibility="no"
              style={[a.text_md, t.atoms.text_contrast_medium]}>
              •
            </Text>
            <Text style={[a.flex_1, a.text_md, a.leading_snug]}>{item}</Text>
          </View>
        ))}
      </View>
    </View>
  )
}

function SectionTitle({kind}: {kind: PatchNoteKind}) {
  switch (kind) {
    case 'horizon':
      return <Trans>New in Horizon</Trans>
    case 'upstream':
      return <Trans>From Bluesky</Trans>
    case 'fixes':
      return <Trans>Fixes</Trans>
  }
}
