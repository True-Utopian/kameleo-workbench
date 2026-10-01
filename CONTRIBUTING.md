# Contributing

Use Node 24 and `npm ci`. Run `npm run check` before a change is submitted. Keep provider requests bounded, preserve the original profile on every failure path, and never include account data, proxy credentials or profile archives in fixtures.

Tests should exercise behavior: cancellation, stale challenges, failed exports, competing proxy leases and recovery matter more than testing private methods. Real Engine/provider tests need explicit local credentials and belong in the validation record, not default CI.

Keep examples small enough to copy. Document a limitation where it applies. A new integration should link its provider's official API reference and identify which requests can spend money. Do not add automatic purchases to the allocator.
