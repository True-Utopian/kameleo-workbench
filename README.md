# Vesper Workbench

<p align="center"><img src="public/vesper-icon.png" width="100" alt="Vesper moth emblem"></p>

[**Vesper Browser**](https://github.com/True-Utopian/vesper-antidetect-browser) keeps independent browser profiles on your PC. **Vesper Workbench** adds repeatable automation, visual flows, schedules and verified profile archives. Install Workbench as an optional plug-in inside Browser, or use its standalone app. Both are original open-source projects by **true-utopian**.

[Get started](#start-locally) · [Desktop setup](docs/desktop.md) · [API reference](docs/api.md) · [Workbench plug-in](docs/workbench-addon.md)

## Status

[![browser](docs/assets/badge-browser.svg)](docs/status.md) [![workbench](docs/assets/badge-workbench.svg)](docs/status.md)

[![Vesper progress map](docs/assets/status.svg)](docs/status.md)

<sub>* Percentages count desktop-verified checks in the [documented inventory](docs/status.md), which grows as requirements become known. Green means accepted; grey means acceptance is pending. Grid squares visualize these proportions, not extra checks. Source-tested, active and planned work are distinguished in the linked checklist. These are not percentages of vendor parity, engineering effort or detection resistance.</sub>

The installed Windows Browser 0.4.7 / Workbench 0.5.10 pair runs real Chromium and shares one Browser-owned profile store through an authenticated API. The extension catalog, portable extension profiles, timezone-aware calendar schedules and native-kernel host integration are implemented. The original Windows kernel passed 26 native unit executions, nine direct and nine copied-runtime cases, installed Browser–Workbench integration and persisted identity checks. Broader WebGL/WebGPU, realtime audio, coherent font packs, media-device modeling, coherent personas, Firefox/mobile engines and native Linux qualification remain unfinished. [Native qualification and its limits](docs/native-kernel-qualification.md).

Automatic native-process-loss cleanup and normal Finish saving passed in the installed 0.5.10 add-on. [Recovery scope and recent-write limitation](docs/native-process-recovery.md).

See the [completion checklist](docs/research/completion-gates.md), [research ledger](docs/research/feature-ledger.md) and [measured validation](docs/validation.md). Windows installers, offline signed updates and a signed Workbench plug-in are built locally. Linux packages are cross-built and require real Linux runtime testing.

End users install compiled browser files. The new local Windows Browser installer with the qualified Vesper runtime is approximately 668 MB; its guarded installed upgrade and native/form checks passed. The large Chromium source checkout is only for developers building the native kernel. [Kernel build and qualification](native/chromium/README.md).

## Two tools, one workspace

Browser provides persistent profiles, HTTP/SOCKS5 proxy credentials, folders, favorites, tags, notes, templates, reversible trash, cookie tools and independent archives. Workbench runs trusted scripts or managed flows, keeps durable run state and saves a checksum-verified profile after completion. Local Chromium is the default and requires no vendor account or subscription; proxies are optional for local fixtures. An optional licensed Kameleo compatibility adapter remains available.

Both projects expose versioned `/api/v1` APIs, OpenAPI descriptions and TypeScript/Python clients. Supported policies and their limits are documented in the [native-engine guide](docs/native-engine.md) and [local-browser guide](docs/local-browser.md). Native Brave protection belongs to upstream Brave. Vesper does not claim proprietary masking internals, detection bypass or complete competitor parity.

The desktop Workbench includes both execution modes. **Script mode** loads trusted JavaScript modules and exposes Puppeteer directly. **Managed mode** loads declarative JSON flow packs and persists checkpoints, identity/profile ownership, fenced leases and archive metadata. Desktop builds use private persistent embedded PGlite; remote PostgreSQL remains optional. CLI deployments retain script-only defaults, with `DATABASE_URL` for managed PostgreSQL or `VESPER_LOCAL_COORDINATOR=true` for the combined local mode.

```text
Web form / HTTP client
        │ validated inputs
        ▼
Script or JSON flow → profile settings + proxy policy
        │
        ▼
Headed Chromium / Kameleo browser ← native window / follow-up inputs
        │ explicit completion
        ▼
Disconnect → stop → export → verify file → SHA-256 → saved
```

## What is included

- An authenticated web workbench and HTTP API, with a queue and per-run events.
- Puppeteer scripts and finite JSON flows with JSON Schema inputs, follow-up challenges, cooperative pause, cancellation and deadlines.
- Main-frame URL/DOM state recognition, explicit refinement, ambiguity handling and fresh evidence before managed browser input.
- Opaque verification choices, exact fill readback, identity receipt checks and durable action intent. An uncertain submission requires reconciliation instead of automatic replay.
- `fast`, `natural-fast` and `natural` pacing, plus custom timings. Raw Puppeteer is always available.
- Per-input profile and proxy hooks; persistent Chromium or Kameleo profiles.
- Local profile controls in the dashboard, including proxy editing and archive upload.
- Imported HTTP/SOCKS5 proxies, IPRoyal sticky residential credentials, and a custom provider interface.
- Proxy constraints for type, location, ISP/ASN, expiry, latency, freshness and independent verification. Observed exit IPs are reserved across managed nodes sharing a quota; script mode reserves them within one process.
- Authenticated noVNC viewing for a private Linux Kameleo display; screenshots and the native Kameleo window on Windows.
- PostgreSQL coordination for managed flows, plus local metadata for script runs. Both retain original profiles after failures and verify archive checksums.

The HTTP interface has one administrator token. Managed coordination scopes records by tenant and node, but it does not add user accounts or per-user permissions to the dashboard. Each shared VNC desktop remains an administrator trust boundary. Install only trusted scripts, packs and resolver policies.

## Start locally

Use Node.js 26 or newer for the Workbench CLI and source build. Desktop installers include their own tested runtime. Install free Chromium once, then start the local workbench:

```sh
npm ci
npm run browser:install
npm start
```

In another terminal:

```sh
npm run token --silent
```

Open **http://127.0.0.1:3180**, enter that access token, and choose **Fill and verify a form**. Use `http://127.0.0.1:3180/demo` as the fixture URL. The demo sends nothing to an outside service.

Copy `.env.example` to `.env` to change settings. Open **Profiles** to create a browser, add your proxy, and choose **Open browser**. The local backend exports `.workbench.tgz` archives; proxies are optional for local fixtures. An existing Chromium executable can replace the download with `LOCAL_BROWSER_EXECUTABLE`.

### Run both Vesper projects together

Vesper Browser has its own profile manager at **http://127.0.0.1:3181**. From the repository root, build both projects and install Chromium into Browser's private store once:

```sh
npm run build
node packages/vesper-browser/dist/cli.js install
npm run browser:serve
```

In a second terminal, start Workbench connected to that Browser service:

```sh
npm run start:connected
```

Use `npm run browser:token --silent` for Browser and `npm run token --silent` for Workbench. Their tokens are separate. The included `vesper.local.env` contains the loopback address and token-file path; it contains no token value. Both interfaces now show the same Browser-owned profiles. Closing Workbench preserves independently opened Browser windows. Stop Browser before using its offline profile commands. `npm start` still selects the embedded local engine unless you configure the service connection in `.env`.

To keep using the licensed backend, set `BROWSER_BACKEND=kameleo` and start Kameleo Desktop/Engine separately. That backend retains `.kameleo` archives and its existing automation entitlement requirement. Docker Compose explicitly selects Kameleo. The same Node commands work in PowerShell and Linux shells; the new local backend has been browser-tested on this Windows PC.

## Start with Docker

Copy `.env.example` to `.env` and set `KAMELEO_PAT`, `VNC_PASSWORD`, `POSTGRES_PASSWORD` and `KAMELEO_TEAM_KEY`. Use the same team key on installations that share a Kameleo quota. The database password must be URL-safe because Compose embeds it in the connection URL. Leave `ENABLE_TEST_FIXTURE=true` for the included synthetic flow, then run:

```sh
docker compose up -d --build
docker compose exec workbench node dist/cli.js token
```

Open **http://127.0.0.1:3180** and choose the owned-site sign-in flow. Use any test username, password `test-password`, and code `123456`. Compose enables managed mode with PostgreSQL and gives the browser fixture origin `http://workbench:3180`. The stack keeps Engine/VNC/database ports private and publishes the workbench on loopback. Persistent volumes hold kernels, profiles, coordinator data, service state and exports.

On a remote server, forward the workbench port:

```sh
ssh -L 3180:127.0.0.1:3180 your-server
```

See [deployment](docs/deployment.md) for managed-mode configuration, shared export paths, TLS and recovery.

## Run a managed flow

Managed mode needs PostgreSQL, a stable node identity, a Kameleo team quota key and installed execution policies. The included owned-site pack exercises username/password entry, a verification-method choice, a code prompt, authenticated identity binding and export. It uses synthetic test credentials on the local fixture.

```dotenv
DATABASE_URL=postgresql://workbench:your-local-password@127.0.0.1:5432/workbench
KAMELEO_TEAM_KEY=your-shared-team-key
KAMELEO_BROWSER_BUDGET=1
FLOWS_DIR=flows
ENABLE_TEST_FIXTURE=true
FIXTURE_ORIGIN=http://127.0.0.1:3180
```

Use the origin reachable by the Kameleo browser; inside Compose that is normally `http://workbench:3180`. Restart the service after configuring it, choose the owned-site flow, and use a test username, password `test-password`, and code `123456`. The fixture is enabled only with `ENABLE_TEST_FIXTURE=true`.

The [flow guide](docs/flows.md) describes pack compilation, the browser adapter, durable checkpoints, recovery and the resolver contract. The [architecture](docs/design/architecture.md) records the broader coordination design and the remaining qualification work. Its capacity figures are sizing examples, not measured throughput.

## Write an automation

Create `automations/my-form.mjs` and restart the service:

```js
import { defineAutomation } from '../dist/index.js';

export default defineAutomation({
  id: 'my-form',
  title: 'Fill my test form',
  inputSchema: {
    type: 'object',
    required: ['message'],
    additionalProperties: false,
    properties: { message: { type: 'string', minLength: 1 } },
  },
  async run({ inputs, actions, page, done }) {
    await actions.goto(process.env.DEMO_URL ?? 'http://127.0.0.1:3180/demo');
    await actions.fill('[data-test="message"]', inputs.message);
    await actions.click('[data-test="save"]');
    await page.waitForSelector('[data-complete="true"]');
    await done();
  },
});
```

`done()` ends the script and requests a verified export. Returning normally is incomplete. Use `waitForFinish()` if a human should inspect the page and click **Finish + save**. A failing script retains its original profile for inspection.

Managed flows use the guarded interaction executor for typing, pointer movement and exact fill readback. Its timing model can be calibrated from consented synthetic-task traces. The bundled defaults have not been fitted to human traces. Cold kernel downloads, proxy availability and account quotas still affect startup.

## Documentation

| Topic | Reference |
| --- | --- |
| Scripts, profile hooks, pacing, challenges | [Automation guide](docs/automations.md) |
| State registries, declarative flows and recovery | [Flow guide](docs/flows.md) |
| Coordination, identity binding and capacity | [Architecture](docs/design/architecture.md) |
| Providers, constraints, health and uniqueness | [Proxy guide](docs/proxies.md) |
| Workbench, inspection and run controls | [Workbench guide](docs/workbench.md) |
| Windows, Linux, Docker and recovery | [Deployment guide](docs/deployment.md) |
| Integrating another app or game | [HTTP API](docs/api.md) |
| What was actually tested | [Validation record](docs/validation.md) |

## Development

```sh
npm run check
npm audit
npm run smoke:pair
```

CI runs the offline checks on Windows and Ubuntu. Real Kameleo tests are opt-in because they need your Engine, account and local profile storage. See the validation record before treating any provider or platform as tested.

The project uses [Puppeteer](https://pptr.dev/), free Chromium, and an optional adapter for Kameleo's [Local API](https://developer.kameleo.io/). It is independent of Kameleo and proxy providers.
