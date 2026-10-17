#!/usr/bin/env python3
"""
Evaluate contract resource costs against committed baseline.
Enforces regression thresholds (#1649) and generates GitHub Step Summary tables.
"""

import argparse
import json
import os
import re
import sys
from datetime import datetime, timezone
from typing import Any, Dict, List, Optional, Tuple

if hasattr(sys.stdout, "reconfigure"):
    try:
        sys.stdout.reconfigure(encoding="utf-8")
    except Exception:
        pass
if hasattr(sys.stderr, "reconfigure"):
    try:
        sys.stderr.reconfigure(encoding="utf-8")
    except Exception:
        pass

DEFAULT_MAX_REGRESSION_PERCENT = 10.0

REQUIRED_ENTRYPOINTS = [
    "join",
    "commit",
    "reveal",
    "resolve_10",
    "resolve_100",
    "resolve_max",
    "claim",
    "refund",
    "stake",
    "unstake",
]
METRIC_KEYS = [
    ("instructions", "CPU Instructions"),
    ("read_entries", "Read Entries"),
    ("write_entries", "Write Entries"),
    ("read_bytes", "Read Bytes"),
    ("write_bytes", "Write Bytes"),
]

BENCHMARK_LINE_RE = re.compile(r"\[RESOURCE_BENCHMARK\]\s*(\{.*\})")


def parse_benchmark_output(text: str) -> Dict[str, Dict[str, Any]]:
    """
    Parse [RESOURCE_BENCHMARK] JSON lines from test output or a raw JSON payload.
    """
    entrypoints: Dict[str, Dict[str, Any]] = {}
    stripped = text.strip()

    # If the whole input is a JSON document
    if stripped.startswith("{") and "entrypoints" in stripped:
        try:
            data = json.loads(stripped)
            if "entrypoints" in data and isinstance(data["entrypoints"], dict):
                return data["entrypoints"]
        except json.JSONDecodeError:
            pass

    for line in text.splitlines():
        match = BENCHMARK_LINE_RE.search(line)
        if match:
            json_str = match.group(1)
            try:
                data = json.loads(json_str)
                name = data.get("entrypoint")
                if name:
                    entrypoints[name] = {
                        "instructions": int(data.get("instructions", 0)),
                        "read_entries": int(data.get("read_entries", 0)),
                        "write_entries": int(data.get("write_entries", 0)),
                        "read_bytes": int(data.get("read_bytes", 0)),
                        "write_bytes": int(data.get("write_bytes", 0)),
                    }
            except (json.JSONDecodeError, ValueError) as err:
                print(f"Warning: Failed to parse benchmark line '{line}': {err}", file=sys.stderr)

    return entrypoints


def load_baseline(baseline_path: str) -> Dict[str, Any]:
    default_structure = {
        "version": 1,
        "updatedAt": datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"),
        "defaultMaxAllowedRegressionPercent": DEFAULT_MAX_REGRESSION_PERCENT,
        "entrypoints": {},
    }
    if not os.path.exists(baseline_path) or os.path.getsize(baseline_path) == 0:
        return default_structure
    with open(baseline_path, "r", encoding="utf-8") as f:
        try:
            return json.load(f)
        except json.JSONDecodeError:
            return default_structure


def calculate_delta(current: int, baseline: int) -> Tuple[int, float]:
    delta_val = current - baseline
    if baseline == 0:
        pct = 0.0 if current == 0 else 100.0
    else:
        pct = (delta_val / baseline) * 100.0
    return delta_val, pct


def format_delta_str(delta_val: int, pct: float) -> str:
    sign = "+" if delta_val > 0 else ""
    return f"{sign}{delta_val:,} ({sign}{pct:.2f}%)"


def evaluate_metrics(
    actual: Dict[str, Dict[str, Any]],
    baseline: Dict[str, Any],
    default_threshold: float,
) -> Tuple[bool, List[Dict[str, Any]], List[str]]:
    """
    Evaluate actual metrics against baseline.
    Returns (success, comparison_rows, errors).
    """
    success = True
    rows: List[Dict[str, Any]] = []
    errors: List[str] = []

    baseline_entries = baseline.get("entrypoints", {})

    for ep in REQUIRED_ENTRYPOINTS:
        if ep not in actual:
            success = False
            errors.append(f"Missing benchmark measurements for required entrypoint: '{ep}'")
            continue

        act_ep = actual[ep]
        base_ep = baseline_entries.get(ep, {})
        allowed_pct = float(
            base_ep.get("maxAllowedRegressionPercent")
            or baseline.get("defaultMaxAllowedRegressionPercent")
            or default_threshold
        )

        ep_has_regression = False
        metrics_summary = {}

        for key, label in METRIC_KEYS:
            cur_val = int(act_ep.get(key, 0))
            base_val = int(base_ep.get(key, cur_val))
            delta_val, pct = calculate_delta(cur_val, base_val)

            is_regressed = pct > allowed_pct
            if is_regressed:
                ep_has_regression = True
                success = False
                errors.append(
                    f"Regression in '{ep}' -> {label}: current={cur_val:,}, baseline={base_val:,}, "
                    f"delta={format_delta_str(delta_val, pct)} exceeds allowed {allowed_pct:.1f}%"
                )

            metrics_summary[key] = {
                "label": label,
                "current": cur_val,
                "baseline": base_val,
                "delta": delta_val,
                "pct": pct,
                "regressed": is_regressed,
            }

        rows.append({
            "entrypoint": ep,
            "allowed_pct": allowed_pct,
            "has_regression": ep_has_regression,
            "metrics": metrics_summary,
        })

    return success, rows, errors


def generate_markdown_report(
    rows: List[Dict[str, Any]],
    baseline_path: str,
    default_threshold: float,
    all_passed: bool,
) -> str:
    lines = [
        "# 📊 Contract Resource Costs Benchmark Report",
        "",
        f"- **Baseline File**: `{baseline_path}`",
        f"- **Default Regression Threshold**: `{default_threshold:.1f}%`",
        f"- **Overall Status**: {'✅ All Entrypoints Within Budget' if all_passed else '❌ Regressions Detected'}",
        "",
        "| Entrypoint | CPU Instructions (Base / Cur / Δ) | Ledger Reads | Ledger Writes | Read Bytes | Write Bytes | Status |",
        "| :--- | :--- | :---: | :---: | :---: | :---: | :---: |",
    ]

    for row in rows:
        ep = f"`{row['entrypoint']}`"
        m = row["metrics"]
        inst = m["instructions"]
        reads = m["read_entries"]
        writes = m["write_entries"]
        rbytes = m["read_bytes"]
        wbytes = m["write_bytes"]

        inst_str = f"{inst['baseline']:,} / {inst['current']:,} ({format_delta_str(inst['delta'], inst['pct'])})"
        reads_str = f"{reads['baseline']} → {reads['current']}"
        writes_str = f"{writes['baseline']} → {writes['current']}"
        rbytes_str = f"{rbytes['baseline']:,} → {rbytes['current']:,}"
        wbytes_str = f"{wbytes['baseline']:,} → {wbytes['current']:,}"

        status = "✅ Pass"
        if row["has_regression"]:
            regressed_labels = [
                v["label"] for v in m.values() if v["regressed"]
            ]
            status = f"❌ Regressed ({', '.join(regressed_labels)})"

        lines.append(
            f"| {ep} | {inst_str} | {reads_str} | {writes_str} | {rbytes_str} | {wbytes_str} | {status} |"
        )

    lines.append("")
    lines.append("### Detailed Metric Breakdown")
    lines.append("")
    lines.append("| Entrypoint | Metric | Baseline | Current | Delta | Max Allowed | Status |")
    lines.append("| :--- | :--- | :---: | :---: | :---: | :---: | :---: |")

    for row in rows:
        for key, label in METRIC_KEYS:
            info = row["metrics"][key]
            delta_str = format_delta_str(info["delta"], info["pct"])
            stat = "❌ Regressed" if info["regressed"] else "✅ Pass"
            lines.append(
                f"| `{row['entrypoint']}` | {label} | {info['baseline']:,} | {info['current']:,} | {delta_str} | {row['allowed_pct']:.1f}% | {stat} |"
            )

    lines.append("")
    return "\n".join(lines)


def bless_baseline(
    baseline_path: str,
    actual: Dict[str, Dict[str, Any]],
    default_threshold: float,
) -> None:
    current_baseline = load_baseline(baseline_path)
    current_entries = current_baseline.get("entrypoints", {})

    new_entries: Dict[str, Any] = {}
    for ep in REQUIRED_ENTRYPOINTS:
        if ep in actual:
            act = actual[ep]
            existing = current_entries.get(ep, {})
            allowed = existing.get("maxAllowedRegressionPercent", default_threshold)
            new_entries[ep] = {
                "instructions": act["instructions"],
                "read_entries": act["read_entries"],
                "write_entries": act["write_entries"],
                "read_bytes": act["read_bytes"],
                "write_bytes": act["write_bytes"],
                "maxAllowedRegressionPercent": allowed,
            }
        elif ep in current_entries:
            new_entries[ep] = current_entries[ep]

    updated_data = {
        "version": current_baseline.get("version", 1),
        "updatedAt": datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"),
        "defaultMaxAllowedRegressionPercent": current_baseline.get(
            "defaultMaxAllowedRegressionPercent", default_threshold
        ),
        "entrypoints": new_entries,
    }

    os.makedirs(os.path.dirname(os.path.abspath(baseline_path)), exist_ok=True)
    with open(baseline_path, "w", encoding="utf-8") as f:
        json.dump(updated_data, f, indent=2)
        f.write("\n")

    print(f"Successfully blessed baseline resource costs: '{baseline_path}'")


def main() -> int:
    parser = argparse.ArgumentParser(description="Evaluate contract resource cost benchmarks.")
    parser.add_argument("--baseline", default="baseline-resource-costs.json", help="Path to baseline JSON file")
    parser.add_argument("--input", default=None, help="Path to benchmark test output file (or stdin if omitted)")
    parser.add_argument("--markdown-output", default=None, help="Path to save markdown report")
    parser.add_argument("--json-output", default=None, help="Path to save current metrics JSON")
    parser.add_argument("--bless", action="store_true", help="Update baseline with current benchmark numbers")
    parser.add_argument("--threshold", type=float, default=DEFAULT_MAX_REGRESSION_PERCENT, help="Default max regression percent")

    args = parser.parse_args()

    # Read input text
    if args.input:
        with open(args.input, "r", encoding="utf-8") as f:
            raw_text = f.read()
    else:
        raw_text = sys.stdin.read()

    actual = parse_benchmark_output(raw_text)
    if not actual:
        print("Error: No benchmark metrics found in input.", file=sys.stderr)
        return 1

    baseline = load_baseline(args.baseline)
    threshold = float(baseline.get("defaultMaxAllowedRegressionPercent", args.threshold))

    # Save JSON metrics if requested
    if args.json_output:
        os.makedirs(os.path.dirname(os.path.abspath(args.json_output)), exist_ok=True)
        with open(args.json_output, "w", encoding="utf-8") as f:
            json.dump({
                "timestamp": datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"),
                "entrypoints": actual,
            }, f, indent=2)
            f.write("\n")

    if args.bless:
        bless_baseline(args.baseline, actual, threshold)
        return 0

    success, rows, errors = evaluate_metrics(actual, baseline, threshold)
    report_md = generate_markdown_report(rows, args.baseline, threshold, success)

    if args.markdown_output:
        os.makedirs(os.path.dirname(os.path.abspath(args.markdown_output)), exist_ok=True)
        with open(args.markdown_output, "w", encoding="utf-8") as f:
            f.write(report_md)

    # Post to GitHub Step Summary if available in CI environment
    gh_step_summary = os.environ.get("GITHUB_STEP_SUMMARY")
    if gh_step_summary:
        try:
            with open(gh_step_summary, "a", encoding="utf-8") as f:
                f.write(report_md + "\n")
        except OSError as err:
            print(f"Warning: Could not write to GITHUB_STEP_SUMMARY: {err}", file=sys.stderr)

    print(report_md)

    if not success:
        print("\n❌ Contract resource costs check failed with regressions:\n", file=sys.stderr)
        for err in errors:
            print(f"  - {err}", file=sys.stderr)
        return 1

    print("\n✅ Contract resource costs check passed successfully!")
    return 0


if __name__ == "__main__":
    sys.exit(main())
