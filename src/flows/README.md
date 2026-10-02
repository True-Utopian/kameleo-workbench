# Flow engine

`compiler.ts` validates and freezes a pack with its trusted manifest. `recognition.ts` samples main-frame evidence and applies refinement, stability and freshness rules. `driver.ts` connects guarded Puppeteer actions to those rules. `interpreter.ts` executes the finite graph and persists each action intent before dispatch.

The host provides an atomic `FlowJournal`, exclusive browser ownership, input prompts and installed identity/reconciliation resolvers. It handles browser creation, lease renewal, stopping and archive export. The interpreter returns only after a complete step; it does not equate website completion with a verified export.

See [the flow guide](../../docs/flows.md) for the public interfaces and [the tests](../../test/flows.test.ts) for failure and recovery cases. Schema files in `../../schemas/` must be distributed alongside the compiled module.
