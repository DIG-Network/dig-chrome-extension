# Development Log

High-signal realizations from debugging/development. Concise durable facts with context — not a
change diary. See CLAUDE.md §4.5.

## Single active derivation index (#165) — a same-address split output must still get pairwise-distinct amounts, or duplicate CREATE_COINs collide

Migrating `prepareSplit` (coin control, `src/offscreen/coins.ts`) off the retired multi-index
gap-limit sweep removed the pool of distinct wallet addresses it used to hand one to each split
piece (`keyring[i]` for `i` in `0..outputs`). Under the single-active-index model there are only 2
addresses (unhardened + hardened at one index), so every split output now returns to the SAME
address. The naive "N equal pieces, remainder on the last" amount scheme then ties: when the split
amount divides evenly, ALL pieces get the identical amount, and `CREATE_COIN(same_ph, same_amount)`
twice in one spend collides on-chain (coin id = `hash(parent, ph, amount)` — identical inputs
produce identical, indistinguishable coin ids). The fix (`distinctSplitAmounts`) assigns
`base, base+1, …, base+outputs-2` plus a strictly-larger final piece absorbing the remainder —
algebraically provable that the final piece always exceeds the largest of the others whenever
`base > 0`, so amounts are pairwise distinct with NO per-output address diversity needed at all.
This also removes the old `SPLIT_TOO_MANY` ceiling (`outputs > keyring.length`) entirely — the
constraint was never really about "how many addresses do we have", it was "how do we keep coin ids
from colliding", and that's solvable with amounts alone.

## `buildKeyring`'s output order matters for every caller that reads `keyring[0]` as "the change/self address"

`sendFlow.ts`'s `buildKeyring` derives `[unhardened, hardened]` in that fixed order for the
requested index. A dozen call sites across `coins.ts`/`sendFlow.ts`/`offers.ts` treat `keyring[0]`
as THE self/change/destination address (never `keyring[1]`) — that convention survived the
multi-index → single-index migration (#165) unchanged only because the scheme order in the array
didn't change, just the count (was `2 × gapLimit` entries, now exactly 2). Any future change to
`buildKeyring`'s scheme ordering would silently redirect change to the wrong scheme everywhere.

## RTK Query object literals with an excess field are NOT caught by `vitest` — only `tsc --noEmit` catches them

Several existing test files (`catDiscovery.test.ts`, `coinControlVault.test.ts`, `didVault.test.ts`,
`nftMintVault.test.ts`, `nfts.test.ts`, `prepareSendRouting.test.ts`) called `buildKeyring(..., {
count: N })` / passed `gapLimit: N` in a `VaultRequest` object literal — a shape from BEFORE the
#165 rename. They kept passing at runtime (`vitest run` — plain JS, no type erasure at the call
site) even after the rename removed those fields from the real type, because the extra/renamed
field was simply ignored by the callee (which reads `opts.index`/`opts.activeIndex`, defaulting to
0 when absent) — the tests were silently exercising ONLY the default-index path regardless of what
value they thought they were passing. `npx tsc --noEmit` is the only thing that flags an excess
object-literal property (`TS2353`); a mechanical rename across many call sites is not verified
complete until typecheck is clean, not just "tests are green."

## chia-wallet-sdk-wasm's `RpcClient` has NO public JS constructor — `new RpcClient(url)` silently builds an unusable phantom instance (#148, P0: took down every wallet read)

`chia-wallet-sdk-wasm`'s wasm-bindgen-generated `RpcClient` class (`chia_wallet_sdk_wasm.d.ts`/`_bg.js`)
defines no `constructor` at all — only static factories: `RpcClient.new(coinsetUrl)`, `.mainnet()`,
`.testnet11()`. `src/offscreen/chain.ts`'s `makeWasmChainClient` called `new chia.RpcClient(coinsetUrl)`
since the coinset adapter's very first commit (#12) — this is NOT a wasm-version regression (the
resolved `chia-wallet-sdk-wasm` version + integrity hash were byte-identical across every release from
v1.39.0 through the release this shipped broken in; the bug was simply never-before-exercised, since
the whole adapter was `/* c8 ignore */`'d).

**Why it doesn't throw.** A JS class with no explicit `constructor` gets an implicit no-arg one
(`constructor(...args) {}` for a base class) — calling `new RpcClient(url)` with an argument does NOT
throw (JS never enforces arity), it just silently discards `url` and returns `Object.create(RpcClient.prototype)`
with `__wbg_ptr` never wired up (only `RpcClient.__wrap(ptr)`, called exclusively by the static
factories, sets it). Every method call on this phantom instance then dispatches into wasm with a null
self-pointer, which the Rust side rejects with `Error: null pointer passed to rust` — and that throw
happens from INSIDE a wasm-bindgen-futures async adapter callback, OUTSIDE the awaited promise's own
chain, so a `try/catch` around the call does NOT catch it in plain Node (confirmed empirically with
`--experimental-wasm-modules`: it crashes the process). In the browser/offscreen-document context it
behaves differently again — the production `withTimeout` wrapper (12s) eventually surfaces a GENERIC
vault-level error (`{code:'VAULT_ERROR', message:'vault operation failed'}`), indistinguishable at
that layer from an ordinary coinset outage, and it does NOT fire a `pageerror`/console event either.
This means an e2e/Playwright test CANNOT reliably pinpoint this exact bug by response shape or console
capture — only a real-wasm unit test (no live network, deterministic) catches it precisely; see
`src/offscreen/chain.realWasm.test.ts` for the regression test and `e2e/sw/wallet-balances.spec.ts` for
the complementary (but necessarily looser) end-user smoke test.

**Rule of thumb:** before calling `new SomeWasmBindgenClass(...)`, check the `.d.ts` for an explicit
`constructor` line — if there's only `static new(...)`/other named static factories, THAT is the real
constructor; `new` on the class itself silently builds a broken object instead of throwing.

## chia-wallet-sdk-wasm has no `Spends.addDid` / high-level DID `Action` (as of 0.33.0, confirmed at xch-dev/chia-wallet-sdk HEAD too)

The Rust driver's `Spends` struct (`crates/chia-sdk-driver`) internally tracks DIDs (`spends.dids`)
and even has an `Action::update_did` — but the wasm bindings (`crates/chia-sdk-bindings/src/action_system.rs`)
never expose a way to ADD a DID into a `Spends` session (only `addXch`/`addCat`/`addNft` exist). This
is a real, permanent bindings gap, not a version-lag issue. Every DID operation (create, transfer,
profile/metadata update, and NFT↔DID ownership assignment) must therefore be hand-built from the
low-level `Clvm.createEveDid` / `Clvm.spendDid` / `Clvm.spendNft` primitives directly, mirroring the
Rust driver's OWN internal construction (`Did::spend`, `Did::transfer`, `Did::update_with_metadata`,
`Nft::assign_owner` in `crates/chia-sdk-driver/src/primitives/{did,nft}.rs`) rather than the
`Action`/`Spends` convenience layer used for XCH/CAT/NFT-mint. See `src/offscreen/dids.ts` and
`src/offscreen/didAssign.ts`.

## A DID's `metadata` is curried into its puzzle — NOT carried by the create-coin hint — so a naive one-spend update is invisible to a chain rescan

`Did::parse_child` (`chia-sdk-driver/src/primitives/did.rs`) reconstructs a child DID's `p2PuzzleHash`
FROM THE CREATE-COIN HINT (so a transfer to a new owner is immediately observable by anyone rescanning
the chain), but reconstructs `metadata` from the PARENT coin's OWN curried value, unconditionally —
the docstring says outright: "this relies on the child... having the same metadata as the parent... If
this is not the case, the DID cannot be parsed... without additional context." A single
metadata-changing spend is therefore invisible to a hint-based rescan immediately afterward (the new
coin's parent — the coin just spent — still carries the OLD metadata in its own reveal).

**Fix (the SDK's own documented pattern, `Did::update`'s doc: "settle the DID's updated metadata and
make it parseable by wallets"):** spend TWICE — once to commit the new metadata into an EPHEMERAL
intermediate coin (built via `did.child(p2PuzzleHash, newMetadata)`, which computes the coin +
lineage proof exactly like the eve-DID commit does), then spend that ephemeral coin AGAIN self-to-self
(same target inner puzzle hash) in the SAME bundle. A later rescan reads the ephemeral coin as the
final coin's parent, whose OWN reveal now correctly carries the new metadata. See
`prepareDidProfileUpdate` in `src/offscreen/dids.ts`.

**Contrast — NFT ownership (`currentOwner`) needs no such trick.** The NFT ownership layer's
`TransferNft` condition (opcode -10) is a RUNTIME condition in the p2 spend's output — `Nft::parse_child`
reruns the transfer program from the revealed output conditions, so the new owner is directly
recoverable from one spend, same as a p2PuzzleHash hint. Only CURRIED (not condition-conveyed) state
needs the settle-spend trick.

## `chia-wallet-sdk-wasm` `Program.toString()` returns `''` for the nil atom, not `undefined` (despite the `.d.ts` signature)

`Clvm.alloc([]).toString()` (nil) is `''`; the TS binding declares `toString(): string | undefined`
but in practice never returns `undefined` for atoms tested (nil, byte atoms, string atoms). Treat a
falsy/blank string, not `=== undefined`, as "field unset" when decoding an optional on-chain metadata
value (e.g. a DID's freshly-created, never-profile-set `metadata`).

## NFT↔DID ownership-assignment announcement construction (byte-identical to `chia-sdk-driver`)

`assignment_puzzle_announcement_id(nftFullPuzzleHash, transferCondition)` =
`sha256(nftFullPuzzleHash ‖ 0xAD 0x4C ‖ treeHash(list(didLauncherId, tradePrices, didInnerPuzzleHash)))`
— note the args list for the treehash is the BARE 3-tuple `(launcherId, tradePrices, innerPuzzleHash)`,
WITHOUT the `-10` opcode prefix that the actual on-chain `TransferNft` condition carries (those are two
different encodings of related data — don't reuse one `Program` handle for both). The DID's own spend
must add BOTH `assertPuzzleAnnouncement(that id)` AND `createPuzzleAnnouncement(nftLauncherId)` — the
NFT's ownership-layer puzzle automatically creates the matching announcement the DID asserts (baked
into consensus), and automatically asserts the announcement the DID creates. Verified against
`xch-dev/chia-wallet-sdk` `crates/chia-sdk-driver/src/primitives/nft.rs` (`assign_owner`) +
`actions/update_nft.rs`. See `src/offscreen/didAssign.ts`.

## `connect-src` CSP blocks `fetch()` to arbitrary hosts even when `img-src` allows them — cache via `<img>`+canvas, not `fetch()`

The manifest's `img-src` is `'self' data: https:` (any HTTPS host, #150 — NFT art can live anywhere),
but `connect-src` is a small explicit allowlist (rpc.dig.net, coinset, dexie, coingecko, bugreport).
Reaching for `fetch(url)` to read an arbitrary NFT-art host's bytes (to cache them, #159) is CSP-
blocked for virtually every real host, REGARDLESS of the host's CORS headers — the request never
leaves the renderer. Confirmed via Playwright e2e: switching the loader from `fetch()` to an
off-screen `<img crossOrigin="anonymous">` + `canvas.drawImage`/`toBlob()` fixed it immediately,
because that request is an "image" CSP destination (`img-src`), not a "fetch" destination
(`connect-src`). Widening `connect-src` to `https:` would also fix it, but is a bigger security-surface
change (lets a compromised script READ arbitrary cross-origin responses, not just send data via a URL
like `img-src` already allows) — prefer the `<img>`+canvas route for any future "read bytes from an
arbitrary NFT-art host" need. Caveat: the canvas read needs the host to send
`Access-Control-Allow-Origin` (`crossOrigin="anonymous"` fails the load entirely otherwise) — fall back
to embedding the raw URL directly (uncached) rather than failing closed, since a PLAIN `<img src>` (no
`crossOrigin`) was never CORS-gated for display. See `src/features/collectibles/nftImageCache.ts`.

**Playwright quirk found while debugging this:** `context.route().fulfill()` does NOT enforce real
browser CORS checks on `crossOrigin="anonymous"` image loads — a mocked response with NO
`Access-Control-Allow-Origin` header still loads successfully under Playwright's CDP-based
interception (verified with an isolated probe). A CORS-rejection code path can't be e2e-proven through
route mocking; test it at the unit level (mock the loader function itself) instead.
