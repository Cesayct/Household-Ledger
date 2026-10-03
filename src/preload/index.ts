import { contextBridge, ipcRenderer } from "electron";
import type { HouseholdLedgerApi, ReceiptImage } from "../shared/types";

const api: HouseholdLedgerApi = {
  dashboard: (referenceDate) => ipcRenderer.invoke("dashboard:get", referenceDate),
  expenses: {
    list: (filters) => ipcRenderer.invoke("expenses:list", filters),
    create: (input) => ipcRenderer.invoke("expenses:create", input),
    update: (id, input) => ipcRenderer.invoke("expenses:update", id, input),
    delete: (id) => ipcRenderer.invoke("expenses:delete", id)
  },
  categories: {
    list: (includeInactive) => ipcRenderer.invoke("categories:list", includeInactive),
    create: (input) => ipcRenderer.invoke("categories:create", input),
    update: (id, input) => ipcRenderer.invoke("categories:update", id, input),
    delete: (id) => ipcRenderer.invoke("categories:delete", id),
    reorder: (ids) => ipcRenderer.invoke("categories:reorder", ids)
  },
  paymentMethods: {
    list: (includeInactive) => ipcRenderer.invoke("payment-methods:list", includeInactive),
    create: (input) => ipcRenderer.invoke("payment-methods:create", input),
    update: (id, input) => ipcRenderer.invoke("payment-methods:update", id, input)
  },
  budgets: {
    settings: () => ipcRenderer.invoke("budgets:settings"),
    saveSettings: (settings) => ipcRenderer.invoke("budgets:save-settings", settings)
  },
  week: (weekStart) => ipcRenderer.invoke("week:get", weekStart),
  month: (month) => ipcRenderer.invoke("month:get", month),
  backup: {
    exportJson: () => ipcRenderer.invoke("backup:export-json"),
    exportCsv: () => ipcRenderer.invoke("backup:export-csv"),
    restoreJson: () => ipcRenderer.invoke("backup:restore-json")
  },
  receipt: {
    chooseImage: () => ipcRenderer.invoke("receipt:choose-image"),
    recognize: (dataUrl) => ipcRenderer.invoke("receipt:recognize", dataUrl),
    startMobileTransfer: () => ipcRenderer.invoke("receipt:mobile-transfer:start"),
    stopMobileTransfer: () => ipcRenderer.invoke("receipt:mobile-transfer:stop"),
    onMobileImage: (callback) => {
      const listener = (_event: Electron.IpcRendererEvent, image: ReceiptImage): void => callback(image);
      ipcRenderer.on("receipt:mobile-image", listener);
      return () => ipcRenderer.removeListener("receipt:mobile-image", listener);
    }
  },
  printing: {
    print: () => ipcRenderer.invoke("printing:print"),
    exportPdf: (fileName) => ipcRenderer.invoke("printing:export-pdf", fileName)
  }
};

contextBridge.exposeInMainWorld("ledgerApi", api);
