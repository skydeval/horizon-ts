/*
 * Reading and writing the private posting defaults
 * (`app.nearhorizon.actor.postingDefaults/self`) in the signed-in account's
 * own repo, through its own PDS client: Horizon never reads another
 * account's defaults and never writes anywhere but the account's own repo.
 *
 * The defaults are a query per account, with a device copy as its initial
 * data so the composer starts from them at once and refetches in the
 * background. A write re-reads the record, replaces `private` and keeps the
 * rest, swapped on the CID just read; writes for one account run one after
 * another, so the last choice made is the one kept.
 */

import {type Client, type LexMap, XrpcResponseError} from '@atproto/lex'
import {type DidString} from '@atproto/syntax'
import {t} from '@lingui/core/macro'
import {useMutation, useQuery, useQueryClient} from '@tanstack/react-query'

import {logger} from '#/logger'
import {STALE} from '#/state/queries'
import {useMaybePdsClient, useSession} from '#/state/session'
import * as Toast from '#/components/Toast'
import {
  POSTING_DEFAULTS_COLLECTION,
  POSTING_DEFAULTS_RKEY,
} from '#/horizon/lexicons/posting-defaults'
import {
  audienceRecord,
  buildPostingDefaultsRecord,
  buildReadingSettingsRecord,
  DEFAULT_PRIVATE_DEFAULTS,
  DEFAULT_READING_SETTINGS,
  parsePostingDefaultsRecord,
  parsePrivateDefaults,
  parseReadingSettings,
  type PrivateDefaults,
  type ReadingSettings,
} from '#/horizon/private/defaults/record'
import {readLocal, writeLocal} from '#/horizon/session/local-store'
import {com} from '#/lexicons'

export const postingDefaultsQueryKey = (did: string) => [
  'horizon-posting-defaults',
  did,
]

function deviceKey(did: string) {
  return `horizon:posting-defaults:${did}`
}

/**
 * The device copy of `did`'s defaults, read with the record's own parser, or
 * `undefined` when there is none.
 */
export function readDeviceDefaults(did: string): PrivateDefaults | undefined {
  if (!did) return undefined
  const raw = readLocal(deviceKey(did))
  if (!raw) return undefined
  try {
    return parsePrivateDefaults(JSON.parse(raw), did)
  } catch {
    return undefined
  }
}

function writeDeviceDefaults(did: string, defaults: PrivateDefaults) {
  writeLocal(
    deviceKey(did),
    JSON.stringify({
      startAs: defaults.startAs,
      // None chosen stays none (`record.ts`).
      ...(defaults.audience
        ? {audience: audienceRecord(defaults.audience)}
        : {}),
    }),
  )
}

type ReadResult = {
  defaults: PrivateDefaults
  reading: ReadingSettings
  raw: Record<string, unknown> | null
  cid: string | null
}

const NO_RECORD: ReadResult = {
  defaults: DEFAULT_PRIVATE_DEFAULTS,
  reading: DEFAULT_READING_SETTINGS,
  raw: null,
  cid: null,
}

async function readRecord(client: Client, did: string): Promise<ReadResult> {
  try {
    const res = await client.call(com.atproto.repo.getRecord, {
      repo: did as DidString,
      collection: POSTING_DEFAULTS_COLLECTION,
      rkey: POSTING_DEFAULTS_RKEY,
    })
    const parsed = parsePostingDefaultsRecord(res.value, did)
    if (!parsed) return NO_RECORD
    return {
      defaults: parsed.defaults,
      reading: parsed.reading,
      raw: parsed.raw,
      cid: res.cid ?? null,
    }
  } catch (error) {
    if (
      error instanceof XrpcResponseError &&
      error.error === 'RecordNotFound'
    ) {
      return NO_RECORD
    }
    throw error
  }
}

/**
 * `did`'s defaults, read from its own repo (the defaults when it has no
 * record). The device copy is updated.
 */
export async function fetchPostingDefaults(
  client: Client,
  did: string,
): Promise<PrivateDefaults> {
  const {defaults} = await readRecord(client, did)
  writeDeviceDefaults(did, defaults)
  return defaults
}

function isSwapFailure(error: unknown) {
  return (
    error instanceof XrpcResponseError &&
    (error.error === 'InvalidSwap' || error.status === 404)
  )
}

const MAX_SWAP_RETRIES = 2

/**
 * Write `defaults` to `did`'s own record: read it, replace `private`, put it
 * swapped on the CID read, and on a swap failure read and try again.
 */
export async function writePostingDefaults(
  client: Client,
  did: string,
  defaults: PrivateDefaults,
  now: () => Date = () => new Date(),
): Promise<PrivateDefaults> {
  for (let attempt = 0; ; attempt++) {
    const read = await readRecord(client, did)
    const record = buildPostingDefaultsRecord(read.raw, defaults, now())
    try {
      await client.call(com.atproto.repo.putRecord, {
        repo: did as DidString,
        collection: POSTING_DEFAULTS_COLLECTION,
        rkey: POSTING_DEFAULTS_RKEY,
        // Horizon's fields plus values kept as read from the repo.
        record: record as LexMap,
        swapRecord: read.cid,
      })
    } catch (error) {
      if (isSwapFailure(error) && attempt < MAX_SWAP_RETRIES) continue
      throw error
    }
    writeDeviceDefaults(did, defaults)
    return defaults
  }
}

const MUTATION_KEY = ['horizon-posting-defaults-write']

/** Writes per account, one after another. */
const chains = new Map<string, Promise<unknown>>()

function queued<T>(did: string, run: () => Promise<T>): Promise<T> {
  const previous = chains.get(did) ?? Promise.resolve()
  const next = previous.then(run, run)
  chains.set(
    did,
    next.catch(() => {}),
  )
  return next
}

/**
 * The current account's private posting defaults: the device copy at once,
 * then the record. `enabled` is false for anyone who may not use them.
 */
export function usePostingDefaultsQuery({enabled}: {enabled: boolean}) {
  const {currentAccount} = useSession()
  const pdsClient = useMaybePdsClient()
  const did = currentAccount?.did ?? ''
  return useQuery({
    queryKey: postingDefaultsQueryKey(did),
    queryFn: () =>
      pdsClient
        ? fetchPostingDefaults(pdsClient, did)
        : DEFAULT_PRIVATE_DEFAULTS,
    initialData: () => readDeviceDefaults(did),
    // The device copy is shown at once but always read again.
    initialDataUpdatedAt: 0,
    staleTime: STALE.MINUTES.FIVE,
    enabled: enabled && !!pdsClient && !!did,
  })
}

/**
 * Save the current account's private posting defaults. The query shows the
 * new value at once and goes back to the previous one, with a toast, when
 * the write fails.
 */
export function useSetPostingDefaultsMutation() {
  const queryClient = useQueryClient()
  const {currentAccount} = useSession()
  const pdsClient = useMaybePdsClient()
  const did = currentAccount?.did ?? ''
  return useMutation({
    mutationKey: MUTATION_KEY,
    mutationFn: (defaults: PrivateDefaults) => {
      if (!pdsClient || !did) throw new Error('Not signed in')
      return queued(did, () => writePostingDefaults(pdsClient, did, defaults))
    },
    onMutate: async defaults => {
      const key = postingDefaultsQueryKey(did)
      await queryClient.cancelQueries({queryKey: key})
      const previous = queryClient.getQueryData<PrivateDefaults>(key)
      queryClient.setQueryData(key, defaults)
      return {previous}
    },
    onError: (error, _defaults, context) => {
      const key = postingDefaultsQueryKey(did)
      // A later choice may be on its way: only go back when none is.
      if (queryClient.isMutating({mutationKey: MUTATION_KEY}) <= 1) {
        queryClient.setQueryData(
          key,
          context?.previous ?? DEFAULT_PRIVATE_DEFAULTS,
        )
      }
      void queryClient.invalidateQueries({queryKey: key})
      logger.warn('posting defaults: the write failed', {
        safeMessage: error instanceof Error ? error.message : String(error),
      })
      Toast.show(t`Failed to save settings. Please try again.`, {
        type: 'error',
      })
    },
  })
}

/*
 * The account's reading choices (change list item 2), kept in the same
 * record: read for every signed-in account, members or not, and written
 * through the same queue, so a reading write and a defaults write never
 * race.
 */

export const readingSettingsQueryKey = (did: string) => [
  'horizon-reading-settings',
  did,
]

function readingDeviceKey(did: string) {
  return `horizon:reading-settings:${did}`
}

/**
 * The device copy of `did`'s reading choices, or `undefined` when there is
 * none.
 */
export function readDeviceReadingSettings(
  did: string,
): ReadingSettings | undefined {
  if (!did) return undefined
  const raw = readLocal(readingDeviceKey(did))
  if (!raw) return undefined
  try {
    return parseReadingSettings(JSON.parse(raw))
  } catch {
    return undefined
  }
}

function writeDeviceReadingSettings(did: string, reading: ReadingSettings) {
  writeLocal(readingDeviceKey(did), JSON.stringify(reading))
}

/**
 * `did`'s reading choices, read from its own repo (the defaults when it has
 * no record). The device copy is updated.
 */
export async function fetchReadingSettings(
  client: Client,
  did: string,
): Promise<ReadingSettings> {
  const {reading} = await readRecord(client, did)
  writeDeviceReadingSettings(did, reading)
  return reading
}

/**
 * Write `reading` to `did`'s own record: read it, replace `reading`, keep
 * everything else, put it swapped on the CID read, and retry a swap failure.
 */
export async function writeReadingSettings(
  client: Client,
  did: string,
  reading: ReadingSettings,
  now: () => Date = () => new Date(),
): Promise<ReadingSettings> {
  for (let attempt = 0; ; attempt++) {
    const read = await readRecord(client, did)
    const record = buildReadingSettingsRecord(read.raw, reading, now())
    try {
      await client.call(com.atproto.repo.putRecord, {
        repo: did as DidString,
        collection: POSTING_DEFAULTS_COLLECTION,
        rkey: POSTING_DEFAULTS_RKEY,
        // Horizon's fields plus values kept as read from the repo.
        record: record as LexMap,
        swapRecord: read.cid,
      })
    } catch (error) {
      if (isSwapFailure(error) && attempt < MAX_SWAP_RETRIES) continue
      throw error
    }
    writeDeviceReadingSettings(did, reading)
    return reading
  }
}

/**
 * The current account's reading choices: the device copy at once, then the
 * record. Signed out, nothing is read and the defaults apply.
 */
export function useReadingSettingsQuery() {
  const {currentAccount} = useSession()
  const pdsClient = useMaybePdsClient()
  const did = currentAccount?.did ?? ''
  return useQuery({
    queryKey: readingSettingsQueryKey(did),
    queryFn: () =>
      pdsClient
        ? fetchReadingSettings(pdsClient, did)
        : DEFAULT_READING_SETTINGS,
    initialData: () => readDeviceReadingSettings(did),
    initialDataUpdatedAt: 0,
    staleTime: STALE.MINUTES.FIVE,
    enabled: !!pdsClient && !!did,
  })
}

const READING_MUTATION_KEY = ['horizon-reading-settings-write']

/**
 * Save the current account's reading choices, shown at once and put back,
 * with a toast, when the write fails.
 */
export function useSetReadingSettingsMutation() {
  const queryClient = useQueryClient()
  const {currentAccount} = useSession()
  const pdsClient = useMaybePdsClient()
  const did = currentAccount?.did ?? ''
  return useMutation({
    mutationKey: READING_MUTATION_KEY,
    mutationFn: (reading: ReadingSettings) => {
      if (!pdsClient || !did) throw new Error('Not signed in')
      return queued(did, () => writeReadingSettings(pdsClient, did, reading))
    },
    onMutate: async reading => {
      const key = readingSettingsQueryKey(did)
      await queryClient.cancelQueries({queryKey: key})
      const previous = queryClient.getQueryData<ReadingSettings>(key)
      queryClient.setQueryData(key, reading)
      return {previous}
    },
    onError: (error, _reading, context) => {
      const key = readingSettingsQueryKey(did)
      if (queryClient.isMutating({mutationKey: READING_MUTATION_KEY}) <= 1) {
        queryClient.setQueryData(
          key,
          context?.previous ?? DEFAULT_READING_SETTINGS,
        )
      }
      void queryClient.invalidateQueries({queryKey: key})
      logger.warn('reading settings: the write failed', {
        safeMessage: error instanceof Error ? error.message : String(error),
      })
      Toast.show(t`Failed to save settings. Please try again.`, {
        type: 'error',
      })
    },
  })
}
