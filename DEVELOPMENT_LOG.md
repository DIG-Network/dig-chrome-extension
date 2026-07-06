# Development Log

High-signal realizations from debugging/development. Concise durable facts with context — not a
change diary. See CLAUDE.md §4.5.

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
