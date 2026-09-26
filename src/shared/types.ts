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

export type MonthlyBudget = {
  month: number;
  amount: number | null;
  memo: string;
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

export type BackupSnapshot = {
  format: "household-ledger-backup";
  version: 1;
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
  monthlyBudgets?: Array<{
    month: number;
    amount: number | null;
    memo?: string;
  }>;
  commonBudget?: number | null;
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
    list: () => Promise<MonthlyBudget[]>;
    update: (month: number, amount: number | null, memo?: string) => Promise<MonthlyBudget>;
    common: () => Promise<number | null>;
    updateCommon: (amount: number | null) => Promise<number | null>;
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
