import {createContext, useContext, useMemo} from 'react'
import {type InterpretedLabelValueDefinition} from '@bsky/sdk/moderation'

import {
  communityLabelInfo,
  useCommunityLabelerVersion,
} from '#/horizon/refract/labeler'
import {type app} from '#/lexicons'
import {useLabelDefinitionsQuery} from '../queries/preferences'

interface StateContext {
  labelDefs: Record<string, InterpretedLabelValueDefinition[]>
  labelers: app.bsky.labeler.defs.LabelerViewDetailed[]
}

const stateContext = createContext<StateContext>({
  labelDefs: {},
  labelers: [],
})
stateContext.displayName = 'LabelDefsStateContext'

export function Provider({children}: React.PropsWithChildren<{}>) {
  const stockState = useLabelDefinitionsQuery()
  /*
   * HORIZON: C-8: a member's community labelers named on restored views'
   * labels; the reader's own labelers win (refract client design 6)
   */
  const communityLabeler = useCommunityLabelerVersion()
  const state = useMemo(() => {
    void communityLabeler
    const community = communityLabelInfo()
    if (community.labelers.length === 0) return stockState
    const own = new Set(stockState.labelers.map(view => view.creator.did))
    return {
      labelDefs: {...community.labelDefs, ...stockState.labelDefs},
      labelers: [
        ...stockState.labelers,
        ...community.labelers.filter(view => !own.has(view.creator.did)),
      ],
    }
  }, [stockState, communityLabeler])
  return <stateContext.Provider value={state}>{children}</stateContext.Provider>
}

export function useLabelDefinitions() {
  return useContext(stateContext)
}
