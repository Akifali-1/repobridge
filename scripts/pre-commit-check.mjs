#!/usr/bin/env node
import { execFileSync } from "node:child_process";

const TOKEN_PATTERNS = [
  { name: "Bearer token", re: /Bearer\s+[A-Za-z0-9._-]{16,}/i },
  { name: "GitHub PAT", re: /\b(?:ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9]{20,}\b/ },
  { name: "Private key", re: /-----BEGIN [A-Z ]*PRIVATE KEY-----/ },
  { name: "AWS access key", re: /\bAKIA[0-9A-Z]{16}\b/ },
  { name: "RepoBridge token literal", re: /REPOBRIDGE_TOKEN\s*=\s*[a-f0-9]{16,}/i }
];

const SAFE_ENV_NAMES = new Set([".env.example", ".env.sample", ".env.template", ".env.defaults"]);

function getStagedFiles() {
  const out = execFileSync("git", ["diff", "--cached", "--name-only", "--diff-filter=ACMR"], {
    encoding: "utf8"
  });
  return out
    .split(/\r?\n/)
    .map((s) => s.trim())
    .filter(Boolean);
}

const staged = getStagedFiles();
const failures = [];

for (const file of staged) {
  const base = file.split("/").pop()?.toLowerCase() ?? "";
  if ((base === ".env" || base.startsWith(".env.")) && !SAFE_ENV_NAMES.has(base)) {
    failures.push(`Blocked staged env file: ${file}`);
    continue;
  }
  if (base === "bundle.txt" || base === "token") {
    failures.push(`Blocked staged artifact/token file: ${file}`);
    continue;
  }

  let content = "";
  try {
    content = execFileSync("git", ["show", `:${file}`], { encoding: "utf8", maxBuffer: 5_000_000 });
  } catch {
    continue;
  }

  const lines = content.split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    for (const pat of TOKEN_PATTERNS) {
      if (pat.re.test(lines[i])) {
        failures.push(`${pat.name} detected in ${file}:${i + 1}`);
      }
    }
  }
}

if (failures.length > 0) {
  console.error("RepoBridge pre-commit check failed:");
  for (const f of failures) {
    console.error(`  - ${f}`);
  }
  process.exit(1);
}
