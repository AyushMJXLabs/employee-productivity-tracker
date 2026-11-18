(() => {
  'use strict';

  const appEl = document.getElementById('app');
  const toastContainer = document.getElementById('toast-container');
  const modalBackdrop = document.getElementById('modal-backdrop');
  const modalTitle = document.getElementById('modal-title');
  const modalBody = document.getElementById('modal-body');
  const modalClose = document.getElementById('modal-close');

  const state = {
    appTitle: 'MJX Labs · Work Ledger',
    user: null,
    needsBossSetup: false,
    authMode: 'login', // 'login' | 'register'
    bossTab: 'ledger', // 'ledger' | 'team'
    bossViewMode: 'table', // 'table' | 'grouped'
    showBossLogForm: false,
    logs: [],
    projects: [],
    employees: [],
    stats: {},
    team: [],
    teamInviteCode: '',
    filters: {
      search: '',
      userId: '',
      project: '',
      fromDate: '',
      toDate: '',
      preset: 'all', // 'all' | 'today' | 'week' | 'month'
    },
    clockInterval: null,
  };

  function escapeHtml(str) {
    return String(str ?? '')
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;');
  }

  function toast(message, isError = false) {
    const el = document.createElement('div');
    el.className = `toast${isError ? ' error' : ''}`;
    el.textContent = message;
    toastContainer.appendChild(el);
    setTimeout(() => {
      el.remove();
    }, 3200);
  }

  async function api(url, options = {}) {
    const res = await fetch(url, {
      credentials: 'same-origin',
      headers: {
        'Content-Type': 'application/json',
        ...(options.headers || {}),
      },
      ...options,
    });
    const contentType = res.headers.get('content-type') || '';
    const data = contentType.includes('application/json') ? await res.json() : null;
    if (!res.ok) {
      throw new Error(data?.error || `Request failed (${res.status})`);
    }
    return data;
  }

  function formatDateTime(isoString) {
    const d = new Date(isoString);
    if (Number.isNaN(d.getTime())) return isoString;
    const datePart = d.toLocaleDateString(undefined, {
      year: 'numeric',
      month: 'short',
      day: '2-digit',
    });
    const timePart = d.toLocaleTimeString(undefined, {
      hour: '2-digit',
      minute: '2-digit',
    });
    return `${datePart} · ${timePart}`;
  }

  function localDayBounds() {
    const now = new Date();
    const todayStart = new Date(now.getFullYear(), now.getMonth(), now.getDate(), 0, 0, 0, 0);
    const weekStart = new Date(now.getFullYear(), now.getMonth(), now.getDate() - 6, 0, 0, 0, 0);
    const monthStart = new Date(now.getFullYear(), now.getMonth(), 1, 0, 0, 0, 0);
    return {
      todayStart: todayStart.toISOString(),
      weekStart: weekStart.toISOString(),
      monthStart: monthStart.toISOString(),
    };
  }

  function localDateInputBounds(fromDateStr, toDateStr) {
    let from = '';
    let to = '';
    if (fromDateStr) {
      const [y, m, d] = fromDateStr.split('-').map(Number);
      from = new Date(y, m - 1, d, 0, 0, 0, 0).toISOString();
    }
    if (toDateStr) {
      const [y, m, d] = toDateStr.split('-').map(Number);
      to = new Date(y, m - 1, d, 23, 59, 59, 999).toISOString();
    }
    return { from, to };
  }

  function toLocalYmd(date) {
    const y = date.getFullYear();
    const m = String(date.getMonth() + 1).padStart(2, '0');
    const d = String(date.getDate()).padStart(2, '0');
    return `${y}-${m}-${d}`;
  }

  function buildLogsQueryString() {
    const params = new URLSearchParams();
    const bounds = localDayBounds();
    params.set('todayStart', bounds.todayStart);
    params.set('weekStart', bounds.weekStart);
    params.set('tzOffsetMinutes', String(new Date().getTimezoneOffset()));

    if (state.filters.search.trim()) {
      params.set('search', state.filters.search.trim());
    }
    if (state.user?.role === 'boss' && state.filters.userId) {
      params.set('userId', state.filters.userId);
    }
    if (state.filters.project) {
      params.set('project', state.filters.project);
    }

    const { from, to } = localDateInputBounds(state.filters.fromDate, state.filters.toDate);
    if (from) params.set('from', from);
    if (to) params.set('to', to);

    return params.toString();
  }

  function brandSvg() {
    return `
      <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor"
           stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
        <rect x="3" y="4" width="18" height="16" rx="2" />
        <path d="M7 9h10M7 13h7M7 17h4" />
      </svg>
    `;
  }

  function lockSvg() {
    return `
      <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor"
           stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
        <rect x="3" y="11" width="18" height="11" rx="2" />
        <path d="M7 11V7a5 5 0 0 1 10 0v4" />
      </svg>
    `;
  }

  function stopClock() {
    if (state.clockInterval) {
      clearInterval(state.clockInterval);
      state.clockInterval = null;
    }
  }

  function startClock() {
    stopClock();
    const update = () => {
      const el = document.getElementById('live-clock');
      if (el) {
        el.textContent = formatDateTime(new Date().toISOString());
      }
    };
    update();
    state.clockInterval = setInterval(update, 1000);
  }

  function openModal(title, htmlContent, onMount) {
    modalTitle.textContent = title;
    modalBody.innerHTML = htmlContent;
    modalBackdrop.classList.remove('hidden');
    if (typeof onMount === 'function') {
      onMount();
    }
  }

  function closeModal() {
    modalBackdrop.classList.add('hidden');
    modalBody.innerHTML = '';
  }

  modalClose.addEventListener('click', closeModal);
  modalBackdrop.addEventListener('click', (e) => {
    if (e.target === modalBackdrop) closeModal();
  });
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && !modalBackdrop.classList.contains('hidden')) {
      closeModal();
    }
  });

  async function bootstrap() {
    try {
      const status = await api('/api/auth/status');
      state.appTitle = status.appTitle || state.appTitle;
      state.user = status.user || null;
      state.needsBossSetup = Boolean(status.needsBossSetup);
      document.title = state.appTitle;

      if (state.user) {
        await refreshWorkspaceData();
      }
      render();
    } catch (err) {
      appEl.innerHTML = `
        <div class="auth-page">
          <div class="auth-card">
            <div class="alert alert-error">${escapeHtml(err.message)}</div>
            <button class="btn btn-primary" onclick="location.reload()">Retry</button>
          </div>
        </div>
      `;
    }
  }

  async function refreshWorkspaceData() {
    const qs = buildLogsQueryString();
    const data = await api(`/api/logs?${qs}`);
    state.logs = data.logs || [];
    state.projects = data.projects || [];
    state.employees = data.employees || [];
    state.stats = data.stats || {};

    if (state.user?.role === 'boss' && state.bossTab === 'team') {
      const teamData = await api('/api/boss/team');
      state.team = teamData.members || [];
      state.teamInviteCode = teamData.teamInviteCode || '';
    }
  }

  function render() {
    stopClock();
    if (!state.user) {
      renderAuthView();
      return;
    }
    if (state.user.role === 'boss') {
      renderBossWorkspace();
    } else {
      renderEmployeeWorkspace();
    }
  }

  function renderAuthView() {
    if (state.needsBossSetup) {
      appEl.innerHTML = `
        <div class="auth-page">
          <div class="auth-card">
            <div class="auth-header">
              <div class="brand-mark">${brandSvg()}</div>
              <div>
                <h1>${escapeHtml(state.appTitle)}</h1>
                <p class="auth-subtitle">One-time Executive Account Setup</p>
              </div>
            </div>
            <div id="auth-error"></div>
            <form id="boss-setup-form" class="form-stack">
              <div class="field">
                <label for="setup-name">Executive Name</label>
                <input id="setup-name" class="input" type="text" required placeholder="e.g., Alex Morgan" />
              </div>
              <div class="field">
                <label for="setup-email">Work Email</label>
                <input id="setup-email" class="input" type="email" required placeholder="lead@company.com" />
              </div>
              <div class="field">
                <label for="setup-password">Password (min 6 characters)</label>
                <input id="setup-password" class="input" type="password" required minlength="6" />
              </div>
              <button type="submit" class="btn btn-primary" style="width: 100%; margin-top: 4px;">
                Initialize Executive Account
              </button>
            </form>
            <div class="auth-footer-note">
              ${lockSvg()}
              <span>Only the executive account can view all team members' logs.</span>
            </div>
          </div>
        </div>
      `;

      document.getElementById('boss-setup-form').addEventListener('submit', async (e) => {
        e.preventDefault();
        const errBox = document.getElementById('auth-error');
        errBox.innerHTML = '';
        const btn = e.target.querySelector('button[type="submit"]');
        btn.disabled = true;
        try {
          const res = await api('/api/auth/setup-boss', {
            method: 'POST',
            body: JSON.stringify({
              name: document.getElementById('setup-name').value,
              email: document.getElementById('setup-email').value,
              password: document.getElementById('setup-password').value,
            }),
          });
          state.user = res.user;
          state.needsBossSetup = false;
          await refreshWorkspaceData();
          render();
          toast('Executive account initialized.');
        } catch (err) {
          errBox.innerHTML = `<div class="alert alert-error">${escapeHtml(err.message)}</div>`;
          btn.disabled = false;
        }
      });
      return;
    }

    const isLogin = state.authMode === 'login';
    const isRegister = state.authMode === 'register';
    const isForgot = state.authMode === 'forgot';

    appEl.innerHTML = `
      <div class="auth-page">
        <div class="auth-card">
          <div class="auth-header">
            <div class="brand-mark">${brandSvg()}</div>
            <div>
              <h1>${escapeHtml(state.appTitle)}</h1>
              <p class="auth-subtitle">Confidential Daily Work Ledger</p>
            </div>
          </div>

          <div class="segmented" role="tablist">
            <button type="button" class="segmented-btn ${isLogin || isForgot ? 'active' : ''}" data-mode="login">
              Sign In
            </button>
            <button type="button" class="segmented-btn ${isRegister ? 'active' : ''}" data-mode="register">
              Join Team
            </button>
          </div>

          <div id="auth-error"></div>

          ${
            isForgot
              ? `
            <form id="forgot-form" class="form-stack">
              <p class="auth-subtitle" style="margin-bottom: 4px;">
                Submit a password reset request to your team lead using your work email and the Team Invite Code.
              </p>
              <div class="field">
                <label for="forgot-email">Work Email</label>
                <input id="forgot-email" class="input" type="email" autocomplete="email" required placeholder="you@company.com" />
              </div>
              <div class="field">
                <label for="forgot-invite">Team Invite Code</label>
                <input id="forgot-invite" class="input" type="text" required placeholder="Provided by your team lead" />
              </div>
              <button type="submit" class="btn btn-primary" style="width: 100%; margin-top: 4px;">
                Request Password Reset
              </button>
              <div style="text-align: center;">
                <button type="button" id="back-to-login-btn" class="link-btn">Back to Sign In</button>
              </div>
            </form>
          `
              : isLogin
                ? `
            <form id="login-form" class="form-stack">
              <div class="field">
                <label for="login-email">Work Email</label>
                <input id="login-email" class="input" type="email" autocomplete="email" required placeholder="you@company.com" />
              </div>
              <div class="field">
                <div style="display: flex; justify-content: space-between; align-items: center;">
                  <label for="login-password">Password</label>
                  <button type="button" id="forgot-pw-link" class="link-btn">Forgot password?</button>
                </div>
                <input id="login-password" class="input" type="password" autocomplete="current-password" required />
              </div>
              <button type="submit" class="btn btn-primary" style="width: 100%; margin-top: 4px;">
                Sign In to Workspace
              </button>
            </form>
          `
                : `
            <form id="register-form" class="form-stack">
              <div class="field">
                <label for="reg-name">Full Name</label>
                <input id="reg-name" class="input" type="text" autocomplete="name" required placeholder="Your full name" />
              </div>
              <div class="field">
                <label for="reg-email">Work Email</label>
                <input id="reg-email" class="input" type="email" autocomplete="email" required placeholder="you@company.com" />
              </div>
              <div class="field">
                <label for="reg-password">Password (min 6 characters)</label>
                <input id="reg-password" class="input" type="password" autocomplete="new-password" required minlength="6" />
              </div>
              <div class="field">
                <label for="reg-invite">Team Invite Code</label>
                <input id="reg-invite" class="input" type="text" required placeholder="Provided by your team lead" />
              </div>
              <button type="submit" class="btn btn-primary" style="width: 100%; margin-top: 4px;">
                Create Private Account
              </button>
            </form>
          `
          }

          <div class="auth-footer-note">
            ${lockSvg()}
            <span>Private isolation: your entries are visible only to you and leadership.</span>
          </div>
        </div>
      </div>
    `;

    appEl.querySelectorAll('[data-mode]').forEach((btn) => {
      btn.addEventListener('click', () => {
        state.authMode = btn.dataset.mode;
        renderAuthView();
      });
    });

    if (isForgot) {
      document.getElementById('back-to-login-btn').addEventListener('click', () => {
        state.authMode = 'login';
        renderAuthView();
      });
      document.getElementById('forgot-form').addEventListener('submit', async (e) => {
        e.preventDefault();
        const errBox = document.getElementById('auth-error');
        errBox.innerHTML = '';
        const btn = e.target.querySelector('button[type="submit"]');
        btn.disabled = true;
        try {
          const res = await api('/api/auth/forgot-password', {
            method: 'POST',
            body: JSON.stringify({
              email: document.getElementById('forgot-email').value,
              inviteCode: document.getElementById('forgot-invite').value,
            }),
          });
          errBox.innerHTML = `<div class="alert alert-success">${escapeHtml(res.message)}</div>`;
          e.target.reset();
        } catch (err) {
          errBox.innerHTML = `<div class="alert alert-error">${escapeHtml(err.message)}</div>`;
        } finally {
          btn.disabled = false;
        }
      });
    } else if (isLogin) {
      document.getElementById('forgot-pw-link').addEventListener('click', () => {
        state.authMode = 'forgot';
        renderAuthView();
      });
      document.getElementById('login-form').addEventListener('submit', async (e) => {
        e.preventDefault();
        const errBox = document.getElementById('auth-error');
        errBox.innerHTML = '';
        const btn = e.target.querySelector('button[type="submit"]');
        btn.disabled = true;
        try {
          const res = await api('/api/auth/login', {
            method: 'POST',
            body: JSON.stringify({
              email: document.getElementById('login-email').value,
              password: document.getElementById('login-password').value,
            }),
          });
          state.user = res.user;
          await refreshWorkspaceData();
          render();
        } catch (err) {
          errBox.innerHTML = `<div class="alert alert-error">${escapeHtml(err.message)}</div>`;
          btn.disabled = false;
        }
      });
    } else {
      document.getElementById('register-form').addEventListener('submit', async (e) => {
        e.preventDefault();
        const errBox = document.getElementById('auth-error');
        errBox.innerHTML = '';
        const btn = e.target.querySelector('button[type="submit"]');
        btn.disabled = true;
        try {
          const res = await api('/api/auth/register', {
            method: 'POST',
            body: JSON.stringify({
              name: document.getElementById('reg-name').value,
              email: document.getElementById('reg-email').value,
              password: document.getElementById('reg-password').value,
              inviteCode: document.getElementById('reg-invite').value,
            }),
          });
          state.user = res.user;
          await refreshWorkspaceData();
          render();
          toast('Account created.');
        } catch (err) {
          errBox.innerHTML = `<div class="alert alert-error">${escapeHtml(err.message)}</div>`;
          btn.disabled = false;
        }
      });
    }
  }

  function renderTopbar(isBoss) {
    return `
      <header class="topbar">
        <div class="topbar-inner">
          <div class="brand-group">
            <div class="brand-mark">${brandSvg()}</div>
            <span class="brand-title">${escapeHtml(state.appTitle)}</span>
            ${
              isBoss
                ? `
              <nav class="nav-tabs" aria-label="Executive views">
                <button type="button" class="nav-tab ${state.bossTab === 'ledger' ? 'active' : ''}" data-boss-tab="ledger">
                  Team Ledger
                </button>
                <button type="button" class="nav-tab ${state.bossTab === 'team' ? 'active' : ''}" data-boss-tab="team">
                  Team &amp; Access
                </button>
              </nav>
            `
                : `
              <span class="privacy-pill">${lockSvg()} Private Personal Ledger</span>
            `
            }
          </div>
          <div class="topbar-right">
            <div class="user-chip">
              <span class="user-name">${escapeHtml(state.user.name)}</span>
              <span class="role-badge ${isBoss ? 'boss' : ''}">${isBoss ? 'Executive' : 'Member'}</span>
            </div>
            <button type="button" id="change-pw-btn" class="btn btn-ghost btn-sm">Password</button>
            <button type="button" id="logout-btn" class="btn btn-secondary btn-sm">Sign Out</button>
          </div>
        </div>
      </header>
    `;
  }

  function bindTopbarEvents() {
    document.getElementById('change-pw-btn')?.addEventListener('click', () => {
      openModal(
        'Change Password',
        `
          <form id="change-pw-form" class="form-stack">
            <div class="field">
              <label for="cur-pw">Current Password</label>
              <input id="cur-pw" class="input" type="password" required autocomplete="current-password" />
            </div>
            <div class="field">
              <label for="new-pw">New Password (min 6 characters)</label>
              <input id="new-pw" class="input" type="password" required minlength="6" autocomplete="new-password" />
            </div>
            <div class="form-actions" style="justify-content: flex-end;">
              <button type="button" id="cancel-cpw" class="btn btn-secondary">Cancel</button>
              <button type="submit" class="btn btn-primary">Update Password</button>
            </div>
          </form>
        `,
        () => {
          document.getElementById('cancel-cpw').addEventListener('click', closeModal);
          document.getElementById('change-pw-form').addEventListener('submit', async (e) => {
            e.preventDefault();
            try {
              await api('/api/auth/change-password', {
                method: 'POST',
                body: JSON.stringify({
                  currentPassword: document.getElementById('cur-pw').value,
                  newPassword: document.getElementById('new-pw').value,
                }),
              });
              closeModal();
              toast('Your password has been updated.');
            } catch (err) {
              toast(err.message, true);
            }
          });
        }
      );
    });

    document.getElementById('logout-btn')?.addEventListener('click', async () => {
      await api('/api/auth/logout', { method: 'POST' });
      state.user = null;
      state.logs = [];
      state.projects = [];
      state.employees = [];
      state.team = [];
      state.filters = { search: '', userId: '', project: '', fromDate: '', toDate: '', preset: 'all' };
      render();
    });

    appEl.querySelectorAll('[data-boss-tab]').forEach((btn) => {
      btn.addEventListener('click', async () => {
        state.bossTab = btn.dataset.bossTab;
        await refreshWorkspaceData();
        render();
      });
    });
  }

  function renderLogEntryFormHtml(titleText = 'Log Work Entry') {
    const projectOptions = state.projects
      .map((p) => `<option value="${escapeHtml(p)}"></option>`)
      .join('');

    return `
      <section class="card">
        <div class="card-header">
          <div class="card-title-group">
            <h2 class="card-title">${escapeHtml(titleText)}</h2>
            <p class="card-subtitle">You can submit multiple entries per day; each entry is stamped with the exact date and time.</p>
          </div>
        </div>
        <div class="card-body">
          <form id="log-entry-form" class="form-stack">
            <div class="form-grid-3">
              <div class="field">
                <label>Person</label>
                <div class="readonly-pill">
                  <span>${escapeHtml(state.user.name)}</span>
                  <span class="hint">Verified</span>
                </div>
              </div>
              <div class="field">
                <label for="entry-project">Project Worked On</label>
                <input
                  id="entry-project"
                  class="input"
                  type="text"
                  list="my-projects-list"
                  required
                  maxlength="120"
                  placeholder="e.g., Client Portal API"
                />
                <datalist id="my-projects-list">${projectOptions}</datalist>
              </div>
              <div class="field">
                <label>Date &amp; Time</label>
                <div class="readonly-pill tabular">
                  <span id="live-clock">${escapeHtml(formatDateTime(new Date().toISOString()))}</span>
                </div>
              </div>
            </div>
            <div class="field">
              <label for="entry-work">Work Done</label>
              <textarea
                id="entry-work"
                class="textarea"
                required
                maxlength="2000"
                placeholder="Describe what you completed or progressed on…"
              ></textarea>
            </div>
            <div class="form-actions">
              <span class="hint">Tip: Press Cmd/Ctrl + Enter to submit quickly.</span>
              <button type="submit" class="btn btn-primary">Submit Work Entry</button>
            </div>
          </form>
        </div>
      </section>
    `;
  }

  function bindLogEntryFormEvents() {
    const form = document.getElementById('log-entry-form');
    if (!form) return;

    const projectInput = document.getElementById('entry-project');
    const workInput = document.getElementById('entry-work');

    workInput.addEventListener('keydown', (e) => {
      if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') {
        e.preventDefault();
        form.requestSubmit();
      }
    });

    form.addEventListener('submit', async (e) => {
      e.preventDefault();
      const btn = form.querySelector('button[type="submit"]');
      btn.disabled = true;
      try {
        await api('/api/logs', {
          method: 'POST',
          body: JSON.stringify({
            project: projectInput.value,
            workDone: workInput.value,
          }),
        });
        workInput.value = '';
        await refreshWorkspaceData();
        render();
        toast('Work entry logged.');
      } catch (err) {
        toast(err.message, true);
        btn.disabled = false;
      }
    });
  }

  function renderFilterToolbarHtml(isBoss) {
    const projectOpts = state.projects
      .map(
        (p) =>
          `<option value="${escapeHtml(p)}" ${state.filters.project === p ? 'selected' : ''}>${escapeHtml(p)}</option>`
      )
      .join('');

    const employeeOpts = isBoss
      ? state.employees
          .map(
            (emp) =>
              `<option value="${emp.id}" ${String(state.filters.userId) === String(emp.id) ? 'selected' : ''}>${escapeHtml(emp.name)}</option>`
          )
          .join('')
      : '';

    return `
      <div class="toolbar">
        <div class="filter-row">
          <input
            id="filter-search"
            class="input"
            type="search"
            value="${escapeHtml(state.filters.search)}"
            placeholder="${isBoss ? 'Search name, project, or work…' : 'Search your project or work…'}"
          />
          ${
            isBoss
              ? `
            <select id="filter-user" class="select" aria-label="Filter by team member">
              <option value="">All Team Members</option>
              ${employeeOpts}
            </select>
          `
              : ''
          }
          <select id="filter-project" class="select" aria-label="Filter by project">
            <option value="">All Projects</option>
            ${projectOpts}
          </select>
          <input
            id="filter-from"
            class="input"
            type="date"
            aria-label="From date"
            value="${escapeHtml(state.filters.fromDate)}"
          />
          <input
            id="filter-to"
            class="input"
            type="date"
            aria-label="To date"
            value="${escapeHtml(state.filters.toDate)}"
          />
        </div>
        <div class="preset-row">
          <div class="chip-group">
            <button type="button" class="chip ${state.filters.preset === 'today' ? 'active' : ''}" data-preset="today">Today</button>
            <button type="button" class="chip ${state.filters.preset === 'week' ? 'active' : ''}" data-preset="week">Last 7 Days</button>
            <button type="button" class="chip ${state.filters.preset === 'month' ? 'active' : ''}" data-preset="month">This Month</button>
            <button type="button" class="chip ${state.filters.preset === 'all' ? 'active' : ''}" data-preset="all">All Time</button>
          </div>
          <div class="chip-group">
            ${
              isBoss
                ? `
              <button type="button" class="chip ${state.bossViewMode === 'table' ? 'active' : ''}" data-view="table">Table View</button>
              <button type="button" class="chip ${state.bossViewMode === 'grouped' ? 'active' : ''}" data-view="grouped">Grouped by Person</button>
            `
                : ''
            }
            <button type="button" id="export-csv-btn" class="btn btn-secondary btn-sm">Export CSV</button>
          </div>
        </div>
      </div>
    `;
  }

  function renderLedgerTableHtml(logs, allowEdit) {
    if (logs.length === 0) {
      return `
        <div class="empty-state">
          No work entries match the current view.
        </div>
      `;
    }

    const rows = logs
      .map(
        (log) => `
      <tr>
        <td class="col-person">${escapeHtml(log.personName)}</td>
        <td><span class="project-badge">${escapeHtml(log.project)}</span></td>
        <td class="col-work">${escapeHtml(log.workDone)}</td>
        <td class="col-datetime tabular">${escapeHtml(formatDateTime(log.loggedAt))}</td>
        <td class="col-actions">
          ${
            allowEdit || log.userId === state.user.id
              ? `<button type="button" class="btn btn-ghost btn-sm" data-edit-log="${log.id}">Edit</button>`
              : ''
          }
          <button type="button" class="btn btn-danger-ghost btn-sm" data-delete-log="${log.id}">Delete</button>
        </td>
      </tr>
    `
      )
      .join('');

    return `
      <div class="table-wrap">
        <table class="ledger-table">
          <thead>
            <tr>
              <th>Person</th>
              <th>Project</th>
              <th>Work Done</th>
              <th>Date &amp; Time</th>
              <th style="text-align: right;">Actions</th>
            </tr>
          </thead>
          <tbody>${rows}</tbody>
        </table>
      </div>
    `;
  }

  function renderGroupedBossHtml(logs) {
    if (logs.length === 0) {
      return `<div class="empty-state">No work entries match the current filters.</div>`;
    }

    const groups = new Map();
    for (const log of logs) {
      const key = `${log.userId}::${log.personName}`;
      if (!groups.has(key)) {
        groups.set(key, { personName: log.personName, entries: [] });
      }
      groups.get(key).entries.push(log);
    }

    const blocks = Array.from(groups.values())
      .map((g) => {
        const rows = g.entries
          .map(
            (log) => `
          <tr>
            <td style="width: 180px;"><span class="project-badge">${escapeHtml(log.project)}</span></td>
            <td class="col-work">${escapeHtml(log.workDone)}</td>
            <td class="col-datetime tabular">${escapeHtml(formatDateTime(log.loggedAt))}</td>
            <td class="col-actions">
              <button type="button" class="btn btn-danger-ghost btn-sm" data-delete-log="${log.id}">Delete</button>
            </td>
          </tr>
        `
          )
          .join('');

        return `
          <div class="person-group-card">
            <div class="person-group-header">
              <span class="person-group-name">${escapeHtml(g.personName)}</span>
              <span class="person-group-count tabular">${g.entries.length} ${g.entries.length === 1 ? 'entry' : 'entries'}</span>
            </div>
            <div class="table-wrap">
              <table class="ledger-table">
                <tbody>${rows}</tbody>
              </table>
            </div>
          </div>
        `;
      })
      .join('');

    return `<div class="grouped-list">${blocks}</div>`;
  }

  function bindLedgerEvents(isBoss) {
    const searchEl = document.getElementById('filter-search');
    let debounceTimer;
    searchEl?.addEventListener('input', () => {
      state.filters.search = searchEl.value;
      clearTimeout(debounceTimer);
      debounceTimer = setTimeout(async () => {
        await refreshWorkspaceData();
        renderLedgerSectionOnly(isBoss);
      }, 200);
    });

    document.getElementById('filter-user')?.addEventListener('change', async (e) => {
      state.filters.userId = e.target.value;
      await refreshWorkspaceData();
      renderLedgerSectionOnly(isBoss);
    });

    document.getElementById('filter-project')?.addEventListener('change', async (e) => {
      state.filters.project = e.target.value;
      await refreshWorkspaceData();
      renderLedgerSectionOnly(isBoss);
    });

    const onDateChange = async () => {
      state.filters.fromDate = document.getElementById('filter-from').value;
      state.filters.toDate = document.getElementById('filter-to').value;
      state.filters.preset = '';
      await refreshWorkspaceData();
      renderLedgerSectionOnly(isBoss);
    };
    document.getElementById('filter-from')?.addEventListener('change', onDateChange);
    document.getElementById('filter-to')?.addEventListener('change', onDateChange);

    appEl.querySelectorAll('[data-preset]').forEach((btn) => {
      btn.addEventListener('click', async () => {
        const preset = btn.dataset.preset;
        state.filters.preset = preset;
        const now = new Date();
        if (preset === 'today') {
          const ymd = toLocalYmd(now);
          state.filters.fromDate = ymd;
          state.filters.toDate = ymd;
        } else if (preset === 'week') {
          const start = new Date(now.getFullYear(), now.getMonth(), now.getDate() - 6);
          state.filters.fromDate = toLocalYmd(start);
          state.filters.toDate = toLocalYmd(now);
        } else if (preset === 'month') {
          const start = new Date(now.getFullYear(), now.getMonth(), 1);
          state.filters.fromDate = toLocalYmd(start);
          state.filters.toDate = toLocalYmd(now);
        } else {
          state.filters.fromDate = '';
          state.filters.toDate = '';
        }
        await refreshWorkspaceData();
        render();
      });
    });

    appEl.querySelectorAll('[data-view]').forEach((btn) => {
      btn.addEventListener('click', () => {
        state.bossViewMode = btn.dataset.view;
        render();
      });
    });

    document.getElementById('export-csv-btn')?.addEventListener('click', () => {
      const qs = buildLogsQueryString();
      window.location.href = `/api/logs/export.csv?${qs}`;
    });

    bindLogRowActions();
  }

  function renderLedgerSectionOnly(isBoss) {
    const container = document.getElementById('ledger-results');
    const countLabel = document.getElementById('ledger-count-label');
    if (countLabel) {
      countLabel.textContent = `${state.logs.length} ${state.logs.length === 1 ? 'entry' : 'entries'} shown`;
    }
    if (!container) return;
    container.innerHTML =
      isBoss && state.bossViewMode === 'grouped'
        ? renderGroupedBossHtml(state.logs)
        : renderLedgerTableHtml(state.logs, !isBoss);
    bindLogRowActions();
  }

  function bindLogRowActions() {
    appEl.querySelectorAll('[data-edit-log]').forEach((btn) => {
      btn.addEventListener('click', () => {
        const logId = Number(btn.dataset.editLog);
        const log = state.logs.find((l) => l.id === logId);
        if (!log) return;

        openModal(
          'Edit Work Entry',
          `
            <form id="edit-log-form" class="form-stack">
              <div class="field">
                <label for="edit-project">Project</label>
                <input id="edit-project" class="input" type="text" required maxlength="120" value="${escapeHtml(log.project)}" />
              </div>
              <div class="field">
                <label for="edit-work">Work Done</label>
                <textarea id="edit-work" class="textarea" required maxlength="2000">${escapeHtml(log.workDone)}</textarea>
              </div>
              <div class="form-actions" style="justify-content: flex-end;">
                <button type="button" id="cancel-edit" class="btn btn-secondary">Cancel</button>
                <button type="submit" class="btn btn-primary">Save Changes</button>
              </div>
            </form>
          `,
          () => {
            document.getElementById('cancel-edit').addEventListener('click', closeModal);
            document.getElementById('edit-log-form').addEventListener('submit', async (e) => {
              e.preventDefault();
              try {
                await api(`/api/logs/${logId}`, {
                  method: 'PATCH',
                  body: JSON.stringify({
                    project: document.getElementById('edit-project').value,
                    workDone: document.getElementById('edit-work').value,
                  }),
                });
                closeModal();
                await refreshWorkspaceData();
                render();
                toast('Entry updated.');
              } catch (err) {
                toast(err.message, true);
              }
            });
          }
        );
      });
    });

    appEl.querySelectorAll('[data-delete-log]').forEach((btn) => {
      btn.addEventListener('click', async () => {
        const logId = Number(btn.dataset.deleteLog);
        if (!confirm('Delete this work entry permanently?')) return;
        try {
          await api(`/api/logs/${logId}`, { method: 'DELETE' });
          await refreshWorkspaceData();
          render();
          toast('Entry deleted.');
        } catch (err) {
          toast(err.message, true);
        }
      });
    });
  }

  function renderEmployeeWorkspace() {
    const s = state.stats || {};
    appEl.innerHTML = `
      ${renderTopbar(false)}
      <main class="container">
        <section class="kpi-grid">
          <div class="kpi-card">
            <span class="kpi-label">My Entries Today</span>
            <span class="kpi-value tabular">${Number(s.todayCount || 0)}</span>
          </div>
          <div class="kpi-card">
            <span class="kpi-label">My Last 7 Days</span>
            <span class="kpi-value tabular">${Number(s.weekCount || 0)}</span>
          </div>
          <div class="kpi-card">
            <span class="kpi-label">My Projects</span>
            <span class="kpi-value tabular">${Number(s.projectCount || 0)}</span>
          </div>
        </section>

        ${renderLogEntryFormHtml('Log Today’s Work')}

        <section class="card">
          <div class="card-header">
            <div class="card-title-group">
              <h2 class="card-title">My Work History</h2>
              <p id="ledger-count-label" class="card-subtitle tabular">${state.logs.length} ${state.logs.length === 1 ? 'entry' : 'entries'} shown · Only visible to you and leadership</p>
            </div>
          </div>
          ${renderFilterToolbarHtml(false)}
          <div id="ledger-results">
            ${renderLedgerTableHtml(state.logs, true)}
          </div>
        </section>
      </main>
    `;

    bindTopbarEvents();
    bindLogEntryFormEvents();
    bindLedgerEvents(false);
    startClock();
  }

  function renderBossWorkspace() {
    if (state.bossTab === 'team') {
      renderBossTeamTab();
      return;
    }

    const s = state.stats || {};
    appEl.innerHTML = `
      ${renderTopbar(true)}
      <main class="container">
        <section class="kpi-grid">
          <div class="kpi-card">
            <span class="kpi-label">Entries Today</span>
            <span class="kpi-value tabular">${Number(s.todayCount || 0)}</span>
          </div>
          <div class="kpi-card">
            <span class="kpi-label">Active Contributors Today</span>
            <span class="kpi-value tabular">${Number(s.activeContributorsToday || 0)}</span>
          </div>
          <div class="kpi-card">
            <span class="kpi-label">Total Logged Entries</span>
            <span class="kpi-value tabular">${Number(s.totalCount || 0)}</span>
          </div>
          <div class="kpi-card">
            <span class="kpi-label">Active Projects</span>
            <span class="kpi-value tabular">${Number(s.projectCount || 0)}</span>
          </div>
        </section>

        <div style="display: flex; justify-content: flex-end;">
          <button type="button" id="toggle-boss-entry" class="btn btn-secondary btn-sm">
            ${state.showBossLogForm ? 'Hide Executive Entry Form' : '+ Log My Own Work Entry'}
          </button>
        </div>

        ${state.showBossLogForm ? renderLogEntryFormHtml('Log Executive Work Entry') : ''}

        <section class="card">
          <div class="card-header">
            <div class="card-title-group">
              <h2 class="card-title">Team Work Ledger</h2>
              <p id="ledger-count-label" class="card-subtitle tabular">${state.logs.length} ${state.logs.length === 1 ? 'entry' : 'entries'} shown across all team members</p>
            </div>
          </div>
          ${renderFilterToolbarHtml(true)}
          <div id="ledger-results">
            ${
              state.bossViewMode === 'grouped'
                ? renderGroupedBossHtml(state.logs)
                : renderLedgerTableHtml(state.logs, false)
            }
          </div>
        </section>
      </main>
    `;

    bindTopbarEvents();
    document.getElementById('toggle-boss-entry')?.addEventListener('click', () => {
      state.showBossLogForm = !state.showBossLogForm;
      render();
    });
    if (state.showBossLogForm) {
      bindLogEntryFormEvents();
      startClock();
    }
    bindLedgerEvents(true);
  }

  function renderBossTeamTab() {
    const resetRequests = state.team.filter((m) => Boolean(m.resetRequestedAt));
    const memberRows = state.team
      .map(
        (m) => `
      <tr>
        <td class="col-person">${escapeHtml(m.name)}</td>
        <td>${escapeHtml(m.email)}</td>
        <td><span class="role-badge ${m.role === 'boss' ? 'boss' : ''}">${m.role === 'boss' ? 'Executive' : 'Member'}</span></td>
        <td class="tabular">${m.entryCount}</td>
        <td class="col-datetime tabular">${m.lastLoggedAt ? escapeHtml(formatDateTime(m.lastLoggedAt)) : '—'}</td>
        <td>
          <span class="status-pill ${m.isActive ? 'active' : 'inactive'}">
            ${m.isActive ? 'Active' : 'Disabled'}
          </span>
          ${
            m.resetRequestedAt
              ? `<span class="status-pill warn" style="margin-left: 4px;">Reset Requested</span>`
              : ''
          }
        </td>
        <td class="col-actions">
          <button type="button" class="btn btn-ghost btn-sm" data-reset-pw="${m.id}" data-member-name="${escapeHtml(m.name)}">
            Reset Password
          </button>
          ${
            m.id !== state.user.id
              ? `
            <button type="button" class="btn btn-ghost btn-sm" data-toggle-active="${m.id}" data-next-active="${m.isActive ? '0' : '1'}">
              ${m.isActive ? 'Disable' : 'Enable'}
            </button>
            <button type="button" class="btn btn-danger-ghost btn-sm" data-remove-member="${m.id}" data-member-name="${escapeHtml(m.name)}">
              Remove
            </button>
          `
              : ''
          }
        </td>
      </tr>
    `
      )
      .join('');

    appEl.innerHTML = `
      ${renderTopbar(true)}
      <main class="container">
        ${
          resetRequests.length > 0
            ? `
          <div class="alert alert-warn" style="margin-bottom: 0;">
            <strong>Password reset requested:</strong> ${resetRequests
              .map((m) => escapeHtml(m.name))
              .join(', ')} — click <em>Reset Password</em> in the directory below to issue a temporary password.
          </div>
        `
            : ''
        }
        <section class="card">
          <div class="card-header">
            <div class="card-title-group">
              <h2 class="card-title">Team Invite Code</h2>
              <p class="card-subtitle">Share this code only with team members so they can register their isolated accounts.</p>
            </div>
          </div>
          <div class="card-body">
            <div class="form-actions">
              <div class="invite-box">
                <span class="code-display">${escapeHtml(state.teamInviteCode)}</span>
                <button type="button" id="copy-invite-btn" class="btn btn-secondary btn-sm">Copy Code</button>
              </div>
              <form id="invite-code-form" style="display: flex; gap: 8px; align-items: center;">
                <input id="new-invite-code" class="input" type="text" minlength="4" maxlength="64" required placeholder="New invite code" style="width: 190px;" />
                <button type="submit" class="btn btn-primary btn-sm">Update Code</button>
              </form>
            </div>
          </div>
        </section>

        <section class="card">
          <div class="card-header">
            <div class="card-title-group">
              <h2 class="card-title">Provision Team Member Directly</h2>
              <p class="card-subtitle">Create a member login on their behalf without sharing the invite code.</p>
            </div>
          </div>
          <div class="card-body">
            <form id="add-member-form" class="form-grid-3" style="align-items: end;">
              <div class="field">
                <label for="member-name">Full Name</label>
                <input id="member-name" class="input" type="text" required placeholder="Intern Full Name" />
              </div>
              <div class="field">
                <label for="member-email">Work Email</label>
                <input id="member-email" class="input" type="email" required placeholder="intern@company.com" />
              </div>
              <div class="field">
                <label for="member-password">Temporary Password</label>
                <div style="display: flex; gap: 8px;">
                  <input id="member-password" class="input" type="text" required minlength="6" placeholder="Min 6 chars" />
                  <button type="submit" class="btn btn-primary">Add</button>
                </div>
              </div>
            </form>
          </div>
        </section>

        <section class="card">
          <div class="card-header">
            <div class="card-title-group">
              <h2 class="card-title">Team Directory</h2>
              <p class="card-subtitle">Only visible to the executive account.</p>
            </div>
          </div>
          <div class="table-wrap">
            <table class="ledger-table">
              <thead>
                <tr>
                  <th>Name</th>
                  <th>Email</th>
                  <th>Role</th>
                  <th>Entries</th>
                  <th>Last Activity</th>
                  <th>Status</th>
                  <th style="text-align: right;">Actions</th>
                </tr>
              </thead>
              <tbody>${memberRows}</tbody>
            </table>
          </div>
        </section>
      </main>
    `;

    bindTopbarEvents();

    document.getElementById('copy-invite-btn').addEventListener('click', async () => {
      try {
        await navigator.clipboard.writeText(state.teamInviteCode);
        toast('Invite code copied.');
      } catch {
        toast('Copy failed — select and copy manually.', true);
      }
    });

    document.getElementById('invite-code-form').addEventListener('submit', async (e) => {
      e.preventDefault();
      try {
        const res = await api('/api/boss/invite-code', {
          method: 'PUT',
          body: JSON.stringify({ inviteCode: document.getElementById('new-invite-code').value }),
        });
        state.teamInviteCode = res.teamInviteCode;
        render();
        toast('Team invite code updated.');
      } catch (err) {
        toast(err.message, true);
      }
    });

    document.getElementById('add-member-form').addEventListener('submit', async (e) => {
      e.preventDefault();
      try {
        await api('/api/boss/team', {
          method: 'POST',
          body: JSON.stringify({
            name: document.getElementById('member-name').value,
            email: document.getElementById('member-email').value,
            password: document.getElementById('member-password').value,
          }),
        });
        await refreshWorkspaceData();
        render();
        toast('Team member added.');
      } catch (err) {
        toast(err.message, true);
      }
    });

    appEl.querySelectorAll('[data-toggle-active]').forEach((btn) => {
      btn.addEventListener('click', async () => {
        const id = Number(btn.dataset.toggleActive);
        const isActive = btn.dataset.nextActive === '1';
        try {
          await api(`/api/boss/team/${id}`, {
            method: 'PATCH',
            body: JSON.stringify({ isActive }),
          });
          await refreshWorkspaceData();
          render();
          toast(isActive ? 'Member enabled.' : 'Member disabled.');
        } catch (err) {
          toast(err.message, true);
        }
      });
    });

    appEl.querySelectorAll('[data-reset-pw]').forEach((btn) => {
      btn.addEventListener('click', () => {
        const id = Number(btn.dataset.resetPw);
        const name = btn.dataset.memberName;
        openModal(
          `Reset Password · ${name}`,
          `
            <form id="reset-pw-form" class="form-stack">
              <div class="field">
                <label for="reset-pw-input">New Password (min 6 characters)</label>
                <input id="reset-pw-input" class="input" type="text" required minlength="6" />
              </div>
              <div class="form-actions" style="justify-content: flex-end;">
                <button type="button" id="cancel-reset" class="btn btn-secondary">Cancel</button>
                <button type="submit" class="btn btn-primary">Update Password</button>
              </div>
            </form>
          `,
          () => {
            document.getElementById('cancel-reset').addEventListener('click', closeModal);
            document.getElementById('reset-pw-form').addEventListener('submit', async (e) => {
              e.preventDefault();
              try {
                await api(`/api/boss/team/${id}`, {
                  method: 'PATCH',
                  body: JSON.stringify({
                    password: document.getElementById('reset-pw-input').value,
                  }),
                });
                closeModal();
                await refreshWorkspaceData();
                render();
                toast('Password updated and old sessions signed out.');
              } catch (err) {
                toast(err.message, true);
              }
            });
          }
        );
      });
    });

    appEl.querySelectorAll('[data-remove-member]').forEach((btn) => {
      btn.addEventListener('click', async () => {
        const id = Number(btn.dataset.removeMember);
        const name = btn.dataset.memberName;
        if (!confirm(`Remove ${name} and all their work logs? This cannot be undone.`)) return;
        try {
          await api(`/api/boss/team/${id}`, { method: 'DELETE' });
          await refreshWorkspaceData();
          render();
          toast('Team member removed.');
        } catch (err) {
          toast(err.message, true);
        }
      });
    });
  }

  bootstrap();
})();
