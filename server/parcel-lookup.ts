/**
 * County Property Appraiser Parcel Lookup
 *
 * For each supported county, this module:
 * 1. Searches the county's address API to resolve an address → parcel ID
 * 2. Builds a direct deep-link URL to the specific parcel record
 * 3. Fetches the parcel detail page to extract assessed value
 * 4. Calculates the actual annual tax from assessed value × millage rate
 *
 * This mirrors what Zillow does when it links directly to a county appraiser parcel page.
 */

import axios from "axios";

export interface ParcelResult {
  parcelId: string | null;
  parcelUrl: string | null;         // Direct deep link to the specific parcel
  assessedValue: number | null;     // Most recent assessed value ($)
  annualTax: number | null;         // Calculated annual tax ($)
  monthlyTax: number | null;        // annualTax / 12
  taxYear: number | null;
  floodZone: string | null;         // FEMA flood zone designation (if available from county)
  source: string;
}

const BROWSER_HEADERS = {
  "User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/123.0.0.0 Safari/537.36",
  "Accept": "text/html,application/xhtml+xml,*/*;q=0.8",
  "Accept-Language": "en-US,en;q=0.9",
};

const JSON_HEADERS = {
  ...BROWSER_HEADERS,
  "Accept": "application/json, text/javascript, */*; q=0.01",
  "X-Requested-With": "XMLHttpRequest",
};

// ─── Helper: parse dollar amount from string ─────────────────────────────────

function parseDollar(s: string): number | null {
  const m = s.replace(/[$,\s]/g, "").match(/^(\d+\.?\d*)$/);
  return m ? parseFloat(m[1]) : null;
}

// ─── Sarasota County (sc-pa.com) ─────────────────────────────────────────────
// API: GET /propertysearch/api/srch/ListAddresses?term={query}
// Returns: [{ Value: "4549 MCINTOSH LN SARASOTA, 34232", Category: "SITUS" }]
// Parcel page: /propertysearch/parcel/details/{strapId}
// Millage rate: ~0.84% effective (Sarasota County 2025)

async function lookupSarasota(address: string): Promise<ParcelResult> {
  try {
    const streetPart = address.split(",")[0].trim();
    const suggestRes = await axios.get(
      `https://www.sc-pa.com/propertysearch/api/srch/ListAddresses?term=${encodeURIComponent(streetPart)}`,
      { headers: { ...JSON_HEADERS, "Referer": "https://www.sc-pa.com/propertysearch" }, timeout: 8000 }
    );

    const suggestions: Array<{ Value: string; Category: string }> = suggestRes.data ?? [];
    if (!suggestions.length) return { parcelId: null, parcelUrl: null, assessedValue: null, annualTax: null, monthlyTax: null, taxYear: null, source: "sarasota" };

    // POST to get parcel redirect
    const postRes = await axios.post(
      "https://www.sc-pa.com/propertysearch/Result",
      `AddressKeywords=${encodeURIComponent(streetPart)}&search=Address`,
      {
        headers: {
          ...BROWSER_HEADERS,
          "Content-Type": "application/x-www-form-urlencoded",
          "Referer": "https://www.sc-pa.com/propertysearch",
        },
        maxRedirects: 0,
        timeout: 8000,
        validateStatus: (s) => s < 400,
      }
    );

    // Extract parcel ID from redirect Location header
    const location = postRes.headers["location"] ?? "";
    const parcelMatch = location.match(/\/parcel\/details\/(\d+)/);
    if (!parcelMatch) return { parcelId: null, parcelUrl: null, assessedValue: null, annualTax: null, monthlyTax: null, taxYear: null, source: "sarasota" };

    const parcelId = parcelMatch[1];
    const parcelUrl = `https://www.sc-pa.com/propertysearch/parcel/${parcelId}`;

    // Fetch parcel page to extract assessed value
    const detailRes = await axios.get(
      `https://www.sc-pa.com/propertysearch/parcel/details/${parcelId}`,
      { headers: { ...BROWSER_HEADERS, "Referer": "https://www.sc-pa.com/propertysearch" }, timeout: 8000 }
    );

    const html: string = detailRes.data;

    // Extract most recent assessed/just value from the values table
    // Pattern: "Just <amount> Assessed <amount>"
    const justMatch = html.match(/Just\s+Assessed[^<]*<\/th>[\s\S]{0,200}?>\s*\$?([\d,]+)/i) ??
                      html.match(/\$\s*([\d,]+)\s*<\/td>\s*<td[^>]*>\s*\$\s*([\d,]+)\s*<\/td>\s*<td[^>]*>\s*\$\s*0/i);
    
    // More targeted: find the first dollar amount after "Just" in the values grid
    const yearSection = html.match(/2025[^<]*<\/td>([\s\S]{0,500}?)<\/tr>/);
    let assessedValue: number | null = null;
    let taxYear = 2025;

    if (yearSection) {
      const cells = yearSection[1].match(/\$([\d,]+)/g) ?? [];
      // Cells in order: Land, Building, Extra Features, Just Value, Assessed, Exemptions, Taxable
      if (cells.length >= 4) {
        assessedValue = parseDollar(cells[3]); // Just Value (index 3)
      }
    }

    if (!assessedValue) {
      // Fallback: find $NNN,NNN pattern near "257" or large numbers
      const amounts = html.match(/\$([\d]{3},[\d]{3})/g);
      if (amounts?.length) {
        const values = amounts.map(a => parseDollar(a)).filter(v => v && v > 50000) as number[];
        if (values.length) assessedValue = values[0];
      }
    }

    const SARASOTA_EFFECTIVE_RATE = 0.0084; // 0.84% effective — Sarasota County 2025
    const annualTax = assessedValue ? Math.round(assessedValue * SARASOTA_EFFECTIVE_RATE) : null;

    return {
      parcelId,
      parcelUrl,
      assessedValue,
      annualTax,
      monthlyTax: annualTax ? Math.round(annualTax / 12) : null,
      taxYear,
      source: "Sarasota County Property Appraiser",
    };
  } catch (err) {
    console.error("Sarasota lookup error:", (err as any)?.message);
    return { parcelId: null, parcelUrl: null, assessedValue: null, annualTax: null, monthlyTax: null, taxYear: null, floodZone: null, source: "sarasota" };
  }
}

// ─── Charlotte County (ccappraiser.com) ──────────────────────────────────────
// Autocomplete: GET /taxestimator/TaxEstimators/PADSearch?term={query}
// Returns: [{pid: "402207429001", pad: "ADDRESS FL ZIP"}]
// Parcel page: /Show_Parcel.asp?acct={pid}&gen=T&tax=T&bld=T&oth=T&sal=T&lnd=T&leg=T
// Flood zone: YES — HTML table with caption "FEMA Flood Zone"
// Effective millage rate: ~1.005% for non-homestead (Charlotte County 2025 published millage: ~10.05 mills)
// Note: 0.87% is the county-wide average including homestead exemptions; new buyers pay ~1.005%

async function lookupCharlotte(address: string): Promise<ParcelResult> {
  try {
    const streetPart = address.split(",")[0].trim();

    // Step 1: autocomplete to get PID
    const suggestRes = await axios.get(
      `https://www.ccappraiser.com/taxestimator/TaxEstimators/PADSearch?term=${encodeURIComponent(streetPart)}`,
      {
        headers: { ...JSON_HEADERS, "Referer": "https://www.ccappraiser.com" },
        timeout: 8000,
      }
    );

    const allSuggestions: Array<{ pid: string; pad: string }> = suggestRes.data ?? [];
    // Filter out empty PIDs ("No matches found", "N records found" messages)
    const suggestions = allSuggestions.filter(s => s.pid && s.pid.trim().length > 0);
    if (!suggestions.length) {
      return { parcelId: null, parcelUrl: null, assessedValue: null, annualTax: null, monthlyTax: null, taxYear: null, floodZone: null, source: "charlotte" };
    }

    const { pid } = suggestions[0];
    const parcelUrl = `https://www.ccappraiser.com/Show_Parcel.asp?acct=${pid}&gen=T&tax=T&bld=T&oth=T&sal=T&lnd=T&leg=T`;

    // Step 2: fetch parcel detail page
    const detailRes = await axios.get(parcelUrl, {
      headers: { ...BROWSER_HEADERS, "Referer": "https://www.ccappraiser.com" },
      timeout: 10000,
    });

    const html: string = detailRes.data;
    let assessedValue: number | null = null;
    let floodZone: string | null = null;
    const taxYear = 2025;

    // Extract Just Value from Charlotte County page
    // Pattern: find "Just Value" then grab the first $NNN,NNN that follows
    const justIdx = html.search(/Just\s+Value/i);
    if (justIdx >= 0) {
      const chunk = html.slice(justIdx, justIdx + 600);
      const m = chunk.match(/\$([0-9,]+)/);
      if (m) assessedValue = parseDollar(m[1]);
    }

    // Extract FEMA Flood Zone
    // The page has a table with caption containing "FEMA Flood Zone"
    const floodSectionMatch = html.match(/FEMA\s+Flood\s+Zone[\s\S]{0,2000}?<\/table>/i);
    if (floodSectionMatch) {
      // Look for flood zone code — FEMA codes are uppercase letters like X, AE, VE, AH, AO, etc.
      // Pattern: a table cell containing a zone code (1-3 uppercase letters, optionally followed by " Zone")
      const zoneMatch = floodSectionMatch[0].match(/<td[^>]*>\s*([A-Za-z]{1,3}(?:\s+Zone)?)\s*<\/td>/i);
      if (zoneMatch) {
        const raw = zoneMatch[1].trim().toUpperCase();
        // raw is now like "X", "AE", "VE", "X ZONE"
        floodZone = raw.endsWith("ZONE") ? raw : `${raw} Zone`;
        // Fix casing: "AE Zone" not "AE ZONE"
        floodZone = floodZone.replace(/ZONE$/i, "Zone");
      }
    }
    // Also try simpler pattern: look for known FEMA zone codes after keyword
    if (!floodZone) {
      const simpleMatch = html.match(/Flood\s+Zone[\s\S]{0,200}?\b([AVX][A-Z0-9]{0,2})\b/i);
      if (simpleMatch) {
        const code = simpleMatch[1].toUpperCase();
        // Only accept known FEMA zone prefixes
        if (/^(A[A-Z0-9]?|AE|AH|AO|AR|VE?|X|D)/.test(code)) {
          floodZone = `${code} Zone`;
        }
      }
    }

    // Use non-homestead millage rate — new buyers have no homestead exemption in year of purchase
    // Charlotte County 2025 published total millage ~10.05 mills = 1.005%
    const CHARLOTTE_EFFECTIVE_RATE = 0.01005;
    const annualTax = assessedValue ? Math.round(assessedValue * CHARLOTTE_EFFECTIVE_RATE) : null;

    return {
      parcelId: pid,
      parcelUrl,
      assessedValue,
      annualTax,
      monthlyTax: annualTax ? Math.round(annualTax / 12) : null,
      taxYear,
      floodZone,
      source: "Charlotte County Property Appraiser",
    };
  } catch (err) {
    console.error("Charlotte lookup error:", (err as any)?.message);
    return { parcelId: null, parcelUrl: null, assessedValue: null, annualTax: null, monthlyTax: null, taxYear: null, floodZone: null, source: "charlotte" };
  }
}

// ─── Palm Beach County (pbcpao.gov) ──────────────────────────────────────────
// Autocomplete: POST /AutoComplete/SearchAutoComplete
//   body: propertyType=RE&searchText={address}
//   returns: [{text: "456 S Ocean Blvd, Palm Beach", pcn: "P:50434326010020011"}]
// Tax JSON: GET /Property/GetTaxDetails?parcelId={PCN}
// Parcel page: /Property/Summary/Details/{PCN-with-dashes}
// Effective rate: ~1.00% (Palm Beach County 2025)

function formatPalmBeachPCN(raw: string): string {
  // Strip "P:" prefix if present, remove any existing dashes, then reformat
  const digits = raw.replace(/^P:/i, "").replace(/-/g, "");
  // Format: 17-digit → XX-XX-XX-XX-XX-XXX-XXXX (2-2-2-2-2-3-4)
  if (digits.length >= 14) {
    return [
      digits.slice(0, 2),
      digits.slice(2, 4),
      digits.slice(4, 6),
      digits.slice(6, 8),
      digits.slice(8, 10),
      digits.slice(10, 13),
      digits.slice(13),
    ].join("-");
  }
  return digits;
}

async function lookupPalmBeach(address: string): Promise<ParcelResult> {
  try {
    const streetPart = address.split(",")[0].trim();

    // Step 1: POST autocomplete to get PCN
    const autoRes = await axios.post(
      "https://pbcpao.gov/AutoComplete/SearchAutoComplete",
      `propertyType=RE&searchText=${encodeURIComponent(streetPart)}`,
      {
        headers: {
          ...BROWSER_HEADERS,
          "Content-Type": "application/x-www-form-urlencoded",
          "Referer": "https://pbcpao.gov",
          "Accept": "application/json, text/javascript, */*; q=0.01",
          "X-Requested-With": "XMLHttpRequest",
        },
        timeout: 8000,
      }
    );

    const results: Array<{ text?: string; pcn?: string }> = Array.isArray(autoRes.data)
      ? autoRes.data
      : (autoRes.data?.results ?? []);

    if (!results.length) {
      // Fall back to GET search
      return {
        parcelId: null,
        parcelUrl: `https://pbcpao.gov/MasterSearch/SearchResults?propertyType=RE&searchvalue=${encodeURIComponent(streetPart)}`,
        assessedValue: null, annualTax: null, monthlyTax: null, taxYear: null, floodZone: null,
        source: "Palm Beach County Property Appraiser",
      };
    }

    const rawPcn = results[0].pcn ?? "";
    let pcnDigits = rawPcn.replace(/^P:/i, "").replace(/-/g, "");

    // If PCN is a short alias (e.g. "R400232"), resolve the real 17-digit PCN
    // by fetching the Details page — the full PCN appears in the HTML
    if (/^[A-Z]\d+$/i.test(pcnDigits) || pcnDigits.length < 14) {
      try {
        const resolveRes = await axios.get(
          `https://pbcpao.gov/Property/Details?parcelId=${encodeURIComponent(pcnDigits)}`,
          { headers: { ...BROWSER_HEADERS, "Referer": "https://pbcpao.gov" }, timeout: 8000 }
        );
        const resolveHtml: string = resolveRes.data;
        // Full PCN appears as 17-digit number in parcelId= params
        const fullPcnMatch = resolveHtml.match(/parcelId=([0-9]{14,18})/i)
          ?? resolveHtml.match(/([0-9]{2}-[0-9]{2}-[0-9]{2}-[0-9]{2}-[0-9]{2}-[0-9]{3}-[0-9]{4})/);
        if (fullPcnMatch) {
          pcnDigits = fullPcnMatch[1].replace(/-/g, "");
        }
      } catch (resolveErr) {
        console.error("Palm Beach PCN resolve error:", (resolveErr as any)?.message);
      }
    }

    const pcnDashed = formatPalmBeachPCN("P:" + pcnDigits);
    // Use Property/Details?parcelId= (digits, no dashes) — the Summary/Details path returns 404
    const parcelUrl = pcnDigits.length >= 14
      ? `https://pbcpao.gov/Property/Details?parcelId=${pcnDigits}`
      : `https://pbcpao.gov/MasterSearch/SearchResults?propertyType=RE&searchvalue=${encodeURIComponent(streetPart)}`;

    // Step 2: GET tax details JSON
    let assessedValue: number | null = null;
    let annualTax: number | null = null;
    const taxYear = 2025;

    try {
      const taxRes = await axios.get(
        `https://pbcpao.gov/Property/GetTaxDetails?parcelId=${pcnDigits}`,
        {
          headers: { ...JSON_HEADERS, "Referer": "https://pbcpao.gov" },
          timeout: 8000,
        }
      );
      const taxData = taxRes.data;
      // Response: {Alist: [{TaxType, Description, TaxAmount, TaxableValue, TaxRate}, ...]}
      const alist: Array<{ TaxableValue?: string; TaxAmount?: string; TaxRate?: string }> =
        taxData?.Alist ?? [];
      if (alist.length) {
        // Sum all TaxAmount — field may be a number or a string like "$1,234.56"
        const total = alist.reduce((sum: number, item) => {
          const raw = item.TaxAmount;
          const amt = typeof raw === "number"
            ? raw
            : parseFloat(String(raw ?? "0").replace(/[$,]/g, ""));
          return sum + (isNaN(amt) ? 0 : amt);
        }, 0);
        if (total > 0) annualTax = Math.round(total);

        // TaxableValue is a plain integer string like "815560" (no $ or commas)
        const taxableRaw = alist[0].TaxableValue;
        const taxable = typeof taxableRaw === "number"
          ? taxableRaw
          : parseFloat(String(taxableRaw ?? "").replace(/[$,]/g, ""));
        if (taxable && taxable > 0) assessedValue = taxable;
      }
    } catch (taxErr) {
      console.error("Palm Beach tax details error:", (taxErr as any)?.message);
      // Fall through — use effective rate estimate
    }

    // If we have assessed value but no actual tax, estimate with effective rate
    if (assessedValue && !annualTax) {
      const PALM_BEACH_EFFECTIVE_RATE = 0.010;
      annualTax = Math.round(assessedValue * PALM_BEACH_EFFECTIVE_RATE);
    }

    return {
      parcelId: pcnDigits.length >= 14 ? pcnDashed : pcnDigits, // display dashed format
      parcelUrl,
      assessedValue,
      annualTax,
      monthlyTax: annualTax ? Math.round(annualTax / 12) : null,
      taxYear,
      floodZone: null, // not available from pbcpao
      source: "Palm Beach County Property Appraiser",
    };
  } catch (err) {
    console.error("Palm Beach lookup error:", (err as any)?.message);
    return { parcelId: null, parcelUrl: null, assessedValue: null, annualTax: null, monthlyTax: null, taxYear: null, floodZone: null, source: "palm beach" };
  }
}

// ─── Broward County (bcpa.net / web.bcpa.net) ─────────────────────────────────
// Address search: POST https://bcpa.net/RecSearch.asp
//   body: Situs_Street_Number={num}&Situs_Street_Direction={dir}&Situs_Street_Name={name}&Situs_Street_Type={type}
//   Response redirects to: RecInfo.asp?URL_Folio={12-digit-folio}
// Parcel JSON: POST https://web.bcpa.net/BcpaClient/search.aspx/getParcelInformation
//   body: {folioNumber, taxyear: "2025", action: "CURRENT", use: ""}
//   Returns: {d: {parcelInfok__BackingField: [{justValue, ...}]}}
// Direct parcel: https://web.bcpa.net/BcpaClient/#/Record-Search/results?account={folio}
// Effective rate: ~1.07% (Broward County 2025)

function parseBrowardAddress(streetPart: string): { houseNum: string; direction: string; streetName: string; streetType: string } {
  // Normalize spelled-out compass directions and street types
  let normalized = streetPart
    .replace(/\bNorth\b/gi, "N").replace(/\bSouth\b/gi, "S")
    .replace(/\bEast\b/gi, "E").replace(/\bWest\b/gi, "W")
    .replace(/\bNortheast\b/gi, "NE").replace(/\bNorthwest\b/gi, "NW")
    .replace(/\bSoutheast\b/gi, "SE").replace(/\bSouthwest\b/gi, "SW")
    .replace(/\bStreet\b/gi, "ST").replace(/\bAvenue\b/gi, "AVE")
    .replace(/\bBoulevard\b/gi, "BLVD").replace(/\bDrive\b/gi, "DR")
    .replace(/\bLane\b/gi, "LN").replace(/\bRoad\b/gi, "RD")
    .replace(/\bCourt\b/gi, "CT").replace(/\bPlace\b/gi, "PL")
    .replace(/\bCircle\b/gi, "CIR").replace(/\bTrail\b/gi, "TRL")
    .replace(/\bTerrace\b/gi, "TER").replace(/\bParkway\b/gi, "PKWY")
    .replace(/\bHighway\b/gi, "HWY")
    .replace(/(\d+)(st|nd|rd|th)\b/gi, "$1"); // remove ordinal suffixes: 40th -> 40
  normalized = normalized.toUpperCase().trim();

  // Match: number [optional direction] name [optional type]
  const m = normalized.match(/^(\d+)\s+(?:(N|S|E|W|NE|NW|SE|SW)\s+)?(.+?)(?:\s+(ST|AVE|BLVD|DR|LN|RD|CT|WAY|PL|CIR|TRL|TER|PKWY|HWY))?\s*$/);
  if (!m) return { houseNum: "", direction: "", streetName: normalized, streetType: "" };
  return {
    houseNum: m[1],
    direction: m[2] ?? "",
    streetName: m[3],
    streetType: m[4] ?? "",
  };
}

async function lookupBroward(address: string): Promise<ParcelResult> {
  try {
    const streetPart = address.split(",")[0].trim();
    const { houseNum, direction, streetName, streetType } = parseBrowardAddress(streetPart);

    if (!houseNum) {
      return { parcelId: null, parcelUrl: "https://web.bcpa.net/BcpaClient/#/Record-Search", assessedValue: null, annualTax: null, monthlyTax: null, taxYear: null, floodZone: null, source: "broward" };
    }

    // Step 1: POST to RecSearch.asp — redirects to RecInfo.asp?URL_Folio={folio}
    const searchRes = await axios.post(
      "https://bcpa.net/RecSearch.asp",
      `Situs_Street_Number=${encodeURIComponent(houseNum)}&Situs_Street_Direction=${encodeURIComponent(direction)}&Situs_Street_Name=${encodeURIComponent(streetName)}&Situs_Street_Type=${encodeURIComponent(streetType)}&Situs_City=&Situs_Zip=`,
      {
        headers: {
          ...BROWSER_HEADERS,
          "Content-Type": "application/x-www-form-urlencoded",
          "Referer": "https://bcpa.net/RecAddr.asp",
        },
        maxRedirects: 0,
        validateStatus: (s) => s < 400,
        timeout: 10000,
      }
    );

    // Response body is HTML with redirect: <a HREF="RecInfo.asp?URL_Folio=514230071470">
    const html: string = searchRes.data ?? "";
    const folioMatch = html.match(/URL_Folio=(\d{10,14})/i);
    let folioNumber: string | null = folioMatch ? folioMatch[1] : null;

    // Also check Location header in case of actual HTTP redirect
    if (!folioNumber) {
      const location: string = searchRes.headers["location"] ?? "";
      const locMatch = location.match(/URL_Folio=(\d{10,14})/i);
      if (locMatch) folioNumber = locMatch[1];
    }

    if (!folioNumber) {
      return {
        parcelId: null,
        parcelUrl: "https://web.bcpa.net/BcpaClient/#/Record-Search",
        assessedValue: null, annualTax: null, monthlyTax: null, taxYear: null, floodZone: null,
        source: "Broward County Property Appraiser",
      };
    }

    const parcelUrl = `https://web.bcpa.net/BcpaClient/#/Record-Search/results?account=${folioNumber}`;

    // Step 2: try the JSON API to get assessed value and tax
    let assessedValue: number | null = null;
    let annualTax: number | null = null;
    const taxYear = 2025;

    try {
      const apiRes = await axios.post(
        "https://web.bcpa.net/BcpaClient/search.aspx/getParcelInformation",
        JSON.stringify({ folioNumber, taxyear: "2025", action: "CURRENT", use: "" }),
        {
          headers: {
            ...BROWSER_HEADERS,
            "Content-Type": "application/json; charset=utf-8",
            "Accept": "application/json, text/javascript, */*; q=0.01",
            "X-Requested-With": "XMLHttpRequest",
            "Referer": "https://web.bcpa.net/BcpaClient/",
          },
          timeout: 8000,
        }
      );

      // Response: {d: {parcelInfok__BackingField: [{justValue, taxableAmountCounty, ...}]}}
      const parcelInfo: Array<{ justValue?: string; taxableAmountCounty?: string }> =
        apiRes.data?.d?.parcelInfok__BackingField ?? [];

      if (parcelInfo.length) {
        const p = parcelInfo[0];
        // justValue is like "$343,650"
        const just = parseDollar(p.justValue ?? "");
        const taxable = parseDollar(p.taxableAmountCounty ?? "");
        if (just && just > 0) assessedValue = just;
        else if (taxable && taxable > 0) assessedValue = taxable;
      }
    } catch (apiErr) {
      console.error("Broward API error:", (apiErr as any)?.message);
      // Fall through — estimated below
    }

    // Estimate annual tax from assessed value if we got it
    if (assessedValue) {
      const BROWARD_EFFECTIVE_RATE = 0.0107;
      annualTax = Math.round(assessedValue * BROWARD_EFFECTIVE_RATE);
    }

    return {
      parcelId: folioNumber,
      parcelUrl,
      assessedValue,
      annualTax,
      monthlyTax: annualTax ? Math.round(annualTax / 12) : null,
      taxYear,
      floodZone: null, // not available from bcpa
      source: "Broward County Property Appraiser",
    };
  } catch (err) {
    console.error("Broward lookup error:", (err as any)?.message);
    return { parcelId: null, parcelUrl: "https://web.bcpa.net/BcpaClient/#/Record-Search", assessedValue: null, annualTax: null, monthlyTax: null, taxYear: null, floodZone: null, source: "broward" };
  }
}

// ─── Miami-Dade County (miamidadepa.gov) ─────────────────────────────────────

async function lookupMiamiDade(address: string): Promise<ParcelResult> {
  try {
    const streetPart = address.split(",").slice(0, 2).join(" ").trim();
    const searchUrl = `https://apps.miamidadepa.gov/PropertySearch/#/?address=${encodeURIComponent(streetPart)}`;
    return {
      parcelId: null,
      parcelUrl: searchUrl,
      assessedValue: null, annualTax: null, monthlyTax: null, taxYear: null, floodZone: null,
      source: "Miami-Dade County Property Appraiser",
    };
  } catch {
    return { parcelId: null, parcelUrl: null, assessedValue: null, annualTax: null, monthlyTax: null, taxYear: null, floodZone: null, source: "miami-dade" };
  }
}

// ─── Hillsborough County (hcpafl.org) ────────────────────────────────────────

async function lookupHillsborough(address: string): Promise<ParcelResult> {
  const streetPart = address.split(",")[0].trim();
  return {
    parcelId: null,
    parcelUrl: `https://gis.hcpafl.org/propertysearch/#/search/basic/address=${encodeURIComponent(streetPart)}`,
    assessedValue: null, annualTax: null, monthlyTax: null, taxYear: null, floodZone: null,
    source: "Hillsborough County Property Appraiser",
  };
}

// ─── Pinellas County (pcpao.gov) ─────────────────────────────────────────────

async function lookupPinellas(address: string): Promise<ParcelResult> {
  const streetPart = address.split(",").slice(0, 2).join(",").trim();
  return {
    parcelId: null,
    parcelUrl: `https://www.pcpao.gov/quick-search?qu=1&input=${encodeURIComponent(streetPart)}&search_option=address`,
    assessedValue: null, annualTax: null, monthlyTax: null, taxYear: null, floodZone: null,
    source: "Pinellas County Property Appraiser",
  };
}

// ─── Main dispatcher ──────────────────────────────────────────────────────────

const COUNTY_LOOKUP_MAP: Record<string, (address: string) => Promise<ParcelResult>> = {
  "Sarasota County, FL":    lookupSarasota,
  "Charlotte County, FL":   lookupCharlotte,
  "Palm Beach County, FL":  lookupPalmBeach,
  "Broward County, FL":     lookupBroward,
  "Miami-Dade County, FL":  lookupMiamiDade,
  "Hillsborough County, FL": lookupHillsborough,
  "Pinellas County, FL":    lookupPinellas,
};

export async function lookupParcel(
  address: string,
  county: string,
  stateCode: string
): Promise<ParcelResult> {
  const key = `${county}, ${stateCode.toUpperCase()}`;
  const handler = COUNTY_LOOKUP_MAP[key];
  if (handler) {
    return handler(address);
  }
  return { parcelId: null, parcelUrl: null, assessedValue: null, annualTax: null, monthlyTax: null, taxYear: null, floodZone: null, source: "unsupported" };
}
