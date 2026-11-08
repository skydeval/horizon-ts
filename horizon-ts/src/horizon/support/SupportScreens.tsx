/*
 * Horizon's support, privacy and terms screens (nearhorizon.app/about/
 * support/...). They open in the app, like the patch notes, and without
 * signing in. The text lives in content.ts.
 */

import {View} from 'react-native'
import {Trans, useLingui} from '@lingui/react/macro'

import {
  type CommonNavigatorParams,
  type NativeStackScreenProps,
} from '#/lib/routes/types'
import {atoms as a, useTheme} from '#/alf'
import * as Layout from '#/components/Layout'
import {InlineLinkText} from '#/components/Link'
import {H2, Text} from '#/components/Typography'
import {
  CONTACT_EMAIL,
  type Part,
  POLICIES_UPDATED,
  PRIVACY_SECTIONS,
  type Section,
  TERMS_SECTIONS,
} from '#/horizon/support/content'
import {HORIZON_PRIVACY_PATH, HORIZON_TERMS_PATH} from '#/horizon/support/links'

function Screen({
  testID,
  titleText,
  children,
}: {
  testID: string
  titleText: React.ReactNode
  children: React.ReactNode
}) {
  return (
    <Layout.Screen testID={testID}>
      <Layout.Header.Outer>
        <Layout.Header.BackButton />
        <Layout.Header.Content>
          <Layout.Header.TitleText>{titleText}</Layout.Header.TitleText>
        </Layout.Header.Content>
        <Layout.Header.Slot />
      </Layout.Header.Outer>
      <Layout.Content>
        <View style={[a.px_lg, a.py_lg, a.gap_xl]}>{children}</View>
      </Layout.Content>
    </Layout.Screen>
  )
}

function Paragraph({parts}: {parts: Part[]}) {
  return (
    <Text style={[a.text_md, a.leading_snug]}>
      {parts.map((part, i) =>
        typeof part === 'string' ? (
          part
        ) : (
          <InlineLinkText
            key={i}
            label={part.text}
            to={part.to}
            // Links Horizon wrote itself, not someone's post
            disableMismatchWarning
            style={[a.text_md, a.leading_snug]}>
            {part.text}
          </InlineLinkText>
        ),
      )}
    </Text>
  )
}

function Sections({sections}: {sections: Section[]}) {
  return (
    <>
      {sections.map((section, i) => (
        <View key={i} style={[a.gap_sm]}>
          {section.heading ? (
            <H2 style={[a.text_lg, a.font_semi_bold]}>{section.heading}</H2>
          ) : null}
          {section.paragraphs.map((parts, j) => (
            <Paragraph key={j} parts={parts} />
          ))}
        </View>
      ))}
    </>
  )
}

function Updated() {
  const t = useTheme()
  const {i18n} = useLingui()
  // Noon UTC, so the date reads the same in every time zone
  const date = i18n.date(new Date(`${POLICIES_UPDATED}T12:00:00Z`), {
    dateStyle: 'long',
    timeZone: 'UTC',
  })
  return (
    <Text style={[a.text_sm, t.atoms.text_contrast_medium]}>
      <Trans>Last updated: {date}</Trans>
    </Text>
  )
}

type SupportProps = NativeStackScreenProps<
  CommonNavigatorParams,
  'HorizonSupport'
>
export function HorizonSupportScreen(_props: SupportProps) {
  const {t: l} = useLingui()
  const email = {text: CONTACT_EMAIL, to: `mailto:${CONTACT_EMAIL}`}
  return (
    <Screen testID="horizonSupportScreen" titleText={<Trans>Support</Trans>}>
      <View style={[a.gap_sm]}>
        <H2 style={[a.text_lg, a.font_semi_bold]}>
          <Trans>Report a bug or share an idea</Trans>
        </H2>
        <Text style={[a.text_md, a.leading_snug]}>
          <Trans>
            Open the menu and choose Feedback. You need to be signed in.
          </Trans>
        </Text>
      </View>
      <View style={[a.gap_sm]}>
        <H2 style={[a.text_lg, a.font_semi_bold]}>
          <Trans>Contact</Trans>
        </H2>
        <Paragraph parts={[l`Email `, email, '.']} />
      </View>
      <View style={[a.gap_sm]}>
        <H2 style={[a.text_lg, a.font_semi_bold]}>
          <Trans>Account, sign-in or moderation problems</Trans>
        </H2>
        <Paragraph
          parts={[
            l`Your account lives on its own server (your PDS), which handles sign-in, passwords and account moderation. For accounts on bsky.social, see `,
            {
              text: l`Bluesky’s help`,
              to: 'https://bsky.social/about/support',
            },
            '.',
          ]}
        />
      </View>
      <View style={[a.gap_sm]}>
        <H2 style={[a.text_lg, a.font_semi_bold]}>
          <Trans>Policies</Trans>
        </H2>
        <Paragraph
          parts={[{text: l`Privacy policy`, to: HORIZON_PRIVACY_PATH}]}
        />
        <Paragraph parts={[{text: l`Terms of use`, to: HORIZON_TERMS_PATH}]} />
      </View>
    </Screen>
  )
}

type PrivacyProps = NativeStackScreenProps<
  CommonNavigatorParams,
  'HorizonPrivacy'
>
export function HorizonPrivacyScreen(_props: PrivacyProps) {
  return (
    <Screen
      testID="horizonPrivacyScreen"
      titleText={<Trans>Privacy policy</Trans>}>
      <Updated />
      <Sections sections={PRIVACY_SECTIONS} />
    </Screen>
  )
}

type TermsProps = NativeStackScreenProps<CommonNavigatorParams, 'HorizonTerms'>
export function HorizonTermsScreen(_props: TermsProps) {
  return (
    <Screen testID="horizonTermsScreen" titleText={<Trans>Terms of use</Trans>}>
      <Updated />
      <Sections sections={TERMS_SECTIONS} />
    </Screen>
  )
}
