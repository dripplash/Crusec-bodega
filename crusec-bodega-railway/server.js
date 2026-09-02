/**
 * KORDIS · Warehouse Management System
 * Aplicación web de gestión de ubicaciones, inventario y sincronización con Relbase.
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
let XLSX = null;
function getXlsx() {
  if (!XLSX) XLSX = require('xlsx');
  return XLSX;
}

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

function envInteger(name, fallback, min, max) {
  const parsed = Number(process.env[name]);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.min(max, Math.max(min, Math.trunc(parsed)));
}

loadEnvFile();

const PORT = envInteger('PORT', 3000, 1, 65535);
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
const SYNC_INTERVAL_MINUTES = envInteger('SYNC_INTERVAL_MINUTES', 10, 1, 24 * 60);
const AUTO_SYNC_ENABLED = String(process.env.AUTO_SYNC_ENABLED || 'true').toLowerCase() !== 'false';
const AUTO_SYNC_ON_START = String(process.env.AUTO_SYNC_ON_START || 'true').toLowerCase() !== 'false';
const IS_PRODUCTION = String(process.env.NODE_ENV || '').toLowerCase() === 'production';
const APP_ACCESS_USER = String(process.env.APP_ACCESS_USER || '').trim();
const APP_ACCESS_PASSWORD = String(process.env.APP_ACCESS_PASSWORD || '');
const APP_ACCESS_ENABLED = Boolean(APP_ACCESS_USER && APP_ACCESS_PASSWORD);
const APP_ACCESS_REQUIRED = String(process.env.REQUIRE_APP_ACCESS || (IS_PRODUCTION ? 'true' : 'false')).toLowerCase() !== 'false'
  || Boolean(APP_ACCESS_USER || APP_ACCESS_PASSWORD);
const MAX_BODY_BYTES = envInteger('MAX_BODY_BYTES', 64 * 1024, 1024, 1024 * 1024);
let relbaseSyncRunning = false;
let lastRelbaseAutoSyncError = null;

let relbaseSyncProgress = {
  running: false,
  percent: 0,
  page: 0,
  totalPages: null,
  productCount: 0,
  reason: null,
  startedAt: null,
  finishedAt: null,
  error: null,
};
const MAX_AISLE = envInteger('MAX_AISLE', 6, 1, 100);
const MAX_RACK = envInteger('MAX_RACK', 11, 1, 1000);
const MAX_LEVEL = envInteger('MAX_LEVEL', 5, 1, 100);
const MAX_SECOND_FLOOR_POSITION = envInteger('MAX_SECOND_FLOOR_POSITION', 20, 1, 10000);
const ADMIN_PIN = String(process.env.ADMIN_PIN || '').trim();
const HISTORY_LIMIT = envInteger('HISTORY_LIMIT', 2000, 100, 100000);
const OAUTH_STATE_TTL_MS = 10 * 60 * 1000;
const OAUTH_STATE_COOKIE = 'kordis_oauth_state';
const UNSAFE_METHODS = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);
const ACCESS_FAILURE_WINDOW_MS = 15 * 60 * 1000;
const ACCESS_FAILURE_LIMIT = 10;
const failedAccessAttempts = new Map();

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

  return 'Sin marca';
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

  const cleanProducts = Array.isArray(products)
    ? products.filter((product) => product && product.sku)
    : [];

  const payload = {
    lastSyncAt: new Date().toISOString(),
    count: cleanProducts.length,
    products: cleanProducts,
  };

  const tmp = `${PRODUCT_CACHE_FILE}.tmp`;

  /*
   * Escribimos primero en archivo temporal.
   * Si todo sale bien, reemplazamos el caché anterior completo.
   */
  fs.writeFileSync(tmp, JSON.stringify(payload, null, 2));

  /*
   * Este rename reemplaza products-cache.json completo.
   * No mezcla con el caché anterior.
   */
  fs.renameSync(tmp, PRODUCT_CACHE_FILE);

  return payload;
}

function clearProductCache() {
  ensureDataDir();

  for (const file of [PRODUCT_CACHE_FILE, `${PRODUCT_CACHE_FILE}.tmp`]) {
    if (fs.existsSync(file)) {
      fs.rmSync(file, { force: true });
    }
  }
}

async function syncRelbaseProducts(reason = 'manual') {
  const relbase = require('./src/relbase');

  /*
   * Primero descargamos todos los productos.
   * No borramos el caché viejo antes, porque si Relbase falla
   * no queremos dejar la app sin productos.
   */
  const products = await relbase.listProducts({
    onProgress(progress) {
      relbaseSyncProgress = {
        ...relbaseSyncProgress,
        running: true,
        reason,
        page: progress.page || 0,
        totalPages: progress.totalPages || null,
        productCount: progress.productCount || 0,
        percent: progress.percent || relbaseSyncProgress.percent || 1,
        error: null,
      };
    },
  });

  /*
   * Si Relbase respondió bien y ya tenemos el catálogo completo,
   * recién ahí limpiamos y reemplazamos el caché completo.
   */
  clearProductCache();

  return writeProductCache(products);
}

async function runRelbaseSync(reason = 'manual') {
  if (relbaseSyncRunning) {
    console.log(`Sincronización Relbase omitida (${reason}): ya hay una sincronización en curso.`);

    return {
      skipped: true,
      reason: 'sync_running',
    };
  }

  relbaseSyncRunning = true;

  relbaseSyncProgress = {
    running: true,
    percent: 1,
    page: 0,
    totalPages: null,
    productCount: 0,
    reason,
    startedAt: new Date().toISOString(),
    finishedAt: null,
    error: null,
  };

  try {
    console.log(`Iniciando sincronización Relbase (${reason})...`);

    const synced = await syncRelbaseProducts(reason);

    lastRelbaseAutoSyncError = null;

    relbaseSyncProgress = {
      ...relbaseSyncProgress,
      running: false,
      percent: 100,
      productCount: synced.products.length,
      finishedAt: new Date().toISOString(),
      error: null,
    };

    console.log(
      `Sincronización Relbase (${reason}) completada: ${synced.products.length} productos.`
    );

    return synced;
  } catch (error) {
    lastRelbaseAutoSyncError = {
      message: error.message || 'No se pudo sincronizar Relbase.',
      at: new Date().toISOString(),
      reason,
    };

    relbaseSyncProgress = {
      ...relbaseSyncProgress,
      running: false,
      error: error.message || 'No se pudo sincronizar Relbase.',
      finishedAt: new Date().toISOString(),
    };

    console.error(`Error sincronizando Relbase (${reason}):`, error);

    throw error;
  } finally {
    relbaseSyncRunning = false;
  }
}

function startRelbaseAutoSync() {
  if (CATALOG_MODE !== 'relbase') {
    console.log('Sincronización automática Relbase desactivada: CATALOG_MODE no es relbase.');
    return;
  }

  if (!AUTO_SYNC_ENABLED) {
    console.log('Sincronización automática Relbase desactivada por AUTO_SYNC_ENABLED=false.');
    return;
  }

  const intervalMs = SYNC_INTERVAL_MINUTES * 60 * 1000;

  console.log(`Sincronización automática Relbase activa cada ${SYNC_INTERVAL_MINUTES} minutos.`);

  if (AUTO_SYNC_ON_START) {
    setTimeout(() => {
      runRelbaseSync('automatica_inicio').catch(() => {});
    }, 30 * 1000);
  }

  setInterval(() => {
    runRelbaseSync('automatica_intervalo').catch(() => {});
  }, intervalMs);
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


async function refreshRelbaseStockForProduct(product) {
  if (CATALOG_MODE !== 'relbase' || !product?.sku) return product;

  try {
    const relbase = require('./src/relbase');
    if (typeof relbase.findStockBySku !== 'function') return product;

    const stockResult = await relbase.findStockBySku({
      sku: product.sku,
      relbaseId: product.relbaseId,
      barcode: product.barcode,
    });

    if (!stockResult || stockResult.stock === null || stockResult.stock === undefined) {
      return product;
    }

    const updated = {
      ...product,
      stock: stockResult.stock,
      stockSource: 'relbase-stock-bodega-principal',
      stockSourceUrl: stockResult.source || null,
      stockUpdatedAt: stockResult.stockUpdatedAt || new Date().toISOString(),
    };

    /*
     * Guardamos el stock exacto en caché para que la siguiente búsqueda
     * ya muestre el valor corregido.
     */
    upsertProductCache(updated);

    return updated;
  } catch (error) {
    console.warn(`No se pudo actualizar stock por bodega para ${product.sku}:`, error.message);
    return product;
  }
}

async function refreshRelbaseStockForSmallList(products, limit = 25) {
  if (CATALOG_MODE !== 'relbase') return products;
  if (!Array.isArray(products) || products.length === 0 || products.length > limit) return products;

  return Promise.all(products.map((product) => refreshRelbaseStockForProduct(product)));
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
    stockSource: product.stockSource || null,
    updatedAt: product.updatedAt || product.stockUpdatedAt || null,
    stockUpdatedAt: product.stockUpdatedAt || product.updatedAt || null,
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

  if (!Number.isInteger(aisle) || aisle < 1 || aisle > MAX_AISLE) {
    return `El pasillo debe estar entre 1 y ${MAX_AISLE}.`;
  }
  if (!['D', 'I'].includes(side)) {
    return 'El lado debe ser D (derecho) o I (izquierdo).';
  }
  if (!Number.isInteger(rack) || rack < 1 || rack > MAX_RACK) {
    return `El rack debe estar entre 1 y ${MAX_RACK}.`;
  }
  if (!Number.isInteger(level) || level < 1 || level > MAX_LEVEL) {
    return `El nivel debe estar entre 1 y ${MAX_LEVEL}.`;
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

const SECURITY_HEADERS = {
  'Content-Security-Policy': "default-src 'self'; base-uri 'none'; object-src 'none'; frame-ancestors 'none'; img-src 'self' data:; style-src 'self' 'unsafe-inline'; script-src 'self'; connect-src 'self'; media-src 'self' blob:; manifest-src 'self'; form-action 'self'",
  'Permissions-Policy': 'camera=(self), geolocation=(), microphone=()',
  'Referrer-Policy': 'no-referrer',
  'X-Content-Type-Options': 'nosniff',
  'X-Frame-Options': 'DENY',
};

function responseHeaders(extra = {}) {
  return {
    ...SECURITY_HEADERS,
    ...(IS_PRODUCTION ? { 'Strict-Transport-Security': 'max-age=31536000' } : {}),
    ...extra,
  };
}

function constantTimeEqual(left, right) {
  const a = Buffer.from(String(left));
  const b = Buffer.from(String(right));
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

function requestUsesHttps(req) {
  const forwarded = String(req.headers['x-forwarded-proto'] || '').split(',')[0].trim();
  return forwarded === 'https' || Boolean(req.socket.encrypted);
}

function requestOriginAllowed(req) {
  const site = String(req.headers['sec-fetch-site'] || '').toLowerCase();
  if (site === 'cross-site') return false;

  const origin = req.headers.origin;
  if (!origin) return true;

  const host = String(req.headers['x-forwarded-host'] || req.headers.host || '').split(',')[0].trim();
  const protocol = requestUsesHttps(req) ? 'https:' : 'http:';

  try {
    const parsed = new URL(origin);
    return parsed.protocol === protocol && parsed.host === host;
  } catch {
    return false;
  }
}

function requestHasAppAccess(req) {
  if (!APP_ACCESS_REQUIRED) return true;

  const client = String(req.headers['x-forwarded-for'] || req.socket.remoteAddress || 'unknown').split(',')[0].trim();
  const now = Date.now();
  const previous = failedAccessAttempts.get(client);

  if (previous?.blockedUntil > now) return false;

  const reject = () => {
    const withinWindow = previous && now - previous.startedAt < ACCESS_FAILURE_WINDOW_MS;
    const attempts = withinWindow ? previous.attempts + 1 : 1;
    failedAccessAttempts.set(client, {
      attempts,
      startedAt: withinWindow ? previous.startedAt : now,
      blockedUntil: attempts >= ACCESS_FAILURE_LIMIT ? now + ACCESS_FAILURE_WINDOW_MS : 0,
    });
    return false;
  };

  if (!APP_ACCESS_ENABLED) return reject();

  const authorization = String(req.headers.authorization || '');
  if (!authorization.startsWith('Basic ')) return reject();

  try {
    const decoded = Buffer.from(authorization.slice(6), 'base64').toString('utf8');
    const separator = decoded.indexOf(':');
    if (separator < 0) return reject();

    const valid = constantTimeEqual(decoded.slice(0, separator), APP_ACCESS_USER)
      && constantTimeEqual(decoded.slice(separator + 1), APP_ACCESS_PASSWORD);

    if (valid) failedAccessAttempts.delete(client);
    return valid || reject();
  } catch {
    return reject();
  }
}

function validAdminPin(pin) {
  return Boolean(ADMIN_PIN) && constantTimeEqual(pin, ADMIN_PIN);
}

function oauthStateHash(state) {
  return crypto.createHash('sha256').update(String(state)).digest('hex');
}

function readCookie(req, name) {
  const prefix = `${name}=`;
  for (const part of String(req.headers.cookie || '').split(';')) {
    const value = part.trim();
    if (value.startsWith(prefix)) {
      try { return decodeURIComponent(value.slice(prefix.length)); } catch { return ''; }
    }
  }
  return '';
}

function oauthStateCookie(req, state, maxAgeSeconds = 600) {
  const secure = requestUsesHttps(req) ? '; Secure' : '';
  return `${OAUTH_STATE_COOKIE}=${encodeURIComponent(state)}; Path=/auth/callback; HttpOnly; SameSite=Lax; Max-Age=${maxAgeSeconds}${secure}`;
}

function writeSecureJson(file, value) {
  ensureDataDir();
  const tmp = `${file}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(value, null, 2), { encoding: 'utf8', mode: 0o600 });
  try { fs.chmodSync(tmp, 0o600); } catch {}
  fs.renameSync(tmp, file);
  try { fs.chmodSync(file, 0o600); } catch {}
}

function escapeHtml(value) {
  return String(value ?? '').replace(/[&<>"']/g, (character) => ({
    '&': '&amp;',
    '<': '&lt;',
    '>': '&gt;',
    '"': '&quot;',
    "'": '&#039;',
  }[character]));
}

function sendRedirect(res, location, headers = {}) {
  res.writeHead(302, responseHeaders({
    Location: location,
    'Cache-Control': 'no-store',
    ...headers,
  }));
  res.end();
}

function htmlPage(title, message, extra = '') {
  return `<!doctype html>
<html lang="es">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>${escapeHtml(title)}</title>
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
    <h1>${escapeHtml(title)}</h1>
    <p>${escapeHtml(message)}</p>
    ${extra}
    <a href="/">Volver a KORDIS</a>
  </main>
</body>
</html>`;
}

function readOAuthStates() {
  try {
    if (!fs.existsSync(OAUTH_STATE_FILE)) return [];
    const parsed = JSON.parse(fs.readFileSync(OAUTH_STATE_FILE, 'utf8'));

    if (Array.isArray(parsed.states)) return parsed.states;
    if (parsed.state && parsed.expiresAt) {
      return [{ hash: oauthStateHash(parsed.state), expiresAt: parsed.expiresAt }];
    }

    return [];
  } catch {
    return [];
  }
}

function writeOAuthStates(states) {
  if (!states.length) {
    try { if (fs.existsSync(OAUTH_STATE_FILE)) fs.unlinkSync(OAUTH_STATE_FILE); } catch {}
    return;
  }

  writeSecureJson(OAUTH_STATE_FILE, { states });
}

function writeOAuthState(state) {
  const now = Date.now();
  const states = readOAuthStates()
    .filter((item) => new Date(item.expiresAt).getTime() > now)
    .slice(-19);

  states.push({
    hash: oauthStateHash(state),
    createdAt: new Date(now).toISOString(),
    expiresAt: new Date(now + OAUTH_STATE_TTL_MS).toISOString(),
  });

  writeOAuthStates(states);
}

function consumeOAuthState(state) {
  const now = Date.now();
  const expectedHash = oauthStateHash(state);
  let valid = false;

  const remaining = readOAuthStates().filter((item) => {
    const current = new Date(item.expiresAt).getTime() > now;
    const matches = current && constantTimeEqual(item.hash || '', expectedHash);
    if (matches) valid = true;
    return current && !matches;
  });

  writeOAuthStates(remaining);
  return valid;
}

async function handleAuth(req, res, url) {
  const relbase = require('./src/relbase');

  if (req.method === 'GET' && url.pathname === '/auth/login') {
    if (!requestOriginAllowed(req)) {
      return sendText(res, 403, 'Origen de solicitud no permitido.');
    }

    const state = crypto.randomBytes(32).toString('hex');
    writeOAuthState(state);
    return sendRedirect(res, relbase.getAuthUrl(state), {
      'Set-Cookie': oauthStateCookie(req, state),
    });
  }

  if (req.method === 'GET' && url.pathname === '/auth/callback') {
    const error = url.searchParams.get('error');
    const errorDescription = url.searchParams.get('error_description');
    const state = url.searchParams.get('state') || '';
    const clearCookie = oauthStateCookie(req, '', 0);

    if (error) {
      if (state) consumeOAuthState(state);
      return sendText(
        res,
        400,
        htmlPage('Relbase no autorizó la conexión', errorDescription || error),
        'text/html; charset=utf-8',
        { 'Set-Cookie': clearCookie }
      );
    }

    const code = url.searchParams.get('code');
    const cookieState = readCookie(req, OAUTH_STATE_COOKIE);

    if (!code) {
      return sendText(
        res,
        400,
        htmlPage('Falta el código de autorización', 'Relbase no devolvió el código necesario para conectar.'),
        'text/html; charset=utf-8',
        { 'Set-Cookie': clearCookie }
      );
    }

    if (!state || !cookieState || !constantTimeEqual(cookieState, state) || !consumeOAuthState(state)) {
      return sendText(
        res,
        400,
        htmlPage('Autorización inválida o expirada', 'Vuelve a iniciar sesión desde /auth/login.'),
        'text/html; charset=utf-8',
        { 'Set-Cookie': clearCookie }
      );
    }

    try {
      const token = await relbase.exchangeCodeForToken(code);
      return sendText(
        res,
        200,
        htmlPage('Relbase conectado correctamente', 'La autorización fue guardada. Ahora la app puede leer productos desde Relbase.', `<pre>Token válido hasta: ${escapeHtml(token.expires_at || 'sin fecha informada')}</pre>`),
        'text/html; charset=utf-8',
        { 'Set-Cookie': clearCookie }
      );
    } catch (authError) {
      console.error('No se pudo completar OAuth con Relbase:', authError.message);
      const publicMessage = IS_PRODUCTION
        ? 'Relbase rechazó la conexión. Revisa la configuración e inténtalo nuevamente.'
        : authError.message || 'Error desconocido.';
      return sendText(
        res,
        500,
        htmlPage('No se pudo conectar Relbase', publicMessage),
        'text/html; charset=utf-8',
        { 'Set-Cookie': clearCookie }
      );
    }
  }

  return sendJson(res, 404, { error: 'Ruta auth no encontrada.' });
}

function sendJson(res, code, payload) {
  const body = JSON.stringify(payload);
  res.writeHead(code, responseHeaders({
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(body),
    'Cache-Control': 'no-store',
  }));
  res.end(body);
}

function sendText(res, code, text, type = 'text/plain; charset=utf-8', headers = {}) {
  res.writeHead(code, responseHeaders({
    'Content-Type': type,
    'Content-Length': Buffer.byteLength(text),
    'Cache-Control': 'no-store',
    ...headers,
  }));
  res.end(text);
}

async function readBody(req) {
  const chunks = [];
  let size = 0;

  for await (const chunk of req) {
    size += chunk.length;
    if (size > MAX_BODY_BYTES) {
      const error = new Error('La solicitud supera el tamaño permitido.');
      error.statusCode = 413;
      throw error;
    }
    chunks.push(chunk);
  }
  if (!chunks.length) return {};

  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } catch {
    const error = new Error('La solicitud no contiene JSON válido.');
    error.statusCode = 400;
    throw error;
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
    const stockUpdatedProduct = await refreshRelbaseStockForProduct(cachedProduct);

    return {
      product: mergeLocation(stockUpdatedProduct, locations),
      source: stockUpdatedProduct.stockSource === 'relbase-stock-bodega-principal'
        ? 'cache-stock-bodega-principal'
        : 'cache',
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

    const stockUpdatedProduct = await refreshRelbaseStockForProduct(liveProduct);
    upsertProductCache(stockUpdatedProduct);

    return {
      product: mergeLocation(stockUpdatedProduct, locations),
      source: stockUpdatedProduct.stockSource === 'relbase-stock-bodega-principal'
        ? 'relbase-live-stock-bodega-principal'
        : 'relbase-live',
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
  if (value === undefined || value === null) return '';
  if (typeof value === 'string' && /^[=+\-@]/.test(value)) return `'${value}`;
  return value;
}

function exportTypeLabel(type) {
  if (type === 'final') return 'Excel_Final';
  return 'Inventario';
}

function buildAisleExportRows(products, type) {
  if (type !== 'final') return null;

  return [
    [
      'SKU',
      'Nombre',
      'Pasillo',
      'Lado',
      'Rack',
      'Nivel',
      'Stock Relbase',
      'Pedir',
      'No Pedir',
      'Bajar Precio',
    ],

    ...products.map((product) => [
      safeExcelValue(product.sku),
      safeExcelValue(product.name),
      safeExcelValue(product.location?.aisle),
      safeExcelValue(product.location?.sideLabel),
      safeExcelValue(product.location?.rack),
      safeExcelValue(product.location?.level),
      safeExcelValue(product.stock),
      '',
      '',
      '',
    ]),
  ];
}
function workbookBufferFromRows(rows, sheetName = 'Inventario') {
  const XLSX = getXlsx();
  const workbook = XLSX.utils.book_new();
  const worksheet = XLSX.utils.aoa_to_sheet(rows);

  worksheet['!cols'] = [
  { wch: 18 }, // SKU
  { wch: 55 }, // Nombre
  { wch: 10 }, // Pasillo
  { wch: 14 }, // Lado
  { wch: 10 }, // Rack
  { wch: 10 }, // Nivel
  { wch: 16 }, // Stock Relbase
  { wch: 12 }, // Pedir
  { wch: 12 }, // No Pedir
  { wch: 15 }, // Bajar Precio
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

  res.writeHead(200, responseHeaders({
    'Content-Type': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    'Content-Disposition': `attachment; filename="${fileName}"`,
    'Content-Length': buffer.length,
    'Cache-Control': 'no-store',
  }));

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

    if (type !== 'final') {
      return sendJson(res, 400, {
        error: 'Tipo de Excel no válido.',
      });
    }

    return sendAisleExport(res, aisle, type);
  }

  if (req.method === 'POST' && url.pathname === '/api/cache/clear-products') {
    const body = await readBody(req);

    if (!ADMIN_PIN) {
      return sendJson(res, 503, { error: 'La función administrativa no está configurada.' });
    }

    if (!validAdminPin(body.pin)) {
      return sendJson(res, 401, { error: 'PIN incorrecto.' });
    }

    clearProductCache();

    relbaseSyncProgress = {
      running: false,
      percent: 0,
      page: 0,
      totalPages: null,
      productCount: 0,
      reason: 'cache_clear',
      startedAt: null,
      finishedAt: new Date().toISOString(),
      error: null,
    };

    return sendJson(res, 200, {
      message: 'Caché de productos eliminado. Sincroniza con Relbase para cargarlo nuevamente.',
    });
  }

  if (req.method === 'GET' && url.pathname === '/api/sync/progress') {
    return sendJson(res, 200, {
      ...relbaseSyncProgress,
      running: relbaseSyncRunning || relbaseSyncProgress.running,
    });
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

    const publicRelbaseStatus = relbaseStatus
      ? {
          configured: Boolean(relbaseStatus.configured),
          authorized: Boolean(relbaseStatus.authorized),
          tokenExpiresAt: relbaseStatus.tokenExpiresAt || null,
        }
      : null;

    return sendJson(res, 200, {
      relbaseEnabled: CATALOG_MODE === 'relbase',
      relbaseAuthorized: Boolean(relbaseStatus?.authorized),
      relbaseStatus: publicRelbaseStatus,
      mode: CATALOG_MODE,
      lastSyncAt: CATALOG_MODE === 'relbase' ? cache.lastSyncAt : null,
      syncStatus: getSyncStatusText(cache, relbaseStatus),
      productCount,
      syncIntervalMinutes: SYNC_INTERVAL_MINUTES,
      autoSyncEnabled: AUTO_SYNC_ENABLED,
      autoSyncOnStart: AUTO_SYNC_ON_START,
      relbaseSyncRunning,
      lastRelbaseAutoSyncError: lastRelbaseAutoSyncError
        ? { at: lastRelbaseAutoSyncError.at, reason: lastRelbaseAutoSyncError.reason }
        : null,
      syncProgress: relbaseSyncProgress,
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

  const publicResult = publicProduct(result.product);
  const syncedAt = cache.lastSyncAt || publicResult.stockUpdatedAt || publicResult.updatedAt || null;

  return sendJson(res, 200, {
    product: {
      ...publicResult,
      updatedAt: syncedAt,
      stockUpdatedAt: syncedAt,
    },
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

    if (q) {
      products = await refreshRelbaseStockForSmallList(products, 25);
      products = products.map((product) => mergeLocation(product, readLocations()));
    }

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

  if (req.method === 'GET' && url.pathname === '/api/history') {
    const sku = normalizeSku(url.searchParams.get('sku'));
    const q = String(url.searchParams.get('q') || '').trim().toUpperCase();
    const limit = Math.min(250, Math.max(1, Number(url.searchParams.get('limit') || 100)));
    let events = readHistory().events;

    if (sku) events = events.filter((event) => normalizeSku(event.sku) === sku);

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

  if (req.method === 'POST' && url.pathname === '/api/admin/history') {
    const body = await readBody(req);

    if (!ADMIN_PIN) {
      return sendJson(res, 503, { error: 'La función administrativa no está configurada.' });
    }

    if (!validAdminPin(body.pin)) {
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
      return sendJson(res, 409, {
        error: 'Relbase todavía no está conectado. La app está funcionando con productos de demostración.',
      });
    }

    try {
      const synced = await runRelbaseSync('manual');

      if (synced.skipped) {
        const cache = readProductCache();

        return sendJson(res, 202, {
          message: 'Ya hay una sincronización de Relbase en curso.',
          productCount: cache.products.length,
          lastSyncAt: cache.lastSyncAt,
          progress: relbaseSyncProgress,
        });
      }

      return sendJson(res, 200, {
        message: `Sincronización completada. ${synced.products.length} productos guardados.`,
        productCount: synced.products.length,
        lastSyncAt: synced.lastSyncAt,
        progress: relbaseSyncProgress,
      });
    } catch (error) {
      console.error('Error sincronizando Relbase:', error);

      const cache = readProductCache();

      return sendJson(res, 502, {
        error: `${error.message || 'No se pudo sincronizar Relbase.'}${cache.products.length ? ` Se mantiene el caché anterior con ${cache.products.length} productos.` : ''}`,
        productCount: cache.products.length,
        lastSyncAt: cache.lastSyncAt,
        progress: relbaseSyncProgress,
      });
    }
  }

  return sendJson(res, 404, { error: 'Ruta no encontrada.' });
}

function serveStatic(res, pathname) {
  const rel = pathname === '/' ? 'index.html' : pathname.replace(/^\/+/, '');
  const file = path.normalize(path.join(PUBLIC_DIR, rel));
  const relative = path.relative(PUBLIC_DIR, file);
  if (relative.startsWith('..') || path.isAbsolute(relative)) return sendText(res, 403, 'Acceso denegado');
  if (!fs.existsSync(file) || fs.statSync(file).isDirectory()) return sendText(res, 404, 'Archivo no encontrado');

  const ext = path.extname(file).toLowerCase();
  const types = {
    '.html': 'text/html; charset=utf-8',
    '.css': 'text/css; charset=utf-8',
    '.js': 'application/javascript; charset=utf-8',
    '.png': 'image/png',
    '.ico': 'image/x-icon',
    '.svg': 'image/svg+xml',
    '.webmanifest': 'application/manifest+json',
    '.json': 'application/json; charset=utf-8',
  };

  const content = fs.readFileSync(file);
  res.writeHead(200, responseHeaders({
    'Content-Type': types[ext] || 'application/octet-stream',
    'Content-Length': content.length,
    'Cache-Control': ext === '.html' ? 'no-store' : 'public, max-age=300',
  }));
  res.end(content);
}

ensureLocationFile();
ensureHistoryFile();

const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);

    if (req.method === 'GET' && url.pathname === '/healthz') {
      return sendText(res, 200, 'ok');
    }

    if (!requestHasAppAccess(req)) {
      return sendText(
        res,
        401,
        'Autenticación requerida.',
        'text/plain; charset=utf-8',
        { 'WWW-Authenticate': 'Basic realm="KORDIS", charset="UTF-8"' }
      );
    }

    if (UNSAFE_METHODS.has(req.method) && !requestOriginAllowed(req)) {
      return sendJson(res, 403, { error: 'Origen de solicitud no permitido.' });
    }

    if (url.pathname.startsWith('/auth/')) return await handleAuth(req, res, url);
    if (url.pathname.startsWith('/api/')) return await handleApi(req, res, url);
    return serveStatic(res, url.pathname);
  } catch (error) {
    console.error(error);
    const statusCode = Number(error.statusCode || 500);
    const message = statusCode < 500 || !IS_PRODUCTION
      ? error.message
      : 'Error interno del servidor.';
    return sendJson(res, statusCode, { error: message || 'Error interno del servidor.' });
  }
});

server.listen(PORT, HOST, () => {
  console.log(`KORDIS disponible en http://localhost:${PORT}`);
  console.log(`Catálogo: ${CATALOG_MODE}.`);

  if (APP_ACCESS_REQUIRED && !APP_ACCESS_ENABLED) {
    console.warn('Aviso de seguridad: APP_ACCESS_USER y APP_ACCESS_PASSWORD no están configurados.');
  }
  if (!ADMIN_PIN) {
    console.warn('Aviso de seguridad: ADMIN_PIN no está configurado; las funciones administrativas están desactivadas.');
  }
  startRelbaseAutoSync();
});
