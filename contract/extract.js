const fs = require('fs');
const path = require('path');

const contracts = ['arena', 'factory', 'payout', 'rwa-adapter', 'oracle', 'staking'];
let output = "# Smart Contracts API Documentation\n\n";

for (const c of contracts) {
    const dir = path.join('contract', c, 'src');
    if (!fs.existsSync(dir)) continue;

    output += `## ${c.charAt(0).toUpperCase() + c.slice(1)}\n\n`;

    // Extract storage keys
    try {
        const storagePath = path.join(dir, 'storage.rs');
        if (fs.existsSync(storagePath)) {
            const content = fs.readFileSync(storagePath, 'utf8');
            const match = content.match(/pub enum DataKey\s*\{([\s\S]*?)\}/);
            if (match) {
                output += "### Storage Keys\n";
                const keys = match[1].split(',').map(k => k.trim()).filter(k => k.length > 0);
                for (const k of keys) {
                    output += `- \`${k}\`\n`;
                }
                output += "\n";
            }
        }
    } catch (e) {}

    // Extract errors
    try {
        let typesPath = path.join(dir, 'types.rs');
        if (!fs.existsSync(typesPath)) {
            typesPath = path.join(dir, 'lib.rs');
        }
        if (fs.existsSync(typesPath)) {
            const content = fs.readFileSync(typesPath, 'utf8');
            const match = content.match(/pub enum .*?Error\s*\{([\s\S]*?)\}/);
            if (match) {
                output += "### Errors\n";
                const errs = match[1].split(',').map(e => e.trim().split(/\s*=/)[0]).filter(e => e.length > 0 && !e.startsWith('//'));
                for (const e of errs) {
                    output += `- \`${e}\`\n`;
                }
                output += "\n";
            }
        }
    } catch (e) {}

    // Extract pub functions
    try {
        const libPath = path.join(dir, 'lib.rs');
        if (fs.existsSync(libPath)) {
            const content = fs.readFileSync(libPath, 'utf8');
            const implBlocks = [...content.matchAll(/#\[contractimpl\][\s\S]*?impl[\s\S]*?\{([\s\S]*?^\})/gm)];
            if (implBlocks.length > 0) {
                output += "### Functions\n";
                for (const block of implBlocks) {
                    const blockContent = block[1];
                    const fns = [...blockContent.matchAll(/pub fn\s+(\w+)\s*\((.*?)\)(?:\s*->\s*(.*?))?\s*\{/g)];
                    for (const fn of fns) {
                        const name = fn[1];
                        const args = fn[2].replace(/\s+/g, ' ').trim();
                        const ret = fn[3] ? ` -> ${fn[3].trim()}` : '';
                        output += `- \`pub fn ${name}(${args})${ret}\`\n`;
                    }
                }
                output += "\n";
            }
        }
    } catch (e) {}
}

fs.writeFileSync(path.join('contract', 'CONTRACTS.md'), output);
console.log('CONTRACTS.md generated successfully.');
