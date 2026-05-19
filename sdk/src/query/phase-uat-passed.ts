/**
 * isPhaseUatPassed — SDK predicate answering "is phase N's UAT contract satisfied?"
 *
 * Cycle 2 of ~15: introduces REASON_CODE frozen enum and UatReason typed shape.
 * Non-pass items (result not literally 'pass') emit a typed NON_PASS_RESULT reason.
 */

import { readFile, readdir } from 'node:fs/promises';
import { join, relative } from 'node:path';
import { resolvePhaseDir } from './phase-list-queries.js';
import { extractFrontmatter } from './frontmatter.js';
import { parseVerificationFrontmatterItems } from './uat.js';

export const REASON_CODE = Object.freeze({
  NON_PASS_RESULT: 'non_pass_result',
  CASE_MISMATCH: 'case_mismatch',
  HUMAN_VERIFICATION_NEEDED: 'human_verification_needed',
  NO_PHASE_DIR: 'no_phase_dir',
  NO_UAT_FILES: 'no_uat_files',
} as const);

export type ReasonCode = typeof REASON_CODE[keyof typeof REASON_CODE];

export type UatReason = {
  code: ReasonCode;
  file?: string;
  itemName?: string;
  capturedValue?: string;
};

/** Regex to parse all UAT items regardless of result value.
 *  Accepts optional bold markers (**key:**) around expected/result keys. */
const UAT_ITEM_PATTERN =
  /###\s*(\d+)\.\s*([^\n]+)\n(?:\*\*)?expected:(?:\*\*)?\s*([^\n]+)\n(?:\*\*)?result:(?:\*\*)?\s*(\w+)/g;

interface UatItem {
  test: number;
  name: string;
  expected: string;
  result: string;
}

/**
 * Strip regions from file content that could contain markdown-shaped text
 * but should not be treated as UAT items (frontmatter, code fences, etc.).
 * Passes are applied in order; each returns a sanitised string.
 */
function stripMarkdownInjection(content: string): string {
  // Pass 1: strip YAML frontmatter region (---\n...\n---)
  let s = content.replace(/^---\r?\n[\s\S]*?\r?\n---/m, '');
  // Pass 2: strip fenced code blocks (``` ... ```)
  s = s.replace(/```[\s\S]*?```/g, '');
  // Pass 3: strip HTML comment regions (<!-- ... -->)
  s = s.replace(/<!--[\s\S]*?-->/g, '');
  // Pass 4: strip blockquote-prefixed lines (any line starting with optional whitespace + >)
  s = s.replace(/^\s*>.*$/gm, '');
  return s;
}

function parseAllUatItems(content: string): UatItem[] {
  const sanitised = stripMarkdownInjection(content);
  const items: UatItem[] = [];
  UAT_ITEM_PATTERN.lastIndex = 0;
  let m: RegExpMatchArray | null;
  while ((m = UAT_ITEM_PATTERN.exec(sanitised)) !== null) {
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
  reasons: UatReason[];
  reasonsHuman: string[];
  items: Record<string, unknown>[];
}> {
  const dir = await resolvePhaseDir(phase, projectDir, workstream);
  if (!dir) {
    return {
      passed: false,
      reasons: [{ code: REASON_CODE.NO_PHASE_DIR }],
      reasonsHuman: [],
      items: [],
    };
  }

  const files = await readdir(dir);
  const uatFiles = files.filter((f) => f.endsWith('-HUMAN-UAT.md'));

  if (uatFiles.length === 0) {
    return {
      passed: false,
      reasons: [{ code: REASON_CODE.NO_UAT_FILES }],
      reasonsHuman: [],
      items: [],
    };
  }

  const items: UatItem[] = [];
  const reasons: UatReason[] = [];

  for (const file of uatFiles) {
    const filePath = join(dir, file);
    const relFile = relative(projectDir, filePath);
    const content = await readFile(filePath, 'utf-8');
    const parsed = parseAllUatItems(content);
    for (const item of parsed) {
      items.push(item);
      if (item.result !== 'pass') {
        const code =
          item.result.toLowerCase() === 'pass'
            ? REASON_CODE.CASE_MISMATCH
            : REASON_CODE.NON_PASS_RESULT;
        reasons.push({
          code,
          file: relFile,
          itemName: item.name,
          capturedValue: item.result,
        });
      }
    }

    // Merge frontmatter human_verification items into the roster.
    const fm = extractFrontmatter(content);
    const fmItems = parseVerificationFrontmatterItems(fm);
    for (const fmItem of fmItems) {
      const name = String(fmItem.name ?? '');
      // Add a synthetic UatItem so items.length is accurate.
      items.push({ test: -1, name, expected: String(fmItem.expected ?? ''), result: 'human_needed' });
      reasons.push({
        code: REASON_CODE.HUMAN_VERIFICATION_NEEDED,
        file: relFile,
        itemName: name,
        capturedValue: 'human_needed',
      });
    }
  }

  const passed = items.length > 0 && reasons.length === 0;

  return { passed, reasons, reasonsHuman: [], items };
}
