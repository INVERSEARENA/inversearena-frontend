import os
import re

contracts = ['arena', 'factory', 'payout', 'rwa-adapter', 'oracle', 'staking']
output = "# Smart Contracts API Documentation\n\n"

for c in contracts:
    if not os.path.isdir(f"contract/{c}"):
        continue
    output += f"## {c.capitalize()}\n\n"
    
    # Extract storage keys
    try:
        with open(f"contract/{c}/src/storage.rs", 'r', encoding='utf-8') as f:
            content = f.read()
            keys = re.findall(r'pub enum DataKey \{(.*?)\}', content, re.DOTALL)
            if keys:
                output += "### Storage Keys\n"
                for k in [x.strip() for x in keys[0].split(',') if x.strip()]:
                    output += f"- `{k}`\n"
                output += "\n"
    except Exception as e:
        pass
    
    # Extract errors
    try:
        with open(f"contract/{c}/src/types.rs", 'r', encoding='utf-8') as f:
            content = f.read()
            errors = re.findall(r'pub enum .*?Error \{(.*?)\}', content, re.DOTALL)
            if errors:
                output += "### Errors\n"
                for e in [x.strip() for x in errors[0].split(',') if x.strip()]:
                    output += f"- `{e}`\n"
                output += "\n"
    except Exception:
        try:
            with open(f"contract/{c}/src/lib.rs", 'r', encoding='utf-8') as f:
                content = f.read()
                errors = re.findall(r'pub enum .*?Error \{(.*?)\}', content, re.DOTALL)
                if errors:
                    output += "### Errors\n"
                    for e in [x.strip() for x in errors[0].split(',') if x.strip()]:
                        output += f"- `{e}`\n"
                    output += "\n"
        except Exception:
            pass

    # Extract pub functions
    try:
        with open(f"contract/{c}/src/lib.rs", 'r', encoding='utf-8') as f:
            content = f.read()
            impl_blocks = re.findall(r'#\[contractimpl\]\s*impl.*?\{(.*?)\n\}', content, re.DOTALL)
            output += "### Functions\n"
            for b in impl_blocks:
                fns = re.findall(r'pub fn (\w+)\((.*?)\)(?:\s*->\s*(.*?))?\s*\{', b)
                for name, args, ret in fns:
                    args_clean = " ".join(args.split())
                    ret_str = f" -> {ret.strip()}" if ret else ""
                    output += f"- `pub fn {name}({args_clean}){ret_str}`\n"
            output += "\n"
    except Exception:
        pass

with open("contract/CONTRACTS.md", "w", encoding='utf-8') as f:
    f.write(output)
