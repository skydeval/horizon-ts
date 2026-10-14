import {MetricsClient} from '#/analytics/metrics/client'
import {type Events} from '#/analytics/metrics/types'

/**
 * A metrics client that records and sends nothing. It extends Bluesky's
 * `MetricsClient` so the shared `metrics` object keeps its type and every
 * caller type-checks unchanged.
 */
export class NoopMetricsClient extends MetricsClient<Events> {
  start() {}

  track() {}

  flush() {}
}
