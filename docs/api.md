# HTTP API

The API accepts structured inputs, not uploaded scripts. An administrator installs trusted modules on disk; clients choose one by ID. Every `/api/` route except login requires authentication.

Use `Authorization: Bearer <WORKBENCH_TOKEN>` from a trusted backend or CLI. Browser clients should POST `{ "token": "…" }` to `/api/login` and use the returned HttpOnly cookie. Do not put the token in a URL.

## Submit a run

```js
const response = await fetch('http://127.0.0.1:3180/api/runs', {
  method: 'POST',
  headers: {
    Authorization: `Bearer ${process.env.WORKBENCH_TOKEN}`,
    'Content-Type': 'application/json',
  },
  body: JSON.stringify({
    automationId: 'demo',
    inputs: { url: 'http://127.0.0.1:3180/demo', message: 'Hello' },
    preset: 'natural-fast',
  }),
});
if (!response.ok) throw new Error(`Submission failed: ${response.status}`);
const run = await response.json();
```

Inputs are checked against the module's JSON Schema. They remain in memory until the run ends and are passed to its worker over local IPC. The workbench does not save them in run records. Scripts still control what gets entered into websites and stored by the browser. Avoid logging secrets yourself. `preset` accepts a named preset or the bounded custom timing object described in the automation guide.

POST submissions are **not idempotent**: each accepted request creates a new run. Record the returned ID; do not automatically repeat an uncertain submission.

## Routes

| Method and path | Result |
| --- | --- |
| `GET /healthz` | Process liveness; public, no Engine/account details |
| `POST /api/login` | `{token}` → owner session cookie |
| `POST /api/logout` | Revoke that session |
| `GET /api/session` | Authenticated session check |
| `GET /api/status` | Engine readiness and run counts |
| `GET /api/automations` | IDs, titles, descriptions and input schemas |
| `POST /api/runs` | `{automationId, inputs, preset?}` → run, HTTP 202 |
| `GET /api/runs` | Runs in reverse creation order |
| `GET /api/runs/:id` | One run record |
| `POST /api/runs/:id/pause` | Request pause at the next checkpoint |
| `POST /api/runs/:id/resume` | Continue a paused run |
| `POST /api/runs/:id/cancel` | Terminate script, stop browser, retain profile |
| `POST /api/runs/:id/finish` | Finish a script that called `waitForFinish()` |
| `POST /api/runs/:id/input` | `{challengeId, values}` → answer current challenge |
| `POST /api/runs/:id/retry-export` | Retry a failed/interrupted export |
| `GET /api/runs/:id/artifact` | Download a verified `.kameleo` archive |
| `GET /api/runs/:id/screenshot` | Current page JPEG, while active |
| `GET /api/runs/:id/view` | Live-view availability and connection settings |
| `WS /api/runs/:id/view/socket` | Authenticated private VNC relay |
| `GET /api/proxies` | Inventory metadata, without credentials |
| `POST /api/proxies/:id/check` | Bounded health check of an unleased inventory item |
| `GET /api/events` | SSE `run` events containing changed run records |

Errors use `{ "error": "…" }`. Request bodies are limited to 256 KiB. Login attempts are limited per remote address. General upstream errors are intentionally sanitized.

## Run states

Normal completion is `queued → starting → running → saving → saved`. Scripts can enter `awaiting_input` or `paused`. Other outcomes are `cancelled`, `failed`, `interrupted`, and `export_failed`. Inspect `error`, `logs`, `timings`, `profileId` and `artifact` for context. No `saved` state is emitted until the nonempty archive is read, hashed and renamed into place.

Follow-up input is represented by `challenge: {id, title, fields}`. `fields` is JSON Schema. Submit its answer using the current challenge ID. The ID prevents a delayed reply being applied to a later prompt. The schema may mark a field `writeOnly: true` to show a password control.

`pauseRequested: true` means the script has been asked to stop at a checkpoint. Only `state: "paused"` acknowledges it. `waitingForFinish: true` exposes the operator completion action. The run timeout continues during both kinds of wait. A terminal record with `cleanupRequired: true` retains capacity until shutdown can be confirmed. Retry export can recover a known profile once outstanding Engine calls settle; it does not rerun the automation. An unknown profile ID requires inspecting the Engine and restarting for reconciliation.

## Events and app integration

The browser uses `EventSource('/api/events')` with its cookie. Listen for named `run` events. Events are notifications, not a durable event log: after reconnecting, fetch `/api/runs` to reconcile current state.

An external app can submit inputs, poll its run ID, render a challenge and download the resulting archive. The game renderer is outside this repository. For live viewing, use the provided workbench on the same trusted origin or build an authenticated session broker. Profile archives, screenshots and display credentials are sensitive owner-only data.
