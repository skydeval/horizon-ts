/*
 * One aster fetch, as a placeholder (a Thread Lens gap row or a blocked
 * quote card) runs it: the grant's labels, the call to prism, its outcome,
 * and undo. The outcome lives in this component's state only; nothing is
 * cached. An unmount or a new call aborts the one in flight.
 */

import {useEffect, useRef, useState} from 'react'

import {useSession} from '#/state/session'
import {type AsterLabels, useAsterLabels} from '#/horizon/routing/aster'
import {getCurrentClients} from '#/horizon/routing/current-clients'
import {ASTER} from '#/horizon/switches'
import {getAsterPost} from '#/horizon/thread-lens/api'
import {type AsterOutcome, asterOutcome} from '#/horizon/thread-lens/aster'
import {type app} from '#/lexicons'

export type AsterState =
  | {status: 'idle' | 'loading' | 'error'}
  | {status: 'done'; outcome: AsterOutcome}

export type UseAster = {
  /** The labels, when the action applies here; else `undefined`. */
  labels: AsterLabels | undefined
  state: AsterState
  /** The aster node to draw, once fetched. */
  view: app.bsky.feed.defs.PostView | undefined
  run: () => void
  undo: () => void
}

/**
 * The aster action for the post at `uri`. `offered` is whether this kind of
 * placeholder offers it at all; the grant and the `ASTER` switch decide the
 * rest.
 */
export function useAster(uri: string, offered: boolean): UseAster {
  const {currentAccount} = useSession()
  const granted = useAsterLabels(currentAccount?.did)
  const labels = ASTER && offered ? granted : undefined
  const [state, setState] = useState<AsterState>({status: 'idle'})
  const abort = useRef<AbortController | undefined>(undefined)
  useEffect(() => () => abort.current?.abort(), [])

  const run = () => {
    const did = currentAccount?.did
    const clients = getCurrentClients()
    if (!labels || !did || !clients || clients.did !== did) return
    abort.current?.abort()
    const controller = new AbortController()
    abort.current = controller
    setState({status: 'loading'})
    getAsterPost(clients.prismClient, did, uri, controller.signal).then(
      node => {
        if (controller.signal.aborted) return
        setState({status: 'done', outcome: asterOutcome(node, uri)})
      },
      () => {
        if (controller.signal.aborted) return
        setState({status: 'error'})
      },
    )
  }

  const view =
    labels && state.status === 'done' && state.outcome.kind === 'post'
      ? state.outcome.view
      : undefined

  return {
    labels,
    state,
    view,
    run,
    undo: () => setState({status: 'idle'}),
  }
}
