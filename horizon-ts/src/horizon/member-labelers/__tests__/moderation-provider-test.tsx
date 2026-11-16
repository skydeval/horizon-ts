import {beforeEach, describe, expect, it, jest} from '@jest/globals'

/*
 * The real moderation options provider, rendered (React Compiler runs in
 * Jest too): member labelers that arrive after the first render must reach
 * the options every consumer moderates with. A plain store read in the
 * provider's render was cached by the compiler and never saw them.
 */

const VIEWER = 'did:plc:mlviewer00000000000000001'
const LABELER = 'did:web:cairn.example.test:labeler:mltest1'

jest.mock('#/horizon/session/local-store', () => ({
  readLocal: () => undefined,
  writeLocal: () => {},
}))
jest.mock('#/state/session', () => ({
  useSession: () => ({currentAccount: {did: VIEWER}}),
}))
const mockPrefs = {
  data: {
    moderationPrefs: {
      adultContentEnabled: false,
      labels: {},
      labelers: [{did: 'did:plc:ar7c4by46qjdydhdevvrndac', labels: {}}],
      mutedWords: [],
      hiddenPosts: [],
    },
  },
}
jest.mock('#/state/queries/preferences', () => ({
  usePreferencesQuery: () => mockPrefs,
}))
const mockLabelDefs = {labelDefs: {}, labelers: []}
jest.mock('#/state/preferences', () => ({
  useHiddenPosts: () => undefined,
  useLabelDefinitions: () => mockLabelDefs,
}))
jest.mock('#/horizon/refract/labeler', () => ({
  useCommunityLabelerVersion: () => '0:0',
}))

import {act, renderHook} from '@testing-library/react-native'

import {Provider, useModerationOpts} from '#/state/preferences/moderation-opts'
import {
  loadMemberLabelers,
  refreshMemberLabelers,
  resetMemberLabelers,
} from '../store'

beforeEach(() => {
  resetMemberLabelers()
})

describe('moderation options provider', () => {
  it('picks up member labelers that arrive after the first render', async () => {
    loadMemberLabelers(VIEWER)
    const {result} = renderHook(() => useModerationOpts(), {
      wrapper: Provider,
    })
    expect(result.current?.prefs.labelers.map(entry => entry.did)).toEqual([
      'did:plc:ar7c4by46qjdydhdevvrndac',
    ])
    await act(async () => {
      await refreshMemberLabelers(VIEWER, {} as never, {
        fetchLabelers: () =>
          Promise.resolve([
            {
              did: LABELER,
              kind: 'moderation',
              state: 'active',
              profile: {displayName: 'Test labeler'},
              policies: {
                policies: {labelValues: [], labelValueDefinitions: []},
              },
            },
          ]),
        fetchImage: () => Promise.reject(new Error('no image')),
      })
    })
    expect(result.current?.prefs.labelers.map(entry => entry.did)).toEqual([
      'did:plc:ar7c4by46qjdydhdevvrndac',
      LABELER,
    ])
  })
})
