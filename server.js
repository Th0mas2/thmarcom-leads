const express = require("express");
const cors = require("cors");
const path = require("path");

const app = express();
app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, "public")));

const APIFY_TOKEN = process.env.APIFY_TOKEN;
const ANTHROPIC_KEY = process.env.ANTHROPIC_API_KEY;

// ── 1. Start Apify Google Maps scraper ────────────────────────────────────────
app.post("/api/scrape", async (req, res) => {
  const { sector, provincie, aantalLeads } = req.body;

  // Build search queries: e.g. "schildersbedrijf Tilburg"
  const steden = {
    "Noord-Brabant": ["Tilburg","Eindhoven","Breda","Den Bosch","Helmond","Oss","Waalwijk","Veghel"],
    "Gelderland":    ["Nijmegen","Arnhem","Apeldoorn","Ede","Doetinchem","Tiel","Zutphen"],
    "Zuid-Holland":  ["Rotterdam","Dordrecht","Delft","Gorinchem","Schiedam","Vlaardingen","Leiden"],
    "Utrecht":       ["Utrecht","Amersfoort","Nieuwegein","Veenendaal","Zeist","Houten"],
    "Alle provincies":["Tilburg","Nijmegen","Rotterdam","Utrecht","Eindhoven","Breda","Arnhem","Amersfoort"],
  };

  const statenLijst = steden[provincie] || steden["Alle provincies"];
  const searchQueries = statenLijst.slice(0, 5).map(stad => `${sector} ${stad} Nederland`);

  try {
    // Start the Apify actor run
    const startRes = await fetch(
      "https://api.apify.com/v2/acts/compass~crawler-google-places/runs?token=" + APIFY_TOKEN,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          searchStringsArray: searchQueries,
          maxCrawledPlacesPerSearch: Math.ceil(aantalLeads / searchQueries.length),
          language: "nl",
          countryCode: "nl",
          includeWebResults: false,
          maxReviews: 0,
          exportPlaceUrls: false,
        }),
      }
    );

    if (!startRes.ok) {
      const err = await startRes.text();
      return res.status(500).json({ error: "Apify start mislukt: " + err });
    }

    const runData = await startRes.json();
    const runId = runData.data?.id;
    res.json({ runId, status: "started" });

  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ── 2. Poll Apify run status ───────────────────────────────────────────────────
app.get("/api/status/:runId", async (req, res) => {
  const { runId } = req.params;
  try {
    const r = await fetch(
      `https://api.apify.com/v2/actor-runs/${runId}?token=${APIFY_TOKEN}`
    );
    const data = await r.json();
    res.json({
      status: data.data?.status,        // RUNNING / SUCCEEDED / FAILED
      itemCount: data.data?.stats?.itemCount || 0,
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ── 3. Fetch results from Apify dataset ───────────────────────────────────────
app.get("/api/results/:runId", async (req, res) => {
  const { runId } = req.params;
  const limit = req.query.limit || 100;
  try {
    const r = await fetch(
      `https://api.apify.com/v2/actor-runs/${runId}/dataset/items?token=${APIFY_TOKEN}&limit=${limit}&format=json`
    );
    const items = await r.json();

    // Normalize Apify Google Maps output to our lead format
    const leads = (Array.isArray(items) ? items : []).map((place, i) => ({
      id: `lead_${i}_${Date.now()}`,
      bedrijfsnaam: place.title || place.name || "Onbekend",
      sector: req.query.sector || "",
      plaats: place.city || place.address?.split(",").pop()?.trim() || "",
      provincie: req.query.provincie || "",
      website: place.website || "",
      email: place.email || "",
      telefoon: place.phone || place.phoneUnformatted || "",
      contactpersoon: "",
      linkedin: place.linkedIn || "",
      instagram: place.instagram || "",
      googleMaps: place.url || `https://maps.google.com/?q=${encodeURIComponent(place.title || "")}`,
      googleReviews: place.reviewsCount || 0,
      googleRating: place.totalScore || 0,
      aantalVolgers: 0,
      dagenSindsPost: 999,
      aantalMedewerkers: 0,
      websiteJaar: 0,
      heeftBlog: false,
      heeftSSL: place.website?.startsWith("https") || false,
      lighthouseScore: 0,
      adres: place.address || "",
    }));

    res.json(leads);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ── 4. Score one lead with Claude AI ─────────────────────────────────────────
app.post("/api/score", async (req, res) => {
  const lead = req.body;

  const prompt = `Je bent een marketing expert die Nederlandse MKB-bedrijven beoordeelt als potentiële klant voor marketingbureau THMarcom.

Beoordeel deze lead en geef een JSON response:

Bedrijf: ${lead.bedrijfsnaam}
Sector: ${lead.sector}
Plaats: ${lead.plaats}
Website: ${lead.website || "GEEN"}
Google Reviews: ${lead.googleReviews}
Google Rating: ${lead.googleRating}/5
Instagram volgers: ${lead.aantalVolgers}
Heeft SSL: ${lead.heeftSSL}

Reageer ALLEEN met dit JSON object, geen uitleg, geen markdown backticks:
{"marketingScore":7,"seoScore":4,"socialScore":3,"prioriteit":"HOOG","redenKort":"Geen SEO, weinig reviews","kansen":["Local SEO","Google Ads","Social media"],"risico":"Laag budget mogelijk"}

Regels:
- marketingScore 1-10: kans dat dit bedrijf marketing nodig heeft (hoog = betere lead)
- seoScore 1-10: hoe slecht hun SEO is (hoog = meer kansen)
- socialScore 1-10: hoe slecht hun social media is
- prioriteit: "HOOG" (score 8-10), "MIDDEL" (5-7), "LAAG" (1-4)
- kansen: array van 2-4 concrete diensten die THMarcom kan leveren`;

  try {
    const r = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-api-key": ANTHROPIC_KEY,
        "anthropic-version": "2023-06-01",
      },
      body: JSON.stringify({
        model: "claude-sonnet-4-20250514",
        max_tokens: 300,
        messages: [{ role: "user", content: prompt }],
      }),
    });

    const data = await r.json();
    const text = data.content?.map(b => b.text || "").join("") || "{}";
    const clean = text.replace(/```json|```/g, "").trim();
    res.json(JSON.parse(clean));
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

const PORT = process.env.PORT || 3001;
app.listen(PORT, () => console.log(`✅ THMarcom Lead Engine draait op poort ${PORT}`));
