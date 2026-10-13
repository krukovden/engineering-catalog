'use strict';
// Pure failure-extraction logic: ANSI stripping, a generic error-window heuristic and
// per-tool recognizers that classify build output as test / lint / typecheck / build.
// Adapted from the CRAP engine's failure-extraction (the GitHub fetching is not part of it).

const ANSI_PATTERN = new RegExp(`${String.fromCharCode(27)}\\[[0-9;?]*[a-zA-Z]`, 'g');
const stripAnsi = (text) => String(text).replace(ANSI_PATTERN, '');

// 3 lines before / 2 after every error line, deduplicated; the last 20 lines when nothing
// matches, so a caller never gets an empty block. Azure Pipelines marks errors `##[error]`.
function extractGenericBlock(lines) {
  const out = [];
  const seen = new Set();
  lines.forEach((line, i) => {
    const isError = line.includes('##[error]') && !line.includes('Process completed with exit code');
    const isFail = /:\s*FAIL\b/i.test(line) || /\bFAILED\b/.test(line);
    if (!isError && !isFail) return;
    for (let j = Math.max(0, i - 3); j <= Math.min(lines.length - 1, i + 2); j++) {
      if (!seen.has(j)) { seen.add(j); out.push(lines[j]); }
    }
  });
  return out.length ? out : lines.slice(-20);
}

// Order matters: first match wins. `build` is the fall-through, never listed here.
const RECOGNIZERS = [
  { kind: 'test', pattern: /FAIL\s+\S+\.(?:test|spec)\.[jt]sx?|Failed Tests\s*\d*\s*$|^\s*FAILED\s+\S+::|Failed!\s+-\s+Failed:|^\s*Failed\s+\S+\s*\[|\d+ (?:tests? )?failed|Tests:\s+\d+ failed/ },
  { kind: 'test', pattern: /coverage (?:for|threshold).{0,60}(?:not met|does not meet|below threshold)/i },
  { kind: 'typecheck', pattern: /error TS\d{2,5}:|mypy.*error:/ },
  { kind: 'lint', pattern: /Some errors were reported by the linter|biome check|eslint|✖ \d+ problems?|\d+ problems? \(\d+ errors?|ruff|StyleCop|warning IDE\d+/i },
];

const CONTEXT_AFTER = 30;
const CONTEXT_BEFORE = 3;

function classifyFailure(rawText) {
  const lines = stripAnsi(rawText).split('\n');
  for (const { kind, pattern } of RECOGNIZERS) {
    const idx = lines.findIndex((l) => pattern.test(l));
    if (idx !== -1) {
      const start = Math.max(0, idx - CONTEXT_BEFORE);
      const end = Math.min(lines.length - 1, idx + CONTEXT_AFTER);
      return { kind, block: lines.slice(start, end + 1).join('\n') };
    }
  }
  return { kind: 'build', block: extractGenericBlock(lines).join('\n') };
}

// Caps a block's line count; `truncated` is set when the cap was hit.
function boundBlock(text, maxLines = 200) {
  const lines = String(text).split('\n');
  if (lines.length <= maxLines) return { block: text, truncated: false };
  return { block: lines.slice(0, maxLines).join('\n'), truncated: true };
}

module.exports = { stripAnsi, extractGenericBlock, classifyFailure, boundBlock };
