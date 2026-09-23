# DRAFT — not opened, not pushed

Upstream PR against `solana-foundation/pay-kit`,
`typescript/packages/mpp/src/server/Charge.ts`.

Drafted 2026-09-19. **Nothing has been filed or pushed.**

---

## Title

`fix(mpp): send preflightCommitment with sendTransaction so confirmed-only blockhashes are accepted`

## The change

```diff
--- a/typescript/packages/mpp/src/server/Charge.ts
+++ b/typescript/packages/mpp/src/server/Charge.ts
@@ -1349,7 +1349,7 @@ async function broadcastTransaction(rpcUrl: string, base64Tx: string): Promise<s
             id: 1,
             jsonrpc: '2.0',
             method: 'sendTransaction',
-            params: [base64Tx, { encoding: 'base64', skipPreflight: false }],
+            params: [base64Tx, { encoding: 'base64', preflightCommitment: 'confirmed', skipPreflight: false }],
         }),
         headers: { 'Content-Type': 'application/json' },
         method: 'POST',
```

One line. `skipPreflight` stays `false` — this aims preflight, it does not skip it.

## Body

`broadcastTransaction` sends `sendTransaction` without `preflightCommitment`.
Solana's default for that parameter is `finalized`:

- `agave` `rpc/src/rpc.rs` passes `None` when `preflight_commitment` is unset;
  `bank()` does `commitment.unwrap_or_default()`; `solana-sdk`'s
  `CommitmentLevel` derives `#[default] Finalized`.

Meanwhile the same file mints the challenge blockhash at `confirmed`
(`Charge.ts:182`) and simulates at `confirmed` (`Charge.ts:1327`). So for the
~12 seconds it takes a blockhash to finalize, the preflight bank has never seen
it and the RPC rejects the transaction:

```
RPC error: Transaction simulation failed: Blockhash not found
```

The failure is deterministic, not flaky, and it is inverted from what anyone
would guess: a client that pays **fast** always fails, and one that dawdles past
finality succeeds. It is also invisible to `simulateTransaction`, which the
package calls immediately before at `confirmed` and which passes — so the error
surfaces only at the send step.

It is invisible in sandbox too: Surfpool stamps a synthetic always-valid
blockhash (`SURFNETxSAFEHASH…`, see `server/network-check.ts`) with no finality
semantics, so the confirmed/finalized split does not exist there.

### The kit already does this correctly in three other languages

Only the TypeScript implementation omits it. Verified in this repo at HEAD:

| language | file | line | sets it? |
|---|---|---|---|
| PHP | `php/src/Protocols/Mpp/Server/SolanaChargeHandler.php` | 283 | `'preflightCommitment' => 'confirmed'` |
| Python | `python/src/solana_pay_kit/_paycore/rpc.py` | 107 | `"preflightCommitment": "confirmed"` |
| Go | `go/paycore/solanatx/solanatx.go` | 317 | `PreflightCommitment: rpc.CommitmentConfirmed` |
| **TypeScript** | `typescript/packages/mpp/src/server/Charge.ts` | **1352** | **omitted** |

The PHP one is the MPP charge handler itself, so this is a straight
inconsistency within one protocol implementation rather than a difference of
opinion between unrelated components.

### Measured

Same transaction, same freshly minted `confirmed` blockhash, simulated at both
commitments against mainnet:

```
commitment=confirmed   value.err=null
commitment=finalized   value.err="BlockhashNotFound"

confirmed slot : 448354281
finalized slot : 448354250
finality lag   : 31 slots (~12.4s)
```

### Proof on real money

Found by a production integration of `@solana/mpp` 0.7.0 gating a live paid API.
Before the fix, a mainnet payment failed with the blockhash error 3.7 s after
the challenge was issued — well inside the 12.4 s window — with nothing wrong
with the credential: correct mint, amount 1000 base units, correct derived
recipient ATA, validly signed, and using the server-supplied blockhash exactly
as §7.2 recommends.

With this one-line change applied to the installed package, the same flow
settled on Solana mainnet:

```
signature : 3jZnZQ4Qxx1oGrWv3jj2sKz5oGW6EKSgBBwVmthfpo48jVkSMdrW1yphpaapEMHtYcAzbMEmgQbZFUn446xYxCg3
slot      : 448360973
blockTime : 2026-09-19T09:01:29Z
amount    : 1000 base units USDC (EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v)
fee       : 5001 lamports, paid by the payer (feePayer:false)
status    : finalized, meta.err = null
```

Verified from a public RPC independent of the one the server used.

### Affected versions

Both. npm `latest` is 0.7.0 (`dist/server/Charge.js:982`) and repo HEAD is
0.11.0 (`src/server/Charge.ts:1352`); the omission is identical in each. A
search of the repository's issues and pull requests for `preflightCommitment`
returns nothing, so this does not appear to have been reported.

### Note for maintainers

`preflightCommitment: 'confirmed'` is also what §12.5 of
`draft-solana-charge-00` mandates for settlement verification ("Servers MUST
fetch the transaction with at least `confirmed` commitment"), so this makes the
three RPC calls in the settlement path agree with each other and with the spec,
rather than loosening anything.

An alternative fix would be to mint the challenge blockhash at `finalized`, but
that is strictly worse: it burns ~12 s of the blockhash's ~60 s validity window
before the client ever sees it.
