export type Category = {
  id: number;
  name: string;
  color: string;
  sortOrder: number;
  isActive: boolean;
};

export type PaymentMethod = {
  id: number;
  name: string;
  sortOrder: number;
  isActive: boolean;
};

export type CategoryBudgetSetting = {
  categoryId: number;
  amount: number | null;
};

export type MonthlyBudgetAddition = {
  id: number;
  categoryId: number;
  categoryName: string;
  amount: number;
  memo: string;
};

export type MonthlyBudgetAdditionInput = {
  categoryId: number;
  amount: number;
  memo: string;
};

export type MonthlyBudget = {
  month: number;
  additions: MonthlyBudgetAddition[];
};

export type BudgetSettings = {
  categoryBudgets: CategoryBudgetSetting[];
  monthlyBudgets: MonthlyBudget[];
};

export type BudgetSettingsInput = {
  categoryBudgets: CategoryBudgetSetting[];
  monthlyBudgets: Array<{
    month: number;
    additions: MonthlyBudgetAdditionInput[];
  }>;
};

export type Expense = {
  id: number;
  spentDate: string;
  amount: number;
  categoryId: number;
  categoryName: string;
  categoryColor: string;
  paymentMethodId: number | null;
  paymentMethodName: string | null;
  memo: string;
  receiptImagePath: string | null;
  createdAt: string;
  updatedAt: string;
};

export type ExpenseInput = {
  spentDate: string;
  amount: number;
  categoryId: number;
  paymentMethodId: number | null;
  memo: string;
  receiptImageDataUrl?: string | null;
};

export type CategoryAmount = {
  categoryId: number;
  categoryName: string;
  color: string;
  amount: number;
  percentage: number;
};

export type DailyAmount = {
  date: string;
  label: string;
  amount: number;
};

export type WeekAmount = {
  weekStart: string;
  weekEnd: string;
  label: string;
  amount: number;
};

export type DashboardData = {
  referenceDate: string;
  todayTotal: number;
  weekTotal: number;
  monthTotal: number;
  monthlyBudget: number | null;
  monthlyBudgetMemo: string;
  monthlyDifference: number | null;
  monthlyAverage: number;
  monthDaysElapsed: number;
  categoryAmounts: CategoryAmount[];
  dailyAmounts: DailyAmount[];
  recentExpenses: Expense[];
};

export type WeekDay = {
  date: string;
  label: string;
  total: number;
  expenses: Expense[];
};

export type WeekView = {
  weekStart: string;
  weekEnd: string;
  total: number;
  days: WeekDay[];
};

export type MonthView = {
  month: string;
  total: number;
  monthlyBudget: number | null;
  monthlyBudgetMemo: string;
  monthlyDifference: number | null;
  categoryAmounts: CategoryAmount[];
  weekAmounts: WeekAmount[];
  expenses: Expense[];
};

export type OcrResult = {
  text: string;
  date: string | null;
  storeName: string | null;
  amountCandidates: number[];
  suggestedCategoryNames: string[];
};

export type ReceiptImage = {
  fileName: string;
  mimeType: string;
  dataUrl: string;
};

export type RestoreResult = {
  categories: number;
  paymentMethods: number;
  expenses: number;
  budgets: number;
};

type BackupSnapshotBase = {
  format: "household-ledger-backup";
  exportedAt: string;
  categories: Array<{
    id: number;
    name: string;
    color: string;
    sortOrder: number;
    isActive: boolean;
  }>;
  paymentMethods: Array<{
    id: number;
    name: string;
    sortOrder: number;
    isActive: boolean;
  }>;
  expenses: Array<{
    id: number;
    spentDate: string;
    amount: number;
    categoryId: number;
    paymentMethodId: number | null;
    memo: string;
    receiptImage?: {
      mimeType: string;
      base64: string;
    };
    createdAt: string;
    updatedAt: string;
  }>;
};

export type BackupSnapshot = BackupSnapshotBase & {
  version: 2;
  categoryBudgets: Array<{
    categoryId: number;
    amount: number;
  }>;
  monthlyBudgetAdditions: Array<{
    month: number;
    categoryId: number;
    amount: number;
    memo: string;
  }>;
};

export type LegacyBackupSnapshot = BackupSnapshotBase & {
  version: 1;
  monthlyBudgets?: Array<{
    month: number;
    amount: number | null;
    memo?: string;
  }>;
  commonBudget?: number | null;
};

export type HouseholdLedgerApi = {
  dashboard: (referenceDate: string) => Promise<DashboardData>;
  expenses: {
    list: (filters?: { dateFrom?: string; dateTo?: string; limit?: number }) => Promise<Expense[]>;
    create: (input: ExpenseInput) => Promise<Expense>;
    update: (id: number, input: ExpenseInput) => Promise<Expense>;
    delete: (id: number) => Promise<void>;
  };
  categories: {
    list: (includeInactive?: boolean) => Promise<Category[]>;
    create: (input: { name: string; color: string }) => Promise<Category>;
    update: (id: number, input: { name: string; color: string; isActive: boolean }) => Promise<Category>;
    reorder: (ids: number[]) => Promise<Category[]>;
  };
  paymentMethods: {
    list: (includeInactive?: boolean) => Promise<PaymentMethod[]>;
    create: (input: { name: string }) => Promise<PaymentMethod>;
    update: (id: number, input: { name: string; isActive: boolean }) => Promise<PaymentMethod>;
  };
  budgets: {
    settings: () => Promise<BudgetSettings>;
    saveSettings: (settings: BudgetSettingsInput) => Promise<void>;
  };
  week: (weekStart: string) => Promise<WeekView>;
  month: (month: string) => Promise<MonthView>;
  backup: {
    exportJson: () => Promise<string | null>;
    exportCsv: () => Promise<string | null>;
    restoreJson: () => Promise<RestoreResult | null>;
  };
  receipt: {
    chooseImage: () => Promise<ReceiptImage | null>;
    recognize: (dataUrl: string) => Promise<OcrResult>;
  };
  printing: {
    print: () => Promise<boolean>;
    exportPdf: (fileName: string) => Promise<string | null>;
  };
};
