const pad = (value: number) => String(value).padStart(2, "0");

export const toDateKey = (date: Date): string =>
  `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;

export const todayKey = (): string => toDateKey(new Date());

export const parseDateKey = (value: string): Date => {
  const [year, month, day] = value.split("-").map(Number);
  return new Date(year, month - 1, day);
};

export const addDays = (value: string, amount: number): string => {
  const date = parseDateKey(value);
  date.setDate(date.getDate() + amount);
  return toDateKey(date);
};

export const getWeekStart = (value: string): string => {
  const date = parseDateKey(value);
  const day = date.getDay();
  const offset = day === 0 ? -6 : 1 - day;
  return addDays(value, offset);
};

export const getWeekRange = (value: string): { start: string; end: string } => {
  const start = getWeekStart(value);
  return { start, end: addDays(start, 6) };
};

export const getMonthRange = (month: string): { start: string; end: string; days: number } => {
  const [year, monthNumber] = month.split("-").map(Number);
  const startDate = new Date(year, monthNumber - 1, 1);
  const endDate = new Date(year, monthNumber, 0);
  return {
    start: toDateKey(startDate),
    end: toDateKey(endDate),
    days: endDate.getDate()
  };
};

export const monthKey = (value: string): string => value.slice(0, 7);

export const formatDateJa = (value: string, withYear = false): string => {
  const date = parseDateKey(value);
  return withYear
    ? `${date.getFullYear()}/${date.getMonth() + 1}/${date.getDate()}`
    : `${date.getMonth() + 1}/${date.getDate()}`;
};

export const formatMonthJa = (value: string): string => {
  const [year, month] = value.split("-");
  return `${year}年${Number(month)}月`;
};

export const isValidDateKey = (value: string): boolean => {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const date = parseDateKey(value);
  return toDateKey(date) === value;
};
