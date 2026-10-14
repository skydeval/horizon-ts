/*
 * Fixed switches that Horizon's hooks into Bluesky's files guard on. They are
 * not user settings. Each is typed as `boolean`, not as its literal value, so
 * TypeScript keeps the guarded stock branch and lint sees its imports as used.
 * Flipping one restores Bluesky's behaviour at that hook.
 */

/**
 * Nothing is sent to Bluesky's metrics service, and Sentry stays off even if
 * a DSN is set.
 */
export const TELEMETRY_OFF: boolean = true

/**
 * Bluesky's feature flags are read from the local table in
 * `#/horizon/flags` instead of being fetched from Bluesky's GrowthBook.
 */
export const LOCAL_FLAGS: boolean = true

/**
 * Age assurance is off for every session, signed in or out.
 */
export const AGE_ASSURANCE_OFF: boolean = true

/**
 * Settings > About shows "Send error report". Off while error reporting is
 * off, since the report would go nowhere.
 */
export const SHOW_ERROR_REPORT: boolean = false

/**
 * Settings shows "Beta features", Bluesky's beta enrolment, kept for when
 * Bluesky ships new betas. Its list is empty while every current beta is on
 * by default in the local flag table.
 */
export const SHOW_BETA_FEATURES: boolean = true
