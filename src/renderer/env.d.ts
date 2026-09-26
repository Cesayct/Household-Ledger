import type { HouseholdLedgerApi } from "../shared/types";

declare global {
  interface Window {
    ledgerApi: HouseholdLedgerApi;
  }
}

export {};
