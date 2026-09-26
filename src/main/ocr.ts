import { createWorker, PSM } from "tesseract.js";
import type { OcrResult } from "../shared/types";
import { copyFileSync, existsSync, mkdirSync } from "node:fs";
import { join } from "node:path";

const normalizeOcrText = (text: string): string => text
  .split(/\r?\n/)
  .map((line) => line
    .normalize("NFKC")
    .replace(/[￥\\]/g, "¥")
    .replace(/[|｜]/g, " ")
    .replace(/\u00a0/g, " ")
    .replace(/\s+/g, " ")
    .trim())
  .filter(Boolean)
  .join("\n");

const normalizedDigits = (value: string): string => value
  .normalize("NFKC")
  .replace(/[〇]/g, "0")
  .replace(/[一]/g, "1")
  .replace(/[二]/g, "2")
  .replace(/[三]/g, "3")
  .replace(/[四]/g, "4")
  .replace(/[五]/g, "5")
  .replace(/[六]/g, "6")
  .replace(/[七]/g, "7")
  .replace(/[八]/g, "8")
  .replace(/[九]/g, "9");

const parseDate = (text: string): string | null => {
  const normalized = normalizeOcrText(text);
  const full = normalized.match(/(20\d{2})\s*[./年-]\s*(\d{1,2})\s*[./月-]\s*(\d{1,2})日?/);
  if (full) return `${full[1]}-${full[2].padStart(2, "0")}-${full[3].padStart(2, "0")}`;
  const short = normalized.match(/(\d{1,2})\s*月\s*(\d{1,2})\s*日/);
  if (short) {
    const year = new Date().getFullYear();
    return `${year}-${short[1].padStart(2, "0")}-${short[2].padStart(2, "0")}`;
  }

  // Separators are often lost on narrow or low-contrast receipts. Only accept
  // an unseparated date when the year is unambiguous and the token is complete.
  for (const line of normalized.split("\n")) {
    if (!/[レジ時:：]/u.test(line)) continue;
    const compact = normalizedDigits(line).replace(/[^0-9]/g, " ");
    const tokens = compact.match(/20\d{6,}/g) ?? [];
    for (const token of tokens) {
      if (token.length === 8) {
        const month = Number(token.slice(4, 6));
        const day = Number(token.slice(6, 8));
        if (month >= 1 && month <= 12 && day >= 1 && day <= 31) {
          return `${token.slice(0, 4)}-${token.slice(4, 6)}-${token.slice(6, 8)}`;
        }
      }
    }
  }
  return null;
};

const parseAmounts = (text: string): number[] => {
  const normalized = normalizeOcrText(text);
  const candidates = new Map<number, number>();
  const add = (value: string, priority: number) => {
    const amount = Number(normalizedDigits(value).replace(/[^0-9]/g, ""));
    if (!Number.isInteger(amount) || amount <= 0 || amount > 100_000_000) return;
    const currentPriority = candidates.get(amount);
    if (currentPriority === undefined || priority > currentPriority) candidates.set(amount, priority);
  };
  const labeledAmounts: Array<{ pattern: RegExp; priority: number }> = [
    { pattern: /総\s*合\s*計|合\s*計(?:金\s*額)?/u, priority: 100 },
    { pattern: /お\s*買\s*上(?:げ|が)?/u, priority: 90 },
    { pattern: /お?\s*支\s*払(?:金\s*額)?/u, priority: 80 },
    { pattern: /小\s*計/u, priority: 60 }
  ];

  for (const line of normalized.split("\n")) {
    for (const { pattern, priority } of labeledAmounts) {
      const match = pattern.exec(line);
      if (!match || match.index === undefined) continue;
      const tail = line.slice(match.index + match[0].length);
      const digits = normalizedDigits(tail).replace(/[^0-9]/g, "");
      if (digits) add(digits, priority);
      break;
    }
  }

  // Keep other yen-looking values as selectable fallbacks, but always keep
  // labeled totals ahead of item prices, change, and phone/date numbers.
  for (const line of normalized.split("\n")) {
    if (!/[¥円]/u.test(line)) continue;
    for (const match of normalizedDigits(line).matchAll(/(?<!\d)(\d{1,3}(?:,\d{3})+|\d{2,8})(?!\d)/g)) {
      add(match[1], 10);
    }
  }

  return [...candidates.entries()]
    .sort(([, priorityA], [, priorityB]) => priorityB - priorityA)
    .map(([amount]) => amount)
    .slice(0, 12);
};

const parseStoreName = (text: string): string | null => {
  const lines = normalizeOcrText(text)
    .split("\n")
    .filter(Boolean);
  const firstDetailIndex = lines.findIndex((line) => /[¥円]|合\s*計|小\s*計|お\s*預/u.test(line));
  const headerLines = lines.slice(0, firstDetailIndex >= 0 ? firstDetailIndex : Math.min(lines.length, 6));
  const candidate = headerLines.find((line) => {
    if (line.length < 2 || line.length > 40) return false;
    const compact = line.replace(/\s+/g, "");
    if (/^(レシート|領収書|TEL|電話|合計|小計|内税|外税|お買上げ|お買上|ありがとうございます|レジ|\d)/iu.test(compact)) return false;
    if (/[¥￥\d]/u.test(line)) return false;
    return /[一-龠ぁ-んァ-ヶA-Za-z]/.test(line);
  });
  return candidate ?? null;
};

const suggestCategories = (text: string): string[] => {
  const searchable = normalizeOcrText(text).replace(/\s+/g, "");
  const rules: Array<[string, RegExp]> = [
    ["食費", /スーパー|コンビニ|飲食|レストラン|弁当|食品|食料|食パン|缶詰|タマゴ|卵|うどん|カフェ|コーヒー/iu],
    ["日用品", /ドラッグ|洗剤|ティッシュ|日用品|ホームセンター|生活用品/iu],
    ["交通費", /電車|鉄道|バス|タクシー|乗車|高速|駐車|交通/iu],
    ["光熱費", /電気|ガス|水道|電力|灯油/iu],
    ["通信費", /携帯|スマホ|通信|インターネット|電話料金/iu],
    ["娯楽費", /映画|ゲーム|書籍|漫画|音楽|レジャー|チケット/iu],
    ["医療費", /病院|薬局|薬|診療|医療|歯科/iu],
    ["衣服費", /衣料|洋服|靴|衣服|アパレル/iu],
    ["住居費", /家賃|住宅|管理費|不動産/iu],
    ["交際費", /贈答|ギフト|交際|飲み会/iu]
  ];
  return rules.filter(([, pattern]) => pattern.test(text)).map(([name]) => name);
};

const findExisting = (candidates: string[]): string | undefined => candidates.find((candidate) => existsSync(candidate));

export class ReceiptOcr {
  private readonly cachePath: string;

  constructor(private readonly appPath: string, private readonly resourcesPath: string, userDataPath: string) {
    this.cachePath = join(userDataPath, "tesseract-cache");
    if (!existsSync(this.cachePath)) mkdirSync(this.cachePath, { recursive: true });
  }

  async recognize(dataUrl: string): Promise<OcrResult> {
    const packageRoots = [
      join(this.resourcesPath, "app.asar.unpacked", "node_modules"),
      join(this.appPath, "node_modules")
    ];
    const packageRoot = packageRoots.find((candidate) => existsSync(candidate)) ?? packageRoots[1];
    const languageSources = {
      jpn: findExisting([
        join(this.resourcesPath, "tessdata", "jpn.traineddata.gz"),
        join(packageRoot, "@tesseract.js-data", "jpn", "4.0.0", "jpn.traineddata.gz"),
        join(packageRoot, "@tesseract.js-data", "jpn", "4.0.0_best_int", "jpn.traineddata.gz")
      ]),
      eng: findExisting([
        join(this.resourcesPath, "tessdata", "eng.traineddata.gz"),
        join(packageRoot, "@tesseract.js-data", "eng", "4.0.0", "eng.traineddata.gz"),
        join(packageRoot, "@tesseract.js-data", "eng", "4.0.0_best_int", "eng.traineddata.gz")
      ])
    };
    const workerPath = findExisting([
      join(packageRoot, "tesseract.js", "src", "worker-script", "node", "index.js")
    ]);
    if (!languageSources.jpn || !languageSources.eng) {
      throw new Error("ローカルOCRのデータが見つかりません。npm install後に再度お試しください。");
    }

    // Tesseract expects all languages in one directory when using `jpn+eng`.
    // Build that tiny bundle in userData so it also works from an asar package.
    const langPath = join(this.cachePath, "languages");
    mkdirSync(langPath, { recursive: true });
    copyFileSync(languageSources.jpn, join(langPath, "jpn.traineddata.gz"));
    copyFileSync(languageSources.eng, join(langPath, "eng.traineddata.gz"));

    const worker = await createWorker("jpn+eng", 1, {
      langPath,
      cachePath: this.cachePath,
      gzip: true,
      ...(workerPath ? { workerPath } : {}),
      logger: () => undefined
    });
    try {
      await worker.setParameters({
        tessedit_pageseg_mode: PSM.SINGLE_BLOCK,
        preserve_interword_spaces: "1"
      });
      const result = await worker.recognize(dataUrl, { rotateAuto: true });
      const text = normalizeOcrText(result.data.text);
      return {
        text,
        date: parseDate(text),
        storeName: parseStoreName(text),
        amountCandidates: parseAmounts(text),
        suggestedCategoryNames: suggestCategories(text)
      };
    } finally {
      await worker.terminate();
    }
  }
}
