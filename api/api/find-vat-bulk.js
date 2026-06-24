// /api/find-vat-bulk.js
// Vercel serverless function. Expects POST { items: [{ supplierName, country }] }.
// Runs find-vat logic for each item sequentially (to respect Serper rate limits)
// and returns all results together.

const VAT_FORMATS = {
  AT: /\bATU\d{8}\b/i, BE: /\bBE0?\d{9,10}\b/i, BG: /\bBG\d{9,10}\b/i,
  CY: /\bCY\d{8}[A-Z]\b/i, CZ: /\bCZ\d{8,10}\b/i, DE: /\bDE\d{9}\b/i,
  DK: /\bDK\d{8}\b/i, EE: /\bEE\d{9}\b/i, EL: /\bEL\d{9}\b/i, GR: /\bGR\d{9}\b/i,
  ES: /\bES[A-Z0-9]\d{7}[A-Z0-9]\b/i, FI: /\bFI\d{8}\b/i, FR: /\bFR[A-Z0-9]{2}\d{9}\b/i,
  HR: /\bHR\d{11}\b/i, HU: /\bHU\d{8}\b/i, IE: /\bIE\d{7}[A-Z]{1,2}\b/i, IT: /\bIT\d{11}\b/i,
  LT: /\bLT(\d{9}|\d{12})\b/i, LU: /\bLU\d{8}\b/i, LV: /\bLV\d{11}\b/i, MT: /\bMT\d{8}\b/i,
  NL: /\bNL\d{9}B\d{2}\b/i, PL: /\bPL\d{10}\b/i, PT: /\bPT\d{9}\b/i, RO: /\bRO\d{2,10}\b/i,
  SE: /\bSE\d{12}\b/i, SI: /\bSI\d{8}\b/i, SK: /\bSK\d{10}\b/i, XI: /\bXI\d{9}\b/i,
};

function extractCandidatesFromText(text) {
  const found = [];
  if (!text) return found;
  for (const [cc, re] of Object.entries(VAT_FORMATS)) {
    const globalRe = new RegExp(re.source, re.flags.includes("g") ? re.flags : re.flags + "g");
    let m;
    while ((m = globalRe.exec(text)) !== null) {
      found.push({ countryCode: cc, raw: m[0].replace(/\s+/g, "").toUpperCase() });
    }
  }
  return found;
}

function sourceWeight(url) {
  if (!url) return 0.3;
  const u = url.toLowerCase();
  if (u.includes("ec.europa.eu") || u.includes("vies")) return 1.0;
  if (u.includes("handelsregister") || u.includes("companieshouse") || u.includes("infogreffe") || u.includes("sirene") || u.includes("insee") || u.includes("registre") || u.includes("northdata")) return 0.92;
  if (u.includes("impressum") || u.includes("imprint") || u.includes("legal-notice") || u.includes("mentions-legales") || u.includes("legal-information")) return 0.88;
  if (u.includes("opencorporates") || u.includes("bloomberg") || u.includes("dnb.com") || u.includes("creditsafe")) return 0.65;
  if (u.includes("kompass") || u.includes("europages") || u.includes("yelp") || u.includes("crunchbase") || u.includes("linkedin")) return 0.45;
  return 0.4;
}

async function callSerper(query, apiKey) {
  const resp = await fetch("https://google.serper.dev/search", {
    method: "POST",
    headers: { "X-API-KEY": apiKey, "Content-Type": "application/json" },
    body: JSON.stringify({ q: query, num: 10 }),
  });
  if (!resp.ok) throw new Error(`Serper API error: HTTP ${resp.status}`);
  return resp.json();
}

async function findVatForOne(supplierName, country, apiKey) {
  const name = supplierName.trim();
  const countryHint = country ? ` ${country}` : "";
  const queries = [
    `"${name}"${countryHint} impressum OR "mentions legales" OR "legal notice" VAT`,
    `"${name}"${countryHint} "VAT" OR "USt-IdNr" OR "TVA" OR "Partita IVA" OR "NIF"`,
  ];

  let allResults = [];
  for (const q of queries) {
    try {
      const data = await callSerper(q, apiKey);
      allResults = allResults.concat((data.organic || []));
    } catch (e) {
      // continue with whatever we have
    }
  }

  const seenUrls = new Set();
  allResults = allResults.filter((r) => {
    if (!r.link || seenUrls.has(r.link)) return false;
    seenUrls.add(r.link);
    return true;
  });

  const candidateMap = new Map();
  for (const r of allResults) {
    const text = `${r.title || ""} ${r.snippet || ""}`;
    const found = extractCandidatesFromText(text);
    for (const f of found) {
      const key = f.countryCode + f.raw;
      if (!candidateMap.has(key)) candidateMap.set(key, { countryCode: f.countryCode, vatNumber: f.raw, sources: [] });
      candidateMap.get(key).sources.push({ url: r.link, title: r.title, snippet: r.snippet });
    }
  }

  const candidates = Array.from(candidateMap.values()).map((c) => {
    const formatOk = VAT_FORMATS[c.countryCode] ? VAT_FORMATS[c.countryCode].test(c.vatNumber) : false;
    const bestSource = c.sources.reduce((best, s) => {
      const w = sourceWeight(s.url);
      return !best || w > best.w ? { ...s, w } : best;
    }, null);
    let confidence = Math.round(((bestSource ? bestSource.w : 0.3) * 0.7 + (formatOk ? 0.3 : 0)) * 100);
    confidence = Math.max(5, Math.min(97, confidence));
    return {
      vatNumber: c.vatNumber,
      countryCode: c.countryCode,
      formatOk,
      confidence,
      sourceUrl: bestSource ? bestSource.url : "",
      sourceType: bestSource && bestSource.url
        ? (bestSource.url.includes("impressum") || bestSource.url.includes("legal") || bestSource.url.includes("mentions") ? "company imprint page"
            : (bestSource.url.includes("handelsregister") || bestSource.url.includes("sirene") || bestSource.url.includes("northdata") ? "business registry" : "directory"))
        : "other",
      evidence: bestSource ? (bestSource.snippet || bestSource.title || "").slice(0, 200) : "",
    };
  });

  candidates.sort((a, b) => b.confidence - a.confidence);
  return candidates;
}

export default async function handler(req, res) {
  if (req.method !== "POST") {
    res.status(405).json({ error: "Method not allowed" });
    return;
  }

  const apiKey = process.env.SERPER_API_KEY;
  if (!apiKey) {
    res.status(500).json({ error: "Server misconfigured: SERPER_API_KEY is not set." });
    return;
  }

  const { items } = req.body || {};
  if (!Array.isArray(items) || items.length === 0) {
    res.status(400).json({ error: "items array is required." });
    return;
  }
  if (items.length > 50) {
    res.status(400).json({ error: "Max 50 suppliers per bulk request." });
    return;
  }

  const results = [];
  for (const item of items) {
    const supplierName = (item.supplierName || item.name || "").trim();
    const country = item.country || "";
    if (!supplierName) continue;
    try {
      const candidates = await findVatForOne(supplierName, country, apiKey);
      results.push({ supplierName, country, candidates, error: null });
    } catch (e) {
      results.push({ supplierName, country, candidates: [], error: e.message });
    }
  }

  res.status(200).json({ results });
}
