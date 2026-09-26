import { app, BrowserWindow, dialog } from "electron";
import { createRequire } from "node:module";

const { autoUpdater } = createRequire(import.meta.url)("electron-updater") as typeof import("electron-updater");

export const startAutoUpdates = (): void => {
  if (!app.isPackaged) return;

  autoUpdater.autoDownload = true;
  autoUpdater.autoInstallOnAppQuit = true;

  autoUpdater.on("error", (error) => {
    console.warn("Household Ledger update check failed:", error);
  });

  let restartPromptOpen = false;
  autoUpdater.on("update-downloaded", (info) => {
    if (restartPromptOpen) return;
    restartPromptOpen = true;

    void (async () => {
      const options = {
        type: "info" as const,
        title: "アップデートの準備ができました",
        message: `バージョン ${info.version} をダウンロードしました。`,
        detail: "今すぐ再起動して更新を適用しますか？「後で」を選んだ場合は、アプリ終了時に適用します。",
        buttons: ["今すぐ再起動", "後で"],
        defaultId: 0,
        cancelId: 1
      };
      const window = BrowserWindow.getFocusedWindow() ?? BrowserWindow.getAllWindows()[0];

      try {
        const result = window
          ? await dialog.showMessageBox(window, options)
          : await dialog.showMessageBox(options);
        if (result.response === 0) autoUpdater.quitAndInstall(false, true);
      } catch (error) {
        console.warn("Could not show the update restart prompt:", error);
      } finally {
        restartPromptOpen = false;
      }
    })();
  });

  const startupCheck = setTimeout(() => {
    void autoUpdater.checkForUpdates().catch((error: unknown) => {
      console.warn("Household Ledger update check failed:", error);
    });
  }, 8000);
  startupCheck.unref();
};
