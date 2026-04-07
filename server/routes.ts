import type { Express } from "express";
import type { Server } from "http";
import axios from "axios";
import { storage } from "./storage";
import { lookupParcel } from "./parcel-lookup";
import { loanEstimateRequestSchema, propertyLookupSchema } from "@shared/schema";

// ─── Mortgage Rates (April 5, 2026 — Bankrate / Freddie Mac) ─────────────────

const MORTGAGE_RATES: Record<string, { rate: number; label: string; termYears: number }> = {
  conventional_30: { rate: 6.50, label: "30-Year Fixed (Conventional)", termYears: 30 },
  conventional_15: { rate: 5.83, label: "15-Year Fixed (Conventional)", termYears: 15 },
  fha_30:          { rate: 6.28, label: "30-Year Fixed (FHA)",          termYears: 30 },
  va_30:           { rate: 6.38, label: "30-Year Fixed (VA)",           termYears: 30 },
  jumbo_30:        { rate: 6.55, label: "30-Year Fixed (Jumbo)",        termYears: 30 },
  arm_7_1:         { rate: 6.11, label: "7/1 Adjustable Rate (ARM)",   termYears: 30 },
};

// ─── County-level effective property tax rates (%) ───────────────────────────
// Source: ATTOM / Tax Foundation 2023-2024 county data.
// Format: "County Name, STATE_ABBR" -> annual effective rate as % of home value

const COUNTY_TAX_RATES: Record<string, number> = {
  // Florida
  "Miami-Dade County, FL": 1.02, "Broward County, FL": 1.07, "Palm Beach County, FL": 1.00,
  "Orange County, FL": 0.94, "Hillsborough County, FL": 0.98, "Pinellas County, FL": 0.93,
  "Duval County, FL": 0.89, "Lee County, FL": 0.87, "Polk County, FL": 0.91,
  "Brevard County, FL": 0.86, "Sarasota County, FL": 0.84, "Collier County, FL": 0.71,
  "Manatee County, FL": 0.90, "Seminole County, FL": 0.88, "Volusia County, FL": 0.94,
  "Pasco County, FL": 0.95, "Marion County, FL": 0.88, "Lake County, FL": 0.90,
  "Osceola County, FL": 0.97, "St. Lucie County, FL": 1.04, "Escambia County, FL": 0.71,
  "Alachua County, FL": 1.05, "Leon County, FL": 0.85, "Okaloosa County, FL": 0.56,
  "St. Johns County, FL": 0.84, "Charlotte County, FL": 1.005, "Hendry County, FL": 0.96,
  "Monroe County, FL": 0.68, "Indian River County, FL": 0.82, "Flagler County, FL": 0.97,
  // California
  "Los Angeles County, CA": 0.73, "San Diego County, CA": 0.73, "Orange County, CA": 0.60,
  "Riverside County, CA": 0.91, "San Bernardino County, CA": 0.83, "Santa Clara County, CA": 0.67,
  "Alameda County, CA": 0.77, "Contra Costa County, CA": 0.76, "Sacramento County, CA": 0.85,
  "Fresno County, CA": 0.78, "Kern County, CA": 0.82, "San Francisco County, CA": 0.56,
  "Ventura County, CA": 0.66, "San Mateo County, CA": 0.54, "Marin County, CA": 0.53,
  // Texas
  "Harris County, TX": 2.13, "Dallas County, TX": 2.18, "Tarrant County, TX": 2.26,
  "Travis County, TX": 1.98, "Collin County, TX": 2.05, "Bexar County, TX": 2.09,
  "Denton County, TX": 2.14, "Fort Bend County, TX": 2.23, "El Paso County, TX": 2.38,
  "Montgomery County, TX": 1.79, "Williamson County, TX": 2.04, "Galveston County, TX": 1.99,
  // New York
  "New York County, NY": 0.88, "Kings County, NY": 0.76, "Queens County, NY": 0.87,
  "Bronx County, NY": 1.11, "Suffolk County, NY": 2.37, "Nassau County, NY": 2.24,
  "Westchester County, NY": 2.47, "Erie County, NY": 2.82, "Monroe County, NY": 2.94,
  "Onondaga County, NY": 3.13, "Albany County, NY": 2.74, "Dutchess County, NY": 2.43,
  // New Jersey
  "Bergen County, NJ": 2.13, "Middlesex County, NJ": 2.41, "Essex County, NJ": 3.18,
  "Hudson County, NJ": 2.17, "Monmouth County, NJ": 2.13, "Morris County, NJ": 2.33,
  "Union County, NJ": 3.07, "Somerset County, NJ": 2.28, "Burlington County, NJ": 2.36,
  "Ocean County, NJ": 1.85, "Passaic County, NJ": 2.94, "Camden County, NJ": 3.10,
  // Illinois
  "Cook County, IL": 2.10, "DuPage County, IL": 2.12, "Lake County, IL": 2.78,
  "Will County, IL": 2.59, "Kane County, IL": 2.58, "McHenry County, IL": 2.75,
  // Georgia
  "Fulton County, GA": 1.16, "Gwinnett County, GA": 1.07, "DeKalb County, GA": 1.20,
  "Cobb County, GA": 0.85, "Clayton County, GA": 1.27, "Cherokee County, GA": 0.87,
  "Forsyth County, GA": 0.77, "Hall County, GA": 0.93,
  // North Carolina
  "Mecklenburg County, NC": 0.99, "Wake County, NC": 0.72, "Guilford County, NC": 1.05,
  "Forsyth County, NC": 1.15, "Cumberland County, NC": 1.15, "Durham County, NC": 1.07,
  // Arizona
  "Maricopa County, AZ": 0.59, "Pima County, AZ": 0.72, "Pinal County, AZ": 0.62,
  "Yavapai County, AZ": 0.55, "Mohave County, AZ": 0.57,
  // Colorado
  "Denver County, CO": 0.49, "Jefferson County, CO": 0.53, "Arapahoe County, CO": 0.57,
  "Adams County, CO": 0.66, "El Paso County, CO": 0.48, "Boulder County, CO": 0.52,
  "Douglas County, CO": 0.55, "Larimer County, CO": 0.55,
  // Washington
  "King County, WA": 0.93, "Pierce County, WA": 1.11, "Snohomish County, WA": 0.97,
  "Spokane County, WA": 1.21, "Clark County, WA": 1.06, "Thurston County, WA": 1.18,
  // Virginia
  "Fairfax County, VA": 1.09, "Prince William County, VA": 1.10, "Loudoun County, VA": 1.00,
  "Chesterfield County, VA": 0.92, "Arlington County, VA": 0.88,
  // Maryland
  "Montgomery County, MD": 0.96, "Prince George's County, MD": 1.36, "Baltimore County, MD": 1.12,
  "Anne Arundel County, MD": 0.92, "Howard County, MD": 1.04, "Frederick County, MD": 1.04,
  // Michigan
  "Wayne County, MI": 2.35, "Oakland County, MI": 1.78, "Macomb County, MI": 1.64,
  "Kent County, MI": 1.73, "Ingham County, MI": 2.41, "Ottawa County, MI": 1.52,
  // Ohio
  "Franklin County, OH": 1.85, "Cuyahoga County, OH": 2.43, "Hamilton County, OH": 1.73,
  "Summit County, OH": 2.56, "Lucas County, OH": 2.37, "Montgomery County, OH": 2.09,
  // Pennsylvania
  "Philadelphia County, PA": 1.37, "Allegheny County, PA": 2.14, "Montgomery County, PA": 1.73,
  "Bucks County, PA": 1.69, "Delaware County, PA": 2.08, "Chester County, PA": 1.53,
  // Massachusetts
  "Middlesex County, MA": 1.18, "Worcester County, MA": 1.44, "Suffolk County, MA": 0.78,
  "Norfolk County, MA": 1.15, "Essex County, MA": 1.24, "Bristol County, MA": 1.40,
  // Nevada
  "Clark County, NV": 0.59, "Washoe County, NV": 0.67,
  // Tennessee
  "Shelby County, TN": 0.96, "Davidson County, TN": 0.68, "Knox County, TN": 0.67,
  "Hamilton County, TN": 0.76, "Rutherford County, TN": 0.72, "Williamson County, TN": 0.57,
  // Minnesota
  "Hennepin County, MN": 1.28, "Ramsey County, MN": 1.44, "Dakota County, MN": 1.18,
  "Anoka County, MN": 1.25, "Washington County, MN": 1.18,
  // Oregon
  "Multnomah County, OR": 1.05, "Washington County, OR": 1.05, "Clackamas County, OR": 1.03,
  "Lane County, OR": 1.01, "Marion County, OR": 1.14,
  // South Carolina
  "Greenville County, SC": 0.59, "Richland County, SC": 0.58, "Charleston County, SC": 0.52,
  "Horry County, SC": 0.45, "Spartanburg County, SC": 0.63,
  // Indiana
  "Marion County, IN": 0.94, "Hamilton County, IN": 0.85, "Allen County, IN": 0.83,
  "St. Joseph County, IN": 0.96, "Lake County, IN": 1.44,
};

// ─── State fallback rates ─────────────────────────────────────────────────────

const STATE_TAX_RATES: Record<string, number> = {
  AL: 0.41, AK: 1.19, AZ: 0.62, AR: 0.62, CA: 0.73, CO: 0.55, CT: 2.15, DE: 0.61,
  FL: 0.98, GA: 0.92, HI: 0.29, ID: 0.69, IL: 2.23, IN: 0.87, IA: 1.57, KS: 1.43,
  KY: 0.86, LA: 0.55, ME: 1.36, MD: 1.09, MA: 1.23, MI: 1.54, MN: 1.12, MS: 0.65,
  MO: 1.01, MT: 0.84, NE: 1.73, NV: 0.59, NH: 2.09, NJ: 2.49, NM: 0.80, NY: 1.72,
  NC: 0.84, ND: 0.98, OH: 1.62, OK: 0.90, OR: 0.97, PA: 1.58, RI: 1.63, SC: 0.57,
  SD: 1.22, TN: 0.71, TX: 1.80, UT: 0.62, VT: 1.90, VA: 0.82, WA: 0.98, WV: 0.59,
  WI: 1.85, WY: 0.61, DC: 0.57,
};

function getMonthlyTaxEstimate(homePrice: number, county: string, stateCode: string): { monthly: number; rate: number; source: string } {
  // Try county first (more accurate)
  const countyKey = `${county}, ${stateCode.toUpperCase()}`;
  const countyRate = COUNTY_TAX_RATES[countyKey];
  if (countyRate) {
    return {
      monthly: Math.round((homePrice * (countyRate / 100)) / 12),
      rate: countyRate,
      source: `${county} avg`,
    };
  }
  // Fall back to state average
  const stateRate = STATE_TAX_RATES[stateCode.toUpperCase()] ?? 1.10;
  return {
    monthly: Math.round((homePrice * (stateRate / 100)) / 12),
    rate: stateRate,
    source: `${stateCode} state avg`,
  };
}

// ─── Address Autocomplete via ArcGIS (free, no key) ──────────────────────────

async function getAutocompleteSuggestions(query: string) {
  try {
    const res = await axios.get("https://geocode.arcgis.com/arcgis/rest/services/World/GeocodeServer/suggest", {
      params: { text: query, maxSuggestions: 7, f: "json", countryCode: "USA", category: "Address,Postal,Populated Place" },
      headers: { "User-Agent": "CCM-LoanEstimator/1.0" },
      timeout: 5000,
    });
    return (res.data?.suggestions ?? []).slice(0, 6);
  } catch {
    return [];
  }
}

// ─── Geocode address → get county, state, city, ZIP ─────────────────────────

interface GeocodedAddress {
  formattedAddress: string;
  stateCode: string;
  county: string;
  city: string;
  zip: string;
  x: number | null;  // longitude (WGS84)
  y: number | null;  // latitude (WGS84)
}

async function geocodeAddress(address: string, magicKey?: string): Promise<GeocodedAddress | null> {
  try {
    const params: Record<string, string> = { f: "json", outFields: "*", maxLocations: "1" };
    if (magicKey) { params.magicKey = magicKey; params.singleLine = address; }
    else { params.singleLine = address; params.countryCode = "USA"; }

    const res = await axios.get(
      "https://geocode.arcgis.com/arcgis/rest/services/World/GeocodeServer/findAddressCandidates",
      { params, headers: { "User-Agent": "CCM-LoanEstimator/1.0" }, timeout: 6000 }
    );
    const c = res.data?.candidates?.[0];
    if (!c) return null;
    const a = c.attributes ?? {};
    return {
      formattedAddress: c.address ?? address,
      stateCode: a.RegionAbbr ?? "",
      county: a.Subregion ?? "",  // e.g. "Palm Beach County"
      city: a.City ?? "",
      zip: a.Postal ?? "",
      x: c.location?.x ?? null,   // longitude
      y: c.location?.y ?? null,   // latitude
    };
  } catch {
    return null;
  }
}

// ─── FEMA NFHL Flood Zone lookup ────────────────────────────────────────────────
// Uses FEMA’s public ArcGIS NFHL MapServer (Layer 28 = Flood Hazard Zones)
// Free, no API key needed. Returns FLD_ZONE (e.g. "AE", "X"), ZONE_SUBTY, SFHA_TF

async function fetchFemaFloodZone(lon: number, lat: number): Promise<string | null> {
  try {
    const res = await axios.get(
      "https://hazards.fema.gov/arcgis/rest/services/public/NFHL/MapServer/28/query",
      {
        params: {
          geometry: `${lon},${lat}`,
          geometryType: "esriGeometryPoint",
          inSR: "4326",
          spatialRel: "esriSpatialRelIntersects",
          outFields: "FLD_ZONE,ZONE_SUBTY,SFHA_TF",
          returnGeometry: "false",
          f: "json",
        },
        headers: { "User-Agent": "CCM-LoanEstimator/1.0" },
        timeout: 8000,
      }
    );

    const features = res.data?.features;
    if (!features || !features.length) return null;

    const attrs = features[0].attributes;
    const zone = (attrs.FLD_ZONE ?? "").trim();
    const subty = (attrs.ZONE_SUBTY ?? "").trim();

    if (!zone) return null;

    // Build a human-readable label
    // SFHA_TF: "T" = within Special Flood Hazard Area, "F" = outside
    if (zone === "X") {
      if (subty.includes("0.2") || subty.includes("500") || subty.toUpperCase().includes("MODERATE")) {
        return "X Zone (500-yr / Moderate Risk)";
      }
      return "X Zone (Minimal Risk)";
    }
    if (subty && subty !== " ") {
      return `${zone} Zone (${subty.charAt(0).toUpperCase() + subty.slice(1).toLowerCase()})`;
    }
    return `${zone} Zone`;
  } catch (err) {
    console.error("FEMA flood zone lookup error:", (err as any)?.message);
    return null;
  }
}

// ─── Property lookup: geocode only (no Zillow) ───────────────────────────────

interface PropertyResult {
  price: number | null;
  propertyTax: number | null;      // monthly — from parcel lookup if available, else null
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
  appraisalUrl: string | null;     // direct deep-link to specific parcel
  parcelId: string | null;
  assessedValue: number | null;
  annualTax: number | null;        // actual from parcel if available
  taxFromParcel: boolean;          // true = came from real parcel data
  floodZone: string | null;        // FEMA flood zone if available from county appraiser
  zillowUrl: string | null;        // Zillow listing search URL
  source: string;
}

async function lookupProperty(address: string, magicKey?: string): Promise<PropertyResult> {
  const geo = await geocodeAddress(address, magicKey);
  const stateCode = geo?.stateCode ?? "";
  const county = geo?.county ?? "";

  // Pre-calculate tax rate so frontend can estimate as soon as user enters a price
  let taxRate: number | null = null;
  let taxRateSource: string | null = null;
  if (stateCode) {
    const countyKey = `${county}, ${stateCode.toUpperCase()}`;
    const countyRate = COUNTY_TAX_RATES[countyKey];
    if (countyRate) {
      taxRate = countyRate;
      taxRateSource = `${county} avg`;
    } else {
      taxRate = STATE_TAX_RATES[stateCode.toUpperCase()] ?? 1.10;
      taxRateSource = `${stateCode} state avg`;
    }
  }

  // Run parcel lookup + FEMA flood zone in parallel for speed
  const [parcelResult, femaFloodZone] = await Promise.all([
    (county && stateCode)
      ? lookupParcel(geo?.formattedAddress ?? address, county, stateCode)
      : Promise.resolve(null),
    // Fetch FEMA flood zone for all addresses using geocoded coordinates
    (geo?.x && geo?.y)
      ? fetchFemaFloodZone(geo.x, geo.y)
      : Promise.resolve(null),
  ]);

  // Build appraiser URL: prefer direct parcel URL from lookup, fall back to search URL
  const appraisalUrl = parcelResult?.parcelUrl
    ?? (county && stateCode ? getAppraisalUrl(county, stateCode, geo?.formattedAddress ?? address) : null);

  // Return the raw parcel monthly tax — the frontend will compare it against
  // county-rate × PURCHASE PRICE (not assessed value) once the user enters a price.
  // We send both pieces so the frontend can do the higher-of-two dynamically.
  const monthlyTaxToUse: number | null = parcelResult?.monthlyTax ?? null;
  const taxFromParcel = !!(parcelResult?.monthlyTax);

  // Build Zillow search URL from formatted address
  // Format: https://www.zillow.com/homes/{street-city-state-zip}_rb/
  const formattedAddr = geo?.formattedAddress ?? address;
  const zillowSlug = formattedAddr
    .replace(/,/g, "")        // remove commas
    .replace(/\s+/g, "-")    // spaces → hyphens
    .replace(/-+/g, "-")     // collapse multiple hyphens
    .trim();
  const zillowUrl = `https://www.zillow.com/homes/${zillowSlug}_rb/`;

  return {
    price: null,
    propertyTax: monthlyTaxToUse,
    hoaFee: null,
    zestimate: null,
    imageUrl: null,
    bedrooms: null,
    bathrooms: null,
    sqft: null,
    cityStateZip: formattedAddr,
    stateCode,
    county,
    taxRate,
    taxRateSource,
    appraisalUrl,
    parcelId: parcelResult?.parcelId ?? null,
    assessedValue: parcelResult?.assessedValue ?? null,
    annualTax: parcelResult?.annualTax ?? null,
    taxFromParcel,
    // Use county appraiser flood zone if available, otherwise fall back to FEMA NFHL
    floodZone: parcelResult?.floodZone ?? femaFloodZone ?? null,
    zillowUrl,
    source: geo ? (parcelResult?.parcelId ? "county appraiser" : "address validated") : "manual",
  };
}

// ─── Florida title insurance promulgated rates (OIR tiered schedule) ─────────────
// Source: Florida Office of Insurance Regulation (OIR) promulgated rate schedule
// Used by Timios and all FL title companies — not a flat %
function floridaLenderTitleInsurance(loanAmount: number): number {
  // Florida promulgated rate: $5.75 per $1,000 up to $100k, then $5.00 per $1,000 above $100k
  // Minimum $100
  if (loanAmount <= 0) return 100;
  const base = Math.min(loanAmount, 100000);
  const above = Math.max(0, loanAmount - 100000);
  return Math.round(base * 0.00575 + above * 0.005);
}

function floridaOwnerTitleInsurance(purchasePrice: number): number {
  // Owner's title = same rate schedule on purchase price, minus simultaneous issue discount (~30%)
  // Simultaneous issue with lender's policy: flat rate $25 + $2.50/1,000 above $100k
  if (purchasePrice <= 0) return 25;
  const above = Math.max(0, purchasePrice - 100000);
  return Math.round(25 + above * 0.0025);
}

function floridaEndorsement(loanAmount: number): number {
  // FL endorsement approx $0.75 per $1,000 (ALTA endorsements)
  return Math.round(loanAmount * 0.00075);
}

// ─── State-specific transfer taxes & recording fees ────────────────────────────
// Sources: State statutes and Timios calculator verified
interface StateClosingFees {
  deedTaxRate: number;       // % of purchase price
  mortgageTaxRate: number;   // % of loan amount
  intangibleTaxRate: number; // % of loan amount (FL only + a few others)
  recordingDeed: number;     // flat $
  recordingMortgage: number; // flat $
  hasTransferTax: boolean;
  label: string;
}

const STATE_CLOSING_FEES: Record<string, StateClosingFees> = {
  // Florida (Miami-Dade uses 0.6% deed stamp; all other counties 0.7%)
  FL: { deedTaxRate: 0.007, mortgageTaxRate: 0.0035, intangibleTaxRate: 0.002, recordingDeed: 86.50, recordingMortgage: 256.50, hasTransferTax: true, label: "FL" },
  // California — no mortgage/intangible tax; county transfer tax ~$1.10/1000
  CA: { deedTaxRate: 0.0011, mortgageTaxRate: 0, intangibleTaxRate: 0, recordingDeed: 25, recordingMortgage: 25, hasTransferTax: true, label: "CA" },
  // Texas — no state transfer tax (local only ~$0)
  TX: { deedTaxRate: 0, mortgageTaxRate: 0, intangibleTaxRate: 0, recordingDeed: 50, recordingMortgage: 50, hasTransferTax: false, label: "TX" },
  // New York — 0.4% mansion tax on purchases > $1M; basic transfer 0.4%
  NY: { deedTaxRate: 0.004, mortgageTaxRate: 0.008, intangibleTaxRate: 0, recordingDeed: 150, recordingMortgage: 250, hasTransferTax: true, label: "NY" },
  // New Jersey — 1% realty transfer fee on first $350k; 1.5% above
  NJ: { deedTaxRate: 0.01, mortgageTaxRate: 0, intangibleTaxRate: 0, recordingDeed: 100, recordingMortgage: 100, hasTransferTax: true, label: "NJ" },
  // Maryland — 0.5% state transfer + 0.25% county
  MD: { deedTaxRate: 0.0075, mortgageTaxRate: 0, intangibleTaxRate: 0, recordingDeed: 60, recordingMortgage: 60, hasTransferTax: true, label: "MD" },
  // Virginia — 0.25% state + 0.1% local grantor
  VA: { deedTaxRate: 0.0035, mortgageTaxRate: 0, intangibleTaxRate: 0, recordingDeed: 40, recordingMortgage: 40, hasTransferTax: true, label: "VA" },
  // Pennsylvania — 2% state transfer tax split buyer/seller; buyer pays 1%
  PA: { deedTaxRate: 0.01, mortgageTaxRate: 0, intangibleTaxRate: 0, recordingDeed: 75, recordingMortgage: 75, hasTransferTax: true, label: "PA" },
  // Illinois — 0.1% state + local varies; use 0.15% avg
  IL: { deedTaxRate: 0.0015, mortgageTaxRate: 0, intangibleTaxRate: 0, recordingDeed: 60, recordingMortgage: 60, hasTransferTax: true, label: "IL" },
  // Georgia — $1/500 (0.2%) deed tax
  GA: { deedTaxRate: 0.002, mortgageTaxRate: 0, intangibleTaxRate: 0.003, recordingDeed: 25, recordingMortgage: 25, hasTransferTax: true, label: "GA" },
  // Default (no transfer tax states: TX, AZ, CO, etc.)
  DEFAULT: { deedTaxRate: 0, mortgageTaxRate: 0, intangibleTaxRate: 0, recordingDeed: 50, recordingMortgage: 100, hasTransferTax: false, label: "" },
};

function getStateClosingFees(stateCode: string): StateClosingFees {
  return STATE_CLOSING_FEES[stateCode.toUpperCase()] ?? STATE_CLOSING_FEES["DEFAULT"];
}

// ─── County Property Appraiser URLs ──────────────────────────────────────────
// All 67 Florida counties + key counties in other states

const PROPERTY_APPRAISER_URLS: Record<string, string> = {
  // ─ Florida (all 67 counties) ─
  "Alachua County, FL":      "https://www.acpafl.org",
  "Baker County, FL":        "https://www.bakercountypa.com",
  "Bay County, FL":          "https://www.baypa.net",
  "Bradford County, FL":     "https://bradfordpa.com",
  "Brevard County, FL":      "https://www.bcpao.us",
  "Broward County, FL":      "https://bcpa.net",
  "Calhoun County, FL":      "https://www.calhounpa.com",
  "Charlotte County, FL":    "https://www.ccappraiser.com",
  "Citrus County, FL":       "https://www.citruspa.org",
  "Clay County, FL":         "https://www.ccpao.com",
  "Collier County, FL":      "https://www.collierappraiser.com",
  "Columbia County, FL":     "https://columbiapafl.com",
  "Miami-Dade County, FL":   "https://www.miamidadepa.gov",
  "DeSoto County, FL":       "https://www.desotopafl.com",
  "Dixie County, FL":        "https://www.dixiecountypa.com",
  "Duval County, FL":        "https://paopropertysearch.coj.net",
  "Escambia County, FL":     "https://www.escpa.org",
  "Flagler County, FL":      "https://www.flaglerpa.com",
  "Franklin County, FL":     "https://www.franklinpa.net",
  "Gadsden County, FL":      "https://www.gadsdenpa.com",
  "Gilchrist County, FL":    "https://www.gilchristpa.org",
  "Glades County, FL":       "https://www.gladespa.org",
  "Gulf County, FL":         "https://www.gulfpa.org",
  "Hamilton County, FL":     "https://www.hamiltonpa.org",
  "Hardee County, FL":       "https://www.hardeepa.org",
  "Hendry County, FL":       "https://www.hendrypa.com",
  "Hernando County, FL":     "https://www.hernandopa.com",
  "Highlands County, FL":    "https://www.hcpafl.org",
  "Hillsborough County, FL": "https://hcpafl.org",
  "Holmes County, FL":       "https://www.holmespa.org",
  "Indian River County, FL": "https://www.ircpa.net",
  "Jackson County, FL":      "https://www.jacksonpa.net",
  "Jefferson County, FL":    "https://www.jeffersonpafl.com",
  "Lafayette County, FL":    "https://www.lafayettepa.org",
  "Lake County, FL":         "https://www.lakepa.org",
  "Lee County, FL":          "https://www.leepa.org",
  "Leon County, FL":         "https://www.leonpa.org",
  "Levy County, FL":         "https://www.levypa.com",
  "Liberty County, FL":      "https://www.libertypa.org",
  "Madison County, FL":      "https://www.madisonpa.org",
  "Manatee County, FL":      "https://www.manateepao.com",
  "Marion County, FL":       "https://www.pa.marion.fl.us",
  "Martin County, FL":       "https://www.pa.martin.fl.us",
  "Monroe County, FL":       "https://www.mcpafl.org",
  "Nassau County, FL":       "https://www.nassauflpa.com",
  "Okaloosa County, FL":     "https://www.okaloosapafl.com",
  "Okeechobee County, FL":   "https://www.okeechobeepa.com",
  "Orange County, FL":       "https://www.ocpafl.org",
  "Osceola County, FL":      "https://www.property-appraiser.org",
  "Palm Beach County, FL":   "https://pbcpao.gov",
  "Pasco County, FL":        "https://pascopa.com",
  "Pinellas County, FL":     "https://www.pcpao.gov",
  "Polk County, FL":         "https://www.polkpa.org",
  "Putnam County, FL":       "https://www.putnampa.com",
  "St. Johns County, FL":    "https://www.sjcpa.us",
  "St. Lucie County, FL":    "https://www.stluciepa.com",
  "Santa Rosa County, FL":   "https://www.srcpa.org",
  "Sarasota County, FL":     "https://www.sc-pa.com",
  "Seminole County, FL":     "https://www.scpafl.org",
  "Sumter County, FL":       "https://www.sumterpa.com",
  "Suwannee County, FL":     "https://www.suwanneepa.com",
  "Taylor County, FL":       "https://www.taylorpa.org",
  "Union County, FL":        "https://www.unioncountypa.org",
  "Volusia County, FL":      "https://www.vcgov.org/government/constitutional-offices/property-appraiser",
  "Wakulla County, FL":      "https://www.wakullapafl.com",
  "Walton County, FL":       "https://www.waltonpa.com",
  "Washington County, FL":   "https://www.washingtonpa.org",

  // ─ California (major counties) ─
  "Los Angeles County, CA":   "https://assessor.lacounty.gov",
  "San Diego County, CA":     "https://www.sandiegocounty.gov/content/sdc/assessor.html",
  "Orange County, CA":        "https://www.ocassessor.gov",
  "Riverside County, CA":     "https://www.assessor.rivco.org",
  "San Bernardino County, CA":"https://www.sbcounty.gov/departments/assessor-recorder-county-clerk",
  "Santa Clara County, CA":   "https://assessor.sccgov.org",
  "Alameda County, CA":       "https://www.acassessor.org",
  "Contra Costa County, CA":  "https://assessor.contracosta.ca.gov",
  "Sacramento County, CA":    "https://assessor.saccounty.gov",
  "San Francisco County, CA": "https://assessor.sfgov.org",
  "San Mateo County, CA":     "https://www.smcassessor.org",
  "Marin County, CA":         "https://www.marincounty.org/depts/ar",
  "Ventura County, CA":       "https://assessor.countyofventura.org",
  "Fresno County, CA":        "https://www.co.fresno.ca.us/departments/assessor",
  "Kern County, CA":          "https://www.assessor.co.kern.ca.us",

  // ─ Texas (major counties) ─
  "Harris County, TX":       "https://hcad.org",
  "Dallas County, TX":       "https://www.dallascad.org",
  "Tarrant County, TX":      "https://www.tad.org",
  "Travis County, TX":       "https://www.traviscad.org",
  "Collin County, TX":       "https://www.collincad.org",
  "Bexar County, TX":        "https://www.bcad.org",
  "Denton County, TX":       "https://www.dentoncad.com",
  "Fort Bend County, TX":    "https://www.fbcad.org",
  "Montgomery County, TX":   "https://www.mcad-tx.org",
  "El Paso County, TX":      "https://epcad.org",
  "Williamson County, TX":   "https://www.wcad.org",
  "Galveston County, TX":    "https://www.galvestoncad.org",

  // ─ New York (major counties) ─
  "New York County, NY":     "https://www.nyc.gov/site/finance/taxes/property.page",
  "Kings County, NY":        "https://www.nyc.gov/site/finance/taxes/property.page",
  "Queens County, NY":       "https://www.nyc.gov/site/finance/taxes/property.page",
  "Bronx County, NY":        "https://www.nyc.gov/site/finance/taxes/property.page",
  "Suffolk County, NY":      "https://www.suffolkcountyny.gov/departments/assessor",
  "Nassau County, NY":       "https://www.nassaucountyny.gov/agencies/Assessor",
  "Westchester County, NY":  "https://www.westchestergov.com/taxcommission",
  "Erie County, NY":         "https://www2.erie.gov/assessments",

  // ─ New Jersey (major counties) ─
  "Bergen County, NJ":       "https://www.bergencountynj.gov/assessment",
  "Middlesex County, NJ":    "https://www.middlesexcountynj.gov/government/departments/tax-board",
  "Essex County, NJ":        "https://www.essexcountynj.org/tax",
  "Hudson County, NJ":       "https://www.hudsoncountynj.org/tax-board",
  "Monmouth County, NJ":     "https://www.visitmonmouth.com/page.aspx?Id=2862",

  // ─ Georgia (major counties) ─
  "Fulton County, GA":       "https://www.fultonassessor.org",
  "Gwinnett County, GA":     "https://www.gwinnettassessor.com",
  "DeKalb County, GA":       "https://www.dekalbcountyga.gov/tax-assessor/tax-assessor",
  "Cobb County, GA":         "https://www.cobbtax.org",
  "Cherokee County, GA":     "https://www.cherokeega.com/tax-assessor",

  // ─ North Carolina (major counties) ─
  "Mecklenburg County, NC":  "https://www.mecknc.gov/LUESA/AssessorsOffice",
  "Wake County, NC":         "https://www.wake.gov/departments-agencies/tax-administration",
  "Durham County, NC":       "https://www.dconc.gov/government/departments-f-z/tax-administration",

  // ─ Virginia (major counties) ─
  "Fairfax County, VA":      "https://www.fairfaxcounty.gov/realestate",
  "Prince William County, VA":"https://www.pwcgov.org/business/dept/finance/pages/real-estate-assessments.aspx",
  "Loudoun County, VA":      "https://www.loudoun.gov/assessments",

  // ─ Maryland (major counties) ─
  "Montgomery County, MD":   "https://sdat.dat.maryland.gov",
  "Prince George's County, MD":"https://sdat.dat.maryland.gov",
  "Baltimore County, MD":    "https://sdat.dat.maryland.gov",

  // ─ Colorado (major counties) ─
  "Denver County, CO":       "https://www.denvergov.org/Government/Agencies-Departments-Offices/Agencies-Departments-Offices-Directory/Assessors-Office",
  "Jefferson County, CO":    "https://www.jeffco.us/463/Assessor",
  "Arapahoe County, CO":     "https://www.arapahoegov.com/assessor",
  "Douglas County, CO":      "https://www.douglas.co.us/assessor",
  "El Paso County, CO":      "https://assessor.elpasoco.com",
  "Boulder County, CO":      "https://www.bouldercounty.gov/property-and-land/assessor",

  // ─ Washington State (major counties) ─
  "King County, WA":         "https://kingcounty.gov/en/dept/dper/land-use-environment/property-assessments-and-taxes",
  "Pierce County, WA":       "https://www.piercecountywa.gov/assessortreasurer",
  "Snohomish County, WA":    "https://snohomishcountywa.gov/294/Assessor",
  "Clark County, WA":        "https://clark.wa.gov/assessor",

  // ─ Arizona (major counties) ─
  "Maricopa County, AZ":     "https://mcassessor.maricopa.gov",
  "Pima County, AZ":         "https://assessor.pima.gov",
  "Pinal County, AZ":        "https://www.pinalcountyaz.gov/assessor",

  // ─ Illinois (major counties) ─
  "Cook County, IL":         "https://www.cookcountyassessor.com",
  "DuPage County, IL":       "https://www.dupageassessor.com",
  "Lake County, IL":         "https://www.lakecountyil.gov/193/Assessment-Office",

  // ─ Pennsylvania (major counties) ─
  "Philadelphia County, PA": "https://www.phila.gov/departments/office-of-property-assessment",
  "Allegheny County, PA":    "https://www.alleghenycounty.us/government/departments/real-estate/property-assessments",
  "Montgomery County, PA":   "https://www.montgomerycopa.gov/assessments",
  "Bucks County, PA":        "https://www.buckscounty.gov/government/departments/AssessmentAndRevision",

  // ─ Tennessee (major counties) ─
  "Shelby County, TN":       "https://www.assessor.shelby.tn.us",
  "Davidson County, TN":     "https://www.padctn.org",
  "Knox County, TN":         "https://www.knoxcounty.org/assessor",
  "Williamson County, TN":   "https://www.williamsonpropertytax.com",

  // ─ South Carolina (major counties) ─
  "Greenville County, SC":   "https://www.greenvillecounty.org/auditor",
  "Charleston County, SC":   "https://www.charlestoncounty.org/departments/assessor",
  "Horry County, SC":        "https://www.horrycountysc.gov/departments/assessor",

  // ─ Nevada (major counties) ─
  "Clark County, NV":        "https://www.clarkcountynv.gov/government/assessor",
  "Washoe County, NV":       "https://www.washoecounty.gov/assessor",
};

// Search URL templates — counties that support address deep-linking
// {ADDRESS} is replaced with the URL-encoded address at runtime
const APPRAISER_SEARCH_TEMPLATES: Record<string, string> = {
  // Florida — sites with direct address search URL support
  "Palm Beach County, FL":   "https://pbcpao.gov/MasterSearch/SearchResults?propertyType=RE&searchvalue={ADDRESS}",
  "Miami-Dade County, FL":   "https://apps.miamidadepa.gov/PropertySearch/#/?address={ADDRESS}",
  "Brevard County, FL":      "https://www.bcpao.us/PropertySearch/#/search/address={ADDRESS}",
  "Pinellas County, FL":     "https://www.pcpao.gov/quick-search?qu=1&input={ADDRESS}&search_option=address",
  "Hillsborough County, FL": "https://gis.hcpafl.org/propertysearch/#/search/basic/address={ADDRESS}",
  "Alachua County, FL":      "https://www.acpafl.org",
  "Collier County, FL":      "https://www.collierappraiser.com/main_search/RecordSearch.aspx",
  "Sarasota County, FL":     "https://www.sc-pa.com/propertysearch",
  "Seminole County, FL":     "https://www.scpafl.org",
  "Manatee County, FL":      "https://www.manateepao.com/Records/PropertySearch.aspx",
  "Indian River County, FL": "https://www.ircpa.net/SitePages/PropertySearch.aspx",
  "St. Johns County, FL":    "https://www.sjcpa.us/property-search",
  "Marion County, FL":       "https://www.pa.marion.fl.us",
  "Duval County, FL":        "https://paopropertysearch.coj.net/Basic/Detail.aspx?searchValue={ADDRESS}",
  "Volusia County, FL":      "https://vcpa.vcgov.org/property_search.aspx",
  // Arizona
  "Maricopa County, AZ":     "https://mcassessor.maricopa.gov/mcs/?q={ADDRESS}",
  // California
  "San Diego County, CA":    "https://arcc.sdcounty.ca.gov/pages/propertyparcel-lookup.aspx",
  "Santa Clara County, CA":  "https://assessor.sccgov.org/online-services/search-property-by-address",
  "Sacramento County, CA":   "https://assessor.saccounty.gov/Pages/FreedomSearch.aspx",
  // Texas
  "Dallas County, TX":       "https://www.dallascad.org/Search.aspx",
  "Tarrant County, TX":      "https://www.tad.org/search-for-a-property/",
  "Travis County, TX":       "https://traviscad.org/propertysearch/",
  "Bexar County, TX":        "https://www.bcad.org/clientdb/",
  // New York (NYC — all boroughs)
  "New York County, NY":     "https://a836-acris.nyc.gov/CP/",
  "Kings County, NY":        "https://a836-acris.nyc.gov/CP/",
  "Queens County, NY":       "https://a836-acris.nyc.gov/CP/",
  "Bronx County, NY":        "https://a836-acris.nyc.gov/CP/",
};

function getAppraisalUrl(county: string, stateCode: string, address?: string): string | null {
  const normalize = (c: string) => c.includes("County") ? c : `${c} County`;
  const key1 = `${county}, ${stateCode.toUpperCase()}`;
  const key2 = `${normalize(county)}, ${stateCode.toUpperCase()}`;

  // Check if we have a deep-link search template for this county
  const template = APPRAISER_SEARCH_TEMPLATES[key1] ?? APPRAISER_SEARCH_TEMPLATES[key2];
  if (template && address) {
    // Encode address — strip state/zip and use just street + city for cleaner search
    const cleanAddress = address.split(",").slice(0, 2).join(",").trim();
    return template.replace("{ADDRESS}", encodeURIComponent(cleanAddress));
  }

  // Fall back to homepage URL
  const baseUrl = PROPERTY_APPRAISER_URLS[key1] ?? PROPERTY_APPRAISER_URLS[key2];
  return baseUrl ?? null;
}

// ─── State property tax due date schedule ────────────────────────────────────
// Returns the next due date months (1-12) for property taxes in a given state.
// Used to calculate how many months of escrow reserves are needed at closing.
// Lenders collect enough months to cover from closing until the next tax bill.

interface TaxSchedule {
  dueDates: number[];  // months (1-12) when taxes are due
  frequency: "annual" | "semi" | "quarterly";
}

const STATE_TAX_SCHEDULE: Record<string, TaxSchedule> = {
  AL: { dueDates: [12], frequency: "annual" },
  AK: { dueDates: [10], frequency: "annual" },
  AZ: { dueDates: [4, 11], frequency: "semi" },
  AR: { dueDates: [4, 7], frequency: "semi" },
  CA: { dueDates: [12, 4], frequency: "semi" },
  CO: { dueDates: [4, 6], frequency: "semi" },
  CT: { dueDates: [7, 1], frequency: "semi" },
  DE: { dueDates: [9], frequency: "annual" },
  DC: { dueDates: [3, 9], frequency: "semi" },
  // FL: bills mailed Nov 1, payable Nov 1 (4% discount), due Mar 31.
  // Lenders escrow to the Nov 1 payable date, not the Mar 31 deadline.
  FL: { dueDates: [11], frequency: "annual" },
  GA: { dueDates: [9, 11], frequency: "semi" },
  HI: { dueDates: [2, 8], frequency: "semi" },
  ID: { dueDates: [6, 12], frequency: "semi" },
  IL: { dueDates: [6, 9], frequency: "semi" },
  IN: { dueDates: [5, 11], frequency: "semi" },
  IA: { dueDates: [9, 3], frequency: "semi" },
  KS: { dueDates: [5, 12], frequency: "semi" },
  KY: { dueDates: [11, 12], frequency: "semi" },
  LA: { dueDates: [12], frequency: "annual" },
  ME: { dueDates: [9], frequency: "annual" },
  MD: { dueDates: [9, 12], frequency: "semi" },
  MA: { dueDates: [2, 5, 8, 11], frequency: "quarterly" },
  MI: { dueDates: [8, 2], frequency: "semi" },
  MN: { dueDates: [5, 10], frequency: "semi" },
  MS: { dueDates: [2], frequency: "annual" },
  MO: { dueDates: [12], frequency: "annual" },
  MT: { dueDates: [5, 11], frequency: "semi" },
  NE: { dueDates: [4, 8], frequency: "semi" },
  NV: { dueDates: [8, 10, 1, 3], frequency: "quarterly" },
  NH: { dueDates: [7, 12], frequency: "semi" },
  NJ: { dueDates: [2, 5, 8, 11], frequency: "quarterly" },
  NM: { dueDates: [11, 4], frequency: "semi" },
  NY: { dueDates: [7, 1], frequency: "semi" },
  NC: { dueDates: [1], frequency: "annual" },
  ND: { dueDates: [3, 10], frequency: "semi" },
  OH: { dueDates: [6, 12], frequency: "semi" },
  OK: { dueDates: [12, 3], frequency: "semi" },
  OR: { dueDates: [11, 5], frequency: "semi" },
  PA: { dueDates: [6], frequency: "annual" },
  RI: { dueDates: [8], frequency: "annual" },
  SC: { dueDates: [1], frequency: "annual" },
  SD: { dueDates: [4, 10], frequency: "semi" },
  TN: { dueDates: [2], frequency: "annual" },
  TX: { dueDates: [1], frequency: "annual" },
  UT: { dueDates: [11], frequency: "annual" },
  VT: { dueDates: [8], frequency: "annual" },
  VA: { dueDates: [5], frequency: "annual" },
  WA: { dueDates: [4, 10], frequency: "semi" },
  WV: { dueDates: [9, 3], frequency: "semi" },
  WI: { dueDates: [1, 7], frequency: "semi" },
  WY: { dueDates: [5, 11], frequency: "semi" },
};

// Calculate months of tax escrow needed at closing.
// Lenders typically require 2-6 months cushion depending on next due date.
function calcTaxEscrowMonths(closingDate: Date, stateCode: string): { months: number; reason: string } {
  const schedule = STATE_TAX_SCHEDULE[stateCode.toUpperCase()];
  if (!schedule) return { months: 3, reason: "3 months (default)" };

  const closingMonth = closingDate.getMonth() + 1; // 1-12

  // Find the next upcoming due month from closing date
  const sortedDates = [...schedule.dueDates].sort((a, b) => a - b);
  let nextDueMonth = sortedDates.find(m => m > closingMonth);
  if (!nextDueMonth) nextDueMonth = sortedDates[0]; // wrap to next year

  // Months until next due date
  let monthsUntilDue = nextDueMonth > closingMonth
    ? nextDueMonth - closingMonth
    : 12 - closingMonth + nextDueMonth;

  // Standard: lender requires 2 months cushion + months until next due
  // Capped between 2 and 8 months (standard range)
  const required = Math.min(8, Math.max(2, monthsUntilDue + 2));

  return {
    months: required,
    reason: `${required} months (next due: ${new Date(2000, nextDueMonth - 1).toLocaleString("default", { month: "short" })})`,
  };
}

// Calculate months of insurance escrow needed (typically 2-14 months depending on renewal date)
function calcInsuranceEscrowMonths(): { months: number; reason: string } {
  // Standard: lender requires 14 months upfront (12-month policy + 2 month cushion)
  // In practice, 14 months is collected at closing for the first year policy
  return { months: 14, reason: "14 months (12 mo. policy + 2 mo. cushion)" };
}

// ─── Financial calculations ───────────────────────────────────────────────────

function calcMonthlyPayment(principal: number, annualRatePercent: number, termYears: number): number {
  const r = annualRatePercent / 100 / 12;
  const n = termYears * 12;
  if (r === 0) return principal / n;
  return principal * (r * Math.pow(1 + r, n)) / (Math.pow(1 + r, n) - 1);
}

function calcClosingCosts(
  homePrice: number,
  loanAmount: number,
  loanType: string,
  interestRate: number,
  monthlyTax: number,
  monthlyInsurance: number,
  stateCode: string,
  closingDate: Date,
  includeEscrow: boolean = true,
  prepaidDays: number | null = null,
  sellerPaysTitle: boolean = true,
  floodInsuranceRequired: boolean = false,
  monthlyFlood: number = 0,
) {
  const state = getStateClosingFees(stateCode);
  const isFL = stateCode.toUpperCase() === "FL";

  // ── A: Lender Fees (always buyer) ────────────────────────────────────────────
  const lenderFees: Record<string, number> = {
    "Lender Fees (Processing & Underwriting)": 1690,
    "Appraisal Fee":                            650,
  };
  // NOTE: FHA Upfront MIP (1.75%) is NOT a closing cost — it is financed into the loan balance.
  // It does not appear in the closing cost worksheet.

  // ── B: Title & Settlement ─────────────────────────────────────────────────────
  const lenderTitle = isFL
    ? floridaLenderTitleInsurance(loanAmount)
    : Math.round(loanAmount * 0.004);
  const ownerTitle = isFL
    ? floridaOwnerTitleInsurance(homePrice)
    : Math.round(homePrice * 0.0025);
  const endorsement = isFL
    ? floridaEndorsement(loanAmount)
    : Math.round(loanAmount * 0.0003);

  // Buyer always pays: settlement fee, lender title, endorsements
  const titleFees: Record<string, number> = {
    "Settlement / Closing Fee *": 575,
    "Lender's Title Insurance *": lenderTitle,
    ...(endorsement > 0 ? { "Title Endorsements *": endorsement } : {}),
  };

  // Owner's title: buyer pays only when NOT seller-paid
  if (!sellerPaysTitle) {
    titleFees["Owner's Title Insurance *"] = ownerTitle;
  }
  const sellerTitleCredit = sellerPaysTitle ? ownerTitle : 0;

  // ── C: Government Fees ────────────────────────────────────────────────────────
  // FL customs: SELLER pays deed doc stamp + deed recording fee
  //             BUYER pays mortgage doc stamp + intangible tax + mortgage recording
  const govFees: Record<string, number> = {
    "Mortgage Recording Fee": Math.round(state.recordingMortgage),
  };
  if (state.mortgageTaxRate > 0)
    govFees["Mortgage Doc Stamp Tax"] = Math.round(loanAmount * state.mortgageTaxRate);
  if (state.intangibleTaxRate > 0)
    govFees["Intangible Tax"] = Math.round(loanAmount * state.intangibleTaxRate);
  // Non-FL states where buyer customarily pays deed tax
  if (!isFL && state.deedTaxRate > 0)
    govFees["Deed / Transfer Tax"] = Math.round(homePrice * state.deedTaxRate);
  if (!isFL)
    govFees["Deed Recording Fee"] = state.recordingDeed;

  // ── D: Other Third-Party ──────────────────────────────────────────────────────
  const thirdPartyFees: Record<string, number> = { "Survey Fee *": 375 };

  // ── E: Prepaids ───────────────────────────────────────────────────────────────
  let daysForPrepaid: number;
  let prepaidLabel: string;
  if (prepaidDays !== null && prepaidDays > 0) {
    daysForPrepaid = prepaidDays;
    prepaidLabel = `Prepaid Interest (${daysForPrepaid} days @ ${interestRate}%)`;
  } else {
    const daysInMonth = new Date(closingDate.getFullYear(), closingDate.getMonth() + 1, 0).getDate();
    daysForPrepaid = daysInMonth - closingDate.getDate() + 1;
    const dateStr = closingDate.toLocaleDateString("en-US", { month: "short", day: "numeric" });
    prepaidLabel = `Prepaid Interest (${daysForPrepaid} days @ ${interestRate}% — closes ${dateStr})`;
  }
  const dailyInterest = (loanAmount * (interestRate / 100)) / 365;
  const prepaidInterest = Math.round(dailyInterest * daysForPrepaid);
  const annualInsurance = Math.round(monthlyInsurance * 12);

  const prepaids: Record<string, number> = {
    [prepaidLabel]:                                prepaidInterest,
    "Homeowner's Insurance Premium * (12 months)": annualInsurance,
  };

  // Flood: 12-month premium always paid upfront at closing when required
  if (floodInsuranceRequired && monthlyFlood > 0) {
    prepaids["Flood Insurance Premium * (12 months)"] = Math.round(monthlyFlood * 12);
  }

  // ── F: Escrow Reserves ────────────────────────────────────────────────────────
  const taxEscrow = calcTaxEscrowMonths(closingDate, stateCode);
  const insuranceCushion = Math.round(monthlyInsurance * 2);
  const taxEscrowAmount = Math.round(monthlyTax * taxEscrow.months);

  const escrowReserves: Record<string, number> = includeEscrow ? {
    [`Property Tax Escrow (${taxEscrow.reason})`]: taxEscrowAmount,
    "Homeowner's Insurance Escrow (2 months)":      insuranceCushion,
  } : {};

  // Flood escrow is ALWAYS required when flood insurance is required —
  // lenders mandate it regardless of escrow waiver election
  if (floodInsuranceRequired && monthlyFlood > 0) {
    escrowReserves["Flood Insurance Escrow (2 months) \u2014 required"] = Math.round(monthlyFlood * 2);
  }

  // ── Combine ───────────────────────────────────────────────────────────────────
  const breakdown: Record<string, number | string> = {
    "── LENDER FEES ──":        "header",
    ...lenderFees,
    "── TITLE & SETTLEMENT ──": "header",
    ...titleFees,
    ...(sellerPaysTitle
      ? { "Seller Credit — Owner's Title Insurance": -sellerTitleCredit }
      : {}),
    "── GOVERNMENT FEES ──":    "header",
    ...govFees,
    "── OTHER FEES ──":         "header",
    ...thirdPartyFees,
    "── PREPAIDS ──":           "header",
    ...prepaids,
    ...(Object.keys(escrowReserves).length > 0
      ? { "── ESCROW RESERVES ──": "header" as string, ...escrowReserves }
      : {}),
  };

  const total = [
    ...Object.values(lenderFees),
    ...Object.values(titleFees),
    ...Object.values(govFees),
    ...Object.values(thirdPartyFees),
    ...Object.values(prepaids),
    ...Object.values(escrowReserves),
    ...(sellerPaysTitle ? [-sellerTitleCredit] : []),
  ].reduce((s, v) => s + v, 0);

  return { total, breakdown, sellerTitleCredit };
}

function applyAdditionalSellerCredit(
  breakdown: Record<string, number | string>,
  total: number,
  credit: number
): { breakdown: Record<string, number | string>; total: number } {
  if (credit <= 0) return { breakdown, total };
  const updated = { ...breakdown, "Additional Seller Credit": -credit };
  return { breakdown: updated, total: total - credit };
}

// ─── Market data: fetch from FRED (free, no key required) ───────────────────

interface MarketDataPoint {
  label: string;
  value: number;
  change: number;
  date: string;
  category: "mortgage" | "treasury" | "mbs";
}

interface MarketDataCache {
  data: MarketDataPoint[];
  fetchedAt: number;
}

let marketDataCache: MarketDataCache | null = null;
const CACHE_TTL_MS = 15 * 60 * 1000; // 15 minutes

async function fetchFredSeries(seriesId: string): Promise<{ value: number; prevValue: number; date: string } | null> {
  try {
    const res = await axios.get(
      `https://fred.stlouisfed.org/graph/fredgraph.csv?id=${seriesId}`,
      { headers: { "User-Agent": "CCM-LoanEstimator/1.0" }, timeout: 8000, responseType: "text" }
    );
    const lines = (res.data as string).trim().split("\n").filter(l => l && !l.startsWith("DATE"));
    if (lines.length < 2) return null;
    const last = lines[lines.length - 1].split(",");
    const prev = lines[lines.length - 2].split(",");
    const value = parseFloat(last[1]);
    const prevValue = parseFloat(prev[1]);
    if (isNaN(value) || isNaN(prevValue)) return null;
    return { value, prevValue, date: last[0] };
  } catch {
    return null;
  }
}

// ─── Mortgage News Daily rate scraper ────────────────────────────────────────
// MND publishes the most accurate daily mortgage rates driven by real lender sheets.
// We parse their public HTML rate table and cache it alongside FRED treasury data.

interface MndRates {
  conv30: number | null; conv15: number | null;
  fha30: number | null;  va30: number | null;
  jumbo30: number | null; arm: number | null;
  date: string;
}

async function fetchMndRates(): Promise<MndRates> {
  const fallback: MndRates = {
    conv30: null, conv15: null, fha30: null,
    va30: null, jumbo30: null, arm: null,
    date: new Date().toISOString().slice(0, 10),
  };
  try {
    const res = await axios.get("https://www.mortgagenewsdaily.com/mortgage-rates/mnd", {
      headers: {
        "User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/123.0.0.0 Safari/537.36",
        "Accept": "text/html,application/xhtml+xml",
      },
      timeout: 10000,
    });
    const html: string = res.data;

    // Extract rates from the MND rate table
    // Each row: <td>Product Name</td><td>6.43%</td>...
    const extractRate = (label: string): number | null => {
      // Match the label then capture the next percentage value
      const re = new RegExp(label.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '[\\s\\S]{0,200}?([\\d]+\\.[\\d]{2})%', 'i');
      const m = html.match(re);
      return m ? parseFloat(m[1]) : null;
    };

    // Parse date from page
    const dateMatch = html.match(/(\d{1,2}\/\d{1,2}\/\d{2,4})/) ;
    const date = dateMatch ? dateMatch[1] : new Date().toISOString().slice(0, 10);

    return {
      conv30:  extractRate('30 Yr. Fixed'),
      conv15:  extractRate('15 Yr. Fixed'),
      fha30:   extractRate('30 Yr. FHA'),
      va30:    extractRate('30 Yr. VA'),
      jumbo30: extractRate('30 Yr. Jumbo'),
      arm:     extractRate('7/6 SOFR ARM') ?? extractRate('7/1 ARM'),
      date,
    };
  } catch (err) {
    console.error("MND rate fetch error:", (err as any)?.message);
    return fallback;
  }
}

async function fetchMarketData(): Promise<MarketDataPoint[]> {
  // Fetch MND mortgage rates + FRED treasury yields in parallel
  const [mnd, t2, t5, t10, t30] = await Promise.all([
    fetchMndRates(),
    fetchFredSeries("DGS2"),
    fetchFredSeries("DGS5"),
    fetchFredSeries("DGS10"),
    fetchFredSeries("DGS30"),
  ]);

  const results: MarketDataPoint[] = [];
  const today = mnd.date;

  // ── Mortgage Rates (Mortgage News Daily — daily lender sheet index) ──
  // MND doesn't expose prev-day deltas in the HTML directly, so we track last cached value
  // For first load, show 0.000 change; subsequent loads compare to cached
  const prev = marketDataCache?.data ?? [];
  const prevRate = (label: string) => prev.find(p => p.label === label)?.value ?? null;

  const pushRate = (label: string, value: number | null) => {
    if (!value) return;
    const p = prevRate(label);
    const change = p ? Math.round((value - p) * 1000) / 1000 : 0;
    results.push({ label, value, change, date: today, category: "mortgage" });
  };

  pushRate("30-Yr Conventional", mnd.conv30);
  pushRate("30-Yr FHA",          mnd.fha30);
  pushRate("30-Yr VA",           mnd.va30);
  pushRate("30-Yr Jumbo",        mnd.jumbo30);
  pushRate("15-Yr Conventional", mnd.conv15);
  if (mnd.arm) pushRate("7/6 ARM", mnd.arm);

  // ── MBS Spread (30yr conv rate minus 10yr Treasury) ──
  if (mnd.conv30 && t10) {
    const spread = Math.round((mnd.conv30 - t10.value) * 100) / 100;
    const prevConv = prevRate("30-Yr Conventional") ?? mnd.conv30;
    const prevSpread = Math.round((prevConv - t10.prevValue) * 100) / 100;
    results.push({
      label: "Mtg-Treasury Spread",
      value: spread,
      change: Math.round((spread - prevSpread) * 1000) / 1000,
      date: today,
      category: "mbs",
    });
    const umbsPrice = Math.round((100 - (mnd.conv30 - 6.0) * 4) * 100) / 100;
    const umbsPrev  = Math.round((100 - (prevConv - 6.0) * 4) * 100) / 100;
    results.push({
      label: "UMBS 30YR 6.0 (est.)",
      value: umbsPrice,
      change: Math.round((umbsPrice - umbsPrev) * 1000) / 1000,
      date: today,
      category: "mbs",
    });
  }

  // ── Treasury Yields (FRED — unchanged) ──
  const r = (v: number, p: number) => Math.round((v - p) * 1000) / 1000;
  if (t2)  results.push({ label: "2-Yr Treasury",  value: t2.value,  change: r(t2.value,  t2.prevValue),  date: t2.date,  category: "treasury" });
  if (t5)  results.push({ label: "5-Yr Treasury",  value: t5.value,  change: r(t5.value,  t5.prevValue),  date: t5.date,  category: "treasury" });
  if (t10) results.push({ label: "10-Yr Treasury", value: t10.value, change: r(t10.value, t10.prevValue), date: t10.date, category: "treasury" });
  if (t30) results.push({ label: "30-Yr Treasury", value: t30.value, change: r(t30.value, t30.prevValue), date: t30.date, category: "treasury" });

  // Update live MORTGAGE_RATES from MND so loan estimates use current rates
  if (mnd.conv30) { MORTGAGE_RATES.conventional_30.rate = mnd.conv30; }
  if (mnd.conv15) { MORTGAGE_RATES.conventional_15.rate = mnd.conv15; }
  if (mnd.fha30)  { MORTGAGE_RATES.fha_30.rate = mnd.fha30; }
  if (mnd.va30)   { MORTGAGE_RATES.va_30.rate  = mnd.va30;  }
  if (mnd.jumbo30){ MORTGAGE_RATES.jumbo_30.rate = mnd.jumbo30; }
  if (mnd.arm)    { MORTGAGE_RATES.arm_7_1.rate  = mnd.arm;  }

  return results;
}

// ─── Routes ───────────────────────────────────────────────────────────────────

export async function registerRoutes(httpServer: Server, app: Express) {

  // GET /api/market-data — live rates from FRED (cached 15min)
  app.get("/api/market-data", async (_req, res) => {
    const now = Date.now();
    if (marketDataCache && (now - marketDataCache.fetchedAt) < CACHE_TTL_MS) {
      return res.json({ data: marketDataCache.data, fetchedAt: new Date(marketDataCache.fetchedAt).toISOString(), cached: true });
    }
    const data = await fetchMarketData();
    marketDataCache = { data, fetchedAt: now };
    res.json({ data, fetchedAt: new Date(now).toISOString(), cached: false });
  });

  app.get("/api/rates", (_req, res) => {
    res.json({
      rates: Object.entries(MORTGAGE_RATES).map(([key, val]) => ({
        key, label: val.label, rate: val.rate, termYears: val.termYears,
        asOf: "April 5, 2026", source: "Mortgage News Daily",
      })),
    });
  });

  app.get("/api/autocomplete", async (req, res) => {
    const q = (req.query.q as string ?? "").trim();
    if (q.length < 3) return res.json({ suggestions: [] });
    res.json({ suggestions: await getAutocompleteSuggestions(q) });
  });

  app.post("/api/property-lookup", async (req, res) => {
    const parsed = propertyLookupSchema.safeParse(req.body);
    if (!parsed.success) return res.status(400).json({ error: "Invalid address" });
    const { address } = parsed.data;
    const magicKey = req.body.magicKey as string | undefined;
    res.json(await lookupProperty(address, magicKey));
  });

  app.post("/api/estimate", async (req, res) => {
    const parsed = loanEstimateRequestSchema.safeParse(req.body);
    if (!parsed.success) return res.status(400).json({ error: parsed.error.errors[0].message });

    const { address, homePrice, downPaymentPercent, loanType, propertyTax, hoaFee } = parsed.data;
    const rateInfo = MORTGAGE_RATES[loanType];
    if (!rateInfo) return res.status(400).json({ error: "Invalid loan type" });

    const downPaymentAmount = homePrice * (downPaymentPercent / 100);
    const baseLoanAmount = homePrice - downPaymentAmount;
    const downPct = downPaymentPercent;

    // FHA: 1.75% UFMIP financed into loan (not a closing cost)
    const ufmip = loanType === "fha_30" ? Math.round(baseLoanAmount * 0.0175) : 0;

    // VA Funding Fee — financed into loan (not a closing cost)
    // Options: exempt (0%), first_use, subsequent_use
    // Rates per VA chart: Purchase First Use: 0%dn=2.3%, 5%dn=1.65%, 10%+dn=1.4%
    //                     Purchase After First Use: 0%dn=3.6%, 5%dn=1.65%, 10%+dn=1.4%
    const vaFundingFeeOption = (req.body.vaFundingFeeOption as string) ?? "first_use";
    let vaFundingFeeRate = 0;
    if (loanType === "va_30" && vaFundingFeeOption !== "exempt") {
      if (downPct >= 10) {
        vaFundingFeeRate = 0.0140; // 1.40% for both first and subsequent use
      } else if (downPct >= 5) {
        vaFundingFeeRate = 0.0165; // 1.65% for both first and subsequent use
      } else {
        // 0% down
        vaFundingFeeRate = vaFundingFeeOption === "subsequent_use" ? 0.0360 : 0.0230;
      }
    }
    const vaFundingFee = loanType === "va_30" ? Math.round(baseLoanAmount * vaFundingFeeRate) : 0;

    const loanAmount = baseLoanAmount + ufmip + vaFundingFee;
    const { termYears } = rateInfo;

    // Use custom rate if provided (and valid), otherwise use the national average
    const customRateInput = req.body.customRate ? parseFloat(req.body.customRate) : null;
    const interestRate = (customRateInput && customRateInput > 0 && customRateInput <= 20)
      ? customRateInput
      : rateInfo.rate;
    const rateIsCustom = interestRate !== rateInfo.rate;

    const monthlyPI = calcMonthlyPayment(loanAmount, interestRate, termYears);
    // Insurance: use override if provided, otherwise estimate from price
    const homeInsuranceOverride = req.body.homeInsuranceOverride ? parseFloat(String(req.body.homeInsuranceOverride)) : null;
    const homeInsurance = (homeInsuranceOverride && homeInsuranceOverride > 0)
      ? homeInsuranceOverride
      : (homePrice * 0.008) / 12;

    const floodInsuranceRequired = req.body.floodInsuranceRequired === true;
    const floodInsuranceOverride = req.body.floodInsuranceOverride ? parseFloat(String(req.body.floodInsuranceOverride)) : null;
    const monthlyFlood = floodInsuranceRequired
      ? ((floodInsuranceOverride && floodInsuranceOverride > 0)
          ? floodInsuranceOverride
          : Math.round((homePrice * 0.005) / 12 * 100) / 100)
      : 0;
    const monthlyMIP = loanType === "fha_30" ? (loanAmount * 0.0055) / 12 : 0;

    // PMI: use override rate if provided, otherwise use MGIC tiered table
    const pmiOverrideInput = req.body.pmiOverride ? parseFloat(String(req.body.pmiOverride)) : null;
    const pmiOverrideRate = (pmiOverrideInput && pmiOverrideInput >= 0.01 && pmiOverrideInput <= 2.0)
      ? pmiOverrideInput / 100  // convert % to decimal
      : null;

    function getPmiRate(ltv: number): number {
      if (ltv >= 0.95) return 0.0085;
      if (ltv >= 0.90) return 0.0049;
      if (ltv >= 0.85) return 0.0032;
      return 0.0020;
    }
    const ltv = loanAmount / homePrice;
    const isConventional = ["conventional_30", "conventional_15"].includes(loanType);
    const effectivePmiRate = pmiOverrideRate ?? getPmiRate(ltv);
    const monthlyPMI = isConventional && downPaymentPercent < 20
      ? Math.round((loanAmount * effectivePmiRate) / 12 * 100) / 100 : 0;

    const totalMonthly = monthlyPI + propertyTax + homeInsurance + monthlyFlood + hoaFee + monthlyMIP + monthlyPMI;

    const stateCode = (req.body.stateCode as string) ?? "";

    // Closing date: use provided date string, or fall back to today
    let closingDate = new Date();
    let prepaidDays: number | null = null;
    if (req.body.closingDate) {
      const parsed = new Date(req.body.closingDate + "T12:00:00"); // noon to avoid TZ issues
      if (!isNaN(parsed.getTime())) {
        closingDate = parsed;
      }
    } else {
      // No closing date provided — default to 5 days prepaid interest
      prepaidDays = 5;
    }

    const includeEscrow = downPaymentPercent >= 20
      ? (req.body.includeEscrow !== false)
      : true;

    // sellerPaysTitle defaults to true (FL default: seller pays owner's title + deed recording)
    const sellerPaysTitle = req.body.sellerPaysTitle !== false;

    // Additional seller credit (reduces cash to close)
    const additionalSellerCredit = req.body.additionalSellerCredit
      ? Math.max(0, parseFloat(String(req.body.additionalSellerCredit)))
      : 0;

    const { total: closingCosts, breakdown: closingCostBreakdown, sellerTitleCredit } = calcClosingCosts(
      homePrice, loanAmount, loanType, interestRate,
      propertyTax, homeInsurance, stateCode, closingDate, includeEscrow, prepaidDays, sellerPaysTitle,
      floodInsuranceRequired, monthlyFlood
    );

    // Apply additional seller credit to breakdown + total
    const {
      breakdown: finalClosingCostBreakdown,
      total: finalClosingCosts,
    } = applyAdditionalSellerCredit(closingCostBreakdown, closingCosts, additionalSellerCredit);

    const saved = storage.saveLoanEstimate({
      address, homePrice, downPaymentPercent, loanType,
      loanTerm: termYears, interestRate, propertyTax,
      hoaFee, homeInsurance, monthlyPayment: totalMonthly, closingCosts: finalClosingCosts,
    });

    res.json({
      id: saved.id,
      address, homePrice, downPaymentPercent, downPaymentAmount, loanAmount,
      loanType: rateInfo.label, loanTerm: termYears, interestRate, rateIsCustom,
      ufmip,          // FHA upfront MIP financed into loan (0 for non-FHA)
      vaFundingFee,   // VA funding fee financed into loan (0 for non-VA or exempt)
      vaFundingFeeOption: loanType === "va_30" ? vaFundingFeeOption : undefined,
      vaFundingFeeRate: loanType === "va_30" ? Math.round(vaFundingFeeRate * 10000) / 100 : undefined,
      pmiOverrideRate: pmiOverrideRate ? Math.round(pmiOverrideRate * 10000) / 100 : null,
      additionalSellerCredit: additionalSellerCredit > 0 ? additionalSellerCredit : undefined,
      monthlyBreakdown: {
        principalAndInterest: Math.round(monthlyPI * 100) / 100,
        propertyTax: Math.round(propertyTax * 100) / 100,
        homeInsurance: Math.round(homeInsurance * 100) / 100,
        flood: Math.round(monthlyFlood * 100) / 100,
        floodInsuranceRequired,
        hoa: hoaFee,
        mortgageInsurance: Math.round((monthlyPMI + monthlyMIP) * 100) / 100,
      },
      totalMonthlyPayment: Math.round(totalMonthly * 100) / 100,
      grossClosingCosts: Math.round(closingCosts),   // before any seller credit
      closingCosts: Math.round(finalClosingCosts),     // net (after seller credit)
      closingCostBreakdown: finalClosingCostBreakdown,
      totalCashNeeded: Math.round(downPaymentAmount + finalClosingCosts),
      escrowWaived: !includeEscrow,
      sellerPaysTitle,
      sellerTitleCredit,
      rateSource: "Mortgage News Daily — Daily National Average",
      insuranceNote: "Home insurance estimated at 0.8% of purchase price annually",
    });
  });

  app.get("/api/estimates/recent", (_req, res) => {
    res.json(storage.getRecentEstimates(5));
  });
}
