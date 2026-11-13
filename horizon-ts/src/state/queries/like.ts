import {type AtUriString} from '@atproto/syntax'
import {deleteLike, like} from '@bsky/sdk'
import {useMutation} from '@tanstack/react-query'

import {usePdsClient} from '#/state/session'
// HORIZON: never like a kryphocron labeler
import {
  isKryphocronLabeler,
  KryphocronLabelerError,
  likedLabelerDid,
} from '#/horizon/kryphocron-labelers'

export function useLikeMutation() {
  const pdsClient = usePdsClient()
  return useMutation({
    mutationFn: async ({uri, cid}: {uri: string; cid: string}) => {
      // HORIZON: a like would name a kryphocron labeler in public
      const labelerDid = likedLabelerDid(uri)
      if (labelerDid && isKryphocronLabeler(labelerDid)) {
        throw new KryphocronLabelerError()
      }
      const res = await pdsClient.call(like, {
        uri: uri as AtUriString,
        cid,
      })
      return {uri: res.uri}
    },
  })
}

export function useUnlikeMutation() {
  const pdsClient = usePdsClient()
  return useMutation({
    mutationFn: async ({uri}: {uri: string}) => {
      await pdsClient.call(deleteLike, uri as AtUriString)
    },
  })
}
