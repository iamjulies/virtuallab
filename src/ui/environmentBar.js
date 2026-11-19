import { CONSTANTS, kelvinToCelsius, waterBoilingPointK } from '../data/constants.js';

export class EnvironmentBar {
  constructor(container, sim, appState, callbacks) {
    this.container = container;
    this.sim = sim;
    this.appState = appState; // { lang, theme, deviceMode }
    this.callbacks = callbacks; // { onLangChange, onThemeChange, onDeviceChange, onPreset }
  }

  setSim(sim) {
    this.sim = sim;
  }

  render(t) {
    const env = this.sim.environment;
    const tempC = kelvinToCelsius(env.tempK);
    const boilC = kelvinToCelsius(waterBoilingPointK(env.pressureBar));
    const { lang, theme, deviceMode } = this.appState;

    this.container.innerHTML = `
      <div class="env-header-inner border-b border-theme bg-surface">
        <!-- Brand -->
        <div class="env-toolbar-group gap-2">
          <div class="w-8 h-8 rounded-xl bg-accent text-white flex items-center justify-center text-base font-bold shadow-sm shrink-0">
            ⚗️
          </div>
          <div class="min-w-0">
            <div class="flex items-center gap-1.5 whitespace-nowrap">
              <h1 class="text-sm font-bold leading-none whitespace-nowrap">${t('appTitle')}</h1>
              <span id="app-version-badge" class="text-[11px] font-mono px-1.5 py-0.5 rounded border border-theme bg-surface-alt text-muted whitespace-nowrap">virlab_beta_v4+build.4</span>
              <span class="env-compact-hide text-xs px-2 py-0.5 rounded-full border border-theme bg-surface-alt text-muted whitespace-nowrap">
                ${theme === 'olivia' ? 'u + me = <3 · 🐝' : theme === 'ctrl' ? 'draft · 4:20 pm' : theme === 'sos' ? 'deep sea · sos' : t('modeFreeSandbox')}
              </span>
            </div>
            <p class="env-compact-hide text-[11px] text-muted mt-0.5 hidden xl:block whitespace-nowrap">${t('appSubtitle')}</p>
          </div>
        </div>

        <!-- Lab Environment Controls: T (298.15 K), P (1.00 bar), Speed -->
        <div class="env-toolbar-group">
          ${(() => {
            const isSatp =
              Math.abs(env.tempK - CONSTANTS.T_STD_K) <= 0.15 &&
              Math.abs(env.pressureBar - CONSTANTS.P_STD_BAR) <= 0.015;
            const isCryo = env.tempK < CONSTANTS.T_FREEZE_WATER_K - 0.05;
            const badgeLabel = isSatp ? t('envBadgeSatp') : isCryo ? t('envBadgeCryo') : t('envBadgeCustom');
            const badgeCls = isSatp
              ? 'px-2 py-0.5 rounded border border-emerald-500/40 bg-emerald-500/10 text-xs font-semibold text-emerald-400 hover:opacity-90'
              : isCryo
              ? 'px-2 py-0.5 rounded border border-sky-500/35 bg-sky-500/10 text-xs font-semibold text-sky-400 hover:opacity-90'
              : 'px-2 py-0.5 rounded border border-amber-500/40 bg-amber-500/10 text-xs font-semibold text-amber-400 hover:opacity-90';
            return `<!-- Ambient Temperature -->
          <div class="flex items-center gap-1.5 px-2.5 py-1.5 rounded-lg border border-theme bg-surface-alt">
            <span class="text-xs text-muted hidden sm:inline">🌡️ ${t('envTemp')}:</span>
            <input id="env-temp-input" type="number" min="200" max="450" step="1" value="${env.tempK.toFixed(2)}"
              class="w-[70px] px-1.5 py-0.5 rounded border border-theme bg-surface text-xs font-mono font-bold text-right" />
            <span class="text-xs font-mono">K <span class="text-muted">(${tempC.toFixed(1)}°C)</span></span>
            <button type="button" id="btn-std-satp" title="${t('envBadgeResetTip')}"
              class="${badgeCls}">${badgeLabel}</button>
          </div>`;
          })()}

          <!-- Ambient Pressure -->
          <div class="flex items-center gap-1.5 px-2.5 py-1.5 rounded-lg border border-theme bg-surface-alt">
            <span class="text-xs text-muted hidden sm:inline">⏱️ ${t('envPress')}:</span>
            <input id="env-press-input" type="number" min="0.2" max="4.0" step="0.05" value="${env.pressureBar.toFixed(2)}"
              class="w-[58px] px-1.5 py-0.5 rounded border border-theme bg-surface text-xs font-mono font-bold text-right" />
            <span class="text-xs font-mono">bar <span class="text-muted hidden xl:inline">(bp ${boilC.toFixed(1)}°C)</span></span>
          </div>

          <!-- Strong UV / Sunlight Toggle for AgCl(s) Photolysis -->
          <button type="button" id="btn-uv-light" title="${t('envUvTip')}"
            class="px-2.5 py-1.5 rounded-lg border text-xs font-semibold transition ${
              env.uvLight
                ? 'border-violet-500/70 bg-violet-500/20 text-violet-300'
                : 'border-theme bg-surface-alt text-muted hover:text-main'
            }">${env.uvLight ? t('envUvBright') : `💡 ${t('envUvRoom')}`}</button>

          <!-- Atmosphere Mode Toggle: Standard Air (78% N2, 21% O2) vs Inert Glovebox (N2/Ar) -->
          <button type="button" id="btn-atm-mode" title="${t('envAtmTip')}"
            class="px-2.5 py-1.5 rounded-lg border text-xs font-semibold transition ${
              env.atmosphereMode === 'inert'
                ? 'border-cyan-500/70 bg-cyan-500/20 text-cyan-300'
                : 'border-emerald-500/50 bg-emerald-500/10 text-emerald-400 hover:opacity-90'
            }">${env.atmosphereMode === 'inert' ? `🛡️ ${t('envAtmInert')}` : `🌬️ ${t('envAtmAir')}`}</button>

          <!-- Multi-Spectral Optics Selector: Normal / Aerodynamics / Thermal FLIR -->
          <select id="optics-select" title="${t('opticsLabel')}" class="px-2 py-1.5 rounded-lg border border-theme bg-surface-alt text-main text-xs font-semibold">
            <option value="normal" ${(env.opticsMode || 'normal') === 'normal' ? 'selected' : ''}>👁️ ${t('opticsNormal')}</option>
            <option value="aerodynamics" ${env.opticsMode === 'aerodynamics' ? 'selected' : ''}>💨 ${t('opticsAero')}</option>
            <option value="thermal" ${env.opticsMode === 'thermal' ? 'selected' : ''}>🌡️ ${t('opticsThermal')}</option>
          </select>

          <!-- Speed & Pause -->
          <div class="flex items-center gap-1 p-1 rounded-lg border border-theme bg-surface-alt">
            <button type="button" id="btn-pause" class="px-2 py-1 rounded text-xs font-semibold ${
              env.paused ? 'bg-amber-500 text-white' : 'bg-surface border border-theme'
            }">
              ${env.paused ? `▶ ${t('resume')}` : `⏸ ${t('pause')}`}
            </button>
            ${[0.5, 1, 2, 4]
              .map(
                (spd) => `
              <button type="button" data-speed="${spd}" class="speed-btn px-2 py-1 rounded text-xs font-mono ${
                env.speed === spd ? 'bg-accent text-white font-bold' : 'text-muted hover:text-main'
              }">${spd}x</button>
            `
              )
              .join('')}
          </div>
        </div>

        <!-- Right Toolbar: Presets, Device Mode, Theme, Language -->
        <div class="env-toolbar-group">
          <!-- Presets -->
          <select id="preset-select" style="max-width: 195px;" class="px-2 py-1.5 rounded-lg border border-theme bg-surface-alt text-xs font-medium truncate">
            <option value="">${t('quickPresets')}</option>
            <option value="starter">${t('presetStarter')}</option>
            <option value="clean">${t('presetClean')}</option>
            <option value="compare_rate_factors">${t('presetCompareRateFactors')}</option>
            <option value="compare_corrosion">${t('presetCompareCorrosion')}</option>
            <option value="caco3_calcination_limewater">${t('presetCaco3Calcination')}</option>
            <option value="cu_ammine_complex">${t('presetCuAmmineComplex')}</option>
            <option value="cuo_h2_reduction">${t('presetCuoH2Reduction')}</option>
            <option value="zn_burn_o2">${t('presetZnBurnO2')}</option>
            <option value="air_tarnish_deliquesce">${t('presetAirTarnish')}</option>
            <option value="na_water_phen">${t('presetNaWaterPhen')}</option>
            <option value="copper_hydroxide_series">${t('presetCuSeries')}</option>
            <option value="amphoteric_zn_cu">${t('presetAmphotericZnCu')}</option>
            <option value="gas_collect">${t('presetGasCollect')}</option>
            <option value="trough_collect">${t('presetTroughCollect')}</option>
            <option value="titration">${t('presetTitration')}</option>
            <option value="filtration">${t('presetFiltration')}</option>
            <option value="daniell_cell">${t('presetDaniellCell')}</option>
            <option value="electrolysis">${t('presetElectrolysis')}</option>
            <option value="distillation">${t('presetDistillation')}</option>
            <option value="ammonia_fountain">${t('presetAmmoniaFountain')}</option>
            <option value="graham_diffusion">${t('presetGrahamDiffusion')}</option>
          </select>

          <!-- Device Preview Switcher -->
          <select id="device-select" class="px-2 py-1.5 rounded-lg border border-theme bg-surface-alt text-xs font-medium" title="Device Layout">
            <option value="auto" ${deviceMode === 'auto' ? 'selected' : ''}>📐 ${t('deviceAuto')}</option>
            <option value="desktop" ${deviceMode === 'desktop' ? 'selected' : ''}>🖥️ ${t('deviceDesktop')}</option>
            <option value="tablet" ${deviceMode === 'tablet' ? 'selected' : ''}>📱 ${t('deviceTablet')}</option>
            <option value="mobile" ${deviceMode === 'mobile' ? 'selected' : ''}>📲 ${t('deviceMobile')}</option>
          </select>

          <!-- Infinite Storage Cabinet Button -->
          <button type="button" id="btn-storage-cabinet" title="${t('cabinetBtnTip')}" class="env-cabinet-btn">
            🗄️ ${t('cabinetBtnLabel')} (${this.appState.cabinetCount || 0})
          </button>

          <!-- Workspace Storage & Cloud Sync Button -->
          <button type="button" id="btn-workspace-storage" title="${t('storageBtnTip')}" class="env-storage-btn ${
            this.appState.cloudSignedIn ? 'signed-in' : ''
          }">
            ${this.appState.cloudSignedIn ? '☁️' : '💾'} ${t('storageBtnLabel')}
          </button>

          <!-- Sound Effects Toggle -->
          <button type="button" id="btn-sound-toggle" title="${t('soundToggleTip')}" class="px-2.5 py-1.5 rounded-lg border ${
            this.appState.soundEnabled !== false
              ? 'border-emerald-500/50 bg-emerald-500/10 text-emerald-400'
              : 'border-theme bg-surface-alt text-muted'
          } text-xs font-semibold hover:border-accent transition">
            ${
              theme === 'petal'
                ? this.appState.soundEnabled !== false
                  ? `🐰 ${t('soundOn')}`
                  : `🔇 ${t('soundMuted')}`
                : this.appState.soundEnabled !== false
                ? `🔊 ${t('soundOn')}`
                : `🔇 ${t('soundMuted')}`
            }
          </button>

          <!-- Theme Selector (Dark, Light, Olivia, petal, Ctrl, SOS) -->
          <select id="theme-select" style="max-width: 155px;" class="px-2 py-1.5 rounded-lg border border-theme bg-surface-alt text-main text-xs font-semibold truncate" title="Theme">
            <option value="dark" ${theme === 'dark' ? 'selected' : ''}>🌙 ${t('themeDark')}</option>
            <option value="light" ${theme === 'light' ? 'selected' : ''}>☀️ ${t('themeLight')}</option>
            <option value="olivia" ${theme === 'olivia' ? 'selected' : ''}>🩷 ${t('themeOlivia')}</option>
            <option value="petal" ${theme === 'petal' ? 'selected' : ''}>🥀 ${t('themePetal')}</option>
            <option value="ctrl" ${theme === 'ctrl' ? 'selected' : ''}>📓 ${t('themeCtrl')}</option>
            <option value="sos" ${theme === 'sos' ? 'selected' : ''}>🌊 ${t('themeSos')}</option>
          </select>

          <!-- Language Toggle VI / EN -->
          <button type="button" id="btn-lang-toggle" class="px-2.5 py-1.5 rounded-lg border border-theme bg-accent text-white text-xs font-bold hover:opacity-90 transition">
            ${lang === 'vi' ? 'VI / EN' : 'EN / VI'}
          </button>
        </div>
      </div>
    `;

    this.container.querySelector('#env-temp-input')?.addEventListener('change', (e) => {
      const val = Math.max(200, Math.min(450, Number(e.target.value) || CONSTANTS.T_STD_K));
      this.sim.setAmbientTempK(val);
    });

    this.container.querySelector('#env-press-input')?.addEventListener('change', (e) => {
      const val = Math.max(0.1, Math.min(5.0, Number(e.target.value) || CONSTANTS.P_STD_BAR));
      this.sim.environment.pressureBar = val;
      this.sim.emitChange();
    });

    this.container.querySelector('#btn-std-satp')?.addEventListener('click', () => {
      this.sim.environment.pressureBar = CONSTANTS.P_STD_BAR;
      this.sim.setAmbientTempK(CONSTANTS.T_STD_K);
    });

    this.container.querySelector('#btn-uv-light')?.addEventListener('click', () => {
      this.sim.setUvLight(!this.sim.environment.uvLight);
    });

    this.container.querySelector('#btn-atm-mode')?.addEventListener('click', () => {
      const next = this.sim.environment.atmosphereMode === 'inert' ? 'air' : 'inert';
      this.sim.setAtmosphereMode(next);
    });

    this.container.querySelector('#btn-pause')?.addEventListener('click', () => {
      this.sim.environment.paused = !this.sim.environment.paused;
      this.sim.emitChange();
    });

    this.container.querySelectorAll('.speed-btn').forEach((btn) => {
      btn.addEventListener('click', () => {
        this.sim.environment.speed = Number(btn.dataset.speed);
        this.sim.emitChange();
      });
    });

    this.container.querySelector('#preset-select')?.addEventListener('change', (e) => {
      if (e.target.value) {
        this.callbacks.onPreset?.(e.target.value);
        e.target.value = '';
      }
    });

    this.container.querySelector('#device-select')?.addEventListener('change', (e) => {
      this.callbacks.onDeviceChange?.(e.target.value);
    });

    this.container.querySelector('#btn-storage-cabinet')?.addEventListener('click', () => {
      this.callbacks.onOpenCabinet?.();
    });

    this.container.querySelector('#btn-workspace-storage')?.addEventListener('click', () => {
      this.callbacks.onOpenStorage?.();
    });

    this.container.querySelector('#btn-sound-toggle')?.addEventListener('click', () => {
      this.callbacks.onSoundToggle?.();
    });

    this.container.querySelector('#optics-select')?.addEventListener('change', (e) => {
      this.callbacks.onOpticsChange?.(e.target.value);
    });

    this.container.querySelector('#theme-select')?.addEventListener('change', (e) => {
      this.callbacks.onThemeChange?.(e.target.value);
    });

    this.container.querySelector('#btn-lang-toggle')?.addEventListener('click', () => {
      this.callbacks.onLangChange?.();
    });
  }
}
