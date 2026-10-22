/*
 * Native has no client encoder: Hermes has no WebAssembly (2K design D-0.13),
 * so the posting route on a non-locus PDS is `none` with reason `no-encoder`.
 */

import {type Encoder, PrivateEncoderUnavailableError} from './types'

export * from './types'

export function encoderAvailable(): boolean {
  return false
}

export function prewarmEncoder(): void {}

export function loadEncoder(): Promise<Encoder> {
  return Promise.reject(new PrivateEncoderUnavailableError())
}
