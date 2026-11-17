import {
  saveToLocalStorage,
  resetAllBenches,
  exportWorkspaceToFile,
  importWorkspaceFromFile,
  cloudSync,
} from '../storage/workspaceStorage.js';
import { soundEngine } from '../audio/soundEngine.js';

export class WorkspaceStorageModal {
  constructor(labManager, getTranslator, callbacks = {}) {
    this.labManager = labManager;
    this.getTranslator = getTranslator;
    this.callbacks = callbacks; // { onNotify, onRefresh }
    this.isOpen = false;
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
      el.className = 'fixed inset-0 z-50 hidden items-center justify-center bg-black/60 backdrop-blur-xs p-4';
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

  open() {
    this.isOpen = true;
    this.rootEl.classList.remove('hidden');
    this.rootEl.classList.add('flex');
    // Lazy-init Firebase in background when modal opens so Auth state is fresh
    cloudSync.ensureFirebaseLoaded().catch(() => {});
    this.render();
  }

  close() {
    this.isOpen = false;
    this.rootEl.classList.add('hidden');
    this.rootEl.classList.remove('flex');
  }

  toggle() {
    if (this.isOpen) this.close();
    else this.open();
  }

  render() {
    if (!this.rootEl) return;
    const t = this.getTranslator();
    const user = cloudSync.user;
    const timeStr = this.lastAutoSaveTime
      ? new Date(this.lastAutoSaveTime).toLocaleTimeString()
      : t('storageAutoSaveReady');

    this.rootEl.innerHTML = `
      <div class="w-full max-w-lg rounded-2xl border border-theme bg-surface text-main shadow-2xl overflow-hidden animate-in">
        <!-- Header -->
        <div class="flex items-center justify-between px-5 py-3.5 border-b border-theme bg-surface-alt">
          <div class="flex items-center gap-2.5">
            <span class="text-lg">💾</span>
            <div>
              <h2 class="text-sm sm:text-base font-bold leading-tight">${t('storageModalTitle')}</h2>
              <p class="text-[11px] text-muted">${t('storageModalSubtitle')}</p>
            </div>
          </div>
          <button type="button" id="btn-storage-close" class="w-7 h-7 rounded-lg border border-theme bg-surface text-muted hover:text-main flex items-center justify-center text-sm font-bold">✕</button>
        </div>

        <div class="p-4 sm:p-5 space-y-4 max-h-[82vh] overflow-y-auto text-xs">
          <!-- LAYER 1: Browser LocalStorage Auto-Save -->
          <div class="p-3.5 rounded-xl border border-theme bg-surface-alt space-y-2.5">
            <div class="flex items-center justify-between">
              <span class="font-bold text-emerald-400">⚡ ${t('storageLayer1Title')}</span>
              <span id="storage-autosave-time" class="text-[11px] font-mono text-muted">${timeStr}</span>
            </div>
            <p class="text-[11px] text-muted leading-relaxed">${t('storageLayer1Desc')}</p>
            <div class="flex flex-wrap items-center gap-2 pt-1">
              <button type="button" id="btn-storage-save-local" class="px-3 py-1.5 rounded-lg bg-emerald-600 hover:bg-emerald-500 text-white font-semibold transition">
                💾 ${t('storageBtnSaveNow')}
              </button>
              <button type="button" id="btn-storage-reset-all" class="px-3 py-1.5 rounded-lg border border-rose-500/50 bg-rose-500/10 hover:bg-rose-500/20 text-rose-400 font-semibold transition">
                🔄 ${t('storageBtnResetAll')}
              </button>
            </div>
          </div>

          <!-- LAYER 2: Local .vlab / .json Export & Import -->
          <div class="p-3.5 rounded-xl border border-theme bg-surface-alt space-y-2.5">
            <div class="flex items-center justify-between">
              <span class="font-bold text-sky-400">📁 ${t('storageLayer2Title')}</span>
              <span class="text-[10px] font-mono px-2 py-0.5 rounded bg-surface border border-theme text-muted">.vlab / .json (v1.0.0)</span>
            </div>
            <p class="text-[11px] text-muted leading-relaxed">${t('storageLayer2Desc')}</p>
            <div class="flex flex-wrap items-center gap-2 pt-1">
              <button type="button" id="btn-storage-export-vlab" class="px-3 py-1.5 rounded-lg bg-accent hover:opacity-90 text-white font-semibold transition">
                📤 ${t('storageBtnExportVlab')}
              </button>
              <button type="button" id="btn-storage-import-vlab" class="px-3 py-1.5 rounded-lg border border-theme bg-surface hover:border-accent font-semibold transition">
                📥 ${t('storageBtnImportVlab')}
              </button>
              <input type="file" id="input-storage-import-vlab" accept=".vlab,.json,application/json" class="hidden" />
            </div>
          </div>

          <!-- LAYER 3: Firebase Cloud Sync & Classroom Share Code -->
          <div class="p-3.5 rounded-xl border border-theme bg-surface-alt space-y-3">
            <div class="flex items-center justify-between">
              <span class="font-bold text-amber-400">☁️ ${t('storageLayer3Title')}</span>
              <span class="text-[10px] font-mono px-2 py-0.5 rounded border ${
                user
                  ? 'border-emerald-500/50 bg-emerald-500/10 text-emerald-400'
                  : 'border-theme bg-surface text-muted'
              }">
                ${user ? `🟢 ${user.email || 'Signed In'}` : t('storageCloudSignedOut')}
              </span>
            </div>

            ${
              user
                ? `
              <div class="flex flex-wrap items-center gap-2">
                <button type="button" id="btn-cloud-save" class="px-3 py-1.5 rounded-lg bg-amber-500 hover:bg-amber-400 text-slate-950 font-bold transition">
                  ☁️ ${t('storageBtnCloudSave')}
                </button>
                <button type="button" id="btn-cloud-load" class="px-3 py-1.5 rounded-lg border border-theme bg-surface hover:border-amber-400 font-semibold transition">
                  📥 ${t('storageBtnCloudLoad')}
                </button>
                <button type="button" id="btn-cloud-signout" class="ml-auto px-2.5 py-1.5 rounded-lg border border-theme bg-surface text-muted hover:text-rose-400 transition">
                  ${t('storageBtnSignOut')}
                </button>
              </div>
            `
                : `
              <div class="space-y-2">
                <button type="button" id="btn-cloud-google" class="w-full py-2 px-3 rounded-lg bg-white text-slate-900 font-bold flex items-center justify-center gap-2 shadow hover:opacity-95 transition">
                  <span>🌐</span>
                  <span>${t('storageBtnGoogleSignIn')}</span>
                </button>
                <div class="grid grid-cols-1 sm:grid-cols-2 gap-2 pt-1">
                  <input id="input-cloud-email" type="email" placeholder="Email (user@example.com)" class="px-2.5 py-1.5 rounded-lg border border-theme bg-surface text-xs" />
                  <input id="input-cloud-password" type="password" placeholder="Password (≥6 chars)" class="px-2.5 py-1.5 rounded-lg border border-theme bg-surface text-xs" />
                </div>
                <div class="flex items-center gap-2">
                  <button type="button" id="btn-cloud-email-login" class="flex-1 py-1.5 px-3 rounded-lg bg-accent text-white font-semibold hover:opacity-90 transition">
                    🔑 ${t('storageBtnEmailSignIn')}
                  </button>
                  <button type="button" id="btn-cloud-email-register" class="py-1.5 px-3 rounded-lg border border-theme bg-surface hover:border-accent font-semibold transition">
                    ✨ ${t('storageBtnEmailRegister')}
                  </button>
                </div>
              </div>
            `
            }

            <!-- Classroom Share Code (LAB-XXX) -->
            <div class="pt-2.5 border-t border-theme space-y-2">
              <div class="flex items-center justify-between">
                <span class="font-semibold text-main">🔗 ${t('storageShareTitle')}</span>
                ${
                  this.lastGeneratedCode
                    ? `<span id="share-code-badge" class="px-2.5 py-0.5 rounded-md bg-amber-500/20 border border-amber-500/50 text-amber-300 font-mono font-bold">${this.lastGeneratedCode}</span>`
                    : ''
                }
              </div>
              <div class="flex flex-wrap items-center gap-2">
                <button type="button" id="btn-share-generate" class="px-3 py-1.5 rounded-lg border border-amber-500/50 bg-amber-500/15 hover:bg-amber-500/25 text-amber-300 font-semibold transition">
                  🔗 ${t('storageBtnShareCreate')}
                </button>
                <div class="flex items-center gap-1.5 flex-1 min-w-[180px]">
                  <input id="input-share-code" type="text" maxlength="10" placeholder="LAB-842" value="${this.lastGeneratedCode}"
                    class="w-full px-2.5 py-1.5 rounded-lg border border-theme bg-surface font-mono uppercase text-xs" />
                  <button type="button" id="btn-share-load" class="px-3 py-1.5 rounded-lg bg-surface border border-theme hover:border-accent font-semibold shrink-0 transition">
                    📥 ${t('storageBtnShareLoad')}
                  </button>
                </div>
              </div>
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
    this.rootEl.addEventListener('click', (e) => {
      if (e.target === this.rootEl) this.close();
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

    // Layer 2: Export & Import .vlab
    this.rootEl.querySelector('#btn-storage-export-vlab')?.addEventListener('click', () => {
      soundEngine.playUiClick();
      exportWorkspaceToFile(this.labManager);
      this.callbacks.onNotify?.(`📤 ${t('toastExportedVlab')}`);
    });

    const fileInput = this.rootEl.querySelector('#input-storage-import-vlab');
    this.rootEl.querySelector('#btn-storage-import-vlab')?.addEventListener('click', () => {
      fileInput?.click();
    });

    fileInput?.addEventListener('change', async (e) => {
      const file = e.target.files?.[0];
      if (!file) return;
      try {
        await importWorkspaceFromFile(file, this.labManager);
        soundEngine.playGlassClink('beaker_250', 0.8);
        this.callbacks.onRefresh?.();
        this.callbacks.onNotify?.(`📥 ${t('toastImportedVlab')}`);
        this.close();
      } catch (err) {
        this.callbacks.onNotify?.(`⚠️ ${t('toastImportFailed')}: ${err.message}`);
      }
    });

    // Layer 3: Firebase Auth
    this.rootEl.querySelector('#btn-cloud-google')?.addEventListener('click', async () => {
      try {
        await cloudSync.signInWithGoogle();
        this.callbacks.onNotify?.(`✅ ${t('toastCloudSignedIn')}`);
        this.render();
      } catch (err) {
        this.callbacks.onNotify?.(`⚠️ ${err.message || t('toastCloudError')}`);
      }
    });

    const handleEmailAuth = async (isRegister) => {
      const email = this.rootEl.querySelector('#input-cloud-email')?.value?.trim();
      const pass = this.rootEl.querySelector('#input-cloud-password')?.value || '';
      if (!email || pass.length < 6) {
        this.callbacks.onNotify?.(`⚠️ ${t('toastCloudCredentialsHint')}`);
        return;
      }
      try {
        await cloudSync.signInWithEmail(email, pass, isRegister);
        this.callbacks.onNotify?.(`✅ ${t('toastCloudSignedIn')}`);
        this.render();
      } catch (err) {
        this.callbacks.onNotify?.(`⚠️ ${err.message || t('toastCloudError')}`);
      }
    };

    this.rootEl.querySelector('#btn-cloud-email-login')?.addEventListener('click', () => handleEmailAuth(false));
    this.rootEl.querySelector('#btn-cloud-email-register')?.addEventListener('click', () => handleEmailAuth(true));

    this.rootEl.querySelector('#btn-cloud-signout')?.addEventListener('click', async () => {
      await cloudSync.signOutUser();
      this.render();
    });

    this.rootEl.querySelector('#btn-cloud-save')?.addEventListener('click', async () => {
      try {
        await cloudSync.saveWorkspaceToCloud(this.labManager);
        soundEngine.playUiClick();
        this.callbacks.onNotify?.(`☁️ ${t('toastCloudSaved')}`);
      } catch (err) {
        this.callbacks.onNotify?.(`⚠️ ${err.message || t('toastCloudError')}`);
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
        this.callbacks.onNotify?.(`⚠️ ${err.message || t('toastCloudError')}`);
      }
    });

    // Share code create & load
    this.rootEl.querySelector('#btn-share-generate')?.addEventListener('click', async () => {
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
        this.callbacks.onNotify?.(`⚠️ ${t('toastShareNotFound')}: ${codeInput}`);
      }
    });
  }
}
