# Changelog

## [Unreleased]

## [0.9.1] - 2026-09-23

### Fixed

- **SECURITY: `GET /user/list/apiEndPoints` was unauthenticated.** The route was missing the
  `errors.assertFromPartner(req)` call its four sibling routes in `src/routes/userRoute.ts` all
  carry, so any caller able to reach a bridge could read it. The response streams every
  `credentials/pryv-api-endpoint` event on the bridge account, and a Pryv apiEndpoint embeds its
  auth token, so the exposure was every onboarded user's credentials rather than only metadata.

  `checkAuth.checkIfPartner` is app-level middleware that only *sets* `req.isPartner`; enforcing
  it is each route's own job, which is why one route missing the assertion was silently open. The
  router is mounted unconditionally at `/user` in `src/server.ts`, so this was live on every
  bridge built on this package.

  **No consumer in the workspace calls the route** (grep across `apps/`, `bridges/`, `libs/`,
  `services/`, `infra/`, `_local/`), so the change to 401 breaks nothing; the exposure was purely
  incidental.

  New `tests/userRouteAuth.test.ts` mounts the router on a bare Express app with the same
  middleware chain rather than going through `getApp()`. That is deliberate: `getApp()`
  initializes the bridge account against a live `bridgeApiEndPoint`, so the whole integration
  suite skips on a machine without one — and a security regression must not be invisible there.
  Verified by reverting the fix: `[USAN]` and `[USAB]` fail without it, all 31 pass with it.

  **Consumers must `npm update lib-bridge-js` and redeploy** to pick this up — they pin by SHA.

## [0.9.0] - 2026-09-18

### Changed

- **`hds-lib` 1.3.4 to 2.5.0.** The dependency is declared as a floating git URL, so the
  committed lockfile was the only thing pinning it, and it had been frozen on a 1.3.4 SHA while
  hds-lib moved a full major version ahead. Every consumer of this package inherited that pin, so
  the four bridges and datasets-service were all resolving a 1.x hds-lib (and with it a stale
  `@pryv/*` 3.10.0 tree) long after the apps had moved to 2.x. The bump also brings `pryv` to
  3.12.0 and `@pryv/cmc` to 3.16.1 here.

  **The 2.0.0 breaking change does not reach this package.** It narrowed
  `HDSItemDef.eventTemplate()` to refuse guessing which declared variation the caller meant;
  lib-bridge-js has no `eventTemplate` call site. The four symbols it does import from hds-lib
  (`pryv`, `initHDSModel`, `getHDSModel`, `HDSService`) are all still exported unchanged at 2.5.0.

  Gate: `tsc --noEmit` clean, `eslint` clean, 26 passing / 12 pending, identical to the 1.3.4
  baseline. The resolved SHA is `e87afd31`, the tip of hds-lib-js `main`.

  **Consumers are not affected until they update.** They pin this package by SHA, so the four
  bridges and datasets-service keep their current tree until each runs `npm update lib-bridge-js`
  with its own test pass.


## [0.8.7] - 2026-09-11

### Fixed

- **Onboarding handed the user a `redirectUserURL` of `undefined` against open-pryv.io 2.x.**
  `POST /reg/access` was slimmed in the v2 refactor to the calling-app surface
  (`status`, `key`, `authUrl`, `poll`, `poll_rate_ms`); the field carrying the sign-in URL is
  now `authUrl`, and the request echo the response used to carry (`code`, `returnURL`,
  `requestedPermissions`, `requestingAppId`, `clientData`) is gone. `onboard.ts` still read
  `responseBody.url`, so every onboarding start returned `redirectUserURL: undefined` and the
  partner backend had nowhere to send the user. Only `url` was affected: the other field the
  flow depends on, `poll`, is unchanged in v2.

### Changed

- **Dependency advisories cleared by a lockfile refresh** (`npm audit fix`, no `--force`):
  13 down to 3. `package.json` is untouched. What remains is dev-only (`mocha` and, through it,
  `serialize-javascript`, both needing the `mocha@12` semver-major) plus `qs`, which
  `express@4.22.1` pins to exactly `6.14.2` while the advisories only clear at `6.16.0` —
  npm reports it in-range but cannot lift it, so it needs an `overrides` entry or express 5.

### Tests

- Brought the integration suite onto the v2 reg API: values the bridge sent are asserted from
  config rather than from the response echo, the access-state update sends `apiEndpoint`
  (it had been `apiEndPoint`, which the pre-v2 server tolerated), and event assertions read
  `streamIds` rather than the deprecated singular `streamId`. 38 passing, previously 34 with
  4 failing.


## [0.8.6] - 2026-09-07

### Changed

- **`backloop.dev` now installs from GitHub instead of npm** (2026-09-07). The service stopped
  being public on 2026-09-04: a certificate authority must revoke any certificate whose private
  key is published, and both did. The two packages also moved into repositories of their own, so
  both are now pinned by tag.

  ```
  backloop.dev             git+https://github.com/perki/backloop.dev-node.git#v5.1.0
  vite-plugin-backloop.dev git+https://github.com/perki/backloop.dev-vite.git#v2.2.0
  ```

  5.1.0 rather than 5.0.0 is deliberate. 5.0.0 fails to start when no secret is configured;
  5.1.0 falls back to a shared self-signed certificate, so local development still works without
  one. That certificate installs once per machine from <https://backloop.dev/public/>, and
  Firefox will not accept it because it ignores the system trust store. To use your own
  certificate instead, point `BACKLOOP_DEV_CERT` and `BACKLOOP_DEV_KEY` at the PEM files.

  **One-time step in every existing checkout.** npm does not replace a package that moved from
  the registry to a git URL: it leaves the old directory on disk while `npm ls` and
  `package-lock.json` both report the new version, so the old code keeps loading.

  ```sh
  rm -rf node_modules/backloop.dev node_modules/vite-plugin-backloop.dev && npm install
  ```


## [0.8.5] - 2026-08-28

### Fixed
- `addCredentialToBridgeAccount` is now genuinely idempotent, as its docstring already
  claimed. It was an unconditional `events.create`, so every repeat call appended another
  `credentials/pryv-api-endpoint` event. Callers depend on repeat calls: the CMC inbox
  watcher re-processes recent accepts after each restart and runs independently in every
  cluster worker.

  On prod 2026-08-28 one accept produced a new credential event every 30s per worker — 10
  duplicates within minutes, growing without bound (~5,700/day per connected user). Nothing
  broke visibly because reads use `limit: 1` and take the newest; the account simply grew
  forever. This is also the most likely origin of the duplicate records previously noticed
  on the old prod bridge account.

  It now reuses an existing credential event and updates it in place, re-asserting the
  active-users stream so a previously deactivated user is reactivated rather than
  duplicated, and creates only when none exists.

## [0.8.4] - 2026-08-28

### Fixed
- Telemetry no longer drops the requests that FAILED. `observabilityTiming` named a call
  `${req.method} ${req.baseUrl}${route.path}` inside `res.on('finish')`. That is correct for
  a request that completed normally, but when a handler calls `next(err)` Express unwinds
  the router to reach the app-level error handler and restores `req.baseUrl` to `''` on the
  way out — and `finish` fires after that. So an errored request on a mounted router was
  named `GET /authReturn/` rather than `GET /mira/authReturn/`, matched nothing in the
  collected method list, and was refused as `unknown_method`.

  The failure mode was the worst possible one for observability: successful mounted
  requests were recorded, failed ones were silently discarded, so `hds.calls` could never
  show an error rate for any mounted route — precisely the signal alerting needs. Found on
  prod 2026-08-28 (`observability drop [unknown_method]: GET /authReturn/`) while
  investigating why bridge-mira reported no metrics.

  The mount prefix is now recovered from `req.originalUrl`, which Express never rewrites:
  when `baseUrl` is empty and the original path has more segments than the route pattern,
  the extra leading segments are the mount. Segment counting (not string matching) keeps it
  correct for patterns containing params, whose concrete values differ from the pattern
  text. `baseUrl` is still preferred whenever it survived.

## [0.8.3] - 2026-08-28

### Fixed
- `ensureBaseStreams()` no longer kills a worker when several cluster workers race to
  create the same base streams. Every worker runs `init()`, so on a bridge account whose
  base streams don't exist yet they all issue the same three `streams.create` calls at
  once. The losers of that race are not guaranteed to get `item-already-exists`: the
  server may surface the storage-level unique-constraint violation as `unexpected-error`
  instead, which the old error-id filter passed straight through to `serviceError` —
  crashing the worker with `Failed creating base streams`.

  Observed on production 2026-08-28 when `bridge-mira` was repointed at a freshly created
  account: one worker died with `duplicate key value violates unique constraint
  "streams_pkey"` (statusCode 501, `id: 'unexpected-error'`). With
  `start.exitOnCrashLoop: true` a persistent version of this takes the whole app down.

  The fix stops classifying by error id and verifies the end state instead: if the base
  streams all exist once the batch returns, that is success regardless of how they got
  there, and only a genuinely missing stream is an error. This stays correct whether or
  not the server-side error mapping is fixed upstream.

## [0.8.2] - 2026-08-18

### Fixed
- `userExists()` no longer asks the registry's `check_username`, which is answered from
  the **serving core's local** user index and therefore reports users hosted on another
  core as non-existent. On a multi-core platform whose registry hostname round-robins
  across cores, the old implementation returned a different answer depending on which
  core replied. It now delegates to `pryv.Service.userExists()`, i.e.
  `POST {register}/{username}/server`, which resolves through the platform-wide store and
  is correct on every core.
  No caller in the HDS workspace uses this export today, so this is a latent trap in the
  library's public API rather than an observed failure — but it would have misfired the
  moment a bridge relied on it. Upstream: https://github.com/pryv/open-pryv.io/issues/122

## [0.8.1] - 2026-07-30

### Added
- **Export the observability primitives** `observabilityTiming`, `initBridgeObservability`
  and the `ObsHolder` type from the public API (plan 88). Standalone Express services that
  don't boot through `createBridgeApp` (e.g. `datasets-service`, `bridge-athenahealth`) can
  now install the same fence-4-compliant timing middleware + OTLP emitter instead of copying
  the route-pattern allow-list logic — keeping a single audited implementation of what leaves
  the process.

## [0.8.0] - 2026-07-29

### Changed
- **Replaced the New Relic APM agent with `hds-observability-js`** (plan 88). `createBridgeApp`
  installs an early `observabilityTiming` middleware and, after routes are mounted, builds an
  OTLP emitter from the registered route **patterns** (never concrete paths — fence 4), exporting
  `hds.calls` / `hds.call.duration` to the host collector. No vendor SDK runs in the process;
  a no-op unless `HDS_OTEL_ENDPOINT` / `observability:endpoint` is set. New Relic removed from
  `start.ts` (crash-loops now covered by the collector's container-uptime alert condition).

## [0.7.1] - 2026-07-21

### Fixed
- **Exposed-URL config now accepts both `baseURL` and `baseUrl`.** The lib read
  `baseURL` (capital) for the `Api is exposed on` log line and the onboarding
  `returnURL`, but bridge consumers (e.g. bridge-mira, which uses the same value
  for its OAuth `redirect_uri`) configure `baseUrl` (lowercase) — so the lib saw
  `undefined` (logged `Api is exposed on: undefined`, and would have built a
  malformed onboard `returnURL`). Both read sites now fall back
  `baseURL ?? baseUrl`, and the log states when neither is set. No API change.

## [0.7.0] - 2026-07-20

### Added
- **Cluster crash-loop detection, backoff & escalation.** The cluster master no longer
  respawns crashing workers unconditionally (which could hide an infinite crash-loop for
  hours while emitting no monitoring signal). It now:
  - detects a crash-loop (default: 5 crashes within 30s),
  - fires **one** New Relic `noticeError` per incident (via an optional `require('newrelic')`
    behind a try/catch — non-monitored deploys are unaffected),
  - reforks with exponential backoff (1→2→4→8→16s, capped at 30s) instead of immediately,
    resetting once a worker survives 60s,
  - and, when `start:exitOnCrashLoop: true` (opt-in, **default false**), exits the master
    with code 1 after the loop persists 5 min so the orchestrator marks the app down.

  Graceful worker exits (`exitedAfterDisconnect`) and SIGTERM/SIGINT are excluded, so the
  master doesn't fight an intentional stop/restart. Detection logic lives in a pure,
  unit-tested `src/lib/crashLoopMonitor.ts`. No API changes; healthy-bridge behaviour is
  unchanged.

## [0.6.3] - 2026-07-16

### Fixed
- **Re-pinned `hds-lib` to 1.3.1**, which unbreaks `model.itemsDefs` against the live
  data-model pack ([site-agents#3](https://github.com/healthdatasafe/site-agents/issues/3)).
  hds-lib's `streamId:eventType` index rejected the deprecated rename-aliases that
  data-model 2.0.0 publishes, so every `itemsDefs` access threw. Bridges reading the model
  (`bridge-mira`, `bridge-chartneo`) inherited the break **through this lockfile**: npm
  honours a git dependency's own `package-lock.json` when running its `prepare`, so the old
  hds-lib was baked in no matter what the consuming bridge did. Bumping here is what
  actually releases the fix downstream. No API changes.

## [0.6.2] - 2026-06-19

### Changed
- Dependency refresh: re-pinned `hds-lib` to 1.2.1, carrying the pryv ecosystem bump to 3.7.1 (matches the open-pryv.io 2.0.0-rc.4 prod cores — Plan 78). No API changes.

## [0.6.1] - 2026-05-04

### Fixed — `bridgeAccount.init()` permission check robust against extra Pryv permissions

Bridges entered a crash loop after the dev Pryv (`demo.datasafe.dev`) started returning `:_system:account` (level `none`) as the first entry in `accessInfo().permissions`, pushing the real `{ streamId: 'bridge', level: 'manage' }` entry to index 1. The previous check looked at `permissions[0]` only and also read `settings.mainStreamId` before it had been assigned (so the comparison was effectively against `null`, and the error message read `… on stream null`).

- `src/lib/bridgeAccount.ts`: assign `settings.mainStreamId` (and derived stream IDs) **before** the access check, then verify by searching the full `permissions` array for an entry matching `mainStreamId` with `level === 'manage'` instead of relying on index `0`.

No API change. Bumps patch.

## [0.6.0] - 2026-04-28

### Added — `ensureAppStreamsTree` helper (Plan 25 / Plan 45 Phase 9)

Public helper for bridges to provision their `{appId}-app/` subtree on a user account in one call, replacing per-bridge boilerplate.

```ts
import { ensureAppStreamsTree } from 'lib-bridge-js';

const { appStreamId, subStreamIds } = await ensureAppStreamsTree(hdsConnection, {
  appId: 'bridge-mira',
  baseName: 'Mira App',
  parentId: 'bridge-mira',                          // optional: child of an existing base stream
  subStreams: [
    { suffix: 'notes', name: 'Notes' },             // → bridge-mira-app-notes
    { suffix: 'chat',  name: 'Chat',                // → bridge-mira-app-chat
      clientData: { hdsCustomField: { /* ... */ } } // optional clientData per substream
    }
  ]
});
```

- Idempotent — tolerates `item-already-exists` on `streams.create`.
- Returns `{ appStreamId: '${appId}-app', subStreamIds: { suffix: fullId, ... } }` so callers can attach `clientData.appStreamId` on the bridge access (via `appTemplates.ensureBridgeAccess`) and post events to specific substreams.
- Validates `appId` and substream `suffix` are non-empty strings.
- 9 tests in `tests/appStreams.test.ts` covering root-only / parentId / baseName / substreams / clientData passthrough / idempotency / hard-error rejection / input validation.

Closes Plan 25's final import to Plan 45 Phase 9. `bridge-mira` will be the first consumer (separate commit there).

## [0.5.0] - 2026-03-19

### Changed
- Updated hds-lib dependency to 0.2.0 (converter engine support)

## [0.4.0] - 2026-03-11

### Changed
- Removed `dist/` from git (rebuilt by `prepare` on install)
- Added re-exports for bridge consumers (pryv, Router, ShortUniqueId, initHDSModel, getHDSModel)
- Exported `getLogger` for plugin use

### Added
- Shared cluster cache abstraction (memored)
- `/status` route returning name, version, uptime from package.json
- Build step with separate test export
- `exports` field for ESM resolution

### Changed
- Upgraded to Node 24
- Removed legacy auto-run from `start.ts`
- Replaced boiler (github fork) with `@pryv/boiler@^1.2.6` from npm
- Renamed from bridge-hds to lib-bridge-js

## [0.3.0] - 2026-02-13

### Changed
- Migrated to TypeScript with ESM
- Fixed TypeScript migration issues
- Aligned linting configuration
- Added backloop.dev support

## [0.2.0] - 2025-12-11

### Changed
- Updated HDSLib dependency
- Updated to new `getModel` syntax
- Removed superagent, using HDSService directly

## [0.1.0] - 2025-08-02

### Added
- Account connection access for plugins
- Conversion system for data transformation

### Changed
- Removed direct pryv package, relying on embedded pryv in hds-lib

## [0.0.2] - 2025-06-03

### Added
- Plugin version tracking
- `userApiEndpoints` accessor
- Status warning support
- User existence check during onboarding

## [0.0.1] - 2025-03-25

### Added
- Initial release
- Generic partner bridge framework for HDS
- Plugin-based architecture with OO design
- User onboarding flow with partner authentication
- Webhook support for real-time data sync
- Stream structure and permission configuration
- Bridge access creation and management
- Data sample routes for testing
- Test suite with local server capture
- Comprehensive documentation with flow diagrams
