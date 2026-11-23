import { writeFile } from "node:fs/promises";
import { renderRetentionPolicyMarkdown } from "../src/workers/retentionPolicies";

const output = `${process.cwd()}/../docs/DATA_RETENTION_POLICY.md`;
await writeFile(output, renderRetentionPolicyMarkdown(), "utf8");
