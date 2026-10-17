import json
import os
import tempfile
import unittest
from unittest.mock import patch

from contract.scripts.evaluate_resource_costs import (
    DEFAULT_MAX_REGRESSION_PERCENT,
    REQUIRED_ENTRYPOINTS,
    bless_baseline,
    calculate_delta,
    evaluate_metrics,
    format_delta_str,
    generate_markdown_report,
    load_baseline,
    parse_benchmark_output,
)

SAMPLE_BENCHMARK_OUTPUT = """
running 2 tests
test resource_benchmarks::benchmark_arena_resource_costs ...
[RESOURCE_BENCHMARK] {"entrypoint":"join","instructions":150000,"read_entries":4,"write_entries":3,"read_bytes":1200,"write_bytes":900}
[RESOURCE_BENCHMARK] {"entrypoint":"commit","instructions":130000,"read_entries":4,"write_entries":3,"read_bytes":1100,"write_bytes":800}
[RESOURCE_BENCHMARK] {"entrypoint":"reveal","instructions":145000,"read_entries":4,"write_entries":3,"read_bytes":1200,"write_bytes":850}
[RESOURCE_BENCHMARK] {"entrypoint":"resolve_10","instructions":850000,"read_entries":25,"write_entries":15,"read_bytes":5000,"write_bytes":3500}
[RESOURCE_BENCHMARK] {"entrypoint":"resolve_100","instructions":4500000,"read_entries":160,"write_entries":110,"read_bytes":32000,"write_bytes":25000}
[RESOURCE_BENCHMARK] {"entrypoint":"resolve_max","instructions":4500000,"read_entries":160,"write_entries":110,"read_bytes":32000,"write_bytes":25000}
[RESOURCE_BENCHMARK] {"entrypoint":"claim","instructions":170000,"read_entries":6,"write_entries":4,"read_bytes":1600,"write_bytes":1100}
[RESOURCE_BENCHMARK] {"entrypoint":"refund","instructions":140000,"read_entries":5,"write_entries":4,"read_bytes":1300,"write_bytes":950}
test resource_benchmarks::benchmark_staking_resource_costs ...
[RESOURCE_BENCHMARK] {"entrypoint":"stake","instructions":130000,"read_entries":5,"write_entries":4,"read_bytes":1200,"write_bytes":900}
[RESOURCE_BENCHMARK] {"entrypoint":"unstake","instructions":135000,"read_entries":5,"write_entries":4,"read_bytes":1250,"write_bytes":920}
test result: ok. 2 passed; 0 failed
"""


class TestEvaluateResourceCosts(unittest.TestCase):
    def test_parse_benchmark_output(self):
        parsed = parse_benchmark_output(SAMPLE_BENCHMARK_OUTPUT)
        self.assertEqual(len(parsed), 10)
        for ep in REQUIRED_ENTRYPOINTS:
            self.assertIn(ep, parsed)
            self.assertGreater(parsed[ep]["instructions"], 0)
            self.assertGreater(parsed[ep]["read_entries"], 0)
            self.assertGreater(parsed[ep]["write_entries"], 0)
            self.assertGreater(parsed[ep]["read_bytes"], 0)
            self.assertGreater(parsed[ep]["write_bytes"], 0)

    def test_calculate_delta(self):
        delta_val, pct = calculate_delta(110, 100)
        self.assertEqual(delta_val, 10)
        self.assertAlmostEqual(pct, 10.0)

        delta_val, pct = calculate_delta(90, 100)
        self.assertEqual(delta_val, -10)
        self.assertAlmostEqual(pct, -10.0)

        self.assertEqual(format_delta_str(10, 10.0), "+10 (+10.00%)")
        self.assertEqual(format_delta_str(-10, -10.0), "-10 (-10.00%)")

    def test_evaluate_passing_metrics(self):
        actual = parse_benchmark_output(SAMPLE_BENCHMARK_OUTPUT)
        baseline = {
            "defaultMaxAllowedRegressionPercent": 10.0,
            "entrypoints": {ep: dict(actual[ep]) for ep in actual},
        }
        success, rows, errors = evaluate_metrics(actual, baseline, 10.0)
        self.assertTrue(success)
        self.assertEqual(len(errors), 0)
        self.assertEqual(len(rows), 10)

    def test_evaluate_regression_fails(self):
        actual = parse_benchmark_output(SAMPLE_BENCHMARK_OUTPUT)
        # Regress join instructions by 20%
        actual["join"]["instructions"] = int(actual["join"]["instructions"] * 1.20)

        baseline = {
            "defaultMaxAllowedRegressionPercent": 10.0,
            "entrypoints": parse_benchmark_output(SAMPLE_BENCHMARK_OUTPUT),
        }
        success, rows, errors = evaluate_metrics(actual, baseline, 10.0)
        self.assertFalse(success)
        self.assertGreaterEqual(len(errors), 1)
        self.assertTrue(any("join" in err and "CPU Instructions" in err for err in errors))

    def test_evaluate_ledger_entries_regression_fails(self):
        actual = parse_benchmark_output(SAMPLE_BENCHMARK_OUTPUT)
        # Regress write_entries from 3 to 5 (66% regression)
        actual["commit"]["write_entries"] = 5

        baseline = {
            "defaultMaxAllowedRegressionPercent": 10.0,
            "entrypoints": parse_benchmark_output(SAMPLE_BENCHMARK_OUTPUT),
        }
        success, rows, errors = evaluate_metrics(actual, baseline, 10.0)
        self.assertFalse(success)
        self.assertTrue(any("commit" in err and "Write Entries" in err for err in errors))

    def test_missing_required_entrypoint(self):
        actual = parse_benchmark_output(SAMPLE_BENCHMARK_OUTPUT)
        del actual["unstake"]
        baseline = {
            "defaultMaxAllowedRegressionPercent": 10.0,
            "entrypoints": parse_benchmark_output(SAMPLE_BENCHMARK_OUTPUT),
        }
        success, rows, errors = evaluate_metrics(actual, baseline, 10.0)
        self.assertFalse(success)
        self.assertTrue(any("unstake" in err for err in errors))

    def test_bless_baseline(self):
        actual = parse_benchmark_output(SAMPLE_BENCHMARK_OUTPUT)
        with tempfile.NamedTemporaryFile(suffix=".json", delete=False) as tf:
            temp_path = tf.name

        try:
            bless_baseline(temp_path, actual, 10.0)
            loaded = load_baseline(temp_path)
            self.assertEqual(loaded["version"], 1)
            self.assertEqual(len(loaded["entrypoints"]), 10)
            for ep in REQUIRED_ENTRYPOINTS:
                self.assertIn(ep, loaded["entrypoints"])
                self.assertEqual(loaded["entrypoints"][ep]["instructions"], actual[ep]["instructions"])
                self.assertEqual(loaded["entrypoints"][ep]["maxAllowedRegressionPercent"], 10.0)
        finally:
            if os.path.exists(temp_path):
                os.remove(temp_path)

    def test_generate_markdown_report(self):
        actual = parse_benchmark_output(SAMPLE_BENCHMARK_OUTPUT)
        baseline = {
            "defaultMaxAllowedRegressionPercent": 10.0,
            "entrypoints": {ep: dict(actual[ep]) for ep in actual},
        }
        success, rows, errors = evaluate_metrics(actual, baseline, 10.0)
        report = generate_markdown_report(rows, "baseline.json", 10.0, success)
        self.assertIn("# 📊 Contract Resource Costs Benchmark Report", report)
        self.assertIn("`join`", report)
        self.assertIn("`stake`", report)
        self.assertIn("✅ Pass", report)


if __name__ == "__main__":
    unittest.main()
