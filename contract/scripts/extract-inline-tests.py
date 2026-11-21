#!/usr/bin/env python3
"""Extract inline test modules from contract lib.rs files into separate test.rs modules."""

import re
import sys
from pathlib import Path

def extract_test_module(lib_file_path):
    """Extract the test module from a lib.rs file and return (test_content, remaining_lib)."""
    with open(lib_file_path, 'r') as f:
        content = f.read()
    
    # Find #[cfg(test)] mod test { ... }
    # Match the entire test module including cfg attributes
    pattern = r'#\[cfg\(test\)\]\s*(?:#\[cfg_attr\([^\)]*\)\]\s*)*mod test \{(?:[^{}]|{[^}]*})*\}'
    
    match = re.search(pattern, content, re.DOTALL)
    if not match:
        print(f"No test module found in {lib_file_path}")
        return None, content
    
    # Extract just the test content (remove the #[cfg(test)] and mod test { ... } wrapper)
    full_match = match.group(0)
    # Remove the leading attributes and "mod test {"
    test_start = full_match.find('mod test {') + len('mod test {')
    # Remove the trailing }
    test_content = full_match[test_start:-1].strip()
    
    # Remove the matched part from the content
    remaining = content[:match.start()] + '\n#[cfg(test)]\n#[cfg_attr(coverage_nightly, coverage(off))]\nmod test;\n' + content[match.end():]
    
    # Add use super::* to test content if not present
    if 'use super::*;' not in test_content:
        test_content = 'use super::*;\n\n' + test_content
    
    return test_content, remaining

def main():
    if len(sys.argv) < 2:
        print("Usage: extract-inline-tests.py <contract_name>")
        print("Example: extract-inline-tests.py oracle")
        sys.exit(1)
    
    contract = sys.argv[1]
    lib_file = Path(f"contract/{contract}/src/lib.rs")
    test_file = Path(f"contract/{contract}/src/test.rs")
    
    if not lib_file.exists():
        print(f"Error: {lib_file} not found")
        sys.exit(1)
    
    test_content, remaining_lib = extract_test_module(str(lib_file))
    
    if test_content is None:
        sys.exit(1)
    
    # Write test.rs
    with open(test_file, 'w') as f:
        f.write(test_content)
    print(f"✓ Created {test_file} ({len(test_content.split(chr(10)))} lines)")
    
    # Write updated lib.rs
    with open(lib_file, 'w') as f:
        f.write(remaining_lib)
    print(f"✓ Updated {lib_file}")

if __name__ == '__main__':
    main()
