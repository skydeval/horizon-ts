/*
 * The Thread Lens strings (Phase 4 design 8.1, 10, 11.3, 11.4, 9.3) as
 * Lingui descriptors, each with a comment naming Thread Lens. A row's list
 * name (8.3) is a variable, so that line is built where it renders.
 */

import {type MessageDescriptor} from '@lingui/core'
import {msg} from '@lingui/core/macro'

import {type LensNoteReason} from '#/horizon/thread-lens/snapshot'

/** A gap row's text by prism's kind (8.1); unknown kinds read as generic. */
export const GAP_TEXT = {
  'blocked-by-you': msg({
    message: 'Post from someone you’ve blocked',
    comment:
      'Thread Lens: a placeholder for a post by someone the reader blocked',
  }),
  'blocking-you': msg({
    message: 'Post from someone who has blocked you',
    comment:
      'Thread Lens: a placeholder for a post by someone who blocked the reader',
  }),
  blocked: msg({
    message: 'Post hidden by a block',
    comment:
      'Thread Lens: a placeholder for a post the thread hides because of a block between other people',
  }),
  'block-state-unknown': msg({
    message: 'Thread Lens couldn’t check this post',
    comment:
      'Thread Lens: a placeholder for a post whose block state is not known',
  }),
  deleted: msg({
    message: 'Deleted post',
    comment: 'Thread Lens: a placeholder for a deleted post',
  }),
  'not-found': msg({
    message: 'Post not found',
    comment: 'Thread Lens: a placeholder for a post that was not found',
  }),
  'upstream-unavailable': msg({
    message: 'Post couldn’t be loaded',
    comment: 'Thread Lens: a placeholder for a post that could not be loaded',
  }),
  'content-stripped': msg({
    message: 'Post unavailable',
    comment: 'Thread Lens: a placeholder for a post that is not available',
  }),
  unverified: msg({
    message: 'Post not loaded',
    comment:
      'Thread Lens: the placeholder of a post opened from Thread Lens that could not be checked',
  }),
} satisfies Record<string, MessageDescriptor>

/** Any kind not in {@link GAP_TEXT}. */
export const GAP_GENERIC = msg({
  message: 'Post unavailable',
  comment: 'Thread Lens: a placeholder for a post that is not available',
})

/** "Blocked by a list", when the list's name cannot be read (8.3). */
export const BLOCKED_BY_A_LIST = msg({
  message: 'Blocked by a list',
  comment:
    'Thread Lens: a placeholder for a post by someone the reader blocks through a list whose name is not known',
})

export const RETRY = msg({
  message: 'Retry',
  comment: 'Thread Lens: retry loading a post that could not be checked',
})
export const VIEW_LIST = msg({
  message: 'View list',
  comment: 'Thread Lens: open the block list that hides a post',
})
export const OPEN_PRIVATE_POST = msg({
  message: 'Open private post',
  comment: 'Thread Lens: open a private post that sits in the thread',
})
export const STILL_UNAVAILABLE = msg({
  message: 'Still unavailable',
  comment: 'Thread Lens: a retried post is still not available',
})
export const ROW_FAILED = msg({
  message: 'Couldn’t load. Try again',
  comment: 'Thread Lens: loading more of the thread failed',
})
export const LOAD_EARLIER = msg({
  message: 'Load earlier posts',
  comment: 'Thread Lens: load the posts above the top of the thread, in place',
})
export const LOAD_MORE_REPLIES = msg({
  message: 'Load more replies',
  comment: 'Thread Lens: load more replies under a post, in place',
})
export const TRY_AGAIN = msg({
  message: 'Try again',
  comment: 'Thread Lens: read the thread through Thread Lens again',
})

/** The "incomplete" notice (10). */
export const BRIDGING_LIMITED = msg({
  message:
    'Thread Lens can’t check every post right now, so some may be missing.',
  comment: 'Thread Lens: the thread may be missing posts',
})
export const BRIDGING_OFF = msg({
  message:
    'Thread Lens can’t see around blocks right now. This is the thread as it normally appears.',
  comment: 'Thread Lens: the thread is shown as it normally appears',
})

/** A fallback's note (11.3). */
export const FALLBACK_NOTE: Record<'429' | 'unavailable', MessageDescriptor> = {
  '429': msg({
    message: 'Thread Lens is busy. Showing the thread as it normally appears.',
    comment: 'Thread Lens: rate limited, showing the ordinary thread',
  }),
  unavailable: msg({
    message:
      'Thread Lens isn’t available right now. Showing the thread as it normally appears.',
    comment: 'Thread Lens: the lens failed, showing the ordinary thread',
  }),
}

/** A failed refetch's note over a kept snapshot (11.3, TL-35). */
export const KEPT_NOTE: Record<'429' | 'unavailable', MessageDescriptor> = {
  '429': msg({
    message: 'Thread Lens is busy, so this thread couldn’t be refreshed.',
    comment:
      'Thread Lens: rate limited, the thread shown is the one loaded before',
  }),
  unavailable: msg({
    message:
      'Thread Lens couldn’t refresh this thread. Showing what was loaded.',
    comment:
      'Thread Lens: a refresh failed, the thread shown is the one loaded before',
  }),
}

/** A gap-only answer's note (11.3). */
export const GAP_ONLY_NOTE: Record<LensNoteReason, MessageDescriptor> = {
  off: msg({
    message:
      'This post is hidden. Turn on Thread Lens to see the conversation around it.',
    comment: 'Thread Lens: a hidden post opened with Thread Lens off',
  }),
  'not-served': msg({
    message:
      'This post is hidden, and Thread Lens isn’t available for this account.',
    comment:
      'Thread Lens: a hidden post opened by an account Thread Lens does not serve',
  }),
  '429': msg({
    message: 'Thread Lens is busy, so only this placeholder can be shown.',
    comment: 'Thread Lens: rate limited on a hidden post',
  }),
  unavailable: msg({
    message:
      'Thread Lens isn’t available right now, so only this placeholder can be shown.',
    comment: 'Thread Lens: the lens failed on a hidden post',
  }),
}

/** The unverified answer's note (11.3, TL-33). */
export const UNVERIFIED_NOTE: Record<LensNoteReason, MessageDescriptor> = {
  off: msg({
    message:
      'This post was opened from Thread Lens. Turn on Thread Lens to see it.',
    comment:
      'Thread Lens: a post opened from a Thread Lens link with Thread Lens off',
  }),
  'not-served': msg({
    message:
      'This post was opened from Thread Lens, which isn’t available for this account.',
    comment:
      'Thread Lens: a post opened from a Thread Lens link by an account it does not serve',
  }),
  '429': msg({
    message: 'Thread Lens is busy, so this post can’t be shown yet.',
    comment:
      'Thread Lens: rate limited on a post opened from a Thread Lens link',
  }),
  unavailable: msg({
    message:
      'Thread Lens isn’t available right now, so this post can’t be shown.',
    comment:
      'Thread Lens: the lens failed on a post opened from a Thread Lens link',
  }),
}

/** The composer note (8.5). */
export const REPLY_NOTE = msg({
  message:
    'Someone earlier in this thread has blocked you, so they won’t see your reply.',
  comment: 'Thread Lens: shown in the composer under the post being replied to',
})

/** The control's name (TL-17). */
export const CONTROL_NAME = msg({
  message: 'Thread Lens',
  comment: 'Thread Lens: the name of the setting',
})
export const CONTROL_EXPLANATION = msg({
  message:
    'Show the conversation around posts from people you’ve blocked or who’ve blocked you, and around deleted posts. Hidden posts show as placeholders.',
  comment:
    'Thread Lens: the explanation under the setting in Thread Preferences',
})
export const ANNOUNCE_ON = msg({
  message: 'Thread Lens on',
  comment: 'Thread Lens: announced when the setting is turned on',
})
export const ANNOUNCE_OFF = msg({
  message: 'Thread Lens off',
  comment: 'Thread Lens: announced when the setting is turned off',
})
