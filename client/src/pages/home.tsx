import { useState, useRef, useEffect, useCallback } from "react";
import { useQuery, useMutation } from "@tanstack/react-query";
import { useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { z } from "zod";
import { apiRequest, API_BASE } from "@/lib/queryClient";
import michaelPhoto from "@assets/michael-zachman.jpeg";
import { jsPDF } from "jspdf";
import autoTable from "jspdf-autotable";
import { useToast } from "@/hooks/use-toast";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Form, FormControl, FormField, FormItem, FormLabel, FormMessage } from "@/components/ui/form";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Separator } from "@/components/ui/separator";
import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";
import {
  Home, Search, DollarSign, TrendingDown, Calendar,
  Shield, ChevronDown, ChevronUp, Info, Phone, Mail, ExternalLink, MapPin
} from "lucide-react";



// ─── Types ───────────────────────────────────────────────────────────────────

interface MortgageRate {
  key: string;
  label: string;
  rate: number;
  termYears: number;
  asOf: string;
  source: string;
}

interface AddressSuggestion {
  text: string;
  magicKey?: string;
}

interface PropertyData {
  price: number | null;
  propertyTax: number | null;
  hoaFee: number | null;
  zestimate: number | null;
  imageUrl: string | null;
  bedrooms: number | null;
  bathrooms: number | null;
  sqft: number | null;
  cityStateZip: string | null;
  stateCode: string | null;
  county: string | null;
  taxRate: number | null;
  taxRateSource: string | null;
  appraisalUrl: string | null;
  parcelId: string | null;
  assessedValue: number | null;
  annualTax: number | null;
  taxFromParcel: boolean;
  floodZone: string | null;
  zillowUrl: string | null;
  source: string;
}

interface EstimateResult {
  id: number;
  address: string;
  homePrice: number;
  downPaymentPercent: number;
  downPaymentAmount: number;
  loanAmount: number;
  loanType: string;
  loanTerm: number;
  interestRate: number;
  monthlyBreakdown: {
    principalAndInterest: number;
    propertyTax: number;
    homeInsurance: number;
    flood: number;
    floodInsuranceRequired: boolean;
    hoa: number;
    mortgageInsurance: number;
  };
  ufmip: number;
  totalMonthlyPayment: number;
  closingCosts: number;
  closingCostBreakdown: Record<string, number | string>;
  totalCashNeeded: number;
  rateIsCustom: boolean;
  escrowWaived: boolean;
  sellerPaysTitle: boolean;
  sellerTitleCredit: number;
  grossClosingCosts: number;      // total before any seller credit
  additionalSellerCredit?: number;
  vaFundingFee?: number;
  vaFundingFeeOption?: string;
  vaFundingFeeRate?: number;
  pmiOverrideRate?: number | null;
  rateSource: string;
  insuranceNote: string;
}

// ─── Form Schema ─────────────────────────────────────────────────────────────

const formSchema = z.object({
  address: z.string().min(5, "Please enter a complete address"),
  homePrice: z.coerce.number().positive("Home price must be positive"),
  downPaymentPercent: z.coerce.number().min(0).max(100),
  loanType: z.string().min(1, "Please select a loan type"),
  customRate: z.string().optional(),
  pmiOverride: z.string().optional(),           // 0.01–2.00% override
  vaFundingFeeOption: z.string().optional(),     // exempt | first_use | subsequent_use
  additionalSellerCredit: z.string().optional(), // dollar amount
  propertyTax: z.coerce.number().min(0),
  hoaFee: z.coerce.number().min(0),
  closingDate: z.string().optional(),
});
type FormValues = z.infer<typeof formSchema>;

// ─── Helpers ─────────────────────────────────────────────────────────────────

const fmt = (n: number, d = 0) =>
  n.toLocaleString("en-US", { minimumFractionDigits: d, maximumFractionDigits: d });
const fmtCurrency = (n: number) => "$" + fmt(Math.round(n));
const fmtRate = (n: number) => n.toFixed(2) + "%";

function debounce<T extends (...args: any[]) => void>(fn: T, delay: number) {
  let timer: ReturnType<typeof setTimeout>;
  return (...args: Parameters<T>) => {
    clearTimeout(timer);
    timer = setTimeout(() => fn(...args), delay);
  };
}

// ─── Sub-components ───────────────────────────────────────────────────────────

function Spinner() {
  return (
    <svg className="animate-spin w-4 h-4" viewBox="0 0 24 24" fill="none">
      <circle cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="3"
        strokeDasharray="60" strokeDashoffset="15" />
    </svg>
  );
}

function RateBadge({ rate }: { rate: MortgageRate }) {
  return (
    <div className="flex items-center justify-between py-2.5 border-b last:border-0 border-border">
      <span className="text-sm text-muted-foreground leading-tight">{rate.label}</span>
      <Badge variant="secondary" className="font-mono font-bold ml-2 shrink-0" style={{ color: "#007a8c" }}>
        {fmtRate(rate.rate)}
      </Badge>
    </div>
  );
}

function SummaryRow({ label, value, highlight = false, sub = false }: {
  label: string; value: string; highlight?: boolean; sub?: boolean;
}) {
  return (
    <div className={`flex justify-between items-center py-2.5 ${sub ? "pl-4" : ""} ${highlight ? "bg-secondary/40 rounded-md px-3 mt-1" : ""}`}>
      <span className={`${sub ? "text-sm text-muted-foreground" : ""} ${highlight ? "font-semibold" : ""}`}>{label}</span>
      <span
        className={`result-number ${highlight ? "font-bold text-lg" : sub ? "text-sm" : ""}`}
        style={highlight ? { color: "#1a3d5c" } : undefined}
      >
        {value}
      </span>
    </div>
  );
}

function ClosingCostSection({ label }: { label: string }) {
  // Strip the em-dash decorators from the header key
  const clean = label.replace(/[──\s]+/g, " ").replace(/^\s*|\s*$/g, "");
  return (
    <div className="pt-3 pb-1">
      <p className="text-xs font-bold uppercase tracking-wider" style={{ color: "#007a8c" }}>{clean}</p>
    </div>
  );
}

// ─── Address Autocomplete Component ──────────────────────────────────────────

function AddressAutocomplete({
  value,
  onChange,
  onSelect,
  placeholder,
}: {
  value: string;
  onChange: (val: string) => void;
  onSelect: (suggestion: AddressSuggestion) => void;
  placeholder?: string;
}) {
  const [suggestions, setSuggestions] = useState<AddressSuggestion[]>([]);
  const [isOpen, setIsOpen] = useState(false);
  const [loading, setLoading] = useState(false);
  const [activeIndex, setActiveIndex] = useState(-1);
  const containerRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  const fetchSuggestions = useCallback(
    debounce(async (q: string) => {
      if (q.length < 3) { setSuggestions([]); setIsOpen(false); return; }
      setLoading(true);
      try {
        const res = await fetch(`${API_BASE}/api/autocomplete?q=${encodeURIComponent(q)}`);
        const data = await res.json();
        // ArcGIS returns { text, magicKey } objects
        const suggestions: AddressSuggestion[] = (data.suggestions ?? []).map((s: any) => ({
          text: s.text ?? s.display ?? "",
          magicKey: s.magicKey ?? undefined,
        }));
        setSuggestions(suggestions);
        setIsOpen(suggestions.length > 0);
        setActiveIndex(-1);
      } catch {
        setSuggestions([]);
      } finally {
        setLoading(false);
      }
    }, 280),
    []
  );

  useEffect(() => {
    fetchSuggestions(value);
  }, [value]);

  // Close on outside click
  useEffect(() => {
    const handler = (e: MouseEvent) => {
      if (containerRef.current && !containerRef.current.contains(e.target as Node)) {
        setIsOpen(false);
      }
    };
    document.addEventListener("mousedown", handler);
    return () => document.removeEventListener("mousedown", handler);
  }, []);

  function handleKeyDown(e: React.KeyboardEvent) {
    if (!isOpen) return;
    if (e.key === "ArrowDown") {
      e.preventDefault();
      setActiveIndex(i => Math.min(i + 1, suggestions.length - 1));
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      setActiveIndex(i => Math.max(i - 1, -1));
    } else if (e.key === "Enter" && activeIndex >= 0) {
      e.preventDefault();
      handleSelect(suggestions[activeIndex]);
    } else if (e.key === "Escape") {
      setIsOpen(false);
    }
  }

  function handleSelect(s: AddressSuggestion) {
    onChange(s.text);
    setSuggestions([]);
    setIsOpen(false);
    onSelect(s);
  }

  return (
    <div ref={containerRef} className="relative flex-1">
      <div className="relative">
        <MapPin className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-muted-foreground pointer-events-none" />
        <input
          ref={inputRef}
          data-testid="input-address"
          type="text"
          value={value}
          onChange={e => onChange(e.target.value)}
          onKeyDown={handleKeyDown}
          onFocus={() => suggestions.length > 0 && setIsOpen(true)}
          placeholder={placeholder}
          className="w-full pl-9 pr-3 py-2 text-sm border border-input rounded-md bg-background text-foreground placeholder:text-muted-foreground focus:outline-none focus:ring-2 focus:ring-ring focus:ring-offset-0 h-10"
          autoComplete="off"
        />
        {loading && (
          <div className="absolute right-3 top-1/2 -translate-y-1/2">
            <Spinner />
          </div>
        )}
      </div>

      {isOpen && suggestions.length > 0 && (
        <div
          className="absolute z-50 w-full mt-1 bg-card border border-border rounded-lg shadow-lg overflow-hidden"
          style={{ maxHeight: "260px", overflowY: "auto" }}
        >
          {suggestions.map((s, i) => (
            <button
              key={i}
              type="button"
              onMouseDown={() => handleSelect(s)}
              className={`w-full text-left px-4 py-2.5 text-sm flex items-center gap-2 transition-colors ${
                i === activeIndex ? "text-white" : "text-foreground hover:bg-secondary/60"
              }`}
              style={i === activeIndex ? { backgroundColor: "#1a3d5c" } : undefined}
            >
              <MapPin className="w-3.5 h-3.5 shrink-0 opacity-60" />
              <span className="truncate">{s.text}</span>
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

// ─── Main Page ────────────────────────────────────────────────────────────────



// ─── PDF Generation ───────────────────────────────────────────────────────────

function generatePDF(estimate: EstimateResult) {
  const doc = new jsPDF({ orientation: "portrait", unit: "mm", format: "letter" });
  const W = doc.internal.pageSize.getWidth();
  const margin = 14;
  let y = 0;

  // ── Header bar ──────────────────────────────────────────────────────────────
  doc.setFillColor(26, 61, 92);  // CCM navy
  doc.rect(0, 0, W, 22, "F");
  doc.setTextColor(255, 255, 255);
  doc.setFontSize(13);
  doc.setFont("helvetica", "bold");
  doc.text("CrossCountry Mortgage", margin, 9);
  doc.setFontSize(8);
  doc.setFont("helvetica", "normal");
  doc.text("Michael Zachman  ·  Loan Officer  ·  NMLS #1682867  ·  (561) 657-7750  ·  Michael.Zachman@ccm.com", margin, 15.5);
  // Accent bar
  doc.setFillColor(0, 122, 140);  // CCM teal
  doc.rect(0, 22, W, 1.5, "F");
  y = 30;

  // ── Title ───────────────────────────────────────────────────────────────────
  doc.setTextColor(26, 61, 92);
  doc.setFontSize(13);
  doc.setFont("helvetica", "bold");
  doc.text("Home Purchase Loan Estimate", margin, y);
  y += 4;
  doc.setFontSize(7.5);
  doc.setFont("helvetica", "normal");
  doc.setTextColor(100, 100, 100);
  doc.text(estimate.address, margin, y);
  doc.text("Generated: " + new Date().toLocaleDateString("en-US", { month: "long", day: "numeric", year: "numeric" }), W - margin, y, { align: "right" });
  y += 6;

  // ── Two hero boxes side by side ──────────────────────────────────────────────
  const boxW = (W - margin * 2 - 4) / 2;
  const boxH = 34; // compact hero boxes
  const cx1 = margin + boxW / 2;
  const cx2 = margin + boxW + 4 + boxW / 2;

  // Monthly Payment box (navy)
  doc.setFillColor(26, 61, 92);
  doc.roundedRect(margin, y, boxW, boxH, 2, 2, "F");
  doc.setFontSize(6.5); doc.setFont("helvetica", "bold"); doc.setTextColor(126, 203, 214);
  doc.text("EST. MONTHLY PAYMENT", cx1, y + 6, { align: "center" });
  doc.setFontSize(20); doc.setFont("helvetica", "bold"); doc.setTextColor(255, 255, 255);
  doc.text(fmtCurrency(estimate.totalMonthlyPayment), cx1, y + 19, { align: "center" });
  doc.setFontSize(6.5); doc.setFont("helvetica", "normal"); doc.setTextColor(200, 230, 235);
  doc.text("/ month · all-in", cx1, y + 28, { align: "center" });

  // Cash to Close box (teal)
  doc.setFillColor(0, 122, 140);
  doc.roundedRect(margin + boxW + 4, y, boxW, boxH, 2, 2, "F");
  doc.setFontSize(6.5); doc.setFont("helvetica", "bold"); doc.setTextColor(255, 255, 255);
  doc.text("TOTAL CASH TO CLOSE", cx2, y + 6, { align: "center" });
  doc.setFontSize(20); doc.setFont("helvetica", "bold"); doc.setTextColor(255, 255, 255);
  doc.text(fmtCurrency(estimate.totalCashNeeded), cx2, y + 19, { align: "center" });
  doc.setFontSize(6.5); doc.setFont("helvetica", "normal"); doc.setTextColor(220, 240, 243);
  doc.text("needed at closing", cx2, y + 28, { align: "center" });
  y += boxH + 4;

  // ── Loan Summary + Monthly Breakdown side by side ────────────────────────────
  const col1 = margin;
  const col2 = margin + boxW + 4;

  // Loan Summary header
  doc.setFillColor(240, 248, 250);
  doc.roundedRect(col1, y, boxW, 6, 1, 1, "F");
  doc.setTextColor(0, 122, 140);
  doc.setFontSize(8);
  doc.setFont("helvetica", "bold");
  doc.text("LOAN SUMMARY", col1 + 3, y + 4.2);
  y += 7;

  const loanRows: [string, string][] = [
    ["Home Price", fmtCurrency(estimate.homePrice)],
    ["Down Payment (" + estimate.downPaymentPercent + "%)", fmtCurrency(estimate.downPaymentAmount)],
    ["Loan Amount", fmtCurrency(estimate.loanAmount)],
    ["Loan Type", estimate.loanType],
    ["Term", estimate.loanTerm + " Years"],
    ["Interest Rate", fmtRate(estimate.interestRate) + (estimate.rateIsCustom ? " (custom)" : "")],
  ];
  if (estimate.ufmip > 0) {
    loanRows.push(["FHA UFMIP Financed", fmtCurrency(estimate.ufmip)]);
  }

  // Monthly Breakdown header (right column, same y start)
  const mbY = y - 7;
  doc.setFillColor(240, 248, 250);
  doc.roundedRect(col2, mbY, boxW, 6, 1, 1, "F");
  doc.setTextColor(0, 122, 140);
  doc.setFontSize(8);
  doc.setFont("helvetica", "bold");
  doc.text("MONTHLY PAYMENT BREAKDOWN", col2 + 3, mbY + 4.2);

  const mbRows: [string, string][] = [
    ["Principal & Interest", fmtCurrency(estimate.monthlyBreakdown.principalAndInterest)],
    ["Property Tax", fmtCurrency(estimate.monthlyBreakdown.propertyTax)],
    ["Home Insurance", fmtCurrency(estimate.monthlyBreakdown.homeInsurance)],
  ];
  if (estimate.monthlyBreakdown.flood > 0) mbRows.push(["Flood Insurance", fmtCurrency(estimate.monthlyBreakdown.flood)]);
  if (estimate.monthlyBreakdown.hoa > 0)  mbRows.push(["HOA Fee", fmtCurrency(estimate.monthlyBreakdown.hoa)]);
  if (estimate.monthlyBreakdown.mortgageInsurance > 0) mbRows.push(["Mortgage Insurance", fmtCurrency(estimate.monthlyBreakdown.mortgageInsurance)]);
  mbRows.push(["TOTAL MONTHLY", fmtCurrency(estimate.totalMonthlyPayment)]);

  // Draw both tables
  const tableStyle = {
    theme: "plain" as const,
    styles: { fontSize: 7.5, cellPadding: 1.2, textColor: [50, 50, 50] as [number,number,number] },
    columnStyles: { 0: { cellWidth: boxW * 0.6 }, 1: { cellWidth: boxW * 0.4, halign: "right" as const, fontStyle: "bold" as const } },
    margin: { left: col1, right: W - col1 - boxW },
  };

  autoTable(doc, {
    body: loanRows,
    startY: y,
    ...tableStyle,
    margin: { left: col1, right: W - col1 - boxW },
    didDrawCell: (data: any) => {
      if (data.row.index === 2) {  // Loan Amount row highlight
        doc.setFillColor(226, 240, 249);
        doc.rect(data.cell.x, data.cell.y, data.cell.width, data.cell.height, "F");
        doc.setTextColor(26, 61, 92);
        doc.setFont("helvetica", "bold");
        doc.text(data.cell.text[0], data.cell.x + (data.column.index === 1 ? data.cell.width - 1.5 : 1.5), data.cell.y + data.cell.height - 1.5, { align: data.column.index === 1 ? "right" : "left" });
      }
    }
  });
  const loanEndY = (doc as any).lastAutoTable.finalY;

  autoTable(doc, {
    body: mbRows,
    startY: mbY + 7,
    ...tableStyle,
    margin: { left: col2, right: W - col2 - boxW },
    didDrawCell: (data: any) => {
      if (data.row.index === mbRows.length - 1) {
        doc.setFillColor(226, 240, 249);
        doc.rect(data.cell.x, data.cell.y, data.cell.width, data.cell.height, "F");
        doc.setTextColor(26, 61, 92);
        doc.setFont("helvetica", "bold");
        doc.text(data.cell.text[0], data.cell.x + (data.column.index === 1 ? data.cell.width - 1.5 : 1.5), data.cell.y + data.cell.height - 1.5, { align: data.column.index === 1 ? "right" : "left" });
      }
    }
  });
  const mbEndY = (doc as any).lastAutoTable.finalY;

  y = Math.max(loanEndY, mbEndY) + 4;

  // ── Cash to Close detail + Closing Costs Breakdown side by side ─────────────
  // Left col: Cash to close summary | Right col: closing costs breakdown
  // This 2-column layout is key to fitting everything on one page.

  // Build closing cost rows (without additional seller credit — show separately)
  const SECTION_PREFIX = ">> ";
  const ccRows: [string, string][] = [];
  let grossClosingTotal = 0; // total before additional seller credit
  const additionalCredit = estimate.additionalSellerCredit ?? 0;

  for (const [label, amount] of Object.entries(estimate.closingCostBreakdown)) {
    // Skip the "Additional Seller Credit" line — we'll add it below as a separate summary row
    if (label === "Additional Seller Credit") continue;
    if (amount === "header") {
      const cleanLabel = label.replace(/[-─\s]+/g, " ").trim();
      ccRows.push([SECTION_PREFIX + cleanLabel, ""]);
    } else {
      const amt = amount as number;
      if (amt !== 0) grossClosingTotal += amt; // tally gross (includes title credits)
      ccRows.push([label, amt < 0 ? "-" + fmtCurrency(Math.abs(amt)) : fmtCurrency(amt)]);
    }
  }

  // Subtotal + additional credit + net rows
  ccRows.push([SECTION_PREFIX + "TOTALS", ""]);
  ccRows.push(["Total Closing Costs", fmtCurrency(Math.round(grossClosingTotal))]);
  if (additionalCredit > 0) {
    ccRows.push(["Additional Seller Credit", "-" + fmtCurrency(additionalCredit)]);
    ccRows.push(["NET CASH TO CLOSE", fmtCurrency(estimate.totalCashNeeded)]);
  }

  // Left col: cash-to-close summary
  doc.setFillColor(240, 248, 250);
  doc.roundedRect(col1, y, boxW, 6, 1, 1, "F");
  doc.setTextColor(0, 122, 140);
  doc.setFontSize(7.5);
  doc.setFont("helvetica", "bold");
  doc.text("CASH NEEDED TO CLOSE", col1 + 3, y + 4.2);

  const grossPct = ((estimate.grossClosingCosts / estimate.homePrice) * 100).toFixed(1);
  const cashRows: [string, string][] = [
    ["Down Payment (" + estimate.downPaymentPercent + "%)", fmtCurrency(estimate.downPaymentAmount)],
    ["Total Closing Costs (" + grossPct + "% of price)", fmtCurrency(estimate.grossClosingCosts)],
  ];
  if (additionalCredit > 0) {
    const netPct = ((estimate.closingCosts / estimate.homePrice) * 100).toFixed(1);
    cashRows.push(["Seller Credit", "-" + fmtCurrency(additionalCredit)]);
    cashRows.push(["Net Closing Costs (" + netPct + "% of price)", fmtCurrency(estimate.closingCosts)]);
  }
  cashRows.push(["TOTAL CASH TO CLOSE", fmtCurrency(estimate.totalCashNeeded)]);

  autoTable(doc, {
    body: cashRows,
    startY: y + 7,
    ...tableStyle,
    styles: { ...tableStyle.styles, fontSize: 7.5, cellPadding: 1.3 },
    margin: { left: col1, right: W - col1 - boxW },
    didParseCell: (data: any) => {
      if (data.row.index === cashRows.length - 1) {
        data.cell.styles.fontStyle = "bold";
        data.cell.styles.textColor = [26, 61, 92];
        data.cell.styles.fillColor = [226, 240, 249];
      }
      if (typeof data.row.raw[1] === "string" && data.row.raw[1].startsWith("-")) {
        data.cell.styles.textColor = [0, 122, 140];
        data.cell.styles.fontStyle = "bold";
      }
    },
  });
  const cashEndY = (doc as any).lastAutoTable.finalY;

  // Right col: closing costs breakdown
  doc.setFillColor(26, 61, 92);
  doc.roundedRect(col2, y, boxW, 6, 1, 1, "F");
  doc.setTextColor(255, 255, 255);
  doc.setFontSize(7.5);
  doc.setFont("helvetica", "bold");
  doc.text("CLOSING COSTS BREAKDOWN", col2 + 3, y + 4.2);

  autoTable(doc, {
    body: ccRows,
    startY: y + 7,
    theme: "plain",
    styles: { fontSize: 6.8, cellPadding: 0.9, textColor: [50, 50, 50] as [number,number,number] },
    columnStyles: {
      0: { cellWidth: boxW * 0.70 },
      1: { cellWidth: boxW * 0.30, halign: "right" as const },
    },
    margin: { left: col2, right: margin },
    didParseCell: (data: any) => {
      if (data.cell.raw === "") return;
      const raw = data.row.raw[0] as string;
      if (raw.startsWith(SECTION_PREFIX)) {
        data.cell.styles.fillColor = [240, 248, 250];
        data.cell.styles.textColor = [0, 122, 140];
        data.cell.styles.fontStyle = "bold";
        data.cell.styles.fontSize = 6.5;
        if (Array.isArray(data.cell.text)) data.cell.text = [raw.slice(SECTION_PREFIX.length)];
      }
      if (typeof data.row.raw[1] === "string" && data.row.raw[1].startsWith("-")) {
        data.cell.styles.textColor = [0, 122, 140];
        data.cell.styles.fontStyle = "bold";
      }
      // Totals rows bold
      if (raw === "Total Closing Costs" || raw === "NET CASH TO CLOSE") {
        data.cell.styles.fontStyle = "bold";
        data.cell.styles.textColor = [26, 61, 92];
      }
    },
  });
  const ccEndY = (doc as any).lastAutoTable.finalY;

  y = Math.max(cashEndY, ccEndY) + 5;

  // ── Footer / Disclosures ─────────────────────────────────────────────────────
  const pageH = doc.internal.pageSize.getHeight();
  // Check if we need a new page
  if (y > pageH - 30) { doc.addPage(); y = 15; }

  doc.setDrawColor(220, 220, 220);
  doc.line(margin, y, W - margin, y);
  y += 4;
  doc.setFontSize(6.5);
  doc.setFont("helvetica", "normal");
  doc.setTextColor(130, 130, 130);
  const disclaimers = [
    "Rate source: " + estimate.rateSource,
    "Home insurance estimated at 0.8% of purchase price annually. * Items marked with * are estimated 3rd-party costs.",
    "This estimate is for informational purposes only and does not constitute a loan offer. Actual rates and fees depend on your credit profile,",
    "lender, and property details. CrossCountry Mortgage, LLC · NMLS #3029 · Equal Housing Opportunity Lender. Michael Zachman NMLS #1682867.",
  ];
  for (const line of disclaimers) {
    doc.text(line, margin, y);
    y += 3.5;
  }

  // ── Filename: "123 Main St - $500,000 - 20% Down - Conventional 30yr.pdf" ──
  const streetPart = estimate.address.split(",")[0].trim();
  const loanShort = estimate.loanType
    .replace("30-Year Fixed", "30yr")
    .replace("15-Year Fixed", "15yr")
    .replace("(Conventional)", "Conv")
    .replace("(FHA)", "FHA")
    .replace("(VA)", "VA")
    .replace("(Jumbo)", "Jumbo")
    .replace("7/1 Adjustable Rate (ARM)", "ARM")
    .replace(/[()]/g, "").trim();
  const filename = `${streetPart} - ${fmtCurrency(estimate.homePrice)} - ${estimate.downPaymentPercent}pct Down - ${loanShort}.pdf`
    .replace(/[/\\:*?"<>|]/g, "-"); // sanitize for file system
  doc.save(filename);
}

// ─── Market Data Panel ───────────────────────────────────────────────────────

interface MarketDataPoint {
  label: string;
  value: number;
  change: number;
  date: string;
  category: "mortgage" | "treasury" | "mbs";
}

function MarketDataPanel() {
  const { data, isLoading } = useQuery<{ data: MarketDataPoint[]; fetchedAt: string }>({
    queryKey: ["/api/market-data"],
    refetchInterval: 15 * 60 * 1000,
    staleTime: 5 * 60 * 1000,
  });

  const mortgages  = data?.data.filter(d => d.category === "mortgage")  ?? [];
  const mbs        = data?.data.filter(d => d.category === "mbs")       ?? [];
  const treasuries = data?.data.filter(d => d.category === "treasury")  ?? [];

  const asOf = data?.data[0]?.date
    ? (() => {
        const raw = data.data[0].date;
        // Handle M/D/YY format from MND (e.g. "4/6/26") or YYYY-MM-DD from FRED
        const d = raw.includes("/")
          ? new Date(raw.replace(/^(\d+)\/(\d+)\/(\d+)$/, (_, m, day, y) => `20${y.length===2?y:y}-${m.padStart(2,'0')}-${day.padStart(2,'0')}`) + "T12:00:00")
          : new Date(raw + "T12:00:00");
        return isNaN(d.getTime()) ? raw : d.toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" });
      })()
    : null;

  function DataCell({ item }: { item: MarketDataPoint }) {
    const up = item.change > 0;
    const dn = item.change < 0;
    const isMbsPrice = item.label.includes("UMBS");
    const changeColor = isMbsPrice
      ? (up ? "#4ade80" : dn ? "#f87171" : "#9ca3af")
      : (up ? "#f87171" : dn ? "#4ade80" : "#9ca3af");
    return (
      <div className="flex flex-col gap-0.5 px-4 py-3 border-r border-white/10 last:border-0" style={{ minWidth: "130px" }}>
        <span className="text-xs font-medium truncate" style={{ color: "rgba(255,255,255,0.6)" }}>{item.label}</span>
        <span className="result-number text-base font-bold text-white">
          {item.value.toFixed(2)}{isMbsPrice ? "" : "%"}
        </span>
        <span className="text-xs font-semibold flex items-center gap-0.5" style={{ color: changeColor }}>
          {up ? "▲" : dn ? "▼" : "—"} {Math.abs(item.change).toFixed(3)}{isMbsPrice ? "" : "%"}
        </span>
      </div>
    );
  }

  function SectionLabel({ title, sub }: { title: string; sub: string }) {
    return (
      <div className="flex flex-col justify-center px-4 py-3 border-r border-white/10" style={{ minWidth: "90px", borderRight: "1px solid rgba(126,203,214,0.2)" }}>
        <span className="text-xs font-bold uppercase tracking-wider" style={{ color: "#7ecbd6" }}>{title}</span>
        <span className="text-xs mt-0.5" style={{ color: "rgba(126,203,214,0.45)" }}>{sub}</span>
      </div>
    );
  }

  return (
    <div className="rounded-xl overflow-hidden no-print shadow-xl" style={{ backgroundColor: "#0d1f30", border: "1px solid rgba(255,255,255,0.08)" }}>
      {/* Header */}
      <div className="flex items-center justify-between px-4 py-2.5" style={{ backgroundColor: "#1a3d5c" }}>
        <div className="flex items-center gap-2.5">
          <svg viewBox="0 0 20 14" fill="none" className="w-5 h-3.5 shrink-0">
            <polyline points="1,12 6,6 10,9 19,1" stroke="#7ecbd6" strokeWidth="2.5" strokeLinejoin="round" strokeLinecap="round"/>
          </svg>
          <span className="text-sm font-bold text-white tracking-wide">Mortgage Market</span>
          {asOf && <span className="text-xs" style={{ color: "#7ecbd6" }}>· Week of {asOf}</span>}
        </div>
        <span className="text-xs flex items-center gap-1.5" style={{ color: "#7ecbd6" }}>
          <span className="w-1.5 h-1.5 rounded-full bg-emerald-400 inline-block" />
          Mortgage News Daily
        </span>
      </div>

      {/* Data */}
      {isLoading ? (
        <div className="flex gap-0 overflow-x-auto py-4 px-2 animate-pulse">
          {[...Array(8)].map((_, i) => (
            <div key={i} className="flex flex-col gap-1.5 px-4" style={{ minWidth: "130px" }}>
              <div className="h-3 rounded" style={{ width: "75%", backgroundColor: "rgba(255,255,255,0.1)" }} />
              <div className="h-5 rounded" style={{ width: "55%", backgroundColor: "rgba(255,255,255,0.15)" }} />
              <div className="h-3 rounded" style={{ width: "40%", backgroundColor: "rgba(255,255,255,0.1)" }} />
            </div>
          ))}
        </div>
      ) : (
        <div className="overflow-x-auto">
          <div className="flex min-w-max">
            {mortgages.length > 0  && <><SectionLabel title="Mortgage" sub="Freddie Mac" />{mortgages.map(item  => <DataCell key={item.label} item={item} />)}</>}
            {mbs.length > 0        && <><SectionLabel title="MBS" sub="UMBS / Spread" />{mbs.map(item        => <DataCell key={item.label} item={item} />)}</>}
            {treasuries.length > 0 && <><SectionLabel title="Treasuries" sub="US Gov't" />{treasuries.map(item => <DataCell key={item.label} item={item} />)}</>}
          </div>
        </div>
      )}

      {/* Footer */}
      <div className="px-4 py-1.5 flex items-center justify-between" style={{ backgroundColor: "#0a1929" }}>
        <span className="text-xs" style={{ color: "rgba(255,255,255,0.3)" }}>Source: Mortgage News Daily · Daily lender rate index</span>
        <span className="text-xs" style={{ color: "rgba(255,255,255,0.3)" }}>▲ = higher rate  ▼ = lower rate</span>
      </div>
    </div>
  );
}

export default function HomePage() {
  const { toast } = useToast();
  const [propertyData, setPropertyData] = useState<PropertyData | null>(null);
  const [estimate, setEstimate] = useState<EstimateResult | null>(null);
  const [showClosingBreakdown, setShowClosingBreakdown] = useState(false);
  const [lookupAddress, setLookupAddress] = useState("");
  const [selectedMagicKey, setSelectedMagicKey] = useState<string | undefined>(undefined);
  const [stateCode, setStateCode] = useState<string>("");
  const [includeEscrow, setIncludeEscrow] = useState<boolean>(true);
  const [sellerPaysTitle, setSellerPaysTitle] = useState<boolean>(true);
  const [floodInsuranceRequired, setFloodInsuranceRequired] = useState<boolean>(false);
  const [homeInsuranceOverride, setHomeInsuranceOverride] = useState<string>("");
  const [floodInsuranceOverride, setFloodInsuranceOverride] = useState<string>("");
  const [showHomeInsOverride, setShowHomeInsOverride] = useState<boolean>(false);
  const [showFloodInsOverride, setShowFloodInsOverride] = useState<boolean>(false);

  const { data: ratesData, isLoading: ratesLoading } = useQuery<{ rates: MortgageRate[] }>({
    queryKey: ["/api/rates"],
  });

  const form = useForm<FormValues>({
    resolver: zodResolver(formSchema),
    defaultValues: {
      address: "",
      homePrice: 0,
      downPaymentPercent: 20,
      loanType: "conventional_30",
      customRate: "",
      pmiOverride: "",
      vaFundingFeeOption: "first_use",
      additionalSellerCredit: "",
      propertyTax: 0,
      hoaFee: 0,
      closingDate: "",
    },
  });

  const lookupMutation = useMutation({
    mutationFn: async ({ address, magicKey }: { address: string; magicKey?: string }) => {
      const res = await apiRequest("POST", "/api/property-lookup", { address, magicKey });
      return res.json() as Promise<PropertyData>;
    },
    onSuccess: (data) => {
      setPropertyData(data);
      if (data.stateCode) setStateCode(data.stateCode);

      // Pre-fill with parcel tax if available — the useEffect will update
      // to higher-of-two vs county-rate × purchase price once user enters a price
      if (data.taxFromParcel && data.propertyTax && data.propertyTax > 0) {
        form.setValue("propertyTax", Math.round(data.propertyTax));
      }
      // Auto-enable flood insurance if property is in a high-risk FEMA zone (SFHA)
      if (data.floodZone && /^(AE?|VE?|AH|AO|AR|A[0-9])/i.test(data.floodZone)) {
        setFloodInsuranceRequired(true);
      }

      if (data.taxFromParcel && data.parcelId) {
        toast({
          title: "Property records found",
          description: `Parcel #${data.parcelId} — assessed ${data.assessedValue ? fmtCurrency(data.assessedValue) : ""}. Monthly tax auto-populated: ${data.propertyTax ? fmtCurrency(Math.round(data.propertyTax)) + "/mo" : "—"} (higher of actual vs county avg).`,
        });
      } else if (data.propertyTax && data.propertyTax > 0) {
        toast({
          title: "Address confirmed",
          description: `Monthly tax estimated at ${fmtCurrency(Math.round(data.propertyTax))}/mo based on ${data.taxRateSource ?? "county avg"} (${data.taxRate?.toFixed(2)}%).`,
        });
      } else {
        toast({
          title: "Address confirmed",
          description: "Enter the home price, taxes, and HOA below.",
        });
      }
    },
    onError: () => {
      toast({ title: "Lookup failed", description: "Enter details manually below.", variant: "destructive" });
    },
  });

  const estimateMutation = useMutation({
    mutationFn: async (values: FormValues) => {
      const res = await apiRequest("POST", "/api/estimate", {
        ...values,
        stateCode,
        includeEscrow,
        sellerPaysTitle,
        floodInsuranceRequired,
        // Custom rate: allow any valid decimal e.g. 5.99, 6.125
        customRate: values.customRate && parseFloat(values.customRate) > 0
          ? parseFloat(values.customRate)
          : undefined,
        // PMI override: only for conventional loans
        pmiOverride: values.pmiOverride && parseFloat(values.pmiOverride) > 0
          ? parseFloat(values.pmiOverride)
          : undefined,
        // VA funding fee option
        vaFundingFeeOption: values.loanType === "va_30" ? (values.vaFundingFeeOption ?? "first_use") : undefined,
        // Additional seller credit in dollars
        additionalSellerCredit: values.additionalSellerCredit && parseFloat(values.additionalSellerCredit) > 0
          ? parseFloat(values.additionalSellerCredit)
          : undefined,
        // Insurance overrides (monthly $)
        homeInsuranceOverride: homeInsuranceOverride && parseFloat(homeInsuranceOverride) > 0
          ? parseFloat(homeInsuranceOverride)
          : undefined,
        floodInsuranceOverride: floodInsuranceOverride && parseFloat(floodInsuranceOverride) > 0
          ? parseFloat(floodInsuranceOverride)
          : undefined,
      });
      return res.json() as Promise<EstimateResult>;
    },
    onSuccess: (data) => {
      setEstimate(data);
      setTimeout(() => {
        document.getElementById("results")?.scrollIntoView({ behavior: "smooth", block: "start" });
      }, 100);
    },
    onError: () => {
      toast({ title: "Calculation error", description: "Check your inputs and try again.", variant: "destructive" });
    },
  });

  function handleAddressSuggestionSelect(suggestion: AddressSuggestion) {
    setLookupAddress(suggestion.text);
    setSelectedMagicKey(suggestion.magicKey);
    form.setValue("address", suggestion.text);
    // Auto-trigger lookup when address is selected from dropdown
    lookupMutation.mutate({ address: suggestion.text, magicKey: suggestion.magicKey });
  }

  function handleManualLookup() {
    const addr = lookupAddress.trim();
    if (addr.length < 5) {
      toast({ title: "Enter a full address", description: "Include street, city, and state.", variant: "destructive" });
      return;
    }
    form.setValue("address", addr);
    lookupMutation.mutate({ address: addr, magicKey: selectedMagicKey });
  }

  function onSubmit(values: FormValues) {
    estimateMutation.mutate(values);
  }

  // These must be declared BEFORE any useEffect that references them
  const selectedLoanType = form.watch("loanType");
  const selectedRate = ratesData?.rates.find(r => r.key === selectedLoanType);
  const watchedHomePrice = form.watch("homePrice");
  const watchedDownPct = form.watch("downPaymentPercent");

  // Auto-calculate property tax whenever home price changes.
  // Always use the HIGHER of:
  //   (a) actual parcel tax from county appraiser, OR
  //   (b) county avg rate × PURCHASE PRICE (not assessed value)
  // This ensures taxes reflect what the buyer will actually pay on the new purchase price.
  useEffect(() => {
    const price = watchedHomePrice;
    if (!propertyData || price <= 0) return;

    // County avg based on purchase price
    const countyRateMonthly = propertyData.taxRate
      ? Math.round((price * (propertyData.taxRate / 100)) / 12)
      : 0;

    // Actual parcel tax (raw from county records)
    const parcelMonthly = propertyData.taxFromParcel && propertyData.propertyTax
      ? Math.round(propertyData.propertyTax)
      : 0;

    // Use whichever is higher
    const higher = Math.max(countyRateMonthly, parcelMonthly);
    if (higher > 0) form.setValue("propertyTax", higher);
  }, [watchedHomePrice, propertyData?.taxFromParcel, propertyData?.taxRate, propertyData?.propertyTax]);

  return (
    <div className="min-h-screen bg-background flex flex-col">

      {/* ── Header ── */}
      <header className="ccm-header shadow-lg">
        <div className="ccm-accent-bar" />
        <div className="max-w-6xl mx-auto px-4 py-3 flex items-center justify-between gap-4">
          <div className="flex items-center gap-3">
            {/* Real CCM Logo */}
            <img
              src="https://crosscountrymortgage.com/app/themes/ccm-redesign/theme/assets/images/CCM_logo.svg"
              alt="CrossCountry Mortgage"
              className="h-8 w-auto"
              style={{ filter: "brightness(0) invert(1)" }}
              onError={(e) => { (e.target as HTMLImageElement).style.display = "none"; }}
            />
            <div className="border-l border-white/30 pl-3">
              <p className="font-semibold text-white text-sm leading-none">Michael Zachman</p>
              <p className="text-xs mt-0.5" style={{ color: "#7ecbd6" }}>Loan Officer · NMLS #1682867</p>
            </div>
          </div>
          <div className="hidden sm:flex items-center gap-2 text-xs" style={{ color: "#7ecbd6" }}>
            <span className="inline-block w-2 h-2 rounded-full bg-emerald-400" />
            Rates updated April 5, 2026
          </div>
        </div>
      </header>

      <main className="max-w-6xl mx-auto px-4 py-8 space-y-8 flex-1 w-full">

        {/* ── Market Data Ticker ── */}
        <div className="print-hide"><MarketDataPanel /></div>

        {/* ── Hero ── */}
        <div className="text-center space-y-3 py-2 print-hide">
          <h1 className="font-bold text-foreground" style={{ fontSize: "clamp(1.75rem, 4vw, 2.5rem)", fontFamily: "Barlow, Arial, sans-serif" }}>
            Home Purchase Loan Estimator
          </h1>
          <p className="text-muted-foreground max-w-xl mx-auto">
            Search any US address to validate it and auto-populate county-level property tax rates.
            Enter the home price, down payment, and loan type for a full estimate.
          </p>
        </div>

        <div className="grid lg:grid-cols-3 gap-6 print-hide">

          {/* ── Left / Main Column ── */}
          <div className="lg:col-span-2 space-y-5">

            {/* Address Search with Autocomplete */}
            <Card className="border-border shadow-sm">
              <CardHeader className="pb-3">
                <CardTitle className="flex items-center gap-2 text-base font-semibold">
                  <Search className="w-4 h-4" style={{ color: "#007a8c" }} />
                  Property Address
                </CardTitle>
              </CardHeader>
              <CardContent className="space-y-3">
                <div className="flex gap-2">
                  <AddressAutocomplete
                    value={lookupAddress}
                    onChange={(val) => {
                      setLookupAddress(val);
                      if (!val) setSelectedZpid(undefined);
                    }}
                    onSelect={handleAddressSuggestionSelect}
                    placeholder="Start typing an address..."
                  />
                  <Button
                    data-testid="button-lookup"
                    type="button"
                    onClick={handleManualLookup}
                    disabled={lookupMutation.isPending}
                    className="shrink-0 hover:opacity-90 transition-opacity"
                    style={{ backgroundColor: "#1a3d5c", color: "white" }}
                  >
                    {lookupMutation.isPending
                      ? <span className="flex items-center gap-2"><Spinner /> Loading...</span>
                      : <span className="flex items-center gap-2"><Search className="w-4 h-4" /> Look Up</span>}
                  </Button>
                </div>
                <p className="text-xs text-muted-foreground flex items-center gap-1.5">
                  <Info className="w-3 h-3 shrink-0" />
                  Suggestions appear as you type. Select an address to confirm it and auto-calculate property taxes.
                </p>

                {/* Loading skeleton */}
                {lookupMutation.isPending && (
                  <div className="flex gap-4 p-3 bg-muted rounded-lg mt-1 animate-pulse">
                    <div className="w-20 h-20 rounded-md bg-muted-foreground/20 shrink-0" />
                    <div className="flex-1 space-y-2 py-1">
                      <div className="h-4 bg-muted-foreground/20 rounded w-3/4" />
                      <div className="h-4 bg-muted-foreground/20 rounded w-1/2" />
                      <div className="h-4 bg-muted-foreground/20 rounded w-1/3" />
                    </div>
                  </div>
                )}

                {/* Property Preview */}
                {propertyData && !lookupMutation.isPending && (
                  <div className="p-3 rounded-lg border border-border fade-in" style={{ backgroundColor: "#f0f8fa" }}>
                    <p className="text-sm font-semibold text-foreground">{propertyData.cityStateZip || lookupAddress}</p>
                    {propertyData.county && (
                      <p className="text-xs text-muted-foreground mt-0.5">{propertyData.county}</p>
                    )}
                    <div className="flex flex-wrap gap-2 mt-2">
                      {propertyData.taxFromParcel && propertyData.annualTax ? (
                        <Badge className="text-xs" style={{ backgroundColor: "#1a3d5c", color: "white" }}>
                          Actual Tax: {fmtCurrency(propertyData.annualTax)}/yr ({fmtCurrency(Math.round(propertyData.annualTax / 12))}/mo)
                        </Badge>
                      ) : propertyData.taxRate ? (
                        <Badge variant="outline" className="text-xs" style={{ borderColor: "#007a8c", color: "#007a8c" }}>
                          Est. tax rate: {propertyData.taxRate.toFixed(2)}% / yr
                          {propertyData.taxRateSource ? ` · ${propertyData.taxRateSource}` : ""}
                        </Badge>
                      ) : null}
                      {propertyData.assessedValue && (
                        <Badge variant="outline" className="text-xs">
                          Assessed: {fmtCurrency(propertyData.assessedValue)}
                        </Badge>
                      )}
                    </div>
                    {/* Flood Zone banner — shown prominently when available */}
                    {propertyData.floodZone && (() => {
                      const fz = propertyData.floodZone!;
                      // High-risk: any A or V zone (Special Flood Hazard Area)
                      const isHighRisk = /^(AE?|VE?|AH|AO|AR|A[0-9])/i.test(fz);
                      // Moderate: 500-yr (X500, shaded X, B)
                      const isModerate = /500-yr|Moderate|X500|Shaded X|\bB\b/i.test(fz);
                      const bgColor = isHighRisk ? "#fff0ee" : isModerate ? "#fffbea" : "#f0faf4";
                      const borderColor = isHighRisk ? "#e74c3c" : isModerate ? "#f39c12" : "#27ae60";
                      const textColor = isHighRisk ? "#c0392b" : isModerate ? "#d68910" : "#1e8449";
                      const icon = isHighRisk ? "⚠" : isModerate ? "◈" : "✓";
                      const label = isHighRisk
                        ? "High-risk SFHA — flood insurance required by lender"
                        : isModerate
                        ? "Moderate flood risk (500-yr) — flood insurance recommended"
                        : "Minimal flood risk — outside FEMA special flood hazard area";
                      return (
                        <div
                          className="flex items-start gap-2 mt-2 px-3 py-2 rounded-md text-xs"
                          style={{ backgroundColor: bgColor, border: `1px solid ${borderColor}` }}
                        >
                          <span className="font-bold text-sm shrink-0" style={{ color: textColor }}>{icon}</span>
                          <div>
                            <span className="font-bold" style={{ color: textColor }}>FEMA Flood Zone: {propertyData.floodZone}</span>
                            <span className="ml-1.5" style={{ color: textColor, opacity: 0.85 }}>— {label}</span>
                          </div>
                        </div>
                      );
                    })()}
                    {/* County Property Appraiser deep link + Zillow link */}
                    <div className="flex flex-wrap gap-2 mt-2">
                      {propertyData.appraisalUrl && (
                        <a
                          href={propertyData.appraisalUrl}
                          target="_blank"
                          rel="noopener noreferrer"
                          className="inline-flex items-center gap-1.5 text-xs font-semibold px-2.5 py-1.5 rounded-md transition-colors hover:opacity-80"
                          style={{ backgroundColor: "#f0f8fa", color: "#007a8c", border: "1px solid #b3dde3" }}
                        >
                          <ExternalLink className="w-3 h-3 shrink-0" />
                          {propertyData.county ?? "County"} Appraiser
                        </a>
                      )}
                      {propertyData.zillowUrl && (
                        <a
                          href={propertyData.zillowUrl}
                          target="_blank"
                          rel="noopener noreferrer"
                          className="inline-flex items-center gap-1.5 text-xs font-semibold px-2.5 py-1.5 rounded-md transition-colors hover:opacity-80"
                          style={{ backgroundColor: "#f0f8fa", color: "#1a3d5c", border: "1px solid #b3dde3" }}
                        >
                          <ExternalLink className="w-3 h-3 shrink-0" />
                          View on Zillow
                        </a>
                      )}
                    </div>
                    {/* County average tax rate — shown below the appraiser link */}
                    {propertyData.taxRate && (
                      <p className="text-xs mt-1.5" style={{ color: "#5a7a8a" }}>
                        {propertyData.county} avg. effective tax rate: <strong>{propertyData.taxRate.toFixed(2)}%</strong>/yr
                        {propertyData.taxRateSource && propertyData.taxRateSource !== `${propertyData.county} avg`
                          ? ` · ${propertyData.taxRateSource}`
                          : ""}
                      </p>
                    )}
                    <p className="text-xs text-muted-foreground mt-1">
                      Enter the home price below — property taxes will auto-calculate.
                    </p>
                  </div>
                )}
              </CardContent>
            </Card>

            {/* Loan Parameters */}
            <Card className="border-border shadow-sm">
              <CardHeader className="pb-3">
                <CardTitle className="flex items-center gap-2 text-base font-semibold">
                  <DollarSign className="w-4 h-4" style={{ color: "#007a8c" }} />
                  Loan Parameters
                </CardTitle>
              </CardHeader>
              <CardContent>
                <Form {...form}>
                  <form onSubmit={form.handleSubmit(onSubmit)} className="space-y-5">
                    <FormField control={form.control} name="address" render={({ field }) => (
                      <input type="hidden" {...field} />
                    )} />

                    <div className="grid sm:grid-cols-2 gap-4">
                      <FormField control={form.control} name="homePrice" render={({ field }) => (
                        <FormItem>
                          <FormLabel>Home Price</FormLabel>
                          <FormControl>
                            <div className="relative">
                              <span className="absolute left-3 top-1/2 -translate-y-1/2 text-muted-foreground text-sm">$</span>
                              <Input data-testid="input-home-price" type="number" placeholder="500,000" className="pl-7" {...field} />
                            </div>
                          </FormControl>
                          <FormMessage />
                        </FormItem>
                      )} />

                      <FormField control={form.control} name="downPaymentPercent" render={({ field }) => (
                        <FormItem>
                          <FormLabel>Down Payment</FormLabel>
                          <FormControl>
                            <div className="relative">
                              <Input data-testid="input-down-payment" type="number" step="0.5" min="0" max="100" placeholder="20" className="pr-8" {...field} />
                              <span className="absolute right-3 top-1/2 -translate-y-1/2 text-muted-foreground text-sm">%</span>
                            </div>
                          </FormControl>
                          {watchedHomePrice > 0 && (
                            <p className="text-xs text-muted-foreground">= {fmtCurrency(watchedHomePrice * (watchedDownPct / 100))} down</p>
                          )}
                          <FormMessage />
                        </FormItem>
                      )} />
                    </div>

                    <FormField control={form.control} name="loanType" render={({ field }) => (
                      <FormItem>
                        <FormLabel>Loan Type</FormLabel>
                        <Select onValueChange={field.onChange} defaultValue={field.value}>
                          <FormControl>
                            <SelectTrigger data-testid="select-loan-type">
                              <SelectValue placeholder="Select loan type" />
                            </SelectTrigger>
                          </FormControl>
                          <SelectContent>
                            {ratesData?.rates.map(r => (
                              <SelectItem key={r.key} value={r.key}>
                                <span className="flex items-center gap-4">
                                  <span>{r.label}</span>
                                  <span className="font-mono font-semibold text-xs" style={{ color: "#007a8c" }}>{fmtRate(r.rate)}</span>
                                </span>
                              </SelectItem>
                            ))}
                          </SelectContent>
                        </Select>
                        {selectedRate && (
                          <p className="text-xs text-muted-foreground flex items-center gap-1">
                            <TrendingDown className="w-3 h-3" />
                            National avg: <span className="font-semibold ml-0.5" style={{ color: "#007a8c" }}>{fmtRate(selectedRate.rate)}</span>
                            <span className="ml-1">· {selectedRate.source}</span>
                          </p>
                        )}
                        <FormMessage />
                      </FormItem>
                    )} />

                    {/* Custom interest rate override */}
                    <FormField control={form.control} name="customRate" render={({ field }) => (
                      <FormItem>
                        <FormLabel className="flex items-center gap-1.5">
                          <TrendingDown className="w-3.5 h-3.5" style={{ color: "#007a8c" }} />
                          Custom Interest Rate
                          <span className="text-xs font-normal text-muted-foreground ml-1">(optional — overrides national avg)</span>
                        </FormLabel>
                        <FormControl>
                          <div className="relative">
                            <Input
                              data-testid="input-custom-rate"
                              type="text"
                              inputMode="decimal"
                              placeholder={selectedRate ? selectedRate.rate.toFixed(2) : "6.50"}
                              className="pr-8"
                              value={field.value}
                              onChange={(e) => {
                                // Allow typing any decimal: 5, 5.9, 5.99, 6.125 etc.
                                const val = e.target.value;
                                if (val === "" || /^\d{0,2}(\.\d{0,3})?$/.test(val)) {
                                  field.onChange(val);
                                }
                              }}
                              onBlur={field.onBlur}
                              name={field.name}
                            />
                            <span className="absolute right-3 top-1/2 -translate-y-1/2 text-muted-foreground text-sm">%</span>
                          </div>
                        </FormControl>
                        <p className="text-xs text-muted-foreground">
                          {field.value && parseFloat(field.value) > 0
                            ? <span className="font-medium" style={{ color: "#1a3d5c" }}>
                                Using custom rate: {parseFloat(field.value).toFixed(3)}%
                              </span>
                            : "Leave blank to use the national average for the selected loan type"}
                        </p>
                        <FormMessage />
                      </FormItem>
                    )} />

                    {/* PMI override — conventional loans only, < 20% down */}
                    {form.watch("loanType")?.startsWith("conventional") && form.watch("downPaymentPercent") < 20 && (
                      <FormField control={form.control} name="pmiOverride" render={({ field }) => (
                        <FormItem>
                          <FormLabel className="flex items-center gap-1.5">
                            <DollarSign className="w-3.5 h-3.5" style={{ color: "#007a8c" }} />
                            PMI Factor Override
                            <span className="text-xs font-normal text-muted-foreground ml-1">(optional — overrides estimated PMI)</span>
                          </FormLabel>
                          <FormControl>
                            <div className="relative">
                              <Input
                                data-testid="input-pmi-override"
                                type="text"
                                inputMode="decimal"
                                placeholder="e.g. 0.49"
                                className="pr-8"
                                value={field.value}
                                onChange={(e) => {
                                  const val = e.target.value;
                                  if (val === "" || /^\d{0,1}(\.\d{0,2})?$/.test(val)) {
                                    field.onChange(val);
                                  }
                                }}
                                onBlur={field.onBlur}
                                name={field.name}
                              />
                              <span className="absolute right-3 top-1/2 -translate-y-1/2 text-muted-foreground text-sm">%</span>
                            </div>
                          </FormControl>
                          <p className="text-xs text-muted-foreground">
                            {field.value && parseFloat(field.value) > 0
                              ? <span className="font-medium" style={{ color: "#1a3d5c" }}>Using custom PMI: {parseFloat(field.value).toFixed(2)}%/yr</span>
                              : "Enter 0.01–2.00. Leave blank to use MGIC rate table estimate."}
                          </p>
                          <FormMessage />
                        </FormItem>
                      )} />
                    )}

                    {/* VA Funding Fee selector — VA loans only */}
                    {form.watch("loanType") === "va_30" && (
                      <FormField control={form.control} name="vaFundingFeeOption" render={({ field }) => (
                        <FormItem>
                          <FormLabel className="flex items-center gap-1.5">
                            <Shield className="w-3.5 h-3.5" style={{ color: "#007a8c" }} />
                            VA Funding Fee
                            <span className="text-xs font-normal text-muted-foreground ml-1">(financed into loan)</span>
                          </FormLabel>
                          <Select onValueChange={field.onChange} value={field.value ?? "first_use"}>
                            <FormControl>
                              <SelectTrigger data-testid="select-va-funding">
                                <SelectValue placeholder="Select funding fee option" />
                              </SelectTrigger>
                            </FormControl>
                            <SelectContent>
                              <SelectItem value="exempt">Exempt (0%) — service-connected disability</SelectItem>
                              <SelectItem value="first_use">First Use — {form.watch("downPaymentPercent") >= 10 ? "1.40%" : form.watch("downPaymentPercent") >= 5 ? "1.65%" : "2.30%"}</SelectItem>
                              <SelectItem value="subsequent_use">Subsequent Use — {form.watch("downPaymentPercent") >= 10 ? "1.40%" : form.watch("downPaymentPercent") >= 5 ? "1.65%" : "3.60%"}</SelectItem>
                            </SelectContent>
                          </Select>
                          <p className="text-xs text-muted-foreground">
                            VA funding fee is added to the loan balance, not charged at closing.
                          </p>
                          <FormMessage />
                        </FormItem>
                      )} />
                    )}

                    {/* Additional seller credit */}
                    <FormField control={form.control} name="additionalSellerCredit" render={({ field }) => (
                      <FormItem>
                        <FormLabel className="flex items-center gap-1.5">
                          <DollarSign className="w-3.5 h-3.5" style={{ color: "#007a8c" }} />
                          Additional Seller Credit
                          <span className="text-xs font-normal text-muted-foreground ml-1">(optional)</span>
                        </FormLabel>
                        <div className="space-y-2">
                          {/* Quick % presets */}
                          <div className="flex flex-wrap gap-1.5">
                            {[0.5, 1, 1.5, 2, 2.5, 3, 4, 5, 6].map(pct => {
                              const hp = form.watch("homePrice") || 0;
                              const dollarAmt = hp > 0 ? Math.round(hp * pct / 100) : null;
                              const isActive = dollarAmt !== null && field.value === String(dollarAmt);
                              return (
                                <button
                                  key={pct}
                                  type="button"
                                  onClick={() => {
                                    if (hp > 0) field.onChange(String(Math.round(hp * pct / 100)));
                                  }}
                                  className={`px-2.5 py-1 rounded text-xs font-semibold border transition-colors ${
                                    isActive
                                      ? "text-white border-transparent"
                                      : "text-muted-foreground border-border hover:border-teal-400"
                                  }`}
                                  style={isActive ? { backgroundColor: "#007a8c", borderColor: "#007a8c" } : {}}
                                >
                                  {pct}%{dollarAmt ? ` (${fmtCurrency(dollarAmt)})` : ""}
                                </button>
                              );
                            })}
                            {field.value && (
                              <button
                                type="button"
                                onClick={() => field.onChange("")}
                                className="px-2.5 py-1 rounded text-xs font-semibold border border-red-200 text-red-400 hover:bg-red-50 transition-colors"
                              >
                                Clear
                              </button>
                            )}
                          </div>
                          {/* Manual dollar entry */}
                          <FormControl>
                            <div className="relative">
                              <span className="absolute left-3 top-1/2 -translate-y-1/2 text-muted-foreground text-sm">$</span>
                              <Input
                                data-testid="input-seller-credit"
                                type="text"
                                inputMode="numeric"
                                placeholder="Or enter custom dollar amount"
                                className="pl-7"
                                value={field.value}
                                onChange={(e) => {
                                  const val = e.target.value.replace(/[^0-9]/g, "");
                                  field.onChange(val);
                                }}
                                onBlur={field.onBlur}
                                name={field.name}
                              />
                            </div>
                          </FormControl>
                        </div>
                        <p className="text-xs text-muted-foreground">
                          {field.value && parseFloat(field.value) > 0
                            ? (() => {
                                const hp = form.watch("homePrice") || 0;
                                const pct = hp > 0 ? ((parseFloat(field.value) / hp) * 100).toFixed(2) : null;
                                return <span className="font-medium" style={{ color: "#1a3d5c" }}>
                                  Seller credit: {fmtCurrency(parseFloat(field.value))}{pct ? ` (${pct}% of price)` : ""} — reduces cash to close
                                </span>;
                              })()
                            : "Select a % preset above or type a dollar amount. Reduces buyer cash to close."}
                        </p>
                        <FormMessage />
                      </FormItem>
                    )} />

                    <div className="grid sm:grid-cols-2 gap-4">
                      <FormField control={form.control} name="propertyTax" render={({ field }) => (
                        <FormItem>
                          <FormLabel>Monthly Property Tax</FormLabel>
                          <FormControl>
                            <div className="relative">
                              <span className="absolute left-3 top-1/2 -translate-y-1/2 text-muted-foreground text-sm">$</span>
                              <Input data-testid="input-property-tax" type="number" placeholder="500" className="pl-7" {...field} />
                            </div>
                          </FormControl>
                          <p className="text-xs text-muted-foreground">
                            {propertyData?.taxFromParcel
                              ? <span className="font-medium" style={{ color: "#1a3d5c" }}>From county appraiser (parcel #{propertyData.parcelId})</span>
                              : propertyData?.taxRateSource
                              ? `Auto-calculated · ${propertyData.taxRateSource} (${propertyData.taxRate?.toFixed(2)}%/yr)`
                              : "Auto-calculated from county avg · adjustable"}
                          </p>
                          <FormMessage />
                        </FormItem>
                      )} />

                      <FormField control={form.control} name="hoaFee" render={({ field }) => (
                        <FormItem>
                          <FormLabel>Monthly HOA Fee</FormLabel>
                          <FormControl>
                            <div className="relative">
                              <span className="absolute left-3 top-1/2 -translate-y-1/2 text-muted-foreground text-sm">$</span>
                              <Input data-testid="input-hoa-fee" type="number" placeholder="0" className="pl-7" {...field} />
                            </div>
                          </FormControl>
                          <p className="text-xs text-muted-foreground">Enter 0 if no HOA</p>
                          <FormMessage />
                        </FormItem>
                      )} />
                    </div>

                    {/* Closing Date */}
                    <FormField control={form.control} name="closingDate" render={({ field }) => (
                      <FormItem>
                        <FormLabel className="flex items-center gap-1.5">
                          <Calendar className="w-3.5 h-3.5" style={{ color: "#007a8c" }} />
                          Estimated Closing Date
                        </FormLabel>
                        <FormControl>
                          <Input
                            data-testid="input-closing-date"
                            type="date"
                            min={new Date().toISOString().split("T")[0]}
                            className="w-full"
                            {...field}
                          />
                        </FormControl>
                        <p className="text-xs text-muted-foreground">
                          {field.value
                            ? `Prepaid interest calculated through end of ${new Date(field.value + "T12:00:00").toLocaleDateString("en-US", { month: "long" })}`
                            : "Leave blank to default to 5 days prepaid interest"}
                        </p>
                        <FormMessage />
                      </FormItem>
                    )} />

                    {/* Home Insurance — with optional monthly override */}
                    <div className="rounded-lg border text-sm" style={{ backgroundColor: "#f0f8fa", borderColor: "#b3dde3" }}>
                      <div className="flex items-start justify-between gap-2.5 p-3">
                        <div className="flex items-start gap-2.5">
                          <Shield className="w-4 h-4 shrink-0 mt-0.5" style={{ color: "#007a8c" }} />
                          <div>
                            <span className="font-semibold">Home Insurance</span>
                            <span className="text-muted-foreground ml-1">
                              {homeInsuranceOverride && parseFloat(homeInsuranceOverride) > 0
                                ? <span style={{ color: "#1a3d5c" }} className="font-medium">
                                    Using {fmtCurrency(parseFloat(homeInsuranceOverride))}/mo (custom)
                                  </span>
                                : `Est. at 0.8% of price annually${watchedHomePrice > 0 ? ` · ~${fmtCurrency(Math.round(watchedHomePrice * 0.008 / 12))}/mo` : ""}`
                              }
                            </span>
                          </div>
                        </div>
                        <button
                          type="button"
                          onClick={() => setShowHomeInsOverride(v => !v)}
                          className="text-xs font-medium shrink-0 transition-colors hover:opacity-70"
                          style={{ color: "#007a8c" }}
                        >
                          {showHomeInsOverride ? "Cancel" : "Override"}
                        </button>
                      </div>
                      {showHomeInsOverride && (
                        <div className="px-3 pb-3">
                          <div className="relative">
                            <span className="absolute left-3 top-1/2 -translate-y-1/2 text-muted-foreground text-sm">$</span>
                            <input
                              type="text"
                              inputMode="numeric"
                              placeholder="Monthly amount (e.g. 250)"
                              value={homeInsuranceOverride}
                              onChange={e => setHomeInsuranceOverride(e.target.value.replace(/[^0-9]/g, ""))}
                              className="w-full pl-7 pr-3 py-2 rounded-md border border-input bg-background text-sm focus:outline-none focus:ring-1"
                              style={{ borderColor: "#b3dde3" }}
                            />
                          </div>
                        </div>
                      )}
                    </div>

                    {/* Flood Insurance toggle + optional override */}
                    <div
                      className="rounded-lg border transition-colors"
                      style={{
                        backgroundColor: floodInsuranceRequired ? "#fff5f0" : "#f5f5f5",
                        borderColor: floodInsuranceRequired ? "#f0a080" : "#e5e7eb",
                      }}
                    >
                      <div
                        className="flex items-start gap-3 p-3 cursor-pointer"
                        onClick={() => setFloodInsuranceRequired(!floodInsuranceRequired)}
                      >
                        <div
                          className="w-10 h-5 rounded-full relative shrink-0 mt-0.5 transition-colors"
                          style={{ backgroundColor: floodInsuranceRequired ? "#c0533a" : "#d1d5db" }}
                        >
                          <div
                            className="w-4 h-4 bg-white rounded-full absolute top-0.5 transition-all shadow-sm"
                            style={{ left: floodInsuranceRequired ? "calc(100% - 18px)" : "2px" }}
                          />
                        </div>
                        <div className="flex-1">
                          <p className="text-sm font-semibold text-foreground">
                            {floodInsuranceRequired ? "Flood Insurance Required" : "No Flood Insurance"}
                          </p>
                          <p className="text-xs text-muted-foreground mt-0.5">
                            {floodInsuranceRequired
                              ? (() => {
                                  const monthly = floodInsuranceOverride && parseFloat(floodInsuranceOverride) > 0
                                    ? parseFloat(floodInsuranceOverride)
                                    : watchedHomePrice > 0 ? Math.round(watchedHomePrice * 0.005 / 12) : null;
                                  const label = floodInsuranceOverride && parseFloat(floodInsuranceOverride) > 0
                                    ? `${fmtCurrency(monthly!)}/mo (custom)` : `Est. at 0.5% annually${monthly ? ` · ~${fmtCurrency(monthly)}/mo` : ""}`;
                                  return `${label} · Escrow always required.`;
                                })()
                              : "Toggle on if property is in a FEMA flood zone (SFHA)."}
                          </p>
                        </div>
                        {floodInsuranceRequired && (
                          <button
                            type="button"
                            onClick={e => { e.stopPropagation(); setShowFloodInsOverride(v => !v); }}
                            className="text-xs font-medium shrink-0 transition-colors hover:opacity-70"
                            style={{ color: "#c0533a" }}
                          >
                            {showFloodInsOverride ? "Cancel" : "Override"}
                          </button>
                        )}
                      </div>
                      {floodInsuranceRequired && showFloodInsOverride && (
                        <div className="px-3 pb-3">
                          <div className="relative">
                            <span className="absolute left-3 top-1/2 -translate-y-1/2 text-muted-foreground text-sm">$</span>
                            <input
                              type="text"
                              inputMode="numeric"
                              placeholder="Monthly amount (e.g. 150)"
                              value={floodInsuranceOverride}
                              onChange={e => setFloodInsuranceOverride(e.target.value.replace(/[^0-9]/g, ""))}
                              className="w-full pl-7 pr-3 py-2 rounded-md border bg-background text-sm focus:outline-none focus:ring-1"
                              style={{ borderColor: "#f0a080" }}
                            />
                          </div>
                        </div>
                      )}
                    </div>

                    {/* Seller pays title toggle — always visible */}
                    <div
                      className="flex items-start gap-3 p-3 rounded-lg border cursor-pointer transition-colors"
                      style={{
                        backgroundColor: sellerPaysTitle ? "#f0f8fa" : "#fff9f0",
                        borderColor: sellerPaysTitle ? "#b3dde3" : "#f0c080",
                      }}
                      onClick={() => setSellerPaysTitle(!sellerPaysTitle)}
                    >
                      <div
                        className="w-10 h-5 rounded-full relative shrink-0 mt-0.5 transition-colors"
                        style={{ backgroundColor: sellerPaysTitle ? "#007a8c" : "#d1a050" }}
                      >
                        <div
                          className="w-4 h-4 bg-white rounded-full absolute top-0.5 transition-all shadow-sm"
                          style={{ left: sellerPaysTitle ? "calc(100% - 18px)" : "2px" }}
                        />
                      </div>
                      <div>
                        <p className="text-sm font-semibold text-foreground">
                          {sellerPaysTitle ? "Seller Pays Owner's Title" : "Buyer Pays Owner's Title"}
                        </p>
                        <p className="text-xs text-muted-foreground mt-0.5">
                          {sellerPaysTitle
                            ? "Standard FL custom — seller pays owner's title insurance. Shown as a seller credit on the closing worksheet."
                            : "Buyer pays owner's title insurance (common in Broward, Hillsborough, Orange, Pinellas counties)."
                          }
                        </p>
                      </div>
                    </div>

                    {/* Escrow waiver toggle — only shown at 20%+ down */}
                    {watchedDownPct >= 20 && (
                      <div
                        className="flex items-start gap-3 p-3 rounded-lg border cursor-pointer transition-colors"
                        style={{
                          backgroundColor: includeEscrow ? "#f0f8fa" : "#fff9f0",
                          borderColor: includeEscrow ? "#b3dde3" : "#f0c080",
                        }}
                        onClick={() => setIncludeEscrow(!includeEscrow)}
                      >
                        {/* Custom toggle */}
                        <div
                          className="w-10 h-5 rounded-full relative shrink-0 mt-0.5 transition-colors"
                          style={{ backgroundColor: includeEscrow ? "#007a8c" : "#d1a050" }}
                        >
                          <div
                            className="w-4 h-4 bg-white rounded-full absolute top-0.5 transition-all shadow-sm"
                            style={{ left: includeEscrow ? "calc(100% - 18px)" : "2px" }}
                          />
                        </div>
                        <div>
                          <p className="text-sm font-semibold text-foreground">
                            {includeEscrow ? "Escrow Account Included" : "Escrow Account Waived"}
                          </p>
                          <p className="text-xs text-muted-foreground mt-0.5">
                            {includeEscrow
                              ? "Taxes & insurance reserves collected at closing (standard). Toggle off to waive — available with 20%+ down."
                              : "No tax or insurance escrow reserves at closing. You pay taxes & insurance directly. Available because down payment ≥ 20%."}
                          </p>
                        </div>
                      </div>
                    )}

                    <Button
                      type="submit"
                      data-testid="button-calculate"
                      disabled={estimateMutation.isPending}
                      className="w-full py-5 text-base font-bold tracking-wide hover:opacity-90 transition-opacity"
                      style={{ backgroundColor: "#1a3d5c", color: "white" }}
                    >
                      {estimateMutation.isPending
                        ? <span className="flex items-center gap-2"><Spinner /> Calculating...</span>
                        : <span className="flex items-center gap-2"><Home className="w-4 h-4" /> Generate Loan Estimate</span>}
                    </Button>
                  </form>
                </Form>
              </CardContent>
            </Card>
          </div>

          {/* ── Right Column ── */}
          <div className="space-y-5">

            {/* Agent Card */}
            <Card className="border-border shadow-sm overflow-hidden">
              <div className="h-1.5 w-full" style={{ backgroundColor: "#007a8c" }} />
              <CardContent className="pt-5 pb-5">
                <div className="flex items-center gap-3 mb-4">
                  <img
                    src={michaelPhoto}
                    alt="Michael Zachman"
                    className="w-14 h-14 rounded-full object-cover object-top shrink-0 border-2"
                    style={{ borderColor: "#1a3d5c" }}
                  />
                  <div>
                    <p className="font-bold text-foreground text-sm leading-tight">Michael Zachman</p>
                    <p className="text-xs text-muted-foreground">Loan Officer · NMLS #1682867</p>
                    <p className="text-xs text-muted-foreground">Delray Beach, FL</p>
                  </div>
                </div>
                <Separator className="mb-4" />
                <div className="space-y-2.5 text-sm mb-4">
                  <a href="tel:5616577750" className="flex items-center gap-2 text-muted-foreground hover:text-foreground transition-colors">
                    <Phone className="w-3.5 h-3.5 shrink-0" style={{ color: "#007a8c" }} />
                    (561) 657-7750
                  </a>
                  <a href="mailto:Michael.Zachman@ccm.com" className="flex items-center gap-2 text-muted-foreground hover:text-foreground transition-colors">
                    <Mail className="w-3.5 h-3.5 shrink-0" style={{ color: "#007a8c" }} />
                    Michael.Zachman@ccm.com
                  </a>
                  <a
                    href="https://www.experience.com/reviews/michael-zachman-334970"
                    target="_blank"
                    rel="noopener noreferrer"
                    className="flex items-center gap-2 transition-colors hover:opacity-80"
                    style={{ color: "#007a8c" }}
                  >
                    <svg className="w-3.5 h-3.5 shrink-0" viewBox="0 0 24 24" fill="currentColor">
                      <path d="M12 2l3.09 6.26L22 9.27l-5 4.87 1.18 6.88L12 17.77l-6.18 3.25L7 14.14 2 9.27l6.91-1.01L12 2z" />
                    </svg>
                    Client Reviews
                  </a>
                </div>
                <a
                  href="https://app.crosscountrymortgage.com/#/choose-loan-type?referrerId=michael.zachman%40myccmortgage.com"
                  target="_blank"
                  rel="noopener noreferrer"
                  className="flex items-center justify-center gap-1.5 w-full py-2.5 rounded-md text-sm font-bold text-white transition-opacity hover:opacity-90"
                  style={{ backgroundColor: "#007a8c" }}
                >
                  Apply Now <ExternalLink className="w-3.5 h-3.5" />
                </a>
              </CardContent>
            </Card>

            {/* Live Rates */}
            <Card className="border-border shadow-sm">
              <CardHeader className="pb-2" style={{ backgroundColor: "#f5fafc", borderRadius: "0.5rem 0.5rem 0 0" }}>
                <CardTitle className="flex items-center gap-2 text-base font-semibold">
                  <TrendingDown className="w-4 h-4" style={{ color: "#007a8c" }} />
                  Today's National Avg Rates
                </CardTitle>
              </CardHeader>
              <CardContent className="pt-3">
                {ratesLoading ? (
                  <div className="space-y-3">
                    {[...Array(6)].map((_, i) => (
                      <div key={i} className="flex justify-between items-center">
                        <Skeleton className="h-3.5 w-32" />
                        <Skeleton className="h-3.5 w-12" />
                      </div>
                    ))}
                  </div>
                ) : (
                  <div>{ratesData?.rates.map(rate => <RateBadge key={rate.key} rate={rate} />)}</div>
                )}
                <p className="text-xs text-muted-foreground mt-3 pt-2 border-t border-border">
                  Mortgage News Daily
                </p>
              </CardContent>
            </Card>

            {/* Loan Guide */}
            <Card className="border-border shadow-sm">
              <CardHeader className="pb-2">
                <CardTitle className="flex items-center gap-2 text-base font-semibold">
                  <Info className="w-4 h-4" style={{ color: "#007a8c" }} />
                  Loan Type Guide
                </CardTitle>
              </CardHeader>
              <CardContent className="text-sm text-muted-foreground space-y-3">
                {[
                  { title: "Conventional 30yr", body: "Most common. No PMI required with 20%+ down." },
                  { title: "Conventional 15yr", body: "Lower rate, higher payment. Build equity faster." },
                  { title: "FHA 30yr", body: "As low as 3.5% down. Good for first-time buyers." },
                  { title: "VA 30yr", body: "For eligible veterans. Often $0 down required." },
                  { title: "Jumbo 30yr", body: "For loans above $806,500 (2026 conforming limit)." },
                  { title: "7/1 ARM", body: "Fixed 7 years, then adjusts. Lower initial rate." },
                ].map(({ title, body }) => (
                  <div key={title}>
                    <p className="font-semibold text-foreground text-xs">{title}</p>
                    <p className="text-xs leading-relaxed">{body}</p>
                  </div>
                ))}
              </CardContent>
            </Card>
          </div>
        </div>

        {/* ── Results ── */}
        {estimate && (
          <div id="results" className="fade-in space-y-5 pt-2">
            {/* Print-only header (hidden on screen, shown in PDF) */}
            <div className="print-header" style={{ display: "none" }}>
              <img
                src="https://crosscountrymortgage.com/app/themes/ccm-redesign/theme/assets/images/CCM_logo.svg"
                alt="CrossCountry Mortgage"
                style={{ height: "32px", filter: "brightness(0) invert(1)", marginRight: "4px" }}
              />
              <div>
                <h1>Home Purchase Loan Estimate</h1>
                <p>Michael Zachman · Loan Officer · CrossCountry Mortgage · NMLS #1682867 · (561) 657-7750</p>
                <p>{estimate.address} · Generated {new Date().toLocaleDateString("en-US", { month: "long", day: "numeric", year: "numeric" })}</p>
              </div>
            </div>

            <div className="flex items-center gap-3 no-print">
              <Separator className="flex-1" />
              <h2 className="text-xl font-bold text-foreground shrink-0" style={{ fontFamily: "Barlow, Arial, sans-serif" }}>
                Your Loan Estimate
              </h2>
              <Separator className="flex-1" />
            </div>

            {/* Export PDF button */}
            <div className="flex justify-end no-print">
              <button
                onClick={() => generatePDF(estimate)}
                className="flex items-center gap-2 px-4 py-2 rounded-md text-sm font-semibold border transition-opacity hover:opacity-80"
                style={{ borderColor: "#1a3d5c", color: "#1a3d5c" }}
              >
                <svg className="w-4 h-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                  <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" />
                  <polyline points="14 2 14 8 20 8" />
                  <line x1="12" y1="18" x2="12" y2="12" />
                  <line x1="9" y1="15" x2="15" y2="15" />
                </svg>
                Export as PDF
              </button>
            </div>

            <div className="grid md:grid-cols-3 gap-4">
              {/* Monthly Payment Hero */}
              <Card className="md:col-span-1 text-white shadow-lg" style={{ background: "linear-gradient(160deg, #1a3d5c 0%, #0d2a40 100%)" }}>
                <CardContent className="pt-6 pb-6 text-center space-y-2">
                  <p className="text-white/70 text-xs uppercase tracking-widest font-semibold">Est. Monthly Payment</p>
                  <p
                    data-testid="text-monthly-payment"
                    className="result-number font-bold"
                    style={{ fontSize: "clamp(2rem, 5vw, 2.75rem)", fontFamily: "Barlow, Arial, sans-serif", color: "#7ecbd6" }}
                  >
                    {fmtCurrency(estimate.totalMonthlyPayment)}
                  </p>
                  <p className="text-white/50 text-xs">/month · all-in</p>
                  <div className="border-t border-white/15 my-3 pt-3 space-y-1.5 text-sm text-left">
                    <div className="flex justify-between"><span className="text-white/60">P&amp;I</span><span className="result-number">{fmtCurrency(estimate.monthlyBreakdown.principalAndInterest)}</span></div>
                    <div className="flex justify-between"><span className="text-white/60">Taxes</span><span className="result-number">{fmtCurrency(estimate.monthlyBreakdown.propertyTax)}</span></div>
                    <div className="flex justify-between"><span className="text-white/60">Insurance</span><span className="result-number">{fmtCurrency(estimate.monthlyBreakdown.homeInsurance)}</span></div>
                    {estimate.monthlyBreakdown.flood > 0 && (
                      <div className="flex justify-between"><span className="text-white/60">Flood Ins.</span><span className="result-number">{fmtCurrency(estimate.monthlyBreakdown.flood)}</span></div>
                    )}
                    {estimate.monthlyBreakdown.hoa > 0 && <div className="flex justify-between"><span className="text-white/60">HOA</span><span className="result-number">{fmtCurrency(estimate.monthlyBreakdown.hoa)}</span></div>}
                    {estimate.monthlyBreakdown.mortgageInsurance > 0 && (
                      <div className="flex justify-between"><span className="text-white/60">Mortgage Ins.</span><span className="result-number">{fmtCurrency(estimate.monthlyBreakdown.mortgageInsurance)}</span></div>
                    )}
                  </div>
                </CardContent>
              </Card>

              {/* Loan Summary */}
              <Card className="md:col-span-2 shadow-sm border-border">
                <CardHeader className="pb-2">
                  <CardTitle className="text-base font-semibold">Loan Summary</CardTitle>
                  <p className="text-xs text-muted-foreground" data-testid="text-address">{estimate.address}</p>
                </CardHeader>
                <CardContent className="divide-y divide-border">
                  <SummaryRow label="Home Price" value={fmtCurrency(estimate.homePrice)} />
                  <SummaryRow label={`Down Payment (${estimate.downPaymentPercent}%)`} value={fmtCurrency(estimate.downPaymentAmount)} />
                  <SummaryRow label="Loan Amount" value={fmtCurrency(estimate.loanAmount)} highlight />
                  {estimate.ufmip > 0 && (
                    <p className="text-xs px-3 py-1.5 rounded" style={{ color: "#007a8c", backgroundColor: "#f0f8fa" }}>
                      Includes {fmtCurrency(estimate.ufmip)} FHA Upfront MIP (1.75%) financed into loan
                    </p>
                  )}
                  {(estimate.vaFundingFee ?? 0) > 0 && (
                    <p className="text-xs px-3 py-1.5 rounded" style={{ color: "#007a8c", backgroundColor: "#f0f8fa" }}>
                      Includes {fmtCurrency(estimate.vaFundingFee!)} VA Funding Fee ({estimate.vaFundingFeeRate?.toFixed(2)}% — {estimate.vaFundingFeeOption === "subsequent_use" ? "Subsequent Use" : "First Use"}) financed into loan
                    </p>
                  )}
                  <SummaryRow label="Loan Type" value={estimate.loanType} />
                  <SummaryRow label="Loan Term" value={`${estimate.loanTerm} Years`} />
                  <div className="flex justify-between items-center py-2.5">
                    <span>Interest Rate</span>
                    <span className="flex items-center gap-2 result-number">
                      {fmtRate(estimate.interestRate)}
                      {estimate.rateIsCustom && (
                        <span className="text-xs font-bold px-1.5 py-0.5 rounded" style={{ backgroundColor: "#1a3d5c", color: "white" }}>
                          Custom
                        </span>
                      )}
                    </span>
                  </div>
                </CardContent>
              </Card>
            </div>

            {/* Cash to Close + Monthly Breakdown */}
            <div className="grid md:grid-cols-2 gap-4">
              {/* Cash to Close — hero card matching monthly payment style */}
              <Card
                className="shadow-lg text-white"
                style={{ background: "linear-gradient(160deg, #007a8c 0%, #005a6a 100%)" }}
              >
                <CardContent className="pt-6 pb-6 text-center space-y-2">
                  <p className="text-white/70 text-xs uppercase tracking-widest font-semibold">Total Cash to Close</p>
                  <p
                    className="result-number font-bold"
                    style={{ fontSize: "clamp(2rem, 5vw, 2.75rem)", fontFamily: "Barlow, Arial, sans-serif", color: "#ffffff" }}
                  >
                    {fmtCurrency(estimate.totalCashNeeded)}
                  </p>
                  <p className="text-white/50 text-xs">needed at closing</p>
                  <div className="border-t border-white/20 my-3 pt-3 space-y-1.5 text-sm text-left">
                    <div className="flex justify-between">
                      <span className="text-white/70">Down Payment ({estimate.downPaymentPercent}%)</span>
                      <span className="result-number">{fmtCurrency(estimate.downPaymentAmount)}</span>
                    </div>
                    <div className="flex justify-between">
                      <span className="text-white/70">Total Closing Costs</span>
                      <span className="result-number">
                        {fmtCurrency(estimate.grossClosingCosts)}
                        <span className="ml-1.5 text-white/50 text-xs font-normal">
                          ({((estimate.grossClosingCosts / estimate.homePrice) * 100).toFixed(1)}% of price)
                        </span>
                      </span>
                    </div>
                    {(estimate.additionalSellerCredit ?? 0) > 0 && (
                      <>
                        <div className="flex justify-between" style={{ color: "#7ecbd6" }}>
                          <span>Seller Credit</span>
                          <span className="result-number">-{fmtCurrency(estimate.additionalSellerCredit!)}</span>
                        </div>
                        <div className="flex justify-between border-t border-white/20 pt-1.5">
                          <span className="text-white/70">Net Closing Costs</span>
                          <span className="result-number">
                            {fmtCurrency(estimate.closingCosts)}
                            <span className="ml-1.5 text-white/50 text-xs font-normal">
                              ({((estimate.closingCosts / estimate.homePrice) * 100).toFixed(1)}% of price)
                            </span>
                          </span>
                        </div>
                      </>
                    )}
                    {estimate.escrowWaived && (
                      <div className="text-xs text-white/50 pt-1 border-t border-white/15">
                        Escrow reserves waived
                      </div>
                    )}
                  </div>
                </CardContent>
              </Card>

              <Card className="shadow-sm border-border">
                <CardHeader className="pb-2">
                  <CardTitle className="flex items-center gap-2 text-base font-semibold">
                    <DollarSign className="w-4 h-4" style={{ color: "#007a8c" }} />
                    Monthly Payment Breakdown
                  </CardTitle>
                </CardHeader>
                <CardContent className="divide-y divide-border">
                  <SummaryRow label="Principal & Interest" value={fmtCurrency(estimate.monthlyBreakdown.principalAndInterest)} />
                  <SummaryRow label="Property Tax" value={fmtCurrency(estimate.monthlyBreakdown.propertyTax)} />
                  <SummaryRow label="Home Insurance" value={fmtCurrency(estimate.monthlyBreakdown.homeInsurance)} />
                  {estimate.monthlyBreakdown.flood > 0 && (
                    <SummaryRow label="Flood Insurance *" value={fmtCurrency(estimate.monthlyBreakdown.flood)} />
                  )}
                  {estimate.monthlyBreakdown.hoa > 0 && <SummaryRow label="HOA Fee" value={fmtCurrency(estimate.monthlyBreakdown.hoa)} />}
                  {estimate.monthlyBreakdown.mortgageInsurance > 0 && (
                    <SummaryRow
                      label="Mortgage Insurance (est.)"
                      value={fmtCurrency(estimate.monthlyBreakdown.mortgageInsurance)}
                    />
                  )}
                  <SummaryRow label="Total Monthly" value={fmtCurrency(estimate.totalMonthlyPayment)} highlight />
                </CardContent>
              </Card>
            </div>

            {/* Closing Costs Expandable */}
            <Card className="shadow-sm border-border">
              <CardHeader className="pb-0">
                <button
                  data-testid="button-toggle-closing"
                  onClick={() => setShowClosingBreakdown(!showClosingBreakdown)}
                  className="w-full flex items-center justify-between py-1 text-left group"
                >
                  <CardTitle className="text-base font-semibold">
                    Closing Costs Breakdown — <span style={{ color: "#1a3d5c" }}>{fmtCurrency(estimate.grossClosingCosts)}</span>
                    {(estimate.additionalSellerCredit ?? 0) > 0 && (
                      <span className="ml-1 text-sm font-normal" style={{ color: "#007a8c" }}>
                        (net {fmtCurrency(estimate.closingCosts)} after seller credit)
                      </span>
                    )}
                  </CardTitle>
                  {showClosingBreakdown
                    ? <ChevronUp className="w-4 h-4 text-muted-foreground group-hover:text-foreground transition-colors" />
                    : <ChevronDown className="w-4 h-4 text-muted-foreground group-hover:text-foreground transition-colors" />}
                </button>
              </CardHeader>
              <CardContent className={`pt-4 closing-breakdown${showClosingBreakdown ? " fade-in" : " hidden"}`}>
                  <div>
                    {(() => {
                      // Separate the additional seller credit from the rest so we can
                      // show a gross subtotal first, then the credit, then net.
                      const entries = Object.entries(estimate.closingCostBreakdown);
                      const regularEntries = entries.filter(([l]) => l !== "Additional Seller Credit");
                      const addlCredit = estimate.additionalSellerCredit ?? 0;
                      const grossTotal = regularEntries
                        .filter(([, v]) => v !== "header" && typeof v === "number")
                        .reduce((s, [, v]) => s + (v as number), 0);

                      return (
                        <>
                          {regularEntries.map(([label, amount]) =>
                            amount === "header" ? (
                              <ClosingCostSection key={label} label={label} />
                            ) : (
                              <div
                                key={label}
                                className="flex justify-between items-center py-2 pl-3 border-b border-border last:border-0"
                                style={(amount as number) < 0 ? { backgroundColor: "#f0faf7" } : undefined}
                              >
                                <span className="text-sm pr-4" style={{ color: (amount as number) < 0 ? "#007a8c" : undefined }}>
                                  {label}
                                </span>
                                <span className="result-number text-sm font-semibold shrink-0" style={{ color: (amount as number) < 0 ? "#007a8c" : undefined }}>
                                  {(amount as number) < 0
                                    ? `−${fmtCurrency(Math.abs(amount as number))}`
                                    : fmtCurrency(amount as number)}
                                </span>
                              </div>
                            )
                          )}
                          {/* Gross subtotal */}
                          <div className="flex justify-between items-center py-2 pl-3 border-t-2 mt-1" style={{ borderColor: "#1a3d5c" }}>
                            <span className="text-sm font-semibold" style={{ color: "#1a3d5c" }}>Total Closing Costs</span>
                            <span className="result-number text-sm font-bold" style={{ color: "#1a3d5c" }}>{fmtCurrency(Math.round(grossTotal))}</span>
                          </div>
                          {/* Additional seller credit */}
                          {addlCredit > 0 && (
                            <>
                              <div className="flex justify-between items-center py-2 pl-3 border-b border-border" style={{ backgroundColor: "#f0faf7" }}>
                                <span className="text-sm" style={{ color: "#007a8c" }}>Additional Seller Credit</span>
                                <span className="result-number text-sm font-semibold" style={{ color: "#007a8c" }}>
                                  −{fmtCurrency(addlCredit)}
                                </span>
                              </div>
                              <div className="flex justify-between items-center py-2.5 pl-3 rounded-md mt-1" style={{ backgroundColor: "#e6f7f5" }}>
                                <span className="text-sm font-bold" style={{ color: "#007a8c" }}>Net Closing Costs</span>
                                <span className="result-number text-sm font-bold" style={{ color: "#007a8c" }}>{fmtCurrency(estimate.closingCosts)}</span>
                              </div>
                            </>
                          )}
                        </>
                      );
                    })()}
                  </div>
                  {estimate.sellerPaysTitle && estimate.sellerTitleCredit > 0 && (
                    <div className="mt-3 px-3 py-2 rounded-md text-xs" style={{ backgroundColor: "#e6f7f5", color: "#007a8c" }}>
                      Seller credit of {fmtCurrency(estimate.sellerTitleCredit)} for Owner's Title Insurance is reflected above.
                    </div>
                  )}
                  {(estimate.additionalSellerCredit ?? 0) > 0 && (
                    <div className="mt-2 px-3 py-2 rounded-md text-xs" style={{ backgroundColor: "#e6f7f5", color: "#007a8c" }}>
                      Additional seller credit of {fmtCurrency(estimate.additionalSellerCredit!)} ({((estimate.additionalSellerCredit! / estimate.homePrice) * 100).toFixed(2)}% of price) — reduces buyer cash to close.
                    </div>
                  )}
                  <p className="text-xs text-muted-foreground mt-3">
                    * Estimated 3rd-party costs — actual amounts provided by title company &amp; insurer at application.
                  </p>
                </CardContent>
            </Card>

            {/* Ready CTA */}
            <Card className="shadow-sm border-border overflow-hidden">
              <div className="h-1 w-full" style={{ backgroundColor: "#007a8c" }} />
              <CardContent className="py-5 flex flex-col sm:flex-row items-center justify-between gap-4">
                <div>
                  <p className="font-bold text-foreground text-sm">Ready to move forward?</p>
                  <p className="text-xs text-muted-foreground mt-0.5">Contact Michael Zachman for an official pre-approval and personalized rate quote.</p>
                </div>
                <div className="flex gap-3 shrink-0">
                  <a href="tel:5616577750" className="flex items-center gap-1.5 px-4 py-2 rounded-md text-sm font-semibold border transition-opacity hover:opacity-80" style={{ borderColor: "#1a3d5c", color: "#1a3d5c" }}>
                    <Phone className="w-3.5 h-3.5" /> Call
                  </a>
                  <a
                    href="https://app.crosscountrymortgage.com/#/choose-loan-type?referrerId=michael.zachman%40myccmortgage.com"
                    target="_blank"
                    rel="noopener noreferrer"
                    className="flex items-center gap-1.5 px-4 py-2 rounded-md text-sm font-bold text-white transition-opacity hover:opacity-90"
                    style={{ backgroundColor: "#1a3d5c" }}
                  >
                    Apply Now <ExternalLink className="w-3.5 h-3.5" />
                  </a>
                </div>
              </CardContent>
            </Card>

            {/* Disclosures */}
            <div className="text-xs text-muted-foreground space-y-2 pb-8 border-t border-border pt-4">
              <p><strong>Rate source:</strong> {estimate.rateSource}</p>
              <p><strong>Insurance:</strong> {estimate.insuranceNote}</p>
              {estimate.monthlyBreakdown.mortgageInsurance > 0 && (
                <p>
                  <strong>Mortgage Insurance:</strong>{
                    estimate.ufmip > 0
                      ? ` FHA monthly MIP at 0.55% of loan balance annually. FHA Upfront MIP (1.75% = ${fmtCurrency(estimate.ufmip)}) is financed into the loan — not a closing cost.`
                      : ` PMI estimated using LTV-based rate tiers from MGIC/Fannie Mae guidelines (assumes 700–739 credit score). Actual PMI varies by lender and credit score. Source: `
                  }
                  {estimate.ufmip === 0 && (
                    <a href="https://www.mgic.com/rates" target="_blank" rel="noopener noreferrer"
                      className="underline" style={{ color: "#007a8c" }}>MGIC Rate Finder</a>
                  )}
                </p>
              )}
              <p>
                <strong>* Estimated 3rd-party costs:</strong> Items marked with * are estimates from typical third-party
                providers (title company, insurance, survey). Actual costs will be provided by the title company and
                insurance carrier and may differ. Your lender will issue an official Loan Estimate within 3 business
                days of application with exact figures.
              </p>
              <p>
                This estimate is for informational purposes only and does not constitute a loan offer or commitment.
                Actual rates, fees, and monthly payments depend on your credit profile, lender, property details, and
                applicable taxes. CrossCountry Mortgage, LLC · NMLS #3029 · Equal Housing Opportunity Lender.
                Michael Zachman NMLS #1682867.
              </p>
            </div>
          </div>
        )}
      </main>

      {/* Footer */}
      <footer className="border-t border-border py-4 mt-4" style={{ backgroundColor: "#f5fafc" }}>
        <div className="max-w-6xl mx-auto px-4 flex flex-col sm:flex-row items-center justify-between gap-2 text-xs text-muted-foreground">
          <div className="flex items-center gap-2">
            <img
              src="https://crosscountrymortgage.com/app/themes/ccm-redesign/theme/assets/images/CCM_logo.svg"
              alt="CrossCountry Mortgage"
              className="h-5 w-auto opacity-60"
              onError={e => { (e.target as HTMLImageElement).style.display = "none"; }}
            />
            <span>CrossCountry Mortgage · Michael Zachman NMLS #1682867</span>
          </div>
          <span>© 2026 CrossCountry Mortgage, LLC · NMLS #3029 · Equal Housing Opportunity</span>
        </div>
      </footer>
    </div>
  );
}
