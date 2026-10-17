#!/usr/bin/env python3
"""
evaluate_coverage.py - Evaluates smart contract coverage against ratcheted thresholds.

Acceptance criteria addressed (#1651):
- Parses cargo-llvm-cov export JSON (or LCOV fallback).
- Groups metrics per contract crate: arena, factory, payout, staking, rwa-adapter.
- Enforces line and branch minimum coverage thresholds.
- Produces markdown summary for $GITHUB_STEP_SUMMARY and CI artifacts.
- Supports ratcheting thresholds when coverage increases.
"""

import argparse
import json
import os
import re
import sys
from datetime import datetime, timezone
from typing import Dict, Any, Tuple, List, Optional

TARGET_CRATES = ["arena", "factory", "payout", "staking", "rwa-adapter"]

def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Evaluate contract test coverage against thresholds")
    parser.add_argument("--coverage", required=True, help="Path to coverage JSON or LCOV file")
    parser.add_argument("--baseline", required=True, help="Path to baseline-coverage.json")
    parser.add_argument("--output-markdown", default=None, help="Path to write markdown summary table")
    parser.add_argument("--ratchet", action="store_true", help="Ratchet thresholds upward if current coverage exceeds baseline")
    return parser.parse_args()

def assign_crate(filename: str) -> Optional[str]:
    # Normalize slashes
    norm = filename.replace("\\", "/")
    # Filter out test-only modules or external fixtures if not filtered by regex
    if any(pat in norm for pat in ["/tests/", "/fixtures/", "/test/", "test_", "_test.rs", "tests.rs"]):
        return None
    for crate in TARGET_CRATES + ["fee-router", "oracle"]:
        # Match crate folder boundary e.g. /arena/src/ or contract/arena/
        if f"/{crate}/" in norm or norm.startswith(f"{crate}/"):
            return crate
    return None

def parse_llvm_json(filepath: str) -> Dict[str, Dict[str, int]]:
    with open(filepath, "r", encoding="utf-8") as f:
        data = json.load(f)

    crate_stats = {
        crate: {"lines_total": 0, "lines_covered": 0, "branches_total": 0, "branches_covered": 0}
        for crate in TARGET_CRATES
    }

    files = []
    # LLVM coverage json export has structure: data -> [ { files: [...] } ]
    if "data" in data and isinstance(data["data"], list):
        for entry in data["data"]:
            files.extend(entry.get("files", []))
    elif "files" in data:
        files = data["files"]

    for file_obj in files:
        fname = file_obj.get("filename", "")
        crate = assign_crate(fname)
        if not crate or crate not in crate_stats:
            continue

        summary = file_obj.get("summary", {})
        lines = summary.get("lines", {})
        branches = summary.get("branches", {})

        crate_stats[crate]["lines_total"] += lines.get("count", 0)
        crate_stats[crate]["lines_covered"] += lines.get("covered", 0)
        crate_stats[crate]["branches_total"] += branches.get("count", 0)
        crate_stats[crate]["branches_covered"] += branches.get("covered", 0)

    return crate_stats

def parse_lcov(filepath: str) -> Dict[str, Dict[str, int]]:
    crate_stats = {
        crate: {"lines_total": 0, "lines_covered": 0, "branches_total": 0, "branches_covered": 0}
        for crate in TARGET_CRATES
    }

    current_crate = None
    with open(filepath, "r", encoding="utf-8") as f:
        for line in f:
            line = line.strip()
            if line.startswith("SF:"):
                fname = line[3:]
                current_crate = assign_crate(fname)
            elif current_crate and current_crate in crate_stats:
                if line.startswith("LF:"):
                    crate_stats[current_crate]["lines_total"] += int(line[3:])
                elif line.startswith("LH:"):
                    crate_stats[current_crate]["lines_covered"] += int(line[3:])
                elif line.startswith("BRF:"):
                    crate_stats[current_crate]["branches_total"] += int(line[4:])
                elif line.startswith("BRH:"):
                    crate_stats[current_crate]["branches_covered"] += int(line[4:])

    return crate_stats

def compute_percentages(stats: Dict[str, int]) -> Tuple[float, float]:
    lines_total = stats.get("lines_total", 0)
    lines_cov = stats.get("lines_covered", 0)
    line_pct = (lines_cov / lines_total * 100.0) if lines_total > 0 else 100.0

    branches_total = stats.get("branches_total", 0)
    branches_cov = stats.get("branches_covered", 0)
    branch_pct = (branches_cov / branches_total * 100.0) if branches_total > 0 else 100.0

    return round(line_pct, 2), round(branch_pct, 2)

def evaluate_and_format(
    crate_stats: Dict[str, Dict[str, int]],
    baseline_data: Dict[str, Any]
) -> Tuple[bool, str, List[Dict[str, Any]]]:
    thresholds = baseline_data.get("thresholds", {})
    all_pass = True
    rows = []

    total_lines = 0
    total_lines_cov = 0
    total_branches = 0
    total_branches_cov = 0

    for crate in TARGET_CRATES:
        stats = crate_stats.get(crate, {"lines_total": 0, "lines_covered": 0, "branches_total": 0, "branches_covered": 0})
        line_pct, branch_pct = compute_percentages(stats)

        total_lines += stats["lines_total"]
        total_lines_cov += stats["lines_covered"]
        total_branches += stats["branches_total"]
        total_branches_cov += stats["branches_covered"]

        crate_thresh = thresholds.get(crate, {})
        min_line = crate_thresh.get("minLinePercent", 70.0)
        min_branch = crate_thresh.get("minBranchPercent", 50.0)

        line_pass = line_pct >= min_line
        branch_pass = branch_pct >= min_branch
        crate_pass = line_pass and branch_pass

        if not crate_pass:
            all_pass = False

        status = "✅ Pass" if crate_pass else "❌ Regressed"

        rows.append({
            "crate": crate,
            "lines": f"{stats['lines_covered']}/{stats['lines_total']}",
            "line_pct": line_pct,
            "min_line": min_line,
            "branches": f"{stats['branches_covered']}/{stats['branches_total']}",
            "branch_pct": branch_pct,
            "min_branch": min_branch,
            "pass": crate_pass,
            "status": status,
        })

    # Global total
    global_line_pct = round((total_lines_cov / total_lines * 100.0) if total_lines > 0 else 100.0, 2)
    global_branch_pct = round((total_branches_cov / total_branches * 100.0) if total_branches > 0 else 100.0, 2)
    global_min_line = baseline_data.get("global", {}).get("minLinePercent", 70.0)
    global_min_branch = baseline_data.get("global", {}).get("minBranchPercent", 50.0)

    global_pass = (global_line_pct >= global_min_line) and (global_branch_pct >= global_min_branch)
    if not global_pass:
        all_pass = False

    # Generate Markdown Table
    md = []
    md.append("# 📊 Smart Contract Test Coverage Report (#1651)")
    md.append("")
    md.append(f"**Overall Status**: {'✅ **ALL THRESHOLDS MET**' if all_pass else '❌ **COVERAGE REGRESSION DETECTED**'}")
    md.append("")
    md.append("| Contract Crate | Lines Covered | Line % | Min Line % | Branches Covered | Branch % | Min Branch % | Status |")
    md.append("| :--- | :---: | :---: | :---: | :---: | :---: | :---: | :---: |")

    for r in rows:
        md.append(
            f"| `{r['crate']}` | {r['lines']} | **{r['line_pct']}%** | {r['min_line']}% | "
            f"{r['branches']} | **{r['branch_pct']}%** | {r['min_branch']}% | {r['status']} |"
        )

    md.append(
        f"| **WORKSPACE TOTAL** | **{total_lines_cov}/{total_lines}** | **{global_line_pct}%** | {global_min_line}% | "
        f"**{total_branches_cov}/{total_branches}** | **{global_branch_pct}%** | {global_min_branch}% | "
        f"{'✅ Pass' if global_pass else '❌ Fail'} |"
    )
    md.append("")
    md.append("> Generated automatically by `cargo llvm-cov` and `evaluate_coverage.py` in Contract CI.")

    markdown_content = "\n".join(md)
    return all_pass, markdown_content, rows

def ratchet_thresholds(baseline_path: str, rows: List[Dict[str, Any]]):
    with open(baseline_path, "r", encoding="utf-8") as f:
        data = json.load(f)

    thresholds = data.setdefault("thresholds", {})
    ratcheted_count = 0

    for r in rows:
        crate = r["crate"]
        crate_t = thresholds.setdefault(crate, {})
        # Only ratchet if significantly higher (> 1% delta) and round to integer
        curr_line = r["line_pct"]
        if curr_line > crate_t.get("minLinePercent", 0) + 1.0:
            crate_t["minLinePercent"] = round(curr_line - 1.0, 1)
            ratcheted_count += 1

        curr_branch = r["branch_pct"]
        if curr_branch > crate_t.get("minBranchPercent", 0) + 1.0:
            crate_t["minBranchPercent"] = round(curr_branch - 1.0, 1)
            ratcheted_count += 1

    if ratcheted_count > 0:
        data["updatedAt"] = datetime.now(timezone.utc).isoformat()
        with open(baseline_path, "w", encoding="utf-8") as f:
            json.dump(data, f, indent=2)
        print(f"Ratcheted {ratcheted_count} threshold(s) in {baseline_path}")

def main():
    args = parse_args()

    if not os.path.exists(args.coverage):
        print(f"Error: Coverage file not found at {args.coverage}", file=sys.stderr)
        sys.exit(1)

    if not os.path.exists(args.baseline):
        print(f"Error: Baseline file not found at {args.baseline}", file=sys.stderr)
        sys.exit(1)

    with open(args.baseline, "r", encoding="utf-8") as f:
        baseline_data = json.load(f)

    # Determine parser
    if args.coverage.endswith(".json"):
        stats = parse_llvm_json(args.coverage)
    else:
        stats = parse_lcov(args.coverage)

    all_pass, markdown, rows = evaluate_and_format(stats, baseline_data)

    print(markdown)

    if args.output_markdown:
        os.makedirs(os.path.dirname(os.path.abspath(args.output_markdown)), exist_ok=True)
        with open(args.output_markdown, "w", encoding="utf-8") as f:
            f.write(markdown)
        print(f"\nWrote coverage report to {args.output_markdown}")

    step_summary_path = os.environ.get("GITHUB_STEP_SUMMARY")
    if step_summary_path:
        with open(step_summary_path, "a", encoding="utf-8") as f:
            f.write("\n" + markdown + "\n")
        print("Exported coverage table to $GITHUB_STEP_SUMMARY")

    if args.ratchet and all_pass:
        ratchet_thresholds(args.baseline, rows)

    if not all_pass:
        print("\n❌ CI FAILURE: Contract coverage fell below ratcheted thresholds!", file=sys.stderr)
        sys.exit(1)

    print("\n✅ All contract coverage thresholds met!")

if __name__ == "__main__":
    main()
