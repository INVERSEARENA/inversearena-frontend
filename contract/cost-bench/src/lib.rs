//! Per-entry-point resource cost benchmarks (#1649).
//!
//! This crate has no code of its own: the benchmarks live in
//! `tests/cost_bench.rs` and drive each contract's compiled WASM, so the
//! recorded costs include VM instantiation and execution exactly as on-chain.
//! See `contract/docs/COST_BENCHMARKS.md` for how to run, compare and re-bless.

#![no_std]
