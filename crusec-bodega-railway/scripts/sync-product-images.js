const fs = require('fs');
const path = require('path');

const SITEMAP_URL = process.env.CRUSEC_SITEMAP_URL || 'https://www.crusec.cl/sitemap_1.xml';
const OUTPUT_FILE = path.join(__dirname, '..', 'data', 'product-images.json');

function decode(value) {
  return String(value || '').replace(/&amp;/g, '&').replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&lt;/g, '<').replace(/&gt;/g, '>');
}

function normalizeSku(value) {
  return decode(value).trim().toUpperCase();
}

function firstMatch(html, patterns) {
  for (const pattern of patterns) {
    const match = html.match(pattern);
    if (match?.[1]) return decode(match[1].replace(/\\\//g, '/'));
  }
  return '';
}

function productRecord(html, pageUrl) {
  if (!/<meta[^>]+property=["']og:type["'][^>]+content=["']product["']/i.test(html)) return null;
  const imageUrl = firstMatch(html, [
    /["']image["']\s*:\s*["']([^"']+)["']/i,
    /<meta[^>]+property=["']og:image["'][^>]+content=["']([^"']+)["']/i,
    /<meta[^>]+content=["']([^"']+)["'][^>]+property=["']og:image["']/i,
  ]);
  if (!imageUrl) return null;

  const skus = new Set();
  for (const match of html.matchAll(/["']sku["']\s*:\s*["']([^"']+)["']/gi)) {
    const sku = normalizeSku(match[1]);
    if (sku && sku !== 'SKU') skus.add(sku);
  }
  return skus.size ? { skus: [...skus], imageUrl, productUrl: pageUrl } : null;
}

async function fetchText(url) {
  const response = await fetch(url, { headers: { Accept: 'text/html,application/xml;q=0.9,*/*;q=0.8', 'User-Agent': 'KORDIS product image sync (crusec.cl)' } });
  if (!response.ok) throw new Error(`${response.status} ${response.statusText}`);
  return response.text();
}

async function main() {
  const sitemap = await fetchText(SITEMAP_URL);
  const urls = [...sitemap.matchAll(/<loc>([^<]+)<\/loc>/gi)].map((match) => decode(match[1]).trim()).filter(Boolean);
  const images = {};
  let next = 0;
  let failures = 0;

  async function worker() {
    while (next < urls.length) {
      const index = next++;
      const url = urls[index];
      try {
        const record = productRecord(await fetchText(url), url);
        if (record) for (const sku of record.skus) images[sku] = { imageUrl: record.imageUrl, productUrl: record.productUrl };
      } catch (error) {
        failures += 1;
        console.warn(`No se pudo leer ${url}: ${error.message}`);
      }
      if ((index + 1) % 100 === 0 || index + 1 === urls.length) console.log(`${index + 1}/${urls.length} URLs · ${Object.keys(images).length} SKU`);
    }
  }

  await Promise.all(Array.from({ length: 12 }, worker));
  const sorted = Object.fromEntries(Object.entries(images).sort(([a], [b]) => a.localeCompare(b)));
  const payload = { source: 'https://www.crusec.cl', syncedAt: new Date().toISOString(), count: Object.keys(sorted).length, images: sorted };
  fs.writeFileSync(OUTPUT_FILE, `${JSON.stringify(payload, null, 2)}\n`, 'utf8');
  console.log(`Guardado ${payload.count} SKU en ${OUTPUT_FILE}; ${failures} fallos.`);
}

main().catch((error) => { console.error(error); process.exitCode = 1; });
