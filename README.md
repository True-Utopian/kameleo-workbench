# Kameleo Workbench

A small control plane for your own headed browser automations. Give a script structured inputs, create a Kameleo profile, attach Puppeteer, inspect the browser, and save a verified `.kameleo` archive when the script finishes.

The script is the unit of extension. Write ordinary JavaScript with the full Puppeteer API; use the workbench for lifecycle, input forms, proxy allocation, live viewing and exports.

```text
Web form / HTTP client
        │ validated inputs
        ▼
Automation module → profile settings + proxy policy
        │
        ▼
Headed Kameleo browser ← live display / follow-up inputs
        │ script calls done()
        ▼
Disconnect → stop → export → verify file → SHA-256 → saved
```

## What is included

- An authenticated web workbench and HTTP API, with a queue and per-run events.
- Puppeteer scripts with JSON Schema inputs, follow-up input challenges, cooperative pause, cancellation and a worker deadline.
- `fast`, `natural-fast` and `natural` pacing, plus custom timings. Raw Puppeteer is always available.
- Per-input profile and proxy hooks; local, persistent Kameleo profiles.
- Imported HTTP/SOCKS5 proxies, IPRoyal sticky residential credentials, and a custom provider interface.
- Proxy constraints for type, location, ISP/ASN, expiry, latency, freshness and independent verification. Active runs cannot lease the same observed exit IP in this process.
- Authenticated noVNC viewing for a private Linux Kameleo display; screenshots and the native Kameleo window on Windows.
- Atomic run metadata, retained profiles after errors, retryable exports, and archive checksums.

This is a single-owner workbench. It does not include team accounts, distributed scheduling, a marketplace of site logins, CAPTCHA solving, or a guarantee that sites will accept automation. An authenticated operator can control browsers and download their sessions. Install only scripts you trust.

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

Copy `.env.example` to `.env`, set `KAMELEO_PAT` and a random `VNC_PASSWORD`, then run:

```sh
docker compose up -d --build
docker compose exec workbench node dist/cli.js token
```

Open **http://127.0.0.1:3180**. In the demo use `http://workbench:3180/demo`, since the browser runs in a different container. The included Compose stack keeps the Engine API and VNC private and publishes only the workbench on loopback. It pins the tested images by digest and uses persistent volumes for kernels, profiles, state and exports.

On a remote server, forward the workbench port:

```sh
ssh -L 3180:127.0.0.1:3180 your-server
```

See [deployment](docs/deployment.md) for shared export paths, proxy credentials, TLS and recovery.

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

Pacing changes typing and pointer timing; it does not make automation indistinguishable from a person. Cold browser/kernel downloads can take minutes. Reusing the kernel cache reduces startup time, but proxy availability and account quotas still apply.

## Documentation

| Topic | Reference |
| --- | --- |
| Scripts, profile hooks, pacing, challenges | [Automation guide](docs/automations.md) |
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
