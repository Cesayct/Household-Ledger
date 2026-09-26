import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { copyFileSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const unpackedRoot = resolve("dist/auto-update/win-unpacked/resources/app.asar.unpacked");
const require = createRequire(import.meta.url);
const tesseract = require(join(unpackedRoot, "node_modules", "tesseract.js"));
const cacheRoot = mkdtempSync(`${tmpdir()}\\household-ledger-packaged-ocr-`);
const langRoot = join(cacheRoot, "languages");
const packageRoot = join(unpackedRoot, "node_modules");
mkdirSync(langRoot, { recursive: true });
const jpnSource = join(packageRoot, "@tesseract.js-data", "jpn", "4.0.0", "jpn.traineddata.gz");
const engSource = join(packageRoot, "@tesseract.js-data", "eng", "4.0.0", "eng.traineddata.gz");
copyFileSync(jpnSource, join(langRoot, "jpn.traineddata.gz"));
copyFileSync(engSource, join(langRoot, "eng.traineddata.gz"));
const onePixelPng = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=";

try {
  const worker = await tesseract.createWorker("jpn+eng", 1, {
    langPath: langRoot,
    workerPath: join(packageRoot, "tesseract.js", "src", "worker-script", "node", "index.js"),
    cachePath: cacheRoot,
    logger: () => undefined
  });
  try {
    const result = await worker.recognize(onePixelPng);
    assert.equal(typeof result.data.text, "string");
  } finally {
    await worker.terminate();
  }
  console.log("packaged OCR integration test passed");
} finally {
  rmSync(cacheRoot, { recursive: true, force: true });
}
