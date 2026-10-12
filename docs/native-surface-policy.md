# Native WebGL, audio and font policy

Vesper Browser 0.4.6 and Workbench 0.5.8 expose three optional native privacy controls. They require a qualified Vesper kernel; stock Chromium and Brave cannot satisfy these controls. Existing profiles keep their previous defaults.

| Control | Implemented scope | Remaining work |
| --- | --- | --- |
| Restricted GPU details | Disable `WEBGL_debug_renderer_info` in WebGL 1 and 2, including extension discovery and unsupported-enum behavior. | Pixel and shader identity, limits, WebGPU and internally coherent hardware personas. |
| Seeded offline audio | Project the three lowest sample mantissa bits using a persisted profile seed, channel and absolute frame. Apply once before offline completion delivery; retain shared buffer and copy semantics. | Realtime audio, device enumeration and broader DSP surfaces. |
| Restricted local fonts | Deny Local Font Access before permission prompts, hide local unique face discovery and restrict named font families to an essential allowlist. | System fallback, Unicode coverage and a distributable coherent font pack. |

## Passing checks

- Full source suite: 178 passing tests (38 Browser, 140 Workbench/root), zero failures and one optional external PostgreSQL test skipped.
- Standalone native C++ policy: 4,141 assertions pass. These cover sample stability, independent seeds/channels, chunk offsets, special floats, bounded changes and font-family parsing; they are not 4,141 browser features.
- Four modified Chromium translation units compile in isolation with the pinned native toolchain: WebGL extension discovery, offline audio completion, font cache and Local Font Access.
- Browser API tests check policy validation, persisted identity, restart/archive behavior and rejection without the required native receipt. Workbench's Inspect schema and profile mapping forward the same settings.
- The expanded first-script fixture runs on the bundled stock browser across eight contexts. Native admission correctly rejects that stock browser. This proves fixture execution, not native masking.
- Browser 0.4.6 and the signed Workbench 0.5.8 add-on passed 22 packaged Windows checks: six desktop/control checks, nine extended API checks and seven saved-proxy checks. This includes saving the three native settings and refusing an unqualified kernel. The production dependency audit recorded zero vulnerabilities.

## Pending release checks

The full native browser is still compiling. The surface patch is queued behind the active build, together with the canvas export-scope correction. Neither isolated compilation nor source tests qualify a native binary.

Native acceptance requires unit tests, direct runtime checks, copied-runtime checks and installed Browser–Workbench integration. The runtime checks compare WebGL discovery/error behavior, offline sample reads/copies/events/restarts and independent seeds, and font metrics/local discovery against an upstream baseline. Each receipt must name the specific passing surface policies before those settings can launch.

The actual installed upgrade and its controls remain pending until their own qualification reports pass. The release audit now requires all nine native fixture cases and the three surface capabilities in direct and copied receipts, plus those capabilities in installed integration; an older scalar/canvas receipt cannot complete these gates. PowerShell UTF-8 receipts with a byte-order mark are accepted without ignoring their recorded state. Linux package structure does not prove execution on Linux. No complete vendor masking parity or detection-avoidance claim is made.
