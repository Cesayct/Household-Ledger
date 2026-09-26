import { app, BrowserWindow, dialog, ipcMain } from "electron";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { basename, dirname, extname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { todayKey } from "../shared/date";
import type { ExpenseInput } from "../shared/types";
import { HouseholdDatabase } from "./database";
import { ReceiptOcr } from "./ocr";
import { startAutoUpdates } from "./updater";

const __dirname = dirname(fileURLToPath(import.meta.url));
let database: HouseholdDatabase;
let receiptOcr: ReceiptOcr;

const mimeTypeFor = (filePath: string): string => {
  switch (extname(filePath).toLowerCase()) {
    case ".png":
      return "image/png";
    case ".webp":
      return "image/webp";
    case ".gif":
      return "image/gif";
    default:
      return "image/jpeg";
  }
};

const safePdfBaseName = (value: string): string => {
  const baseName = String(value || "household-ledger-report")
    .replace(/[<>:"/\\|?*\x00-\x1F]/g, "-")
    .replace(/\.pdf$/i, "")
    .trim();
  return baseName || "household-ledger-report";
};

const createWindow = async (): Promise<void> => {
  const window = new BrowserWindow({
    width: 1440,
    height: 960,
    minWidth: 1100,
    minHeight: 720,
    backgroundColor: "#f5f7fb",
    title: "家計簿",
    webPreferences: {
      preload: join(__dirname, "../preload/index.mjs"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false
    }
  });

  if (process.env.ELECTRON_RENDERER_URL) {
    await window.loadURL(process.env.ELECTRON_RENDERER_URL);
  } else {
    await window.loadFile(join(__dirname, "../renderer/index.html"));
  }
};

const registerIpc = (): void => {
  ipcMain.handle("dashboard:get", (_event, referenceDate: string) => database.getDashboard(referenceDate));
  ipcMain.handle("week:get", (_event, weekStart: string) => database.getWeek(weekStart));
  ipcMain.handle("month:get", (_event, month: string) => database.getMonth(month));
  ipcMain.handle("budgets:list", () => database.listMonthlyBudgets());
  ipcMain.handle("budgets:update", (_event, month: number, amount: number | null, memo?: string) => database.updateMonthlyBudget(month, amount, memo));
  ipcMain.handle("budgets:common", () => database.getCommonBudget());
  ipcMain.handle("budgets:update-common", (_event, amount: number | null) => database.updateCommonBudget(amount));

  ipcMain.handle("expenses:list", (_event, filters) => database.listExpenses(filters ?? {}));
  ipcMain.handle("expenses:create", (_event, input: ExpenseInput) => database.createExpense(input));
  ipcMain.handle("expenses:update", (_event, id: number, input: ExpenseInput) => database.updateExpense(id, input));
  ipcMain.handle("expenses:delete", (_event, id: number) => database.deleteExpense(id));

  ipcMain.handle("categories:list", (_event, includeInactive = false) => database.listCategories(includeInactive));
  ipcMain.handle("categories:create", (_event, input) => database.createCategory(input));
  ipcMain.handle("categories:update", (_event, id: number, input) => database.updateCategory(id, input));
  ipcMain.handle("categories:reorder", (_event, ids: number[]) => database.reorderCategories(ids));

  ipcMain.handle("payment-methods:list", (_event, includeInactive = false) => database.listPaymentMethods(includeInactive));
  ipcMain.handle("payment-methods:create", (_event, input) => database.createPaymentMethod(input));
  ipcMain.handle("payment-methods:update", (_event, id: number, input) => database.updatePaymentMethod(id, input));

  ipcMain.handle("backup:export-json", async () => {
    const result = await dialog.showSaveDialog({
      title: "JSONバックアップを保存",
      defaultPath: join(app.getPath("documents"), `household-ledger-${todayKey()}.json`),
      filters: [{ name: "JSONバックアップ", extensions: ["json"] }]
    });
    if (result.canceled || !result.filePath) return null;
    writeFileSync(result.filePath, database.exportJson(), "utf8");
    return result.filePath;
  });

  ipcMain.handle("backup:export-csv", async () => {
    const result = await dialog.showSaveDialog({
      title: "CSVを保存",
      defaultPath: join(app.getPath("documents"), `household-ledger-${todayKey()}.csv`),
      filters: [{ name: "CSV", extensions: ["csv"] }]
    });
    if (result.canceled || !result.filePath) return null;
    writeFileSync(result.filePath, database.exportCsv(), "utf8");
    return result.filePath;
  });

  ipcMain.handle("backup:restore-json", async () => {
    const result = await dialog.showOpenDialog({
      title: "JSONバックアップを選択",
      properties: ["openFile"],
      filters: [{ name: "JSONバックアップ", extensions: ["json"] }]
    });
    if (result.canceled || !result.filePaths[0]) return null;
    const confirm = await dialog.showMessageBox({
      type: "warning",
      title: "データを復元しますか？",
      message: "現在の家計簿データはバックアップの内容で上書きされます。",
      detail: basename(result.filePaths[0]),
      buttons: ["復元する", "キャンセル"],
      defaultId: 1,
      cancelId: 1
    });
    if (confirm.response !== 0) return null;
    return database.restoreJson(readFileSync(result.filePaths[0], "utf8"));
  });

  ipcMain.handle("printing:print", async (event) => {
    const window = BrowserWindow.fromWebContents(event.sender);
    if (!window) return false;
    return new Promise<boolean>((resolve) => {
      window.webContents.print({
        printBackground: true,
        landscape: false,
        pageSize: "A4"
      }, (success) => resolve(success));
    });
  });

  ipcMain.handle("printing:export-pdf", async (event, fileName: string) => {
    const window = BrowserWindow.fromWebContents(event.sender);
    if (!window) throw new Error("印刷対象のウィンドウが見つかりません。");
    const result = await dialog.showSaveDialog(window, {
      title: "PDFを保存",
      defaultPath: join(app.getPath("documents"), `${safePdfBaseName(fileName)}.pdf`),
      filters: [{ name: "PDF", extensions: ["pdf"] }]
    });
    if (result.canceled || !result.filePath) return null;
    const pdf = await window.webContents.printToPDF({
      displayHeaderFooter: false,
      landscape: false,
      pageSize: "A4",
      margins: { top: 0.35, bottom: 0.35, left: 0.35, right: 0.35 },
      printBackground: true,
      preferCSSPageSize: true
    });
    writeFileSync(result.filePath, pdf);
    return result.filePath;
  });

  ipcMain.handle("receipt:choose-image", async () => {
    const result = await dialog.showOpenDialog({
      title: "レシート画像を選択",
      properties: ["openFile"],
      filters: [{ name: "画像", extensions: ["jpg", "jpeg", "png", "webp", "gif"] }]
    });
    const filePath = result.filePaths[0];
    if (result.canceled || !filePath || !existsSync(filePath)) return null;
    const mimeType = mimeTypeFor(filePath);
    const dataUrl = `data:${mimeType};base64,${readFileSync(filePath).toString("base64")}`;
    return { fileName: basename(filePath), mimeType, dataUrl };
  });

  ipcMain.handle("receipt:recognize", (_event, dataUrl: string) => receiptOcr.recognize(dataUrl));
};

app.setAppUserModelId("jp.local.householdledger");

app.whenReady().then(async () => {
  database = new HouseholdDatabase(app.getPath("userData"), app.getAppPath(), process.resourcesPath);
  await database.initialize();
  receiptOcr = new ReceiptOcr(app.getAppPath(), process.resourcesPath, app.getPath("userData"));
  registerIpc();
  await createWindow();
  startAutoUpdates();
  app.on("activate", async () => {
    if (BrowserWindow.getAllWindows().length === 0) await createWindow();
  });
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") app.quit();
});
