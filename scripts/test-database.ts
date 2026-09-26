import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { HouseholdDatabase } from "../src/main/database";

const temporaryRoot = mkdtempSync(`${tmpdir()}\\household-ledger-test-`);

try {
  const projectRoot = resolve(".");
  const database = new HouseholdDatabase(temporaryRoot, projectRoot, "");
  await database.initialize();

  const categories = database.listCategories();
  const paymentMethods = database.listPaymentMethods();
  assert.equal(categories.length, 11);
  assert.equal(paymentMethods.length, 5);
  assert.equal(database.listMonthlyBudgets()[8].amount, null);
  database.updateMonthlyBudget(9, 30000);

  const first = database.createExpense({
    spentDate: "2026-09-19",
    amount: 1200,
    categoryId: categories[0].id,
    paymentMethodId: paymentMethods[0].id,
    memo: "一時テスト"
  });
  database.createExpense({
    spentDate: "2026-09-15",
    amount: 800,
    categoryId: categories[1].id,
    paymentMethodId: null,
    memo: "一時テスト2"
  });

  assert.equal(database.getDashboard("2026-09-19").monthTotal, 2000);
  assert.equal(database.getDashboard("2026-09-19").todayTotal, 1200);
  assert.equal(database.getDashboard("2026-09-19").monthlyBudget, 30000);
  assert.equal(database.getDashboard("2026-09-19").monthlyDifference, 28000);
  assert.equal(database.getWeek("2026-09-14").total, 2000);
  assert.equal(database.getMonth("2026-09").total, 2000);
  assert.equal(database.getMonth("2026-09").monthlyBudget, 30000);
  assert.equal(database.exportCsv().includes("一時テスト"), true);

  const backup = database.exportJson();
  const restoredRoot = mkdtempSync(`${tmpdir()}\\household-ledger-restore-`);
  try {
    const restored = new HouseholdDatabase(restoredRoot, projectRoot, "");
    await restored.initialize();
    const result = restored.restoreJson(backup);
    assert.deepEqual(result, { categories: 11, paymentMethods: 5, expenses: 2, budgets: 1 });
    assert.equal(restored.listExpenses().length, 2);
    assert.equal(restored.listMonthlyBudgets()[8].amount, 30000);
    restored.updateExpense(first.id, {
      spentDate: "2026-09-20",
      amount: 1500,
      categoryId: categories[0].id,
      paymentMethodId: paymentMethods[0].id,
      memo: "更新済み"
    });
    assert.equal(restored.listExpenses({ dateFrom: "2026-09-20", dateTo: "2026-09-20" }).length, 1);
    restored.deleteExpense(first.id);
    assert.equal(restored.listExpenses().length, 1);
  } finally {
    rmSync(restoredRoot, { recursive: true, force: true });
  }

  console.log("database integration test passed");
} finally {
  rmSync(temporaryRoot, { recursive: true, force: true });
}
