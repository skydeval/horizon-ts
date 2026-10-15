/*
 * The server a signup goes to: probing a server for what it offers, and
 * handing the picked server to the stock password signup.
 *
 * Adapted from the Witchsky client (MIT), src/screens/Signup/index.tsx (the
 * `describeServer` probe), src/screens/Signup/providers.ts (`normalizePdsUrl`)
 * and src/screens/Signup/oauthSignupUtils.ts (`oauthSignupErrorMessage`).
 */

import {createContext, useContext} from 'react'

import {createServiceClient} from '#/lib/lexClient'
import {cleanError, isNetworkError} from '#/lib/strings/errors'
import {logger} from '#/logger'
import {com} from '#/lexicons'

/**
 * aurora-locus, first in the picker.
 */
export const AURORA_LOCUS_SERVICE = 'https://locus.nearhorizon.app'

/**
 * What a server offers for signup.
 */
export type SignupServerProbe = {
  /** `describeServer` answered. */
  reachable: boolean
  inviteCodeRequired: boolean
  availableUserDomains: string[]
  /** OAuth account creation: `prompt_values_supported` includes `create`. */
  supportsCreatePrompt: boolean
}

/**
 * Normalise a typed server address into a service URL: trimmed, lowercase,
 * `https://` added when missing (`http://` for `localhost`).
 */
export function normalizeServerUrl(input: string): string {
  let url = input.trim().toLowerCase()
  if (!url) return ''
  if (!url.startsWith('http://') && !url.startsWith('https://')) {
    url =
      url === 'localhost' || url.startsWith('localhost:')
        ? `http://${url}`
        : `https://${url}`
  }
  return url.replace(/\/+$/, '')
}

async function readJson(url: string): Promise<Record<string, unknown>> {
  const response = await fetch(url)
  if (!response.ok) throw new Error(`${url}: ${response.status}`)
  const body: unknown = await response.json()
  if (!body || typeof body !== 'object') throw new Error(`${url}: not JSON`)
  return body as Record<string, unknown>
}

/**
 * Whether the server's authorization server advertises OAuth account
 * creation: `/.well-known/oauth-protected-resource`, then the first
 * authorization server's `/.well-known/oauth-authorization-server`.
 */
async function supportsCreatePrompt(serviceUrl: string): Promise<boolean> {
  try {
    const resource = await readJson(
      `${serviceUrl}/.well-known/oauth-protected-resource`,
    )
    const servers = resource.authorization_servers
    const issuer =
      Array.isArray(servers) && typeof servers[0] === 'string'
        ? servers[0]
        : serviceUrl
    const metadata = await readJson(
      `${issuer.replace(/\/+$/, '')}/.well-known/oauth-authorization-server`,
    )
    const prompts = metadata.prompt_values_supported
    return Array.isArray(prompts) && prompts.includes('create')
  } catch {
    return false
  }
}

/**
 * Probe a server once: `describeServer` for reachability, invite codes and
 * user domains, then its OAuth metadata for `prompt=create`.
 */
export async function probeSignupServer(
  serviceUrl: string,
): Promise<SignupServerProbe> {
  try {
    const description = await createServiceClient(serviceUrl).call(
      com.atproto.server.describeServer,
      {},
    )
    return {
      reachable: true,
      inviteCodeRequired: !!description.inviteCodeRequired,
      availableUserDomains: description.availableUserDomains,
      supportsCreatePrompt: await supportsCreatePrompt(serviceUrl),
    }
  } catch (e) {
    logger.debug('signup: server probe failed', {
      serviceUrl,
      message: e instanceof Error ? e.message : String(e),
    })
    return {
      reachable: false,
      inviteCodeRequired: false,
      availableUserDomains: [],
      supportsCreatePrompt: false,
    }
  }
}

/**
 * The text to show when starting OAuth signup failed, or `null` when the user
 * cancelled.
 */
export function oauthSignupErrorMessage(
  e: unknown,
  messages: {network: string; generic: string},
): string | null {
  const message = String(e)
  if (message.includes('cancelled') || message.includes('dismiss')) {
    return null
  }
  if (isNetworkError(e)) {
    logger.warn('signup: OAuth start failed (network)', {error: message})
    return messages.network
  }
  logger.warn('signup: OAuth start failed', {error: message})
  return cleanError(e) || messages.generic
}

/**
 * The server the picker chose for the stock password signup; empty outside
 * the picker.
 */
export const SignupServiceContext = createContext<string | undefined>(undefined)
SignupServiceContext.displayName = 'SignupServiceContext'

/**
 * The stock signup's initial state, with the picked server when the picker
 * set one, otherwise unchanged.
 */
export function useSignupInitialState<State extends {serviceUrl: string}>(
  state: State,
): State {
  const picked = useContext(SignupServiceContext)
  return picked ? {...state, serviceUrl: picked} : state
}
