const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const fs = require('node:fs');
const http = require('node:http');
const net = require('node:net');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const APP_DIR = path.join(__dirname, '..');

function freePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address();
      server.close((error) => error ? reject(error) : resolve(port));
    });
  });
}

function basicAuthorization(user, password) {
  return `Basic ${Buffer.from(`${user}:${password}`).toString('base64')}`;
}

async function waitUntilHealthy(baseUrl, child) {
  for (let attempt = 0; attempt < 80; attempt += 1) {
    if (child.exitCode !== null) throw new Error(`El servidor terminó con código ${child.exitCode}.`);

    try {
      const response = await fetch(`${baseUrl}/healthz`);
      if (response.status === 200) return;
    } catch {}

    await new Promise((resolve) => setTimeout(resolve, 50));
  }

  throw new Error('El servidor no respondió al healthcheck.');
}

function stopChild(child) {
  if (child.exitCode !== null) return Promise.resolve();

  return new Promise((resolve) => {
    child.once('exit', resolve);
    child.kill();
    setTimeout(resolve, 2000).unref();
  });
}

test('mantiene el flujo funcional y aplica las protecciones de producción', async (t) => {
  const appPort = await freePort();
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'kordis-security-test-'));
  const user = 'pruebas';
  const password = 'clave-de-pruebas-larga';
  const adminPin = 'pin-de-pruebas-largo';
  const authorization = basicAuthorization(user, password);
  let tokenRequestBody = '';
  let productRequestAuthorization = '';

  const demoProducts = JSON.parse(fs.readFileSync(path.join(APP_DIR, 'data', 'demo-products.json'), 'utf8')).products;
  fs.writeFileSync(path.join(dataDir, 'products-cache.json'), JSON.stringify({
    products: demoProducts,
    count: demoProducts.length,
    lastSyncAt: new Date().toISOString(),
  }));

  const relbaseMock = http.createServer(async (req, res) => {
    if (req.method === 'POST' && req.url === '/oauth/token') {
      const chunks = [];
      for await (const chunk of req) chunks.push(chunk);
      tokenRequestBody = Buffer.concat(chunks).toString('utf8');
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({
        access_token: 'access-token-de-prueba',
        refresh_token: 'refresh-token-de-prueba',
        token_type: 'Bearer',
        expires_in: 900,
      }));
      return;
    }

    if (req.method === 'GET' && req.url.startsWith('/api/v2/productos')) {
      productRequestAuthorization = req.headers.authorization || '';
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ products: demoProducts }));
      return;
    }

    res.writeHead(404);
    res.end();
  });

  await new Promise((resolve, reject) => {
    relbaseMock.once('error', reject);
    relbaseMock.listen(0, '127.0.0.1', resolve);
  });

  const relbasePort = relbaseMock.address().port;
  const baseUrl = `http://127.0.0.1:${appPort}`;
  const child = spawn(process.execPath, ['server.js'], {
    cwd: APP_DIR,
    env: {
      ...process.env,
      NODE_ENV: 'production',
      HOST: '127.0.0.1',
      PORT: String(appPort),
      DATA_DIR: dataDir,
      CATALOG_MODE: 'relbase',
      AUTO_SYNC_ENABLED: 'false',
      AUTO_SYNC_ON_START: 'false',
      APP_ACCESS_USER: user,
      APP_ACCESS_PASSWORD: password,
      ADMIN_PIN: adminPin,
      RELBASE_BASE_URL: `http://127.0.0.1:${relbasePort}`,
      RELBASE_CLIENT_ID: 'cliente-de-prueba',
      RELBASE_CLIENT_SECRET: 'secreto-de-prueba',
      RELBASE_REDIRECT_URI: `${baseUrl}/auth/callback`,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  let serverOutput = '';
  child.stdout.on('data', (chunk) => { serverOutput += chunk; });
  child.stderr.on('data', (chunk) => { serverOutput += chunk; });

  t.after(async () => {
    await stopChild(child);
    await new Promise((resolve) => relbaseMock.close(resolve));
    fs.rmSync(dataDir, { recursive: true, force: true });
  });

  await waitUntilHealthy(baseUrl, child);

  let response = await fetch(`${baseUrl}/api/status`);
  assert.equal(response.status, 401);
  assert.match(response.headers.get('www-authenticate') || '', /Basic/);

  response = await fetch(`${baseUrl}/api/status`, { headers: { authorization } });
  assert.equal(response.status, 200, serverOutput);
  assert.equal(response.headers.get('x-content-type-options'), 'nosniff');
  assert.equal(response.headers.get('x-frame-options'), 'DENY');
  assert.match(response.headers.get('strict-transport-security') || '', /max-age=31536000/);
  const status = await response.json();
  assert.equal(status.relbaseEnabled, true);
  assert.equal(status.relbaseStatus.configured, true);
  assert.equal('storage' in status, false);
  assert.equal('cacheFile' in status, false);

  response = await fetch(`${baseUrl}/api/debug/stock/ABC`, { headers: { authorization } });
  assert.equal(response.status, 404);

  response = await fetch(`${baseUrl}/api/products?filter=all&q=`, { headers: { authorization } });
  assert.equal(response.status, 200);
  const productsPayload = await response.json();
  assert.ok(productsPayload.products.length > 0);
  const product = productsPayload.products[0];

  response = await fetch(`${baseUrl}/api/products/${encodeURIComponent(product.sku)}/location`, {
    method: 'PUT',
    headers: {
      authorization,
      'content-type': 'application/json',
      origin: 'https://sitio-no-autorizado.example',
    },
    body: JSON.stringify({ aisle: 1, side: 'I', rack: 1, level: 1, updatedBy: 'Pruebas' }),
  });
  assert.equal(response.status, 403);

  response = await fetch(`${baseUrl}/api/products/${encodeURIComponent(product.sku)}/location`, {
    method: 'PUT',
    headers: { authorization, 'content-type': 'application/json', origin: baseUrl },
    body: JSON.stringify({ aisle: 1, side: 'I', rack: 1, level: 1, updatedBy: 'Pruebas' }),
  });
  assert.equal(response.status, 200, await response.text());

  response = await fetch(`${baseUrl}/api/history?sku=${encodeURIComponent(product.sku)}`, {
    headers: { authorization },
  });
  assert.equal(response.status, 200);
  const history = await response.json();
  assert.equal(history.events[0].updatedBy, 'Pruebas');

  response = await fetch(`${baseUrl}/api/exports/aisle?aisle=1&type=final`, {
    headers: { authorization },
  });
  assert.equal(response.status, 200);
  assert.match(response.headers.get('content-type') || '', /spreadsheetml/);
  assert.ok((await response.arrayBuffer()).byteLength > 1000);

  response = await fetch(`${baseUrl}/api/products/${encodeURIComponent(product.sku)}/location`, {
    method: 'DELETE',
    headers: { authorization, 'content-type': 'application/json', origin: baseUrl },
    body: JSON.stringify({ updatedBy: 'Pruebas' }),
  });
  assert.equal(response.status, 200, await response.text());

  response = await fetch(`${baseUrl}/api/cache/clear-products`, {
    method: 'POST',
    headers: { authorization, 'content-type': 'application/json', origin: baseUrl },
    body: JSON.stringify({ pin: 'incorrecto' }),
  });
  assert.equal(response.status, 401);

  response = await fetch(`${baseUrl}/api/cache/clear-products`, {
    method: 'POST',
    headers: { authorization, 'content-type': 'application/json', origin: baseUrl },
    body: JSON.stringify({ pin: adminPin }),
  });
  assert.equal(response.status, 200);

  response = await fetch(`${baseUrl}/api/admin/history`, {
    method: 'POST',
    headers: { authorization, 'content-type': 'application/json', origin: baseUrl },
    body: JSON.stringify({ pin: adminPin, q: product.sku }),
  });
  assert.equal(response.status, 200);

  response = await fetch(`${baseUrl}/api/admin/history`, {
    method: 'POST',
    headers: { authorization, 'content-type': 'application/json', origin: baseUrl },
    body: `"${'x'.repeat(70_000)}"`,
  });
  assert.equal(response.status, 413);

  response = await fetch(`${baseUrl}/api/admin/history`, {
    method: 'POST',
    headers: { authorization, 'content-type': 'application/json', origin: baseUrl },
    body: '{json-invalido',
  });
  assert.equal(response.status, 400);

  response = await fetch(`${baseUrl}/auth/login`, {
    headers: { authorization },
    redirect: 'manual',
  });
  assert.equal(response.status, 302);
  const location = response.headers.get('location');
  const setCookie = response.headers.get('set-cookie');
  assert.ok(location);
  assert.ok(setCookie);
  const state = new URL(location).searchParams.get('state');
  const stateFile = path.join(dataDir, 'relbase-oauth-state.json');
  assert.equal(fs.readFileSync(stateFile, 'utf8').includes(state), false);

  response = await fetch(`${baseUrl}/auth/callback?code=codigo&state=${encodeURIComponent(state)}`, {
    headers: { authorization },
  });
  assert.equal(response.status, 400);

  const cookie = setCookie.split(';', 1)[0];
  response = await fetch(`${baseUrl}/auth/callback?code=codigo&state=${encodeURIComponent(state)}`, {
    headers: { authorization, cookie },
  });
  assert.equal(response.status, 200, await response.text());
  assert.match(tokenRequestBody, /grant_type=authorization_code/);
  assert.match(tokenRequestBody, /client_secret=secreto-de-prueba/);

  const savedToken = JSON.parse(fs.readFileSync(path.join(dataDir, 'relbase-token.json'), 'utf8'));
  assert.equal(savedToken.access_token, 'access-token-de-prueba');
  assert.equal(savedToken.refresh_token, 'refresh-token-de-prueba');

  response = await fetch(`${baseUrl}/api/sync`, {
    method: 'POST',
    headers: { authorization, 'content-type': 'application/json', origin: baseUrl },
    body: '{}',
  });
  const syncText = await response.text();
  assert.equal(response.status, 200, syncText);
  const syncResult = JSON.parse(syncText);
  assert.equal(syncResult.productCount, demoProducts.length);
  assert.equal(productRequestAuthorization, 'Bearer access-token-de-prueba');
});
