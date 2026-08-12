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
const state = {
  products: [],
  selectedProduct: null,
  searchedProduct: null,
  specialProduct: null,
  status: null,
  specialConfig: {
    areas: [],
    maxSecondFloorPosition: 20,
  },
  specialSelection: {
    areaKey: '',
    spotKey: '',
  },
  adminPin: '',
  historyUnlocked: false,
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

function escapeHtml(value) {
  return String(value ?? '')
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#039;');
}

function brandFromCode(code) {
  const sku = String(code || '').trim().toUpperCase();
  const prefix = sku.charAt(0);

  if (prefix === 'P') return 'Pitaya';
  if (prefix === 'Y') return 'Yozen';

  return 'Crusec';
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

function locationKind(location) {
  if (!location) return 'none';
  return location.type === 'special' ? 'special' : 'normal';
}

function showView(viewName) {
  $$('.tab').forEach((button) => {
    button.classList.toggle('active', button.dataset.view === viewName);
  });

  $$('.view').forEach((view) => {
    view.classList.remove('active');
  });

  const view = $(`#${viewName}-view`);
  if (view) {
    view.classList.add('active');
  }

  if (viewName === 'search') {
    setTimeout(() => $('#sku-search')?.focus(), 30);
  }

  if (viewName === 'special') {
    setTimeout(() => $('#special-sku-search')?.focus(), 30);
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

  if (viewName === 'special') {
    try {
      await loadSpecialBrowser();
    } catch (error) {
      showMessage($('#special-message'), error.message, 'error');
    }
  }
}

function populateSpecialBrowserFilters() {
  const areaSelect = $('#browser-area-select');

  if (!areaSelect) return;

  areaSelect.innerHTML = '<option value="">Todas las zonas</option>';

  for (const area of state.specialConfig.areas || []) {
    areaSelect.insertAdjacentHTML(
      'beforeend',
      `<option value="${escapeHtml(area.key)}">${escapeHtml(area.label)}</option>`
    );
  }

  populateSpotSelect();
}

function populateSpotSelect() {
  const areaSelect = $('#browser-area-select');
  const spotSelect = $('#browser-spot-select');

  if (!areaSelect || !spotSelect) return;

  const area = (state.specialConfig.areas || []).find((item) => item.key === areaSelect.value);

  spotSelect.innerHTML = '<option value="">Todos los lugares</option>';

  const spots = area
    ? area.spots
    : (state.specialConfig.areas || []).flatMap((item) => item.spots);

  const unique = [];
  const seen = new Set();

  for (const spot of spots) {
    const key = `${spot.key}:${spot.label}`;

    if (seen.has(key)) continue;

    seen.add(key);
    unique.push(spot);
  }

  for (const spot of unique) {
    spotSelect.insertAdjacentHTML(
      'beforeend',
      `<option value="${escapeHtml(spot.key)}">${escapeHtml(spot.label)}</option>`
    );
  }
}

async function loadStatus() {
  try {
    const status = await api('/api/status');

    state.status = status;
    state.specialConfig.areas = status.specialAreas || [];
    state.specialConfig.maxSecondFloorPosition = status.maxSecondFloorPosition || 20;

    const positionInput = $('#special-position-input');
    if (positionInput) {
      positionInput.max = state.specialConfig.maxSecondFloorPosition;
    }

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

    populateSpecialBrowserFilters();
  } catch (error) {
    const indicator = $('#connection-indicator');
    indicator.textContent = 'No conectado';
    indicator.className = 'connection-indicator error';
  }
}

async function searchProduct(searchText) {
  const message = $('#search-message');

  hideMessage(message);
  $('#search-result').classList.add('hidden');

  try {
    const { product } = await api(`/api/products/search?sku=${encodeURIComponent(searchText)}`);

    state.searchedProduct = product;
    renderSearchResult(product);
  } catch (error) {
    state.searchedProduct = null;
    showMessage(message, error.message, 'error');
  }
}

function renderUpdateMeta(product) {
  if (!product?.locationUpdatedAt && !product?.locationUpdatedBy) return '';

  const who = product.locationUpdatedBy || 'Sin identificar';
  const when = product.locationUpdatedAt ? formatDate(product.locationUpdatedAt) : 'Sin fecha';

  return `
    <p class="result-update-line">
      Última actualización: <strong>${escapeHtml(who)}</strong> · ${escapeHtml(when)}
    </p>
  `;
}

function renderNormalLocationContent(location, missing = false, product = null) {
  const aisle = missing ? '—' : escapeHtml(location.aisle);
  const side = missing ? '—' : escapeHtml(location.sideLabel);
  const rack = missing ? '—' : escapeHtml(location.rack);
  const level = missing ? '—' : escapeHtml(location.level);

  const summary = missing
    ? 'Este producto todavía no tiene una ubicación. Puedes agregarla ahora.'
    : escapeHtml(location.fullLabel);

  return `
    <div class="location-grid ${missing ? 'missing-grid' : ''}">
      <div class="location-box">
        <span>Pasillo</span>
        <strong>${aisle}</strong>
      </div>
      <div class="location-box">
        <span>Lado</span>
        <strong>${side}</strong>
      </div>
      <div class="location-box">
        <span>Rack</span>
        <strong>${rack}</strong>
      </div>
      <div class="location-box">
        <span>Nivel</span>
        <strong>${level}</strong>
      </div>
    </div>
    <p class="location-full ${missing ? 'missing-copy' : ''}">${summary}</p>
    ${renderUpdateMeta(product)}
  `;
}

function renderSpecialLocationContent(location, product = null) {
  const hasPosition = Number.isInteger(location.position);

  return `
    <div class="location-grid special-grid">
      <div class="location-box">
        <span>Zona</span>
        <strong>${escapeHtml(location.areaLabel)}</strong>
      </div>
      <div class="location-box">
        <span>Lugar</span>
        <strong>${escapeHtml(location.spotLabel)}</strong>
      </div>
      <div class="location-box">
        <span>Posición</span>
        <strong>${hasPosition ? escapeHtml(location.position) : '—'}</strong>
      </div>
    </div>
    <p class="location-full">${escapeHtml(location.fullLabel)}</p>
    ${renderUpdateMeta(product)}
  `;
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
  const content = $('#location-content');
  const editButton = $('#edit-result-button');
  const kind = locationKind(product.location);

  panel.classList.remove('missing', 'special-panel');

  if (kind === 'normal') {
    content.innerHTML = renderNormalLocationContent(product.location, false, product);
    editButton.textContent = 'Editar ubicación';
  } else if (kind === 'special') {
    panel.classList.add('special-panel');
    content.innerHTML = renderSpecialLocationContent(product.location, product);
    editButton.textContent = 'Editar ubicación especial';
  } else {
    panel.classList.add('missing');
    content.innerHTML = renderNormalLocationContent({}, true, product);
    editButton.textContent = 'Asignar ubicación';
  }

  $('#search-result').classList.remove('hidden');
}

async function openSearchedProductEditor() {
  if (!state.searchedProduct) return;

  if (locationKind(state.searchedProduct.location) === 'special') {
    showView('special');
    state.specialProduct = state.searchedProduct;
    renderSpecialProduct(state.searchedProduct);
    await loadSpecialBrowser();
    return;
  }

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

  const syncStatus = $('#sync-status');

  syncStatus.className = 'sync-status connected';

  syncStatus.innerHTML = payload.lastSyncAt
    ? `<span class="status-dot"></span><span><strong>Relbase conectado</strong><br>${state.products.length} productos en esta vista<br>Última actualización: ${formatDate(payload.lastSyncAt)}</span>`
    : `<span class="status-dot"></span><span><strong>Relbase conectado</strong><br>${state.products.length} productos en esta vista<br>Sin sincronización registrada</span>`;

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
    const specialClass = locationKind(product.location) === 'special' ? 'special' : '';

    button.innerHTML = `
      <div class="product-item-top">
        <div>
          <strong class="product-name">${escapeHtml(product.name)}</strong>
          <small class="product-sku">SKU: ${escapeHtml(product.sku)}</small>
          <small class="brand-small">Marca: ${escapeHtml(product.brand || brandFromCode(product.sku))}</small>
        </div>
        <span class="stock-chip">${escapeHtml(stockText)}</span>
      </div>
      <span class="location-chip ${product.location ? '' : 'missing'} ${specialClass}">${escapeHtml(locationText)}</span>
    `;

    button.addEventListener('click', () => selectProduct(product));

    list.appendChild(button);
  }
}

function renderNormalOptionGroup(
  containerId,
  options,
  selectedValue,
  onSelect
) {
  const container = $(`#${containerId}`);

  if (!container) return;

  container.innerHTML = '';

  for (const option of options) {
    const value = String(
      typeof option === 'object'
        ? option.value
        : option
    );

    const label =
      typeof option === 'object'
        ? option.label
        : String(option);

    const button = document.createElement('button');

    button.type = 'button';

    button.className =
      `option-button normal-option-button${
        String(selectedValue) === value
          ? ' active'
          : ''
      }`;

    button.textContent = label;

    button.addEventListener('click', () => {
      onSelect(value);
    });

    container.appendChild(button);
  }
}


function renderNormalLocationButtons() {

  // PASILLO 1 AL 6
  renderNormalOptionGroup(
    'aisle-buttons',
    [1, 2, 3, 4, 5, 6],
    $('#aisle-input').value,
    (value) => {

      $('#aisle-input').value = value;

      renderNormalLocationButtons();
    }
  );


  // LADO IZQUIERDO / DERECHO
  renderNormalOptionGroup(
    'side-buttons',
    [
      {
        value: 'I',
        label: 'Izquierdo'
      },
      {
        value: 'D',
        label: 'Derecho'
      }
    ],
    $('#side-input').value,
    (value) => {

      $('#side-input').value = value;

      renderNormalLocationButtons();
    }
  );


  // RACK 1 AL 11
  renderNormalOptionGroup(
    'rack-buttons',
    [
      1, 2, 3, 4, 5, 6,
      7, 8, 9, 10, 11
    ],
    $('#rack-input').value,
    (value) => {

      $('#rack-input').value = value;

      renderNormalLocationButtons();
    }
  );


  // NIVEL 1 AL 5
  renderNormalOptionGroup(
    'level-buttons',
    [1, 2, 3, 4, 5],
    $('#level-input').value,
    (value) => {

      $('#level-input').value = value;

      renderNormalLocationButtons();
    }
  );
}


function selectProduct(product) {

  state.selectedProduct = product;

  const assignmentCard = $('#assignment-card');

  assignmentCard.classList.remove('empty');

  $('#assignment-empty')
    .classList.add('hidden');

  $('#assignment-content')
    .classList.remove('hidden');


  // DATOS DEL PRODUCTO
  $('#assign-name').textContent =
    product.name;

  $('#assign-sku').textContent =
    `SKU: ${product.sku}`;

  $('#assign-brand').textContent =
    `Marca: ${
      product.brand ||
      brandFromCode(product.sku)
    }`;

  $('#assign-stock').textContent =
    product.stock === null ||
    product.stock === undefined
      ? '—'
      : product.stock;


  const kind =
    locationKind(product.location);

  const currentLocation =
    $('#assignment-current-location');

  currentLocation.classList.add('hidden');


  /*
   * SI YA TIENE UNA UBICACIÓN NORMAL
   * cargamos automáticamente los botones.
   */
  if (kind === 'normal') {

    $('#aisle-input').value =
      product.location.aisle || '';

    $('#side-input').value =
      product.location.side || '';

    $('#rack-input').value =
      product.location.rack || '';

    $('#level-input').value =
      product.location.level || '';


    $('#assignment-mode').textContent =
      'EDITAR UBICACIÓN DE BODEGA';

    $('#save-location-button').textContent =
      'Actualizar ubicación';
  }

  /*
   * SI NO TIENE UBICACIÓN NORMAL
   * limpiamos las opciones.
   */
  else {

    $('#aisle-input').value = '';

    $('#side-input').value = '';

    $('#rack-input').value = '';

    $('#level-input').value = '';


    $('#assignment-mode').textContent =
      'ASIGNAR UBICACIÓN DE BODEGA';

    $('#save-location-button').textContent =
      'Guardar ubicación';
  }


  /*
   * MOSTRAR UBICACIÓN ACTUAL
   */
  if (kind === 'special') {

    currentLocation.textContent =
      `Ubicación actual: ${
        product.location.fullLabel
      }. Si guardas aquí, esa ubicación especial se reemplazará.`;

    currentLocation.classList
      .remove('hidden');
  }

  else if (kind === 'normal') {

    currentLocation.textContent =
      `Ubicación actual: ${
        product.location.fullLabel
      }`;

    currentLocation.classList
      .remove('hidden');
  }


  /*
   * MOSTRAR / OCULTAR BOTÓN BORRAR
   */
  $('#delete-location-button')
    .classList.toggle(
      'hidden',
      !product.location
    );


  /*
   * CREAR BOTONES DE
   * PASILLO / LADO / RACK / NIVEL
   */
  renderNormalLocationButtons();


  /*
   * ACTUALIZAR LISTA
   */
  renderProductList();


  /*
   * EN CELULAR LLEVAR AUTOMÁTICAMENTE
   * AL FORMULARIO
   */
  setTimeout(() => {

    const isMobile =
      window.matchMedia(
        '(max-width: 860px)'
      ).matches;


    if (isMobile) {

      assignmentCard.scrollIntoView({
        behavior: 'smooth',
        block: 'start',
      });
    }

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
      loadSpecialBrowser().catch(() => {}),
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
      body: JSON.stringify({
        updatedBy: $('#updated-by-input').value,
      }),
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

function getAreaConfig(areaKey) {
  return (state.specialConfig.areas || []).find((area) => area.key === areaKey) || null;
}

function setSpecialArea(areaKey) {
  state.specialSelection.areaKey = areaKey;

  const area = getAreaConfig(areaKey);

  state.specialSelection.spotKey = area?.spots?.[0]?.key || '';

  renderSpecialAreaButtons();
  renderSpecialSpotButtons();
  syncBrowserWithSpecialSelection();
}

function setSpecialSpot(spotKey) {
  state.specialSelection.spotKey = spotKey;

  renderSpecialSpotButtons();
  toggleSpecialPositionInput();
  syncBrowserWithSpecialSelection();
}

function renderSpecialAreaButtons() {
  const wrap = $('#special-area-buttons');

  if (!wrap) return;

  wrap.innerHTML = '';

  for (const area of state.specialConfig.areas || []) {
    const button = document.createElement('button');

    button.type = 'button';
    button.className = `option-button${state.specialSelection.areaKey === area.key ? ' active' : ''}`;
    button.textContent = area.label;

    button.addEventListener('click', () => setSpecialArea(area.key));

    wrap.appendChild(button);
  }
}

function renderSpecialSpotButtons() {
  const wrap = $('#special-spot-buttons');

  if (!wrap) return;

  wrap.innerHTML = '';

  const area = getAreaConfig(state.specialSelection.areaKey);

  if (!area) return;

  for (const spot of area.spots || []) {
    const button = document.createElement('button');

    button.type = 'button';
    button.className = `option-button${state.specialSelection.spotKey === spot.key ? ' active' : ''}`;
    button.textContent = spot.label;

    button.addEventListener('click', () => setSpecialSpot(spot.key));

    wrap.appendChild(button);
  }

  toggleSpecialPositionInput();
}

function toggleSpecialPositionInput() {
  const show = state.specialSelection.areaKey === 'SEGUNDO_PISO' && state.specialSelection.spotKey === 'PISO';

  $('#special-position-wrap').classList.toggle('hidden', !show);

  if (!show) {
    $('#special-position-input').value = '';
  }
}

function renderSpecialProduct(product) {
  state.specialProduct = product;

  $('#special-product-placeholder').classList.add('hidden');
  $('#special-product-card').classList.remove('hidden');

  $('#special-name').textContent = product.name;
  $('#special-sku').textContent = `SKU: ${product.sku}`;
  $('#special-brand').textContent = `Marca: ${product.brand || brandFromCode(product.sku)}`;
  $('#special-stock').textContent = product.stock === null || product.stock === undefined ? '—' : product.stock;

  const kind = locationKind(product.location);

  if (kind === 'special') {
    $('#special-current-location').textContent = `Ubicación actual: ${product.location.fullLabel}`;
    state.specialSelection.areaKey = product.location.areaKey;
    state.specialSelection.spotKey = product.location.spotKey;
    $('#special-position-input').value = product.location.position || '';
  } else if (kind === 'normal') {
    $('#special-current-location').textContent = `Ubicación actual: ${product.location.fullLabel}. Si guardas aquí, esta ubicación de bodega se reemplazará.`;
    state.specialSelection.areaKey = 'PIEZA_1';
    state.specialSelection.spotKey = 'ESTANTE_1';
    $('#special-position-input').value = '';
  } else {
    $('#special-current-location').textContent = 'Este producto todavía no tiene una ubicación.';
    state.specialSelection.areaKey = 'PIEZA_1';
    state.specialSelection.spotKey = 'ESTANTE_1';
    $('#special-position-input').value = '';
  }

  $('#delete-special-button').classList.toggle('hidden', !product.location);

  renderSpecialAreaButtons();
  renderSpecialSpotButtons();
  syncBrowserWithSpecialSelection();
}

async function searchSpecialProduct(searchText) {
  hideMessage($('#special-message'));

  try {
    const { product } = await api(`/api/products/search?sku=${encodeURIComponent(searchText)}`);

    renderSpecialProduct(product);
  } catch (error) {
    state.specialProduct = null;
    showMessage($('#special-message'), error.message, 'error');
  }
}

function syncBrowserWithSpecialSelection() {
  const areaSelect = $('#browser-area-select');
  const spotSelect = $('#browser-spot-select');

  if (!areaSelect || !spotSelect) return;

  if (state.specialSelection.areaKey) {
    areaSelect.value = state.specialSelection.areaKey;
    populateSpotSelect();

    if (state.specialSelection.spotKey) {
      spotSelect.value = state.specialSelection.spotKey;
    }
  }
}

async function saveSpecialLocation() {
  if (!state.specialProduct) return;

  hideMessage($('#special-message'));

  const payload = {
    areaKey: state.specialSelection.areaKey,
    spotKey: state.specialSelection.spotKey,
    position: $('#special-position-input').value,
    updatedBy: $('#special-updated-by-input').value,
  };

  try {
    const result = await api(`/api/products/${encodeURIComponent(state.specialProduct.sku)}/special-location`, {
      method: 'PUT',
      body: JSON.stringify(payload),
    });

    state.specialProduct = result.product;

    if (state.searchedProduct?.sku === result.product.sku) {
      state.searchedProduct = result.product;
      renderSearchResult(result.product);
    }

    renderSpecialProduct(result.product);

    showMessage($('#special-message'), `${result.message} ${result.product.location.fullLabel}`, 'success');

    await Promise.all([
      loadProducts().catch(() => {}),
      loadSpecialBrowser(),
    ]);
  } catch (error) {
    showMessage($('#special-message'), error.message, 'error');
  }
}

async function deleteSpecialLocation() {
  if (!state.specialProduct) return;

  const accepted = confirm(`¿Quitar la ubicación actual de ${state.specialProduct.sku}?`);

  if (!accepted) return;

  try {
    const result = await api(`/api/products/${encodeURIComponent(state.specialProduct.sku)}/special-location`, {
      method: 'DELETE',
      body: JSON.stringify({
        updatedBy: $('#special-updated-by-input').value,
      }),
    });

    state.specialProduct = result.product;

    if (state.searchedProduct?.sku === result.product.sku) {
      state.searchedProduct = result.product;
      renderSearchResult(result.product);
    }

    renderSpecialProduct(result.product);

    showMessage($('#special-message'), result.message, 'success');

    await Promise.all([
      loadProducts().catch(() => {}),
      loadSpecialBrowser(),
    ]);
  } catch (error) {
    showMessage($('#special-message'), error.message, 'error');
  }
}

async function loadSpecialBrowser() {
  const areaSelect = $('#browser-area-select');
  const spotSelect = $('#browser-spot-select');

  if (!areaSelect || !spotSelect) return;

  const areaKey = areaSelect.value;
  const spotKey = spotSelect.value;

  const payload = await api(`/api/special-locations?areaKey=${encodeURIComponent(areaKey)}&spotKey=${encodeURIComponent(spotKey)}`);

  $('#special-product-count').textContent = payload.products.length;

  const list = $('#special-browser-list');

  list.innerHTML = '';

  if (!payload.products.length) {
    list.innerHTML = '<p class="muted">No hay productos en esa ubicación especial.</p>';
    return;
  }

  for (const product of payload.products) {
    const item = document.createElement('button');

    item.type = 'button';
    item.className = 'browser-item';

    item.innerHTML = `
      <div>
        <strong>${escapeHtml(product.name)}</strong>
        <small>SKU: ${escapeHtml(product.sku)}</small>
        <small>${escapeHtml(product.location?.fullLabel || 'Sin ubicación')}</small>
      </div>
      <span class="stock-chip">${escapeHtml(product.stock ?? '—')}</span>
    `;

    item.addEventListener('click', () => {
      renderSpecialProduct(product);

      if (window.matchMedia('(max-width: 860px)').matches) {
        $('.special-assignment-card').scrollIntoView({
          behavior: 'smooth',
          block: 'start',
        });
      }
    });

    list.appendChild(item);
  }
}

function openHiddenAdmin() {
  hideMessage($('#search-message'));

  showView('history');

  $('#history-pin-input').value = '';
  $('#history-message').className = 'message hidden';

  setTimeout(() => $('#history-pin-input').focus(), 40);
}

async function loadHistory() {
  const pin = state.adminPin || $('#history-pin-input').value.trim();
  const q = $('#history-search').value.trim();

  const payload = await api('/api/admin/history', {
    method: 'POST',
    body: JSON.stringify({
      pin,
      q,
      limit: 300,
    }),
  });

  state.adminPin = pin;
  state.historyUnlocked = true;

  $('#history-content').classList.remove('hidden');

  renderHistory(payload.events);
}

function renderHistory(events) {
  const list = $('#history-list');

  list.innerHTML = '';

  const actionFilter = $('#history-action-filter')?.value || '';

  const filteredEvents = actionFilter
    ? events.filter((event) => String(event.action || '').toLowerCase().includes(actionFilter.replaceAll('-', ' ')))
    : events;

  if (!filteredEvents.length) {
    list.innerHTML = '<p class="muted">No hay registros para mostrar.</p>';
    return;
  }

  for (const event of filteredEvents) {
    const item = document.createElement('article');

    item.className = 'history-item';

    item.innerHTML = `
      <div class="history-item-top">
        <div>
          <strong>${escapeHtml(event.sku)}</strong>
          <small>${escapeHtml(event.productName || 'Producto sin nombre')}</small>
          <small>Modificado por: ${escapeHtml(event.updatedBy || 'Sin identificar')}</small>
        </div>
        <span class="history-badge">${escapeHtml(event.action || 'cambio')}</span>
      </div>

      <small>${escapeHtml(formatDate(event.createdAt))}</small>

      <div class="history-change-grid">
        <div class="history-change-box">
          <span>Antes</span>
          <p>${escapeHtml(event.beforeLabel || 'Sin ubicación')}</p>
        </div>
        <div class="history-change-box">
          <span>Después</span>
          <p>${escapeHtml(event.afterLabel || 'Sin ubicación')}</p>
        </div>
      </div>
    `;

    list.appendChild(item);
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
      return showMessage($('#search-message'), 'Debes ingresar un SKU o nombre del producto.', 'warning');
    }

    if (code === 'ADMIN') {
      $('#sku-search').value = '';
      openHiddenAdmin();
      return;
    }

    searchProduct(code);
  });

  $('#sku-search').addEventListener('input', (event) => {
    event.target.value = event.target.value.toUpperCase();
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

  $('#special-search-form').addEventListener('submit', (event) => {
    event.preventDefault();

    const code = $('#special-sku-search').value.trim().toUpperCase();

    $('#special-sku-search').value = code;

    if (!code) {
      return showMessage($('#special-message'), 'Debes ingresar un SKU.', 'warning');
    }

    searchSpecialProduct(code);
  });

  $('#special-sku-search').addEventListener('input', (event) => {
    event.target.value = event.target.value.toUpperCase().replace(/\s+/g, '');
  });

  $('#save-special-button').addEventListener('click', saveSpecialLocation);
  $('#delete-special-button').addEventListener('click', deleteSpecialLocation);

  $('#browser-area-select').addEventListener('change', async () => {
    populateSpotSelect();
    await loadSpecialBrowser();
  });

  $('#browser-spot-select').addEventListener('change', loadSpecialBrowser);
  $('#refresh-special-browser').addEventListener('click', loadSpecialBrowser);

  $('#history-back-button').addEventListener('click', () => setView('search'));

  $('#history-pin-form').addEventListener('submit', async (event) => {
    event.preventDefault();

    hideMessage($('#history-message'));

    try {
      await loadHistory();
      showMessage($('#history-message'), 'Historial desbloqueado.', 'success');
    } catch (error) {
      state.adminPin = '';
      state.historyUnlocked = false;
      $('#history-content').classList.add('hidden');
      showMessage($('#history-message'), error.message, 'error');
    }
  });

  $('#history-search').addEventListener('input', debounce(async () => {
    if (!state.historyUnlocked) return;

    try {
      await loadHistory();
    } catch (error) {
      showMessage($('#history-message'), error.message, 'error');
    }
  }, 250));

  $('#history-action-filter').addEventListener('change', async () => {
    if (!state.historyUnlocked) return;

    try {
      await loadHistory();
    } catch (error) {
      showMessage($('#history-message'), error.message, 'error');
    }
  });

  $('#refresh-history-button').addEventListener('click', async () => {
    if (!state.historyUnlocked) return;

    try {
      await loadHistory();
    } catch (error) {
      showMessage($('#history-message'), error.message, 'error');
    }
  });
}

setupEvents();
configureKeyboardFlow();
loadStatus();
