//! Golden test vectors shared with the TypeScript client (#1643).
//!
//! Every vector in `contract/test-vectors/commitment.json` is recomputed here
//! from first principles (independent SHA-256, not `compute_commitment`) and
//! compared against the checked-in file. The Jest suite in
//! `frontend/src/shared/lib/stellar/__tests__/test-vectors.test.ts` asserts the
//! same file, so a divergence on either side fails CI.
//!
//! Regenerate the file with:
//!
//! ```bash
//! BLESS_TEST_VECTORS=1 cargo test -p arena commitment_vectors -- --nocapture
//! ```
//!
//! See `contract/test-vectors/README.md` for the full workflow.

#![cfg(test)]

use sha2::{Digest, Sha256};
use std::fs;
use std::path::PathBuf;

/// `Choice::to_byte` — must stay in lockstep with `types.rs`.
fn choice_byte(choice: &str) -> u8 {
    match choice {
        "Heads" => 0,
        "Tails" => 1,
        other => panic!("unknown choice in vector: {other}"),
    }
}

fn hex_to_bytes(hex: &str) -> Vec<u8> {
    (0..hex.len())
        .step_by(2)
        .map(|i| u8::from_str_radix(&hex[i..i + 2], 16).expect("valid hex"))
        .collect()
}

fn bytes_to_hex(bytes: &[u8]) -> String {
    bytes.iter().map(|b| format!("{b:02x}")).collect()
}

fn vectors_path() -> PathBuf {
    // contract/arena/src/commitment_vectors.rs → contract/test-vectors/commitment.json
    PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("..")
        .join("test-vectors")
        .join("commitment.json")
}

fn load_vectors() -> serde_json::Value {
    let raw = fs::read_to_string(vectors_path()).expect("read commitment.json");
    serde_json::from_str(&raw).expect("parse commitment.json")
}

/// Independent SHA-256 of `[choice_byte] ++ salt` — deliberately does **not**
/// call `ArenaContract::compute_commitment`, so a bug in the contract helper
/// cannot hide behind a self-consistent test.
fn independent_commitment(choice: &str, salt: &[u8]) -> Vec<u8> {
    assert_eq!(salt.len(), 32, "salt must be 32 bytes");
    let mut preimage = Vec::with_capacity(33);
    preimage.push(choice_byte(choice));
    preimage.extend_from_slice(salt);
    Sha256::digest(&preimage).to_vec()
}

fn bless() -> bool {
    std::env::var("BLESS_TEST_VECTORS").map(|v| v == "1" || v.eq("true")).unwrap_or(false)
}

#[test]
fn commitment_vectors_match_file() {
    let doc = load_vectors();
    let vectors = doc["commitment"].as_array().expect("commitment array");

    assert!(
        !vectors.is_empty(),
        "commitment.json must contain at least one vector"
    );

    // Edge salts must be present (#1643 acceptance criteria).
    let salts: Vec<&str> = vectors
        .iter()
        .map(|v| v["salt"].as_str().expect("salt"))
        .collect();
    assert!(
        salts.iter().any(|s| *s == "00".repeat(32).as_str()),
        "vectors must include an all-zero salt"
    );
    assert!(
        salts.iter().any(|s| *s == "ff".repeat(32).as_str()),
        "vectors must include an all-0xff salt"
    );

    for vector in vectors {
        let name = vector["name"].as_str().expect("name");
        let choice = vector["choice"].as_str().expect("choice");
        let choice_byte_json = vector["choiceByte"].as_u64().expect("choiceByte") as u8;
        assert_eq!(
            choice_byte_json,
            choice_byte(choice),
            "choiceByte disagrees with choice string in vector '{name}'"
        );

        let salt = hex_to_bytes(vector["salt"].as_str().expect("salt"));
        assert_eq!(salt.len(), 32, "vector '{name}' salt must be 32 bytes");

        let preimage_hex = vector["preimage"].as_str().expect("preimage");
        let commitment_hex = vector["commitment"].as_str().expect("commitment");

        let mut expected_preimage = Vec::with_capacity(33);
        expected_preimage.push(choice_byte(choice));
        expected_preimage.extend_from_slice(&salt);
        assert_eq!(
            bytes_to_hex(&expected_preimage),
            preimage_hex,
            "preimage mismatch in vector '{name}'"
        );

        let computed = independent_commitment(choice, &salt);
        assert_eq!(
            bytes_to_hex(&computed),
            commitment_hex,
            "commitment hash mismatch in vector '{name}' — Rust and the checked-in file disagree"
        );
    }
}

#[test]
fn metadata_hash_vectors_match_file() {
    let doc = load_vectors();
    let vectors = doc["metadataHash"].as_array().expect("metadataHash array");
    assert!(!vectors.is_empty());

    for vector in vectors {
        let name = vector["name"].as_str().expect("name");
        let canonical = vector["canonical"].as_str().expect("canonical");
        let expected = vector["hash"].as_str().expect("hash");
        assert_ne!(
            expected, "REGENERATE_WITH_BLESS",
            "vector '{name}' was never blessed"
        );

        // Recompute from the canonical form — the JSON → canonical mapping is
        // asserted on the TS side; here we pin the hash of the canonical bytes.
        let computed = Sha256::digest(canonical.as_bytes());
        assert_eq!(
            bytes_to_hex(&computed),
            expected,
            "metadata hash mismatch in vector '{name}'"
        );
    }
}

#[test]
fn amount_encoding_vectors_match_file() {
    let doc = load_vectors();
    let vectors = doc["amountEncoding"].as_array().expect("amountEncoding array");
    assert!(!vectors.is_empty());

    for vector in vectors {
        let name = vector["name"].as_str().expect("name");
        let decimal = vector["decimal"].as_str().expect("decimal");
        let valid = vector["valid"].as_bool().expect("valid");
        let i128_json = vector["i128"].as_str();

        if valid {
            let expected = i128_json.unwrap_or_else(|| panic!("vector '{name}' needs i128"));
            let parsed: i128 = decimal.parse().unwrap_or_else(|_| {
                panic!("vector '{name}' marked valid but '{decimal}' is not an i128")
            });
            assert_eq!(parsed.to_string(), expected, "amount encoding mismatch in '{name}'");
        } else {
            assert!(
                decimal.parse::<i128>().is_err(),
                "vector '{name}' marked invalid but '{decimal}' parses as i128"
            );
        }
    }
}

/// `--bless` mode: recompute every hash and rewrite `commitment.json`.
/// Guarded so an accidental `BLESS_TEST_VECTORS=1` during a normal run still
/// verifies rather than silently rewriting.
#[test]
fn bless_vectors_when_requested() {
    if !bless() {
        return;
    }

    let path = vectors_path();
    let raw = fs::read_to_string(&path).expect("read commitment.json");
    let mut doc: serde_json::Value = serde_json::from_str(&raw).expect("parse commitment.json");

    for vector in doc["commitment"].as_array_mut().expect("commitment array") {
        let choice = vector["choice"].as_str().expect("choice").to_string();
        let salt = hex_to_bytes(vector["salt"].as_str().expect("salt"));

        let mut preimage = Vec::with_capacity(33);
        preimage.push(choice_byte(&choice));
        preimage.extend_from_slice(&salt);

        vector["preimage"] = serde_json::Value::String(bytes_to_hex(&preimage));
        vector["commitment"] =
            serde_json::Value::String(bytes_to_hex(&Sha256::digest(&preimage)));
    }

    for vector in doc["metadataHash"].as_array_mut().expect("metadataHash array") {
        let canonical = vector["canonical"].as_str().expect("canonical").to_string();
        vector["hash"] = serde_json::Value::String(bytes_to_hex(&Sha256::digest(canonical.as_bytes())));
    }

    let serialized = serde_json::to_string_pretty(&doc).expect("serialize");
    fs::write(&path, format!("{serialized}\n")).expect("write commitment.json");
    eprintln!("blessed {}", path.display());
}
