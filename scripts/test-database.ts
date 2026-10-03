import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import initSqlJs from "sql.js";
import { HouseholdDatabase } from "../src/main/database";

const temporaryRoot = mkdtempSync(`${tmpdir()}\\household-ledger-test-`);
let currentYear = 2026;

try {
  const projectRoot = resolve(".");
  const database = new HouseholdDatabase(temporaryRoot, projectRoot, "", () => currentYear);
  await database.initialize();

  const categories = database.listCategories();
  const paymentMethods = database.listPaymentMethods();
  assert.equal(categories.length, 11);
  assert.equal(paymentMethods.length, 5);
  assert.equal(categories.every((category) => !category.excludeFromWeeklyBudget), true);
  const blankSettings = database.getBudgetSettings();
  assert.equal(blankSettings.categoryBudgets.length, categories.length);
  assert.equal(blankSettings.categoryBudgets.every((budget) => budget.amount == null), true);
  assert.equal(blankSettings.monthlyBudgets.length, 12);
  assert.equal(blankSettings.monthlyBudgets[8].additions.length, 0);
  assert.deepEqual(database.getMonth("2026-09").categoryBudgets, []);

  const removableCategory = database.createCategory({ name: "削除テスト", color: "#123456" });
  database.updateCategory(removableCategory.id, { name: removableCategory.name, color: removableCategory.color, isActive: false });
  database.deleteCategory(removableCategory.id);
  assert.equal(database.listCategories(true).some((category) => category.id === removableCategory.id), false);

  const categoryBudgets = categories.map((category, index) => ({
    categoryId: category.id,
    amount: index === 0 ? 20000 : index === 7 ? 30000 : null
  }));
  const monthlyBudgets = blankSettings.monthlyBudgets.map((budget) => ({
    month: budget.month,
    additions: budget.month === 9
      ? [
          { categoryId: categories[0].id, amount: 3000, memo: "食費の追加" },
          { categoryId: categories[1].id, amount: 250, memo: "追加予算のみ" },
          { categoryId: categories[7].id, amount: 5000, memo: "通院分" }
        ]
      : []
  }));
  database.saveBudgetSettings({ categoryBudgets, monthlyBudgets });
  const excludedCategory = categories[0];
  const updatedExcludedCategory = database.updateCategory(excludedCategory.id, {
    name: excludedCategory.name,
    color: excludedCategory.color,
    isActive: excludedCategory.isActive,
    excludeFromWeeklyBudget: true
  });
  assert.equal(updatedExcludedCategory.excludeFromWeeklyBudget, true);
  assert.equal(database.getCommonBudget(), 50000);
  assert.equal(database.getBudgetSettings().monthlyBudgets[8].additions.length, 3);
  assert.throws(() => database.deleteCategory(categories[0].id), /使用中のため削除できません/);
  assert.equal(database.listCategories(true).some((category) => category.id === categories[0].id), true);

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
  database.createExpense({
    spentDate: "2026-09-16",
    amount: 300,
    categoryId: categories[2].id,
    paymentMethodId: null,
    memo: "未設定予算のテスト"
  });

  assert.equal(database.getDashboard("2026-09-19").monthTotal, 2300);
  assert.equal(database.getDashboard("2026-09-19").todayTotal, 1200);
  assert.equal(database.getDashboard("2026-09-19").monthlyBudget, 58250);
  assert.equal(database.getDashboard("2026-09-19").monthlyDifference, 55950);
  assert.deepEqual(database.getDashboard("2026-09-19").categoryBudgets.map(({ categoryId, amount }) => [categoryId, amount]), [
    [categories[0].id, 23000],
    [categories[1].id, 250],
    [categories[7].id, 35000]
  ]);
  assert.equal(database.getWeek("2026-09-14").total, 2300);
  const monthView = database.getMonth("2026-09");
  assert.equal(monthView.total, 2300);
  assert.equal(monthView.monthlyBudget, 58250);
  assert.deepEqual(monthView.categoryBudgets.map(({ categoryId, amount }) => [categoryId, amount]), [
    [categories[0].id, 23000],
    [categories[1].id, 250],
    [categories[7].id, 35000]
  ]);
  assert.equal(monthView.categoryAmounts.find((item) => item.categoryId === categories[0].id)?.budget, 23000);
  assert.equal(monthView.categoryAmounts.find((item) => item.categoryId === categories[1].id)?.budget, 250);
  assert.equal(monthView.categoryAmounts.find((item) => item.categoryId === categories[2].id)?.budget, null);
  assert.deepEqual(monthView.weekAmounts.map((item) => [item.weekStart, item.weekEnd, item.label]), [
    ["2026-09-01", "2026-09-06", "9/1〜9/6"],
    ["2026-09-07", "2026-09-13", "9/7〜9/13"],
    ["2026-09-14", "2026-09-20", "9/14〜9/20"],
    ["2026-09-21", "2026-09-27", "9/21〜9/27"],
    ["2026-09-28", "2026-09-30", "9/28〜9/30"]
  ]);
  assert.deepEqual(monthView.weekAmounts.map((item) => item.budget), [7050, 8225, 8225, 8225, 3525]);
  assert.equal(monthView.weekAmounts.reduce((sum, item) => sum + (item.budget ?? 0), 0), 35250);
  assert.equal(monthView.weekAmounts[2].amount, 1100);
  assert.equal(monthView.weekAmounts[2].remaining, 7125);
  assert.equal(database.getWeek("2026-09-14").total, 2300);

  const overBudgetExpense = database.createExpense({
    spentDate: "2026-10-31",
    amount: 60000,
    categoryId: categories[2].id,
    paymentMethodId: null,
    memo: "超過テスト"
  });
  const octoberView = database.getMonth("2026-10");
  assert.deepEqual(octoberView.categoryBudgets.map(({ categoryId, amount }) => [categoryId, amount]), [
    [categories[0].id, 20000],
    [categories[7].id, 30000]
  ]);
  const lastOctoberWeek = octoberView.weekAmounts.at(-1)!;
  assert.equal(lastOctoberWeek.weekStart, "2026-10-26");
  assert.equal(lastOctoberWeek.weekEnd, "2026-10-31");
  assert.equal(lastOctoberWeek.budget, 5806);
  assert.equal(lastOctoberWeek.amount, 60000);
  assert.equal(lastOctoberWeek.overspend, 54194);
  assert.equal(lastOctoberWeek.remaining, 0);
  database.deleteExpense(overBudgetExpense.id);
  assert.equal(database.exportCsv().includes("一時テスト"), true);

  const backup = database.exportJson();
  const backupSnapshot = JSON.parse(backup) as {
    version: number;
    activeBudgetYear: number;
    budgetSettingsByYear: Array<{ year: number }>;
    categories: Array<{ id: number; excludeFromWeeklyBudget?: boolean }>;
  };
  assert.equal(backupSnapshot.version, 3);
  assert.equal(backupSnapshot.activeBudgetYear, 2026);
  assert.deepEqual(backupSnapshot.budgetSettingsByYear.map(({ year }) => year), [2026]);
  assert.equal(backupSnapshot.categories.find((category) => category.id === excludedCategory.id)?.excludeFromWeeklyBudget, true);
  const restoredRoot = mkdtempSync(`${tmpdir()}\\household-ledger-restore-`);
  try {
    const restored = new HouseholdDatabase(restoredRoot, projectRoot, "");
    await restored.initialize();
    const result = restored.restoreJson(backup);
    assert.deepEqual(result, { categories: 11, paymentMethods: 5, expenses: 3, budgets: 5 });
    assert.equal(restored.listExpenses().length, 3);
    assert.equal(restored.getCommonBudget(), 50000);
    assert.equal(restored.getDashboard("2026-09-19").monthlyBudget, 58250);
    assert.equal(restored.getBudgetSettings().monthlyBudgets[8].additions[0].memo, "食費の追加");
    assert.equal(restored.listCategories(true).find((category) => category.id === excludedCategory.id)?.excludeFromWeeklyBudget, true);
    restored.updateExpense(first.id, {
      spentDate: "2026-09-20",
      amount: 1500,
      categoryId: categories[0].id,
      paymentMethodId: paymentMethods[0].id,
      memo: "更新済み"
    });
    assert.equal(restored.listExpenses({ dateFrom: "2026-09-20", dateTo: "2026-09-20" }).length, 1);
    restored.deleteExpense(first.id);
    assert.equal(restored.listExpenses().length, 2);

    const previousVersion2Backup = JSON.parse(backup) as {
      version: number;
      activeBudgetYear?: number;
      budgetSettingsByYear?: unknown;
      categories: Array<Record<string, unknown>>;
    };
    previousVersion2Backup.version = 2;
    delete previousVersion2Backup.activeBudgetYear;
    delete previousVersion2Backup.budgetSettingsByYear;
    previousVersion2Backup.categories.forEach((category) => delete category.excludeFromWeeklyBudget);
    restored.restoreJson(JSON.stringify(previousVersion2Backup));
    assert.equal(restored.listCategories(true).find((category) => category.id === excludedCategory.id)?.excludeFromWeeklyBudget, false);
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
    delete legacySnapshot.activeBudgetYear;
    delete legacySnapshot.budgetSettingsByYear;
    legacySnapshot.version = 1;
    legacySnapshot.commonBudget = 25000;
    legacySnapshot.monthlyBudgets = [
      { month: 9, amount: 20000, memo: "旧月別予算" },
      { month: 11, amount: 30000, memo: "旧月別予算" }
    ];
    const legacyResult = legacyDatabase.restoreJson(JSON.stringify(legacySnapshot));
    assert.equal(legacyDatabase.listCategories(true).find((category) => category.id === excludedCategory.id)?.excludeFromWeeklyBudget, true);
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
    assert.equal(upgraded.listCategories(true)[0].excludeFromWeeklyBudget, false);
    assert.equal(upgraded.getDashboard("2026-09-19").monthlyBudget, 25000);
    assert.equal(upgraded.getDashboard("2026-10-19").monthlyBudget, 35000);
    assert.equal(upgraded.getDashboard("2026-11-19").monthlyBudget, 30000);
    assert.equal(upgraded.getBudgetSettings().monthlyBudgets[8].additions[0].amount, -5000);
    assert.equal(upgraded.getBudgetSettings().monthlyBudgets[8].additions[0].memo, "旧メモ");
  } finally {
    rmSync(migrationRoot, { recursive: true, force: true });
  }

  currentYear = 2027;
  const settingsBeforeRollover = database.getBudgetSettings();
  assert.equal(settingsBeforeRollover.categoryBudgets.find((budget) => budget.categoryId === categories[0].id)?.amount, 20000);
  assert.equal(database.getMonth("2027-09").monthlyBudget, 58250);
  assert.equal(database.getMonth("2026-09").monthlyBudget, 58250);

  const nextYearCategoryBudgets = settingsBeforeRollover.categoryBudgets.map((budget) => ({
    ...budget,
    amount: budget.categoryId === categories[0].id
      ? 25000
      : budget.categoryId === categories[7].id
        ? 35000
        : budget.amount
  }));
  const nextYearMonthlyBudgets = settingsBeforeRollover.monthlyBudgets.map((budget) => ({
    month: budget.month,
    additions: budget.additions.map((addition) => ({
      categoryId: addition.categoryId,
      amount: budget.month === 9 && addition.categoryId === categories[0].id ? 4000 : addition.amount,
      memo: addition.memo
    }))
  }));
  database.saveBudgetSettings({
    categoryBudgets: nextYearCategoryBudgets,
    monthlyBudgets: nextYearMonthlyBudgets
  });
  assert.equal(database.getMonth("2026-09").monthlyBudget, 58250);
  assert.equal(database.getMonth("2027-09").monthlyBudget, 69250);
  assert.deepEqual(database.getMonth("2026-09").categoryBudgets.map(({ categoryId, amount }) => [categoryId, amount]), [
    [categories[0].id, 23000],
    [categories[1].id, 250],
    [categories[7].id, 35000]
  ]);
  assert.deepEqual(database.getMonth("2027-09").categoryBudgets.map(({ categoryId, amount }) => [categoryId, amount]), [
    [categories[0].id, 29000],
    [categories[1].id, 250],
    [categories[7].id, 40000]
  ]);

  const yearlyBackup = database.exportJson();
  const yearlyBackupRoot = mkdtempSync(`${tmpdir()}\\household-ledger-yearly-restore-`);
  try {
    const yearlyRestored = new HouseholdDatabase(yearlyBackupRoot, projectRoot, "", () => 2027);
    await yearlyRestored.initialize();
    yearlyRestored.restoreJson(yearlyBackup);
    assert.equal(yearlyRestored.getMonth("2026-09").monthlyBudget, 58250);
    assert.equal(yearlyRestored.getMonth("2027-09").monthlyBudget, 69250);
  } finally {
    rmSync(yearlyBackupRoot, { recursive: true, force: true });
  }

  console.log("database integration test passed");
} finally {
  rmSync(temporaryRoot, { recursive: true, force: true });
}
