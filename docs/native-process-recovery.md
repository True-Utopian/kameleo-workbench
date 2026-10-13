# Native process interruption

Original Vesper behavior and qualification by **true-utopian**, 13 October 2026.

The actual Browser 0.4.7 / Workbench 0.5.9 installation passed an owned native-process interruption fixture. The test verified the exact executable and physical profile path before interrupting only its new browser process. Browser refused the dead connection; explicit Workbench cancellation confirmed stop and released the profile lease. Reopening that same profile retained committed localStorage, IndexedDB and native CPU/memory settings. Original profile metadata and idle leases were preserved. These five checks qualify explicit recovery of that fixture.

A separate earlier interruption, three seconds after a new localStorage write, lost that write while IndexedDB survived. The native Chromium storage implementation batches localStorage commits with a five-second default delay. The committed-data fixture waited until its unique value appeared in the owned storage file before interruption; the observed wait was 4,984 ms. This does not qualify preservation of arbitrary recent writes, OS power loss or the full crash-recovery matrix. The earlier failed receipt is retained privately.

The installed Inspect worker remained in its operator Finish wait after browser loss until explicitly cancelled. The source correction watches its Browser-owned connection throughout automation, aborts pending input/Finish requests on disconnect, and terminates without claiming a save. It removes the watcher on successful completion so intentional final disconnect does not create a false failure. The native kernel itself is unchanged.

Five lifecycle regressions and the complete source suite passed: **196 tests**, zero failures and one optional external PostgreSQL skip. A separate real compiled source worker reached Inspect through the installed native Browser, then terminated 36 ms after the verified owned native process exited. Four source integration checks passed, including preservation of original profile metadata and idle lease state. These are source checks; the worker correction still requires a new signed Workbench add-on, packaged qualification and guarded actual installation. It is not present in the installed 0.5.9 add-on.

Private evidence: `test-results/recovery/installed-native-interruption.json`, the retained failed recent-write fixture and `test-results/recovery/source-worker-native-loss.json`. Profiles, storage contents and raw receipts stay local. The full recovery roadmap item remains pending.
