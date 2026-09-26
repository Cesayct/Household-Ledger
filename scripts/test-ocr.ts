import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { ReceiptOcr } from "../src/main/ocr";

const onePixelPng = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=";
const cacheRoot = mkdtempSync(`${tmpdir()}\\household-ledger-ocr-`);
try {
  const result = await new ReceiptOcr(resolve("."), "", cacheRoot).recognize(onePixelPng);
  assert.equal(typeof result.text, "string");
  assert.ok(Array.isArray(result.amountCandidates));
  console.log("ocr integration test passed");
} finally {
  rmSync(cacheRoot, { recursive: true, force: true });
}
