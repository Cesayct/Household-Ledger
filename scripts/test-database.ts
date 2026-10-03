import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import initSqlJs from "sql.js";
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
  const blankSettings = database.getBudgetSettings();
  assert.equal(blankSettings.categoryBudgets.length, categories.length);
  assert.equal(blankSettings.categoryBudgets.every((budget) => budget.amount == null), true);
  assert.equal(blankSettings.monthlyBudgets.length, 12);
  assert.equal(blankSettings.monthlyBudgets[8].additions.length, 0);

  const categoryBudgets = categories.map((category, index) => ({
    categoryId: category.id,
    amount: index === 0 ? 20000 : index === 7 ? 30000 : null
  }));
  const monthlyBudgets = blankSettings.monthlyBudgets.map((budget) => ({
    month: budget.month,
    additions: budget.month === 9
      ? [
          { categoryId: categories[0].id, amount: 3000, memo: "食費の追加" },
          { categoryId: categories[7].id, amount: 5000, memo: "通院分" }
        ]
      : []
  }));
  database.saveBudgetSettings({ categoryBudgets, monthlyBudgets });
  assert.equal(database.getCommonBudget(), 50000);
  assert.equal(database.getBudgetSettings().monthlyBudgets[8].additions.length, 2);

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
  assert.equal(database.getDashboard("2026-09-19").monthlyBudget, 58000);
  assert.equal(database.getDashboard("2026-09-19").monthlyDifference, 56000);
  assert.equal(database.getWeek("2026-09-14").total, 2000);
  assert.equal(database.getMonth("2026-09").total, 2000);
  assert.equal(database.getMonth("2026-09").monthlyBudget, 58000);
  assert.equal(database.exportCsv().includes("一時テスト"), true);

  const backup = database.exportJson();
  const backupSnapshot = JSON.parse(backup) as { version: number };
  assert.equal(backupSnapshot.version, 2);
  const restoredRoot = mkdtempSync(`${tmpdir()}\\household-ledger-restore-`);
  try {
    const restored = new HouseholdDatabase(restoredRoot, projectRoot, "");
    await restored.initialize();
    const result = restored.restoreJson(backup);
    assert.deepEqual(result, { categories: 11, paymentMethods: 5, expenses: 2, budgets: 4 });
    assert.equal(restored.listExpenses().length, 2);
    assert.equal(restored.getCommonBudget(), 50000);
    assert.equal(restored.getDashboard("2026-09-19").monthlyBudget, 58000);
    assert.equal(restored.getBudgetSettings().monthlyBudgets[8].additions[0].memo, "食費の追加");
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

  const legacyRoot = mkdtempSync(`${tmpdir()}\\household-ledger-legacy-`);
  try {
    const legacyDatabase = new HouseholdDatabase(legacyRoot, projectRoot, "");
    await legacyDatabase.initialize();
    const legacySnapshot = JSON.parse(backup) as Record<string, unknown>;
    delete legacySnapshot.categoryBudgets;
    delete legacySnapshot.monthlyBudgetAdditions;
    legacySnapshot.version = 1;
    legacySnapshot.commonBudget = 25000;
    legacySnapshot.monthlyBudgets = [
      { month: 9, amount: 20000, memo: "旧月別予算" },
      { month: 11, amount: 30000, memo: "旧月別予算" }
    ];
    const legacyResult = legacyDatabase.restoreJson(JSON.stringify(legacySnapshot));
    assert.equal(legacyResult.budgets, 3);
    assert.equal(legacyDatabase.getCommonBudget(), 25000);
    assert.equal(legacyDatabase.getDashboard("2026-09-19").monthlyBudget, 20000);
    assert.equal(legacyDatabase.getDashboard("2026-10-19").monthlyBudget, 25000);
    assert.equal(legacyDatabase.getDashboard("2026-11-19").monthlyBudget, 30000);
    assert.equal(legacyDatabase.getBudgetSettings().monthlyBudgets[8].additions[0].amount, -5000);
    assert.equal(legacyDatabase.getBudgetSettings().monthlyBudgets[8].additions[0].memo, "旧月別予算");
  } finally {
    rmSync(legacyRoot, { recursive: true, force: true });
  }

  const migrationRoot = mkdtempSync(`${tmpdir()}\\household-ledger-migration-`);
  try {
    const SQL = await initSqlJs({ locateFile: () => join(projectRoot, "node_modules", "sql.js", "dist", "sql-wasm.wasm") });
    const oldDatabase = new SQL.Database();
    oldDatabase.run(`
      CREATE TABLE categories (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL UNIQUE, color TEXT NOT NULL, sort_order INTEGER NOT NULL DEFAULT 0, is_active INTEGER NOT NULL DEFAULT 1);
      CREATE TABLE payment_methods (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL UNIQUE, sort_order INTEGER NOT NULL DEFAULT 0, is_active INTEGER NOT NULL DEFAULT 1);
      CREATE TABLE monthly_budgets (month INTEGER PRIMARY KEY, amount INTEGER NOT NULL, updated_at TEXT NOT NULL);
      CREATE TABLE monthly_budget_memos (month INTEGER PRIMARY KEY, memo TEXT NOT NULL, updated_at TEXT NOT NULL);
      CREATE TABLE common_budgets (id INTEGER PRIMARY KEY, amount INTEGER NOT NULL, updated_at TEXT NOT NULL);
    `);
    oldDatabase.run("INSERT INTO categories (name, color, sort_order, is_active) VALUES (?, ?, 0, 1)", ["その他", "#64748b"]);
    oldDatabase.run("INSERT INTO common_budgets (id, amount, updated_at) VALUES (1, 30000, 'old')");
    oldDatabase.run("INSERT INTO monthly_budgets (month, amount, updated_at) VALUES (9, 25000, 'old'), (10, 35000, 'old')");
    oldDatabase.run("INSERT INTO monthly_budget_memos (month, memo, updated_at) VALUES (9, '旧メモ', 'old')");
    writeFileSync(join(migrationRoot, "household-ledger.sqlite"), Buffer.from(oldDatabase.export()));
    oldDatabase.close();

    const upgraded = new HouseholdDatabase(migrationRoot, projectRoot, "");
    await upgraded.initialize();
    assert.equal(upgraded.getCommonBudget(), 30000);
    assert.equal(upgraded.getDashboard("2026-09-19").monthlyBudget, 25000);
    assert.equal(upgraded.getDashboard("2026-10-19").monthlyBudget, 35000);
    assert.equal(upgraded.getDashboard("2026-11-19").monthlyBudget, 30000);
    assert.equal(upgraded.getBudgetSettings().monthlyBudgets[8].additions[0].amount, -5000);
    assert.equal(upgraded.getBudgetSettings().monthlyBudgets[8].additions[0].memo, "旧メモ");
  } finally {
    rmSync(migrationRoot, { recursive: true, force: true });
  }

  console.log("database integration test passed");
} finally {
  rmSync(temporaryRoot, { recursive: true, force: true });
}
