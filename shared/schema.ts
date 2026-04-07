import { sqliteTable, text, real, integer } from "drizzle-orm/sqlite-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod";

export const loanEstimates = sqliteTable("loan_estimates", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  address: text("address").notNull(),
  homePrice: real("home_price").notNull(),
  downPaymentPercent: real("down_payment_percent").notNull(),
  loanType: text("loan_type").notNull(),
  loanTerm: integer("loan_term").notNull(),
  interestRate: real("interest_rate").notNull(),
  propertyTax: real("property_tax").notNull(),
  hoaFee: real("hoa_fee").notNull(),
  homeInsurance: real("home_insurance").notNull(),
  monthlyPayment: real("monthly_payment").notNull(),
  closingCosts: real("closing_costs").notNull(),
});

export const insertLoanEstimateSchema = createInsertSchema(loanEstimates).omit({
  id: true,
});

export type InsertLoanEstimate = z.infer<typeof insertLoanEstimateSchema>;
export type LoanEstimate = typeof loanEstimates.$inferSelect;

export const propertyLookupSchema = z.object({
  address: z.string().min(5, "Please enter a valid address"),
});

export const loanEstimateRequestSchema = z.object({
  address: z.string().min(5),
  homePrice: z.number().positive(),
  downPaymentPercent: z.number().min(0).max(100),
  loanType: z.enum(["conventional_30", "conventional_15", "fha_30", "va_30", "jumbo_30", "arm_7_1"]),
  propertyTax: z.number().min(0),
  hoaFee: z.number().min(0),
  // Optional overrides
  customRate: z.union([z.string(), z.number(), z.null()]).optional(),
  pmiOverride: z.union([z.string(), z.number(), z.null()]).optional(),   // 0.01–2.00%
  vaFundingFeeOption: z.enum(["exempt", "first_use", "subsequent_use"]).optional(), // VA only
  stateCode: z.string().optional(),
  sellerPaysTitle: z.boolean().optional(),
  includeEscrow: z.boolean().optional(),
  floodInsuranceRequired: z.boolean().optional(),
  closingDate: z.string().optional(),
});
