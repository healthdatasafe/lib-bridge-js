# Agent primer — lib-bridge-js

This file orients agents (Claude or others) working on `lib-bridge-js`. It deliberately **does not duplicate** information that already lives in this repo — it links you to the right document for each concern. Read this first, then the linked sources as you start a task.

---

## Read first

Before touching code, read these in order:

1. **[README.md](README.md)** — what the package is, public API surface, and the typical bridge-author flow.
2. **[INSTALL.md](INSTALL.md)** — server-side install steps for a partner deployment (nginx, certbot, managing-user creation).
3. **[CHANGELOG.md](CHANGELOG.md)** — every behaviour change in reverse chronological order. Read recent entries before estimating an API.
4. **[doc/onboarding-flow-detail.md](doc/onboarding-flow-detail.md)** — sequence diagram and step-by-step description of the partner→bridge→HDS onboarding handshake. Essential before changing any onboarding code.
5. **[`src/index.ts`](src/index.ts)** — the canonical list of public exports. Anything a bridge consumes goes through here.
6. **[`src/server.ts`](src/server.ts)**, **[`src/start.ts`](src/start.ts)** — the Express app factory and the cluster entry point.
7. **[`src/initBoiler.ts`](src/initBoiler.ts)** — config initialization. The order of `initBoiler` vs everything else is the most common source of bridge bugs (see "Gotchas").

---

## Mental model

A **bridge** is a server that mediates between a third-party partner platform and an [HDS](https://github.com/healthdatasafe) ecosystem account. Each user gets a long-lived "bridge account" on HDS; the bridge holds the partner credentials and pushes data into the user's HDS streams.

```
Partner platform ──HTTPS──▶ bridge (this lib + plugin) ──HTTPS──▶ HDS (Pryv) account
                                       │
                                       └──▶ persistent bridge state (boiler config, user store)
```

This library provides the **shared scaffolding**:

- HTTP server (Express + cluster + CORS + error handling).
- Partner-auth middleware (`partnerAuthToken` header check).
- The user onboarding flow (initiate → HDS auth → finalize → optional partner webhook).
- A `PluginBridge` base class that each partner-specific bridge extends.
- Test utilities (`testServer`) for consumer-side integration tests.

A bridge consumer:

1. `extends PluginBridge` with partner-specific logic (`key`, `potentialCreatedItemKeys`, `init`, `newUserAssociated`).
2. Calls `startCluster(MyBridge, configDir)` (or `createBridgeApp` for tests).
3. Ships its own `localConfig.yml` describing partner endpoints, secrets, and HDS-side connection.

The README's "Creating a bridge" section is the canonical worked example — keep it as the source of truth for the consumer flow; this file points you at the **internal** invariants that make it work.

---

## Conventions enforced in this repo

### TypeScript build pipeline (Node 24)

This repo ships **compiled** JS to consumers because Node 24 forbids TS type-stripping inside `node_modules/` (`ERR_UNSUPPORTED_NODE_MODULES_TYPE_STRIPPING`):

- [`tsconfig.build.json`](tsconfig.build.json) sets `rewriteRelativeImportExtensions: true` so `.ts` imports compile to `.js` correctly.
- `npm run build` → `tsc -p tsconfig.build.json` → emits `dist/`.
- `npm run prepare` runs `npm run build` automatically — **every git-dep install rebuilds**.
- Consumers import from the published `exports`:
  - `"."` → `./dist/src/index.js`
  - `"./test"` → `./dist/tests/helpers/testServer.js`

When you change `src/`, run `npm run build` and verify `dist/` is updated before committing. **Do not import from `dist/` inside `src/`.**

### Critical init order

`initBoiler(name, configDir)` **must run before** anything that reads config — including `new PluginBridge(...)`. The constructor calls `getLogger()` which auto-initialises boiler with the *wrong* config dir if boiler isn't initialised yet, leaving you with a half-loaded bridge that fails in subtle ways.

The bootstrap shape every bridge follows:

```ts
import { initBoiler, startCluster } from 'lib-bridge-js';
initBoiler('my-bridge', __dirname);   // FIRST
await import('./postBoot.js');         // Then everything else
```

If you see "config key not found" for a key that exists in `localConfig.yml`, check the init order before suspecting the config.

### `__` (double underscore) → `:` env var convention

Boiler / nconf maps env-var `__` to config-path `:`. So `MY_BRIDGE__partnerAuth__token=foo` sets `myBridge:partnerAuth:token`. Deep merging happens at the **leaf** level, not the object level. Useful for Dokku / docker overrides.

### Public surface

Everything a bridge consumer can touch is re-exported by [`src/index.ts`](src/index.ts). If a consumer needs something deeper, **add the export** — don't let bridges import from `dist/src/lib/...` paths that we may rename.

The current public exports (full list in `src/index.ts`):

- `PluginBridge` — base class.
- `startCluster`, `createBridgeApp` — entry points.
- `initBoiler` — config init.
- `errors`, `Router` — utilities.
- `initHDSModel`, `getHDSModel` — re-exported from [hds-lib-js](https://github.com/healthdatasafe/hds-lib-js).
- `testServer` — test helpers (under the `"./test"` export).

### Tests

- [`tests/`](tests/) — mocha + node `assert`. Tests run via `npm test` against a real test server (no mocks for bridge boundary code).
- New tests go next to similar existing ones. New behaviour without a test is not done.
- Many tests need a configured `localConfig.yml` — never commit local secrets; use the example config and document required keys in the README.

### Logging

Use the boiler-provided logger (via `getLogger`), not `console.log`. The logger respects log-level config and writes to the configured destination (file in prod, stdout in dev).

### Versioning

- Bump `version` in `package.json` for **every** observable change (any change a downstream bridge could see).
- Add a `## [x.y.z] - YYYY-MM-DD` block under `[Unreleased]` in [CHANGELOG.md](CHANGELOG.md). One bullet = one observable change.
- Consumers pin to git URLs, but the version + changelog is how humans read the diff.

---

## Onboarding flow — quick recap

The handshake spans 3 actors: **partner** (their server), **bridge** (this code + plugin), and **HDS** (Pryv account). The full sequence is in [doc/onboarding-flow-detail.md](doc/onboarding-flow-detail.md). Headline beats:

1. **Partner → bridge** `POST /onboarding/initiate` with `partnerUserId` + `partnerAuthToken`. Bridge issues a one-time HDS auth request and returns a redirect URL.
2. **User → HDS** authenticates in their browser, grants the bridge access, returns to the bridge's redirect URL with a Pryv API endpoint.
3. **Bridge → partner** webhook (configured per-partner) confirming the new association.
4. **Bridge** stores `{partnerUserId → bridgeAccount}` and starts whatever periodic sync the plugin defines.

Anything that diverges from this flow needs a strong reason and an updated diagram.

---

## Gotchas

- **`initBoiler` order**: see "Critical init order" above. This is the #1 source of "works on my machine but not in prod" bugs.
- **Stale `dist/`**: if you edit `src/`, push, and the consumer still reports old behaviour after `npm install`, your `dist/` is stale. Run `npm run build`, verify the file in `dist/`, recommit.
- **`tsconfig.build.json` vs `tsconfig.json`**: the dev `tsconfig.json` has `noEmit: true`. Only `tsconfig.build.json` emits — always run `tsc -p tsconfig.build.json` (or `npm run build`) to regenerate `dist/`.
- **Cluster vs single-process**: `startCluster` forks workers; in dev you usually want `createBridgeApp` directly so breakpoints work.
- **Partner auth header**: `partnerAuthToken` is checked by middleware on every partner-facing route. Do NOT bypass it for "convenience" endpoints.
- **HDS access scoping**: a bridge access on a user account has a finite stream scope. Pushing to a stream outside the granted scope errors with `forbidden` from Pryv. When adding new item types, declare them up-front in `potentialCreatedItemKeys` so the access request includes them.

---

## Cross-repo relationships

- **[hds-lib-js](https://github.com/healthdatasafe/hds-lib-js)** — the runtime data-model + Pryv-extensions library. `lib-bridge-js` re-exports `initHDSModel` / `getHDSModel`. When `hds-lib-js` ships a breaking API change, this repo's `dist/` needs a rebuild + version bump.
- **[data-model](https://github.com/healthdatasafe/data-model)** — the YAML source for HDS items / streams / event types. A bridge maps partner observations to the **canonical** items declared here (e.g. partner appetite → `nutrition-appetite`, partner cervical-fluid → `body-vulva-mucus-inspect`). **Never** create source-prefixed items; see the data-model [`AGENTS.md`](https://github.com/healthdatasafe/data-model/blob/main/AGENTS.md) for the rule.

---

## Pryv concepts you'll encounter

A bridge runs against a real HDS (Pryv) account. The Pryv concepts you must hold in your head are documented in [hds-lib-js's `AGENTS.md`](https://github.com/healthdatasafe/hds-lib-js/blob/main/AGENTS.md) — read its "Pryv concepts" table once. The ones bridges hit constantly:

- **Service info** — discovery endpoint of the platform the bridge writes into.
- **Accesses & permissions** — bridges typically hold an `app` access scoped to the streams they create.
- **Events / event types / streams** — what the bridge writes; shapes are defined in `data-model`.
- **Integrity** — per-event hash; do not strip or recompute manually.

Authoritative Pryv reference: <https://pryv.github.io/reference/>. Conceptual primer: <https://pryv.github.io/data-in-pryv/>.

---

## When in doubt

- For the data shape of an event you're producing: read the item YAML in [data-model](https://github.com/healthdatasafe/data-model).
- For the Pryv method to call (`events.create`, `events.update`, …): read the [Pryv API reference](https://pryv.github.io/reference/#methods).
- For the right place to add new shared scaffolding: re-read [`src/index.ts`](src/index.ts) and the section above titled "Public surface". If the right place doesn't exist yet, propose it in the PR description.

If the answer to a question is not in any of these places, that is a documentation bug — extend this file or `README.md` before fixing the code.
