#![no_std]

mod snapshot_tests;
mod storage;
mod types;

use storage::FactoryStorage;
use types::FactoryError;

/// Factory contract — deploys arena instances and enforces protocol-level rules.
///
/// Architecture overview: see `ARCHITECTURE.md` in the workspace root.
#[contract]
pub struct FactoryContract;

#[contractimpl]
impl FactoryContract {

    }
}
