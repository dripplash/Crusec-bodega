const state = {
  products: [],
  selectedProduct: null,
  searchedProduct: null,
  status: null,
};

const $ = (selector) => document.querySelector(selector);
const $$ = (selector) => [...document.querySelectorAll(selector)];

function formatDate(value) {
  if (!value) return 'Sin sincronizar';

  const date = new Date(value);

  if (Number.isNaN(date.getTime())) return 'Sin información';

  return new Intl.DateTimeFormat('es-CL', {
    dateStyle: 'short',
    timeStyle: 'medium',
  }).format(date);
}

function showMessage(element, message, type = 'error') {
  element.textContent = message;
  element.className = `message ${type}`;
}

function hideMessage(element) {
  element.textContent = '';
  element.className = 'message hidden';
}

async function api(path, options = {}) {
  const headers = { ...(options.headers || {}) };

  if (options.body && !headers['Content-Type']) {
    headers['Content-Type'] = 'application/json';
  }

  const response = await fetch(path, {
    ...options,
    headers,
  });

  const payload = await response.json().catch(() => ({}));

  if (!response.ok) {
    const error = new Error(payload.error || payload.message || `Error ${response.status}`);
    error.status = response.status;
    throw error;
  }

  return payload;
}

function showView(viewName) {
  $$('.tab').forEach((button) => {
    button.classList.toggle('active', button.dataset.view === viewName);
  });

  $$('.view').forEach((view) => {
    view.classList.remove('active');
  });

  $(`#${viewName}-view`).classList.add('active');

  if (viewName === 'search') {
    setTimeout(() => $('#sku-search').focus(), 30);
  }
}

async function setView(viewName) {
  showView(viewName);

  if (viewName === 'admin') {
    try {
      await loadProducts();
    } catch (error) {
      showMessage($('#admin-message'), error.message, 'error');
    }
  }
}

async function loadStatus() {
  try {
    const status = await api('/api/status');

    state.status = status;

    const indicator = $('#connection-indicator');

    if (status.relbaseEnabled && status.relbaseAuthorized) {
      indicator.textContent = `Relbase conectado · ${status.productCount || 0} productos guardados`;
      indicator.className = 'connection-indicator connected';
    } else if (status.relbaseEnabled) {
      indicator.textContent = 'Relbase pendiente de autorización';
      indicator.className = 'connection-indicator demo';
    } else {
      indicator.textContent = 'Modo demostración · Relbase aún no está conectado';
      indicator.className = 'connection-indicator demo';
    }
  } catch (error) {
    const indicator = $('#connection-indicator');
indicator.textContent = 'No conectado';
indicator.className = 'connection-indicator error';
  }
}

async function searchProduct(sku) {
  const message = $('#search-message');

  hideMessage(message);
  $('#search-result').classList.add('hidden');

  try {
    const { product } = await api(`/api/products/search?sku=${encodeURIComponent(sku)}`);

    state.searchedProduct = product;
    renderSearchResult(product);
  } catch (error) {
    state.searchedProduct = null;
    showMessage(message, error.message, 'error');
  }
}

function renderSearchResult(product) {
  $('#result-name').textContent = product.name;
  $('#result-sku').textContent = `SKU: ${product.sku}`;
  $('#result-brand').textContent = `Marca: ${product.brand || brandFromCode(product.sku)}`;
  $('#result-stock').textContent = product.stock === null || product.stock === undefined ? '—' : `${product.stock}`;

  $('#result-stock-time').textContent = product.stockUpdatedAt
    ? `Actualizado: ${formatDate(product.stockUpdatedAt)}`
    : 'Stock no informado por Relbase';

  const panel = $('#location-panel');
  const editButton = $('#edit-result-button');

  if (product.location) {
    panel.classList.remove('missing');

    $('#result-aisle').textContent = product.location.aisle;
    $('#result-side').textContent = product.location.sideLabel;
    $('#result-rack').textContent = product.location.rack;
    $('#result-level').textContent = product.location.level;
    $('#result-location-full').textContent = product.location.fullLabel;

    editButton.textContent = 'Editar ubicación';
  } else {
    panel.classList.add('missing');

    $('#result-aisle').textContent = '—';
    $('#result-side').textContent = '—';
    $('#result-rack').textContent = '—';
    $('#result-level').textContent = '—';
    $('#result-location-full').textContent = 'Este producto todavía no tiene una ubicación. Puedes agregarla ahora.';

    editButton.textContent = 'Asignar ubicación';
  }

  $('#search-result').classList.remove('hidden');
}

async function openSearchedProductEditor() {
  if (!state.searchedProduct) return;

  $('#admin-filter').value = 'all';
  $('#admin-search').value = state.searchedProduct.sku;

  showView('admin');

  await loadProducts();

  const product = state.products.find((item) => item.sku === state.searchedProduct.sku) || state.searchedProduct;

  selectProduct(product);
}

async function loadProducts() {
  const filter = $('#admin-filter').value;
  const q = $('#admin-search').value.trim();

  const payload = await api(`/api/products?filter=${encodeURIComponent(filter)}&q=${encodeURIComponent(q)}`);

  state.products = payload.products;

  const statusText = payload.lastSyncAt
    ? `● Relbase conectado\n${state.products.length} productos en esta vista\nÚltima actualización: ${formatDate(payload.lastSyncAt)}`
    : `● Relbase conectado\n${state.products.length} productos en esta vista\nSin sincronización registrada`;

  $('#sync-status').textContent = statusText;

  renderProductList();
}

function renderProductList() {
  const list = $('#product-list');

  list.innerHTML = '';
  $('#product-count').textContent = state.products.length;

  if (!state.products.length) {
    list.innerHTML = '<p class="muted">No hay productos para este filtro.</p>';
    return;
  }

  for (const product of state.products) {
    const button = document.createElement('button');

    button.type = 'button';
    button.className = `product-item${state.selectedProduct?.sku === product.sku ? ' selected' : ''}`;

    const stockText = product.stock === null || product.stock === undefined ? 'Stock —' : `Stock ${product.stock}`;
    const locationText = product.location ? product.location.fullLabel : 'Sin ubicación';
    const brand = product.brand || brandFromCode(product.sku);

    button.innerHTML = `
      <div class="product-item-top">
        <div>
          <strong class="product-name">${escapeHtml(product.name)}</strong>
          <small class="product-sku">SKU: ${escapeHtml(product.sku)}</small>
          <small class="brand-small">Marca: ${escapeHtml(brand)}</small>
        </div>
        <span class="stock-chip">${escapeHtml(stockText)}</span>
      </div>
      <span class="location-chip ${product.location ? '' : 'missing'}">${escapeHtml(locationText)}</span>
    `;

    button.addEventListener('click', () => selectProduct(product));

    list.appendChild(button);
  }
}

function brandFromCode(code) {
  const sku = String(code || '').trim().toUpperCase();
  const prefix = sku.charAt(0);

  if (prefix === 'P') return 'Pitaya';
  if (prefix === 'Y') return 'Yozen';

  return 'Crusec';
}

function escapeHtml(value) {
  return String(value ?? '')
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#039;');
}

function selectProduct(product) {
  state.selectedProduct = product;

  const assignmentCard = $('#assignment-card');

  assignmentCard.classList.remove('empty');
  $('#assignment-empty').classList.add('hidden');
  $('#assignment-content').classList.remove('hidden');

  $('#assign-name').textContent = product.name;
  $('#assign-sku').textContent = `SKU: ${product.sku}`;
  $('#assign-brand').textContent = `Marca: ${product.brand || brandFromCode(product.sku)}`;
  $('#assign-stock').textContent = product.stock === null || product.stock === undefined ? '—' : product.stock;

  $('#aisle-input').value = product.location?.aisle || '';
  $('#side-input').value = product.location?.side || '';
  $('#rack-input').value = product.location?.rack || '';
  $('#level-input').value = product.location?.level || '';

  $('#assignment-mode').textContent = product.location ? 'EDITAR UBICACIÓN' : 'ASIGNAR UBICACIÓN';
  $('#save-location-button').textContent = product.location ? 'Actualizar ubicación' : 'Guardar ubicación';
  $('#delete-location-button').classList.toggle('hidden', !product.location);

  renderProductList();

  setTimeout(() => {
    const isMobile = window.matchMedia('(max-width: 860px)').matches;

    if (isMobile) {
      assignmentCard.scrollIntoView({
        behavior: 'smooth',
        block: 'start',
      });
    }

    $('#aisle-input').focus();
    $('#aisle-input').select();
  }, 80);
}

function clearSelection() {
  state.selectedProduct = null;

  $('#assignment-content').classList.add('hidden');
  $('#assignment-empty').classList.remove('hidden');
  $('#assignment-card').classList.add('empty');

  renderProductList();
}

async function saveLocation() {
  if (!state.selectedProduct) return;

  const message = $('#admin-message');

  hideMessage(message);

  const previousSku = state.selectedProduct.sku;

  const payload = {
    aisle: $('#aisle-input').value,
    side: $('#side-input').value,
    rack: $('#rack-input').value,
    level: $('#level-input').value,
    updatedBy: $('#updated-by-input').value,
  };

  try {
    const result = await api(`/api/products/${encodeURIComponent(previousSku)}/location`, {
      method: 'PUT',
      body: JSON.stringify(payload),
    });

    showMessage(message, `${result.message} ${result.product.location.fullLabel}`, 'success');

    if (state.searchedProduct?.sku === previousSku) {
      state.searchedProduct = result.product;
      renderSearchResult(result.product);
    }

    await loadProducts();

    clearSelection();

    if (window.matchMedia('(max-width: 860px)').matches) {
      $('#product-list').scrollIntoView({
        behavior: 'smooth',
        block: 'start',
      });
    }
  } catch (error) {
    showMessage(message, error.message, 'error');
  }
}

function configureKeyboardFlow() {
  const flow = [
    $('#aisle-input'),
    $('#side-input'),
    $('#rack-input'),
    $('#level-input'),
  ];

  flow.forEach((input, index) => {
    input.addEventListener('keydown', (event) => {
      if (event.key !== 'Enter') return;

      event.preventDefault();

      if (!input.value.trim()) return;

      if (index < flow.length - 1) {
        flow[index + 1].focus();
        flow[index + 1].select();
      } else {
        saveLocation();
      }
    });
  });

  $('#side-input').addEventListener('input', (event) => {
    event.target.value = event.target.value.toUpperCase().replace(/[^DI]/g, '').slice(0, 1);
  });
}

async function syncRelbase() {
  const button = $('#sync-button');
  const message = $('#admin-message');

  hideMessage(message);

  button.disabled = true;
  button.textContent = 'Sincronizando…';

  try {
    const result = await api('/api/sync', {
      method: 'POST',
    });

    showMessage(message, result.message, 'success');

    await Promise.all([
      loadProducts(),
      loadStatus(),
    ]);
  } catch (error) {
    showMessage(message, error.message, error.status === 409 ? 'warning' : 'error');
  } finally {
    button.disabled = false;
    button.textContent = 'Sincronizar con Relbase';
  }
}

async function deleteLocation() {
  if (!state.selectedProduct) return;

  const sku = state.selectedProduct.sku;
  const accepted = confirm(`¿Quitar la ubicación actual de ${sku}? Después podrá asignarse nuevamente.`);

  if (!accepted) return;

  const message = $('#admin-message');

  try {
    const result = await api(`/api/products/${encodeURIComponent(sku)}/location`, {
      method: 'DELETE',
    });

    showMessage(message, result.message, 'success');

    if (state.searchedProduct?.sku === sku) {
      state.searchedProduct = result.product;
      renderSearchResult(result.product);
    }

    await loadProducts();

    clearSelection();
  } catch (error) {
    showMessage(message, error.message, 'error');
  }
}

function debounce(fn, delay) {
  let timer;

  return (...args) => {
    clearTimeout(timer);
    timer = setTimeout(() => fn(...args), delay);
  };
}

function setupEvents() {
  $$('.tab').forEach((button) => {
    button.addEventListener('click', () => setView(button.dataset.view));
  });

  $('#search-form').addEventListener('submit', (event) => {
    event.preventDefault();

    const code = $('#sku-search').value.trim().toUpperCase();

    $('#sku-search').value = code;

    if (!code) {
      return showMessage($('#search-message'), 'Debes ingresar un SKU.', 'warning');
    }

    searchProduct(code);
  });

  $('#sku-search').addEventListener('input', (event) => {
    event.target.value = event.target.value.toUpperCase().replace(/\s+/g, '');
  });

  $('#admin-search').addEventListener('input', (event) => {
    const cursor = event.target.selectionStart;

    event.target.value = event.target.value.toUpperCase();
    event.target.setSelectionRange(cursor, cursor);
  });

  $('#edit-result-button').addEventListener('click', openSearchedProductEditor);

  $('#assignment-form').addEventListener('submit', (event) => {
    event.preventDefault();
    saveLocation();
  });

  $('#admin-filter').addEventListener('change', async () => {
    clearSelection();
    await loadProducts();
  });

  $('#admin-search').addEventListener('input', debounce(loadProducts, 250));
  $('#refresh-button').addEventListener('click', loadProducts);
  $('#sync-button').addEventListener('click', syncRelbase);
  $('#delete-location-button').addEventListener('click', deleteLocation);
}

setupEvents();
configureKeyboardFlow();
loadStatus();
