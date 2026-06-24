// /api/check-vies.js
// Vercel serverless function. Expects POST { vatNumber }.
// Calls VATcomply server-side (avoids any browser CORS concerns entirely)
// which itself validates against the official EU VIES service.

export default async function handler(req, res) {
  if (req.method !== "POST") {
    res.status(405).json({ error: "Method not allowed" });
    return;
  }

  const { vatNumber } = req.body || {};
  if (!vatNumber || typeof vatNumber !== "string" || !vatNumber.trim()) {
    res.status(400).json({ error: "vatNumber is required." });
    return;
  }

  const clean = vatNumber.trim().replace(/\s+/g, "").toUpperCase();

  try {
    const resp = await fetch(`https://api.vatcomply.com/vat?vat_number=${encodeURIComponent(clean)}`);
    const data = await resp.json().catch(() => null);

    if (!resp.ok || !data) {
      res.status(200).json({
        status: "error",
        message: (data && data.error) || `Validator returned HTTP ${resp.status}`,
      });
      return;
    }

    if (data.error) {
      res.status(200).json({ status: "error", message: data.error });
      return;
    }

    res.status(200).json({
      status: data.valid ? "valid" : "invalid",
      name: data.name || "",
      address: data.address || "",
      countryCode: data.country_code || clean.slice(0, 2),
      vatNumber: clean,
    });
  } catch (e) {
    res.status(200).json({
      status: "unreachable",
      message: "Could not reach the validation service. Try again shortly, or check manually at the official VIES page.",
    });
  }
}
