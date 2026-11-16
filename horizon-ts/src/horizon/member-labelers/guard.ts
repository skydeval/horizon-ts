/*
 * A member labeler's id never leaves for a public server: it isn't an
 * account, and naming it would tell that server it exists.
 *
 * This sits on every lex client's agent (`createLexClient`), the one place
 * every request passes, so no stock path can miss it:
 * - a request whose URL names a member labeler is refused before it is sent
 *   (a profile or labeler lookup, a link that slipped through);
 * - a request proxied to one (`atproto-proxy`, as a report or appeal to a
 *   labeler would be) is refused;
 * - an `atproto-accept-labelers` header loses any member labeler in it.
 *
 * Calls that are meant to carry an id (prism's labeler methods, reports to
 * the labeler's operator) don't use a lex client and put it in a body.
 */

import {type Agent} from '@atproto/lex'

import {isMemberLabelerId} from './ids'

/** A request refused because it would name a member labeler. */
export class MemberLabelerLeakError extends Error {
  constructor() {
    super('This request would name a labeler that isn’t public.')
    this.name = 'MemberLabelerLeakError'
  }
}

/** Every DID-shaped run in `text`. */
const DIDS = /did:[a-z]+:[A-Za-z0-9._:%-]+/g

function namesMemberLabeler(text: string): boolean {
  let decoded = text
  try {
    decoded = decodeURIComponent(text)
  } catch {
    // Not URI-encoded as a whole: check it as it is.
  }
  for (const match of decoded.matchAll(DIDS)) {
    // A service ref (`did#fragment`) or a path segment ends the DID.
    if (isMemberLabelerId(match[0])) return true
  }
  return false
}

/**
 * Throws {@link MemberLabelerLeakError} for a request that would name a
 * member labeler; returns the request's init, with any member labeler taken
 * out of `atproto-accept-labelers`.
 */
export function guardRequest(path: string, init?: RequestInit): RequestInit {
  if (namesMemberLabeler(path)) throw new MemberLabelerLeakError()
  if (!init?.headers) return init ?? {}
  const headers = new Headers(init.headers)
  const proxy = headers.get('atproto-proxy')
  if (proxy && namesMemberLabeler(proxy.split('#')[0])) {
    throw new MemberLabelerLeakError()
  }
  const accept = headers.get('atproto-accept-labelers')
  if (accept && namesMemberLabeler(accept)) {
    const kept = accept
      .split(',')
      .map(entry => entry.trim())
      .filter(entry => entry && !isMemberLabelerId(entry.split(';')[0]))
    if (kept.length) headers.set('atproto-accept-labelers', kept.join(', '))
    else headers.delete('atproto-accept-labelers')
    return {...init, headers}
  }
  return init
}

const guarded = new WeakMap<object, Agent>()

/** The same agent, with every request checked first. Idempotent. */
export function withMemberLabelerGuard(agent: Agent): Agent {
  const known = guarded.get(agent)
  if (known) return known
  const proxy = new Proxy(agent, {
    get(target, prop) {
      if (prop === 'fetchHandler') {
        return (path: `/${string}`, init: RequestInit) =>
          target.fetchHandler(path, guardRequest(path, init))
      }
      const value: unknown = Reflect.get(target, prop, target)
      return typeof value === 'function' ? value.bind(target) : value
    },
  })
  guarded.set(agent, proxy)
  guarded.set(proxy, proxy)
  return proxy
}
