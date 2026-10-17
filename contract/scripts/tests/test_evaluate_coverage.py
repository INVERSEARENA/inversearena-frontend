#!/usr/bin/env python3
import json
import os
import sys
import tempfile
import unittest

# Add scripts directory to sys.path
sys.path.insert(0, os.path.abspath(os.path.join(os.path.dirname(__file__), "..")))

from evaluate_coverage import (
    assign_crate,
    parse_llvm_json,
    parse_lcov,
    evaluate_and_format,
    ratchet_thresholds,
    TARGET_CRATES,
)

class TestCoverageEvaluator(unittest.TestCase):
    def test_assign_crate(self):
        self.assertEqual(assign_crate("contract/arena/src/lib.rs"), "arena")
        self.assertEqual(assign_crate("C:\\repo\\contract\\factory\\src\\types.rs"), "factory")
        self.assertEqual(assign_crate("contract/payout/src/state.rs"), "payout")
        self.assertEqual(assign_crate("contract/staking/src/lib.rs"), "staking")
        self.assertEqual(assign_crate("contract/rwa-adapter/src/vault.rs"), "rwa-adapter")

        # Ignored files (tests, fixtures, mocks)
        self.assertIsNone(assign_crate("contract/arena/src/tests.rs"))
        self.assertIsNone(assign_crate("contract/arena/src/integration_tests.rs"))
        self.assertIsNone(assign_crate("contract/arena/tests/smoke_test.rs"))
        self.assertIsNone(assign_crate("contract/factory/src/fixtures/mock.rs"))

    def test_evaluate_and_format_pass(self):
        baseline = {
            "thresholds": {
                "arena": {"minLinePercent": 70.0, "minBranchPercent": 50.0},
                "factory": {"minLinePercent": 70.0, "minBranchPercent": 50.0},
                "payout": {"minLinePercent": 70.0, "minBranchPercent": 50.0},
                "staking": {"minLinePercent": 70.0, "minBranchPercent": 50.0},
                "rwa-adapter": {"minLinePercent": 60.0, "minBranchPercent": 40.0},
            },
            "global": {"minLinePercent": 65.0, "minBranchPercent": 45.0}
        }

        stats = {
            "arena": {"lines_total": 100, "lines_covered": 85, "branches_total": 40, "branches_covered": 30},
            "factory": {"lines_total": 100, "lines_covered": 80, "branches_total": 40, "branches_covered": 25},
            "payout": {"lines_total": 100, "lines_covered": 75, "branches_total": 40, "branches_covered": 25},
            "staking": {"lines_total": 100, "lines_covered": 90, "branches_total": 40, "branches_covered": 35},
            "rwa-adapter": {"lines_total": 100, "lines_covered": 70, "branches_total": 40, "branches_covered": 20},
        }

        all_pass, markdown, rows = evaluate_and_format(stats, baseline)
        self.assertTrue(all_pass)
        self.assertIn("ALL THRESHOLDS MET", markdown)
        self.assertIn("✅ Pass", markdown)
        self.assertEqual(len(rows), 5)

    def test_evaluate_and_format_regression_fails(self):
        baseline = {
            "thresholds": {
                "arena": {"minLinePercent": 80.0, "minBranchPercent": 60.0},
                "factory": {"minLinePercent": 70.0, "minBranchPercent": 50.0},
                "payout": {"minLinePercent": 70.0, "minBranchPercent": 50.0},
                "staking": {"minLinePercent": 70.0, "minBranchPercent": 50.0},
                "rwa-adapter": {"minLinePercent": 60.0, "minBranchPercent": 40.0},
            },
            "global": {"minLinePercent": 65.0, "minBranchPercent": 45.0}
        }

        # Arena line coverage is only 60%, below 80% threshold
        stats = {
            "arena": {"lines_total": 100, "lines_covered": 60, "branches_total": 40, "branches_covered": 30},
            "factory": {"lines_total": 100, "lines_covered": 80, "branches_total": 40, "branches_covered": 25},
            "payout": {"lines_total": 100, "lines_covered": 75, "branches_total": 40, "branches_covered": 25},
            "staking": {"lines_total": 100, "lines_covered": 90, "branches_total": 40, "branches_covered": 35},
            "rwa-adapter": {"lines_total": 100, "lines_covered": 70, "branches_total": 40, "branches_covered": 20},
        }

        all_pass, markdown, rows = evaluate_and_format(stats, baseline)
        self.assertFalse(all_pass)
        self.assertIn("COVERAGE REGRESSION DETECTED", markdown)
        self.assertIn("❌ Regressed", markdown)

    def test_parse_llvm_json(self):
        sample_llvm_json = {
            "version": "2.0.1",
            "data": [
                {
                    "files": [
                        {
                            "filename": "contract/arena/src/lib.rs",
                            "summary": {
                                "lines": {"count": 200, "covered": 180},
                                "branches": {"count": 50, "covered": 40}
                            }
                        },
                        {
                            "filename": "contract/factory/src/lib.rs",
                            "summary": {
                                "lines": {"count": 150, "covered": 120},
                                "branches": {"count": 30, "covered": 20}
                            }
                        },
                        {
                            "filename": "contract/arena/tests/should_ignore.rs",
                            "summary": {
                                "lines": {"count": 100, "covered": 100},
                                "branches": {"count": 20, "covered": 20}
                            }
                        }
                    ]
                }
            ]
        }

        with tempfile.NamedTemporaryFile("w", delete=False, suffix=".json") as f:
            json.dump(sample_llvm_json, f)
            temp_path = f.name

        try:
            stats = parse_llvm_json(temp_path)
            self.assertEqual(stats["arena"]["lines_total"], 200)
            self.assertEqual(stats["arena"]["lines_covered"], 180)
            self.assertEqual(stats["factory"]["lines_total"], 150)
            self.assertEqual(stats["factory"]["lines_covered"], 120)
            # Ignored test file did not pollute arena stats
            self.assertNotEqual(stats["arena"]["lines_total"], 300)
        finally:
            if os.path.exists(temp_path):
                os.remove(temp_path)

    def test_ratchet_thresholds(self):
        initial_baseline = {
            "version": 1,
            "thresholds": {
                "arena": {"minLinePercent": 60.0, "minBranchPercent": 40.0}
            }
        }

        with tempfile.NamedTemporaryFile("w", delete=False, suffix=".json") as f:
            json.dump(initial_baseline, f)
            temp_path = f.name

        rows = [
            {"crate": "arena", "line_pct": 82.5, "branch_pct": 65.0}
        ]

        try:
            ratchet_thresholds(temp_path, rows)
            with open(temp_path, "r", encoding="utf-8") as f:
                updated = json.load(f)
            # Ratchet should adjust minLinePercent up from 60.0 to 81.5
            self.assertGreater(updated["thresholds"]["arena"]["minLinePercent"], 80.0)
            self.assertGreater(updated["thresholds"]["arena"]["minBranchPercent"], 60.0)
        finally:
            if os.path.exists(temp_path):
                os.remove(temp_path)

if __name__ == "__main__":
    unittest.main()
