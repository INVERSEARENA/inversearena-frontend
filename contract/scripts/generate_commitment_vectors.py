#!/usr/bin/env python3
"""
Generates and checks golden test vectors for commit-reveal hashing (#1643).

Preimage layout:
  [choice_byte] (1 byte: Heads=0, Tails=1) ++ salt (32 bytes)
Algorithm:
  SHA-256

Usage:
  python generate_commitment_vectors.py --check   # Check that vectors in commitment.json match
  python generate_commitment_vectors.py --bless   # Regenerate commitment.json with expected hashes
"""

import argparse
import hashlib
import json
import os
import sys
from pathlib import Path

CHOICE_MAP = {
    "Heads": 0,
    "Tails": 1,
}

RAW_VECTORS = [
    {
        "id": "heads_all_zeros",
        "description": "Heads choice (byte 0) with 32-byte all-zero salt (0x00 * 32)",
        "choice": "Heads",
        "salt": bytes([0x00] * 32),
    },
    {
        "id": "tails_all_zeros",
        "description": "Tails choice (byte 1) with 32-byte all-zero salt (0x00 * 32)",
        "choice": "Tails",
        "salt": bytes([0x00] * 32),
    },
    {
        "id": "heads_all_ones",
        "description": "Heads choice (byte 0) with 32-byte all-0xff salt (0xff * 32)",
        "choice": "Heads",
        "salt": bytes([0xff] * 32),
    },
    {
        "id": "tails_all_ones",
        "description": "Tails choice (byte 1) with 32-byte all-0xff salt (0xff * 32)",
        "choice": "Tails",
        "salt": bytes([0xff] * 32),
    },
    {
        "id": "heads_repeated_2a",
        "description": "Heads choice with repeated byte 0x2a salt (0x2a * 32)",
        "choice": "Heads",
        "salt": bytes([0x2a] * 32),
    },
    {
        "id": "tails_repeated_2a",
        "description": "Tails choice with repeated byte 0x2a salt (0x2a * 32)",
        "choice": "Tails",
        "salt": bytes([0x2a] * 32),
    },
    {
        "id": "heads_alternating_aa",
        "description": "Heads choice with alternating bits 0xaa (10101010) salt",
        "choice": "Heads",
        "salt": bytes([0xaa] * 32),
    },
    {
        "id": "tails_alternating_aa",
        "description": "Tails choice with alternating bits 0xaa (10101010) salt",
        "choice": "Tails",
        "salt": bytes([0xaa] * 32),
    },
    {
        "id": "heads_alternating_55",
        "description": "Heads choice with alternating bits 0x55 (01010101) salt",
        "choice": "Heads",
        "salt": bytes([0x55] * 32),
    },
    {
        "id": "tails_alternating_55",
        "description": "Tails choice with alternating bits 0x55 (01010101) salt",
        "choice": "Tails",
        "salt": bytes([0x55] * 32),
    },
    {
        "id": "heads_sequential_asc",
        "description": "Heads choice with ascending sequential bytes 0x00..0x1f",
        "choice": "Heads",
        "salt": bytes(range(32)),
    },
    {
        "id": "tails_sequential_asc",
        "description": "Tails choice with ascending sequential bytes 0x00..0x1f",
        "choice": "Tails",
        "salt": bytes(range(32)),
    },
    {
        "id": "heads_sequential_desc",
        "description": "Heads choice with descending sequential bytes 0x1f..0x00",
        "choice": "Heads",
        "salt": bytes(range(31, -1, -1)),
    },
    {
        "id": "tails_sequential_desc",
        "description": "Tails choice with descending sequential bytes 0x1f..0x00",
        "choice": "Tails",
        "salt": bytes(range(31, -1, -1)),
    },
    {
        "id": "heads_single_bit_msb",
        "description": "Heads choice with single MSB bit set in byte 0 (0x80 followed by 31 zeros)",
        "choice": "Heads",
        "salt": bytes([0x80] + [0x00] * 31),
    },
    {
        "id": "tails_single_bit_msb",
        "description": "Tails choice with single MSB bit set in byte 0 (0x80 followed by 31 zeros)",
        "choice": "Tails",
        "salt": bytes([0x80] + [0x00] * 31),
    },
    {
        "id": "heads_single_bit_lsb",
        "description": "Heads choice with single LSB bit set in byte 31 (31 zeros followed by 0x01)",
        "choice": "Heads",
        "salt": bytes([0x00] * 31 + [0x01]),
    },
    {
        "id": "tails_single_bit_lsb",
        "description": "Tails choice with single LSB bit set in byte 31 (31 zeros followed by 0x01)",
        "choice": "Tails",
        "salt": bytes([0x00] * 31 + [0x01]),
    },
    {
        "id": "heads_pseudorandom_pattern",
        "description": "Heads choice with fixed pseudorandom pattern salt",
        "choice": "Heads",
        "salt": bytes.fromhex("e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855"),
    },
    {
        "id": "tails_pseudorandom_pattern",
        "description": "Tails choice with fixed pseudorandom pattern salt",
        "choice": "Tails",
        "salt": bytes.fromhex("e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855"),
    },
]


def compute_hash(choice_byte: int, salt: bytes) -> str:
    preimage = bytes([choice_byte]) + salt
    return hashlib.sha256(preimage).hexdigest()


def generate_payload() -> dict:
    vectors = []
    for item in RAW_VECTORS:
        choice = item["choice"]
        choice_byte = CHOICE_MAP[choice]
        salt_bytes = item["salt"]
        expected_hash = compute_hash(choice_byte, salt_bytes)
        vectors.append({
            "id": item["id"],
            "description": item["description"],
            "choice": choice,
            "choiceByte": choice_byte,
            "salt": salt_bytes.hex(),
            "expectedHash": expected_hash,
        })

    return {
        "version": "1.0.0",
        "description": "Golden test vectors for commit-reveal hashing (SHA256([choice_byte] ++ salt)) shared between Soroban contract (Rust) and frontend client (TypeScript).",
        "hashAlgorithm": "SHA-256",
        "preimageFormat": "choice_byte (1 byte: Heads=0, Tails=1) ++ salt (32 bytes)",
        "vectors": vectors,
    }


def find_target_file() -> Path:
    script_dir = Path(__file__).resolve().parent
    # Check script_dir/../test-vectors/commitment.json
    candidates = [
        script_dir.parent / "test-vectors" / "commitment.json",
        Path.cwd() / "contract" / "test-vectors" / "commitment.json",
        Path.cwd() / "test-vectors" / "commitment.json",
    ]
    for c in candidates:
        if c.parent.exists():
            return c
    # Default to script_dir.parent / "test-vectors" / "commitment.json"
    default_path = script_dir.parent / "test-vectors" / "commitment.json"
    default_path.parent.mkdir(parents=True, exist_ok=True)
    return default_path


def main():
    parser = argparse.ArgumentParser(description="Golden test vectors generator and checker.")
    parser.add_argument("--bless", action="store_true", help="Regenerate/update commitment.json with expected hashes")
    parser.add_argument("--check", action="store_true", help="Check that commitment.json matches expected hashes")
    args = parser.parse_args()

    target_file = find_target_file()
    payload = generate_payload()
    payload_json = json.dumps(payload, indent=2) + "\n"

    if args.bless or (not args.check and not target_file.exists()):
        target_file.parent.mkdir(parents=True, exist_ok=True)
        target_file.write_text(payload_json, encoding="utf-8")
        print(f"Successfully blessed {len(payload['vectors'])} test vectors to {target_file}")
        return 0

    if args.check:
        if not target_file.exists():
            print(f"Error: {target_file} does not exist. Run with --bless first.", file=sys.stderr)
            return 1

        existing_text = target_file.read_text(encoding="utf-8")
        try:
            existing_data = json.loads(existing_text)
        except Exception as e:
            print(f"Error parsing existing JSON: {e}", file=sys.stderr)
            return 1

        existing_vectors = existing_data.get("vectors", [])
        expected_vectors = payload["vectors"]

        if len(existing_vectors) != len(expected_vectors):
            print(f"Mismatch: existing vector count {len(existing_vectors)} != expected {len(expected_vectors)}", file=sys.stderr)
            return 1

        for i, (exp, act) in enumerate(zip(expected_vectors, existing_vectors)):
            if exp["id"] != act.get("id"):
                print(f"Mismatch at index {i}: id {act.get('id')} != expected {exp['id']}", file=sys.stderr)
                return 1
            if exp["expectedHash"] != act.get("expectedHash"):
                print(f"Hash mismatch for {exp['id']}: actual {act.get('expectedHash')} != expected {exp['expectedHash']}", file=sys.stderr)
                return 1

        print(f"OK: All {len(existing_vectors)} test vectors match.")
        return 0

    print("Please specify --bless or --check")
    return 1


if __name__ == "__main__":
    sys.exit(main())
