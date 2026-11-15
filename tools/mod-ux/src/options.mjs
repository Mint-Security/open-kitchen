/**
 * Shared option contracts for the JavaScript controller. These are editor-facing
 * JSDoc types; scenario/action validation remains in protocol.mjs.
 *
 * @typedef {object} CommandOptions
 * @property {number} [timeoutMs] Subprocess deadline in milliseconds.
 * @property {string} [cwd] Working directory for the subprocess.
 * @property {Record<string, string | undefined>} [env] Subprocess environment; defaults to process.env.
 * @property {AbortSignal} [signal] Cancels the current subprocess invocation.
 * @property {number} [maxBytes] Combined stdout/stderr byte limit.
 *
 * @typedef {CommandOptions & { input?: string }} ProcessOptions
 * @typedef {(command: string[], options?: ProcessOptions) => Promise<{stdout: string, stderr?: string}>} Executor
 *
 * @typedef {object} AgentCallOptions
 * @property {AbortSignal} [signal] Per-call cancellation, overriding the caller's default signal.
 * @typedef {(request: Record<string, unknown>, options?: AgentCallOptions) => Promise<unknown>} Agent
 *
 * @typedef {CommandOptions & {
 *   model?: string,
 *   budgetUsd?: number,
 *   binary?: string,
 *   executeCommand?: Executor
 * }} ClaudeOptions
 *
 * @typedef {object} AgentCallerOptions
 * @property {string} [model] Model passed to the built-in Claude adapter.
 * @property {number} [callBudgetUsd=0.5] Per-invocation Claude budget, not a run-wide cap.
 * @property {number} [timeoutMs=60000] Per-invocation subprocess deadline.
 * @property {string} [cwd] Working directory for the agent process.
 * @property {AbortSignal} [signal] Default cancellation signal.
 * @property {Session} [session] Mutable run state receiving timing and usage records.
 *
 * @typedef {object} PeekabooOptions
 * @property {string} [binary] Executable; defaults to MOD_UX_PEEKABOO or peekaboo.
 * @property {string} [app] Must identify the supported Claude Desktop app.
 * @property {string | number} [windowId] Exact window to attach to.
 * @property {'background' | 'foreground'} [interactionMode='background'] Explicit input mode.
 * @property {string} [bridgeSocket] Authorized companion socket; defaults to PEEKABOO_BRIDGE_SOCKET.
 * @property {Executor} [executeCommand] Subprocess implementation, injectable for tests.
 *
 * @typedef {{draft: string, pane: boolean, focused: boolean, buggy: boolean}} FixtureState
 * @typedef {{buggy?: boolean, state?: FixtureState}} FixtureOptions
 * @typedef {import('./peekaboo.mjs').PeekabooDriver | import('./fixture.mjs').FixtureDriver} Driver
 * @typedef {Awaited<ReturnType<typeof import('./session.mjs').createSession>>} Session
 * @typedef {'completed' | 'blocked' | 'error' | 'limit' | 'stopped'} FinalStatus
 *
 * @typedef {object} SessionContext
 * @property {string} directory Run directory containing state and evidence.
 * @property {Session} session Mutable state created by createSession or loaded by withSession.
 * @typedef {SessionContext & {driver: Driver}} DriverContext
 * @typedef {DriverContext & CommandOptions} CaptureOptions
 * @typedef {CaptureOptions & {action: object, observationId: string}} ActionOptions
 * @typedef {SessionContext & {status: FinalStatus, summary: string}} FinishOptions
 * @typedef {SessionContext & AgentCallOptions & {critic: Agent}} ReviewOptions
 * @typedef {DriverContext & {actor: Agent, critic?: Agent, signal?: AbortSignal}} RunOptions
 *
 * @typedef {object} CreateSessionOptions
 * @property {object} scenario Versioned scenario, validated before creating the run.
 * @property {string} directory New run directory; existing directories are refused.
 * @property {Driver} [driver] Defaults to the Peekaboo desktop driver.
 * @property {string | number} [windowId] Exact desktop window, when constructing a driver.
 * @property {string} [variant='current'] Evidence label; does not toggle mods.
 * @property {Record<string, unknown>} [provenance] Caller-supplied source/version metadata.
 *
 * @typedef {object} OutputOptions
 * @property {boolean} [allowUnignored=false] Explicitly bypass the Git output-visibility check.
 */

export {};
