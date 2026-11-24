//! Shared Soroban test fixture builders for InverseArena contracts (#1464).
//!
//! Enforces valid defaults (distinct generated addresses, positive stakes,
//! valid round bounds) while exposing explicit invalid-state helpers for
//! negative and boundary tests.
//!
//! Include in a contract's `#[cfg(test)]` module with:
//! `#[path = "../../test-support/fixtures.rs"] mod fixtures;`

#![allow(dead_code)]

use soroban_sdk::{testutils::Address as _, Address, Env, String};

pub const MAX_ARENA_PLAYERS: u32 = 256;

#[derive(Clone, Debug)]
pub struct ArenaFixture {
    pub admin: Address,
    pub token: Address,
    pub entry_fee: i128,
    pub max_players: u32,
    pub round_duration_secs: u64,
}

impl ArenaFixture {
    pub fn valid(env: &Env) -> Self {
        Self {
            admin: Address::generate(env),
            token: Address::generate(env),
            entry_fee: 10_000_000,
            max_players: 16,
            round_duration_secs: 300,
        }
    }

    pub fn with_max_players_boundary(mut self) -> Self {
        self.max_players = MAX_ARENA_PLAYERS;
        self
    }

    /// Explicit invalid-state helper: zero entry fee.
    pub fn with_zero_entry_fee(mut self) -> Self {
        self.entry_fee = 0;
        self
    }

    /// Explicit invalid-state helper: zero max players.
    pub fn with_zero_max_players(mut self) -> Self {
        self.max_players = 0;
        self
    }

    pub fn validate(&self) -> Result<(), &'static str> {
        if self.entry_fee <= 0 {
            return Err("entry_fee must be positive");
        }
        if self.max_players < 2 || self.max_players > MAX_ARENA_PLAYERS {
            return Err("max_players out of bounds");
        }
        if self.round_duration_secs == 0 {
            return Err("round_duration_secs must be positive");
        }
        Ok(())
    }
}

#[derive(Clone, Debug)]
pub struct PayoutFixture {
    pub payout_id: String,
    pub recipient: Address,
    pub amount: i128,
    pub round_number: u32,
}

impl PayoutFixture {
    pub fn valid(env: &Env, suffix: &str) -> Self {
        Self {
            payout_id: String::from_str(env, suffix),
            recipient: Address::generate(env),
            amount: 25_000_000,
            round_number: 1,
        }
    }

    /// Explicit invalid-state helper: non-positive payout amount.
    pub fn with_zero_amount(mut self) -> Self {
        self.amount = 0;
        self
    }

    /// Explicit invalid-state helper: duplicate payout_id for idempotency tests.
    pub fn with_duplicate_id(mut self, env: &Env, existing: &str) -> Self {
        self.payout_id = String::from_str(env, existing);
        self
    }

    pub fn validate(&self) -> Result<(), &'static str> {
        if self.amount <= 0 {
            return Err("payout amount must be positive");
        }
        if self.round_number == 0 {
            return Err("round_number must be >= 1");
        }
        Ok(())
    }
}
