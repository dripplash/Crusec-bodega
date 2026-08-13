/**
 * Crusec Bodega
 * Sistema desarrollado por David Navarro por iniciativa propia
 * para apoyo interno de bodega Crusec Life Store.
 *
 * Nota de autoría:
 * Este desarrollo, su estructura técnica y futuras mejoras quedan sujetos a acuerdo
 * con David Navarro en caso de continuidad, modificación mayor, traspaso o uso
 * fuera de la operación interna de bodega.
 */
const http = require('http');
const fs = require('fs');
const path = require('path');
const { URL } = require('url');
const crypto = require('crypto');
const XLSX = require('xlsx');

function loadEnvFile() {
  const envPath = path.join(__dirname, '.env');
  if (!fs.existsSync(envPath)) return;

  for (const line of fs.readFileSync(envPath, 'utf8').split(/\r?\n/)) {
    const value = line.trim();
    if (!value || value.startsWith('#')) continue;

    const i = value.indexOf('=');
    if (i < 1) continue;

    const key = value.slice(0, i).trim();
    let val = value.slice(i + 1).trim();

    if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
      val = val.slice(1, -1);
    }

    if (process.env[key] === undefined) process.env[key] = val;
  }
}

loadEnvFile();

const PORT = Number(process.env.PORT || 3000);
const HOST = process.env.HOST || '0.0.0.0';

const PUBLIC_DIR = path.join(__dirname, 'public');
const PROJECT_DATA_DIR = path.join(__dirname, 'data');
const DATA_DIR = path.resolve(process.env.DATA_DIR || PROJECT_DATA_DIR);

const LOCATIONS_FILE = path.join(DATA_DIR, 'locations.json');
const HISTORY_FILE = path.join(DATA_DIR, 'history.json');
const PRODUCT_CACHE_FILE = path.join(DATA_DIR, 'products-cache.json');
const OAUTH_STATE_FILE = path.join(DATA_DIR, 'relbase-oauth-state.json');

const SEED_FILE = path.join(PROJECT_DATA_DIR, 'locations.seed.json');
const DEMO_PRODUCTS_FILE = path.join(PROJECT_DATA_DIR, 'demo-products.json');

const CATALOG_MODE = String(process.env.CATALOG_MODE || 'demo').toLowerCase();
const SYNC_INTERVAL_MINUTES = Math.max(1, Number(process.env.SYNC_INTERVAL_MINUTES || 10));
const MAX_SECOND_FLOOR_POSITION = Math.max(1, Number(process.env.MAX_SECOND_FLOOR_POSITION || 20));
const ADMIN_PIN = String(process.env.ADMIN_PIN || '1234');
const HISTORY_LIMIT = Math.max(100, Number(process.env.HISTORY_LIMIT || 2000));

const SPECIAL_AREAS = {
  PIEZA_1: {
    key: 'PIEZA_1',
    label: 'Pieza 1',
    spots: {
      ESTANTE_1: 'Estante 1',
      ESTANTE_2: 'Estante 2',
      ESTANTE_3: 'Estante 3',
    },
  },
  PIEZA_2: {
    key: 'PIEZA_2',
    label: 'Pieza 2',
    spots: {
      ESTANTE_1: 'Estante 1',
      ESTANTE_2: 'Estante 2',
      ESTANTE_3: 'Estante 3',
    },
  },
  PIEZA_3: {
    key: 'PIEZA_3',
    label: 'Pieza 3',
    spots: {
      ESTANTE_1: 'Estante 1',
      ESTANTE_2: 'Estante 2',
      ESTANTE_3: 'Estante 3',
    },
  },
  SEGUNDO_PISO: {
    key: 'SEGUNDO_PISO',
    label: 'Segundo piso',
    spots: {
      PIEZA: 'Pieza',
      ESTANTE_1: 'Estante 1',
      PISO: 'Piso',
    },
  },
};

function normalizeSku(v) {
  return String(v || '').trim().toUpperCase();
}

function brandFromCode(code) {
  const sku = normalizeSku(code);
  const p = sku.charAt(0);

  if (p === 'P') return 'Pitaya';
  if (p === 'Y') return 'Yozen';

  return 'Crusec';
}

function ensureDataDir() {
  fs.mkdirSync(DATA_DIR, { recursive: true });
}

function ensureLocationFile() {
  ensureDataDir();

  if (!fs.existsSync(LOCATIONS_FILE)) {
    const seed = fs.existsSync(SEED_FILE)
      ? fs.readFileSync(SEED_FILE, 'utf8')
      : '{"locations":{}}';

    fs.writeFileSync(LOCATIONS_FILE, seed);
  }
}

function readLocations() {
  ensureLocationFile();

  try {
    const parsed = JSON.parse(fs.readFileSync(LOCATIONS_FILE, 'utf8'));

    return {
      locations: parsed.locations && typeof parsed.locations === 'object'
        ? parsed.locations
        : {},
    };
  } catch (error) {
    console.error('Error leyendo ubicaciones:', error);
    return { locations: {} };
  }
}

function writeLocations(db) {
  ensureLocationFile();

  const tmp = `${LOCATIONS_FILE}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(db, null, 2));
  fs.renameSync(tmp, LOCATIONS_FILE);
}

function ensureHistoryFile() {
  ensureDataDir();

  if (!fs.existsSync(HISTORY_FILE)) {
    fs.writeFileSync(HISTORY_FILE, JSON.stringify({ events: [] }, null, 2));
  }
}

function readHistory() {
  ensureHistoryFile();

  try {
    const parsed = JSON.parse(fs.readFileSync(HISTORY_FILE, 'utf8'));
    return {
      events: Array.isArray(parsed.events) ? parsed.events : [],
    };
  } catch (error) {
    console.error('Error leyendo historial:', error);
    return { events: [] };
  }
}

function writeHistory(history) {
  ensureHistoryFile();

  const events = Array.isArray(history.events) ? history.events.slice(0, HISTORY_LIMIT) : [];
  const tmp = `${HISTORY_FILE}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify({ events }, null, 2));
  fs.renameSync(tmp, HISTORY_FILE);
}

function describeLocation(location) {
  const normalized = normalizeSavedLocation(location);
  return normalized?.fullLabel || 'Sin ubicación';
}

function appendHistoryEvent({ sku, product, action, before, after, updatedBy }) {
  const history = readHistory();
  const actor = String(updatedBy || 'Sin identificar').trim() || 'Sin identificar';

  const event = {
    id: `${Date.now()}-${crypto.randomBytes(4).toString('hex')}`,
    createdAt: new Date().toISOString(),
    sku: normalizeSku(sku),
    productName: product?.name || 'Producto sin nombre',
    brand: product?.brand || brandFromCode(sku),
    action,
    updatedBy: actor,
    before: normalizeSavedLocation(before),
    after: normalizeSavedLocation(after),
    beforeLabel: describeLocation(before),
    afterLabel: describeLocation(after),
  };

  history.events.unshift(event);
  writeHistory(history);

  return event;
}

function readDemoProducts() {
  const parsed = JSON.parse(fs.readFileSync(DEMO_PRODUCTS_FILE, 'utf8'));
  return Array.isArray(parsed.products) ? parsed.products : [];
}

function readProductCache() {
  ensureDataDir();

  try {
    if (!fs.existsSync(PRODUCT_CACHE_FILE)) {
      return {
        products: [],
        lastSyncAt: null,
        count: 0,
      };
    }

    const parsed = JSON.parse(fs.readFileSync(PRODUCT_CACHE_FILE, 'utf8'));
    const products = Array.isArray(parsed.products) ? parsed.products : [];

    return {
      products,
      lastSyncAt: parsed.lastSyncAt || null,
      count: Number(parsed.count || products.length || 0),
    };
  } catch (error) {
    console.error('Error leyendo caché de productos:', error);

    return {
      products: [],
      lastSyncAt: null,
      count: 0,
      error: error.message,
    };
  }
}

function writeProductCache(products) {
  ensureDataDir();

  const payload = {
    lastSyncAt: new Date().toISOString(),
    count: products.length,
    products,
  };

  const tmp = `${PRODUCT_CACHE_FILE}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(payload, null, 2));
  fs.renameSync(tmp, PRODUCT_CACHE_FILE);

  return payload;
}

async function syncRelbaseProducts() {
  const relbase = require('./src/relbase');
  const products = await relbase.listProducts();

  return writeProductCache(products);
}

function upsertProductCache(product) {
  const normalizedSku = normalizeSku(product?.sku);
  if (!normalizedSku) return readProductCache();

  const cache = readProductCache();
  const products = Array.isArray(cache.products) ? cache.products.slice() : [];

  const index = products.findIndex((item) =>
    normalizeSku(item.sku) === normalizedSku ||
    normalizeSku(item.barcode) === normalizedSku
  );

  const cleanProduct = {
    ...product,
    sku: normalizedSku,
    cachedAt: new Date().toISOString(),
  };

  if (index >= 0) {
    products[index] = {
      ...products[index],
      ...cleanProduct,
    };
  } else {
    products.push(cleanProduct);
  }

  const payload = {
    lastSyncAt: cache.lastSyncAt || null,
    lastSingleLookupAt: new Date().toISOString(),
    count: products.length,
    products,
  };

  const tmp = `${PRODUCT_CACHE_FILE}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(payload, null, 2));
  fs.renameSync(tmp, PRODUCT_CACHE_FILE);

  return payload;
}

async function getCatalog(options = {}) {
  const allowLiveFetch = Boolean(options.allowLiveFetch);

  if (CATALOG_MODE === 'relbase') {
    const cache = readProductCache();

    if (cache.products.length) return cache.products;
    if (allowLiveFetch) {
      const synced = await syncRelbaseProducts();
      return synced.products;
    }
    return [];
  }

  return readDemoProducts();
}

function normalizeNormalLocation(location) {
  if (!location) return null;

  const aisle = Number(location.aisle);
  const rack = Number(location.rack);
  const level = Number(location.level);
  const side = String(location.side || '').trim().toUpperCase();
  const sideLabel = side === 'D' ? 'Derecho' : side === 'I' ? 'Izquierdo' : (location.sideLabel || '');

  if (!Number.isInteger(aisle) || !Number.isInteger(rack) || !Number.isInteger(level) || !['D', 'I'].includes(side)) {
    return null;
  }

  return {
    type: 'normal',
    aisle,
    side,
    sideLabel,
    rack,
    level,
    fullLabel: `Pasillo ${aisle} — lado ${sideLabel.toLowerCase()} — rack ${rack} — nivel ${level}`,
  };
}

function normalizeSpecialLocation(location) {
  if (!location) return null;

  const areaKey = String(location.areaKey || location.area || '').trim().toUpperCase();
  const area = SPECIAL_AREAS[areaKey];
  if (!area) return null;

  const spotKey = String(location.spotKey || location.spot || '').trim().toUpperCase();
  const spotLabel = area.spots[spotKey];
  if (!spotLabel) return null;

  let position = null;
  if (spotKey === 'PISO') {
    position = Number(location.position);
    if (!Number.isInteger(position) || position < 1 || position > MAX_SECOND_FLOOR_POSITION) return null;
  }

  return {
    type: 'special',
    areaKey,
    areaLabel: area.label,
    spotKey,
    spotLabel,
    position,
    fullLabel: position
      ? `${area.label} — ${spotLabel} — Posición ${position}`
      : `${area.label} — ${spotLabel}`,
  };
}

function normalizeSavedLocation(location) {
  if (!location || typeof location !== 'object') return null;
  if (location.type === 'special' || location.areaKey || location.area) return normalizeSpecialLocation(location);
  return normalizeNormalLocation(location);
}

function mergeLocation(product, locationsDb) {
  const saved = locationsDb.locations[normalizeSku(product.sku)] || {};
  const normalizedLocation = normalizeSavedLocation(saved.location);

  return {
    ...product,
    sku: normalizeSku(product.sku),
    brand: product.brand || brandFromCode(product.sku),
    location: normalizedLocation,
    locationUpdatedAt: saved.locationUpdatedAt || null,
    locationUpdatedBy: saved.locationUpdatedBy || null,
  };
}

function publicProduct(product) {
  return {
    relbaseId: product.relbaseId || product.sku,
    sku: normalizeSku(product.sku),
    name: product.name || 'Producto sin nombre',
    barcode: product.barcode || '',
    brand: product.brand || brandFromCode(product.sku),
    active: product.active !== false,
    stock: product.stock ?? null,
    stockUpdatedAt: product.stockUpdatedAt || null,
    location: product.location || null,
    locationUpdatedAt: product.locationUpdatedAt || null,
    locationUpdatedBy: product.locationUpdatedBy || null,
  };
}

function validateNormalLocation(input) {
  const aisle = Number(input.aisle);
  const side = String(input.side || '').trim().toUpperCase();
  const rack = Number(input.rack);
  const level = Number(input.level);

  const maxAisle = Number(process.env.MAX_AISLE || 6);
  const maxRack = Number(process.env.MAX_RACK || 11);
  const maxLevel = Number(process.env.MAX_LEVEL || 5);
  
  if (!Number.isInteger(aisle) || aisle < 1 || aisle > maxAisle) {
    return `El pasillo debe estar entre 1 y ${maxAisle}.`;
  }
  if (!['D', 'I'].includes(side)) {
    return 'El lado debe ser D (derecho) o I (izquierdo).';
  }
  if (!Number.isInteger(rack) || rack < 1 || rack > maxRack) {
    return `El rack debe estar entre 1 y ${maxRack}.`;
  }
  if (!Number.isInteger(level) || level < 1 || level > maxLevel) {
    return `El nivel debe estar entre 1 y ${maxLevel}.`;
  }

  const sideLabel = side === 'D' ? 'Derecho' : 'Izquierdo';

  return {
    type: 'normal',
    aisle,
    side,
    sideLabel,
    rack,
    level,
    fullLabel: `Pasillo ${aisle} — lado ${sideLabel.toLowerCase()} — rack ${rack} — nivel ${level}`,
  };
}

function validateSpecialLocation(input) {
  const areaKey = String(input.areaKey || input.area || '').trim().toUpperCase();
  const area = SPECIAL_AREAS[areaKey];
  if (!area) return 'Debes elegir una zona especial válida.';

  const spotKey = String(input.spotKey || input.spot || '').trim().toUpperCase();
  const spotLabel = area.spots[spotKey];
  if (!spotLabel) return 'Debes elegir una ubicación interna válida.';

  let position = null;
  if (spotKey === 'PISO') {
    position = Number(input.position);
    if (!Number.isInteger(position) || position < 1 || position > MAX_SECOND_FLOOR_POSITION) {
      return `La posición del piso debe estar entre 1 y ${MAX_SECOND_FLOOR_POSITION}.`;
    }
  }

  return {
    type: 'special',
    areaKey,
    areaLabel: area.label,
    spotKey,
    spotLabel,
    position,
    fullLabel: position
      ? `${area.label} — ${spotLabel} — Posición ${position}`
      : `${area.label} — ${spotLabel}`,
  };
}

function sendRedirect(res, location) {
  res.writeHead(302, { Location: location });
  res.end();
}

function htmlPage(title, message, extra = '') {
  return `<!doctype html>
<html lang="es">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>${title}</title>
  <style>
    body { font-family: system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; background: #f4f6f8; color: #111827; margin: 0; min-height: 100vh; display: grid; place-items: center; }
    main { width: min(680px, calc(100% - 32px)); background: white; border: 1px solid #dbe2ea; border-radius: 20px; padding: 32px; box-shadow: 0 18px 50px rgba(15, 23, 42, 0.08); }
    h1 { margin-top: 0; }
    a { display: inline-block; margin-top: 16px; background: #1d4ed8; color: white; padding: 12px 16px; border-radius: 12px; text-decoration: none; font-weight: 800; }
    pre { background: #0f172a; color: #e5e7eb; padding: 14px; border-radius: 12px; overflow: auto; }
  </style>
</head>
<body>
  <main>
    <h1>${title}</h1>
    <p>${message}</p>
    ${extra}
    <a href="/">Volver a Crusec Bodega</a>
  </main>
</body>
</html>`;
}

function writeOAuthState(state) {
  ensureDataDir();
  fs.writeFileSync(OAUTH_STATE_FILE, JSON.stringify({
    state,
    createdAt: new Date().toISOString(),
    expiresAt: new Date(Date.now() + 10 * 60 * 1000).toISOString(),
  }, null, 2));
}

function readOAuthState() {
  try {
    if (!fs.existsSync(OAUTH_STATE_FILE)) return null;
    return JSON.parse(fs.readFileSync(OAUTH_STATE_FILE, 'utf8'));
  } catch {
    return null;
  }
}

function clearOAuthState() {
  try {
    if (fs.existsSync(OAUTH_STATE_FILE)) fs.unlinkSync(OAUTH_STATE_FILE);
  } catch {}
}

async function handleAuth(req, res, url) {
  const relbase = require('./src/relbase');

  if (req.method === 'GET' && url.pathname === '/auth/login') {
    const state = crypto.randomBytes(24).toString('hex');
    writeOAuthState(state);
    return sendRedirect(res, relbase.getAuthUrl(state));
  }

  if (req.method === 'GET' && url.pathname === '/auth/callback') {
    const error = url.searchParams.get('error');
    const errorDescription = url.searchParams.get('error_description');

    if (error) {
      return sendText(res, 400, htmlPage('Relbase no autorizó la conexión', `${errorDescription || error}`), 'text/html; charset=utf-8');
    }

    const code = url.searchParams.get('code');
    const state = url.searchParams.get('state');
    const savedState = readOAuthState();

    if (!code) {
      return sendText(res, 400, htmlPage('Falta el código de autorización', 'Relbase no devolvió el código necesario para conectar.'), 'text/html; charset=utf-8');
    }

    if (!savedState || savedState.state !== state || new Date(savedState.expiresAt).getTime() < Date.now()) {
      return sendText(res, 400, htmlPage('Autorización inválida o expirada', 'Vuelve a iniciar sesión desde /auth/login.'), 'text/html; charset=utf-8');
    }

    try {
      const token = await relbase.exchangeCodeForToken(code);
      clearOAuthState();
      return sendText(res, 200, htmlPage('Relbase conectado correctamente', 'La autorización fue guardada. Ahora la app puede leer productos desde Relbase.', `<pre>Token válido hasta: ${token.expires_at || 'sin fecha informada'}</pre>`), 'text/html; charset=utf-8');
    } catch (authError) {
      console.error(authError);
      return sendText(res, 500, htmlPage('No se pudo conectar Relbase', authError.message || 'Error desconocido.'), 'text/html; charset=utf-8');
    }
  }

  return sendJson(res, 404, { error: 'Ruta auth no encontrada.' });
}

function sendJson(res, code, payload) {
  const body = JSON.stringify(payload);
  res.writeHead(code, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(body),
    'Cache-Control': 'no-store',
  });
  res.end(body);
}

function sendText(res, code, text, type = 'text/plain; charset=utf-8') {
  res.writeHead(code, {
    'Content-Type': type,
    'Content-Length': Buffer.byteLength(text),
  });
  res.end(text);
}

async function readBody(req) {
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  if (!chunks.length) return {};

  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } catch {
    throw new Error('La solicitud no contiene JSON válido.');
  }
}

async function productSnapshot() {
  const [catalog, locations] = await Promise.all([getCatalog(), Promise.resolve(readLocations())]);
  return catalog.map((p) => mergeLocation(p, locations));
}
async function findProductForSearch(sku) {
  const normalizedSku = normalizeSku(sku);
  const locations = readLocations();

  if (CATALOG_MODE !== 'relbase') {
    const catalog = await getCatalog();

    const product = catalog.find((p) =>
      normalizeSku(p.sku) === normalizedSku ||
      normalizeSku(p.barcode) === normalizedSku
    );

    return {
      product: product ? mergeLocation(product, locations) : null,
      source: 'demo',
      relbaseError: null,
    };
  }

  const cache = readProductCache();

  const cachedProduct = cache.products.find((p) =>
    normalizeSku(p.sku) === normalizedSku ||
    normalizeSku(p.barcode) === normalizedSku
  );

  /*
   * Primero caché:
   * así no gastamos solicitudes de Relbase si el producto ya está guardado.
   */
  if (cachedProduct) {
    return {
      product: mergeLocation(cachedProduct, locations),
      source: 'cache',
      relbaseError: null,
    };
  }

  /*
   * Si no está en caché,
   * recién ahí hacemos una consulta puntual a Relbase.
   */
  try {
    const relbase = require('./src/relbase');
    const liveProduct = await relbase.findProductBySku(normalizedSku);

    if (!liveProduct) {
      return {
        product: null,
        source: 'relbase-live',
        relbaseError: null,
      };
    }

    upsertProductCache(liveProduct);

    return {
      product: mergeLocation(liveProduct, locations),
      source: 'relbase-live',
      relbaseError: null,
    };
  } catch (error) {
    console.error('Error buscando SKU puntual en Relbase:', error);

    return {
      product: null,
      source: 'cache-fallback',
      relbaseError: error.message || 'Relbase no respondió.',
    };
  }
}
function getSyncStatusText(cache, relbaseStatus) {
  if (CATALOG_MODE !== 'relbase') return 'Modo demo: Relbase pendiente de conectar';
  if (!relbaseStatus?.authorized) return 'Relbase pendiente de autorización';
  if (!cache.lastSyncAt || !cache.products.length) return 'Relbase conectado · presiona Sincronizar para cargar productos';
  return `Relbase conectado · ${cache.products.length} productos guardados`;
}

function locationKind(location) {
  if (!location) return 'none';
  return location.type === 'special' ? 'special' : 'normal';
}

function safeExcelValue(value) {
  return value === undefined || value === null ? '' : value;
}

function exportTypeLabel(type) {
  if (type === 'full') return 'Ubicacion_Completa';
  if (type === 'simple') return 'Lista_Simple';
  if (type === 'notes') return 'Observaciones';
  return 'Inventario';
}

function recorridoBodega(product) {
  const side = String(product.location?.side || '').toUpperCase();
  const sideLabel = side === 'I' ? 'I' : side === 'D' ? 'D' : '';
  const rack = String(product.location?.rack || '').padStart(2, '0');
  const level = String(product.location?.level || '').padStart(2, '0');

  return `${sideLabel}-${rack}-${level}`;
}

function buildAisleExportRows(products, type) {
  if (type === 'full') {
    return [
      ['Orden recorrido', 'SKU', 'Nombre', 'Pasillo', 'Lado', 'Rack', 'Nivel', 'Stock Relbase'],
      ...products.map((product) => [
        recorridoBodega(product),
        safeExcelValue(product.sku),
        safeExcelValue(product.name),
        safeExcelValue(product.location?.aisle),
        safeExcelValue(product.location?.sideLabel),
        safeExcelValue(product.location?.rack),
        safeExcelValue(product.location?.level),
        safeExcelValue(product.stock),
      ]),
    ];
  }

  if (type === 'simple') {
    return [
      ['Orden recorrido', 'SKU', 'Nombre', 'Pasillo', 'Lado', 'Rack', 'Nivel'],
      ...products.map((product) => [
        recorridoBodega(product),
        safeExcelValue(product.sku),
        safeExcelValue(product.name),
        safeExcelValue(product.location?.aisle),
        safeExcelValue(product.location?.sideLabel),
        safeExcelValue(product.location?.rack),
        safeExcelValue(product.location?.level),
      ]),
    ];
  }

  if (type === 'notes') {
    return [
      ['Orden recorrido', 'SKU', 'Nombre', 'Pasillo', 'Lado', 'Rack', 'Nivel', 'Acción sugerida', 'Observación'],
      ...products.map((product) => [
        recorridoBodega(product),
        safeExcelValue(product.sku),
        safeExcelValue(product.name),
        safeExcelValue(product.location?.aisle),
        safeExcelValue(product.location?.sideLabel),
        safeExcelValue(product.location?.rack),
        safeExcelValue(product.location?.level),
        '',
        '',
      ]),
    ];
  }

  return null;
}

function workbookBufferFromRows(rows, sheetName = 'Inventario') {
  const workbook = XLSX.utils.book_new();
  const worksheet = XLSX.utils.aoa_to_sheet(rows);

  worksheet['!cols'] = [
  { wch: 18 },
  { wch: 18 },
  { wch: 55 },
  { wch: 12 },
  { wch: 18 },
  { wch: 12 },
  { wch: 12 },
  { wch: 16 },
  { wch: 18 },
];

  XLSX.utils.book_append_sheet(workbook, worksheet, sheetName);

  return XLSX.write(workbook, {
    type: 'buffer',
    bookType: 'xlsx',
  });
}

async function sendAisleExport(res, aisle, type) {
  const products = await productSnapshot();

  const aisleProducts = products
    .filter((product) =>
      product.location?.type === 'normal' &&
      Number(product.location.aisle) === Number(aisle)
    )
    .sort((a, b) => {
  const sideOrder = {
    I: 1,
    D: 2,
  };

  const sideA = sideOrder[String(a.location?.side || '').toUpperCase()] || 99;
  const sideB = sideOrder[String(b.location?.side || '').toUpperCase()] || 99;

  const rackA = Number(a.location?.rack || 0);
  const rackB = Number(b.location?.rack || 0);

  const levelA = Number(a.location?.level || 0);
  const levelB = Number(b.location?.level || 0);

  if (sideA !== sideB) return sideA - sideB;
  if (rackA !== rackB) return rackA - rackB;
  if (levelA !== levelB) return levelA - levelB;

  return normalizeSku(a.sku).localeCompare(normalizeSku(b.sku));
});
  if (!aisleProducts.length) {
    return sendJson(res, 404, {
      error: `No hay productos con ubicación guardada en el Pasillo ${aisle}.`,
    });
  }

  const rows = buildAisleExportRows(aisleProducts, type);

  if (!rows) {
    return sendJson(res, 400, {
      error: 'Tipo de Excel no válido.',
    });
  }

  const buffer = workbookBufferFromRows(rows, `Pasillo ${aisle}`);
  const fileName = `Pasillo_${aisle}_${exportTypeLabel(type)}.xlsx`;

  res.writeHead(200, {
    'Content-Type': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    'Content-Disposition': `attachment; filename="${fileName}"`,
    'Content-Length': buffer.length,
    'Cache-Control': 'no-store',
  });

  return res.end(buffer);
}

async function handleApi(req, res, url) {
    if (req.method === 'GET' && url.pathname === '/api/exports/aisle') {
    const aisle = Number(url.searchParams.get('aisle'));
    const type = String(url.searchParams.get('type') || 'full');

    if (!Number.isInteger(aisle) || aisle < 1 || aisle > 6) {
      return sendJson(res, 400, {
        error: 'Debes elegir un pasillo entre 1 y 6.',
      });
    }

    if (!['full', 'simple', 'notes'].includes(type)) {
      return sendJson(res, 400, {
        error: 'Tipo de Excel no válido.',
      });
    }

    return sendAisleExport(res, aisle, type);
  }
  
  if (req.method === 'GET' && url.pathname === '/api/status') {
    let relbaseStatus = null;
    let productCount = 0;
    let cache = { products: [], lastSyncAt: null, count: 0 };

    try {
      if (CATALOG_MODE === 'relbase') {
        const relbase = require('./src/relbase');
        relbaseStatus = relbase.status();
        cache = readProductCache();
        productCount = cache.products.length;
      } else {
        productCount = readDemoProducts().length;
      }
    } catch (error) {
      relbaseStatus = { configured: true, authorized: false, error: error.message };
    }

    return sendJson(res, 200, {
      relbaseEnabled: CATALOG_MODE === 'relbase',
      relbaseAuthorized: Boolean(relbaseStatus?.authorized),
      relbaseStatus,
      mode: CATALOG_MODE,
      lastSyncAt: CATALOG_MODE === 'relbase' ? cache.lastSyncAt : null,
      syncStatus: getSyncStatusText(cache, relbaseStatus),
      productCount,
      syncIntervalMinutes: SYNC_INTERVAL_MINUTES,
      storage: DATA_DIR,
      cacheFile: CATALOG_MODE === 'relbase' ? PRODUCT_CACHE_FILE : null,
      maxSecondFloorPosition: MAX_SECOND_FLOOR_POSITION,
      specialAreas: Object.values(SPECIAL_AREAS).map((area) => ({
        key: area.key,
        label: area.label,
        spots: Object.entries(area.spots).map(([key, label]) => ({ key, label })),
      })),
    });
  }

  if (req.method === 'GET' && url.pathname === '/api/products/search') {
  const sku = normalizeSku(url.searchParams.get('sku'));
  if (!sku) return sendJson(res, 400, { error: 'Debes ingresar un SKU o código de barras.' });

  const result = await findProductForSearch(sku);
  const cache = CATALOG_MODE === 'relbase'
    ? readProductCache()
    : { lastSyncAt: null };

  if (!result.product) {
    if (result.relbaseError) {
      return sendJson(res, 502, {
        error: `No está en caché y Relbase no respondió: ${result.relbaseError}`,
        lastSyncAt: cache.lastSyncAt,
      });
    }

    return sendJson(res, 404, {
      error: 'Código de producto no registrado.',
      lastSyncAt: cache.lastSyncAt,
    });
  }

  return sendJson(res, 200, {
    product: publicProduct(result.product),
    lastSyncAt: cache.lastSyncAt,
    source: result.source,
  });
}

  if (req.method === 'GET' && url.pathname === '/api/products') {
    const filter = String(url.searchParams.get('filter') || 'all');
    const q = String(url.searchParams.get('q') || '').trim().toUpperCase();
    let products = await productSnapshot();
    const cache = CATALOG_MODE === 'relbase' ? readProductCache() : { lastSyncAt: null };

    if (filter === 'unassigned') products = products.filter((p) => !p.location);
    if (filter === 'assigned') products = products.filter((p) => Boolean(p.location));
    if (filter === 'normal') products = products.filter((p) => locationKind(p.location) === 'normal');
    if (filter === 'special') products = products.filter((p) => locationKind(p.location) === 'special');
    if (filter === 'with-stock') products = products.filter((p) => Number(p.stock) > 0);
    if (filter === 'without-stock') products = products.filter((p) => Number(p.stock) === 0);

    if (q) {
      products = products.filter((p) =>
        normalizeSku(p.sku).includes(q) ||
        String(p.name || '').toUpperCase().includes(q) ||
        String(p.brand || '').toUpperCase().includes(q) ||
        normalizeSku(p.barcode).includes(q)
      );
    }

    products.sort((a, b) => {
      if (Boolean(a.location) !== Boolean(b.location)) return a.location ? 1 : -1;
      return normalizeSku(a.sku).localeCompare(normalizeSku(b.sku));
    });

    let relbaseStatus = null;
    if (CATALOG_MODE === 'relbase') {
      try { relbaseStatus = require('./src/relbase').status(); } catch {}
    }

    return sendJson(res, 200, {
      products: products.map(publicProduct),
      lastSyncAt: CATALOG_MODE === 'relbase' ? cache.lastSyncAt : null,
      syncStatus: getSyncStatusText(cache, relbaseStatus),
    });
  }

  if (req.method === 'GET' && url.pathname === '/api/special-locations') {
    const areaKey = String(url.searchParams.get('areaKey') || '').trim().toUpperCase();
    const spotKey = String(url.searchParams.get('spotKey') || '').trim().toUpperCase();

    let products = await productSnapshot();
    products = products.filter((p) => p.location?.type === 'special');
    if (areaKey) products = products.filter((p) => p.location.areaKey === areaKey);
    if (spotKey) products = products.filter((p) => p.location.spotKey === spotKey);

    products.sort((a, b) => {
      const apos = a.location?.position ?? 99999;
      const bpos = b.location?.position ?? 99999;
      if (apos !== bpos) return apos - bpos;
      return normalizeSku(a.sku).localeCompare(normalizeSku(b.sku));
    });

    return sendJson(res, 200, { products: products.map(publicProduct) });
  }

  const locationMatch = url.pathname.match(/^\/api\/products\/([^/]+)\/location$/);
  const specialMatch = url.pathname.match(/^\/api\/products\/([^/]+)\/special-location$/);

  if (locationMatch && req.method === 'PUT') {
    const sku = normalizeSku(decodeURIComponent(locationMatch[1]));
    const products = await getCatalog();
    const exists = products.some((p) => normalizeSku(p.sku) === sku);
    if (!exists) return sendJson(res, 404, { error: 'Producto no encontrado.' });

    const body = await readBody(req);
    const location = validateNormalLocation(body);
    if (typeof location === 'string') return sendJson(res, 400, { error: location });

    const db = readLocations();
    const baseProduct = products.find((p) => normalizeSku(p.sku) === sku);
    const previousLocation = db.locations[sku]?.location || null;
    const updatedBy = String(body.updatedBy || 'Sin identificar').trim() || 'Sin identificar';

    db.locations[sku] = {
      location,
      locationUpdatedAt: new Date().toISOString(),
      locationUpdatedBy: updatedBy,
    };
    writeLocations(db);

    appendHistoryEvent({
      sku,
      product: baseProduct,
      action: previousLocation ? 'actualizar ubicación de bodega' : 'asignar ubicación de bodega',
      before: previousLocation,
      after: location,
      updatedBy,
    });

    const product = mergeLocation(baseProduct, db);
    return sendJson(res, 200, { product: publicProduct(product), message: 'Ubicación de bodega guardada correctamente.' });
  }

  if (specialMatch && req.method === 'PUT') {
    const sku = normalizeSku(decodeURIComponent(specialMatch[1]));
    const products = await getCatalog();
    const exists = products.some((p) => normalizeSku(p.sku) === sku);
    if (!exists) return sendJson(res, 404, { error: 'Producto no encontrado.' });

    const body = await readBody(req);
    const location = validateSpecialLocation(body);
    if (typeof location === 'string') return sendJson(res, 400, { error: location });

    const db = readLocations();
    const baseProduct = products.find((p) => normalizeSku(p.sku) === sku);
    const previousLocation = db.locations[sku]?.location || null;
    const updatedBy = String(body.updatedBy || 'Sin identificar').trim() || 'Sin identificar';

    db.locations[sku] = {
      location,
      locationUpdatedAt: new Date().toISOString(),
      locationUpdatedBy: updatedBy,
    };
    writeLocations(db);

    appendHistoryEvent({
      sku,
      product: baseProduct,
      action: previousLocation ? 'actualizar ubicación especial' : 'asignar ubicación especial',
      before: previousLocation,
      after: location,
      updatedBy,
    });

    const product = mergeLocation(baseProduct, db);
    return sendJson(res, 200, { product: publicProduct(product), message: 'Ubicación especial guardada correctamente.' });
  }

  if ((locationMatch || specialMatch) && req.method === 'DELETE') {
    const sku = normalizeSku(decodeURIComponent((locationMatch || specialMatch)[1]));
    const products = await getCatalog();
    const base = products.find((p) => normalizeSku(p.sku) === sku);
    if (!base) return sendJson(res, 404, { error: 'Producto no encontrado.' });

    const body = await readBody(req);
    const db = readLocations();
    const previousLocation = db.locations[sku]?.location || null;
    const updatedBy = String(body.updatedBy || 'Sin identificar').trim() || 'Sin identificar';

    delete db.locations[sku];
    writeLocations(db);

    appendHistoryEvent({
      sku,
      product: base,
      action: 'quitar ubicación',
      before: previousLocation,
      after: null,
      updatedBy,
    });

    return sendJson(res, 200, { product: publicProduct(mergeLocation(base, db)), message: 'Ubicación eliminada.' });
  }

  if (req.method === 'POST' && url.pathname === '/api/admin/history') {
    const body = await readBody(req);
    const pin = String(body.pin || '');

    if (!ADMIN_PIN || pin !== ADMIN_PIN) {
      return sendJson(res, 401, { error: 'PIN incorrecto.' });
    }

    const q = String(body.q || '').trim().toUpperCase();
    const limit = Math.min(500, Math.max(1, Number(body.limit || 250)));
    let events = readHistory().events;

    if (q) {
      events = events.filter((event) =>
        normalizeSku(event.sku).includes(q) ||
        String(event.productName || '').toUpperCase().includes(q) ||
        String(event.updatedBy || '').toUpperCase().includes(q) ||
        String(event.beforeLabel || '').toUpperCase().includes(q) ||
        String(event.afterLabel || '').toUpperCase().includes(q)
      );
    }

    return sendJson(res, 200, {
      events: events.slice(0, limit),
      total: events.length,
    });
  }

  if (req.method === 'POST' && url.pathname === '/api/sync') {
    if (CATALOG_MODE !== 'relbase') {
      return sendJson(res, 409, { error: 'Relbase todavía no está conectado. La app está funcionando con productos de demostración.' });
    }

    try {
      const synced = await syncRelbaseProducts();
      return sendJson(res, 200, {
        message: `Sincronización completada. ${synced.products.length} productos guardados.`,
        productCount: synced.products.length,
        lastSyncAt: synced.lastSyncAt,
      });
    } catch (error) {
      console.error('Error sincronizando Relbase:', error);
      const cache = readProductCache();
      return sendJson(res, 502, {
        error: `${error.message || 'No se pudo sincronizar Relbase.'}${cache.products.length ? ` Se mantiene el caché anterior con ${cache.products.length} productos.` : ''}`,
        productCount: cache.products.length,
        lastSyncAt: cache.lastSyncAt,
      });
    }
  }

  return sendJson(res, 404, { error: 'Ruta no encontrada.' });
}

function serveStatic(res, pathname) {
  const rel = pathname === '/' ? 'index.html' : pathname.replace(/^\/+/, '');
  const file = path.normalize(path.join(PUBLIC_DIR, rel));
  if (!file.startsWith(PUBLIC_DIR)) return sendText(res, 403, 'Acceso denegado');
  if (!fs.existsSync(file) || fs.statSync(file).isDirectory()) return sendText(res, 404, 'Archivo no encontrado');

  const ext = path.extname(file).toLowerCase();
  const types = {
    '.html': 'text/html; charset=utf-8',
    '.css': 'text/css; charset=utf-8',
    '.js': 'application/javascript; charset=utf-8',
    '.png': 'image/png',
    '.ico': 'image/x-icon',
    '.json': 'application/json; charset=utf-8',
  };

  const content = fs.readFileSync(file);
  res.writeHead(200, {
    'Content-Type': types[ext] || 'application/octet-stream',
    'Content-Length': content.length,
    'Cache-Control': ext === '.html' ? 'no-store' : 'public, max-age=300',
  });
  res.end(content);
}

ensureLocationFile();
ensureHistoryFile();

const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);

    if (url.pathname.startsWith('/auth/')) return await handleAuth(req, res, url);
    if (url.pathname.startsWith('/api/')) return await handleApi(req, res, url);
    return serveStatic(res, url.pathname);
  } catch (error) {
    console.error(error);
    return sendJson(res, 500, { error: error.message || 'Error interno del servidor.' });
  }
});

server.listen(PORT, HOST, () => {
  console.log(`Crusec Bodega disponible en http://localhost:${PORT}`);
  console.log(`Catálogo: ${CATALOG_MODE}. Ubicaciones: ${LOCATIONS_FILE}`);
  console.log(`Caché productos: ${PRODUCT_CACHE_FILE}`);
});
