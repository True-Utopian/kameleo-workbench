# Validation record

Tested on 1 October 2026. This records observed behavior, not a promise about every site, proxy vendor or host.

## Environments

| Environment | Checks | Result |
| --- | --- | --- |
| Windows, Node 24.14.0 | TypeScript, 40 automated tests, production build | Passed |
| Ubuntu 24.04 amd64 host, Node 24.21.0 in Docker | Clean dependency installation, TypeScript, same 40 tests, production build | Passed |
| Official Kameleo Linux container, Engine 5.3.1 | Create, headed start, Puppeteer attachment, form input, stop, export, restore | Passed |
| npm dependency audit | Production dependencies | No known vulnerabilities reported at test time |

Kameleo's published npm SDK was 5.2.0 when tested. The pinned Engine image is 5.3.1; the specific API calls used here were exercised against that combination. Do not assume that every API field added in a later Engine is exposed by this SDK.

## Browser lifecycle and recovery

The controlled `/demo` form was completed through a real headed Chroma browser. The workbench disconnected, stopped it, exported a nonempty `.kameleo` file and verified its byte count and SHA-256. One saved profile was imported into a **separate Engine workspace** and reopened; both local storage and a persistent cookie survived.

The first deployment test exposed a shared-volume ownership error. The run entered `export_failed` and retained the original profile. After correcting the volume owner to the image's actual runtime UID 1001, Retry export saved the same profile without repeating the form action. An SDK regression test covers the exact `profile_not_running` stop response used in that recovery.

Offline tests also cover queue limits, cancellation, explicit completion, pause acknowledgement, input validation, timeouts, late Engine results, restart cleanup, retained proxy leases and late secret-bearing logs. Unconfirmed cleanup holds capacity. An unresolved Engine creation with no discoverable profile ID requires operator inspection.

## Live display and input

The authenticated dashboard was checked against the live Linux deployment. Browser snapshots and the noVNC connection rendered the actual headed browser. A six-digit test-input challenge was submitted through the web form; the automation continued and saved its profile. The viewer disconnected when the run finished.

The separate UI smoke test also passed: login, Engine readiness, SSE connection, discovery of all three bundled scripts, schema fields, and no horizontal page overflow at 390 px. Desktop and mobile screenshots were reviewed. Its temporary browser profile was removed after the test.

## Proxy path

`scripts/proxy-smoke.mjs` ran a temporary authenticated HTTP CONNECT relay on the private container network. It allowed only the test form, HTTPS IP probe and two observed Kameleo startup IP-check hosts. A real headed browser and the allocator reported the same exit IP. The relay observed the browser's nonce-tagged form request, four HTTP requests and four CONNECT requests. The resulting profile archive was verified; temporary relay credentials were cleared from the stopped test profile before export.

This proves the framework's authenticated HTTP proxy path and probe-to-browser mapping. It does **not** validate an IPRoyal account, residential classification, ISP targeting, paid proxy inventory, live SOCKS5 service, or NSocks service quality. No paid proxy credentials were supplied and no traffic or proxy service was purchased. IPRoyal credential construction and inventory policies have automated tests; NSocks support is imported endpoints only.

Kameleo itself performs startup checks through a configured proxy. The controlled test needed `tools.kameleo.io:443` and `tools-bckp4.kameleo.io:443`; an over-restrictive proxy can therefore pass the workbench's probe and still prevent Engine startup. Consult [Kameleo's network requirements](https://help.kameleo.io/article/65-kameleo-in-restricted-network-environments) for your deployment.

## Observed timing

One cached-kernel run created its profile in about **0.6 s**, had its browser ready in **3.2 s**, and finished form entry plus verified export in **4.9 s** using `natural-fast`. The controlled proxy smoke run took about **4.0 s**. These are individual observations on this server, not benchmark percentiles or service guarantees. First startup/kernel installation and provider allocation can take much longer.

## Reproduce

With a running, idle workbench and Engine:

```sh
npm run check
npm run smoke
```

In Compose, use the container's network and shared paths:

```sh
docker compose exec workbench node scripts/smoke.mjs
docker compose exec workbench node scripts/proxy-smoke.mjs
```

For archive restoration, give the smoke script `IMPORT_KAMELEO_URL` pointing to another Engine with a separate `/data` volume, access to the same export mount and access to the demo URL. The smoke script retains profiles for inspection. Kameleo preserves profile IDs in archives and rejects importing beside the original profile.

For UI checks, run `scripts/ui-smoke.mjs` with `UI_WORKBENCH_URL` and optionally `IMPORT_KAMELEO_URL` and `UI_SCREENSHOT_DIR`. It creates and removes its own temporary browser profile and writes private screenshots; keep those outside the public source tree.

Native Windows Kameleo browser execution, external login providers, game renderers, team isolation and distributed workers have not been validated. The Windows test result above covers the Node framework and filesystem behavior. CI is configured for Ubuntu and Windows; hosted CI results are separate from these local/server checks.
