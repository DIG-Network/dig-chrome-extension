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

## An `inline-flex`/`flex` row with no `overflow`/`min-width:0` silently overflows the popup sideways (#163)

`.dig-seg` (the shared wallet/network segmented control, `SegmentedControl.tsx`) was `display:
inline-flex` with no `overflow`, no `flex-shrink` handling on its buttons, and no wrap. With 5 wallet
segments (`Home | Activity | Trade | Collectibles | Identity`) it naturally sized to ~430px — wider
than the 372px popup — and neither it nor its flex-row ancestor (`.dig-toggle-row`) clipped that
overflow, so it bled into `.dig-main` (`[data-testid="popup-root"]`), which — because it already sets
`overflow-y: auto` — silently became horizontally scrollable too (per the CSS overflow spec, setting
one axis to a non-`visible` value forces the other to computed `auto`, not `visible`). Confirmed with
`el.scrollWidth - el.clientWidth` (450 vs 372 before the fix; jsdom can't catch this — `scrollWidth`/
`clientWidth` are always 0 there, so this class of bug needs a REAL layout engine: Playwright, not
vitest).

**Fix + the general pattern:** give the WIDE INNER element itself `max-width: 100%; overflow-x: auto`
(make it the scroll container, never the popup body) plus `flex: none; white-space: nowrap` on its
non-shrinking children. Bonus: setting `overflow-x` to anything but `visible` also zeroes that
element's flexbox *automatic minimum size* (normally its min-content width), which is what let it
shrink below its buttons' combined width in the first place — a plain `min-width: 0` alone would NOT
have been enough here since the element wasn't itself the overflowing flex item hitting that specific
default; the `overflow` change was necessary. Any future segmented-tab-style control (or long
mono/address row) added to a popup screen needs the same treatment, not a fixed-width guess. See
`src/styles/theme.css` (`.dig-seg`) and the Playwright guard `e2e/screenshots.spec.ts` ("has no
horizontal overflow").

## `position: sticky` headers must sit OUTSIDE the bordered card, not nested inside it (#166)

Building the shared `ViewHeader` sticky-top-bar primitive: putting it as the first child INSIDE a
screen's `.dig-card` (border + radius + shadow + background) makes the sticky strip visually clip
against the card once it pins mid-scroll — the card's rounded top edge and border scroll away
underneath the still-pinned header, leaving a visible seam. Fix: `ViewHeader` renders as a sibling
BEFORE the `.dig-card`, both wrapped in a plain (unstyled) `<div>` — so the sticky strip floats over
plain background, and the card's own border/shadow/radius scroll normally beneath it. Applies to
every future sticky in-page header, not just this one.

**Vitest/RTL trap when asserting a `.click()` navigates then asserting the closed state's absence:**
two `render()` calls of different props in the SAME `it()` (e.g. "onBack shown" then "onBack NOT
shown") both stay mounted in the same jsdom `document.body` unless you `unmount()` the first — a
`screen.queryByTestId` after the second render still finds the FIRST render's element and the
"absent" assertion passes for the wrong reason (or fails misleadingly). Either split into two `it()`s
(cleanup runs between tests automatically) or explicitly call the first render's returned `unmount()`
before the second render.

**Playwright e2e trap: `.click()` auto-scrolls the target into view before clicking**, which can leave
a scroll container's `scrollTop` non-zero afterward even though a real user click on an
already-visible element wouldn't have scrolled anything. This defeats a "reachable with ZERO
scrolling" assertion taken right after a `.click()`. Use `.click({ force: true })` (skips Playwright's
own actionability/scroll-into-view step) or explicitly reset `scrollTop = 0` before measuring — see
`e2e/sw/view-header-receive.spec.ts`.

## #154 — nearly every confirm* action already reuses `confirmSend`'s wire shape, so one enrichment fed activity-logging to nine action kinds for free

Replacing the on-chain Activity scan with a local MetaMask-style log required knowing, at broadcast
time, WHAT was just spent (asset/amount/counterparty) so the SW could write a real entry. The naive
assumption was "every action kind needs its own plumbing" — false. `confirmNftTransfer`,
`confirmNftMint`, `confirmDidCreate`, `confirmDidTransfer`, `confirmDidProfileUpdate`, and
`confirmNftDidAssign` all literally call `vault.handle({ op: 'confirmSend', pendingId })` — the SAME
vault method as a plain XCH/CAT send (`src/background/index.ts`'s case handlers just relabel the
SW-level action name; `src/offscreen/vault.ts` has exactly ONE broadcast method for all of them,
keyed off a single shared `this.pending` map). So adding ONE optional field —
`activityHint: {asset, amount, counterparty}` — captured at each `prepare*` call site (where the
real data already exists: `req.recipient` for a transfer, a synthetic `'NFT'`/`'DID'` label + null
counterparty for a self-only mint/create) and echoed back by the single shared `confirmSend` method,
gave SEVEN of the eight emitted activity kinds real data with zero new wire surface. Only
`confirmTrade` needed its own (near-identical) treatment because offers use a separate
`pendingTrades` map. The tell: before adding a new field/path per action, check whether the actions
already collapse onto one shared vault method — coin-control's `prepareSplit`/`prepareCombine` ALSO
reuse the plain `confirmSend` path, which is why a real send is distinguished from a self-only
split/combine purely by `activityHint.counterparty` being non-null, not by a separate action check.

## Receive-detection must skip the FIRST balance scan after any wallet/index switch, or a pre-existing balance reads as a fake "receive"

`walletCache.balances` already gets cleared on every wallet switch AND every `setActiveIndex` call
(`clearActiveWalletCaches`, pre-existing, unrelated to #154). Diffing "previous vs current" balance
to detect a receive (`detectReceivedEntries`) is only correct because of that existing clear: the
first `getCustodyBalances` scan after switching has NO prior snapshot, so the SW skips the delta
call entirely (`logReceivedActivity` no-ops on a missing baseline) rather than comparing against
`{xch:0, cats:{}}` and reporting the *entire* newly-active wallet's existing balance as a single
giant "received" entry. The pure `detectReceivedEntries` function itself does NOT enforce this — it
happily treats a missing baseline as zero (that's the right behavior for a genuinely brand-new
wallet) — the skip-on-first-scan policy lives entirely in the SW glue
(`src/background/index.ts`'s `getCustodyBalances` case), which is exactly the kind of policy
decision easy to accidentally omit when only unit-testing the pure function in isolation. Any future
consumer of `detectReceivedEntries` MUST replicate this "no prior snapshot → don't call it" guard,
not rely on the function to do it.

## #152 — a new VaultOp MUST be added to `src/entries/offscreen.ts`'s `NEEDS_CHIA`/`NEEDS_CHAIN` allowlists, or it silently gets empty deps and returns CHAIN_UNAVAILABLE

`Vault.handle(req, deps)` (the pure, unit-tested class in `src/offscreen/vault.ts`) is NOT what
decides whether a given op receives `deps.chia`/`deps.chain` — that's a SEPARATE, hardcoded
allowlist in the thin entry glue `src/entries/offscreen.ts` (`NEEDS_CHIA`/`NEEDS_CHAIN`, two
`Set<VaultRequest['op']>`), which is coverage-excluded (`src/entries/**`) and therefore invisible to
`npm run test:web`. Adding `listClawbacks`/`prepareClawbackAction` as new vault ops without also
adding them to BOTH sets compiled clean, passed every `vault.test.ts` unit test (those tests call
`vault.handle` directly with hand-built `deps`, bypassing `depsFor()` entirely), and passed `npx tsc`
— then failed deterministically in the real built extension with `CHAIN_UNAVAILABLE` on the very
first e2e call, because `depsFor()` returned `{}` for an op absent from `NEEDS_CHIA`. This is
precisely the class of bug e2e wiring tests exist to catch (mirroring #91/#93's own "prove it's not
the unknown-action stub" e2e pattern) — a unit-test-only verification pass would have shipped it.
**Any new `VaultOp` that reads derived keys/coinset MUST be added to both sets in
`src/entries/offscreen.ts`, and its e2e coverage MUST actually run against the built `dist/`
extension** (not just `vitest run`) before considering the op "wired."

## Chia clawback (`ClawbackV2`) is a hard on-chain CUTOVER at the deadline, not a race window

Read literally, "the recipient can only claim after the window, and the sender can reclaim before
the recipient claims" sounds like an open-ended race that could go either way after the deadline.
Verified against the real `chia-wallet-sdk-wasm` Simulator (not assumed): the underlying puzzle
enforces a STRICT, non-overlapping split at `seconds` (an absolute unix timestamp) —
`senderSpend`'s solution embeds `ASSERT_BEFORE_SECONDS_ABSOLUTE(seconds)` (valid ONLY strictly
before the deadline) and `receiverSpend`'s embeds `ASSERT_SECONDS_ABSOLUTE(seconds)` (valid ONLY
at/after it); there is no timestamp at which both are simultaneously spendable. A reclaim attempted
at/after the deadline fails on-chain (`AssertBeforeSecondsAbsoluteFailed`) exactly as reliably as an
early claim fails (`AssertSecondsAbsoluteFailed`) — confirmed empirically against a live Simulator,
not inferred from the wasm's `.d.ts` alone (the signatures alone give no hint of this; `senderSpend`/
`receiverSpend` take only a `Spend`, no explicit time parameter — the constraint is baked into the
curried puzzle from the constructor's `seconds` field). Practical upshot for any clawback UI: the
"claw back" affordance must disable/hide once the window elapses (not "race" against the receiver);
`ClawbackV2`'s own `seconds` field is always an ABSOLUTE deadline the caller computes as
`now + chosenDuration` once, never a raw duration threaded further down.

## `ClawbackV2` has a REAL public wasm constructor (unlike `RpcClient.new(...)`-only, #148) — but its memo/discovery methods split by whether they need a `Clvm`

`new chia.ClawbackV2(senderPuzzleHash, receiverPuzzleHash, seconds, amount, hinted)` is safe to call
directly (confirmed against the generated `.d.ts`: a real `constructor(...)`, not a static-`new`-only
factory) — it wraps a plain Rust data struct (`{sender_puzzle_hash, receiver_puzzle_hash, seconds,
amount, hinted}`, mirrored exactly in `xch-dev/sage`'s `child_kind.rs`), so `puzzleHash()`,
`senderSpend(spend)`, `receiverSpend(spend)`, and the static `fromMemo(...)` all take NO `Clvm`
parameter — they build/consume fully-serialized `Spend`/`Program` values that work regardless of
which `Clvm` instance's allocator produced their inputs. The ONE exception is `memo(clvm: Clvm)` —
it DOES take a `Clvm`, because the resulting memo `Program` must be curried into the SAME allocator
tree as the rest of the send driver's output (the `Spends`/`Action` machinery's `Action.send(...,
memos)` argument) for the final serialized bundle to cohere; building it against a throwaway `Clvm`
and passing the result into a different one's `Action.send` would silently produce inconsistent
output. This is why `offscreen/clawback.ts`'s `clawbackDestination()` returns a `buildMemos(clvm)`
CALLBACK rather than a pre-built memo Program — `send.ts`'s `buildXchSend` invokes it with its OWN
internal `clvm`, right before finalizing.

## `Vault.handle()`'s catch-all silently swallowed domain error codes (#179 root cause)

`vault.ts`'s `handle()` wraps every op in one `try { switch(...) } catch (e) { ... }`. The catch ONLY
special-cased `KeystoreError` (`return { code: e.code, ... }`); every OTHER thrown `Error` — including
the `CODE: message` convention used throughout `dids.ts`/`nfts.ts`/`sendFlow.ts` (`NO_XCH_COINS`,
`NO_SUITABLE_COIN`, `MISSING_KEY`, …) — fell through to a hardcoded generic `{ code: 'VAULT_ERROR',
message: 'vault operation failed' }`, discarding the real cause before it ever reached the UI. The fix
generalizes the catch to regex-extract a leading `CODE:` prefix from ANY thrown `Error.message` (the
same convention two OTHER call sites — `signDappSpend`/`signMessage` — already handled locally with
`msg.startsWith('MISSING_KEY')`), falling back to `VAULT_ERROR` only for a throw that carries no code
at all. **The regression test that should have caught this originally asserted the WRONG thing** —
`didVault.test.ts`'s `"prepareDidCreate fails NO_XCH_COINS..."` test only checked
`expect(res.code).not.toBe('NO_PENDING')`, which the generic `VAULT_ERROR` also satisfies; a test
whose name promises a specific code must assert that exact code, not merely "not some other code".
Any future vault op that throws a new domain code gets it surfaced automatically — no per-op catch
needed — but a caller-side UI still has to explicitly branch on the code to show a specific message
(the generic surfacing alone does not localize/word it); mapping it to copy is done in the feature's
own component (e.g. `CreateDid.tsx`'s `didCreateErrorMessage`).
