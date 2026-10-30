const app = document.getElementById('app');
let currentUser = null;
let toastTimer;
let productFilters = {
  q: '',
  category: 'all',
  stock: 'all',
  status: 'active',
  sort: 'newest',
  page: 1
};
let productRequestId = 0;
let productSearchTimer;
let recordsRequestId = 0;
let recordsSearchTimer;
let recordsView = {
  type: 'orders',
  q: '',
  status: 'all',
  page: 1
};

async function api(path, options = {}) {
  const response = await fetch(path, {
    credentials: 'same-origin',
    ...options,
    headers: {
      ...(options.body ? { 'Content-Type': 'application/json' } : {}),
      ...options.headers
    }
  });
  const result = await response.json().catch(() => ({}));
  if (!response.ok) {
    const error = new Error(result.error || `Request failed (${response.status})`);
    error.status = response.status;
    throw error;
  }
  return result;
}

function showNotice(message, isError = true) {
  const notice = document.getElementById('notice');
  if (!notice) return;
  notice.textContent = message;
  notice.classList.toggle('notice-error', isError);
  notice.classList.toggle('notice-success', !isError);
}

function showToast(message) {
  let toast = document.querySelector('.toast');
  if (!toast) {
    toast = document.createElement('div');
    toast.className = 'toast';
    toast.setAttribute('role', 'status');
    document.body.append(toast);
  }
  toast.textContent = message;
  toast.hidden = false;
  window.clearTimeout(toastTimer);
  toastTimer = window.setTimeout(() => {
    toast.hidden = true;
  }, 3500);
}

function renderLogin(setupRequired = false, message = '') {
  app.innerHTML = `
    <section class="login-wrap">
      <div class="login-card">
        <div class="login-heading">
          <span class="brand-mark" aria-hidden="true">R</span>
          <div>
            <h1>ResAirBD Admin</h1>
            <p>Sign in to manage your store</p>
          </div>
        </div>
        ${setupRequired ? `
          <p class="setup-note">
            No active owner account is configured. Create or reset it from the server with
            <code>ADMIN_USERNAME</code> and a strong <code>ADMIN_PASSWORD</code>, then run
            <code>npm run bootstrap-admin</code>. Never put the password in this page.
          </p>
        ` : `
          <form id="login-form">
            <label class="field">
              Username
              <input name="username" autocomplete="username" required maxlength="100">
            </label>
            <label class="field">
              Password
              <input name="password" type="password" autocomplete="current-password" required maxlength="256">
            </label>
            <button class="button button-full" type="submit">Sign in</button>
          </form>
        `}
        <p id="notice" class="notice" role="alert">${escapeText(message)}</p>
      </div>
    </section>
  `;

  const form = document.getElementById('login-form');
  if (form) form.addEventListener('submit', login);
}

function escapeText(value) {
  const element = document.createElement('span');
  element.textContent = value == null ? '' : String(value);
  return element.innerHTML;
}

async function login(event) {
  event.preventDefault();
  const form = event.currentTarget;
  const data = new FormData(form);
  const button = form.querySelector('button[type="submit"]');
  button.disabled = true;

  try {
    const result = await api('/api/auth/login', {
      method: 'POST',
      body: JSON.stringify({
        username: data.get('username'),
        password: data.get('password')
      })
    });
    currentUser = result.user;
    await renderDashboard();
  } catch (error) {
    showNotice(error.message);
    button.disabled = false;
  }
}

function createElement(tag, className, text) {
  const element = document.createElement(tag);
  if (className) element.className = className;
  if (text !== undefined) element.textContent = text;
  return element;
}

function renderShell() {
  app.innerHTML = `
    <div class="admin-layout">
      <aside class="sidebar">
        <div class="brand">
          <span class="brand-mark" aria-hidden="true">R</span>
          <span>ResAirBD<small>Store administration</small></span>
        </div>
        <p class="nav-label">Workspace</p>
        <nav aria-label="Admin navigation">
          <ul class="nav-list">
            <li><button class="nav-item" data-page="dashboard" aria-current="page"><span aria-hidden="true">▦</span>Dashboard</button></li>
            <li><button class="nav-item" data-page="products"><span aria-hidden="true">▤</span>Products</button></li>
            <li><button class="nav-item" data-page="records"><span aria-hidden="true">▣</span>Orders & bookings</button></li>
            ${currentUser.role === 'owner' ? '<li><button class="nav-item" data-page="sliders"><span aria-hidden="true">▧</span>Sliders</button></li>' : ''}
            ${currentUser.role === 'owner' ? '<li><button class="nav-item" data-page="settings"><span aria-hidden="true">⚙</span>Settings</button></li>' : ''}
            ${currentUser.role === 'owner' ? '<li><button class="nav-item" data-page="activity"><span aria-hidden="true">◷</span>Activity</button></li>' : ''}
          </ul>
        </nav>
        <div class="sidebar-foot">Changes made here are recorded in the admin activity log.</div>
      </aside>
      <section class="main-area">
        <header class="topbar">
          <div>
            <h1 id="page-title">Dashboard</h1>
            <p id="page-subtitle">A quick view of your store activity</p>
          </div>
          <div class="account-actions">
            <span class="account-name">${escapeText(currentUser.username)} · ${escapeText(currentUser.role)}</span>
            <button class="button button-secondary" id="change-password">Change password</button>
            <button class="button button-secondary" id="logout">Sign out</button>
          </div>
        </header>
        <main class="content" id="page-content"></main>
      </section>
    </div>
  `;

  document.getElementById('logout').addEventListener('click', logout);
  document.getElementById('change-password').addEventListener('click', renderChangePassword);
  app.querySelectorAll('[data-page]').forEach(button => {
    button.addEventListener('click', () => {
      if (button.dataset.page === 'activity') renderActivity();
      else if (button.dataset.page === 'products') renderProducts();
      else if (button.dataset.page === 'records') renderOrdersBookings();
      else if (button.dataset.page === 'sliders') renderSliders();
      else if (button.dataset.page === 'settings') renderSettings();
      else renderDashboard();
    });
  });
}

function setPageHeading(title, subtitle, pageKey = title.toLowerCase()) {
  document.getElementById('page-title').textContent = title;
  document.getElementById('page-subtitle').textContent = subtitle;
  app.querySelectorAll('[data-page]').forEach(button => {
    button.setAttribute('aria-current', button.dataset.page === pageKey ? 'page' : 'false');
  });
}

function createStat(label, value) {
  const card = createElement('article', 'stat-card');
  card.append(createElement('span', '', label), createElement('strong', '', value));
  return card;
}

function makePanel(title, actionText, onAction) {
  const panel = createElement('section', 'panel');
  const heading = createElement('div', 'panel-heading');
  heading.append(createElement('h2', '', title));
  if (actionText) {
    const button = createElement('button', 'button button-secondary', actionText);
    button.type = 'button';
    button.addEventListener('click', onAction);
    heading.append(button);
  }
  panel.append(heading);
  return panel;
}

function renderDataRows(container, rows, emptyText, getMain, getStatus, getDate) {
  if (!rows || rows.length === 0) {
    container.append(createElement('div', 'empty-state', emptyText));
    return;
  }
  const list = createElement('div', 'data-list');
  for (const row of rows) {
    const item = createElement('article', 'data-row');
    const main = createElement('div', 'data-main');
    const primary = getMain(row);
    main.append(createElement('strong', '', primary.title));
    if (primary.detail) main.append(createElement('span', '', primary.detail));
    item.append(main);
    if (getStatus) item.append(createElement('span', 'status-pill', getStatus(row)));
    if (getDate) item.append(createElement('time', 'data-time', formatDate(getDate(row))));
    list.append(item);
  }
  container.append(list);
}

function formatDate(value) {
  if (!value) return '—';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return '—';
  return new Intl.DateTimeFormat('en-BD', {
    dateStyle: 'medium',
    timeStyle: 'short',
    timeZone: 'Asia/Dhaka'
  }).format(date);
}

async function renderDashboard() {
  if (!document.querySelector('.admin-layout')) renderShell();
  setPageHeading('Dashboard', 'A quick view of your store activity');
  const content = document.getElementById('page-content');
  content.replaceChildren(createElement('div', 'empty-state', 'Loading dashboard…'));

  try {
    const data = await api('/api/analytics/overview');
    content.replaceChildren();

    const stats = createElement('section', 'stats-grid');
    stats.setAttribute('aria-label', 'Store summary');
    stats.append(
      createStat('Products', data.products?.total ?? 0),
      createStat('In stock', data.products?.inStock ?? 0),
      createStat('Orders', data.orders?.total ?? 0),
      createStat('New requests', data.bookings?.new ?? 0)
    );
    content.append(stats);

    const orders = makePanel('Recent orders', null);
    renderDataRows(
      orders,
      data.recentOrders,
      'No orders have been recorded yet.',
      row => ({ title: row.order_id || 'Order', detail: `৳${Number(row.grand_total || 0).toLocaleString('en-BD')}` }),
      row => row.status || 'pending',
      row => row.created_at
    );
    content.append(orders);

    const bookings = makePanel('Recent service requests', null);
    renderDataRows(
      bookings,
      data.recentBookings,
      'No service requests have been recorded yet.',
      row => ({ title: row.type || 'Service request', detail: row.booking_id || '' }),
      row => row.status || 'new',
      row => row.created_at
    );
    content.append(bookings);

    const note = createElement(
      'p',
      'muted',
      'Traffic and revenue summaries will appear here after their data sources are connected and verified.'
    );
    content.append(note);
  } catch (error) {
    if (error.status === 401) {
      currentUser = null;
      renderLogin(false, 'Your session expired. Please sign in again.');
      return;
    }
    content.replaceChildren(createElement('div', 'empty-state', `Dashboard could not be loaded: ${error.message}`));
  }
}

function addSelectOption(select, value, label) {
  const option = document.createElement('option');
  option.value = value;
  option.textContent = label;
  select.append(option);
}

function formatPrice(value) {
  return `৳${Number(value || 0).toLocaleString('en-BD')}`;
}

function createFilterSelect(labelText, value, options, onChange) {
  const label = createElement('label', 'filter-field');
  label.append(createElement('span', '', labelText));
  const select = document.createElement('select');
  select.className = 'filter-select';
  for (const [optionValue, optionLabel] of options) {
    addSelectOption(select, optionValue, optionLabel);
  }
  select.value = value;
  select.addEventListener('change', event => onChange(event.target.value));
  label.append(select);
  return label;
}

async function renderProducts() {
  setPageHeading('Products', 'Search, edit, and archive your product catalog', 'products');
  const content = document.getElementById('page-content');
  const requestId = ++productRequestId;
  content.replaceChildren(createElement('div', 'empty-state', 'Loading products…'));

  try {
    const query = new URLSearchParams({
      q: productFilters.q,
      category: productFilters.category,
      stock: productFilters.stock,
      status: productFilters.status,
      sort: productFilters.sort,
      page: String(productFilters.page),
      limit: '20'
    });
    const [result, categoryResult] = await Promise.all([
      api(`/api/products/manage?${query}`),
      api('/api/categories')
    ]);
    if (requestId !== productRequestId) return;

    content.replaceChildren();
    const toolbar = createElement('section', 'product-toolbar');
    const searchLabel = createElement('label', 'product-search');
    searchLabel.append(createElement('span', '', 'Search products'));
    const search = document.createElement('input');
    search.type = 'search';
    search.placeholder = 'Name, category, or product ID';
    search.value = productFilters.q;
    search.maxLength = 120;
    search.setAttribute('aria-label', 'Search products');
    search.addEventListener('input', event => {
      productFilters.q = event.target.value;
      productFilters.page = 1;
      window.clearTimeout(productSearchTimer);
      productSearchTimer = window.setTimeout(renderProducts, 250);
    });
    searchLabel.append(search);
    toolbar.append(searchLabel);

    const categories = categoryResult.categories || [];
    toolbar.append(
      createFilterSelect('Category', productFilters.category, [
        ['all', 'All categories'],
        ...categories.map(category => [category.name, category.name])
      ], value => {
        productFilters.category = value;
        productFilters.page = 1;
        renderProducts();
      }),
      createFilterSelect('Availability', productFilters.stock, [
        ['all', 'All stock'],
        ['in-stock', 'In stock'],
        ['out-of-stock', 'Out of stock']
      ], value => {
        productFilters.stock = value;
        productFilters.page = 1;
        renderProducts();
      }),
      createFilterSelect('Catalog', productFilters.status, [
        ['active', 'Active'],
        ['archived', 'Archived'],
        ['all', 'All products']
      ], value => {
        productFilters.status = value;
        productFilters.page = 1;
        renderProducts();
      }),
      createFilterSelect('Sort by', productFilters.sort, [
        ['newest', 'Recently added'],
        ['oldest', 'Oldest first'],
        ['name_asc', 'Name A–Z'],
        ['price_asc', 'Lowest price'],
        ['price_desc', 'Highest price']
      ], value => {
        productFilters.sort = value;
        renderProducts();
      })
    );

    const actions = createElement('div', 'product-actions');
    const count = createElement(
      'p',
      'muted product-count',
      `${result.total} product${result.total === 1 ? '' : 's'}`
    );
    actions.append(count);
    if (currentUser.role === 'owner') {
      const categoryButton = createElement('button', 'button button-secondary', 'Manage categories');
      categoryButton.type = 'button';
      categoryButton.addEventListener('click', () => openCategoryManager(categories));
      const addButton = createElement('button', 'button', 'Add product');
      addButton.type = 'button';
      addButton.addEventListener('click', () => openProductEditor(null, categories));
      actions.append(categoryButton, addButton);
    }
    toolbar.append(actions);
    content.append(toolbar);

    const panel = createElement('section', 'panel products-panel');
    const tableWrap = createElement('div', 'table-scroll');
    const table = document.createElement('table');
    table.className = 'product-table';
    const head = document.createElement('thead');
    const headerRow = document.createElement('tr');
    for (const label of ['Product', 'Category', 'Price', 'Original price', 'Availability', 'Actions']) {
      const th = createElement('th', '', label);
      th.scope = 'col';
      headerRow.append(th);
    }
    head.append(headerRow);
    const tbody = document.createElement('tbody');

    if (!result.products.length) {
      const emptyRow = document.createElement('tr');
      const emptyCell = createElement('td', 'table-empty', 'No products match these filters.');
      emptyCell.colSpan = 6;
      emptyRow.append(emptyCell);
      tbody.append(emptyRow);
    } else {
      for (const product of result.products) {
        const row = document.createElement('tr');
        const productCell = createElement('td', 'product-name-cell');
        const thumbnail = document.createElement('img');
        thumbnail.src = product.image || 'assets/logo-white-bg.png';
        thumbnail.alt = '';
        thumbnail.loading = 'lazy';
        thumbnail.onerror = () => { thumbnail.src = '/assets/logo-white-bg.png'; };
        const productName = createElement('span', 'product-name');
        productName.append(
          createElement('strong', '', product.name),
          createElement('small', '', `ID ${product.id}`)
        );
        productCell.append(thumbnail, productName);
        row.append(
          productCell,
          createElement('td', '', product.category),
          createElement('td', 'price-cell', formatPrice(product.price)),
          createElement('td', '', formatPrice(product.originalPrice)),
          createElement(
            'td',
            '',
            product.active === false ? 'Archived' : product.inStock ? 'In stock' : 'Out of stock'
          )
        );

        const actionCell = createElement('td', 'product-row-actions');
        if (currentUser.role === 'owner') {
          const editButton = createElement('button', 'button button-secondary button-small', 'Edit');
          editButton.type = 'button';
          editButton.addEventListener('click', () => openProductEditor(product, categories));
          actionCell.append(editButton);
          const archiveButton = createElement(
            'button',
            product.active === false ? 'button button-small' : 'button button-danger button-small',
            product.active === false ? 'Restore' : 'Archive'
          );
          archiveButton.type = 'button';
          archiveButton.addEventListener('click', () => toggleProductArchive(product));
          actionCell.append(archiveButton);
        } else {
          actionCell.append(createElement('span', 'muted', 'Read only'));
        }
        row.append(actionCell);
        tbody.append(row);
      }
    }

    table.append(head, tbody);
    tableWrap.append(table);
    panel.append(tableWrap);
    content.append(panel);

    const pagination = createElement('div', 'pagination-controls');
    const previous = createElement('button', 'button button-secondary', 'Previous');
    previous.type = 'button';
    previous.disabled = result.page <= 1;
    previous.addEventListener('click', () => {
      productFilters.page = Math.max(1, result.page - 1);
      renderProducts();
    });
    const pageLabel = createElement(
      'span',
      '',
      `Page ${result.page} of ${Math.max(1, result.totalPages)}`
    );
    const next = createElement('button', 'button button-secondary', 'Next');
    next.type = 'button';
    next.disabled = result.page >= result.totalPages;
    next.addEventListener('click', () => {
      productFilters.page = result.page + 1;
      renderProducts();
    });
    pagination.append(previous, pageLabel, next);
    content.append(pagination);
  } catch (error) {
    if (requestId !== productRequestId) return;
    if (error.status === 401) {
      currentUser = null;
      renderLogin(false, 'Your session expired. Please sign in again.');
      return;
    }
    content.replaceChildren(createElement('div', 'empty-state', `Products could not be loaded: ${error.message}`));
  }
}

async function renderOrdersBookings(type = recordsView.type) {
  recordsView.type = type;
  setPageHeading('Orders & bookings', 'Review customer orders and service requests', 'records');
  const content = document.getElementById('page-content');
  const requestId = ++recordsRequestId;
  const statuses = type === 'orders'
    ? ['pending', 'confirmed', 'processing', 'delivered', 'cancelled']
    : ['new', 'contacted', 'in_service', 'completed', 'cancelled'];
  if (recordsView.status !== 'all' && !statuses.includes(recordsView.status)) {
    recordsView.status = 'all';
  }
  content.replaceChildren(createElement('div', 'empty-state', 'Loading customer requests…'));

  try {
    const query = new URLSearchParams({
      q: recordsView.q,
      status: recordsView.status,
      page: String(recordsView.page),
      limit: '20'
    });
    const endpoint = type === 'orders' ? '/api/orders' : '/api/bookings';
    const result = await api(`${endpoint}?${query}`);
    if (requestId !== recordsRequestId) return;
    const rows = type === 'orders' ? result.orders : result.bookings;

    content.replaceChildren();
    const toolbar = createElement('section', 'records-toolbar');
    const tabs = createElement('div', 'record-tabs');
    for (const [viewType, label] of [['orders', 'Orders'], ['bookings', 'Service requests']]) {
      const tab = createElement(
        'button',
        `button ${type === viewType ? '' : 'button-secondary'}`,
        label
      );
      tab.type = 'button';
      tab.setAttribute('aria-pressed', String(type === viewType));
      tab.addEventListener('click', () => {
        recordsView.page = 1;
        renderOrdersBookings(viewType);
      });
      tabs.append(tab);
    }

    const searchLabel = createElement('label', 'product-search record-search');
    searchLabel.append(createElement('span', '', type === 'orders'
      ? 'Search orders'
      : 'Search service requests'));
    const search = document.createElement('input');
    search.type = 'search';
    search.placeholder = type === 'orders'
      ? 'Order ID, customer, or phone'
      : 'Request ID, service, customer, or phone';
    search.value = recordsView.q;
    search.maxLength = 120;
    search.addEventListener('input', event => {
      recordsView.q = event.target.value;
      recordsView.page = 1;
      window.clearTimeout(recordsSearchTimer);
      recordsSearchTimer = window.setTimeout(() => renderOrdersBookings(type), 250);
    });
    searchLabel.append(search);

    const statusFilter = createFilterSelect(
      'Status',
      recordsView.status,
      [['all', 'All statuses'], ...statuses.map(status => [status, status.replaceAll('_', ' ')])],
      value => {
        recordsView.status = value;
        recordsView.page = 1;
        renderOrdersBookings(type);
      }
    );
    const count = createElement(
      'p',
      'muted product-count',
      `${result.total} ${type === 'orders' ? 'order' : 'request'}${result.total === 1 ? '' : 's'}`
    );
    toolbar.append(tabs, searchLabel, statusFilter, count);
    content.append(toolbar);

    const panel = createElement('section', 'panel products-panel');
    const tableWrap = createElement('div', 'table-scroll');
    const table = document.createElement('table');
    table.className = 'product-table records-table';
    const head = document.createElement('thead');
    const header = document.createElement('tr');
    const labels = type === 'orders'
      ? ['Order', 'Customer', 'Total', 'Status', 'Placed', 'Actions']
      : ['Request', 'Customer', 'Service', 'Status', 'Received', 'Actions'];
    for (const label of labels) {
      const cell = createElement('th', '', label);
      cell.scope = 'col';
      header.append(cell);
    }
    head.append(header);
    const body = document.createElement('tbody');
    if (!rows.length) {
      const row = document.createElement('tr');
      const cell = createElement('td', 'table-empty', `No ${type === 'orders' ? 'orders' : 'service requests'} match these filters.`);
      cell.colSpan = labels.length;
      row.append(cell);
      body.append(row);
    } else {
      for (const record of rows) {
        const row = document.createElement('tr');
        const identifier = type === 'orders' ? record.orderId : record.bookingId;
        row.append(
          createElement('td', 'record-reference', identifier),
          createElement(
            'td',
            '',
            `${record.customer.name} · ${record.customer.phone}`
          ),
          createElement(
            'td',
            '',
            type === 'orders' ? formatPrice(record.grandTotal) : record.type
          ),
          createElement('td', '', record.status.replaceAll('_', ' ')),
          createElement('td', '', formatDate(record.createdAt))
        );

        const actions = createElement('td', 'record-actions');
        const details = createElement('button', 'button button-secondary button-small', 'Details');
        details.type = 'button';
        details.addEventListener('click', () => showRecordDetails(record, type));
        const statusSelect = document.createElement('select');
        statusSelect.className = 'filter-select record-status-select';
        statusSelect.setAttribute('aria-label', `Update ${identifier} status`);
        for (const status of statuses) {
          addSelectOption(statusSelect, status, status.replaceAll('_', ' '));
        }
        statusSelect.value = record.status;
        const update = createElement('button', 'button button-small', 'Save');
        update.type = 'button';
        update.addEventListener('click', async () => {
          update.disabled = true;
          try {
            const route = type === 'orders' ? 'orders' : 'bookings';
            await api(`/api/${route}/${encodeURIComponent(record.id)}/status`, {
              method: 'PATCH',
              body: JSON.stringify({ status: statusSelect.value })
            });
            showToast('Status updated.');
            await renderOrdersBookings(type);
          } catch (error) {
            showToast(error.message);
            update.disabled = false;
          }
        });
        actions.append(details, statusSelect, update);
        row.append(actions);
        body.append(row);
      }
    }
    table.append(head, body);
    tableWrap.append(table);
    panel.append(tableWrap);
    content.append(panel);

    const pagination = createElement('div', 'pagination-controls');
    const previous = createElement('button', 'button button-secondary', 'Previous');
    previous.type = 'button';
    previous.disabled = result.page <= 1;
    previous.addEventListener('click', () => {
      recordsView.page = Math.max(1, result.page - 1);
      renderOrdersBookings(type);
    });
    const pageLabel = createElement(
      'span',
      '',
      `Page ${result.page} of ${Math.max(1, result.totalPages)}`
    );
    const next = createElement('button', 'button button-secondary', 'Next');
    next.type = 'button';
    next.disabled = result.page >= result.totalPages;
    next.addEventListener('click', () => {
      recordsView.page = result.page + 1;
      renderOrdersBookings(type);
    });
    pagination.append(previous, pageLabel, next);
    content.append(pagination);
  } catch (error) {
    if (requestId !== recordsRequestId) return;
    if (error.status === 401) {
      currentUser = null;
      renderLogin(false, 'Your session expired. Please sign in again.');
      return;
    }
    content.replaceChildren(createElement('div', 'empty-state', `Customer records could not be loaded: ${error.message}`));
  }
}

function showRecordDetails(record, type) {
  const dialog = document.createElement('dialog');
  dialog.className = 'editor-dialog record-dialog';
  const section = createElement('section', 'category-manager');
  const heading = createElement('div', 'editor-heading');
  const title = document.createElement('div');
  const identifier = type === 'orders' ? record.orderId : record.bookingId;
  title.append(
    createElement('p', 'nav-label', type === 'orders' ? 'Order details' : 'Service request'),
    createElement('h2', '', identifier)
  );
  const closeButton = createElement('button', 'icon-button', '×');
  closeButton.type = 'button';
  closeButton.setAttribute('aria-label', 'Close details');
  heading.append(title, closeButton);
  section.append(heading);

  const details = createElement('div', 'record-detail-list');
  const detailRows = [
    ['Customer', record.customer.name],
    ['Phone', record.customer.phone],
    [type === 'orders' ? 'Delivery address' : 'Service area', record.customer.address],
    ['Status', record.status.replaceAll('_', ' ')],
    ['Received', formatDate(record.createdAt)]
  ];
  if (record.customer.altPhone) detailRows.push(['Alternative phone', record.customer.altPhone]);
  if (record.customer.area) detailRows.push(['Delivery location', record.customer.area]);
  if (type === 'orders') {
    detailRows.push(
      ['Payment', record.paymentMethod],
      ['Subtotal', formatPrice(record.subtotal)],
      ['Delivery', formatPrice(record.deliveryFee)],
      ['Total', formatPrice(record.grandTotal)]
    );
  } else {
    detailRows.push(['Service', record.type]);
  }
  if (record.customer.notes || record.details) {
    detailRows.push(['Notes', record.customer.notes || record.details]);
  }
  for (const [label, value] of detailRows) {
    const row = createElement('div', 'record-detail-row');
    row.append(createElement('span', '', label), createElement('strong', '', value || '—'));
    details.append(row);
  }
  section.append(details);

  if (type === 'orders') {
    const itemsHeading = createElement('h3', 'record-items-heading', 'Items');
    section.append(itemsHeading);
    const items = createElement('div', 'record-items');
    for (const item of record.items) {
      const itemRow = createElement('div', 'record-item');
      itemRow.append(
        createElement('span', '', `${item.name} × ${item.qty}`),
        createElement('strong', '', formatPrice(item.price * item.qty))
      );
      items.append(itemRow);
    }
    section.append(items);
  }

  dialog.append(section);
  document.body.append(dialog);
  const close = () => dialog.close();
  closeButton.addEventListener('click', close);
  dialog.addEventListener('close', () => dialog.remove(), { once: true });
  dialog.addEventListener('click', event => {
    if (event.target === dialog) close();
  });
  dialog.showModal();
}

async function renderSliders() {
  if (currentUser.role !== 'owner') return;
  setPageHeading('Hero slides', 'Manage the public storefront carousel', 'sliders');
  const content = document.getElementById('page-content');
  content.replaceChildren(createElement('div', 'empty-state', 'Loading hero slides…'));
  try {
    const result = await api('/api/sliders?all=true');
    content.replaceChildren();
    const toolbar = createElement('section', 'records-toolbar slider-toolbar');
    toolbar.append(
      createElement('p', 'muted product-count', `${result.slides.length} slide${result.slides.length === 1 ? '' : 's'}`)
    );
    const addButton = createElement('button', 'button', 'Add slide');
    addButton.type = 'button';
    addButton.addEventListener('click', () => openSlideEditor(null));
    toolbar.append(addButton);
    content.append(toolbar);

    if (!result.slides.length) {
      content.append(createElement('section', 'panel empty-state', 'No slides yet. Add one to show a hero carousel.'));
      return;
    }

    const list = createElement('section', 'slide-list');
    for (const slide of result.slides) {
      const card = createElement('article', 'slide-card');
      const image = document.createElement('img');
      image.className = 'slide-thumbnail';
      image.src = slide.bannerImage || '/assets/logo-white-bg.png';
      image.alt = '';
      image.loading = 'lazy';
      image.onerror = () => { image.src = '/assets/logo-white-bg.png'; };
      const details = createElement('div', 'slide-card-details');
      details.append(
        createElement('span', 'status-pill', `${slide.isActive ? 'Active' : 'Inactive'} · ${slide.slideType.replace('_', ' ')}`),
        createElement('strong', '', slide.title || `Hero slide ${slide.slideOrder}`),
        createElement('span', 'muted', `Position ${slide.slideOrder}${slide.badgeText ? ` · ${slide.badgeText}` : ''}`)
      );
      const actions = createElement('div', 'category-row-actions');
      const edit = createElement('button', 'button button-secondary button-small', 'Edit');
      edit.type = 'button';
      edit.addEventListener('click', () => openSlideEditor(slide));
      const toggle = createElement(
        'button',
        slide.isActive ? 'button button-danger button-small' : 'button button-small',
        slide.isActive ? 'Disable' : 'Enable'
      );
      toggle.type = 'button';
      toggle.addEventListener('click', () => updateSlide(slide, { isActive: !slide.isActive }));
      const remove = createElement('button', 'button button-danger button-small', 'Delete');
      remove.type = 'button';
      remove.addEventListener('click', async () => {
        if (!window.confirm(`Permanently delete "${slide.title || `Slide ${slide.slideOrder}`}“?`)) return;
        try {
          await api(`/api/sliders/${slide.id}`, { method: 'DELETE' });
          showToast('Slide deleted.');
          await renderSliders();
        } catch (error) {
          showToast(error.message);
        }
      });
      actions.append(edit, toggle, remove);
      card.append(image, details, actions);
      list.append(card);
    }
    content.append(list);
  } catch (error) {
    if (error.status === 401) {
      currentUser = null;
      renderLogin(false, 'Your session expired. Please sign in again.');
      return;
    }
    content.replaceChildren(createElement('div', 'empty-state', `Slides could not be loaded: ${error.message}`));
  }
}

function openSlideEditor(slide) {
  if (currentUser.role !== 'owner') return;
  const dialog = document.createElement('dialog');
  dialog.className = 'editor-dialog slide-editor-dialog';
  const form = document.createElement('form');
  form.className = 'editor-form';
  form.innerHTML = `
    <div class="editor-heading">
      <div><p class="nav-label">Storefront carousel</p><h2>${slide ? 'Edit slide' : 'Add slide'}</h2></div>
      <button class="icon-button" type="button" aria-label="Close editor">×</button>
    </div>
    <div class="editor-fields"></div>
    <div class="editor-actions">
      <button class="button button-secondary" type="button" data-cancel>Cancel</button>
      <button class="button" type="submit">${slide ? 'Save changes' : 'Add slide'}</button>
    </div>
  `;
  const fields = form.querySelector('.editor-fields');
  const selectField = createElement('label', 'field', 'Slide type');
  const typeSelect = document.createElement('select');
  typeSelect.name = 'slideType';
  addSelectOption(typeSelect, 'content', 'Content slide');
  addSelectOption(typeSelect, 'image_banner', 'Image banner');
  typeSelect.value = slide?.slideType || 'content';
  selectField.append(typeSelect);
  fields.append(
    selectField,
    createField('Display order', 'slideOrder', slide?.slideOrder ?? 1, 'number', { required: true, min: 1, maxLength: 4 }),
    createField('Title', 'title', slide?.title || '', 'text', { required: true, maxLength: 240 }),
    createField('Badge / eyebrow', 'badgeText', slide?.badgeText || '', 'text', { maxLength: 160 }),
    createField('Description', 'subtitle', slide?.subtitle || '', 'text', { multiline: true, rows: 3, maxLength: 2000 }),
    createField('Banner / visual image path', 'bannerImage', slide?.bannerImage || '', 'text', { maxLength: 1000 }),
    createField('Banner click URL (optional)', 'bannerLink', slide?.bannerLink || '', 'text', { maxLength: 2000 }),
    createField('Primary button label', 'primaryBtnText', slide?.primaryBtnText || '', 'text', { maxLength: 80 }),
    createField('Primary button URL or rental action', 'primaryBtnLink', slide?.primaryBtnLink || '', 'text', { maxLength: 2000 }),
    createField('Secondary button label', 'secondaryBtnText', slide?.secondaryBtnText || '', 'text', { maxLength: 80 }),
    createField('Secondary button URL or rental action', 'secondaryBtnLink', slide?.secondaryBtnLink || '', 'text', { maxLength: 2000 }),
    createField('Background color / gradient', 'bgGradient', slide?.bgGradient || '#0284c7', 'text', { maxLength: 240 })
  );
  const uploadField = createElement('div', 'field', 'Upload slide image');
  const uploadInput = document.createElement('input');
  uploadInput.type = 'file';
  uploadInput.accept = 'image/png,image/jpeg,image/webp';
  uploadInput.setAttribute('aria-label', 'Upload slide image');
  const uploadButton = createElement('button', 'button button-secondary', 'Upload and optimize image');
  uploadButton.type = 'button';
  uploadField.append(uploadInput, uploadButton);
  fields.append(uploadField);
  const imageField = form.elements.bannerImage;
  const syncImageRequirement = () => {
    imageField.required = typeSelect.value === 'image_banner';
  };
  typeSelect.addEventListener('change', syncImageRequirement);
  syncImageRequirement();
  const activeLabel = createElement('label', 'checkbox-field');
  const activeInput = document.createElement('input');
  activeInput.type = 'checkbox';
  activeInput.checked = slide ? slide.isActive : true;
  activeLabel.append(activeInput, createElement('span', '', 'Show this slide on the storefront'));
  fields.append(activeLabel);

  const close = () => dialog.close();
  form.querySelector('.icon-button').addEventListener('click', close);
  form.querySelector('[data-cancel]').addEventListener('click', close);
  uploadButton.addEventListener('click', async () => {
    if (!uploadInput.files.length) {
      showToast('Choose an image file first.');
      return;
    }
    uploadButton.disabled = true;
    try {
      const data = new FormData();
      data.append('image', uploadInput.files[0]);
      const response = await fetch('/api/upload', { method: 'POST', credentials: 'same-origin', body: data });
      const result = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(result.error || `Upload failed (${response.status})`);
      form.elements.bannerImage.value = result.url;
      showToast('Slide image uploaded.');
    } catch (error) {
      showToast(error.message);
    } finally {
      uploadButton.disabled = false;
    }
  });
  form.addEventListener('submit', async event => {
    event.preventDefault();
    if (!form.reportValidity()) return;
    const data = new FormData(form);
    const payload = {
      slideType: data.get('slideType'),
      slideOrder: Number(data.get('slideOrder')),
      title: data.get('title').trim(),
      badgeText: data.get('badgeText').trim(),
      subtitle: data.get('subtitle').trim(),
      bannerImage: data.get('bannerImage').trim(),
      bannerLink: data.get('bannerLink').trim(),
      primaryBtnText: data.get('primaryBtnText').trim(),
      primaryBtnLink: data.get('primaryBtnLink').trim(),
      secondaryBtnText: data.get('secondaryBtnText').trim(),
      secondaryBtnLink: data.get('secondaryBtnLink').trim(),
      bgGradient: data.get('bgGradient').trim(),
      isActive: activeInput.checked
    };
    const submit = form.querySelector('[type="submit"]');
    submit.disabled = true;
    try {
      await api(slide ? `/api/sliders/${slide.id}` : '/api/sliders', {
        method: slide ? 'PUT' : 'POST',
        body: JSON.stringify(payload)
      });
      dialog.close();
      showToast(slide ? 'Slide updated.' : 'Slide added.');
      await renderSliders();
    } catch (error) {
      showToast(error.message);
      submit.disabled = false;
    }
  });
  dialog.append(form);
  document.body.append(dialog);
  dialog.addEventListener('close', () => dialog.remove(), { once: true });
  dialog.addEventListener('click', event => { if (event.target === dialog) close(); });
  dialog.showModal();
  form.elements.title.focus();
}

async function updateSlide(slide, changes) {
  try {
    await api(`/api/sliders/${slide.id}`, {
      method: 'PUT',
      body: JSON.stringify({ ...slide, ...changes })
    });
    showToast(changes.isActive ? 'Slide enabled.' : 'Slide disabled.');
    await renderSliders();
  } catch (error) {
    showToast(error.message);
  }
}

async function renderSettings() {
  if (currentUser.role !== 'owner') return;
  setPageHeading('Site settings', 'Manage business details, delivery pricing, and branding', 'settings');
  const content = document.getElementById('page-content');
  content.replaceChildren(createElement('div', 'empty-state', 'Loading site settings…'));
  try {
    const result = await api('/api/settings');
    const settings = result.settings;
    content.replaceChildren();
    const panel = makePanel('Business and storefront settings', null);
    const form = document.createElement('form');
    form.className = 'settings-form';
    const fields = createElement('div', 'editor-fields settings-fields');
    const config = [
      ['Site name', 'site_name', 'text'],
      ['Tagline', 'tagline', 'text'],
      ['Hotline', 'hotline', 'tel'],
      ['Secondary phone', 'secondary_phone', 'tel'],
      ['WhatsApp number (country code, no +)', 'whatsapp', 'tel'],
      ['Contact email', 'email', 'email'],
      ['Business address', 'address', 'text', true],
      ['Delivery fee inside Dhaka (৳)', 'delivery_inside_dhaka', 'number'],
      ['Delivery fee outside Dhaka (৳)', 'delivery_outside_dhaka', 'number'],
      ['Free delivery threshold (৳)', 'free_delivery_threshold', 'number'],
      ['Powered by label', 'powered_by_name', 'text'],
      ['Powered by URL', 'powered_by_url', 'url']
    ];
    for (const [label, key, type, multiline] of config) {
      fields.append(createField(label, key, settings[key] || '', type, {
        required: ['site_name', 'hotline', 'whatsapp'].includes(key),
        maxLength: key === 'address' ? 500 : 254,
        multiline,
        rows: 3
      }));
      const input = fields.querySelector(`[name="${key}"]`);
      if (['delivery_inside_dhaka', 'delivery_outside_dhaka', 'free_delivery_threshold'].includes(key)) {
        input.min = '0';
        input.max = '10000000';
        input.step = '0.01';
      }
    }
    form.append(fields);

    const logoPanel = createElement('section', 'logo-settings');
    logoPanel.append(createElement('h3', '', 'Store logo'));
    const logoPreview = document.createElement('img');
    logoPreview.className = 'settings-logo-preview';
    logoPreview.src = `/${settings.logo_url || 'assets/logo-white-bg.png'}`;
    logoPreview.alt = 'Current store logo';
    const logoControls = createElement('div', 'logo-controls');
    const logoInput = document.createElement('input');
    logoInput.type = 'file';
    logoInput.accept = 'image/png,image/jpeg,image/webp';
    logoInput.setAttribute('aria-label', 'Choose new store logo');
    const logoButton = createElement('button', 'button button-secondary', 'Upload logo and generate favicons');
    logoButton.type = 'button';
    logoControls.append(logoInput, logoButton);
    logoPanel.append(logoPreview, logoControls);
    form.append(logoPanel);

    const actions = createElement('div', 'settings-actions');
    const save = createElement('button', 'button', 'Save settings');
    save.type = 'submit';
    actions.append(save);
    form.append(actions);
    panel.append(form);
    content.append(panel);

    logoButton.addEventListener('click', async () => {
      if (!logoInput.files.length) {
        showToast('Choose a logo image first.');
        return;
      }
      logoButton.disabled = true;
      try {
        const data = new FormData();
        data.append('logo', logoInput.files[0]);
        const response = await fetch('/api/settings/logo', {
          method: 'POST',
          credentials: 'same-origin',
          body: data
        });
        const uploaded = await response.json().catch(() => ({}));
        if (!response.ok) throw new Error(uploaded.error || `Upload failed (${response.status})`);
        logoPreview.src = `/${uploaded.logoUrl}?v=${Date.now()}`;
        settings.logo_url = uploaded.logoUrl;
        showToast('Logo and favicon updated.');
      } catch (error) {
        showToast(error.message);
      } finally {
        logoButton.disabled = false;
      }
    });

    form.addEventListener('submit', async event => {
      event.preventDefault();
      if (!form.reportValidity()) return;
      const data = new FormData(form);
      const updatedSettings = {};
      for (const [, key] of config) updatedSettings[key] = String(data.get(key) || '').trim();
      updatedSettings.logo_url = settings.logo_url || '';
      save.disabled = true;
      try {
        await api('/api/settings', {
          method: 'PUT',
          body: JSON.stringify({ settings: updatedSettings })
        });
        showToast('Site settings saved.');
      } catch (error) {
        showToast(error.message);
      } finally {
        save.disabled = false;
      }
    });
  } catch (error) {
    if (error.status === 401) {
      currentUser = null;
      renderLogin(false, 'Your session expired. Please sign in again.');
      return;
    }
    content.replaceChildren(createElement('div', 'empty-state', `Settings could not be loaded: ${error.message}`));
  }
}

function createField(labelText, name, value, type = 'text', options = {}) {
  const label = createElement('label', 'field', labelText);
  const input = options.multiline ? document.createElement('textarea') : document.createElement('input');
  if (!options.multiline) input.type = type;
  input.name = name;
  input.value = value == null ? '' : String(value);
  if (options.required) input.required = true;
  if (options.maxLength) input.maxLength = options.maxLength;
  if (options.min !== undefined) input.min = String(options.min);
  if (options.step !== undefined) input.step = String(options.step);
  if (options.multiline) input.rows = options.rows || 3;
  label.append(input);
  return label;
}

function openProductEditor(product, categories) {
  if (currentUser.role !== 'owner') return;
  const dialog = document.createElement('dialog');
  dialog.className = 'editor-dialog';
  const form = document.createElement('form');
  form.className = 'editor-form';
  form.innerHTML = `
    <div class="editor-heading">
      <div>
        <p class="nav-label">Product catalog</p>
        <h2>${product ? 'Edit product' : 'Add product'}</h2>
      </div>
      <button class="icon-button" type="button" aria-label="Close editor">×</button>
    </div>
    <div class="editor-fields"></div>
    <div class="editor-actions">
      <button class="button button-secondary" type="button" data-cancel>Cancel</button>
      <button class="button" type="submit">${product ? 'Save changes' : 'Add product'}</button>
    </div>
  `;
  const fields = form.querySelector('.editor-fields');
  fields.append(
    createField('Product name', 'name', product?.name || '', 'text', { required: true, maxLength: 240 }),
    createField('Current price (৳)', 'price', product?.price ?? '', 'number', { required: true, min: 0, step: '0.01' })
  );
  const categoryLabel = createElement('label', 'field', 'Category');
  const categorySelect = document.createElement('select');
  categorySelect.name = 'category';
  categorySelect.required = true;
  for (const category of categories) addSelectOption(categorySelect, category.name, category.name);
  if (product?.category) categorySelect.value = product.category;
  categoryLabel.append(categorySelect);
  fields.append(
    categoryLabel,
    createField('Original price (৳)', 'originalPrice', product?.originalPrice ?? '', 'number', { min: 0, step: '0.01' }),
    createField('Product image path', 'image', product?.image || 'assets/logo-white-bg.png', 'text', { required: true, maxLength: 1000 }),
    createField('Product page link', 'link', product?.link || '', 'text', { maxLength: 2000 }),
    createField('Badge', 'badge', product?.badge || '', 'text', { maxLength: 100 }),
    createField('Description', 'description', product?.description || '', 'text', { multiline: true, rows: 4, maxLength: 20000 }),
    createField('Specifications (one per line)', 'specs', (product?.specs || []).join('\n'), 'text', { multiline: true, rows: 5, maxLength: 25000 })
  );

  const uploadLabel = createElement('div', 'field', 'Choose product image');
  const uploadInput = document.createElement('input');
  uploadInput.type = 'file';
  uploadInput.accept = 'image/png,image/jpeg,image/webp';
  uploadInput.setAttribute('aria-label', 'Choose product image');
  uploadLabel.append(uploadInput);
  const uploadButton = createElement('button', 'button button-secondary', 'Upload and optimize image');
  uploadButton.type = 'button';
  uploadLabel.append(uploadButton);
  fields.append(uploadLabel);

  const stockLabel = createElement('label', 'checkbox-field');
  const stockInput = document.createElement('input');
  stockInput.type = 'checkbox';
  stockInput.name = 'inStock';
  stockInput.checked = product ? product.inStock : true;
  stockLabel.append(stockInput, createElement('span', '', 'Available for purchase'));
  fields.append(stockLabel);

  const close = () => dialog.close();
  form.querySelector('.icon-button').addEventListener('click', close);
  form.querySelector('[data-cancel]').addEventListener('click', close);
  uploadButton.addEventListener('click', async () => {
    if (!uploadInput.files.length) {
      showToast('Choose an image file first.');
      return;
    }
    uploadButton.disabled = true;
    try {
      const formData = new FormData();
      formData.append('image', uploadInput.files[0]);
      const response = await fetch('/api/upload', {
        method: 'POST',
        credentials: 'same-origin',
        body: formData
      });
      const result = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(result.error || `Upload failed (${response.status})`);
      form.elements.image.value = result.url;
      showToast('Image uploaded and optimized.');
    } catch (error) {
      showToast(error.message);
    } finally {
      uploadButton.disabled = false;
    }
  });

  form.addEventListener('submit', async event => {
    event.preventDefault();
    if (!form.reportValidity()) return;
    const data = new FormData(form);
    const priceValue = data.get('price');
    const originalValue = data.get('originalPrice');
    const payload = {
      name: data.get('name').trim(),
      category: data.get('category'),
      price: Number(priceValue),
      originalPrice: originalValue === '' ? Number(priceValue) : Number(originalValue),
      image: data.get('image').trim(),
      link: data.get('link').trim(),
      badge: data.get('badge').trim(),
      description: data.get('description').trim(),
      specs: data.get('specs').split(/\r?\n/).map(spec => spec.trim()).filter(Boolean),
      inStock: stockInput.checked
    };
    const submit = form.querySelector('[type="submit"]');
    submit.disabled = true;
    try {
      await api(product ? `/api/products/${encodeURIComponent(product.id)}` : '/api/products', {
        method: product ? 'PUT' : 'POST',
        body: JSON.stringify(payload)
      });
      dialog.close();
      showToast(product ? 'Product changes saved.' : 'Product added.');
      productFilters.status = 'active';
      await renderProducts();
    } catch (error) {
      showToast(error.message);
      submit.disabled = false;
    }
  });

  dialog.append(form);
  document.body.append(dialog);
  dialog.addEventListener('close', () => dialog.remove(), { once: true });
  dialog.addEventListener('click', event => {
    if (event.target === dialog) close();
  });
  dialog.showModal();
  form.elements.name.focus();
}

async function toggleProductArchive(product) {
  const restoring = product.active === false;
  const action = restoring ? 'restore' : 'archive';
  if (!restoring && !window.confirm(`Archive "${product.name}"? It will disappear from the storefront and can be restored later.`)) {
    return;
  }
  try {
    await api(`/api/products/${encodeURIComponent(product.id)}/${action}`, { method: 'PATCH' });
    showToast(restoring ? 'Product restored.' : 'Product archived.');
    await renderProducts();
  } catch (error) {
    showToast(error.message);
  }
}

function openCategoryManager(categories) {
  if (currentUser.role !== 'owner') return;
  const dialog = document.createElement('dialog');
  dialog.className = 'editor-dialog category-dialog';
  const panel = createElement('section', 'category-manager');
  const heading = createElement('div', 'editor-heading');
  const titleGroup = document.createElement('div');
  titleGroup.append(
    createElement('p', 'nav-label', 'Product catalog'),
    createElement('h2', '', 'Manage categories')
  );
  const closeButton = createElement('button', 'icon-button', '×');
  closeButton.type = 'button';
  closeButton.setAttribute('aria-label', 'Close categories');
  heading.append(titleGroup, closeButton);
  panel.append(heading);

  const addButton = createElement('button', 'button', 'Add category');
  addButton.type = 'button';
  addButton.addEventListener('click', () => openCategoryEditor(null, dialog));
  panel.append(addButton);

  const list = createElement('div', 'category-list');
  for (const category of categories) {
    const row = createElement('div', 'category-row');
    const info = createElement('div', 'category-row-info');
    info.append(
      createElement('strong', '', category.name),
      createElement('span', '', `${category.count || 0} active products`)
    );
    const actions = createElement('div', 'category-row-actions');
    const edit = createElement('button', 'button button-secondary button-small', 'Edit');
    edit.type = 'button';
    edit.addEventListener('click', () => openCategoryEditor(category, dialog));
    const remove = createElement('button', 'button button-danger button-small', 'Delete');
    remove.type = 'button';
    remove.addEventListener('click', async () => {
      if (!window.confirm(`Delete category "${category.name}"? Categories containing products cannot be deleted.`)) return;
      try {
        await api(`/api/categories/${category.id}`, { method: 'DELETE' });
        showToast('Category deleted.');
        dialog.close();
        await renderProducts();
      } catch (error) {
        showToast(error.message);
      }
    });
    actions.append(edit, remove);
    row.append(info, actions);
    list.append(row);
  }
  panel.append(list);
  dialog.append(panel);
  document.body.append(dialog);
  const close = () => dialog.close();
  closeButton.addEventListener('click', close);
  dialog.addEventListener('close', () => dialog.remove(), { once: true });
  dialog.addEventListener('click', event => {
    if (event.target === dialog) close();
  });
  dialog.showModal();
}

function openCategoryEditor(category, parentDialog) {
  const dialog = document.createElement('dialog');
  dialog.className = 'editor-dialog';
  const form = document.createElement('form');
  form.className = 'editor-form';
  form.innerHTML = `
    <div class="editor-heading">
      <div><p class="nav-label">Product catalog</p><h2>${category ? 'Edit category' : 'Add category'}</h2></div>
      <button class="icon-button" type="button" aria-label="Close editor">×</button>
    </div>
    <div class="editor-fields"></div>
    <div class="editor-actions">
      <button class="button button-secondary" type="button" data-cancel>Cancel</button>
      <button class="button" type="submit">${category ? 'Save changes' : 'Add category'}</button>
    </div>
  `;
  const fields = form.querySelector('.editor-fields');
  fields.append(
    createField('Category name', 'name', category?.name || '', 'text', { required: true, maxLength: 120 }),
    createField('Category image path', 'image', category?.image || '', 'text', { maxLength: 1000 }),
    createField('Description', 'desc', category?.desc || '', 'text', { multiline: true, rows: 3, maxLength: 2000 })
  );

  const close = () => dialog.close();
  form.querySelector('.icon-button').addEventListener('click', close);
  form.querySelector('[data-cancel]').addEventListener('click', close);
  form.addEventListener('submit', async event => {
    event.preventDefault();
    if (!form.reportValidity()) return;
    const data = new FormData(form);
    const submit = form.querySelector('[type="submit"]');
    submit.disabled = true;
    try {
      const payload = {
        name: data.get('name').trim(),
        image: data.get('image').trim(),
        desc: data.get('desc').trim()
      };
      await api(category ? `/api/categories/${category.id}` : '/api/categories', {
        method: category ? 'PUT' : 'POST',
        body: JSON.stringify(payload)
      });
      dialog.close();
      parentDialog.close();
      showToast(category ? 'Category updated.' : 'Category added.');
      await renderProducts();
    } catch (error) {
      showToast(error.message);
      submit.disabled = false;
    }
  });
  dialog.append(form);
  document.body.append(dialog);
  dialog.addEventListener('close', () => dialog.remove(), { once: true });
  dialog.showModal();
  form.elements.name.focus();
}

async function renderActivity() {
  setPageHeading('Activity', 'Recent changes made by administrators');
  const content = document.getElementById('page-content');
  content.replaceChildren(createElement('div', 'empty-state', 'Loading activity…'));

  try {
    const result = await api('/api/audit-logs');
    content.replaceChildren();
    const panel = makePanel('Recent activity', 'Refresh', renderActivity);
    const list = createElement('div', 'data-list');
    if (!result.logs?.length) {
      list.append(createElement('div', 'empty-state', 'No admin activity has been recorded yet.'));
    } else {
      for (const log of result.logs) {
        const row = createElement('article', 'data-row activity-row');
        const main = createElement('div', 'data-main');
        main.append(
          createElement('strong', '', log.action || 'Activity'),
          createElement('span', '', `${log.username || 'Admin'} · ${log.details || ''}`)
        );
        row.append(main, createElement('time', 'data-time', formatDate(log.created_at)));
        list.append(row);
      }
    }
    panel.append(list);
    content.append(panel);
  } catch (error) {
    if (error.status === 401) {
      currentUser = null;
      renderLogin(false, 'Your session expired. Please sign in again.');
      return;
    }
    content.replaceChildren(createElement('div', 'empty-state', `Activity could not be loaded: ${error.message}`));
  }
}

function renderChangePassword() {
  const content = document.getElementById('page-content');
  content.replaceChildren();
  const panel = makePanel('Change password', null);
  const form = document.createElement('form');
  form.innerHTML = `
    <div class="form-padding">
      <label class="field">Current password
        <input name="currentPassword" type="password" autocomplete="current-password" required maxlength="256">
      </label>
      <label class="field">New password (at least 12 characters)
        <input name="newPassword" type="password" autocomplete="new-password" required minlength="12" maxlength="256">
      </label>
      <p class="notice" id="notice" role="alert"></p>
      <button class="button" type="submit">Update password</button>
    </div>
  `;
  panel.append(form);
  content.append(panel);
  form.addEventListener('submit', async event => {
    event.preventDefault();
    const formData = new FormData(form);
    const button = form.querySelector('button');
    button.disabled = true;
    try {
      await api('/api/auth/change-password', {
        method: 'POST',
        body: JSON.stringify({
          currentPassword: formData.get('currentPassword'),
          newPassword: formData.get('newPassword')
        })
      });
      await logout();
      renderLogin(false, 'Password changed. Sign in with your new password.');
    } catch (error) {
      showNotice(error.message);
      button.disabled = false;
    }
  });
}

async function logout() {
  try {
    await api('/api/auth/logout', { method: 'POST' });
  } catch (error) {
    if (error.status !== 401) showToast(error.message);
  }
  currentUser = null;
  renderLogin();
}

async function init() {
  try {
    const status = await api('/api/auth/setup-status');
    if (status.setupRequired) {
      renderLogin(true);
      return;
    }

    const result = await api('/api/auth/me');
    currentUser = result.user;
    await renderDashboard();
  } catch (error) {
    renderLogin(false, error.status === 503
      ? error.message
      : error.status === 401 ? '' : `Could not connect to the admin server: ${error.message}`);
  }
}

init();
