import {
  saveToLocalStorage,
  resetAllBenches,
  exportWorkspaceToFile,
  exportScopedVlabFile,
  importWorkspaceFromFile,
  VLAB_SCOPES,
  cloudSync,
} from '../storage/workspaceStorage.js';
import { soundEngine } from '../audio/soundEngine.js';

const FIRESTORE_RULES_HELP = `rules_version = '2';
service cloud.firestore {
  match /databases/{database}/documents {
    match /users/{userId}/{document=**} {
      allow read, write: if request.auth != null && request.auth.uid == userId;
    }
    match /shared_benches/{shareCode} {
      allow get: if request.auth != null;
      allow list: if false;
      allow create, update, delete: if request.auth != null;
    }
  }
}`;

export class WorkspaceStorageModal {
  constructor(labManager, getTranslator, callbacks = {}) {
    this.labManager = labManager;
    this.getTranslator = getTranslator;
    this.callbacks = callbacks; // { onNotify, onRefresh, onAuthChange }
    this.isOpen = false;
    this.authMode = 'login'; // 'login' | 'register'
    this.showPassword = false;
    this.feedbackMsg = '';
    this.feedbackType = ''; // 'error' | 'success' | ''
    this.lastGeneratedCode = '';
    this.lastAutoSaveTime = null;
    this.rootEl = null;
    this._ensureRoot();

    cloudSync.subscribe(() => {
      if (this.isOpen) this.render();
      this.callbacks.onAuthChange?.(cloudSync.user);
    });
  }

  _ensureRoot() {
    let el = document.getElementById('workspace-storage-modal');
    if (!el) {
      el = document.createElement('div');
      el.id = 'workspace-storage-modal';
      el.className = 'storage-modal-backdrop hidden';
      document.body.appendChild(el);
    }
    this.rootEl = el;
  }

  setLastAutoSaveTime(ts) {
    this.lastAutoSaveTime = ts;
    const badge = this.rootEl?.querySelector('#storage-autosave-time');
    if (badge && ts) {
      badge.textContent = new Date(ts).toLocaleTimeString();
    }
  }

  open(focusTarget = null) {
    this.isOpen = true;
    this.feedbackMsg = '';
    if (focusTarget === 'register') {
      this.authMode = 'register';
    } else if (focusTarget === 'login') {
      this.authMode = 'login';
    }
    this.rootEl.classList.remove('hidden');
    cloudSync.ensureFirebaseLoaded().catch(() => {});
    this.render();
    if (focusTarget === 'auth' || focusTarget === 'login' || focusTarget === 'register') {
      setTimeout(() => this.rootEl?.querySelector('#input-cloud-email')?.focus(), 40);
    } else if (focusTarget === 'share') {
      setTimeout(() => this.rootEl?.querySelector('#input-share-code')?.focus(), 40);
    }
  }

  close() {
    this.isOpen = false;
    this.rootEl.classList.add('hidden');
  }

  toggle() {
    if (this.isOpen) this.close();
    else this.open();
  }

  _setFeedback(msg, type = 'error') {
    this.feedbackMsg = msg;
    this.feedbackType = type;
    const fbEl = this.rootEl?.querySelector('#cloud-auth-feedback');
    if (fbEl) {
      fbEl.textContent = msg;
      fbEl.className = `storage-status-banner ${type}`;
      fbEl.style.display = msg ? 'block' : 'none';
    }
  }

  render() {
    if (!this.rootEl) return;
    const t = this.getTranslator();
    const user = cloudSync.user;
    const roleTag = user ? (cloudSync.isTeacher() ? ' · teacher' : ' · student') : '';
    const examLocked = Boolean(this.labManager?.hasActiveExamLab?.());
    const timeStr = this.lastAutoSaveTime
      ? new Date(this.lastAutoSaveTime).toLocaleTimeString()
      : t('storageAutoSaveReady');
    const isReg = this.authMode === 'register';
    const passType = this.showPassword ? 'text' : 'password';

    this.rootEl.innerHTML = `
      <div class="storage-modal-card">
        <!-- Header -->
        <div class="storage-modal-header">
          <div class="flex items-center gap-2.5">
            <span class="text-lg">💾</span>
            <div>
              <h2 class="text-sm sm:text-base font-bold leading-tight">${t('storageModalTitle')}</h2>
              <p class="text-[11px] text-muted">${t('storageModalSubtitle')}</p>
            </div>
          </div>
          <button type="button" id="btn-storage-close" class="w-8 h-8 rounded-lg border border-theme bg-surface text-muted hover:text-main flex items-center justify-center text-sm font-bold">✕</button>
        </div>

        <div class="storage-modal-body">
          <!-- LAYER 3 (TOP PROMINENT): Firebase Account Login/Register, Cloud Save/Load & Share Code -->
          <div class="storage-section">
            <div class="flex items-center justify-between gap-2">
              <span class="font-bold text-amber-400">☁️ ${t('storageLayer3Title')}</span>
              <span class="text-[11px] font-mono px-2.5 py-0.5 rounded-full border ${
                user
                  ? 'border-emerald-500/40 bg-emerald-500/10 text-emerald-400 font-bold'
                  : 'border-theme bg-surface text-muted'
              }">
                ${user ? `🟢 ${user.email || 'Signed In'}${roleTag}` : `⚪ ${t('storageCloudSignedOut')}`}
              </span>
            </div>

            <div id="cloud-auth-feedback" class="storage-status-banner ${this.feedbackType || 'error'}" style="display:${
              this.feedbackMsg ? 'block' : 'none'
            }">${this.feedbackMsg}</div>

            ${
              user
                ? `
              <div class="flex flex-wrap items-center gap-2 pt-1">
                <button type="button" id="btn-cloud-save" class="storage-btn storage-btn-amber">
                  ☁️ ${t('storageBtnCloudSave')}
                </button>
                <button type="button" id="btn-cloud-load" class="storage-btn storage-btn-primary">
                  📥 ${t('storageBtnCloudLoad')}
                </button>
                <button type="button" id="btn-cloud-signout" class="storage-btn storage-btn-danger" style="margin-left:auto">
                  🚪 ${t('storageBtnSignOut')}
                </button>
              </div>
              ${
                !cloudSync.isTeacher()
                  ? `<div class="mt-2 pt-2 border-t border-theme/60 flex flex-wrap items-center gap-1.5 text-[11px]">
                      <span class="font-semibold text-amber-300 shrink-0">🎓 ${t('teacherInviteSectionLabel')}:</span>
                      <input id="input-teacher-invite" type="text" maxlength="16" placeholder="GV-XXXXXX"
                        class="storage-input font-mono uppercase" style="max-width:138px;padding:0.25rem 0.5rem;font-size:11.5px" />
                      <button type="button" id="btn-redeem-teacher-invite" class="storage-btn storage-btn-primary shrink-0" style="padding:0.25rem 0.65rem;font-size:11.5px">
                        ✨ ${t('teacherInviteRedeemBtn')}
                      </button>
                    </div>`
                  : ''
              }
            `
                : `
              <!-- Login / Register Switch Tabs -->
              <div class="auth-tab-strip">
                <button type="button" id="tab-auth-login" class="auth-tab-btn ${!isReg ? 'active' : ''}">
                  🔑 ${t('storageBtnEmailSignIn')}
                </button>
                <button type="button" id="tab-auth-register" class="auth-tab-btn ${isReg ? 'active' : ''}">
                  ✨ ${t('storageBtnEmailRegister')}
                </button>
              </div>

              <div class="flex flex-col gap-2">
                <input id="input-cloud-email" type="email" autocomplete="email" placeholder="Email (vd: hocsinh@truong.edu.vn)" class="storage-input" />
                <input id="input-cloud-password" type="${passType}" autocomplete="${
                  isReg ? 'new-password' : 'current-password'
                }" placeholder="${t('storagePasswordPlaceholder')}" class="storage-input" />
                ${
                  isReg
                    ? `<input id="input-cloud-password-confirm" type="${passType}" autocomplete="new-password" placeholder="${t('storagePasswordConfirmPlaceholder')}" class="storage-input" />`
                    : ''
                }
                <div class="flex items-center justify-between text-[11px] text-muted">
                  <label class="flex items-center gap-1.5 cursor-pointer select-none">
                    <input type="checkbox" id="chk-show-password" ${this.showPassword ? 'checked' : ''} />
                    <span>${t('storageShowPassword')}</span>
                  </label>
                  <span>Firebase Auth (sos-app-1c5ff)</span>
                </div>
                <div class="flex items-center gap-2">
                  <button type="button" id="btn-cloud-email-login" class="storage-btn ${
                    !isReg ? 'storage-btn-primary flex-1' : ''
                  }">
                    🔑 ${t('storageBtnEmailSignIn')}
                  </button>
                  <button type="button" id="btn-cloud-email-register" class="storage-btn ${
                    isReg ? 'storage-btn-primary flex-1' : ''
                  }">
                    ✨ ${t('storageBtnEmailRegister')}
                  </button>
                </div>
                <button type="button" id="btn-cloud-google" class="storage-btn-google">
                  <span>🌐</span>
                  <span>${t('storageBtnGoogleSignIn')}</span>
                </button>
              </div>
            `
            }

            <!-- Classroom Share Code (LAB-XXX) -->
            <div class="pt-2 border-t border-theme flex flex-col gap-2">
              <div class="flex items-center justify-between">
                <span class="font-semibold text-main">🔗 ${t('storageShareTitle')}</span>
                ${
                  this.lastGeneratedCode
                    ? `<span id="share-code-badge" class="px-2.5 py-0.5 rounded bg-amber-500/10 border border-amber-500/40 text-amber-400 font-mono font-bold">${this.lastGeneratedCode}</span>`
                    : ''
                }
              </div>
              <div class="flex flex-wrap items-center gap-2">
                <button type="button" id="btn-share-generate" class="storage-btn storage-btn-amber">
                  🔗 ${t('storageBtnShareCreate')}
                </button>
                <div class="flex items-center gap-1.5 flex-1">
                  <input id="input-share-code" type="text" maxlength="10" placeholder="LAB-842" value="${this.lastGeneratedCode}"
                    class="storage-input font-mono uppercase" style="max-width:130px" />
                  <button type="button" id="btn-share-load" class="storage-btn storage-btn-primary shrink-0">
                    📥 ${t('storageBtnShareLoad')}
                  </button>
                </div>
              </div>
            </div>
          </div>

          <!-- LAYER 2: Scoped .vlab Export & Import -->
          <div class="storage-section">
            <div class="flex items-center justify-between">
              <span class="font-bold text-sky-400">📁 ${t('storageLayer2Title')}</span>
              <span class="text-[10px] font-mono px-2 py-0.5 rounded bg-surface border border-theme text-muted">.vlab / .json (v1.0.0)</span>
            </div>
            ${
              examLocked
                ? `<div class="p-2 rounded-lg border border-red-500/40 bg-red-500/10 text-xs text-red-300 font-semibold">🔒 ${t('examLockExportMsg')}</div>`
                : `<p class="text-[11px] text-muted leading-relaxed">${t('storageLayer2Desc')}</p>
            <div class="flex flex-wrap items-center gap-2">
              <button type="button" id="btn-storage-export-vlab" class="storage-btn storage-btn-primary">
                📤 ${t('storageBtnExportVlab')}
              </button>
              <button type="button" id="btn-storage-export-full" class="storage-btn storage-btn-amber">
                📦 ${t('storageBtnExportFullLab')}
              </button>
              <button type="button" id="btn-storage-import-vlab" class="storage-btn">
                📥 ${t('storageBtnImportVlab')}
              </button>
              <input type="file" id="input-storage-import-vlab" accept=".vlab,.json,application/json" class="hidden" />
            </div>`
            }
          </div>

          <!-- LAYER 1: Browser LocalStorage Auto-Save -->
          <div class="storage-section">
            <div class="flex items-center justify-between">
              <span class="font-bold text-emerald-400">⚡ ${t('storageLayer1Title')}</span>
              <span id="storage-autosave-time" class="text-[11px] font-mono text-muted">${timeStr}</span>
            </div>
            <p class="text-[11px] text-muted leading-relaxed">${t('storageLayer1Desc')}</p>
            <div class="flex flex-wrap items-center gap-2">
              <button type="button" id="btn-storage-save-local" class="storage-btn storage-btn-emerald">
                💾 ${t('storageBtnSaveNow')}
              </button>
              <button type="button" id="btn-storage-reset-all" class="storage-btn storage-btn-danger">
                🔄 ${t('storageBtnResetAll')}
              </button>
            </div>
          </div>
        </div>
      </div>
    `;

    this._bindEvents();
  }

  _bindEvents() {
    const t = this.getTranslator();

    this.rootEl.querySelector('#btn-storage-close')?.addEventListener('click', () => this.close());
    this.rootEl.onclick = (e) => {
      if (e.target === this.rootEl) this.close();
    };

    // Auth Mode Tabs
    this.rootEl.querySelector('#tab-auth-login')?.addEventListener('click', () => {
      this.authMode = 'login';
      this.feedbackMsg = '';
      this.render();
    });
    this.rootEl.querySelector('#tab-auth-register')?.addEventListener('click', () => {
      this.authMode = 'register';
      this.feedbackMsg = '';
      this.render();
    });

    this.rootEl.querySelector('#chk-show-password')?.addEventListener('change', (e) => {
      this.showPassword = Boolean(e.target.checked);
      const p1 = this.rootEl.querySelector('#input-cloud-password');
      const p2 = this.rootEl.querySelector('#input-cloud-password-confirm');
      if (p1) p1.type = this.showPassword ? 'text' : 'password';
      if (p2) p2.type = this.showPassword ? 'text' : 'password';
    });

    // Layer 1: LocalStorage Save & Reset All
    this.rootEl.querySelector('#btn-storage-save-local')?.addEventListener('click', () => {
      soundEngine.playUiClick();
      const ok = saveToLocalStorage(this.labManager);
      if (ok) {
        this.setLastAutoSaveTime(Date.now());
        this.callbacks.onNotify?.(`💾 ${t('toastLocalSaved')}`);
      }
    });

    this.rootEl.querySelector('#btn-storage-reset-all')?.addEventListener('click', () => {
      soundEngine.playTrashCrumple();
      resetAllBenches(this.labManager);
      this.callbacks.onRefresh?.();
      this.callbacks.onNotify?.(`🔄 ${t('toastResetAllBenches')}`);
      this.close();
    });

    // Layer 2: Export & Import .vlab (standardized scope & custom naming)
    this.rootEl.querySelector('#btn-storage-export-vlab')?.addEventListener('click', () => {
      soundEngine.playUiClick();
      if (this.callbacks.onRequestExportSingleBench) {
        this.close();
        this.callbacks.onRequestExportSingleBench();
      } else {
        exportWorkspaceToFile(this.labManager);
        this.callbacks.onNotify?.(`📤 ${t('toastExportedVlab')}`);
      }
    });

    this.rootEl.querySelector('#btn-storage-export-full')?.addEventListener('click', () => {
      soundEngine.playUiClick();
      const fname = exportScopedVlabFile(VLAB_SCOPES.FULL_LAB, this.labManager);
      if (fname) this.callbacks.onNotify?.(`📤 ${t('toastExportedVlab')} (${fname})`);
    });

    const fileInput = this.rootEl.querySelector('#input-storage-import-vlab');
    this.rootEl.querySelector('#btn-storage-import-vlab')?.addEventListener('click', () => {
      fileInput?.click();
    });

    fileInput?.addEventListener('change', async (e) => {
      const file = e.target.files?.[0];
      if (!file) return;
      try {
        if (this.callbacks.onImportVlabFile) {
          this.close();
          await this.callbacks.onImportVlabFile(file);
        } else {
          await importWorkspaceFromFile(file, this.labManager);
          soundEngine.playGlassClink('beaker_250', 0.8);
          this.callbacks.onRefresh?.();
          this.callbacks.onNotify?.(`📥 ${t('toastImportedVlab')}`);
          this.close();
        }
      } catch (err) {
        this.callbacks.onNotify?.(`⚠️ ${t('toastImportFailed')}: ${err.message}`);
      } finally {
        e.target.value = '';
      }
    });

    // Layer 3: Firebase Auth
    this.rootEl.querySelector('#btn-cloud-google')?.addEventListener('click', async () => {
      try {
        this._setFeedback('⏳ Đang kết nối Google...', 'success');
        await cloudSync.signInWithGoogle();
        this.feedbackMsg = '';
        this.callbacks.onNotify?.(`✅ ${t('toastCloudSignedIn')}`);
        this.render();
      } catch (err) {
        this._setFeedback(`⚠️ ${err.message || t('toastCloudError')}`, 'error');
        this.callbacks.onNotify?.(`⚠️ ${err.message || t('toastCloudError')}`);
      }
    });

    const handleEmailAuth = async (isRegister) => {
      const email = this.rootEl.querySelector('#input-cloud-email')?.value?.trim();
      const pass = this.rootEl.querySelector('#input-cloud-password')?.value || '';
      const passConfirm = this.rootEl.querySelector('#input-cloud-password-confirm')?.value;
      if (!email || !email.includes('@') || pass.length < 6) {
        this._setFeedback(`⚠️ ${t('toastCloudCredentialsHint')}`, 'error');
        this.callbacks.onNotify?.(`⚠️ ${t('toastCloudCredentialsHint')}`);
        return;
      }
      if (isRegister && passConfirm !== undefined && pass !== passConfirm) {
        this._setFeedback(`⚠️ ${t('storagePasswordMismatch')}`, 'error');
        return;
      }
      try {
        this._setFeedback('⏳ Đang xác thực Firebase...', 'success');
        await cloudSync.signInWithEmail(email, pass, isRegister);
        this.feedbackMsg = '';
        this.callbacks.onNotify?.(`✅ ${t('toastCloudSignedIn')}`);
        this.render();
      } catch (err) {
        this._setFeedback(`⚠️ ${err.message || t('toastCloudError')}`, 'error');
        this.callbacks.onNotify?.(`⚠️ ${err.message || t('toastCloudError')}`);
      }
    };

    this.rootEl.querySelector('#btn-cloud-email-login')?.addEventListener('click', () => {
      if (this.authMode === 'register') {
        this.authMode = 'login';
        this.render();
        return;
      }
      handleEmailAuth(false);
    });
    this.rootEl.querySelector('#btn-cloud-email-register')?.addEventListener('click', () => {
      if (this.authMode === 'login' && !this.rootEl.querySelector('#input-cloud-email')?.value?.trim()) {
        this.authMode = 'register';
        this.render();
        return;
      }
      handleEmailAuth(true);
    });

    this.rootEl.querySelector('#btn-cloud-signout')?.addEventListener('click', async () => {
      await cloudSync.signOutUser();
      this.render();
    });

    this.rootEl.querySelector('#btn-redeem-teacher-invite')?.addEventListener('click', async () => {
      const code = this.rootEl.querySelector('#input-teacher-invite')?.value?.trim() || '';
      if (!code) {
        this._setFeedback(`⚠️ ${t('teacherInviteInvalidMsg')}`, 'error');
        return;
      }
      try {
        await cloudSync.redeemTeacherInvite(code);
        soundEngine.playUiClick();
        this._setFeedback(`🎉 ${t('teacherInviteSuccessMsg')}`, 'success');
        this.callbacks.onNotify?.(`🎓 ${t('teacherInviteSuccessMsg')}`);
        this.callbacks.onRefresh?.();
        this.render();
      } catch (err) {
        const msgKey =
          err?.message === 'INVITE_CODE_INVALID'
            ? 'teacherInviteInvalidMsg'
            : err?.message === 'INVITE_CODE_NOT_FOUND'
            ? 'teacherInviteNotFoundMsg'
            : err?.message === 'INVITE_CODE_USED'
            ? 'teacherInviteUsedMsg'
            : err?.message === 'INVITE_CODE_EXPIRED'
            ? 'teacherInviteExpiredMsg'
            : 'toastCloudError';
        const txt = t(msgKey);
        this._setFeedback(`⚠️ ${txt}`, 'error');
        this.callbacks.onNotify?.(`⚠️ ${txt}`);
      }
    });

    this.rootEl.querySelector('#btn-cloud-save')?.addEventListener('click', async () => {
      try {
        await cloudSync.saveWorkspaceToCloud(this.labManager);
        soundEngine.playUiClick();
        this._setFeedback(`✅ ${t('toastCloudSaved')}`, 'success');
        this.callbacks.onNotify?.(`☁️ ${t('toastCloudSaved')}`);
      } catch (err) {
        if (err?.message === 'CLOUD_PERMISSION_DENIED' || err?.code === 'permission-denied') {
          this._renderPermissionError(t);
          this.callbacks.onNotify?.(`⚠️ ${t('toastCloudPermissionErr')}`);
        } else {
          this._setFeedback(`⚠️ ${err.message || t('toastCloudError')}`, 'error');
          this.callbacks.onNotify?.(`⚠️ ${err.message || t('toastCloudError')}`);
        }
      }
    });

    this.rootEl.querySelector('#btn-cloud-load')?.addEventListener('click', async () => {
      try {
        await cloudSync.loadWorkspaceFromCloud(this.labManager);
        soundEngine.playGlassClink('beaker_250', 0.8);
        this.callbacks.onRefresh?.();
        this.callbacks.onNotify?.(`☁️ ${t('toastCloudLoaded')}`);
        this.close();
      } catch (err) {
        if (err?.message === 'CLOUD_PERMISSION_DENIED' || err?.code === 'permission-denied') {
          this._renderPermissionError(t);
          this.callbacks.onNotify?.(`⚠️ ${t('toastCloudPermissionErr')}`);
        } else {
          this._setFeedback(`⚠️ ${err.message || t('toastCloudError')}`, 'error');
          this.callbacks.onNotify?.(`⚠️ ${err.message || t('toastCloudError')}`);
        }
      }
    });

    // Share code create & load
    this.rootEl.querySelector('#btn-share-generate')?.addEventListener('click', async () => {
      if (this.labManager?.hasActiveExamLab?.()) {
        this._setFeedback(`🔒 ${t('examLockExportMsg')}`, 'error');
        return;
      }
      try {
        const code = await cloudSync.createBenchShareCode(this.labManager);
        this.lastGeneratedCode = code;
        try {
          await navigator.clipboard?.writeText(code);
        } catch {}
        soundEngine.playUiClick();
        this.render();
        this.callbacks.onNotify?.(`🔗 ${t('toastShareCreated')}: ${code}`);
      } catch (err) {
        this.callbacks.onNotify?.(`⚠️ ${err.message}`);
      }
    });

    this.rootEl.querySelector('#btn-share-load')?.addEventListener('click', async () => {
      const codeInput = this.rootEl.querySelector('#input-share-code')?.value?.trim();
      if (!codeInput) return;
      try {
        const { shareCode } = await cloudSync.loadBenchByShareCode(codeInput, this.labManager);
        soundEngine.playGlassClink('erlenmeyer_250', 0.85);
        this.callbacks.onRefresh?.();
        this.callbacks.onNotify?.(`📥 ${t('toastShareLoaded')}: ${shareCode}`);
        this.close();
      } catch (err) {
        this._setFeedback(`⚠️ ${t('toastShareNotFound')}: ${codeInput}`, 'error');
        this.callbacks.onNotify?.(`⚠️ ${t('toastShareNotFound')}: ${codeInput}`);
      }
    });
  }

  _renderPermissionError(t) {
    const fbEl = this.rootEl?.querySelector('#cloud-auth-feedback');
    if (!fbEl) return;
    fbEl.className = 'storage-status-banner error';
    fbEl.style.display = 'block';
    fbEl.innerHTML = `
      <div class="flex flex-col gap-1.5">
        <span>⚠️ ${t('toastCloudPermissionErr')}</span>
        <div class="flex flex-wrap items-center gap-2">
          <button type="button" id="btn-copy-firestore-rules" class="storage-btn storage-btn-amber text-xs">📋 Copy Firestore Rules</button>
          <span class="text-[10px] opacity-85">Project: <code>sos-app-1c5ff</code></span>
        </div>
      </div>
    `;
    fbEl.querySelector('#btn-copy-firestore-rules')?.addEventListener('click', async () => {
      try {
        await navigator.clipboard?.writeText(FIRESTORE_RULES_HELP);
        this.callbacks.onNotify?.('📋 Copied Firestore Rules to clipboard!');
      } catch {}
    });
  }
}
