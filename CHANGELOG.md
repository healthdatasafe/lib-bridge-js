# Changelog

## [Unreleased]

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
