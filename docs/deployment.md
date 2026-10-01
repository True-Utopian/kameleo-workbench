# Deployment

## Native Windows

Install Node.js 24+ and Kameleo Desktop, start its Engine, then run `npm ci`, `npm run build`, and `npm start`. The default Engine address is `http://127.0.0.1:5050`. The default workbench address is `http://127.0.0.1:3180`.

Set environment variables in `.env` or PowerShell. `npm start`, `npm run token --silent` and `npm run doctor` load `.env`; direct `node` commands only load it if passed `--env-file-if-exists=.env`. With the default generated access token, `node dist/cli.js token` also prints the saved token from `.workbench/admin-token`.

Native Kameleo shows its own browser windows. The workbench screenshot button works without VNC. A live embedded display requires a separately configured VNC WebSocket endpoint; the included Docker deployment provides it. Docker Desktop in Linux-container mode is also supported by the Compose configuration.

## Linux / Docker

The official Kameleo Linux image is amd64. The supplied Compose file runs the Engine with 2 GiB of shared memory. Keep the `kameleo-data` volume: it stores profiles and downloaded kernels. The initial download takes longer than a cached start.

Set these values in an untracked `.env`:

```dotenv
KAMELEO_PAT=your-personal-access-token
VNC_PASSWORD=your-random-display-password
```

Generate a long random access token in `WORKBENCH_TOKEN`, or leave it blank and use the generated one. The VNC password travels only between the authenticated owner and private display; classic VNC authentication uses at most eight characters. The workbench's long access token is the external access control.

Run `docker compose up -d --build`. The Engine has no host port mappings. The workbench is available on `127.0.0.1:3180`. On a remote host, use an SSH tunnel or an authenticated HTTPS reverse proxy.

The pinned image currently runs as UID 1001 (checked from the image, rather than relying on a documentation example). Both containers share an export volume owned by that UID. If you change the image, inspect its runtime UID and update the workbench user/volume initialization together.

## Export paths

Export is a filesystem operation **on the Engine host**, not a download response from Kameleo. `KAMELEO_EXPORT_DIR` names a directory that the Engine can write. `EXPORT_DIR` names the same files as seen by the workbench. The directories must be the same directory or a shared mount.

| Setup | Engine path | Workbench path |
| --- | --- | --- |
| Native on one Windows machine | `C:\work\profiles` | `C:\work\profiles` |
| Native on one Linux machine | `/srv/workbench/profiles` | `/srv/workbench/profiles` |
| Included Compose | `/exports` | `/exports` |
| Separate hosts | An explicitly shared mount | Its local mount point |

If that mapping is wrong, export is marked `export_failed`; the original profile remains. Correct the mapping and retry the export. Never remove the original until its archive is verified and backed up.

Download saved profiles through the workbench, or copy the container directory:

```sh
docker compose cp workbench:/exports ./profile-backup
```

Archives contain browser sessions, cookies and site data. Protect backups accordingly. A checksum establishes file integrity; an import test establishes whether the archive restores in your Engine version.

## Configuration

| Variable | Default | Purpose |
| --- | --- | --- |
| `HOST`, `PORT` | `127.0.0.1`, `3180` | HTTP listener |
| `WORKBENCH_TOKEN` | Generated and persisted | Owner access / API bearer token |
| `WORKBENCH_DATA_DIR` | `.workbench` | Private token and run records |
| `KAMELEO_URL` | `http://127.0.0.1:5050` | Private Local API |
| `EXPORT_DIR` | `profiles` | Locally readable export directory |
| `KAMELEO_EXPORT_DIR` | Same as `EXPORT_DIR` | Engine-side export directory |
| `AUTOMATIONS_DIR` | `automations` | Trusted local JS modules |
| `PROXY_INVENTORY_FILE` | `proxy-inventory.json` | Private imported proxy inventory |
| `MAX_CONCURRENCY` | `1` | Concurrent browser runs |
| `RUN_TIMEOUT_MS` | `600000` | Maximum running time, including manual waits |
| `KAMELEO_VNC_URL` | Unset | Private `ws://…/websockify` endpoint |
| `VNC_PASSWORD` | Unset | Credentials for that display |
| `PUBLIC_ORIGIN` | Derived from request | Exact workbench origin, e.g. `https://browser.example.com` |
| `COOKIE_SECURE` | True for HTTPS origin | Restrict cookie to HTTPS |
| `EMBED_ORIGINS` | Empty | Comma-separated allowed iframe parent origins |
| `WORKBENCH_URL` | `http://127.0.0.1:3180` | Destination of CLI `run` submissions |

Proxy provider environment variables are in [the proxy guide](proxies.md). To supply a private inventory in Compose, add a read-only mount at `/app/proxy-inventory.json`. Add provider secrets through a private Compose override or secret manager; never put them into a committed automation.

## Live display and concurrency

The Linux container has one shared desktop. Live viewing therefore requires `MAX_CONCURRENCY=1`. A queued run gets the display after the previous run has stopped. Viewer connections are closed when their run ends. Do not start unrelated profiles manually in that same Engine: they would share its desktop.

For parallel viewing, run separate workbench/Engine pairs with separate data volumes and ports. An in-process proxy lease cannot guarantee uniqueness across those instances; use a shared allocator if that is required. This version deliberately has no distributed lease database or team permissions.

Pause is cooperative. Action helpers check the pause flag before acting. When using raw Puppeteer, insert `await checkpoint()` at safe boundaries. Wait for the run to say **paused** before manual input. A pending pause is not proof that the browser has stopped executing commands.

## HTTPS and embedding

For public access, put a reverse proxy with TLS in front of the loopback listener, set `PUBLIC_ORIGIN` to the exact external origin, and forward WebSocket upgrades and SSE without buffering. Do not publish Kameleo's Local API or VNC ports. The owner token has full authority over all runs; this is not a multi-tenant service.

Browser sessions use an HttpOnly, SameSite=Strict cookie and expire after 12 hours. API calls can use a bearer token. Cross-origin browser requests are rejected. `EMBED_ORIGINS` permits iframe framing only; it does not add CORS or relax cookies. A cross-site game/web app should call this API from its own trusted backend. Never ship the owner token inside a game client or public webpage.

## Shutdown and recovery

SIGINT/SIGTERM stops active workers and their profiles. After an abrupt restart, nonterminal run records become `interrupted`; inputs are intentionally not persisted or replayed. Inspect the original profile before retrying an export. The workbench never automatically reruns a form submission or login after a crash.

Restart after changing automation modules. Back up the state and profile volumes together. Rotate the workbench token by changing `WORKBENCH_TOKEN` and restarting; existing sessions then become invalid. Kameleo PAT changes require restarting the Engine.

The upstream [Docker guide](https://developer.kameleo.io/integrations/docker/) and [configuration reference](https://developer.kameleo.io/reference/configuration-options/) describe Engine-specific settings. Dependency and image pins should be upgraded deliberately, then checked with a complete create → run → stop → export → import cycle.
