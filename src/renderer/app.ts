import Chart from "chart.js/auto";
import {
  addDays,
  formatDateJa,
  formatMonthJa,
  getWeekStart,
  monthKey,
  parseDateKey,
  todayKey
} from "../shared/date";
import type {
  Category,
  DashboardData,
  Expense,
  ExpenseInput,
  MonthView,
  MonthlyBudget,
  OcrResult,
  PaymentMethod,
  ReceiptImage,
  WeekView
} from "../shared/types";

type View = "dashboard" | "expense" | "weekly" | "monthly" | "ocr" | "settings";

type ExpenseDraft = {
  spentDate: string;
  amount: string;
  categoryId: number | null;
  paymentMethodId: number | null;
  memo: string;
};

const yen = (amount: number): string => `¥${Math.round(amount).toLocaleString("ja-JP")}`;
const number = (amount: number): string => Math.round(amount).toLocaleString("ja-JP");
const formatBudgetInput = (amount: number | null): string => amount == null ? "" : amount.toLocaleString("en-US");
const parseBudgetInput = (value: string): number | null => value.trim() === "" ? null : Number(value.replaceAll(",", ""));
const percentage = (value: number): string => `${value.toFixed(value >= 10 ? 0 : 1)}%`;
const weekday = (date: string): string => ["日", "月", "火", "水", "木", "金", "土"][parseDateKey(date).getDay()];

const escapeHtml = (value: unknown): string => {
  const entities: Record<string, string> = {
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    '"': "&quot;",
    "'": "&#39;"
  };
  return String(value ?? "").replace(/[&<>"']/g, (character) => entities[character]);
};

const selected = (condition: boolean): string => (condition ? " selected" : "");
const checked = (condition: boolean): string => (condition ? " checked" : "");

const emptyState = (message: string, icon = "◎"): string => `
  <div class="empty-state">
    <span class="empty-icon">${icon}</span>
    <p>${escapeHtml(message)}</p>
  </div>
`;

export class HouseholdLedgerApp {
  private readonly root: HTMLDivElement;
  private readonly content: HTMLDivElement;
  private readonly pageTitle: HTMLElement;
  private readonly navButtons: NodeListOf<HTMLButtonElement>;
  private activeView: View = "dashboard";
  private selectedDate = todayKey();
  private selectedWeekStart = getWeekStart(this.selectedDate);
  private selectedMonth = monthKey(this.selectedDate);
  private categories: Category[] = [];
  private paymentMethods: PaymentMethod[] = [];
  private monthlyBudgets: MonthlyBudget[] = [];
  private commonBudget: number | null = null;
  private charts: Chart[] = [];
  private ocrImage: ReceiptImage | null = null;
  private ocrResult: OcrResult | null = null;

  constructor(root: HTMLDivElement) {
    this.root = root;
    this.root.innerHTML = this.shellMarkup();
    this.content = this.root.querySelector<HTMLDivElement>("#content")!;
    this.pageTitle = this.root.querySelector<HTMLElement>("#page-title")!;
    this.navButtons = this.root.querySelectorAll<HTMLButtonElement>("[data-view]");
    this.bindEvents();
    void this.renderCurrent();
  }

  private shellMarkup(): string {
    return `
      <div class="app-shell">
        <aside class="sidebar">
          <div class="brand">
            <div class="brand-mark">¥</div>
            <div>
              <strong>家計簿</strong>
              <span>HOUSEHOLD LEDGER</span>
            </div>
          </div>
          <nav class="main-nav" aria-label="メインメニュー">
            ${this.navButton("dashboard", "▦", "ダッシュボード")}
            ${this.navButton("expense", "+", "支出を登録")}
            ${this.navButton("weekly", "▤", "日別・週間")}
            ${this.navButton("monthly", "◒", "月間管理")}
            ${this.navButton("ocr", "▧", "レシート読取")}
            ${this.navButton("settings", "⚙", "設定")}
          </nav>
          <div class="sidebar-footnote">
            <span class="offline-dot"></span>
            <div><strong>オフライン保存</strong><small>データはこのPC内に保存されます</small></div>
          </div>
        </aside>
        <main class="main-shell">
          <header class="topbar">
            <div>
              <p class="eyebrow">PERSONAL FINANCE</p>
              <h1 id="page-title">ダッシュボード</h1>
            </div>
            <button class="button primary top-action" data-view="expense"><span>＋</span> 支出を登録</button>
          </header>
          <div id="content" class="content"></div>
        </main>
      </div>
    `;
  }

  private navButton(view: View, icon: string, label: string): string {
    return `<button class="nav-button" data-view="${view}"><span class="nav-icon">${icon}</span><span>${label}</span></button>`;
  }

  private bindEvents(): void {
    this.root.addEventListener("click", (event) => void this.handleClick(event));
    this.root.addEventListener("input", (event) => this.handleInput(event));
    this.root.addEventListener("change", (event) => void this.handleChange(event));
    this.root.addEventListener("submit", (event) => void this.handleSubmit(event));
  }

  private handleInput(event: Event): void {
    const input = event.target;
    if (!(input instanceof HTMLInputElement) || !input.hasAttribute("data-budget-amount")) return;

    const currentValue = input.value;
    const currentPosition = input.selectionStart ?? currentValue.length;
    const digitsBeforeCursor = currentValue.slice(0, currentPosition).replace(/\D/g, "").length;
    const digits = currentValue.replace(/\D/g, "").slice(0, 10);
    const formatted = digits ? Number(digits).toLocaleString("en-US") : "";
    let nextPosition = 0;
    let digitCount = 0;
    while (nextPosition < formatted.length && digitCount < digitsBeforeCursor) {
      if (/\d/.test(formatted[nextPosition])) digitCount += 1;
      nextPosition += 1;
    }
    input.value = formatted;
    input.setSelectionRange(nextPosition, nextPosition);
  }

  private async handleClick(event: Event): Promise<void> {
    const target = event.target as HTMLElement;
    const viewButton = target.closest<HTMLElement>("[data-view]");
    if (viewButton) {
      const view = viewButton.dataset.view as View;
      if (view) await this.navigate(view);
      return;
    }

    const actionElement = target.closest<HTMLElement>("[data-action]");
    if (!actionElement) return;
    const action = actionElement.dataset.action;
    switch (action) {
      case "today":
        this.selectedDate = todayKey();
        this.selectedWeekStart = getWeekStart(this.selectedDate);
        this.selectedMonth = monthKey(this.selectedDate);
        await this.renderCurrent();
        break;
      case "previous-week":
      case "next-week":
        this.selectedWeekStart = addDays(this.selectedWeekStart, action === "previous-week" ? -7 : 7);
        await this.renderCurrent();
        break;
      case "previous-month":
      case "next-month": {
        const date = parseDateKey(`${this.selectedMonth}-01`);
        date.setMonth(date.getMonth() + (action === "previous-month" ? -1 : 1));
        this.selectedMonth = `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}`;
        await this.renderCurrent();
        break;
      }
      case "edit-expense":
        if (actionElement.dataset.id === "new") {
          if (actionElement.dataset.date) this.selectedDate = actionElement.dataset.date;
          await this.navigate("expense");
        } else {
          await this.openExpenseEditor(Number(actionElement.dataset.id));
        }
        break;
      case "delete-expense":
        await this.deleteExpense(Number(actionElement.dataset.id));
        break;
      case "submit-and-continue":
        await this.submitExpenseForm(true, this.root.querySelector<HTMLFormElement>("#expense-form"));
        break;
      case "edit-category":
        await this.openCategoryEditor(Number(actionElement.dataset.id));
        break;
      case "move-category":
        await this.moveCategory(Number(actionElement.dataset.id), actionElement.dataset.direction === "up" ? -1 : 1);
        break;
      case "edit-payment-method":
        await this.openPaymentMethodEditor(Number(actionElement.dataset.id));
        break;
      case "export-json":
        await this.exportJson();
        break;
      case "export-csv":
        await this.exportCsv();
        break;
      case "restore-json":
        await this.restoreJson();
        break;
      case "choose-receipt":
        await this.chooseReceipt();
        break;
      case "run-ocr":
        await this.runOcr();
        break;
      case "manual-expense":
        this.ocrImage = null;
        this.ocrResult = null;
        await this.navigate("expense");
        break;
      case "reset-ocr":
        this.ocrImage = null;
        this.ocrResult = null;
        await this.renderCurrent();
        break;
      case "print-view":
        await this.printCurrentView(false);
        break;
      case "export-view-pdf":
        await this.printCurrentView(true);
        break;
    }
  }

  private async handleChange(event: Event): Promise<void> {
    const input = event.target as HTMLInputElement;
    if (input.id === "dashboard-date" && input.value) {
      this.selectedDate = input.value;
      this.selectedWeekStart = getWeekStart(input.value);
      this.selectedMonth = monthKey(input.value);
      await this.renderCurrent();
    } else if (input.id === "dashboard-month" && input.value) {
      this.selectedMonth = input.value;
      this.selectedDate = `${input.value}-01`;
      this.selectedWeekStart = getWeekStart(this.selectedDate);
      await this.renderCurrent();
    } else if (input.id === "week-start" && input.value) {
      this.selectedWeekStart = getWeekStart(input.value);
      await this.renderCurrent();
    } else if (input.id === "month-picker" && input.value) {
      this.selectedMonth = input.value;
      await this.renderCurrent();
    } else if (input.id === "ocr-amount-candidate") {
      const amount = this.root.querySelector<HTMLInputElement>("#ocr-amount");
      if (amount && input.value) amount.value = input.value;
    }
  }

  private async handleSubmit(event: SubmitEvent): Promise<void> {
    event.preventDefault();
    const form = event.target as HTMLFormElement;
    switch (form.id) {
      case "expense-form":
        await this.submitExpenseForm(false, form);
        break;
      case "category-create-form":
        await this.createCategory(form);
        break;
      case "payment-create-form":
        await this.createPaymentMethod(form);
        break;
      case "budget-settings-form":
        await this.saveMonthlyBudgets(form);
        break;
      case "ocr-expense-form":
        await this.submitOcrExpense(form);
        break;
    }
  }

  private async navigate(view: View): Promise<void> {
    this.activeView = view;
    await this.renderCurrent();
  }

  private async renderCurrent(): Promise<void> {
    const titles: Record<View, string> = {
      dashboard: "ダッシュボード",
      expense: "支出を登録",
      weekly: "日別・週間管理",
      monthly: "月間管理",
      ocr: "レシート読取",
      settings: "設定"
    };
    this.pageTitle.textContent = titles[this.activeView];
    this.navButtons.forEach((button) => button.classList.toggle("active", button.dataset.view === this.activeView));
    this.charts.forEach((chart) => chart.destroy());
    this.charts = [];
    this.content.innerHTML = `<div class="loading"><span class="spinner"></span>読み込み中…</div>`;
    try {
      switch (this.activeView) {
        case "dashboard":
          await this.renderDashboard();
          break;
        case "expense":
          await this.renderExpensePage();
          break;
        case "weekly":
          await this.renderWeekly();
          break;
        case "monthly":
          await this.renderMonthly();
          break;
        case "ocr":
          await this.renderOcr();
          break;
        case "settings":
          await this.renderSettings();
          break;
      }
    } catch (error) {
      this.content.innerHTML = `<div class="error-panel"><strong>読み込みに失敗しました</strong><p>${escapeHtml(this.errorMessage(error))}</p><button class="button outline" data-action="today">再試行</button></div>`;
    }
  }

  private async loadReferenceData(includeInactive = false): Promise<void> {
    this.categories = await window.ledgerApi.categories.list(includeInactive);
    this.paymentMethods = await window.ledgerApi.paymentMethods.list(includeInactive);
  }

  private async renderDashboard(): Promise<void> {
    await this.loadReferenceData();
    const data = await window.ledgerApi.dashboard(this.selectedDate);
    this.content.innerHTML = `
      <section class="page-intro compact-intro">
        <div><p class="eyebrow">OVERVIEW</p><h2>${escapeHtml(formatDateJa(this.selectedDate, true))} の家計状況</h2></div>
        <div class="page-tools"><div class="date-tools"><button class="button ghost" data-action="today">今日</button><input id="dashboard-date" class="date-input" type="date" value="${this.selectedDate}" /><input id="dashboard-month" class="month-input" type="month" value="${monthKey(this.selectedDate)}" aria-label="表示月" /></div>${this.reportActions()}</div>
      </section>
      <section class="stat-grid">
        ${this.statCard("今日の支出", data.todayTotal, "TODAY", "blue")}
        ${this.statCard("今週の支出", data.weekTotal, "MON〜SUN", "violet")}
        ${this.statCard("今月の支出", data.monthTotal, formatMonthJa(monthKey(this.selectedDate)), "orange")}
        ${this.statCard("今月の1日平均", data.monthlyAverage, `${data.monthDaysElapsed}日経過`, "green", true)}
      </section>
      ${this.budgetComparisonMarkup(formatMonthJa(monthKey(this.selectedDate)), data.monthTotal, data.monthlyBudget, data.monthlyBudgetMemo)}
      <section class="dashboard-grid">
        <article class="card chart-card wide-card">
          <div class="card-heading"><div><p class="eyebrow">DAILY TREND</p><h3>日別の支出</h3></div><span class="muted-label">${escapeHtml(formatMonthJa(monthKey(this.selectedDate)))}</span></div>
          <div class="chart-wrap line-chart-wrap"><canvas id="daily-chart"></canvas></div>
        </article>
        <article class="card chart-card category-card">
          <div class="card-heading"><div><p class="eyebrow">BY CATEGORY</p><h3>カテゴリ別</h3></div><span class="muted-label">合計 ${yen(data.monthTotal)}</span></div>
          ${data.categoryAmounts.length ? '<div class="chart-wrap doughnut-wrap"><canvas id="category-chart"></canvas></div>' : emptyState("この月の支出はありません", "◌")}
          ${this.categoryLegend(data.categoryAmounts)}
        </article>
      </section>
      <section class="card recent-card">
        <div class="card-heading"><div><p class="eyebrow">RECENT ACTIVITY</p><h3>最近登録した支出</h3></div><button class="button outline small" data-view="weekly">週間管理を見る</button></div>
        ${this.expenseTable(data.recentExpenses)}
      </section>
    `;
    this.renderDailyChart(data);
    if (data.categoryAmounts.length) this.renderCategoryChart(data.categoryAmounts);
  }

  private statCard(title: string, amount: number, detail: string, color: string, decimal = false): string {
    return `
      <article class="stat-card ${color}">
        <div class="stat-top"><span>${escapeHtml(title)}</span><span class="stat-dot"></span></div>
        <strong>${decimal ? yen(amount) : yen(amount)}</strong>
        <small>${escapeHtml(detail)}</small>
      </article>
    `;
  }

  private reportActions(): string {
    return `<div class="report-actions"><button class="button outline small" data-action="print-view">印刷</button><button class="button outline small" data-action="export-view-pdf">PDF保存</button></div>`;
  }

  private budgetComparisonMarkup(monthLabel: string, actual: number, budget: number | null, memo: string): string {
    const difference = budget == null ? null : budget - actual;
    const isOver = difference != null && difference < 0;
    const usage = budget && budget > 0 ? Math.min(100, Math.round((actual / budget) * 100)) : 0;
    const differenceLabel = difference == null ? "未設定" : isOver ? "超過" : "余り";
    const differenceAmount = difference == null ? "—" : yen(Math.abs(difference));
    return `
      <section class="card budget-card${isOver ? " is-over" : difference != null ? " is-under" : " is-unset"}">
        <div class="budget-heading"><div><p class="eyebrow">MONTHLY BUDGET</p><h3>${escapeHtml(monthLabel)}の予算と実績</h3><small>月別予算が未設定の場合は共通予算を適用します。</small></div><span class="budget-status">${differenceLabel}</span></div>
        <div class="budget-metrics"><div><span>予算</span><strong>${budget == null ? "未設定" : yen(budget)}</strong></div><div><span>実績</span><strong>${yen(actual)}</strong></div><div><span>${differenceLabel}</span><strong>${differenceAmount}</strong></div></div>
        ${budget == null ? `<p class="budget-note">共通予算と月別予算が未設定です。</p>` : `<div class="budget-progress"><div><span>予算消化率</span><strong>${usage}%</strong></div><div class="budget-progress-track"><i style="width:${usage}%"></i></div></div>`}
        ${memo.trim() ? `<p class="budget-note budget-memo"><strong>補足：</strong>${escapeHtml(memo)}</p>` : ""}
      </section>
    `;
  }

  private categoryLegend(amounts: DashboardData["categoryAmounts"]): string {
    if (!amounts.length) return "";
    return `<div class="legend-list">${amounts
      .slice(0, 6)
      .map(
        (item) => `
          <div class="legend-row"><span class="legend-name"><i style="background:${escapeHtml(item.color)}"></i>${escapeHtml(item.categoryName)}</span><span><strong>${yen(item.amount)}</strong><small>${percentage(item.percentage)}</small></span></div>
        `
      )
      .join("")}</div>`;
  }

  private renderDailyChart(data: DashboardData): void {
    const canvas = this.content.querySelector<HTMLCanvasElement>("#daily-chart");
    if (!canvas) return;
    this.charts.push(
      new Chart(canvas, {
        type: "bar",
        data: {
          labels: data.dailyAmounts.map((item) => item.label),
          datasets: [
            {
              data: data.dailyAmounts.map((item) => item.amount),
              backgroundColor: "rgba(67, 97, 238, .72)",
              hoverBackgroundColor: "#4361ee",
              borderRadius: 5,
              maxBarThickness: 22
            }
          ]
        },
        options: {
          responsive: true,
          maintainAspectRatio: false,
          plugins: { legend: { display: false }, tooltip: { callbacks: { label: (context) => ` ${yen(Number(context.raw))}` } } },
          scales: {
            x: { grid: { display: false }, ticks: { color: "#8b94a7", maxRotation: 0, autoSkip: true, maxTicksLimit: 10 } },
            y: { beginAtZero: true, grid: { color: "#eef1f6" }, ticks: { color: "#8b94a7", callback: (value) => yen(Number(value)) } }
          }
        }
      })
    );
  }

  private renderCategoryChart(amounts: DashboardData["categoryAmounts"]): void {
    const canvas = this.content.querySelector<HTMLCanvasElement>("#category-chart");
    if (!canvas) return;
    this.charts.push(
      new Chart(canvas, {
        type: "doughnut",
        data: {
          labels: amounts.map((item) => item.categoryName),
          datasets: [{ data: amounts.map((item) => item.amount), backgroundColor: amounts.map((item) => item.color), borderWidth: 3, borderColor: "#fff" }]
        },
        options: { responsive: true, maintainAspectRatio: false, cutout: "68%", plugins: { legend: { display: false }, tooltip: { callbacks: { label: (context) => ` ${yen(Number(context.raw))}` } } } }
      })
    );
  }

  private async renderExpensePage(): Promise<void> {
    await this.loadReferenceData();
    this.content.innerHTML = `
      <section class="page-intro"><div><p class="eyebrow">NEW ENTRY</p><h2>支出を登録</h2><p>使った費用を入力すると、集計へすぐ反映されます。</p></div></section>
      <section class="form-layout">
        <article class="card form-card">
          <div class="card-heading"><div><p class="eyebrow">EXPENSE DETAIL</p><h3>支出内容</h3></div><span class="required-note">* 必須</span></div>
          ${this.expenseFormMarkup("expense-form", { spentDate: this.selectedDate, amount: "", categoryId: this.categories[0]?.id ?? null, paymentMethodId: null, memo: "" })}
        </article>
        <aside class="card tip-card">
          <span class="tip-icon">✦</span><h3>入力のヒント</h3>
          <p>店名や用途をメモしておくと、あとから支出を振り返りやすくなります。</p>
          <div class="tip-rule"></div><p class="muted">レシート画像から入力したい場合は、左メニューの「レシート読取」を使えます。</p>
        </aside>
      </section>
    `;
  }

  private expenseFormMarkup(formId: string, draft: ExpenseDraft): string {
    const categories = this.categories.length ? this.categories : [];
    const methods = this.paymentMethods;
    return `
      <form id="${formId}" class="expense-form" data-form="expense">
        <div class="form-grid two-col">
          <label class="field"><span>使用日 <b>*</b></span><input name="spentDate" type="date" value="${escapeHtml(draft.spentDate)}" required /></label>
          <label class="field"><span>金額 <b>*</b></span><div class="input-with-suffix"><input name="amount" type="number" min="1" step="1" inputmode="numeric" value="${escapeHtml(draft.amount)}" placeholder="0" required /><em>円</em></div></label>
        </div>
        <label class="field"><span>カテゴリ <b>*</b></span><select name="categoryId" required>${categories
          .filter((category) => category.isActive || category.id === draft.categoryId)
          .map((category) => `<option value="${category.id}"${selected(category.id === draft.categoryId)}>${escapeHtml(category.name)}${category.isActive ? "" : "（無効）"}</option>`)
          .join("")}</select></label>
        <label class="field"><span>支払い方法 <small>任意</small></span><select name="paymentMethodId"><option value="">選択しない</option>${methods
          .filter((method) => method.isActive || method.id === draft.paymentMethodId)
          .map((method) => `<option value="${method.id}"${selected(method.id === draft.paymentMethodId)}>${escapeHtml(method.name)}${method.isActive ? "" : "（無効）"}</option>`)
          .join("")}</select></label>
        <label class="field"><span>メモ <small>任意</small></span><textarea name="memo" rows="4" placeholder="店名、用途など">${escapeHtml(draft.memo)}</textarea></label>
        <div class="form-actions"><button class="button primary" type="submit">登録する</button><button class="button outline" type="button" data-action="submit-and-continue">登録して続けて入力</button><button class="button ghost" type="button" data-view="dashboard">キャンセル</button></div>
      </form>
    `;
  }

  private readExpenseForm(form: HTMLFormElement): ExpenseInput {
    const value = (name: string): string => (form.elements.namedItem(name) as HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement)?.value ?? "";
    return {
      spentDate: value("spentDate"),
      amount: Number(value("amount")),
      categoryId: Number(value("categoryId")),
      paymentMethodId: value("paymentMethodId") ? Number(value("paymentMethodId")) : null,
      memo: value("memo")
    };
  }

  private async submitExpenseForm(continueInput: boolean, form: HTMLFormElement | null): Promise<void> {
    if (!form) return;
    try {
      await window.ledgerApi.expenses.create(this.readExpenseForm(form));
      this.showToast("支出を登録しました", "success");
      if (continueInput) {
        form.reset();
        (form.elements.namedItem("spentDate") as HTMLInputElement).value = this.selectedDate;
        (form.elements.namedItem("categoryId") as HTMLSelectElement).value = String(this.categories[0]?.id ?? "");
        (form.elements.namedItem("amount") as HTMLInputElement).focus();
      } else {
        await this.navigate("dashboard");
      }
    } catch (error) {
      this.showToast(this.errorMessage(error), "error");
    }
  }

  private expenseTable(expenses: Expense[]): string {
    if (!expenses.length) return emptyState("登録済みの支出はありません", "＋");
    return `
      <div class="table-scroll"><table class="data-table"><thead><tr><th>使用日</th><th>カテゴリ</th><th>メモ</th><th>支払い方法</th><th class="align-right">金額</th><th></th></tr></thead><tbody>${expenses
        .map(
          (expense) => `
            <tr>
              <td><strong>${escapeHtml(formatDateJa(expense.spentDate, true))}</strong><small>${weekday(expense.spentDate)}曜日</small></td>
              <td><span class="category-pill"><i style="background:${escapeHtml(expense.categoryColor)}"></i>${escapeHtml(expense.categoryName)}</span></td>
              <td class="memo-cell">${escapeHtml(expense.memo || "—")}</td>
              <td>${escapeHtml(expense.paymentMethodName || "—")}</td>
              <td class="align-right amount-cell">${yen(expense.amount)}</td>
              <td class="row-actions"><button class="icon-button" title="編集" data-action="edit-expense" data-id="${expense.id}">編集</button><button class="icon-button danger" title="削除" data-action="delete-expense" data-id="${expense.id}">削除</button></td>
            </tr>
          `
        )
        .join("")}</tbody></table></div>
    `;
  }

  private async renderWeekly(): Promise<void> {
    const data = await window.ledgerApi.week(this.selectedWeekStart);
    this.content.innerHTML = `
      <section class="page-intro compact-intro"><div><p class="eyebrow">WEEKLY REVIEW</p><h2>${escapeHtml(formatDateJa(data.weekStart, true))} 〜 ${escapeHtml(formatDateJa(data.weekEnd, true))}</h2></div><div class="page-tools"><div class="period-tools"><button class="icon-nav" data-action="previous-week" aria-label="前週">‹</button><input id="week-start" class="date-input" type="date" value="${data.weekStart}" /><button class="icon-nav" data-action="next-week" aria-label="次週">›</button></div>${this.reportActions()}</div></section>
      <div class="summary-strip"><div><span>週間合計</span><strong>${yen(data.total)}</strong></div><div><span>登録件数</span><strong>${data.days.reduce((sum, day) => sum + day.expenses.length, 0)}<small>件</small></strong></div><div><span>支出があった日</span><strong>${data.days.filter((day) => day.total > 0).length}<small>日</small></strong></div></div>
      <section class="week-grid">${data.days.map((day) => this.dayCard(day, data.weekStart)).join("")}</section>
    `;
  }

  private dayCard(day: WeekView["days"][number], weekStart: string): string {
    const isToday = day.date === todayKey();
    return `
      <article class="day-card${isToday ? " is-today" : ""}">
        <div class="day-card-head"><div><span class="weekday-label">${weekday(day.date)}曜日</span><strong>${escapeHtml(formatDateJa(day.date))}</strong></div><span class="day-total">${day.total ? yen(day.total) : "—"}</span></div>
        <div class="day-expenses">${day.expenses.length ? day.expenses.map((expense) => this.compactExpense(expense)).join("") : '<span class="no-expense">支出なし</span>'}</div>
        <button class="text-button" data-action="edit-expense" data-id="new" data-date="${day.date}" data-week="${weekStart}">＋ 支出を追加</button>
      </article>
    `;
  }

  private compactExpense(expense: Expense): string {
    return `<div class="compact-expense"><span class="category-dot" style="background:${escapeHtml(expense.categoryColor)}"></span><div><strong>${escapeHtml(expense.categoryName)}</strong><small>${escapeHtml(expense.memo || expense.paymentMethodName || "")}</small></div><b>${yen(expense.amount)}</b><button class="mini-edit" data-action="edit-expense" data-id="${expense.id}">編集</button></div>`;
  }

  private async renderMonthly(): Promise<void> {
    const data = await window.ledgerApi.month(this.selectedMonth);
    this.content.innerHTML = `
      <section class="page-intro compact-intro"><div><p class="eyebrow">MONTHLY REVIEW</p><h2>${escapeHtml(formatMonthJa(data.month))}</h2></div><div class="page-tools"><div class="period-tools"><button class="icon-nav" data-action="previous-month" aria-label="前月">‹</button><input id="month-picker" class="month-input" type="month" value="${data.month}" /><button class="icon-nav" data-action="next-month" aria-label="次月">›</button></div>${this.reportActions()}</div></section>
      <div class="summary-strip"><div><span>月間合計</span><strong>${yen(data.total)}</strong></div><div><span>登録件数</span><strong>${data.expenses.length}<small>件</small></strong></div><div><span>カテゴリ数</span><strong>${data.categoryAmounts.length}<small>項目</small></strong></div></div>
      ${this.budgetComparisonMarkup(formatMonthJa(data.month), data.total, data.monthlyBudget, data.monthlyBudgetMemo)}
      <section class="dashboard-grid monthly-top"><article class="card chart-card category-card"><div class="card-heading"><div><p class="eyebrow">BY CATEGORY</p><h3>カテゴリ別の割合</h3></div></div>${data.categoryAmounts.length ? '<div class="chart-wrap doughnut-wrap"><canvas id="month-category-chart"></canvas></div>' : emptyState("この月の支出はありません", "◌")}${this.categoryLegend(data.categoryAmounts)}</article><article class="card chart-card wide-card"><div class="card-heading"><div><p class="eyebrow">WEEKLY TOTALS</p><h3>週ごとの合計</h3></div></div><div class="chart-wrap line-chart-wrap"><canvas id="week-chart"></canvas></div></article></section>
      <section class="card recent-card"><div class="card-heading"><div><p class="eyebrow">MONTH DETAIL</p><h3>支出明細</h3></div></div>${this.expenseTable(data.expenses)}</section>
    `;
    if (data.categoryAmounts.length) this.renderMonthCategoryChart(data);
    this.renderWeekChart(data);
  }

  private renderMonthCategoryChart(data: MonthView): void {
    const canvas = this.content.querySelector<HTMLCanvasElement>("#month-category-chart");
    if (!canvas) return;
    this.charts.push(new Chart(canvas, { type: "doughnut", data: { labels: data.categoryAmounts.map((item) => item.categoryName), datasets: [{ data: data.categoryAmounts.map((item) => item.amount), backgroundColor: data.categoryAmounts.map((item) => item.color), borderWidth: 3, borderColor: "#fff" }] }, options: { responsive: true, maintainAspectRatio: false, cutout: "68%", plugins: { legend: { display: false } } } }));
  }

  private renderWeekChart(data: MonthView): void {
    const canvas = this.content.querySelector<HTMLCanvasElement>("#week-chart");
    if (!canvas) return;
    this.charts.push(new Chart(canvas, { type: "bar", data: { labels: data.weekAmounts.map((item) => item.label), datasets: [{ data: data.weekAmounts.map((item) => item.amount), backgroundColor: "rgba(67, 97, 238, .72)", borderRadius: 6, maxBarThickness: 46 }] }, options: { responsive: true, maintainAspectRatio: false, plugins: { legend: { display: false }, tooltip: { callbacks: { label: (context) => ` ${yen(Number(context.raw))}` } } }, scales: { x: { grid: { display: false }, ticks: { color: "#8b94a7" } }, y: { beginAtZero: true, grid: { color: "#eef1f6" }, ticks: { color: "#8b94a7", callback: (value) => yen(Number(value)) } } } } }));
  }

  private async renderOcr(): Promise<void> {
    await this.loadReferenceData();
    const image = this.ocrImage;
    const result = this.ocrResult;
    const suggested = result?.suggestedCategoryNames.find((name) => this.categories.some((category) => category.name === name));
    this.content.innerHTML = `
      <section class="page-intro"><div><p class="eyebrow">LOCAL OCR</p><h2>レシートから登録</h2><p>画像はこのPC内だけで処理され、OCR結果は自動登録されません。</p></div></section>
      <section class="ocr-layout">
        <article class="card ocr-upload-card">
          <div class="card-heading"><div><p class="eyebrow">RECEIPT IMAGE</p><h3>レシート画像</h3></div></div>
          ${image ? `<div class="receipt-preview"><img src="${escapeHtml(image.dataUrl)}" alt="選択したレシート" /></div><div class="selected-file">${escapeHtml(image.fileName)}</div><div class="ocr-actions"><button class="button primary" data-action="run-ocr">${result ? "もう一度読み取る" : "OCRを実行"}</button><button class="button outline" data-action="reset-ocr">画像を選び直す</button></div>` : `<div class="upload-placeholder"><span>▧</span><p>レシート画像を選択してください</p><small>JPG、PNG、WEBPに対応</small><button class="button primary" data-action="choose-receipt">画像を選択</button></div>`}
        </article>
        <article class="card ocr-result-card">
          <div class="card-heading"><div><p class="eyebrow">CONFIRM BEFORE SAVE</p><h3>読み取り結果</h3></div></div>
          ${result ? this.ocrResultMarkup(result, suggested) : emptyState("画像を選択してOCRを実行すると、ここに結果が表示されます", "◎")}
        </article>
      </section>
    `;
  }

  private ocrResultMarkup(result: OcrResult, suggested?: string): string {
    const amount = result.amountCandidates[0] ?? "";
    return `
      <form id="ocr-expense-form" class="expense-form">
        <div class="ocr-status"><span class="status-check">✓</span><div><strong>読み取り完了</strong><small>内容を確認・修正してから登録してください。</small></div></div>
        <label class="field"><span>使用日 <b>*</b></span><input name="spentDate" type="date" value="${escapeHtml(result.date ?? this.selectedDate)}" required /></label>
        ${result.amountCandidates.length > 1 ? `<label class="field"><span>金額候補</span><select id="ocr-amount-candidate">${result.amountCandidates.map((candidate) => `<option value="${candidate}">${yen(candidate)}</option>`).join("")}</select></label>` : ""}
        <label class="field"><span>合計金額 <b>*</b></span><div class="input-with-suffix"><input id="ocr-amount" name="amount" type="number" min="1" step="1" value="${escapeHtml(amount)}" required /><em>円</em></div></label>
        <label class="field"><span>カテゴリ <b>*</b></span><select name="categoryId" required>${this.categories.map((category) => `<option value="${category.id}"${selected(category.name === suggested)}>${escapeHtml(category.name)}</option>`).join("")}</select></label>
        <label class="field"><span>メモ <small>任意</small></span><input name="memo" type="text" value="${escapeHtml(result.storeName ?? "")}" placeholder="店名、用途など" /></label>
        <label class="checkbox-field"><input name="saveReceipt" type="checkbox" checked /><span>レシート画像も保存する</span></label>
        <div class="form-actions"><button class="button primary" type="submit">確認して登録</button><button class="button ghost" type="button" data-action="manual-expense">通常入力に切り替え</button></div>
        <details class="ocr-text"><summary>読み取った全文を確認</summary><pre>${escapeHtml(result.text || "（文字を読み取れませんでした）")}</pre></details>
      </form>
    `;
  }

  private async chooseReceipt(): Promise<void> {
    const image = await window.ledgerApi.receipt.chooseImage();
    if (!image) return;
    this.ocrImage = image;
    this.ocrResult = null;
    await this.renderCurrent();
  }

  private async prepareOcrImage(dataUrl: string): Promise<string> {
    try {
      const image = await new Promise<HTMLImageElement>((resolve, reject) => {
        const loaded = new Image();
        loaded.onload = () => resolve(loaded);
        loaded.onerror = () => reject(new Error("画像を読み込めませんでした"));
        loaded.src = dataUrl;
      });
      const width = image.naturalWidth || image.width;
      const height = image.naturalHeight || image.height;
      if (!width || !height) return dataUrl;

      const scanCanvas = document.createElement("canvas");
      scanCanvas.width = width;
      scanCanvas.height = height;
      const scanContext = scanCanvas.getContext("2d", { willReadFrequently: true });
      if (!scanContext) return dataUrl;
      scanContext.drawImage(image, 0, 0);
      const pixels = scanContext.getImageData(0, 0, width, height).data;
      let minX = width;
      let minY = height;
      let maxX = -1;
      let maxY = -1;

      // Ignore the pale page background and watermark, then crop to the dark
      // receipt text/barcode before enlarging it for Tesseract.
      for (let y = 0; y < height; y += 2) {
        for (let x = 0; x < width; x += 2) {
          const index = (y * width + x) * 4;
          const gray = pixels[index] * 0.299 + pixels[index + 1] * 0.587 + pixels[index + 2] * 0.114;
          if (gray >= 205) continue;
          minX = Math.min(minX, x);
          minY = Math.min(minY, y);
          maxX = Math.max(maxX, x);
          maxY = Math.max(maxY, y);
        }
      }

      if (maxX < 0 || maxY < 0 || maxX - minX < 100 || maxY - minY < 100) return dataUrl;
      const margin = Math.max(24, Math.round(Math.min(width, height) * 0.035));
      const cropX = Math.max(0, minX - margin);
      const cropY = Math.max(0, minY - margin);
      const cropRight = Math.min(width, maxX + margin + 1);
      const cropBottom = Math.min(height, maxY + margin + 1);
      const cropWidth = cropRight - cropX;
      const cropHeight = cropBottom - cropY;
      const scale = Math.min(3, 2200 / Math.max(cropWidth, cropHeight));

      const output = document.createElement("canvas");
      output.width = Math.max(1, Math.round(cropWidth * scale));
      output.height = Math.max(1, Math.round(cropHeight * scale));
      const outputContext = output.getContext("2d", { willReadFrequently: true });
      if (!outputContext) return dataUrl;
      outputContext.fillStyle = "#fff";
      outputContext.fillRect(0, 0, output.width, output.height);
      outputContext.drawImage(image, cropX, cropY, cropWidth, cropHeight, 0, 0, output.width, output.height);

      const outputPixels = outputContext.getImageData(0, 0, output.width, output.height);
      for (let index = 0; index < outputPixels.data.length; index += 4) {
        const gray = outputPixels.data[index] * 0.299 + outputPixels.data[index + 1] * 0.587 + outputPixels.data[index + 2] * 0.114;
        const enhanced = Math.max(0, Math.min(255, Math.round((gray - 128) * 1.35 + 128)));
        outputPixels.data[index] = enhanced;
        outputPixels.data[index + 1] = enhanced;
        outputPixels.data[index + 2] = enhanced;
        outputPixels.data[index + 3] = 255;
      }
      outputContext.putImageData(outputPixels, 0, 0);
      return output.toDataURL("image/png");
    } catch {
      return dataUrl;
    }
  }

  private async runOcr(): Promise<void> {
    if (!this.ocrImage) return;
    this.showToast("OCRを実行しています。画像によって数十秒かかる場合があります。", "info");
    try {
      const processedImage = await this.prepareOcrImage(this.ocrImage.dataUrl);
      this.ocrResult = await window.ledgerApi.receipt.recognize(processedImage);
      await this.renderCurrent();
      this.showToast("読み取りが完了しました。内容を確認してください。", "success");
    } catch (error) {
      this.showToast(this.errorMessage(error), "error");
    }
  }

  private async submitOcrExpense(form: HTMLFormElement): Promise<void> {
    if (!this.ocrImage) return;
    const value = (name: string): string => (form.elements.namedItem(name) as HTMLInputElement | HTMLSelectElement)?.value ?? "";
    const saveReceipt = (form.elements.namedItem("saveReceipt") as HTMLInputElement)?.checked ?? false;
    try {
      await window.ledgerApi.expenses.create({
        spentDate: value("spentDate"),
        amount: Number(value("amount")),
        categoryId: Number(value("categoryId")),
        paymentMethodId: null,
        memo: value("memo"),
        receiptImageDataUrl: saveReceipt ? this.ocrImage.dataUrl : null
      });
      this.showToast("OCR結果から支出を登録しました", "success");
      this.ocrImage = null;
      this.ocrResult = null;
      await this.navigate("dashboard");
    } catch (error) {
      this.showToast(this.errorMessage(error), "error");
    }
  }

  private async renderSettings(): Promise<void> {
    await this.loadReferenceData(true);
    [this.monthlyBudgets, this.commonBudget] = await Promise.all([
      window.ledgerApi.budgets.list(),
      window.ledgerApi.budgets.common()
    ]);
    this.content.innerHTML = `
      <section class="page-intro"><div><p class="eyebrow">PREFERENCES</p><h2>設定</h2><p>カテゴリ、支払い方法、データの入出力を管理します。</p></div></section>
      <section class="settings-grid">
        <article class="card settings-card"><div class="card-heading"><div><p class="eyebrow">CATEGORIES</p><h3>カテゴリ管理</h3></div></div><form id="category-create-form" class="inline-create"><input name="name" type="text" placeholder="新しいカテゴリ名" required /><input name="color" type="color" value="#4361ee" title="カテゴリ色" /><button class="button primary" type="submit">追加</button></form><div class="settings-list">${this.categories.map((category, index) => this.categorySettingRow(category, index)).join("")}</div></article>
        <article class="card settings-card"><div class="card-heading"><div><p class="eyebrow">PAYMENT METHODS</p><h3>支払い方法</h3></div></div><form id="payment-create-form" class="inline-create"><input name="name" type="text" placeholder="新しい支払い方法" required /><button class="button primary" type="submit">追加</button></form><div class="settings-list">${this.paymentMethods.map((method) => this.paymentSettingRow(method)).join("")}</div></article>
      </section>
      <section class="card budget-settings-card"><div class="card-heading"><div><p class="eyebrow">MONTHLY BUDGETS</p><h3>予算設定</h3><p class="settings-description">月別予算が未設定の月には、共通予算が適用されます。月別予算は毎年同じ月に適用されます。</p></div></div><form id="budget-settings-form" class="budget-settings-form"><div class="common-budget-row"><label class="budget-field"><span>共通予算</span><div class="input-with-suffix"><input name="budget-common" data-budget-amount type="text" inputmode="numeric" maxlength="13" autocomplete="off" value="${formatBudgetInput(this.commonBudget)}" placeholder="未設定" /><em>円</em></div></label><small>各月に個別の予算がない場合、この金額を参照します。</small></div><div class="budget-input-grid">${this.monthlyBudgets.map((budget) => `<label class="budget-field"><span>${budget.month}月</span><div class="input-with-suffix"><input name="budget-${budget.month}" data-budget-amount type="text" inputmode="numeric" maxlength="13" autocomplete="off" value="${formatBudgetInput(budget.amount)}" placeholder="共通予算を使用" /><em>円</em></div><input class="budget-memo-input" name="memo-${budget.month}" type="text" maxlength="100" aria-label="${budget.month}月の補足メモ" value="${escapeHtml(budget.memo)}" placeholder="補足メモ（1行）" /></label>`).join("")}</div><div class="budget-form-footer"><small>月別予算は空欄または0円で共通予算を参照します。メモだけの保存もできます。</small><button class="button primary" type="submit">予算を保存</button></div></form></section>
      <section class="card backup-card"><div class="backup-copy"><p class="eyebrow">DATA SAFETY</p><h3>バックアップと復元</h3><p>家計簿データをJSONでバックアップ、CSVで出力できます。復元すると現在のデータは上書きされます。</p></div><div class="backup-actions"><button class="button outline" data-action="export-json">JSONバックアップ</button><button class="button outline" data-action="export-csv">CSV出力</button><button class="button danger-outline" data-action="restore-json">JSONから復元</button></div></section>
    `;
  }

  private categorySettingRow(category: Category, index: number): string {
    return `<div class="setting-row${category.isActive ? "" : " disabled"}"><span class="color-swatch" style="background:${escapeHtml(category.color)}"></span><div class="setting-name"><strong>${escapeHtml(category.name)}</strong><small>${category.isActive ? "使用中" : "無効"}</small></div><div class="setting-actions"><button class="icon-button" data-action="move-category" data-direction="up" data-id="${category.id}"${index === 0 ? " disabled" : ""}>↑</button><button class="icon-button" data-action="move-category" data-direction="down" data-id="${category.id}"${index === this.categories.length - 1 ? " disabled" : ""}>↓</button><button class="icon-button" data-action="edit-category" data-id="${category.id}">編集</button></div></div>`;
  }

  private paymentSettingRow(method: PaymentMethod): string {
    return `<div class="setting-row${method.isActive ? "" : " disabled"}"><span class="method-symbol">◈</span><div class="setting-name"><strong>${escapeHtml(method.name)}</strong><small>${method.isActive ? "使用中" : "無効"}</small></div><div class="setting-actions"><button class="icon-button" data-action="edit-payment-method" data-id="${method.id}">編集</button></div></div>`;
  }

  private async createCategory(form: HTMLFormElement): Promise<void> {
    const name = (form.elements.namedItem("name") as HTMLInputElement).value;
    const color = (form.elements.namedItem("color") as HTMLInputElement).value;
    try {
      await window.ledgerApi.categories.create({ name, color });
      this.showToast("カテゴリを追加しました", "success");
      await this.renderCurrent();
    } catch (error) {
      this.showToast(this.errorMessage(error), "error");
    }
  }

  private async createPaymentMethod(form: HTMLFormElement): Promise<void> {
    const name = (form.elements.namedItem("name") as HTMLInputElement).value;
    try {
      await window.ledgerApi.paymentMethods.create({ name });
      this.showToast("支払い方法を追加しました", "success");
      await this.renderCurrent();
    } catch (error) {
      this.showToast(this.errorMessage(error), "error");
    }
  }

  private async saveMonthlyBudgets(form: HTMLFormElement): Promise<void> {
    try {
      const commonInput = form.elements.namedItem("budget-common") as HTMLInputElement | null;
      const commonRaw = commonInput?.value.trim() ?? "";
      const commonAmount = parseBudgetInput(commonRaw);
      const monthUpdates = this.monthlyBudgets.map((budget) => {
        const input = form.elements.namedItem(`budget-${budget.month}`) as HTMLInputElement | null;
        const memoInput = form.elements.namedItem(`memo-${budget.month}`) as HTMLInputElement | null;
        return {
          month: budget.month,
          amount: parseBudgetInput(input?.value ?? ""),
          memo: memoInput?.value ?? ""
        };
      });
      const enteredAmounts = [commonAmount, ...monthUpdates.map((budget) => budget.amount)];
      if (enteredAmounts.some((amount) => amount != null && (!Number.isSafeInteger(amount) || amount < 0 || amount > 1_000_000_000))) {
        throw new Error("予算は0円以上10億円以下の整数で入力してください。");
      }
      await Promise.all([
        window.ledgerApi.budgets.updateCommon(commonAmount),
        ...monthUpdates.map((budget) => window.ledgerApi.budgets.update(budget.month, budget.amount, budget.memo))
      ]);
      this.showToast("共通予算・月別予算・補足メモを保存しました", "success");
      await this.renderCurrent();
    } catch (error) {
      this.showToast(this.errorMessage(error), "error");
    }
  }

  private async moveCategory(id: number, offset: number): Promise<void> {
    const index = this.categories.findIndex((category) => category.id === id);
    const next = index + offset;
    if (index < 0 || next < 0 || next >= this.categories.length) return;
    const ids = this.categories.map((category) => category.id);
    [ids[index], ids[next]] = [ids[next], ids[index]];
    try {
      await window.ledgerApi.categories.reorder(ids);
      await this.renderCurrent();
    } catch (error) {
      this.showToast(this.errorMessage(error), "error");
    }
  }

  private async openExpenseEditor(id: number): Promise<void> {
    if (!id) return;
    try {
      const [expenses, categories, methods] = await Promise.all([window.ledgerApi.expenses.list(), window.ledgerApi.categories.list(true), window.ledgerApi.paymentMethods.list(true)]);
      const expense = expenses.find((item) => item.id === id);
      if (!expense) throw new Error("支出が見つかりません。");
      this.categories = categories;
      this.paymentMethods = methods;
      const dialog = document.createElement("dialog");
      dialog.className = "modal-dialog";
      dialog.innerHTML = `<div class="dialog-head"><div><p class="eyebrow">EDIT EXPENSE</p><h3>支出を編集</h3></div><button class="dialog-close" type="button">×</button></div>${this.expenseFormMarkup("edit-expense-form", { spentDate: expense.spentDate, amount: String(expense.amount), categoryId: expense.categoryId, paymentMethodId: expense.paymentMethodId, memo: expense.memo })}<button class="button danger-text dialog-delete" type="button">この支出を削除</button>`;
      document.body.append(dialog);
      const form = dialog.querySelector<HTMLFormElement>("#edit-expense-form")!;
      form.querySelector<HTMLElement>("[data-action=submit-and-continue]")?.remove();
      form.querySelector<HTMLElement>("[data-view]")?.remove();
      form.addEventListener("submit", async (event) => {
        event.preventDefault();
        try {
          await window.ledgerApi.expenses.update(id, this.readExpenseForm(form));
          dialog.close();
          this.showToast("支出を更新しました", "success");
          await this.renderCurrent();
        } catch (error) {
          this.showToast(this.errorMessage(error), "error");
        }
      });
      dialog.querySelector<HTMLButtonElement>(".dialog-close")?.addEventListener("click", () => dialog.close());
      dialog.querySelector<HTMLButtonElement>(".dialog-delete")?.addEventListener("click", async () => {
        if (confirm("この支出を削除しますか？")) {
          await window.ledgerApi.expenses.delete(id);
          dialog.close();
          this.showToast("支出を削除しました", "success");
          await this.renderCurrent();
        }
      });
      dialog.addEventListener("close", () => dialog.remove(), { once: true });
      dialog.showModal();
    } catch (error) {
      this.showToast(this.errorMessage(error), "error");
    }
  }

  private async deleteExpense(id: number): Promise<void> {
    if (!id || !confirm("この支出を削除しますか？")) return;
    try {
      await window.ledgerApi.expenses.delete(id);
      this.showToast("支出を削除しました", "success");
      await this.renderCurrent();
    } catch (error) {
      this.showToast(this.errorMessage(error), "error");
    }
  }

  private async openCategoryEditor(id: number): Promise<void> {
    const category = (await window.ledgerApi.categories.list(true)).find((item) => item.id === id);
    if (!category) return;
    const dialog = document.createElement("dialog");
    dialog.className = "modal-dialog small-dialog";
    dialog.innerHTML = `<div class="dialog-head"><div><p class="eyebrow">CATEGORY</p><h3>カテゴリを編集</h3></div><button class="dialog-close" type="button">×</button></div><form class="dialog-form"><label class="field"><span>カテゴリ名</span><input name="name" value="${escapeHtml(category.name)}" required /></label><label class="field"><span>表示色</span><input name="color" type="color" value="${escapeHtml(category.color)}" /></label><label class="checkbox-field"><input name="isActive" type="checkbox"${checked(category.isActive)} /><span>使用中にする</span></label><div class="form-actions"><button class="button primary" type="submit">保存</button><button class="button ghost dialog-cancel" type="button">キャンセル</button></div></form>`;
    document.body.append(dialog);
    const form = dialog.querySelector<HTMLFormElement>("form")!;
    form.addEventListener("submit", async (event) => {
      event.preventDefault();
      try {
        await window.ledgerApi.categories.update(id, { name: (form.elements.namedItem("name") as HTMLInputElement).value, color: (form.elements.namedItem("color") as HTMLInputElement).value, isActive: (form.elements.namedItem("isActive") as HTMLInputElement).checked });
        dialog.close();
        this.showToast("カテゴリを更新しました", "success");
        await this.renderCurrent();
      } catch (error) {
        this.showToast(this.errorMessage(error), "error");
      }
    });
    dialog.querySelector(".dialog-close")?.addEventListener("click", () => dialog.close());
    dialog.querySelector(".dialog-cancel")?.addEventListener("click", () => dialog.close());
    dialog.addEventListener("close", () => dialog.remove(), { once: true });
    dialog.showModal();
  }

  private async openPaymentMethodEditor(id: number): Promise<void> {
    const method = (await window.ledgerApi.paymentMethods.list(true)).find((item) => item.id === id);
    if (!method) return;
    const dialog = document.createElement("dialog");
    dialog.className = "modal-dialog small-dialog";
    dialog.innerHTML = `<div class="dialog-head"><div><p class="eyebrow">PAYMENT METHOD</p><h3>支払い方法を編集</h3></div><button class="dialog-close" type="button">×</button></div><form class="dialog-form"><label class="field"><span>名称</span><input name="name" value="${escapeHtml(method.name)}" required /></label><label class="checkbox-field"><input name="isActive" type="checkbox"${checked(method.isActive)} /><span>使用中にする</span></label><div class="form-actions"><button class="button primary" type="submit">保存</button><button class="button ghost dialog-cancel" type="button">キャンセル</button></div></form>`;
    document.body.append(dialog);
    const form = dialog.querySelector<HTMLFormElement>("form")!;
    form.addEventListener("submit", async (event) => {
      event.preventDefault();
      try {
        await window.ledgerApi.paymentMethods.update(id, { name: (form.elements.namedItem("name") as HTMLInputElement).value, isActive: (form.elements.namedItem("isActive") as HTMLInputElement).checked });
        dialog.close();
        this.showToast("支払い方法を更新しました", "success");
        await this.renderCurrent();
      } catch (error) {
        this.showToast(this.errorMessage(error), "error");
      }
    });
    dialog.querySelector(".dialog-close")?.addEventListener("click", () => dialog.close());
    dialog.querySelector(".dialog-cancel")?.addEventListener("click", () => dialog.close());
    dialog.addEventListener("close", () => dialog.remove(), { once: true });
    dialog.showModal();
  }

  private async exportJson(): Promise<void> {
    try {
      const path = await window.ledgerApi.backup.exportJson();
      if (path) this.showToast(`JSONバックアップを保存しました: ${path}`, "success");
    } catch (error) {
      this.showToast(this.errorMessage(error), "error");
    }
  }

  private async exportCsv(): Promise<void> {
    try {
      const path = await window.ledgerApi.backup.exportCsv();
      if (path) this.showToast(`CSVを保存しました: ${path}`, "success");
    } catch (error) {
      this.showToast(this.errorMessage(error), "error");
    }
  }

  private async printCurrentView(exportPdf: boolean): Promise<void> {
    if (!(["dashboard", "weekly", "monthly"] as View[]).includes(this.activeView)) return;
    const fileName = this.activeView === "dashboard"
      ? `household-ledger-dashboard-${this.selectedDate}`
      : this.activeView === "weekly"
        ? `household-ledger-weekly-${this.selectedWeekStart}-to-${addDays(this.selectedWeekStart, 6)}`
        : `household-ledger-monthly-${this.selectedMonth}`;
    try {
      document.body.classList.add("print-mode");
      this.setChartPrintMode(true);
      // Let Chart.js finish its current paint before Electron captures the page.
      await new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve())));
      if (exportPdf) {
        const path = await window.ledgerApi.printing.exportPdf(fileName);
        if (path) this.showToast(`PDFを保存しました: ${path}`, "success");
      } else if (await window.ledgerApi.printing.print()) {
        this.showToast("印刷処理を開始しました", "success");
      }
    } catch (error) {
      this.showToast(this.errorMessage(error), "error");
    } finally {
      this.setChartPrintMode(false);
      document.body.classList.remove("print-mode");
    }
  }

  private setChartPrintMode(printing: boolean): void {
    const gridColor = printing ? "#aeb7c5" : "#eef1f6";
    this.charts.forEach((chart) => {
      const scales = chart.options.scales as unknown as Record<string, { grid?: { color?: string } }> | undefined;
      Object.values(scales ?? {}).forEach((scale) => {
        if (scale?.grid) scale.grid.color = gridColor;
      });
      chart.update("none");
    });
  }

  private async restoreJson(): Promise<void> {
    try {
      const result = await window.ledgerApi.backup.restoreJson();
      if (result) {
        this.ocrImage = null;
        this.ocrResult = null;
        this.showToast(`${result.expenses}件の支出を復元しました`, "success");
        await this.renderCurrent();
      }
    } catch (error) {
      this.showToast(this.errorMessage(error), "error");
    }
  }

  private showToast(message: string, kind: "success" | "error" | "info"): void {
    const region = document.querySelector<HTMLDivElement>("#toast-region");
    if (!region) return;
    const toast = document.createElement("div");
    toast.className = `toast ${kind}`;
    toast.innerHTML = `<span>${kind === "success" ? "✓" : kind === "error" ? "!" : "i"}</span><p>${escapeHtml(message)}</p>`;
    region.append(toast);
    window.setTimeout(() => toast.remove(), 5000);
  }

  private errorMessage(error: unknown): string {
    return error instanceof Error ? error.message : String(error || "予期しないエラーが発生しました。");
  }
}
