#!/usr/bin/env bash

# Check that no inline test module in contract lib.rs exceeds 100 lines
# Acceptance criterion for issue: Extract inline tests from contracts

set -euo pipefail

THRESHOLD=100
FAILED=0

for lib_file in contract/*/src/lib.rs; do
  crate=$(basename $(dirname $(dirname "$lib_file")))
  
  # Skip test-support and other non-contract crates
  if [[ "$crate" == "test-support" ]] || [[ "$crate" == "cost-bench" ]] || [[ "$crate" == "interfaces" ]] || [[ "$crate" == "fixtures" ]] || [[ "$crate" == "test-vectors" ]] || [[ "$crate" == "docs" ]] || [[ "$crate" == "scripts" ]]; then
    continue
  fi
  
  # Look for inline test modules: #[cfg(test)] mod test { ... }
  # Extract lines between "mod test {" and the closing "}"
  if grep -q "^mod test {" "$lib_file"; then
    # Count lines in the test module
    test_start=$(grep -n "^mod test {" "$lib_file" | head -1 | cut -d: -f1)
    
    if [ -n "$test_start" ]; then
      # Find the corresponding closing brace
      tail_lines=$(($(wc -l < "$lib_file") - test_start + 1))
      test_module=$(tail -n $tail_lines "$lib_file")
      
      # Count lines until the first closing brace at column 0
      test_lines=$(echo "$test_module" | grep -n "^}" | head -1 | cut -d: -f1)
      test_lines=$((test_lines - 1))  # Don't count the closing brace itself
      
      if [ $test_lines -gt $THRESHOLD ]; then
        echo "❌ $crate: inline test module has $test_lines lines (exceeds $THRESHOLD line limit)"
        FAILED=$((FAILED + 1))
      else
        echo "✓ $crate: inline test module has $test_lines lines"
      fi
    fi
  else
    echo "✓ $crate: no inline test module"
  fi
done

if [ $FAILED -gt 0 ]; then
  echo ""
  echo "❌ $FAILED crate(s) have inline test modules exceeding $THRESHOLD lines"
  exit 1
else
  echo ""
  echo "✅ All inline test modules comply with the $THRESHOLD line limit"
  exit 0
fi
