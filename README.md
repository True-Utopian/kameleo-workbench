# Kameleo Workbench

Run headed Kameleo browsers from a web form or HTTP client. The workbench validates inputs, allocates a profile and optional proxy, runs the automation, and saves a verified `.kameleo` archive. Authenticated snapshots show active work; noVNC control is available during an acknowledged pause or input/completion wait.

Choose one runtime per deployment. **Script mode** loads trusted JavaScript modules and exposes Puppeteer directly. **Managed mode** loads declarative JSON flow packs and uses PostgreSQL for flow checkpoints, identity/profile ownership, fenced leases and archive metadata. Set `DATABASE_URL` to enable managed mode; leave it unset for scripts.

```text
Web form / HTTP client
        │ validated inputs
        ▼
Script or JSON flow → profile settings + proxy policy
        │
        ▼
Headed Kameleo browser ← live display / follow-up inputs
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
- Per-input profile and proxy hooks; local, persistent Kameleo profiles.
- Imported HTTP/SOCKS5 proxies, IPRoyal sticky residential credentials, and a custom provider interface.
- Proxy constraints for type, location, ISP/ASN, expiry, latency, freshness and independent verification. Observed exit IPs are reserved across managed nodes sharing a quota; script mode reserves them within one process.
- Authenticated noVNC viewing for a private Linux Kameleo display; screenshots and the native Kameleo window on Windows.
- PostgreSQL coordination for managed flows, plus local metadata for script runs. Both retain original profiles after failures and verify archive checksums.

The HTTP interface has one administrator token. Managed coordination scopes records by tenant and node, but it does not add user accounts or per-user permissions to the dashboard. Each shared VNC desktop remains an administrator trust boundary. Install only trusted scripts, packs and resolver policies.

## Start locally

Use Node.js 24 or newer and a running Kameleo Engine. A Kameleo account with the necessary automation entitlement is required for real browser runs.

```sh
npm ci
npm run build
npm start
```

In another terminal:

```sh
npm run token --silent
```

Open **http://127.0.0.1:3180**, enter that access token, and choose **Fill and verify a form**. Use `http://127.0.0.1:3180/demo` as the fixture URL. The demo sends nothing to an outside service.

Copy `.env.example` to `.env` to change settings. The same Node commands work in PowerShell and Linux shells. Native Windows needs Kameleo Desktop/Engine installed separately; the Linux route uses Kameleo's official Docker image.

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
```

CI runs the offline checks on Windows and Ubuntu. Real Kameleo tests are opt-in because they need your Engine, account and local profile storage. See the validation record before treating any provider or platform as tested.

The project uses Kameleo's [Local API](https://developer.kameleo.io/) and [Puppeteer](https://pptr.dev/). It is independent of Kameleo and proxy providers.
