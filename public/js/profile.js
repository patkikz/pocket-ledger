import {
  state,
  showToast,
  apiFetch,
  handleActionError,
  readErrorMessage,
  withButtonLoading,
  switchView,
  applyTheme,
  getUserInitials,
} from './state.js';
import { fetchDashboard } from './dashboard.js';

const DEMO_EMAILS = new Set(['patrick@pocketledger.app', 'alex.isolated@pocketledger.app']);
let selectedAvatarColor = '#6366f1';

function syncAvatarDisplay(user) {
  const initials = getUserInitials(user);
  const color = user?.avatarColor || '#6366f1';
  const topbarAvatar = document.getElementById('topbarAvatar');
  const profileAvatarLg = document.getElementById('profileAvatarLg');
  if (topbarAvatar) {
    topbarAvatar.textContent = initials;
    topbarAvatar.style.background = color;
  }
  if (profileAvatarLg) {
    profileAvatarLg.textContent = initials;
    profileAvatarLg.style.background = color;
  }
}

export function closeProfileDropdown() {
  const dropdown = document.getElementById('profileDropdown');
  const btn = document.getElementById('openProfileBtn');
  if (dropdown) dropdown.classList.add('hidden');
  if (btn) btn.setAttribute('aria-expanded', 'false');
}

export function switchAccountTab(tabName) {
  document.querySelectorAll('.account-nav-item').forEach((btn) => {
    btn.classList.toggle('active', btn.dataset.accountTab === tabName);
  });
  document.querySelectorAll('.account-tab-panel').forEach((panel) => {
    panel.classList.toggle('hidden', panel.id !== `accountTab-${tabName}`);
  });
}

export function renderProfile(user, accounts = []) {
  if (!user) return;
  selectedAvatarColor = user.avatarColor || '#6366f1';
  syncAvatarDisplay(user);

  const displayName = user.displayName || (user.email ? user.email.split('@')[0] : '—');
  const dropdownName = document.getElementById('dropdownDisplayName');
  const dropdownEmail = document.getElementById('dropdownEmail');
  if (dropdownName) dropdownName.textContent = displayName;
  if (dropdownEmail) dropdownEmail.textContent = user.email || '—';

  document.getElementById('profileEmail').textContent = user.email || '—';
  document.getElementById('profileNameInput').value = user.displayName || '';

  document.querySelectorAll('#profileColorPicker .color-swatch').forEach((btn) => {
    btn.classList.toggle('active', btn.dataset.color === selectedAvatarColor);
  });

  const activeTheme = user.theme || 'system';
  document.querySelectorAll('[data-theme-choice]').forEach((btn) => {
    const isActive = btn.dataset.themeChoice === activeTheme;
    btn.classList.toggle('active', isActive);
    btn.setAttribute('aria-checked', String(isActive));
  });
  applyTheme(activeTheme);

  document.getElementById('currencySelect').value = user.homeCurrencyCode || 'USD';
  document.getElementById('cycleStartDaySelect').value = String(user.budgetCycleStartDay || 1);

  const defaultAccountSelect = document.getElementById('defaultAccountSelect');
  if (defaultAccountSelect) {
    const activeAccounts = accounts.filter((a) => !a.isArchived);
    defaultAccountSelect.innerHTML = '<option value="">Smart default (last used)</option>' +
      activeAccounts.map((a) => `<option value="${a.id}">${a.name}</option>`).join('');
    defaultAccountSelect.value = user.defaultAccountId && activeAccounts.some((a) => a.id === user.defaultAccountId)
      ? user.defaultAccountId
      : '';
  }

  const isDemo = DEMO_EMAILS.has(String(user.email || '').toLowerCase());
  document.getElementById('demoPasswordNotice').classList.toggle('hidden', !isDemo);
  document.getElementById('changePasswordFields').classList.toggle('hidden', isDemo);
}

async function patchProfile(patch, successMessage) {
  const res = await apiFetch('/api/profile', {
    method: 'PATCH',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(patch),
  });
  if (!res.ok) {
    showToast(await readErrorMessage(res, 'Could not update profile.'), true);
    return null;
  }
  const data = await res.json();
  state.user = data.user;
  renderProfile(data.user, state.dashboard?.accounts || []);
  if (successMessage) showToast(successMessage);
  return data.user;
}

export function initProfileHandlers() {
  const openProfileBtn = document.getElementById('openProfileBtn');
  const profileDropdown = document.getElementById('profileDropdown');

  openProfileBtn.addEventListener('click', (e) => {
    e.stopPropagation();
    const willOpen = profileDropdown.classList.contains('hidden');
    profileDropdown.classList.toggle('hidden', !willOpen);
    openProfileBtn.setAttribute('aria-expanded', String(willOpen));
  });

  document.addEventListener('click', (e) => {
    if (!e.target.closest('.profile-menu-wrap')) {
      closeProfileDropdown();
    }
  });

  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') closeProfileDropdown();
  });

  document.getElementById('openAccountPageBtn').addEventListener('click', () => {
    closeProfileDropdown();
    switchAccountTab('preferences');
    switchView('profile');
  });

  document.getElementById('backToDashboardBtn').addEventListener('click', () => {
    switchView('home');
  });

  document.querySelector('.account-sidebar').addEventListener('click', (e) => {
    const btn = e.target.closest('[data-account-tab]');
    if (!btn) return;
    switchAccountTab(btn.dataset.accountTab);
  });

  document.getElementById('dropdownLogoutBtn').addEventListener('click', () => {
    closeProfileDropdown();
    document.getElementById('logoutBtn').click();
  });

  document.getElementById('profileColorPicker').addEventListener('click', (e) => {
    const swatch = e.target.closest('.color-swatch');
    if (!swatch) return;
    selectedAvatarColor = swatch.dataset.color;
    document.querySelectorAll('#profileColorPicker .color-swatch').forEach((btn) => {
      btn.classList.toggle('active', btn.dataset.color === selectedAvatarColor);
    });
  });

  document.getElementById('profileIdentityForm').addEventListener('submit', async (e) => {
    e.preventDefault();
    const saveBtn = document.getElementById('saveIdentityBtn');
    const displayName = document.getElementById('profileNameInput').value.trim();
    await withButtonLoading(saveBtn, 'Saving...', async () => {
      try {
        await patchProfile(
          { displayName, avatarColor: selectedAvatarColor },
          'Profile updated.'
        );
      } catch (err) {
        handleActionError(err, 'Could not update profile.');
      }
    });
  });

  async function handleThemeChoice(e) {
    const item = e.target.closest('[data-theme-choice]');
    if (!item) return;
    const theme = item.dataset.themeChoice;
    applyTheme(theme);
    try {
      await patchProfile({ theme });
    } catch (err) {
      handleActionError(err, 'Could not update theme.');
    }
  }

  document.getElementById('dropdownThemeList').addEventListener('click', handleThemeChoice);
  document.getElementById('themeRadioList').addEventListener('click', handleThemeChoice);

  document.getElementById('currencySelect').addEventListener('change', async (e) => {
    const homeCurrencyCode = e.target.value;
    try {
      const updated = await patchProfile({ homeCurrencyCode }, `Home currency updated to ${homeCurrencyCode}.`);
      if (updated) await fetchDashboard();
    } catch (err) {
      handleActionError(err, 'Could not update currency.');
    }
  });

  document.getElementById('cycleStartDaySelect').addEventListener('change', async (e) => {
    const budgetCycleStartDay = Number(e.target.value);
    try {
      const updated = await patchProfile(
        { budgetCycleStartDay },
        `Monthly budget reset day updated to Day ${budgetCycleStartDay}.`
      );
      if (updated) await fetchDashboard();
    } catch (err) {
      handleActionError(err, 'Could not update budget reset day.');
    }
  });

  document.getElementById('defaultAccountSelect').addEventListener('change', async (e) => {
    const defaultAccountId = e.target.value || null;
    try {
      const updated = await patchProfile({ defaultAccountId }, 'Default quick-entry account updated.');
      if (updated) {
        state.selectedAccountId = updated.defaultAccountId || state.dashboard?.smartDefaults?.accountId || null;
      }
    } catch (err) {
      handleActionError(err, 'Could not update default account.');
    }
  });

  document.getElementById('changePasswordForm').addEventListener('submit', async (e) => {
    e.preventDefault();
    const currentPassword = document.getElementById('currentPasswordInput').value;
    const newPassword = document.getElementById('newPasswordInput').value;
    const confirmPassword = document.getElementById('confirmPasswordInput').value;
    if (newPassword !== confirmPassword) {
      showToast('New passwords do not match.', true);
      return;
    }
    const saveBtn = document.getElementById('savePasswordBtn');
    await withButtonLoading(saveBtn, 'Updating...', async () => {
      try {
        const res = await apiFetch('/api/auth/change-password', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ currentPassword, newPassword }),
        });
        if (!res.ok) {
          showToast(await readErrorMessage(res, 'Could not update password.'), true);
          return;
        }
        e.target.reset();
        showToast('Password updated.');
      } catch (err) {
        handleActionError(err, 'Could not update password.');
      }
    });
  });

  document.getElementById('txDateInput').addEventListener('change', (e) => {
    if (e.target.value) {
      state.referenceDate = e.target.value;
      fetchDashboard().catch((err) => handleActionError(err, 'Could not load dashboard.'));
    }
  });
}
