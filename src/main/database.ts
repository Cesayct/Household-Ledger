import initSqlJs, { type Database as SqlDatabase } from "sql.js";
import {
  addDays,
  formatDateJa,
  getMonthRange,
  getWeekRange,
  getWeekStart,
  isValidDateKey,
  monthKey,
  parseDateKey,
  toDateKey
} from "../shared/date";
import type {
  BackupSnapshot,
  BudgetSettings,
  BudgetSettingsInput,
  CategoryBudgetSetting,
  Category,
  CategoryAmount,
  DashboardData,
  Expense,
  ExpenseInput,
  LegacyBackupSnapshot,
  MonthView,
  MonthlyBudgetAddition,
  MonthlyBudget,
  PaymentMethod,
  RestoreResult,
  WeekView
} from "../shared/types";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  unlinkSync,
  writeFileSync
} from "node:fs";
import { dirname, extname, join, resolve, sep } from "node:path";

type SqlParam = string | number | null;

type LegacyMonthlyBudget = {
  month: number;
  amount: number | null;
  memo: string;
};

const DEFAULT_CATEGORIES = [
  ["食費", "#e76f51"],
  ["日用品", "#f4a261"],
  ["交通費", "#2a9d8f"],
  ["光熱費", "#457b9d"],
  ["住居費", "#6d597a"],
  ["通信費", "#5e60ce"],
  ["娯楽費", "#e9c46a"],
  ["医療費", "#d62828"],
  ["衣服費", "#b56576"],
  ["交際費", "#8ab17d"],
  ["その他", "#64748b"]
] as const;

const DEFAULT_PAYMENT_METHODS = ["現金", "クレジットカード", "電子マネー", "銀行振込", "その他"] as const;

const nowIso = () => new Date().toISOString();

const toNumber = (value: unknown): number => Number(value ?? 0);

const toBoolean = (value: unknown): boolean => Boolean(Number(value));

const escapeCsv = (value: unknown): string => {
  const text = value == null ? "" : String(value);
  return /[",\r\n]/.test(text) ? `"${text.replaceAll('"', '""')}"` : text;
};

const ensureDirectory = (path: string) => {
  if (!existsSync(path)) mkdirSync(path, { recursive: true });
};

export class HouseholdDatabase {
  private database!: SqlDatabase;
  private readonly databasePath: string;
  private readonly receiptsDirectory: string;
  private readonly appPath: string;
  private readonly resourcesPath: string;

  constructor(userDataPath: string, appPath: string, resourcesPath: string) {
    this.databasePath = join(userDataPath, "household-ledger.sqlite");
    this.receiptsDirectory = join(userDataPath, "receipts");
    this.appPath = appPath;
    this.resourcesPath = resourcesPath;
  }

  async initialize(): Promise<void> {
    ensureDirectory(dirname(this.databasePath));
    ensureDirectory(this.receiptsDirectory);

    const wasmCandidates = [
      join(this.resourcesPath, "sql.js", "sql-wasm.wasm"),
      join(this.resourcesPath, "app.asar.unpacked", "node_modules", "sql.js", "dist", "sql-wasm.wasm"),
      join(this.appPath, "node_modules", "sql.js", "dist", "sql-wasm.wasm"),
      join(dirname(this.databasePath), "sql-wasm.wasm")
    ];
    const wasmPath = wasmCandidates.find((candidate) => existsSync(candidate));
    const SQL = await initSqlJs({ locateFile: () => wasmPath ?? "sql-wasm.wasm" });
    const existing = existsSync(this.databasePath) ? readFileSync(this.databasePath) : undefined;
    this.database = existing ? new SQL.Database(existing) : new SQL.Database();
    this.database.run("PRAGMA foreign_keys = ON;");
    this.createSchema();
    this.seedDefaults();
    this.migrateLegacyBudgetSettings();
    this.persist();
  }

  private createSchema(): void {
    this.database.run(`
      CREATE TABLE IF NOT EXISTS categories (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        name TEXT NOT NULL UNIQUE,
        color TEXT NOT NULL,
        sort_order INTEGER NOT NULL DEFAULT 0,
        is_active INTEGER NOT NULL DEFAULT 1 CHECK (is_active IN (0, 1))
      );

      CREATE TABLE IF NOT EXISTS payment_methods (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        name TEXT NOT NULL UNIQUE,
        sort_order INTEGER NOT NULL DEFAULT 0,
        is_active INTEGER NOT NULL DEFAULT 1 CHECK (is_active IN (0, 1))
      );

      CREATE TABLE IF NOT EXISTS monthly_budgets (
        month INTEGER PRIMARY KEY CHECK (month BETWEEN 1 AND 12),
        amount INTEGER NOT NULL CHECK (amount >= 0),
        updated_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS monthly_budget_memos (
        month INTEGER PRIMARY KEY CHECK (month BETWEEN 1 AND 12),
        memo TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS common_budgets (
        id INTEGER PRIMARY KEY CHECK (id = 1),
        amount INTEGER NOT NULL CHECK (amount > 0),
        updated_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS category_budgets (
        category_id INTEGER PRIMARY KEY,
        amount INTEGER NOT NULL CHECK (amount BETWEEN 1 AND 1000000000),
        updated_at TEXT NOT NULL,
        FOREIGN KEY (category_id) REFERENCES categories(id)
      );

      CREATE TABLE IF NOT EXISTS monthly_budget_additions (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        month INTEGER NOT NULL CHECK (month BETWEEN 1 AND 12),
        category_id INTEGER NOT NULL,
        amount INTEGER NOT NULL CHECK (amount BETWEEN -1000000000 AND 1000000000),
        memo TEXT NOT NULL DEFAULT '',
        updated_at TEXT NOT NULL,
        FOREIGN KEY (category_id) REFERENCES categories(id)
      );

      CREATE INDEX IF NOT EXISTS idx_monthly_budget_additions_month
        ON monthly_budget_additions(month, id);

      CREATE TABLE IF NOT EXISTS budget_settings_migrations (
        id INTEGER PRIMARY KEY CHECK (id = 1),
        migrated_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS expenses (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        spent_date TEXT NOT NULL,
        amount INTEGER NOT NULL CHECK (amount >= 1),
        category_id INTEGER NOT NULL,
        payment_method_id INTEGER,
        memo TEXT NOT NULL DEFAULT '',
        receipt_image_path TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        FOREIGN KEY (category_id) REFERENCES categories(id),
        FOREIGN KEY (payment_method_id) REFERENCES payment_methods(id)
      );

      CREATE INDEX IF NOT EXISTS idx_expenses_spent_date ON expenses(spent_date);
      CREATE INDEX IF NOT EXISTS idx_expenses_category_id ON expenses(category_id);
    `);
  }

  private seedDefaults(): void {
    const categoryCount = this.scalar("SELECT COUNT(*) AS count FROM categories");
    if (categoryCount === 0) {
      DEFAULT_CATEGORIES.forEach(([name, color], index) => {
        this.run(
          "INSERT INTO categories (name, color, sort_order, is_active) VALUES (?, ?, ?, 1)",
          [name, color, index]
        );
      });
    }

    const paymentMethodCount = this.scalar("SELECT COUNT(*) AS count FROM payment_methods");
    if (paymentMethodCount === 0) {
      DEFAULT_PAYMENT_METHODS.forEach((name, index) => {
        this.run(
          "INSERT INTO payment_methods (name, sort_order, is_active) VALUES (?, ?, 1)",
          [name, index]
        );
      });
    }
  }

  private scalar(sql: string, params: SqlParam[] = []): number {
    const rows = this.query<{ value: unknown }>(sql.replace("count", "value"), params);
    return rows.length ? toNumber(rows[0].value) : 0;
  }

  private run(sql: string, params: SqlParam[] = []): void {
    this.database.run(sql, params);
  }

  private query<T extends Record<string, unknown>>(sql: string, params: SqlParam[] = []): T[] {
    const statement = this.database.prepare(sql);
    try {
      statement.bind(params);
      const rows: T[] = [];
      while (statement.step()) rows.push(statement.getAsObject() as T);
      return rows;
    } finally {
      statement.free();
    }
  }

  private persist(): void {
    const bytes = this.database.export();
    writeFileSync(this.databasePath, Buffer.from(bytes));
  }

  private transaction<T>(callback: () => T): T {
    this.database.run("BEGIN TRANSACTION");
    try {
      const result = callback();
      this.database.run("COMMIT");
      this.persist();
      return result;
    } catch (error) {
      this.database.run("ROLLBACK");
      throw error;
    }
  }

  private categoryFromRow(row: Record<string, unknown>): Category {
    return {
      id: toNumber(row.id),
      name: String(row.name),
      color: String(row.color),
      sortOrder: toNumber(row.sort_order),
      isActive: toBoolean(row.is_active)
    };
  }

  private paymentMethodFromRow(row: Record<string, unknown>): PaymentMethod {
    return {
      id: toNumber(row.id),
      name: String(row.name),
      sortOrder: toNumber(row.sort_order),
      isActive: toBoolean(row.is_active)
    };
  }

  private expenseFromRow(row: Record<string, unknown>): Expense {
    return {
      id: toNumber(row.id),
      spentDate: String(row.spent_date),
      amount: toNumber(row.amount),
      categoryId: toNumber(row.category_id),
      categoryName: String(row.category_name),
      categoryColor: String(row.category_color),
      paymentMethodId: row.payment_method_id == null ? null : toNumber(row.payment_method_id),
      paymentMethodName: row.payment_method_name == null ? null : String(row.payment_method_name),
      memo: String(row.memo ?? ""),
      receiptImagePath: row.receipt_image_path == null ? null : String(row.receipt_image_path),
      createdAt: String(row.created_at),
      updatedAt: String(row.updated_at)
    };
  }

  listCategories(includeInactive = false): Category[] {
    const condition = includeInactive ? "" : "WHERE is_active = 1";
    return this.query<Record<string, unknown>>(
      `SELECT id, name, color, sort_order, is_active FROM categories ${condition} ORDER BY sort_order, id`
    ).map((row) => this.categoryFromRow(row));
  }

  createCategory(input: { name: string; color: string }): Category {
    const name = input.name.trim();
    if (!name) throw new Error("カテゴリ名を入力してください。");
    if (!/^#[0-9a-fA-F]{6}$/.test(input.color)) throw new Error("カテゴリ色が正しくありません。");
    try {
      return this.transaction(() => {
        const sortOrder = this.scalar("SELECT COALESCE(MAX(sort_order), -1) + 1 AS count FROM categories");
        this.run("INSERT INTO categories (name, color, sort_order, is_active) VALUES (?, ?, ?, 1)", [
          name,
          input.color,
          sortOrder
        ]);
        const id = this.scalar("SELECT last_insert_rowid() AS count");
        return this.listCategories(true).find((category) => category.id === id)!;
      });
    } catch (error) {
      if (String(error).includes("UNIQUE")) throw new Error("同じ名前のカテゴリが既にあります。");
      throw error;
    }
  }

  updateCategory(id: number, input: { name: string; color: string; isActive: boolean }): Category {
    const name = input.name.trim();
    if (!name) throw new Error("カテゴリ名を入力してください。");
    if (!/^#[0-9a-fA-F]{6}$/.test(input.color)) throw new Error("カテゴリ色が正しくありません。");
    try {
      return this.transaction(() => {
        this.run("UPDATE categories SET name = ?, color = ?, is_active = ? WHERE id = ?", [
          name,
          input.color,
          input.isActive ? 1 : 0,
          id
        ]);
        const row = this.query<Record<string, unknown>>(
          "SELECT id, name, color, sort_order, is_active FROM categories WHERE id = ?",
          [id]
        )[0];
        if (!row) throw new Error("カテゴリが見つかりません。");
        return this.categoryFromRow(row);
      });
    } catch (error) {
      if (String(error).includes("UNIQUE")) throw new Error("同じ名前のカテゴリが既にあります。");
      throw error;
    }
  }

  reorderCategories(ids: number[]): Category[] {
    return this.transaction(() => {
      ids.forEach((id, index) => this.run("UPDATE categories SET sort_order = ? WHERE id = ?", [index, id]));
      return this.listCategories(true);
    });
  }

  listPaymentMethods(includeInactive = false): PaymentMethod[] {
    const condition = includeInactive ? "" : "WHERE is_active = 1";
    return this.query<Record<string, unknown>>(
      `SELECT id, name, sort_order, is_active FROM payment_methods ${condition} ORDER BY sort_order, id`
    ).map((row) => this.paymentMethodFromRow(row));
  }

  createPaymentMethod(input: { name: string }): PaymentMethod {
    const name = input.name.trim();
    if (!name) throw new Error("支払い方法名を入力してください。");
    try {
      return this.transaction(() => {
        const sortOrder = this.scalar("SELECT COALESCE(MAX(sort_order), -1) + 1 AS count FROM payment_methods");
        this.run("INSERT INTO payment_methods (name, sort_order, is_active) VALUES (?, ?, 1)", [name, sortOrder]);
        const id = this.scalar("SELECT last_insert_rowid() AS count");
        return this.listPaymentMethods(true).find((method) => method.id === id)!;
      });
    } catch (error) {
      if (String(error).includes("UNIQUE")) throw new Error("同じ名前の支払い方法が既にあります。");
      throw error;
    }
  }

  updatePaymentMethod(id: number, input: { name: string; isActive: boolean }): PaymentMethod {
    const name = input.name.trim();
    if (!name) throw new Error("支払い方法名を入力してください。");
    try {
      return this.transaction(() => {
        this.run("UPDATE payment_methods SET name = ?, is_active = ? WHERE id = ?", [
          name,
          input.isActive ? 1 : 0,
          id
        ]);
        const row = this.query<Record<string, unknown>>(
          "SELECT id, name, sort_order, is_active FROM payment_methods WHERE id = ?",
          [id]
        )[0];
        if (!row) throw new Error("支払い方法が見つかりません。");
        return this.paymentMethodFromRow(row);
      });
    } catch (error) {
      if (String(error).includes("UNIQUE")) throw new Error("同じ名前の支払い方法が既にあります。");
      throw error;
    }
  }

  private migrateLegacyBudgetSettings(): void {
    if (this.scalar("SELECT COUNT(*) AS count FROM budget_settings_migrations WHERE id = 1") > 0) return;

    this.transaction(() => {
      const newBudgetRows =
        this.scalar("SELECT COUNT(*) AS count FROM category_budgets") +
        this.scalar("SELECT COUNT(*) AS count FROM monthly_budget_additions");
      if (newBudgetRows === 0) {
        const oldCommon = this.query<Record<string, unknown>>(
          "SELECT amount FROM common_budgets WHERE id = 1"
        )[0];
        const oldMonthly = this.query<Record<string, unknown>>(
          "SELECT month, amount FROM monthly_budgets ORDER BY month"
        );
        const oldMemos = this.query<Record<string, unknown>>(
          "SELECT month, memo FROM monthly_budget_memos ORDER BY month"
        );
        const commonAmount = oldCommon ? toNumber(oldCommon.amount) : 0;
        const hasLegacySettings = commonAmount > 0 || oldMonthly.length > 0 || oldMemos.length > 0;
        const fallbackCategory = hasLegacySettings
          ? this.listCategories(true).find((category) => category.name === "その他") ?? this.listCategories(true)[0]
          : undefined;

        if (hasLegacySettings && !fallbackCategory) {
          throw new Error("旧予算を移行するカテゴリがありません。");
        }

        if (fallbackCategory && commonAmount > 0) {
          this.run(
            "INSERT INTO category_budgets (category_id, amount, updated_at) VALUES (?, ?, ?)",
            [fallbackCategory.id, commonAmount, nowIso()]
          );
        }

        if (fallbackCategory) {
          const amountByMonth = new Map(oldMonthly.map((row) => [toNumber(row.month), toNumber(row.amount)]));
          const memoByMonth = new Map(oldMemos.map((row) => [toNumber(row.month), String(row.memo ?? "")]));
          const legacyMonths = new Set([...amountByMonth.keys(), ...memoByMonth.keys()]);
          for (const month of legacyMonths) {
            const oldAmount = amountByMonth.get(month);
            const adjustment = oldAmount == null ? 0 : oldAmount - commonAmount;
            const memo = (memoByMonth.get(month) ?? "").replace(/[\r\n\t]+/g, " ").trim();
            if (adjustment !== 0 || memo) {
              this.run(
                `INSERT INTO monthly_budget_additions (month, category_id, amount, memo, updated_at)
                 VALUES (?, ?, ?, ?, ?)`,
                [month, fallbackCategory.id, adjustment, memo || "旧月別予算から移行", nowIso()]
              );
            }
          }
        }
      }

      this.run("INSERT INTO budget_settings_migrations (id, migrated_at) VALUES (1, ?)", [nowIso()]);
    });
  }

  listCommonCategoryBudgets(): CategoryBudgetSetting[] {
    const amounts = new Map(
      this.query<Record<string, unknown>>("SELECT category_id, amount FROM category_budgets")
        .map((row) => [toNumber(row.category_id), toNumber(row.amount)])
    );
    return this.listCategories(true).map((category) => ({
      categoryId: category.id,
      amount: amounts.get(category.id) ?? null
    }));
  }

  listMonthlyBudgetSettings(): MonthlyBudget[] {
    const rows = this.query<Record<string, unknown>>(
      `SELECT b.id, b.month, b.category_id, c.name AS category_name, b.amount, b.memo
       FROM monthly_budget_additions b
       JOIN categories c ON c.id = b.category_id
       ORDER BY b.month, b.id`
    );
    const additionsByMonth = new Map<number, MonthlyBudgetAddition[]>();
    rows.forEach((row) => {
      const month = toNumber(row.month);
      const additions = additionsByMonth.get(month) ?? [];
      additions.push({
        id: toNumber(row.id),
        categoryId: toNumber(row.category_id),
        categoryName: String(row.category_name),
        amount: toNumber(row.amount),
        memo: String(row.memo ?? "")
      });
      additionsByMonth.set(month, additions);
    });
    return Array.from({ length: 12 }, (_, index) => ({
      month: index + 1,
      additions: additionsByMonth.get(index + 1) ?? []
    }));
  }

  getBudgetSettings(): BudgetSettings {
    return {
      categoryBudgets: this.listCommonCategoryBudgets(),
      monthlyBudgets: this.listMonthlyBudgetSettings()
    };
  }

  saveBudgetSettings(settings: BudgetSettingsInput): void {
    if (!settings || !Array.isArray(settings.categoryBudgets) || !Array.isArray(settings.monthlyBudgets)) {
      throw new Error("Budget settings are invalid.");
    }
    const categoryIds = new Set(this.listCategories(true).map((category) => category.id));
    const seenCategoryBudgets = new Set<number>();
    settings.categoryBudgets.forEach((budget) => {
      if (!Number.isInteger(budget.categoryId) || !categoryIds.has(budget.categoryId) || seenCategoryBudgets.has(budget.categoryId)) {
        throw new Error("共通予算のカテゴリ設定が正しくありません。");
      }
      if (budget.amount != null && (!Number.isSafeInteger(budget.amount) || budget.amount < 0 || budget.amount > 1_000_000_000)) {
        throw new Error("カテゴリ共通予算は0円以上、1,000,000,000円以下の整数で入力してください。");
      }
      seenCategoryBudgets.add(budget.categoryId);
    });

    const seenMonths = new Set<number>();
    settings.monthlyBudgets.forEach((budget) => {
      if (!Number.isInteger(budget.month) || budget.month < 1 || budget.month > 12 || seenMonths.has(budget.month)) {
        throw new Error("月別予算の月指定が正しくありません。");
      }
      if (!Array.isArray(budget.additions)) throw new Error("月別追加予算の形式が正しくありません。");
      budget.additions.forEach((addition) => {
        if (!Number.isInteger(addition.categoryId) || !categoryIds.has(addition.categoryId)) {
          throw new Error("月別追加予算のカテゴリを選択してください。");
        }
        if (!Number.isSafeInteger(addition.amount) || Math.abs(addition.amount) > 1_000_000_000) {
          throw new Error("月別予算の金額は±1,000,000,000円以内の整数で入力してください。");
        }
        if (typeof addition.memo !== "string" || addition.memo.length > 100) {
          throw new Error("月別予算の補足メモは100文字以内で入力してください。");
        }
      });
      seenMonths.add(budget.month);
    });
    if (seenCategoryBudgets.size !== categoryIds.size || seenMonths.size !== 12) {
      throw new Error("すべてのカテゴリと1月から12月までの設定を送信してください。");
    }

    this.transaction(() => {
      this.run("DELETE FROM category_budgets");
      this.run("DELETE FROM monthly_budget_additions");
      settings.categoryBudgets.forEach((budget) => {
        if (budget.amount != null && budget.amount > 0) {
          this.run(
            "INSERT INTO category_budgets (category_id, amount, updated_at) VALUES (?, ?, ?)",
            [budget.categoryId, budget.amount, nowIso()]
          );
        }
      });
      settings.monthlyBudgets.forEach((budget) => {
        budget.additions.forEach((addition) => {
          const memo = addition.memo.replace(/[\r\n\t]+/g, " ").trim();
          if (addition.amount !== 0 || memo) {
            this.run(
              `INSERT INTO monthly_budget_additions (month, category_id, amount, memo, updated_at)
               VALUES (?, ?, ?, ?, ?)`,
              [budget.month, addition.categoryId, addition.amount, memo, nowIso()]
            );
          }
        });
      });
    });
  }

  listMonthlyBudgets(): LegacyMonthlyBudget[] {
    const rows = this.query<Record<string, unknown>>(
      "SELECT month, amount FROM monthly_budgets ORDER BY month"
    );
    const amounts = new Map(rows.map((row) => [toNumber(row.month), toNumber(row.amount)]));
    const memoRows = this.query<Record<string, unknown>>(
      "SELECT month, memo FROM monthly_budget_memos ORDER BY month"
    );
    const memos = new Map(memoRows.map((row) => [toNumber(row.month), String(row.memo ?? "")]));
    return Array.from({ length: 12 }, (_, index) => ({
      month: index + 1,
      amount: amounts.has(index + 1) && amounts.get(index + 1)! > 0 ? amounts.get(index + 1)! : null,
      memo: memos.get(index + 1) ?? ""
    }));
  }

  updateMonthlyBudget(month: number, amount: number | null, memo = ""): LegacyMonthlyBudget {
    if (!Number.isInteger(month) || month < 1 || month > 12) {
      throw new Error("予算の月が正しくありません。");
    }
    if (amount != null && (!Number.isInteger(amount) || amount < 0 || amount > 1_000_000_000)) {
      throw new Error("予算は0円以上の整数で入力してください。");
    }
    if (typeof memo !== "string") throw new Error("月別メモが正しくありません。");
    const normalizedMemo = memo.replace(/[\r\n\t]+/g, " ").trim();
    if (normalizedMemo.length > 100) throw new Error("月別メモは100文字以内で入力してください。");
    return this.transaction(() => {
      if (amount == null || amount === 0) {
        this.run("DELETE FROM monthly_budgets WHERE month = ?", [month]);
      } else {
        this.run(
          `INSERT INTO monthly_budgets (month, amount, updated_at) VALUES (?, ?, ?)
           ON CONFLICT(month) DO UPDATE SET amount = excluded.amount, updated_at = excluded.updated_at`,
          [month, amount, nowIso()]
        );
      }
      if (normalizedMemo) {
        this.run(
          `INSERT INTO monthly_budget_memos (month, memo, updated_at) VALUES (?, ?, ?)
           ON CONFLICT(month) DO UPDATE SET memo = excluded.memo, updated_at = excluded.updated_at`,
          [month, normalizedMemo, nowIso()]
        );
      } else {
        this.run("DELETE FROM monthly_budget_memos WHERE month = ?", [month]);
      }
      return { month, amount: amount == null || amount === 0 ? null : amount, memo: normalizedMemo };
    });
  }

  getCommonBudget(): number | null {
    const amount = this.scalar("SELECT COALESCE(SUM(amount), 0) AS count FROM category_budgets");
    return amount > 0 ? amount : null;
  }

  updateCommonBudget(amount: number | null): number | null {
    if (amount != null && (!Number.isInteger(amount) || amount < 0 || amount > 1_000_000_000)) {
      throw new Error("共通予算は0円以上の整数で入力してください。");
    }
    return this.transaction(() => {
      if (amount == null || amount === 0) {
        this.run("DELETE FROM common_budgets WHERE id = 1");
        return null;
      }
      this.run(
        `INSERT INTO common_budgets (id, amount, updated_at) VALUES (1, ?, ?)
         ON CONFLICT(id) DO UPDATE SET amount = excluded.amount, updated_at = excluded.updated_at`,
        [amount, nowIso()]
      );
      return amount;
    });
  }

  private legacyMonthlyBudgetForMonth(month: string): { amount: number | null; memo: string } {
    const monthNumber = Number(month.slice(5, 7));
    if (!Number.isInteger(monthNumber) || monthNumber < 1 || monthNumber > 12) {
      return { amount: null, memo: "" };
    }
    const row = this.query<Record<string, unknown>>(
      `SELECT
         (SELECT amount FROM monthly_budgets WHERE month = ?) AS amount,
         (SELECT memo FROM monthly_budget_memos WHERE month = ?) AS memo`,
      [monthNumber, monthNumber]
    )[0];
    const monthAmount = row?.amount == null ? null : toNumber(row.amount);
    return {
      amount: monthAmount != null && monthAmount > 0 ? monthAmount : this.getCommonBudget(),
      memo: String(row?.memo ?? "")
    };
  }

  private monthlyBudgetForMonth(month: string): { amount: number | null; memo: string } {
    const monthNumber = Number(month.slice(5, 7));
    if (!Number.isInteger(monthNumber) || monthNumber < 1 || monthNumber > 12) {
      return { amount: null, memo: "" };
    }
    const additions = this.query<Record<string, unknown>>(
      `SELECT SUM(CASE WHEN amount <> 0 THEN 1 ELSE 0 END) AS count, COALESCE(SUM(amount), 0) AS amount
       FROM monthly_budget_additions WHERE month = ?`,
      [monthNumber]
    )[0];
    const commonBudget = this.getCommonBudget();
    const hasAdditions = toNumber(additions?.count) > 0;
    if (commonBudget == null && !hasAdditions) return { amount: null, memo: "" };
    return {
      amount: (commonBudget ?? 0) + toNumber(additions?.amount),
      memo: ""
    };
  }

  private validateExpenseInput(input: ExpenseInput): void {
    if (!isValidDateKey(input.spentDate)) throw new Error("使用日を正しく入力してください。");
    if (!Number.isInteger(input.amount) || input.amount < 1) throw new Error("金額は1円以上の整数で入力してください。");
    const category = this.query<{ id: unknown }>("SELECT id FROM categories WHERE id = ?", [input.categoryId]);
    if (!category.length) throw new Error("カテゴリを選択してください。");
    if (input.paymentMethodId != null) {
      const paymentMethod = this.query<{ id: unknown }>("SELECT id FROM payment_methods WHERE id = ?", [
        input.paymentMethodId
      ]);
      if (!paymentMethod.length) throw new Error("支払い方法が正しくありません。");
    }
  }

  private expenseById(id: number): Expense {
    const row = this.query<Record<string, unknown>>(
      `SELECT e.id, e.spent_date, e.amount, e.category_id, c.name AS category_name, c.color AS category_color,
              e.payment_method_id, p.name AS payment_method_name, e.memo, e.receipt_image_path,
              e.created_at, e.updated_at
       FROM expenses e
       JOIN categories c ON c.id = e.category_id
       LEFT JOIN payment_methods p ON p.id = e.payment_method_id
       WHERE e.id = ?`,
      [id]
    )[0];
    if (!row) throw new Error("支出が見つかりません。");
    return this.expenseFromRow(row);
  }

  listExpenses(filters: { dateFrom?: string; dateTo?: string; limit?: number } = {}): Expense[] {
    const conditions: string[] = [];
    const params: SqlParam[] = [];
    if (filters.dateFrom) {
      conditions.push("e.spent_date >= ?");
      params.push(filters.dateFrom);
    }
    if (filters.dateTo) {
      conditions.push("e.spent_date <= ?");
      params.push(filters.dateTo);
    }
    const where = conditions.length ? `WHERE ${conditions.join(" AND ")}` : "";
    const limit = filters.limit == null ? "" : " LIMIT ?";
    if (filters.limit != null) params.push(Math.max(1, Math.floor(filters.limit)));
    return this.query<Record<string, unknown>>(
      `SELECT e.id, e.spent_date, e.amount, e.category_id, c.name AS category_name, c.color AS category_color,
              e.payment_method_id, p.name AS payment_method_name, e.memo, e.receipt_image_path,
              e.created_at, e.updated_at
       FROM expenses e
       JOIN categories c ON c.id = e.category_id
       LEFT JOIN payment_methods p ON p.id = e.payment_method_id
       ${where}
       ORDER BY e.spent_date DESC, e.id DESC${limit}`,
      params
    ).map((row) => this.expenseFromRow(row));
  }

  createExpense(input: ExpenseInput): Expense {
    this.validateExpenseInput(input);
    const createdAt = nowIso();
    let id = 0;
    this.transaction(() => {
      this.run(
        `INSERT INTO expenses (spent_date, amount, category_id, payment_method_id, memo, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
        [input.spentDate, input.amount, input.categoryId, input.paymentMethodId, input.memo.trim(), createdAt, createdAt]
      );
      id = this.scalar("SELECT last_insert_rowid() AS count");
    });
    if (input.receiptImageDataUrl) this.attachReceiptImage(id, input.receiptImageDataUrl);
    return this.expenseById(id);
  }

  updateExpense(id: number, input: ExpenseInput): Expense {
    this.validateExpenseInput(input);
    const updatedAt = nowIso();
    this.transaction(() => {
      const existing = this.expenseById(id);
      this.run(
        `UPDATE expenses
         SET spent_date = ?, amount = ?, category_id = ?, payment_method_id = ?, memo = ?, updated_at = ?
         WHERE id = ?`,
        [
          input.spentDate,
          input.amount,
          input.categoryId,
          input.paymentMethodId,
          input.memo.trim(),
          updatedAt,
          id
        ]
      );
      if (!existing) throw new Error("支出が見つかりません。");
    });
    if (input.receiptImageDataUrl) this.attachReceiptImage(id, input.receiptImageDataUrl);
    return this.expenseById(id);
  }

  deleteExpense(id: number): void {
    const existing = this.expenseById(id);
    this.transaction(() => this.run("DELETE FROM expenses WHERE id = ?", [id]));
    if (existing.receiptImagePath) {
      const candidate = resolve(existing.receiptImagePath);
      const root = resolve(this.receiptsDirectory);
      if (candidate.startsWith(`${root}${sep}`) && existsSync(candidate)) unlinkSync(candidate);
    }
  }

  private amountRows(start: string, end: string): Array<{ date: string; amount: number }> {
    return this.query<Record<string, unknown>>(
      "SELECT spent_date AS date, SUM(amount) AS amount FROM expenses WHERE spent_date BETWEEN ? AND ? GROUP BY spent_date ORDER BY spent_date",
      [start, end]
    ).map((row) => ({ date: String(row.date), amount: toNumber(row.amount) }));
  }

  private total(start: string, end: string): number {
    const row = this.query<Record<string, unknown>>(
      "SELECT COALESCE(SUM(amount), 0) AS total FROM expenses WHERE spent_date BETWEEN ? AND ?",
      [start, end]
    )[0];
    return toNumber(row?.total);
  }

  private categoryAmounts(start: string, end: string): CategoryAmount[] {
    const rows = this.query<Record<string, unknown>>(
      `SELECT c.id AS category_id, c.name AS category_name, c.color, SUM(e.amount) AS amount
       FROM expenses e
       JOIN categories c ON c.id = e.category_id
       WHERE e.spent_date BETWEEN ? AND ?
       GROUP BY c.id, c.name, c.color
       ORDER BY amount DESC, c.sort_order, c.id`,
      [start, end]
    );
    const total = rows.reduce((sum, row) => sum + toNumber(row.amount), 0);
    return rows.map((row) => ({
      categoryId: toNumber(row.category_id),
      categoryName: String(row.category_name),
      color: String(row.color),
      amount: toNumber(row.amount),
      percentage: total ? (toNumber(row.amount) / total) * 100 : 0
    }));
  }

  getDashboard(referenceDate: string): DashboardData {
    if (!isValidDateKey(referenceDate)) throw new Error("基準日が正しくありません。");
    const week = getWeekRange(referenceDate);
    const month = getMonthRange(monthKey(referenceDate));
    const elapsedDays = parseDateKey(referenceDate).getDate();
    const dailyRows = this.amountRows(month.start, month.end);
    const dailyMap = new Map(dailyRows.map((row) => [row.date, row.amount]));
    const dailyAmounts = Array.from({ length: month.days }, (_, index) => {
      const date = addDays(month.start, index);
      return { date, label: formatDateJa(date), amount: dailyMap.get(date) ?? 0 };
    });
    const monthTotal = this.total(month.start, month.end);
    const budget = this.monthlyBudgetForMonth(monthKey(referenceDate));
    return {
      referenceDate,
      todayTotal: this.total(referenceDate, referenceDate),
      weekTotal: this.total(week.start, week.end),
      monthTotal,
      monthlyBudget: budget.amount,
      monthlyBudgetMemo: budget.memo,
      monthlyDifference: budget.amount == null ? null : budget.amount - monthTotal,
      monthlyAverage: elapsedDays ? monthTotal / elapsedDays : 0,
      monthDaysElapsed: elapsedDays,
      categoryAmounts: this.categoryAmounts(month.start, month.end),
      dailyAmounts,
      recentExpenses: this.listExpenses({ limit: 8 })
    };
  }

  getWeek(weekStart: string): WeekView {
    if (!isValidDateKey(weekStart) || getWeekStart(weekStart) !== weekStart) {
      throw new Error("週の開始日が正しくありません。");
    }
    const range = getWeekRange(weekStart);
    const dailyRows = this.amountRows(range.start, range.end);
    const dailyMap = new Map(dailyRows.map((row) => [row.date, row.amount]));
    const expenses = this.listExpenses({ dateFrom: range.start, dateTo: range.end });
    const byDay = new Map<string, Expense[]>();
    expenses.forEach((expense) => {
      const list = byDay.get(expense.spentDate) ?? [];
      list.push(expense);
      byDay.set(expense.spentDate, list);
    });
    const days = Array.from({ length: 7 }, (_, index) => {
      const date = addDays(range.start, index);
      return {
        date,
        label: formatDateJa(date),
        total: dailyMap.get(date) ?? 0,
        expenses: byDay.get(date) ?? []
      };
    });
    return { weekStart: range.start, weekEnd: range.end, total: this.total(range.start, range.end), days };
  }

  getMonth(month: string): MonthView {
    const range = getMonthRange(month);
    const expenses = this.listExpenses({ dateFrom: range.start, dateTo: range.end });
    const dailyRows = this.amountRows(range.start, range.end);
    const dailyMap = new Map(dailyRows.map((row) => [row.date, row.amount]));
    const weekAmounts = [];
    let weekStart = getWeekStart(range.start);
    while (weekStart <= range.end) {
      const weekEnd = addDays(weekStart, 6);
      let total = 0;
      for (let date = weekStart < range.start ? range.start : weekStart; date <= weekEnd && date <= range.end; date = addDays(date, 1)) {
        total += dailyMap.get(date) ?? 0;
      }
      weekAmounts.push({
        weekStart,
        weekEnd,
        label: `${formatDateJa(weekStart)}〜${formatDateJa(weekEnd)}`,
        amount: total
      });
      weekStart = addDays(weekStart, 7);
    }
    const monthTotal = this.total(range.start, range.end);
    const budget = this.monthlyBudgetForMonth(month);
    return {
      month,
      total: monthTotal,
      monthlyBudget: budget.amount,
      monthlyBudgetMemo: budget.memo,
      monthlyDifference: budget.amount == null ? null : budget.amount - monthTotal,
      categoryAmounts: this.categoryAmounts(range.start, range.end),
      weekAmounts,
      expenses
    };
  }

  private attachReceiptImage(id: number, dataUrl: string): void {
    const match = /^data:(image\/[a-zA-Z0-9.+-]+);base64,(.+)$/.exec(dataUrl);
    if (!match) throw new Error("レシート画像の形式を読み取れません。");
    const mimeType = match[1].toLowerCase();
    const extension = mimeType.includes("png") ? ".png" : mimeType.includes("webp") ? ".webp" : ".jpg";
    const filePath = join(this.receiptsDirectory, `receipt-${id}${extension}`);
    writeFileSync(filePath, Buffer.from(match[2], "base64"));
    this.transaction(() => {
      this.run("UPDATE expenses SET receipt_image_path = ?, updated_at = ? WHERE id = ?", [filePath, nowIso(), id]);
    });
  }

  private backupSnapshot(): BackupSnapshot {
    const categories = this.listCategories(true);
    const paymentMethods = this.listPaymentMethods(true);
    const budgetSettings = this.getBudgetSettings();
    const categoryBudgets = budgetSettings.categoryBudgets
      .filter((budget): budget is CategoryBudgetSetting & { amount: number } => budget.amount != null)
      .map((budget) => ({ categoryId: budget.categoryId, amount: budget.amount }));
    const monthlyBudgetAdditions = budgetSettings.monthlyBudgets.flatMap((budget) =>
      budget.additions.map(({ categoryId, amount, memo }) => ({
        month: budget.month,
        categoryId,
        amount,
        memo
      }))
    );
    const rows = this.query<Record<string, unknown>>(
      `SELECT id, spent_date, amount, category_id, payment_method_id, memo, receipt_image_path, created_at, updated_at
       FROM expenses ORDER BY spent_date, id`
    );
    const expenses = rows.map((row) => {
      const imagePath = row.receipt_image_path == null ? null : String(row.receipt_image_path);
      const image = imagePath && existsSync(imagePath)
        ? {
            mimeType: imagePath.endsWith(".png") ? "image/png" : imagePath.endsWith(".webp") ? "image/webp" : "image/jpeg",
            base64: readFileSync(imagePath).toString("base64")
          }
        : undefined;
      return {
        id: toNumber(row.id),
        spentDate: String(row.spent_date),
        amount: toNumber(row.amount),
        categoryId: toNumber(row.category_id),
        paymentMethodId: row.payment_method_id == null ? null : toNumber(row.payment_method_id),
        memo: String(row.memo ?? ""),
        ...(image ? { receiptImage: image } : {}),
        createdAt: String(row.created_at),
        updatedAt: String(row.updated_at)
      };
    });
    return {
      format: "household-ledger-backup",
      version: 2,
      exportedAt: nowIso(),
      categories,
      paymentMethods,
      categoryBudgets,
      monthlyBudgetAdditions,
      expenses
    };
  }

  exportJson(): string {
    return JSON.stringify(this.backupSnapshot(), null, 2);
  }

  exportCsv(): string {
    const expenses = this.listExpenses();
    const lines = [
      ["使用日", "金額", "カテゴリ", "支払い方法", "メモ", "作成日時", "更新日時"].map(escapeCsv).join(",")
    ];
    expenses.forEach((expense) => {
      lines.push(
        [
          expense.spentDate,
          expense.amount,
          expense.categoryName,
          expense.paymentMethodName ?? "",
          expense.memo,
          expense.createdAt,
          expense.updatedAt
        ]
          .map(escapeCsv)
          .join(",")
      );
    });
    return `\uFEFF${lines.join("\r\n")}\r\n`;
  }

  restoreJson(text: string): RestoreResult {
    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch {
      throw new Error("JSONバックアップの形式が正しくありません。");
    }
    const snapshot = parsed as Partial<BackupSnapshot> & Partial<LegacyBackupSnapshot>;
    const isCurrentVersion = snapshot.version === 2 &&
      Array.isArray(snapshot.categoryBudgets) &&
      Array.isArray(snapshot.monthlyBudgetAdditions);
    const isLegacyVersion = snapshot.version === 1 &&
      (snapshot.monthlyBudgets == null || Array.isArray(snapshot.monthlyBudgets));
    if (
      snapshot.format !== "household-ledger-backup" ||
      (!isCurrentVersion && !isLegacyVersion) ||
      !Array.isArray(snapshot.categories) ||
      !Array.isArray(snapshot.paymentMethods) ||
      !Array.isArray(snapshot.expenses)
    ) {
      throw new Error("このアプリのバックアップ形式ではありません。");
    }

    const categories = snapshot.categories as BackupSnapshot["categories"];
    const paymentMethods = snapshot.paymentMethods as BackupSnapshot["paymentMethods"];
    const expenses = snapshot.expenses as BackupSnapshot["expenses"];
    const categoryIds = new Set(categories.map((category) => category.id));
    const paymentMethodIds = new Set(paymentMethods.map((method) => method.id));
    const categoryBudgets: Array<{ categoryId: number; amount: number }> = [];
    const monthlyBudgetAdditions: Array<{ month: number; categoryId: number; amount: number; memo: string }> = [];

    if (isCurrentVersion) {
      categoryBudgets.push(...(snapshot.categoryBudgets as BackupSnapshot["categoryBudgets"]));
      monthlyBudgetAdditions.push(...(snapshot.monthlyBudgetAdditions as BackupSnapshot["monthlyBudgetAdditions"]));
    } else {
      const legacy = snapshot as unknown as LegacyBackupSnapshot;
      const commonBudget = legacy.commonBudget ?? null;
      if (commonBudget != null && (!Number.isSafeInteger(commonBudget) || commonBudget < 0 || commonBudget > 1_000_000_000)) {
        throw new Error("バックアップ内の共通予算データが不正です。");
      }
      const legacyMonths = legacy.monthlyBudgets ?? [];
      legacyMonths.forEach((budget) => {
        if (
          !Number.isInteger(budget.month) || budget.month < 1 || budget.month > 12 ||
          (budget.amount != null && (!Number.isSafeInteger(budget.amount) || budget.amount < 0 || budget.amount > 1_000_000_000)) ||
          (budget.memo != null && (typeof budget.memo !== "string" || budget.memo.length > 100))
        ) {
          throw new Error("バックアップ内の月別予算データが不正です。");
        }
      });
      const hasLegacyBudget = (commonBudget ?? 0) > 0 ||
        legacyMonths.some((budget) => (budget.amount ?? 0) > 0 || Boolean(budget.memo?.trim()));
      if (hasLegacyBudget) {
        const fallbackCategory = categories.find((category) => category.name === "その他") ?? categories[0];
        if (!fallbackCategory) throw new Error("予算を移行できるカテゴリがありません。");
        if ((commonBudget ?? 0) > 0) {
          categoryBudgets.push({ categoryId: fallbackCategory.id, amount: commonBudget! });
        }
        legacyMonths.forEach((budget) => {
          const adjustment = budget.amount == null || budget.amount === 0
            ? 0
            : budget.amount - (commonBudget ?? 0);
          const memo = String(budget.memo ?? "").replace(/[\r\n\t]+/g, " ").trim();
          if (adjustment !== 0 || memo) {
            monthlyBudgetAdditions.push({
              month: budget.month,
              categoryId: fallbackCategory.id,
              amount: adjustment,
              memo: memo || "旧月別予算から移行"
            });
          }
        });
      }
    }

    const seenCategoryBudgets = new Set<number>();
    categoryBudgets.forEach((budget) => {
      if (
        !Number.isInteger(budget.categoryId) ||
        !categoryIds.has(budget.categoryId) ||
        seenCategoryBudgets.has(budget.categoryId) ||
        !Number.isSafeInteger(budget.amount) ||
        budget.amount < 1 ||
        budget.amount > 1_000_000_000
      ) {
        throw new Error("バックアップ内のカテゴリ別共通予算データが不正です。");
      }
      seenCategoryBudgets.add(budget.categoryId);
    });
    monthlyBudgetAdditions.forEach((addition) => {
      if (
        !Number.isInteger(addition.month) || addition.month < 1 || addition.month > 12 ||
        !Number.isInteger(addition.categoryId) || !categoryIds.has(addition.categoryId) ||
        !Number.isSafeInteger(addition.amount) || Math.abs(addition.amount) > 1_000_000_000 ||
        typeof addition.memo !== "string" || addition.memo.length > 100
      ) {
        throw new Error("バックアップ内の月別追加予算データが不正です。");
      }
    });
    expenses.forEach((expense) => {
      if (!categoryIds.has(expense.categoryId) || (expense.paymentMethodId != null && !paymentMethodIds.has(expense.paymentMethodId))) {
        throw new Error("バックアップ内のカテゴリまたは支払い方法が不正です。");
      }
      if (!isValidDateKey(expense.spentDate) || !Number.isInteger(expense.amount) || expense.amount < 1) {
        throw new Error("バックアップ内の支出データが不正です。");
      }
    });

    return this.transaction(() => {
      this.run("DELETE FROM expenses");
      this.run("DELETE FROM monthly_budget_additions");
      this.run("DELETE FROM category_budgets");
      this.run("DELETE FROM monthly_budgets");
      this.run("DELETE FROM monthly_budget_memos");
      this.run("DELETE FROM common_budgets");
      this.run("DELETE FROM categories");
      this.run("DELETE FROM payment_methods");
      categories.forEach((category) => {
        this.run(
          "INSERT INTO categories (id, name, color, sort_order, is_active) VALUES (?, ?, ?, ?, ?)",
          [category.id, category.name, category.color, category.sortOrder, category.isActive ? 1 : 0]
        );
      });
      paymentMethods.forEach((method) => {
        this.run(
          "INSERT INTO payment_methods (id, name, sort_order, is_active) VALUES (?, ?, ?, ?)",
          [method.id, method.name, method.sortOrder, method.isActive ? 1 : 0]
        );
      });
      categoryBudgets.forEach((budget) => {
        this.run(
          "INSERT INTO category_budgets (category_id, amount, updated_at) VALUES (?, ?, ?)",
          [budget.categoryId, budget.amount, nowIso()]
        );
      });
      monthlyBudgetAdditions.forEach((addition) => {
        const memo = addition.memo.replace(/[\r\n\t]+/g, " ").trim();
        this.run(
          `INSERT INTO monthly_budget_additions (month, category_id, amount, memo, updated_at)
           VALUES (?, ?, ?, ?, ?)`,
          [addition.month, addition.categoryId, addition.amount, memo, nowIso()]
        );
      });
      expenses.forEach((expense) => {
        this.run(
          `INSERT INTO expenses (id, spent_date, amount, category_id, payment_method_id, memo, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
          [
            expense.id,
            expense.spentDate,
            expense.amount,
            expense.categoryId,
            expense.paymentMethodId,
            expense.memo,
            expense.createdAt,
            expense.updatedAt
          ]
        );
      });
      expenses.forEach((expense) => {
        if (expense.receiptImage) {
          const extension = expense.receiptImage.mimeType.includes("png")
            ? ".png"
            : expense.receiptImage.mimeType.includes("webp")
              ? ".webp"
              : ".jpg";
          const imagePath = join(this.receiptsDirectory, `receipt-${expense.id}${extension}`);
          writeFileSync(imagePath, Buffer.from(expense.receiptImage.base64, "base64"));
          this.run("UPDATE expenses SET receipt_image_path = ? WHERE id = ?", [imagePath, expense.id]);
        }
      });
      return {
        categories: categories.length,
        paymentMethods: paymentMethods.length,
        expenses: expenses.length,
        budgets: categoryBudgets.length + monthlyBudgetAdditions.length
      };
    });
  }
}
