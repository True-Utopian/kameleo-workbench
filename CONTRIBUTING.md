# Contributing

Use Node 24 and `npm ci`. Run `npm run check` before a change is submitted. Keep provider requests bounded, preserve the original profile on every failure path, and never include account data, proxy credentials or profile archives in fixtures.

Test behavior at its boundary: stale evidence must block input, an uncertain submission must not replay, failed durable writes must prevent dispatch, and unconfirmed stops must retain capacity. Include changed-choice, identity-mismatch, archive and lease-race cases when those paths change. Real Engine/provider tests need local credentials and belong in the validation record rather than default CI.

Keep examples small enough to copy. Document a limitation where it applies. A new integration should link its provider's official API reference and identify which requests can spend money. Do not add automatic purchases to the allocator.
