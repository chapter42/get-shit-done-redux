/**
 * isPhaseUatPassed — SDK predicate answering "is phase N's UAT contract satisfied?"
 *
 * Cycle 1 of ~15 (walking skeleton): happy path only. No injection stripping,
 * no orphan detection, no human_verification frontmatter merge, no REASON_CODEs.
 */

import { readFile, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { resolvePhaseDir } from './phase-list-queries.js';

/** Regex to parse all UAT items regardless of result value. */
const UAT_ITEM_PATTERN =
  /###\s*(\d+)\.\s*([^\n]+)\nexpected:\s*([^\n]+)\nresult:\s*(\w+)/g;

function parseAllUatItems(content: string): Record<string, unknown>[] {
  const items: Record<string, unknown>[] = [];
  UAT_ITEM_PATTERN.lastIndex = 0;
  let m: RegExpMatchArray | null;
  while ((m = UAT_ITEM_PATTERN.exec(content)) !== null) {
    const [, num, name, expected, result] = m;
    items.push({
      test: parseInt(num, 10),
      name: name.trim(),
      expected: expected.trim(),
      result,
    });
  }
  UAT_ITEM_PATTERN.lastIndex = 0;
  return items;
}

export async function isPhaseUatPassed(
  projectDir: string,
  phase: string,
  workstream?: string,
): Promise<{
  passed: boolean;
  reasons: unknown[];
  reasonsHuman: string[];
  items: Record<string, unknown>[];
}> {
  const dir = await resolvePhaseDir(phase, projectDir, workstream);
  if (!dir) {
    return { passed: false, reasons: [], reasonsHuman: [], items: [] };
  }

  const files = await readdir(dir);
  const uatFiles = files.filter((f) => f.endsWith('-HUMAN-UAT.md'));

  const items: Record<string, unknown>[] = [];
  for (const file of uatFiles) {
    const content = await readFile(join(dir, file), 'utf-8');
    items.push(...parseAllUatItems(content));
  }

  const passed = items.length > 0 && items.every((i) => i.result === 'pass');

  return { passed, reasons: [], reasonsHuman: [], items };
}
