import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { parseAmounts, parseDate, ReceiptOcr } from "../src/main/ocr";

const onePixelPng = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=";
const noisyReceiptText = [
  "2026 年 10 月 0 1 日 17:05",
  "外 ¥420",
  "外税対象 8.0% ¥420",
  "外税 ¥33",
  "國S 計 。 #453",
  "お預り ¥460",
  "お釣 ¥7"
].join("\n");

assert.equal(parseDate(noisyReceiptText), "2026-10-01");
assert.deepEqual(parseAmounts(noisyReceiptText), [453, 420, 33, 460]);
assert.deepEqual(parseAmounts("小 計 #420\n合 計 #453"), [453, 420]);

const cacheRoot = mkdtempSync(`${tmpdir()}\\household-ledger-ocr-`);
try {
  const result = await new ReceiptOcr(resolve("."), "", cacheRoot).recognize(onePixelPng);
  assert.equal(typeof result.text, "string");
  assert.ok(Array.isArray(result.amountCandidates));
  console.log("ocr integration test passed");
} finally {
  rmSync(cacheRoot, { recursive: true, force: true });
}
