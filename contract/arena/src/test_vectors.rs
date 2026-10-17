//! Shared commit-reveal golden test vectors test suite (#1643).
//!
//! Validates that `ArenaContract::compute_commitment` matches the canonical golden
//! test vectors stored in `contract/test-vectors/commitment.json`. These vectors are
//! shared with the TypeScript frontend client (`commit-reveal.test.ts`), ensuring
//! that client-generated commitments always verify correctly on-chain.
//!
//! Regeneration / Bless mode:
//! To recompute and update golden hashes in `commitment.json`:
//!   `BLESS=1 cargo test -p arena test_vectors:: -- --nocapture`
//!   or `python contract/scripts/generate_commitment_vectors.py --bless`

use crate::ArenaContract;
use crate::types::Choice;
use serde::{Deserialize, Serialize};
use soroban_sdk::{BytesN, Env};

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CommitmentVector {
    pub id: String,
    pub description: String,
    pub choice: String,
    pub choice_byte: u8,
    pub salt: String,
    pub expected_hash: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CommitmentVectorFile {
    pub version: String,
    pub description: String,
    pub hash_algorithm: String,
    pub preimage_format: String,
    pub vectors: Vec<CommitmentVector>,
}

const GOLDEN_JSON: &str = include_str!("../../test-vectors/commitment.json");

#[test]
fn test_commitment_golden_vectors() {
    let env = Env::default();
    let mut vector_file: CommitmentVectorFile =
        serde_json::from_str(GOLDEN_JSON).expect("Failed to parse golden commitment.json");

    assert!(
        !vector_file.vectors.is_empty(),
        "Golden test vectors list cannot be empty"
    );
    assert_eq!(
        vector_file.hash_algorithm, "SHA-256",
        "Hash algorithm must be SHA-256"
    );

    let bless = std::env::var("BLESS")
        .map(|v| v == "1" || v.eq_ignore_ascii_case("true"))
        .unwrap_or(false)
        || std::env::args().any(|a| a == "--bless" || a == "bless");

    let mut updated = false;

    for vector in vector_file.vectors.iter_mut() {
        let choice = match vector.choice.as_str() {
            "Heads" => {
                assert_eq!(vector.choice_byte, 0, "Heads must have choice_byte 0");
                Choice::Heads
            }
            "Tails" => {
                assert_eq!(vector.choice_byte, 1, "Tails must have choice_byte 1");
                Choice::Tails
            }
            other => panic!("Unknown choice string in vector {}: {}", vector.id, other),
        };

        let salt_bytes = hex::decode(&vector.salt)
            .unwrap_or_else(|e| panic!("Failed to decode salt hex for {}: {}", vector.id, e));
        assert_eq!(
            salt_bytes.len(),
            32,
            "Salt for vector {} must be exactly 32 bytes, got {}",
            vector.id,
            salt_bytes.len()
        );

        let mut salt_arr = [0u8; 32];
        salt_arr.copy_from_slice(&salt_bytes);
        let salt = BytesN::from_array(&env, &salt_arr);

        let computed = ArenaContract::compute_commitment(&env, choice, &salt);
        let computed_hex = hex::encode(computed.to_array());

        if bless {
            if vector.expected_hash != computed_hex {
                vector.expected_hash = computed_hex;
                updated = true;
            }
        } else {
            assert_eq!(
                computed_hex, vector.expected_hash,
                "Golden commitment hash mismatch for vector '{}' (choice: {}, salt: {})",
                vector.id, vector.choice, vector.salt
            );
        }
    }

    if bless {
        let serialized = serde_json::to_string_pretty(&vector_file)
            .expect("Failed to serialize blessed vectors");
        let manifest_dir = std::path::Path::new(env!("CARGO_MANIFEST_DIR"));
        let target_path = manifest_dir.join("../test-vectors/commitment.json");
        std::fs::write(&target_path, format!("{}\n", serialized))
            .expect("Failed to write blessed vectors to commitment.json");
        println!(
            "Successfully blessed {} commitment test vectors (updated: {}) at {:?}",
            vector_file.vectors.len(),
            updated,
            target_path
        );
    }
}

#[test]
fn test_commitment_edge_case_salts_distinct() {
    let env = Env::default();

    let zero_salt = BytesN::from_array(&env, &[0u8; 32]);
    let ff_salt = BytesN::from_array(&env, &[0xffu8; 32]);

    let heads_zero = ArenaContract::compute_commitment(&env, Choice::Heads, &zero_salt);
    let tails_zero = ArenaContract::compute_commitment(&env, Choice::Tails, &zero_salt);
    let heads_ff = ArenaContract::compute_commitment(&env, Choice::Heads, &ff_salt);
    let tails_ff = ArenaContract::compute_commitment(&env, Choice::Tails, &ff_salt);

    // Same salt with different choice must yield completely different commitments
    assert_ne!(heads_zero, tails_zero);
    assert_ne!(heads_ff, tails_ff);

    // Different salts with same choice must yield different commitments
    assert_ne!(heads_zero, heads_ff);
    assert_ne!(tails_zero, tails_ff);
}

#[test]
fn test_commitment_preimage_byte_layout() {
    let env = Env::default();

    let salt_arr = [0x2au8; 32];
    let salt = BytesN::from_array(&env, &salt_arr);

    // Expected byte layout: [choice_byte] ++ [salt 32 bytes]
    let mut manual_preimage = soroban_sdk::Bytes::new(&env);
    manual_preimage.push_back(Choice::Heads.to_byte()); // 0
    for b in salt_arr.iter() {
        manual_preimage.push_back(*b);
    }
    let expected_hash: BytesN<32> = env.crypto().sha256(&manual_preimage).into();

    let contract_hash = ArenaContract::compute_commitment(&env, Choice::Heads, &salt);
    assert_eq!(contract_hash, expected_hash);
}
