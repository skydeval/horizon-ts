import {describe, expect, it} from '@jest/globals'

import {getReportSubjectLabel} from '#/screens/ModerationInbox/components/util/reportSubjectLabel'
import {isKryphocronReport} from '#/horizon/report/kryphocron-report'

const PP = 'at://did:plc:abc/tools.kryphocron.feed.postPrivate/3k2a'
const POST = 'at://did:plc:abc/app.bsky.feed.post/3k2a'

const strongRef = (uri: string) => ({
  subject: {$type: 'com.atproto.repo.strongRef' as const, uri, cid: 'bafy'},
})

describe('isKryphocronReport', () => {
  it('sorts reports by their subject', () => {
    expect(isKryphocronReport(strongRef(PP) as never)).toBe(true)
    expect(isKryphocronReport(strongRef(POST) as never)).toBe(false)
    expect(
      isKryphocronReport({
        subject: {$type: 'com.atproto.admin.defs#repoRef', did: 'did:plc:abc'},
      }),
    ).toBe(false)
  })
})

describe('getReportSubjectLabel', () => {
  it('names a kryphocron post as a post', () => {
    const label = getReportSubjectLabel(strongRef(PP).subject as never, {
      authorName: 'Ash',
    })
    expect(label.message ?? label.id).toMatch(/Post by/)
  })
})
