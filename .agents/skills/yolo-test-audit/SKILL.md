---
name: yolo-test-audit
description: Use when writing, changing, reviewing, or pruning Yolo tests; rejects duplicate, implementation-coupled, or test-only-seam proof and keeps one owner test per contract at its strongest boundary. Adapted from OpenClaw's test-audit skill.
---

# Test audit

Every new or changed test passes the authoring gate. An audit removes low-value proof in coherent owner batches. Run and select proof with [`yolo-testing`](../yolo-testing/SKILL.md).

Yolo's suite was cut by more than 80% on 2026-10-18 under this skill. The suite stays small on purpose: extend a keeper before adding a file, and delete a test when you add a stronger one for the same contract.

## Authoring gate

Before adding a test, answer:

1. Which observable behavior, invariant, or independent contract does it protect?
2. Which credible regression makes it fail?
3. Why does existing proof miss it? Each contract has one owner test at the strongest boundary that is still cheap. Another layer needs a distinct risk (transport, lifecycle, browser). Extend a table or a shared fixture instead of adding a file.
4. Does it need an export, flag, wrapper, or injection hook that no production caller uses? Then prove it at the real boundary instead.

- A regression test fails before the fix for the intended reason and passes after. One owner regression covers a bug; never replay it at every layer it crossed.
- A behavior-preserving refactor must not break a test.

## Junk patterns

Delete or reject:

- assertion-free probes, self-comparisons, expected values computed by the code under test;
- copied inventories, export lists, and source or string greps (except a gate such as `scripts/provider-names.test.js` that guards a rule no identifier rename can dodge);
- tests of private helpers or call shapes that a boundary test or an e2e journey already proves;
- mocks that supply the behavior the test asserts, fixtures that fabricate what the owner should produce, persistence asserted on a path the code never writes;
- negative controls that pass on an unrelated guard, and names that promise behavior the test never exercises;
- narrow regressions for fixed bugs that a broader keeper already covers.

## Retention bar

Keep, compactly, the independent contracts whose break would be silent: security (device credentials, media tokens, HMAC signing, pairing, passkeys), D1 migrations and storage, wire shapes (`/v1`, MCP tools, `/internal/v1`, the plugin API), defaults and configuration rendering, and the AGENTS.md rules (bounded decode queues, single-flight HLS prefetch, direct paths before the relay, no provider names under `service/`). Slow or static is not by itself a reason to delete. A baseline failure may be a product bug: repair the owner, do not delete the test.

## Audit workflow

1. Baseline: record line and test counts and the pass or fail state of every in-scope file.
2. Split the surface into lanes by production owner (player, control, node and core, plugins and ops, e2e); lanes can be audited in parallel because their files do not overlap.
3. For each test declaration, read its assertions (not its name), the production owner, its callers, and the overlapping proof. Mark it retain, repair, consolidate (naming the keeper), or delete (naming the proof that remains).
4. Name one keeper per contract, preferring the real boundary with a fake network over a mocked collaborator. Fold assertions into keepers; delete helpers and fixtures nothing uses.
5. Remove the production seams the deletions leave test-only (exports, injection parameters, reset hooks).
6. Run the lane's tests, then `npm run check`. Fix notes and links that named a deleted test.
7. Report: line and test counts before and after, production versus test lines, the keepers, the riskiest losses, and follow-ups.
