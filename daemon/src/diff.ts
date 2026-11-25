// Compact unified diff generator (zero runtime dependencies).

export function buildUnifiedDiff(
  relPath: string,
  oldText: string,
  newText: string,
  contextLines = 2,
  maxDiffLines = 80
): string {
  const a = oldText.replace(/\r\n/g, "\n").split("\n");
  const b = newText.replace(/\r\n/g, "\n").split("\n");

  // Trim common prefix and suffix first so large files diff in O(changed^2)
  let prefix = 0;
  const minLen = Math.min(a.length, b.length);
  while (prefix < minLen && a[prefix] === b[prefix]) {
    prefix += 1;
  }

  let aEnd = a.length;
  let bEnd = b.length;
  while (aEnd > prefix && bEnd > prefix && a[aEnd - 1] === b[bEnd - 1]) {
    aEnd -= 1;
    bEnd -= 1;
  }

  const midA = a.slice(prefix, aEnd);
  const midB = b.slice(prefix, bEnd);

  if (midA.length === 0 && midB.length === 0) {
    return `(no changes in ${relPath})`;
  }

  const hunks: Array<{ type: " " | "-" | "+"; line: string }> = [];
  const ctxBeforeStart = Math.max(0, prefix - contextLines);
  for (let i = ctxBeforeStart; i < prefix; i++) {
    hunks.push({ type: " ", line: a[i] });
  }

  // Use LCS for reasonably sized changed regions; simple replace block if huge
  if (midA.length * midB.length <= 40_000) {
    const m = midA.length;
    const n = midB.length;
    const dp: Int32Array[] = Array.from({ length: m + 1 }, () => new Int32Array(n + 1));
    for (let i = m - 1; i >= 0; i--) {
      for (let j = n - 1; j >= 0; j--) {
        if (midA[i] === midB[j]) {
          dp[i][j] = dp[i + 1][j + 1] + 1;
        } else {
          dp[i][j] = Math.max(dp[i + 1][j], dp[i][j + 1]);
        }
      }
    }
    let i = 0;
    let j = 0;
    while (i < m && j < n) {
      if (midA[i] === midB[j]) {
        hunks.push({ type: " ", line: midA[i] });
        i += 1;
        j += 1;
      } else if (dp[i + 1][j] >= dp[i][j + 1]) {
        hunks.push({ type: "-", line: midA[i] });
        i += 1;
      } else {
        hunks.push({ type: "+", line: midB[j] });
        j += 1;
      }
    }
    while (i < m) {
      hunks.push({ type: "-", line: midA[i++] });
    }
    while (j < n) {
      hunks.push({ type: "+", line: midB[j++] });
    }
  } else {
    for (const line of midA) hunks.push({ type: "-", line });
    for (const line of midB) hunks.push({ type: "+", line });
  }

  const ctxAfterEnd = Math.min(a.length, aEnd + contextLines);
  for (let i = aEnd; i < ctxAfterEnd; i++) {
    hunks.push({ type: " ", line: a[i] });
  }

  const oldCount = aEnd - prefix + (prefix - ctxBeforeStart) + (ctxAfterEnd - aEnd);
  const newCount = bEnd - prefix + (prefix - ctxBeforeStart) + (ctxAfterEnd - aEnd);
  const header = `@@ -${ctxBeforeStart + 1},${oldCount} +${ctxBeforeStart + 1},${newCount} @@ ${relPath}`;

  const bodyLines = hunks.map((h) => `${h.type}${h.line}`);
  if (bodyLines.length > maxDiffLines) {
    const kept = bodyLines.slice(0, maxDiffLines);
    kept.push(`... [+${bodyLines.length - maxDiffLines} more diff lines]`);
    return `${header}\n${kept.join("\n")}`;
  }
  return `${header}\n${bodyLines.join("\n")}`;
}
