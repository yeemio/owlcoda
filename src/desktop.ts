/**
 * Public desktop product-shell facade.
 *
 * External shells should import `owlcoda/desktop` instead of reaching into
 * `src/native/app-server/*`, so App Server and runtime internals can evolve
 * behind one semver-visible contract.
 */

export {
  createAppServerClient,
  AppServerClientError,
  type AppServerClient,
  type AppServerClientOptions,
  type AppServerEventSubscription,
  type AppServerCompatibilityCheckResult,
} from './native/app-server/client.js'

export {
  DEFAULT_DESKTOP_CAPABILITY_GATE_POLICY,
  evaluateDesktopCapabilityGate,
  type DesktopCapabilityGatePolicy,
  type DesktopCapabilityGateResult,
} from './native/app-server/desktop-capability-gate.js'

export {
  bootstrapDesktopProductShell,
  type DesktopProductShellBootstrapOptions,
  type DesktopProductShellBootstrapResult,
} from './native/app-server/desktop-product-shell.js'

export {
  runDesktopProductShellSmoke,
  type DesktopProductShellSmokeChecks,
  type DesktopProductShellSmokeDebugBoundary,
  type DesktopProductShellSmokeOptions,
  type DesktopProductShellSmokeResult,
} from './native/app-server/desktop-product-shell-smoke.js'

export {
  buildDesktopModelComparisonPanel,
  loadDesktopProductShellViewModel,
  latestRunIdFromDesktopTranscript,
  type DesktopModelComparisonCaseItem,
  type DesktopModelComparisonLeaderboardItem,
  type DesktopModelComparisonPanel,
  type DesktopModelComparisonPanelStatus,
  type DesktopProductShellRuntimeView,
  type DesktopProductShellViewModel,
  type DesktopProductShellViewModelParams,
  type DesktopProductShellViewModelStatus,
  type DesktopRuntimeFactsStatus,
} from './native/app-server/desktop-product-shell-view-model.js'

export {
  connectDesktopProductShellLiveEvents,
  createDesktopProductShellLiveAdapter,
  DESKTOP_PRODUCT_SHELL_LIVE_EVENT_TYPES,
  type DesktopProductShellLiveAdapter,
  type DesktopProductShellLiveAdapterOptions,
  type DesktopProductShellEventSourceLike,
  type DesktopProductShellLiveConnection,
  type DesktopProductShellLiveConnectionOptions,
  type DesktopProductShellLiveSnapshot,
  type DesktopProductShellServerEventLike,
} from './native/app-server/desktop-product-shell-live-events.js'

export {
  buildDesktopRuntimeFactsDrilldown,
  type DesktopRuntimeFactsArtifactItem,
  type DesktopRuntimeFactsCheckpointItem,
  type DesktopRuntimeFactsDrilldown,
  type DesktopRuntimeFactsDrilldownEntities,
  type DesktopRuntimeFactsDrilldownInput,
  type DesktopRuntimeFactsDrilldownScorecardStatus,
  type DesktopRuntimeFactsDrilldownSummary,
  type DesktopRuntimeFactsEventItem,
  type DesktopRuntimeFactsJobItem,
  type DesktopRuntimeFactsProofItem,
  type DesktopRuntimeFactsScorecardSummary,
} from './native/app-server/desktop-runtime-facts-drilldown.js'

export type {
  AppServerProtocolDescription,
  AppServerProviderEvalReportReadResult,
  AppServerRuntimeFactsReadResult,
  AppServerRuntimeScorecardReadResult,
  AppServerStructuredOutputArtifactItem,
  AppServerStructuredOutputArtifactsReadInput,
  AppServerStructuredOutputArtifactsReadResult,
  AppServerStructuredOutputArtifactStatus,
  AppServerStructuredOutputAttemptItem,
  AppServerStructuredOutputRerunAction,
  AppServerClientIdentity,
  AppServerClientInitializeInput,
  AppServerClientInitializeResult,
  AppServerCompatibility,
} from './native/app-server/protocol-contract.js'
