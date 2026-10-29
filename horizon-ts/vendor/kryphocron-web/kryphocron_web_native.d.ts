/* tslint:disable */
/* eslint-disable */

/**
 * Prepare the encoded fields of a private post.
 *
 * - `did`, `nsid`, `rkey`: where the record will be written.
 * - `content_json`: `{"text": string, "facets"?: array, "embed"?: object}`;
 *   `text` is required (empty when the post has none).
 * - `now_secs`: the current time in Unix seconds (`Date.now() / 1000`).
 *
 * Returns a JSON string of the fields to add to the record:
 * `encodedContent` (`{"$bytes": …}`), `encodedContentCodec`,
 * `encodedContentGeneration`, and whichever of `embedBlobs`, `mentionDids`,
 * `quote` and `mediaKinds` are non-empty. The record must not also carry
 * `text`, `facets` or `embed`.
 *
 * # Errors
 *
 * A JS `Error` when the identity or content is malformed, the time is out of
 * range, or the browser's CSRNG fails.
 */
export function preparePrivatePost(did: string, nsid: string, rkey: string, content_json: string, now_secs: number): string;

export type InitInput = RequestInfo | URL | Response | BufferSource | WebAssembly.Module;

export interface InitOutput {
    readonly memory: WebAssembly.Memory;
    readonly preparePrivatePost: (a: number, b: number, c: number, d: number, e: number, f: number, g: number, h: number, i: number, j: number) => void;
    readonly rust_zstd_wasm_shim_qsort: (a: number, b: number, c: number, d: number) => void;
    readonly rust_zstd_wasm_shim_malloc: (a: number) => number;
    readonly rust_zstd_wasm_shim_memcmp: (a: number, b: number, c: number) => number;
    readonly rust_zstd_wasm_shim_calloc: (a: number, b: number) => number;
    readonly rust_zstd_wasm_shim_free: (a: number) => void;
    readonly rust_zstd_wasm_shim_memcpy: (a: number, b: number, c: number) => number;
    readonly rust_zstd_wasm_shim_memmove: (a: number, b: number, c: number) => number;
    readonly rust_zstd_wasm_shim_memset: (a: number, b: number, c: number) => number;
    readonly __wbindgen_export: (a: number) => void;
    readonly __wbindgen_add_to_stack_pointer: (a: number) => number;
    readonly __wbindgen_export2: (a: number, b: number) => number;
    readonly __wbindgen_export3: (a: number, b: number, c: number, d: number) => number;
    readonly __wbindgen_export4: (a: number, b: number, c: number) => void;
}

export type SyncInitInput = BufferSource | WebAssembly.Module;

/**
 * Instantiates the given `module`, which can either be bytes or
 * a precompiled `WebAssembly.Module`.
 *
 * @param {{ module: SyncInitInput }} module - Passing `SyncInitInput` directly is deprecated.
 *
 * @returns {InitOutput}
 */
export function initSync(module: { module: SyncInitInput } | SyncInitInput): InitOutput;

/**
 * If `module_or_path` is {RequestInfo} or {URL}, makes a request and
 * for everything else, calls `WebAssembly.instantiate` directly.
 *
 * @param {{ module_or_path: InitInput | Promise<InitInput> }} module_or_path - Passing `InitInput` directly is deprecated.
 *
 * @returns {Promise<InitOutput>}
 */
export default function __wbg_init (module_or_path?: { module_or_path: InitInput | Promise<InitInput> } | InitInput | Promise<InitInput>): Promise<InitOutput>;
