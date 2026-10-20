/*
 * Interaction settings for members (Phase 3, batch B, rolling list item 5):
 * the stock screen's defaults become the "Public posts" section, and a
 * "Private posts" section follows it with
 *
 * - "New posts start as" Public or Private (the composer's initial
 *   visibility for a top-level post that quotes nothing; a quote starts as
 *   the quoted post is, round 2 list item 6);
 * - "Default audience" (the composer's initial private audience): the
 *   standing audiences and the account's named list audiences, as the
 *   composer's drop-down offers them, with "New audience...". None is
 *   selected until the account chooses one (`record.ts`);
 * - who can reply and quote: private posts share the public defaults above
 *   (Horizon writes a private post's limits as the stock gate records, from
 *   the same composer settings), so this is a note, not a second form;
 * - Audiences, moved here from its own Settings row.
 *
 * Each choice is saved at once to the account's posting defaults record
 * (`query.ts`). Non-members see the stock screen: neither piece renders.
 */

import {View} from 'react-native'
import {Trans, useLingui} from '@lingui/react/macro'

import {atoms as a, useTheme} from '#/alf'
import {Admonition} from '#/components/Admonition'
import {Button} from '#/components/Button'
import * as Dialog from '#/components/Dialog'
import * as Toggle from '#/components/forms/Toggle'
import {ChevronRight_Stroke2_Corner0_Rounded as ChevronRightIcon} from '#/components/icons/Chevron'
import {ListPlus_Stroke2_Corner0_Rounded as ListPlusIcon} from '#/components/icons/List'
import {PersonGroup_Stroke2_Corner2_Rounded as PersonGroupIcon} from '#/components/icons/Person'
import {Link} from '#/components/Link'
import {Loader} from '#/components/Loader'
import {Text} from '#/components/Typography'
import {type StandingMode} from '#/horizon/private/api/audiences'
import {AudienceEditorDialog} from '#/horizon/private/audiences/AudienceEditorDialog'
import {useAudiencesQuery} from '#/horizon/private/audiences/useAudiencesQuery'
import {
  listName,
  pickableListAudiences,
  useModeLabel,
} from '#/horizon/private/composer/AudienceMenu'
import {postingDefaultsOn} from '#/horizon/private/defaults/compose'
import {
  usePostingDefaultsQuery,
  useSetPostingDefaultsMutation,
} from '#/horizon/private/defaults/query'
import {
  type DefaultAudience,
  type PrivateDefaults,
} from '#/horizon/private/defaults/record'
import {useIsMember} from '#/horizon/private/membership'

/**
 * Whether the screen shows its two sections: the switches are on and the
 * account is a member.
 */
function useShowsSections(): boolean {
  const isMember = useIsMember()
  return postingDefaultsOn() && isMember
}

function SectionHeadingText({children}: {children: React.ReactNode}) {
  return (
    <Text style={[a.text_lg, a.font_semi_bold]} accessibilityRole="header">
      {children}
    </Text>
  )
}

/**
 * The "Public posts" heading above the stock defaults, for members.
 */
export function PublicPostsHeading() {
  const shows = useShowsSections()
  if (!shows) return null
  return (
    <SectionHeadingText>
      <Trans>Public posts</Trans>
    </SectionHeadingText>
  )
}

/**
 * The "Private posts" section below the stock defaults, for members.
 */
export function PrivatePostsSection() {
  const t = useTheme()
  const shows = useShowsSections()
  if (!shows) return null
  return (
    <View
      testID="privatePostsSection"
      style={[a.gap_xl, a.pt_xl, a.border_t, t.atoms.border_contrast_low]}>
      <SectionHeadingText>
        <Trans>Private posts</Trans>
      </SectionHeadingText>
      <PrivateDefaultsForm />
      <ReplyAndQuoteNote />
      <AudiencesLink />
    </View>
  )
}

function PrivateDefaultsForm() {
  const {t: l} = useLingui()
  const {data: defaults, isError} = usePostingDefaultsQuery({enabled: true})
  const {mutate: save} = useSetPostingDefaultsMutation()

  if (!defaults) {
    return isError ? (
      <Admonition type="error">
        <Trans>Failed to load your private posting defaults.</Trans>
      </Admonition>
    ) : (
      <View style={[a.py_md, a.align_center]}>
        <Loader size="lg" />
      </View>
    )
  }

  const change = (next: Partial<PrivateDefaults>) =>
    save({...defaults, ...next})

  return (
    <>
      <View style={[a.gap_sm]}>
        <Text style={[a.text_md, a.font_medium]}>
          <Trans>New posts start as</Trans>
        </Text>
        <Toggle.Group
          type="radio"
          label={l`Choose whether new posts start public or private`}
          values={[defaults.startAs]}
          onChange={values => {
            const next = values[0]
            if (
              (next === 'public' || next === 'private') &&
              next !== defaults.startAs
            ) {
              change({startAs: next})
            }
          }}>
          <View style={[a.flex_row, a.gap_sm]}>
            <Toggle.Item
              testID="defaultStartPublic"
              name="public"
              label={l`New posts start public`}
              style={[a.flex_1]}>
              {({selected}) => (
                <Toggle.Panel active={selected}>
                  <Toggle.Radio />
                  <Toggle.PanelText>
                    <Trans>Public</Trans>
                  </Toggle.PanelText>
                </Toggle.Panel>
              )}
            </Toggle.Item>
            <Toggle.Item
              testID="defaultStartPrivate"
              name="private"
              label={l`New posts start private`}
              style={[a.flex_1]}>
              {({selected}) => (
                <Toggle.Panel active={selected}>
                  <Toggle.Radio />
                  <Toggle.PanelText>
                    <Trans>Private</Trans>
                  </Toggle.PanelText>
                </Toggle.Panel>
              )}
            </Toggle.Item>
          </View>
        </Toggle.Group>
        <HintText>
          <Trans>
            Replies and quotes start as the post they reply to or quote. Replies
            to private posts are always private.
          </Trans>
        </HintText>
      </View>
      <DefaultAudienceForm
        audience={defaults.audience}
        onChange={audience => change({audience})}
      />
    </>
  )
}

/** The radio value of `audience`; none selected while none is chosen. */
function audienceValue(audience: DefaultAudience | undefined): string {
  if (!audience) return ''
  return audience.kind === 'list' ? `list:${audience.uri}` : audience.mode
}

function DefaultAudienceForm({
  audience,
  onChange,
}: {
  audience: DefaultAudience | undefined
  onChange: (next: DefaultAudience) => void
}) {
  const {t: l} = useLingui()
  const modeLabel = useModeLabel()
  const editor = Dialog.useDialogControl()
  const {data: audiences, isPending, isError} = useAudiencesQuery()
  const lists = pickableListAudiences(audiences)
  const value = audienceValue(audience)
  /*
   * A default list the account no longer has (or not yet listed) stays
   * chosen and shown, so it is never widened here; a post naming it is
   * refused at publish.
   */
  const missingList =
    audience?.kind === 'list' &&
    !isPending &&
    !lists.some(entry => entry.uri === audience.uri)

  const onValues = (values: string[]) => {
    const next = values[0]
    if (!next || next === value) return
    if (next.startsWith('list:')) {
      onChange({kind: 'list', uri: next.slice('list:'.length)})
      return
    }
    onChange({kind: 'mode', mode: next as StandingMode})
  }

  const standing = (mode: StandingMode, detailText?: string) => (
    <Toggle.Item key={mode} name={mode} label={modeLabel(mode)}>
      {({selected}) => (
        <Toggle.Panel active={selected} adjacent="both">
          <Toggle.Radio />
          <View style={[a.flex_1, a.gap_2xs]}>
            <Toggle.PanelText>{modeLabel(mode)}</Toggle.PanelText>
            {detailText ? <HintText>{detailText}</HintText> : null}
          </View>
        </Toggle.Panel>
      )}
    </Toggle.Item>
  )

  return (
    <View style={[a.gap_sm]}>
      <Text style={[a.text_md, a.font_medium]}>
        <Trans>Default audience</Trans>
      </Text>
      <Toggle.Group
        type="radio"
        label={l`Choose who can see your private posts by default`}
        values={[value]}
        onChange={onValues}>
        <Toggle.PanelGroup>
          {standing('everyone', l`Everyone who can see private posts`)}
          {standing('followers')}
          {standing('following')}
          {lists.map(entry => {
            const name = listName(entry) ?? ''
            return (
              <Toggle.Item
                key={entry.uri}
                name={`list:${entry.uri}`}
                label={l`List: ${name}`}>
                {({selected}) => (
                  <Toggle.Panel active={selected} adjacent="both">
                    <Toggle.Radio />
                    <Toggle.PanelText>{name}</Toggle.PanelText>
                  </Toggle.Panel>
                )}
              </Toggle.Item>
            )
          })}
          {missingList ? (
            <Toggle.Item name={value} label={l`A list you no longer have`}>
              {({selected}) => (
                <Toggle.Panel active={selected} adjacent="both">
                  <Toggle.Radio />
                  <Toggle.PanelText>
                    <Trans>A list you no longer have</Trans>
                  </Toggle.PanelText>
                </Toggle.Panel>
              )}
            </Toggle.Item>
          ) : null}
          {standing('nobody')}
        </Toggle.PanelGroup>
      </Toggle.Group>
      {audience ? null : (
        <HintText>
          <Trans>
            Until you choose, posts you make private go to Everyone, and quotes
            of private posts start private to Followers.
          </Trans>
        </HintText>
      )}
      {isError ? (
        <HintText>
          <Trans>Your lists could not be loaded.</Trans>
        </HintText>
      ) : null}
      <Button
        testID="defaultNewAudience"
        label={l`New audience…`}
        onPress={() => editor.open()}>
        {({hovered, pressed}) => (
          <RowLink
            icon={ListPlusIcon}
            titleText={<Trans>New audience…</Trans>}
            active={hovered || pressed}
          />
        )}
      </Button>
      <AudienceEditorDialog
        control={editor}
        kind="audience"
        onCreated={uri => onChange({kind: 'list', uri})}
      />
    </View>
  )
}

function ReplyAndQuoteNote() {
  return (
    <View style={[a.gap_sm]}>
      <Text style={[a.text_md, a.font_medium]}>
        <Trans>Who can reply and quote</Trans>
      </Text>
      <HintText>
        <Trans>
          Private posts start with the same reply and quote settings as public
          posts, set above. You can change them for each post in the composer.
        </Trans>
      </HintText>
    </View>
  )
}

function AudiencesLink() {
  const {t: l} = useLingui()
  return (
    <Link
      testID="interactionSettingsAudiences"
      to="/settings/audiences"
      label={l`Audiences`}>
      {({hovered, pressed}) => (
        <RowLink
          icon={PersonGroupIcon}
          titleText={<Trans>Audiences</Trans>}
          detailText={
            <Trans>The people your private posts can be shown to</Trans>
          }
          active={hovered || pressed}
          chevron
        />
      )}
    </Link>
  )
}

function RowLink({
  icon: Icon,
  titleText,
  detailText,
  active,
  chevron = false,
}: {
  icon: typeof PersonGroupIcon
  titleText: React.ReactNode
  detailText?: React.ReactNode
  active: boolean
  chevron?: boolean
}) {
  const t = useTheme()
  return (
    <View
      style={[
        a.w_full,
        a.flex_row,
        a.align_center,
        a.gap_sm,
        a.px_md,
        a.py_md,
        a.rounded_md,
        active ? t.atoms.bg_contrast_100 : t.atoms.bg_contrast_50,
      ]}>
      <Icon size="md" style={[t.atoms.text_contrast_medium]} />
      <View style={[a.flex_1, a.gap_2xs]}>
        <Text style={[a.text_md, a.font_medium]}>{titleText}</Text>
        {detailText ? <HintText>{detailText}</HintText> : null}
      </View>
      {chevron ? (
        <ChevronRightIcon size="sm" style={[t.atoms.text_contrast_low]} />
      ) : null}
    </View>
  )
}

function HintText({children}: {children: React.ReactNode}) {
  const t = useTheme()
  return (
    <Text style={[a.text_sm, a.leading_snug, t.atoms.text_contrast_medium]}>
      {children}
    </Text>
  )
}
