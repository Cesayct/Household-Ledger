import { randomBytes, timingSafeEqual } from "node:crypto";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { networkInterfaces } from "node:os";
import { basename } from "node:path";
import type { ReceiptImage, ReceiptTransferSession } from "../shared/types";

const DEFAULT_SESSION_DURATION_MS = 10 * 60 * 1000;
const DEFAULT_MAX_IMAGE_BYTES = 20 * 1024 * 1024;
const SUPPORTED_MIME_TYPES = new Set(["image/jpeg", "image/png", "image/webp", "image/gif"]);

type MobileReceiptTransferOptions = {
  bindAddress?: string;
  advertisedAddress?: string;
  sessionDurationMs?: number;
  maxImageBytes?: number;
};

const isPrivateIpv4 = (address: string): boolean => {
  const octets = address.split(".").map(Number);
  if (octets.length !== 4 || octets.some((octet) => !Number.isInteger(octet) || octet < 0 || octet > 255)) return false;
  return octets[0] === 10
    || (octets[0] === 172 && octets[1] >= 16 && octets[1] <= 31)
    || (octets[0] === 192 && octets[1] === 168);
};

const preferredAddressScore = (name: string): number => {
  if (/wi.?fi|wlan|wireless|ワイヤレス/i.test(name)) return 0;
  if (/ethernet|イーサネット/i.test(name)) return 1;
  if (/virtual|vpn|vEthernet|vmware|wsl|docker|bluetooth|loopback/i.test(name)) return 3;
  return 2;
};

export const findLanIpv4Address = (): string => {
  const candidates = Object.entries(networkInterfaces()).flatMap(([name, entries]) =>
    (entries ?? [])
      .filter((entry) => (String(entry.family) === "IPv4" || String(entry.family) === "4") && !entry.internal && isPrivateIpv4(entry.address))
      .map((entry) => ({ name, address: entry.address }))
  );
  candidates.sort((a, b) => preferredAddressScore(a.name) - preferredAddressScore(b.name));
  if (!candidates[0]) {
    throw new Error("スマホから接続できるLANのIPv4アドレスが見つかりません。PCをWi-Fiに接続してから再試行してください。");
  }
  return candidates[0].address;
};

const mimeTypeFromImage = (image: Buffer): string | null => {
  if (image.length >= 3 && image[0] === 0xff && image[1] === 0xd8 && image[2] === 0xff) return "image/jpeg";
  if (image.length >= 8 && image.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return "image/png";
  if (image.length >= 12 && image.toString("ascii", 0, 4) === "RIFF" && image.toString("ascii", 8, 12) === "WEBP") return "image/webp";
  if (image.length >= 6 && ["GIF87a", "GIF89a"].includes(image.toString("ascii", 0, 6))) return "image/gif";
  return null;
};

const extensionForMimeType = (mimeType: string): string => {
  switch (mimeType) {
    case "image/png": return ".png";
    case "image/webp": return ".webp";
    case "image/gif": return ".gif";
    default: return ".jpg";
  }
};

const safeFileName = (value: string | null, mimeType: string): string => {
  const input = (value ?? "mobile-receipt").replace(/\\/g, "/");
  const name = basename(input)
    .replace(/[<>:"/|?*\x00-\x1f]/g, "_")
    .trim()
    .slice(0, 100);
  const stem = name.replace(/\.[^.]*$/, "").trim() || "mobile-receipt";
  return stem + extensionForMimeType(mimeType);
};

const sendText = (response: ServerResponse, status: number, text: string): void => {
  const body = Buffer.from(text, "utf8");
  response.writeHead(status, {
    "Content-Type": "text/plain; charset=utf-8",
    "Content-Length": body.length,
    "Cache-Control": "no-store",
    "X-Content-Type-Options": "nosniff",
    "Referrer-Policy": "no-referrer"
  });
  response.end(body);
};

export class MobileReceiptTransferServer {
  private server: Server | null = null;
  private expiryTimer: NodeJS.Timeout | null = null;
  private token: string | null = null;
  private received = false;
  private onReceipt: ((image: ReceiptImage) => void) | null = null;

  constructor(private readonly options: MobileReceiptTransferOptions = {}) {}

  async start(onReceipt: (image: ReceiptImage) => void): Promise<ReceiptTransferSession> {
    await this.stop();
    const bindAddress = this.options.bindAddress ?? findLanIpv4Address();
    const advertisedAddress = this.options.advertisedAddress ?? bindAddress;
    const duration = this.options.sessionDurationMs ?? DEFAULT_SESSION_DURATION_MS;
    const maxImageBytes = this.options.maxImageBytes ?? DEFAULT_MAX_IMAGE_BYTES;
    this.token = randomBytes(32).toString("hex");
    this.received = false;
    this.onReceipt = onReceipt;

    const server = createServer((request, response) => {
      void this.handleRequest(request, response, maxImageBytes).catch(() => {
        if (!response.headersSent) sendText(response, 500, "受信処理でエラーが発生しました。QRコードを再発行してください。");
      });
    });
    server.requestTimeout = 120_000;
    server.headersTimeout = 15_000;
    server.keepAliveTimeout = 1_000;
    this.server = server;

    try {
      await new Promise<void>((resolve, reject) => {
        const onError = (error: Error): void => reject(error);
        server.once("error", onError);
        server.listen(0, bindAddress, () => {
          server.removeListener("error", onError);
          resolve();
        });
      });
    } catch (error) {
      this.server = null;
      this.token = null;
      this.onReceipt = null;
      throw error;
    }

    const address = server.address();
    if (!address || typeof address === "string") {
      await this.stop();
      throw new Error("スマホ用の受信サーバーを開始できませんでした。");
    }

    const expiresAt = Date.now() + duration;
    this.expiryTimer = setTimeout(() => void this.stop(), duration);
    return {
      url: "http://" + advertisedAddress + ":" + address.port + "/?token=" + this.token,
      expiresAt
    };
  }

  async stop(): Promise<void> {
    if (this.expiryTimer) clearTimeout(this.expiryTimer);
    this.expiryTimer = null;
    this.token = null;
    this.onReceipt = null;
    const server = this.server;
    this.server = null;
    if (!server?.listening) return;
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }

  private async handleRequest(request: IncomingMessage, response: ServerResponse, maxImageBytes: number): Promise<void> {
    const requestUrl = new URL(request.url ?? "/", "http://receipt-transfer.local");
    if (!this.isValidToken(requestUrl.searchParams.get("token"))) {
      sendText(response, 404, "この受信リンクは無効です。PCアプリでQRコードを再発行してください。");
      return;
    }
    if (this.received) {
      sendText(response, 410, "画像はすでに受信済みです。PCアプリでQRコードを再発行してください。");
      return;
    }
    if (request.method === "GET" && requestUrl.pathname === "/") {
      this.sendUploadPage(response);
      return;
    }
    if (request.method !== "POST" || requestUrl.pathname !== "/upload") {
      sendText(response, 404, "ページが見つかりません。");
      return;
    }

    const declaredType = String(request.headers["content-type"] ?? "").split(";")[0].trim().toLowerCase();
    if (declaredType && declaredType !== "application/octet-stream" && !SUPPORTED_MIME_TYPES.has(declaredType) && !declaredType.startsWith("image/")) {
      sendText(response, 415, "JPEG、PNG、WEBP、GIF形式の画像を選択してください。");
      request.resume();
      return;
    }
    const contentLength = Number(request.headers["content-length"] ?? 0);
    if (contentLength > maxImageBytes) {
      sendText(response, 413, "画像が大きすぎます。20MB以下の画像を選択してください。");
      request.resume();
      return;
    }

    const chunks: Buffer[] = [];
    let receivedBytes = 0;
    let tooLarge = false;
    request.on("data", (chunk: Buffer | string) => {
      const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      receivedBytes += buffer.length;
      if (receivedBytes > maxImageBytes) {
        tooLarge = true;
        chunks.length = 0;
      } else if (!tooLarge) {
        chunks.push(buffer);
      }
    });
    request.on("end", () => {
      if (tooLarge) {
        sendText(response, 413, "画像が大きすぎます。20MB以下の画像を選択してください。");
        return;
      }
      const image = Buffer.concat(chunks);
      const mimeType = mimeTypeFromImage(image);
      if (!mimeType) {
        sendText(response, 415, "対応していない画像形式です。JPEG、PNG、WEBP、GIF形式をお使いください。");
        return;
      }
      if (this.received || !this.token) {
        sendText(response, 410, "受信時間が終了しました。PCアプリでQRコードを再発行してください。");
        return;
      }

      this.received = true;
      const callback = this.onReceipt;
      const fileName = safeFileName(requestUrl.searchParams.get("name"), mimeType);
      const receiptImage: ReceiptImage = {
        fileName,
        mimeType,
        dataUrl: "data:" + mimeType + ";base64," + image.toString("base64")
      };
      sendText(response, 200, "画像をPCアプリへ転送しました。スマホ側のページを閉じてください。");
      response.once("finish", () => void this.stop());
      try {
        callback?.(receiptImage);
      } catch {
        // The phone has completed the upload; a destroyed desktop window must not crash the main process.
      }
    });
    request.on("error", () => {
      if (!response.headersSent) sendText(response, 400, "画像を受信できませんでした。もう一度お試しください。");
    });
  }

  private isValidToken(candidate: string | null): boolean {
    if (!candidate || !this.token) return false;
    const receivedToken = Buffer.from(candidate, "utf8");
    const expectedToken = Buffer.from(this.token, "utf8");
    return receivedToken.length === expectedToken.length && timingSafeEqual(receivedToken, expectedToken);
  }

  private sendUploadPage(response: ServerResponse): void {
    const nonce = randomBytes(18).toString("base64");
    const script = [
      "const form=document.querySelector('#upload-form');",
      "const fileInput=document.querySelector('#receipt-image');",
      "const submitButton=document.querySelector('#submit');",
      "const status=document.querySelector('#status');",
      "const token=" + JSON.stringify(this.token) + ";",
      "fileInput.addEventListener('change',()=>{submitButton.disabled=!fileInput.files.length;status.textContent=fileInput.files.length?'選択中: '+fileInput.files[0].name:'画像を選択してください';});",
      "form.addEventListener('submit',async(event)=>{event.preventDefault();const file=fileInput.files[0];if(!file)return;submitButton.disabled=true;status.textContent='PCへ転送しています…';try{const endpoint=new URL('/upload',location.href);endpoint.searchParams.set('token',token);endpoint.searchParams.set('name',file.name);const response=await fetch(endpoint,{method:'POST',headers:{'Content-Type':file.type||'application/octet-stream'},body:file});const message=await response.text();status.textContent=message;if(!response.ok)submitButton.disabled=false;}catch{status.textContent='PCに接続できませんでした。同じWi-Fiに接続しているか確認してください。';submitButton.disabled=false;}});"
    ].join("");
    const html = [
      "<!doctype html><html lang=\"ja\"><head><meta charset=\"utf-8\">",
      "<meta name=\"viewport\" content=\"width=device-width, initial-scale=1, viewport-fit=cover\">",
      "<meta name=\"theme-color\" content=\"#f5f7fb\"><title>レシート画像を送信</title>",
      "<style>",
      "*{box-sizing:border-box}body{margin:0;padding:24px;background:#f5f7fb;color:#17233e;font-family:system-ui,-apple-system,'Segoe UI',sans-serif}",
      "main{width:min(100%,460px);margin:8vh auto;padding:26px;border:1px solid #e0e6f0;border-radius:18px;background:#fff;box-shadow:0 14px 42px #24385e12}",
      ".eyebrow{margin:0 0 9px;color:#74819a;font-size:11px;font-weight:700;letter-spacing:.16em}h1{margin:0;font-size:23px}p{color:#75829a;font-size:14px;line-height:1.7}",
      "label{display:grid;gap:10px;margin:22px 0 14px;font-size:14px;font-weight:650}input[type=file]{width:100%;padding:14px;border:1px dashed #bdc8dc;border-radius:12px;background:#f8faff;font-size:14px}",
      "button{width:100%;min-height:48px;border:0;border-radius:11px;background:#465ff0;color:white;font-size:15px;font-weight:700}button:disabled{opacity:.48}",
      "#status{min-height:24px;margin:15px 0 0;color:#596783;font-size:13px}",
      "small{display:block;margin-top:14px;color:#8b96a9;font-size:11px;line-height:1.7}",
      "</style></head><body><main><p class=\"eyebrow\">HOUSEHOLD LEDGER</p>",
      "<h1>レシート画像を送信</h1><p>画像は同じWi-Fi上のPCへ直接送信され、PC内でOCR処理されます。</p>",
      "<form id=\"upload-form\"><label for=\"receipt-image\">カメラで撮影、または画像を選択",
      "<input id=\"receipt-image\" type=\"file\" accept=\"image/*\" capture=\"environment\" required></label>",
      "<button id=\"submit\" type=\"submit\" disabled>PCへ送信</button></form>",
      "<p id=\"status\" role=\"status\" aria-live=\"polite\">画像を選択してください。</p>",
      "<small>JPEG、PNG、WEBP、GIF形式、20MB以下の画像に対応します。送信は1回限りです。</small>",
      "</main><script nonce=\"" + nonce + "\">" + script + "</script></body></html>"
    ].join("");
    const body = Buffer.from(html, "utf8");
    response.writeHead(200, {
      "Content-Type": "text/html; charset=utf-8",
      "Content-Length": body.length,
      "Cache-Control": "no-store",
      "X-Content-Type-Options": "nosniff",
      "Referrer-Policy": "no-referrer",
      "Content-Security-Policy": "default-src 'none'; style-src 'unsafe-inline'; script-src 'nonce-" + nonce + "'; connect-src 'self'; form-action 'self'; base-uri 'none'; frame-ancestors 'none'"
    });
    response.end(body);
  }
}
