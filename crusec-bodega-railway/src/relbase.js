const fs = require('fs');
const path = require('path');

const PROJECT_DATA_DIR = path.join(__dirname, '..', 'data');
const DATA_DIR = path.resolve(process.env.DATA_DIR || PROJECT_DATA_DIR);
const TOKEN_FILE = path.join(DATA_DIR, 'relbase-token.json');

const RELBASE_BASE_URL = String(process.env.RELBASE_BASE_URL || 'https://api.relbase.cl').replace(/\/+$/, '');
const RELBASE_AUTH_URL = process.env.RELBASE_AUTH_URL || `${RELBASE_BASE_URL}/oauth/authorize`;
const RELBASE_TOKEN_URL = process.env.RELBASE_TOKEN_URL || `${RELBASE_BASE_URL}/oauth/token`;
const RELBASE_PRODUCTS_URL = process.env.RELBASE_PRODUCTS_URL || `${RELBASE_BASE_URL}/api/v2/productos`;
const RELBASE_SAFETY_MAX_PAGES = Math.max(
  1000,
  Number(process.env.RELBASE_SAFETY_MAX_PAGES || 10000)
);

const RELBASE_MAIN_WAREHOUSE_ID = String(process.env.RELBASE_MAIN_WAREHOUSE_ID || '2881').trim();
function ensureDataDir() {
  fs.mkdirSync(DATA_DIR, { recursive: true });
}

function getConfig() {
  return {
    clientId: process.env.RELBASE_CLIENT_ID || '',
    clientSecret: process.env.RELBASE_CLIENT_SECRET || '',
    redirectUri: process.env.RELBASE_REDIRECT_URI || '',
    scopes: process.env.RELBASE_SCOPES || 'products:read inventory:read warehouses:read',
    authUrl: RELBASE_AUTH_URL,
    tokenUrl: RELBASE_TOKEN_URL,
    productsUrl: RELBASE_PRODUCTS_URL,
  };
}

function isConfigured() {
  const config = getConfig();
  return Boolean(config.clientId && config.clientSecret && config.redirectUri);
}

function readToken() {
  try {
    if (!fs.existsSync(TOKEN_FILE)) return null;
    return JSON.parse(fs.readFileSync(TOKEN_FILE, 'utf8'));
  } catch (error) {
    console.error('Error leyendo token Relbase:', error);
    return null;
  }
}

function saveToken(token, previous = null) {
  ensureDataDir();

  const expiresIn = Number(token.expires_in || 900);
  const expiresAt = token.expires_at || new Date(Date.now() + expiresIn * 1000).toISOString();

  const stored = {
    access_token: token.access_token,
    refresh_token: token.refresh_token || previous?.refresh_token || null,
    token_type: token.token_type || previous?.token_type || 'Bearer',
    scope: token.scope || previous?.scope || '',
    expires_in: expiresIn,
    expires_at: expiresAt,
    updated_at: new Date().toISOString(),
  };

  const tmp = `${TOKEN_FILE}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(stored, null, 2));
  fs.renameSync(tmp, TOKEN_FILE);

  return stored;
}

function tokenStillValid(token) {
  if (!token?.access_token || !token?.expires_at) return false;

  const expiresAt = new Date(token.expires_at).getTime();
  if (Number.isNaN(expiresAt)) return false;

  return expiresAt > Date.now() + 60_000;
}

async function requestToken(params) {
  const config = getConfig();

  if (!isConfigured()) {
    throw new Error('Relbase no está configurado. Revisa RELBASE_CLIENT_ID, RELBASE_CLIENT_SECRET y RELBASE_REDIRECT_URI en Railway.');
  }

  const body = new URLSearchParams({
    ...params,
    client_id: config.clientId,
    client_secret: config.clientSecret,
  });

  const response = await fetch(config.tokenUrl, {
    method: 'POST',
    headers: {
      Accept: 'application/json',
      'Content-Type': 'application/x-www-form-urlencoded',
    },
    body,
  });

  const text = await response.text();
  let payload = {};

  try {
    payload = text ? JSON.parse(text) : {};
  } catch {
    payload = { raw: text };
  }

  if (!response.ok) {
    console.error('Error token Relbase:', response.status, payload);

    const error = new Error(payload.error_description || payload.error || `Relbase rechazó la solicitud de token (${response.status}).`);
    error.status = response.status;
    error.payload = payload;
    throw error;
  }

  if (!payload.access_token) {
    console.error('Respuesta token Relbase sin access_token:', payload);
    throw new Error('Relbase no devolvió access_token.');
  }

  return payload;
}

async function exchangeCodeForToken(code) {
  const config = getConfig();

  const token = await requestToken({
    grant_type: 'authorization_code',
    code,
    redirect_uri: config.redirectUri,
  });

  return saveToken(token);
}

async function refreshAccessToken() {
  const previous = readToken();

  if (!previous?.refresh_token) {
    throw new Error('Relbase todavía no está autorizado. Entra a /auth/login para autorizar la aplicación.');
  }

  const token = await requestToken({
    grant_type: 'refresh_token',
    refresh_token: previous.refresh_token,
  });

  return saveToken(token, previous);
}

async function getValidAccessToken() {
  const current = readToken();

  if (tokenStillValid(current)) {
    return current.access_token;
  }

  const refreshed = await refreshAccessToken();
  return refreshed.access_token;
}

function getAuthUrl(state) {
  const config = getConfig();

  if (!isConfigured()) {
    throw new Error('Relbase no está configurado. Faltan variables en Railway.');
  }

  const url = new URL(config.authUrl);
  url.searchParams.set('response_type', 'code');
  url.searchParams.set('client_id', config.clientId);
  url.searchParams.set('redirect_uri', config.redirectUri);
  url.searchParams.set('scope', config.scopes);
  url.searchParams.set('state', state);

  return url.toString();
}

function status() {
  const token = readToken();

  return {
    configured: isConfigured(),
    authorized: Boolean(token?.refresh_token || token?.access_token),
    tokenExpiresAt: token?.expires_at || null,
    productsUrl: RELBASE_PRODUCTS_URL,
    safetyMaxPages: RELBASE_SAFETY_MAX_PAGES,
  };
}

function firstValue(...values) {
  for (const value of values) {
    if (value !== undefined && value !== null && String(value).trim() !== '') return value;
  }

  return '';
}

function cleanText(value) {
  return String(value ?? '')
    .trim()
    .replace(/^["']+|["']+$/g, '')
    .trim();
}

function cleanSku(value) {
  return cleanText(value).toUpperCase();
}

function nestedName(value) {
  if (!value) return '';

  if (typeof value === 'string') return value;

  if (typeof value === 'object') {
    return firstValue(
      value.nombre,
      value.name,
      value.descripcion,
      value.description,
      value.label,
      value.title
    );
  }

  return '';
}

function nestedId(value) {
  if (!value) return '';

  if (typeof value === 'string' || typeof value === 'number') return value;

  if (typeof value === 'object') {
    return firstValue(
      value.id,
      value.ware_house_id,
      value.warehouse_id,
      value.warehouseId,
      value.bodega_id,
      value.bodegaId,
      value.almacen_id,
      value.almacenId,
      value.id_bodega,
      value.idBodega
    );
  }

  return '';
}

function numberOrNull(value) {
  if (value === undefined || value === null || value === '') return null;

  const number = Number(String(value).replace(',', '.'));
  return Number.isFinite(number) ? number : null;
}

function stockValueFromItem(item) {
  return numberOrNull(firstValue(
    item.stock_disponible,
    item.stockDisponible,
    item.disponible,
    item.available,
    item.available_quantity,
    item.availableQuantity,
    item.stock_available,
    item.stockAvailable,
    item.stock,
    item.stock_total,
    item.stockTotal,
    item.cantidad,
    item.quantity,
    item.qty,
    item.saldo,
    item.balance,
    item.on_hand,
    item.onHand
  ));
}

function warehouseText(item) {
  return cleanText(firstValue(
    item.bodega_nombre,
    item.bodegaNombre,
    item.warehouse_name,
    item.warehouseName,
    item.almacen_nombre,
    item.almacenNombre,
    item.nombre_bodega,
    item.nombreBodega,
    item.ubicacion,
    item.location,
    nestedName(item.bodega),
    nestedName(item.warehouse),
    nestedName(item.almacen),
    nestedName(item.store),
    nestedName(item.location)
  )).toLowerCase();
}

function warehouseIdFromItem(item) {
  const value = firstValue(
    item.ware_house_id,
    item.warehouse_id,
    item.warehouseId,
    item.bodega_id,
    item.bodegaId,
    item.almacen_id,
    item.almacenId,
    item.id_bodega,
    item.idBodega,
    item.store_id,
    item.storeId,
    nestedId(item.bodega),
    nestedId(item.warehouse),
    nestedId(item.almacen),
    nestedId(item.store)
  );

  return cleanText(value);
}

function isMainWarehouseItem(item) {
  const configuredId = RELBASE_MAIN_WAREHOUSE_ID;
  const itemWarehouseId = warehouseIdFromItem(item);

  if (configuredId && itemWarehouseId && itemWarehouseId === configuredId) {
    return true;
  }

  const text = warehouseText(item);

  if (!text) return false;

  return (
    text.includes('bodega principal') ||
    text.includes('casa matriz') ||
    text.includes('principal')
  );
}

function stockFromMainWarehouseArray(items) {
  if (!Array.isArray(items)) return null;

  for (const item of items) {
    if (!isMainWarehouseItem(item)) continue;

    const qty = stockValueFromItem(item);
    if (qty !== null) return qty;
  }

  return null;
}

function sumStockArray(items) {
  if (!Array.isArray(items)) return null;

  let total = 0;
  let found = false;

  for (const item of items) {
    const qty = stockValueFromItem(item);

    if (qty !== null) {
      total += qty;
      found = true;
    }
  }

  return found ? total : null;
}

function detectStock(product) {
  const mainWarehouseStock =
    stockFromMainWarehouseArray(product.inventarios) ??
    stockFromMainWarehouseArray(product.inventory) ??
    stockFromMainWarehouseArray(product.inventories) ??
    stockFromMainWarehouseArray(product.stocks) ??
    stockFromMainWarehouseArray(product.bodegas) ??
    stockFromMainWarehouseArray(product.warehouses) ??
    stockFromMainWarehouseArray(product.stock_bodegas) ??
    stockFromMainWarehouseArray(product.stockBodegas);

  if (mainWarehouseStock !== null) return mainWarehouseStock;

  const availableDirect = numberOrNull(firstValue(
    product.stock_disponible,
    product.stockDisponible,
    product.disponible,
    product.available,
    product.available_quantity,
    product.availableQuantity,
    product.stock_available,
    product.stockAvailable
  ));

  if (availableDirect !== null) return availableDirect;

  const direct = numberOrNull(firstValue(
    product.stock,
    product.stock_total,
    product.stockTotal,
    product.cantidad,
    product.quantity,
    product.qty,
    product.saldo,
    product.balance,
    product.on_hand,
    product.onHand
  ));

  if (direct !== null) return direct;

  return (
    sumStockArray(product.inventarios) ??
    sumStockArray(product.inventory) ??
    sumStockArray(product.inventories) ??
    sumStockArray(product.stocks) ??
    sumStockArray(product.bodegas) ??
    sumStockArray(product.warehouses) ??
    sumStockArray(product.stock_bodegas) ??
    sumStockArray(product.stockBodegas) ??
    null
  );
}

function detectBrand(product) {
  return cleanText(firstValue(
    product.brand,
    product.marca,
    product.brand_name,
    product.brandName,
    product.marca_nombre,
    product.marcaNombre,
    nestedName(product.brand),
    nestedName(product.marca)
  ));
}

function normalizeProduct(product) {
  const sku = cleanSku(firstValue(
    product.sku,
    product.SKU,
    product.codigo,
    product.código,
    product.codigo_sku,
    product.codigoSku,
    product.codigo_producto,
    product.codigoProducto,
    product.code,
    product.internal_code,
    product.internalCode,
    product.barcode,
    product.codigo_barras,
    product.codigoBarras,
    product.codigo_barra,
    product.codigoBarra,
    product.id
  ));

  const name = cleanText(firstValue(
    product.nombre,
    product.name,
    product.descripcion,
    product.description,
    product.titulo,
    product.title,
    product.nombre_producto,
    product.nombreProducto,
    `Producto ${sku}`
  ));

  const barcode = cleanText(firstValue(
    product.barcode,
    product.codigo_barras,
    product.codigoBarras,
    product.codigoBarra,
    product.codigo_barra,
    product.ean,
    product.upc
  ));

  const brand = detectBrand(product);

  const activeValue = firstValue(
    product.active,
    product.activo,
    product.estado,
    product.status,
    true
  );

  const active = typeof activeValue === 'boolean'
    ? activeValue
    : !['false', '0', 'inactivo', 'inactive', 'disabled'].includes(String(activeValue).toLowerCase());

  return {
    relbaseId: product.id || product.relbaseId || sku,
    sku,
    name,
    barcode,
    brand,
    active,
    stock: detectStock(product),
    stockUpdatedAt: product.stockUpdatedAt || product.updated_at || product.updatedAt || product.fecha_actualizacion || null,
  };
}

function extractProducts(payload) {
  if (Array.isArray(payload)) return payload;

  if (Array.isArray(payload.products)) return payload.products;
  if (Array.isArray(payload.productos)) return payload.productos;
  if (Array.isArray(payload.resources)) return payload.resources;
  if (Array.isArray(payload.data)) return payload.data;
  if (Array.isArray(payload.items)) return payload.items;
  if (Array.isArray(payload.results)) return payload.results;

  if (payload.data && typeof payload.data === 'object') {
    if (Array.isArray(payload.data.resources)) return payload.data.resources;
    if (Array.isArray(payload.data.productos)) return payload.data.productos;
    if (Array.isArray(payload.data.products)) return payload.data.products;

    return extractProducts(payload.data);
  }

  return [];
}

function logDebugRelbase(payload, url) {
  if (global.__RELBASE_DEBUG_LOGGED__) return;

  global.__RELBASE_DEBUG_LOGGED__ = true;

  const sampleProducts = extractProducts(payload);
  const first = sampleProducts[0];

  console.log('========== DEBUG RELBASE ==========');
  console.log('URL consultada:', url);
  console.log('Campos principales de respuesta:', Object.keys(payload || {}));
  console.log('Meta:', JSON.stringify(payload?.meta || payload?.pagination || {}, null, 2));
  console.log('Cantidad en esta página:', sampleProducts.length);

  if (first) {
    console.log('Campos del primer producto:', Object.keys(first));
    console.log('Primer producto muestra:', JSON.stringify(first, null, 2).slice(0, 6000));
  } else {
    console.log('No se encontró producto de muestra en esta página.');
    console.log('Respuesta muestra:', JSON.stringify(payload, null, 2).slice(0, 6000));
  }

  console.log('======== FIN DEBUG RELBASE ========');
}

async function fetchProductsPage(url, accessToken) {
  const response = await fetch(url, {
    headers: {
      Accept: 'application/json',
      Authorization: `Bearer ${accessToken}`,
    },
  });

  const text = await response.text();
  let payload = {};

  try {
    payload = text ? JSON.parse(text) : {};
  } catch {
    payload = { raw: text };
  }

  if (!response.ok) {
    console.error('Error productos Relbase:', response.status, payload);

    const error = new Error(payload.error_description || payload.error || `Relbase rechazó la consulta de productos (${response.status}).`);
    error.status = response.status;
    error.payload = payload;
    throw error;
  }

  logDebugRelbase(payload, url);

  return payload;
}

function nextPageUrl(payload, currentUrl) {
  const directNext =
    payload?.links?.next ||
    payload?.pagination?.next ||
    payload?.meta?.next ||
    payload?.next;

  if (directNext) {
    try {
      return new URL(directNext, RELBASE_PRODUCTS_URL).toString();
    } catch {
      return null;
    }
  }

  const meta = payload?.meta || payload?.pagination || {};

  let nextPage = numberOrNull(firstValue(
    meta.next_page,
    meta.nextPage,
    meta.next
  ));

  const currentPage = numberOrNull(firstValue(
    meta.current_page,
    meta.currentPage,
    meta.page
  ));

  const totalPages = numberOrNull(firstValue(
    meta.total_pages,
    meta.totalPages,
    meta.pages
  ));

  if (nextPage === null && currentPage !== null && totalPages !== null && currentPage < totalPages) {
    nextPage = currentPage + 1;
  }

  if (nextPage === null || nextPage < 1) return null;
  if (totalPages !== null && nextPage > totalPages) return null;

  const url = new URL(currentUrl || RELBASE_PRODUCTS_URL);
  url.searchParams.set('page', String(nextPage));

  return url.toString();
}

async function listProducts(options = {}) {
  const onProgress = typeof options.onProgress === 'function'
    ? options.onProgress
    : null;

  let accessToken = await getValidAccessToken();

  let url = RELBASE_PRODUCTS_URL;
  const all = [];
  const seenUrls = new Set();
  let pageCount = 0;
  let knownTotalPages = null;

  while (url) {
    pageCount += 1;

    if (pageCount > RELBASE_SAFETY_MAX_PAGES) {
      throw new Error(
        `Relbase superó el límite de seguridad de ${RELBASE_SAFETY_MAX_PAGES} páginas. Se detuvo para proteger Railway.`
      );
    }

    if (seenUrls.has(url)) {
      throw new Error(
        'Relbase repitió una página durante la sincronización. Se detuvo para evitar un ciclo infinito.'
      );
    }

    seenUrls.add(url);

    let payload;

    try {
      payload = await fetchProductsPage(url, accessToken);
    } catch (error) {
      if (error.status === 401) {
        console.warn('Relbase respondió 401. Renovando token e intentando nuevamente...');
        const refreshed = await refreshAccessToken();
        accessToken = refreshed.access_token;
        payload = await fetchProductsPage(url, accessToken);
      } else {
        error.message = `Error sincronizando Relbase en página ${pageCount}: ${error.message}`;
        throw error;
      }
    }

    const products = extractProducts(payload);
    all.push(...products);

    const meta = payload?.meta || payload?.pagination || {};
    const totalPages = numberOrNull(firstValue(
      meta.total_pages,
      meta.totalPages,
      meta.pages,
      meta.last_page,
      meta.lastPage
    ));

    if (totalPages !== null) {
      knownTotalPages = totalPages;
    }

    let percent = 1;

    if (knownTotalPages) {
      percent = Math.min(99, Math.round((pageCount / knownTotalPages) * 100));
    } else {
      percent = Math.min(95, Math.max(1, Math.round(pageCount * 2)));
    }

    if (onProgress) {
      onProgress({
        page: pageCount,
        totalPages: knownTotalPages,
        productCount: all.length,
        percent,
      });
    }

    console.log(
      `Relbase página ${pageCount}: ${products.length} productos. Total acumulado: ${all.length}`
    );

    url = nextPageUrl(payload, url);
  }

  const normalized = all
    .map(normalizeProduct)
    .filter((product) => product.sku);

  const unique = new Map();

  for (const product of normalized) {
    unique.set(product.sku, product);
  }

  console.log(`Sincronización Relbase terminada: ${unique.size} productos únicos.`);

  if (onProgress) {
    onProgress({
      page: pageCount,
      totalPages: knownTotalPages,
      productCount: unique.size,
      percent: 100,
    });
  }

  return [...unique.values()];
}

function productMatchesSku(product, sku) {
  const normalized = normalizeProduct(product);

  return (
    normalized.sku === sku ||
    cleanSku(normalized.barcode) === sku ||
    cleanSku(normalized.relbaseId) === sku
  );
}

function buildProductLookupUrls(sku) {
  const urls = [];
  const base = new URL(RELBASE_PRODUCTS_URL);

  const addUrl = (url) => {
    const value = url.toString();
    if (!urls.includes(value)) urls.push(value);
  };

  /*
   * Intentos por filtros.
   * Si Relbase ignora alguno, no importa:
   * igual validamos que el SKU coincida exacto.
   */
  for (const key of ['sku', 'codigo', 'code', 'q', 'search', 'busqueda']) {
    const url = new URL(base.toString());
    url.searchParams.set(key, sku);
    addUrl(url);
  }

  return urls;
}

async function fetchProductLookupPayload(url, accessToken) {
  const response = await fetch(url, {
    headers: {
      Accept: 'application/json',
      Authorization: `Bearer ${accessToken}`,
    },
  });

  const text = await response.text();
  let payload = {};

  try {
    payload = text ? JSON.parse(text) : {};
  } catch {
    payload = { raw: text };
  }

  if (response.status === 404) return null;

  if (!response.ok) {
    const error = new Error(
      payload.error_description ||
      payload.error ||
      `Relbase rechazó la búsqueda puntual de producto (${response.status}).`
    );
    error.status = response.status;
    error.payload = payload;
    throw error;
  }

  return payload;
}

function singleProductCandidates(payload) {
  const candidates = [];

  if (payload && typeof payload === 'object' && !Array.isArray(payload)) {
    candidates.push(payload);

    if (payload.data && typeof payload.data === 'object' && !Array.isArray(payload.data)) {
      candidates.push(payload.data);
    }

    if (payload.product && typeof payload.product === 'object') {
      candidates.push(payload.product);
    }

    if (payload.producto && typeof payload.producto === 'object') {
      candidates.push(payload.producto);
    }

    if (payload.resource && typeof payload.resource === 'object') {
      candidates.push(payload.resource);
    }
  }

  return candidates;
}

async function findProductBySku(skuInput) {
  const sku = cleanSku(skuInput);
  if (!sku) return null;

  let accessToken = await getValidAccessToken();
  const urls = buildProductLookupUrls(sku);

  for (const url of urls) {
    let payload;

    try {
      payload = await fetchProductLookupPayload(url, accessToken);
    } catch (error) {
      if (error.status === 401) {
        console.warn('Relbase respondió 401 en búsqueda puntual. Renovando token...');
        const refreshed = await refreshAccessToken();
        accessToken = refreshed.access_token;
        payload = await fetchProductLookupPayload(url, accessToken);
      } else {
        throw error;
      }
    }

    if (!payload) continue;

    /*
     * Caso 1:
     * Relbase devuelve una lista de productos.
     */
    const products = extractProducts(payload);
    const match = products.find((product) => productMatchesSku(product, sku));

    if (match) {
      return normalizeProduct(match);
    }

    /*
     * Caso 2:
     * Relbase devuelve un solo producto como objeto,
     * o lo devuelve dentro de data/product/producto/resource.
     */
    for (const candidate of singleProductCandidates(payload)) {
      const normalized = normalizeProduct(candidate);

      if (normalized.sku && productMatchesSku(candidate, sku)) {
        return normalized;
      }
    }
  }

  return null;
}
module.exports = {
  getAuthUrl,
  exchangeCodeForToken,
  listProducts,
  findProductBySku,
  status,
};
