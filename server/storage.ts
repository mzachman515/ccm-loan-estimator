import { drizzle } from "drizzle-orm/better-sqlite3";
import Database from "better-sqlite3";
import * as schema from "@shared/schema";
import { InsertLoanEstimate, LoanEstimate } from "@shared/schema";

const sqlite = new Database("./data.db");
export const db = drizzle(sqlite, { schema });

// Auto-create tables
sqlite.exec(`
  CREATE TABLE IF NOT EXISTS loan_estimates (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    address TEXT NOT NULL,
    home_price REAL NOT NULL,
    down_payment_percent REAL NOT NULL,
    loan_type TEXT NOT NULL,
    loan_term INTEGER NOT NULL,
    interest_rate REAL NOT NULL,
    property_tax REAL NOT NULL,
    hoa_fee REAL NOT NULL,
    home_insurance REAL NOT NULL,
    monthly_payment REAL NOT NULL,
    closing_costs REAL NOT NULL
  )
`);

export interface IStorage {
  saveLoanEstimate(estimate: InsertLoanEstimate): LoanEstimate;
  getRecentEstimates(limit?: number): LoanEstimate[];
  getRecentAddresses(limit?: number): { address: string; homePrice: number; loanType: string }[];
}

export class Storage implements IStorage {
  saveLoanEstimate(estimate: InsertLoanEstimate): LoanEstimate {
    return db.insert(schema.loanEstimates).values(estimate).returning().get();
  }

  getRecentEstimates(limit: number = 10): LoanEstimate[] {
    return db.select().from(schema.loanEstimates).all().slice(-limit).reverse();
  }

  getRecentAddresses(limit: number = 20): { address: string; homePrice: number; loanType: string }[] {
    // Get unique addresses, most recent first
    const all = db.select().from(schema.loanEstimates).all().reverse();
    const seen = new Set<string>();
    const results: { address: string; homePrice: number; loanType: string }[] = [];
    for (const row of all) {
      const key = row.address.toLowerCase().trim();
      if (!seen.has(key)) {
        seen.add(key);
        results.push({ address: row.address, homePrice: row.homePrice, loanType: row.loanType });
      }
      if (results.length >= limit) break;
    }
    return results;
  }
}

export const storage = new Storage();
