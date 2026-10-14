import {MetricsClient} from '#/analytics/metrics/client'
import {type Events} from '#/analytics/metrics/types'
// HORIZON: no usage metrics are sent to Bluesky
import {TELEMETRY_OFF} from '#/horizon/switches'
// HORIZON: no usage metrics are sent to Bluesky
import {NoopMetricsClient} from '#/horizon/telemetry/NoopMetricsClient'

export type {Events as Metrics} from '#/analytics/metrics/types'
export * from '#/analytics/metrics/utils'
// HORIZON: no usage metrics are sent to Bluesky
export const metrics: MetricsClient<Events> = TELEMETRY_OFF
  ? new NoopMetricsClient()
  : new MetricsClient<Events>()
