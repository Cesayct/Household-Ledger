import assert from "node:assert/strict";
import { MobileReceiptTransferServer } from "../src/main/mobile-receipt-transfer";

const delay = (milliseconds: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, milliseconds));

const uploadUrlFor = (sessionUrl: string, name?: string): string => {
  const url = new URL("/upload", sessionUrl);
  url.searchParams.set("token", new URL(sessionUrl).searchParams.get("token") ?? "");
  if (name) url.searchParams.set("name", name);
  return url.toString();
};

const run = async (): Promise<void> => {
  let receivedImage: { fileName: string; mimeType: string; dataUrl: string } | null = null;
  const server = new MobileReceiptTransferServer({
    bindAddress: "127.0.0.1",
    advertisedAddress: "127.0.0.1",
    sessionDurationMs: 60_000,
    maxImageBytes: 1024
  });

  try {
    const session = await server.start((image) => {
      receivedImage = image;
    });
    assert.match(new URL(session.url).searchParams.get("token") ?? "", /^[a-f0-9]{64}$/);
    assert.ok(session.expiresAt > Date.now());
    const page = await fetch(session.url);
    assert.equal(page.status, 200);
    assert.match(await page.text(), /capture="environment"/);
    assert.match(page.headers.get("content-security-policy") ?? "", /script-src 'nonce-/);

    const invalidTokenUrl = new URL(session.url);
    invalidTokenUrl.searchParams.set("token", "not-a-valid-token");
    assert.equal((await fetch(invalidTokenUrl)).status, 404);

    const unsupported = await fetch(uploadUrlFor(session.url), {
      method: "POST",
      headers: { "Content-Type": "text/plain" },
      body: "not an image"
    });
    assert.equal(unsupported.status, 415);

    const invalidImage = await fetch(uploadUrlFor(session.url), {
      method: "POST",
      headers: { "Content-Type": "image/jpeg" },
      body: new Uint8Array([1, 2, 3, 4])
    });
    assert.equal(invalidImage.status, 415);

    const oversized = await fetch(uploadUrlFor(session.url), {
      method: "POST",
      headers: { "Content-Type": "image/png" },
      body: new Uint8Array(1025)
    });
    assert.equal(oversized.status, 413);

    const pngHeader = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3]);
    const uploaded = await fetch(uploadUrlFor(session.url, "..\\private.png"), {
      method: "POST",
      headers: { "Content-Type": "image/png" },
      body: pngHeader
    });
    assert.equal(uploaded.status, 200);
    assert.match(await uploaded.text(), /PCアプリへ転送しました/);
    assert.deepEqual(receivedImage, {
      fileName: "private.png",
      mimeType: "image/png",
      dataUrl: "data:image/png;base64," + Buffer.from(pngHeader).toString("base64")
    });
  } finally {
    await server.stop();
  }

  const expiringServer = new MobileReceiptTransferServer({
    bindAddress: "127.0.0.1",
    advertisedAddress: "127.0.0.1",
    sessionDurationMs: 40
  });
  const expiringSession = await expiringServer.start(() => undefined);
  await delay(100);
  await assert.rejects(() => fetch(expiringSession.url));
  await expiringServer.stop();
  process.stdout.write("mobile receipt transfer integration test passed\n");
};

void run().catch((error: unknown) => {
  process.stderr.write(String(error) + "\n");
  process.exitCode = 1;
});
