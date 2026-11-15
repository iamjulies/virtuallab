import { CONSTANTS, kelvinToCelsius, waterBoilingPointK } from '../data/constants.js';

export class EnvironmentBar {
  constructor(container, sim, appState, callbacks) {
    this.container = container;
    this.sim = sim;
    this.appState = appState; // { lang, theme, deviceMode }
    this.callbacks = callbacks; // { onLangChange, onThemeChange, onDeviceChange, onPreset }
  }

  render(t) {
    const env = this.sim.environment;
    const tempC = kelvinToCelsius(env.tempK);
    const boilC = kelvinToCelsius(waterBoilingPointK(env.pressureBar));
    const { lang, theme, deviceMode } = this.appState;

    this.container.innerHTML = `
      <div class="flex flex-wrap items-center justify-between gap-3 px-4 py-2.5 border-b border-theme bg-surface">
        <!-- Brand -->
        <div class="flex items-center gap-2.5">
          <div class="w-9 h-9 rounded-xl bg-accent text-white flex items-center justify-center text-lg font-bold shadow-sm">
            ⚗️
          </div>
          <div>
            <div class="flex items-center gap-2">
              <h1 class="text-sm sm:text-base font-bold leading-none">${t('appTitle')}</h1>
              <span class="hidden sm:inline-block text-xs px-2 py-0.5 rounded-full border border-theme bg-surface-alt text-muted">
                ${t('modeFreeSandbox')}
              </span>
            </div>
            <p class="text-xs text-muted mt-0.5 hidden md:block">${t('appSubtitle')}</p>
          </div>
        </div>

        <!-- Lab Environment Controls: T (298.15 K), P (1.00 bar), Speed -->
        <div class="flex flex-wrap items-center gap-2 sm:gap-3">
          <!-- Ambient Temperature -->
          <div class="flex items-center gap-1.5 px-2.5 py-1.5 rounded-lg border border-theme bg-surface-alt">
            <span class="text-xs text-muted hidden sm:inline">🌡️ ${t('envTemp')}:</span>
            <input id="env-temp-input" type="number" min="250" max="420" step="1" value="${env.tempK.toFixed(2)}"
              class="w-[70px] px-1.5 py-0.5 rounded border border-theme bg-surface text-xs font-mono font-bold text-right" />
            <span class="text-xs font-mono">K <span class="text-muted">(${tempC.toFixed(1)}°C)</span></span>
            <button type="button" id="btn-std-satp" title="Reset SATP (298.15 K, 1.00 bar)"
              class="px-1.5 py-0.5 rounded border border-theme bg-surface text-xs text-muted hover:text-main">SATP</button>
          </div>

          <!-- Ambient Pressure -->
          <div class="flex items-center gap-1.5 px-2.5 py-1.5 rounded-lg border border-theme bg-surface-alt">
            <span class="text-xs text-muted hidden sm:inline">⏱️ ${t('envPress')}:</span>
            <input id="env-press-input" type="number" min="0.2" max="4.0" step="0.05" value="${env.pressureBar.toFixed(2)}"
              class="w-[58px] px-1.5 py-0.5 rounded border border-theme bg-surface text-xs font-mono font-bold text-right" />
            <span class="text-xs font-mono">bar <span class="text-muted hidden xl:inline">(bp ${boilC.toFixed(1)}°C)</span></span>
          </div>

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
        <div class="flex flex-wrap items-center gap-1.5">
          <!-- Presets -->
          <select id="preset-select" style="max-width: 150px;" class="px-2 py-1.5 rounded-lg border border-theme bg-surface-alt text-xs font-medium truncate">
            <option value="">${t('quickPresets')}</option>
            <option value="clean">${t('presetClean')}</option>
            <option value="gas_collect">${t('presetGasCollect')}</option>
          </select>

          <!-- Device Preview Switcher -->
          <select id="device-select" class="px-2 py-1.5 rounded-lg border border-theme bg-surface-alt text-xs font-medium" title="Device Layout">
            <option value="auto" ${deviceMode === 'auto' ? 'selected' : ''}>📐 ${t('deviceAuto')}</option>
            <option value="desktop" ${deviceMode === 'desktop' ? 'selected' : ''}>🖥️ ${t('deviceDesktop')}</option>
            <option value="tablet" ${deviceMode === 'tablet' ? 'selected' : ''}>📱 ${t('deviceTablet')}</option>
            <option value="mobile" ${deviceMode === 'mobile' ? 'selected' : ''}>📲 ${t('deviceMobile')}</option>
          </select>

          <!-- Theme Toggle -->
          <button type="button" id="btn-theme-toggle" class="px-2.5 py-1.5 rounded-lg border border-theme bg-surface-alt text-xs font-semibold hover:border-accent transition">
            ${theme === 'dark' ? `🌙 ${t('themeDark')}` : `☀️ ${t('themeLight')}`}
          </button>

          <!-- Language Toggle VI / EN -->
          <button type="button" id="btn-lang-toggle" class="px-2.5 py-1.5 rounded-lg border border-theme bg-accent text-white text-xs font-bold hover:opacity-90 transition">
            ${lang === 'vi' ? 'VI / EN' : 'EN / VI'}
          </button>
        </div>
      </div>
    `;

    this.container.querySelector('#env-temp-input')?.addEventListener('change', (e) => {
      const val = Math.max(240, Math.min(450, Number(e.target.value) || CONSTANTS.T_STD_K));
      this.sim.environment.tempK = val;
      this.sim.emitChange();
    });

    this.container.querySelector('#env-press-input')?.addEventListener('change', (e) => {
      const val = Math.max(0.1, Math.min(5.0, Number(e.target.value) || CONSTANTS.P_STD_BAR));
      this.sim.environment.pressureBar = val;
      this.sim.emitChange();
    });

    this.container.querySelector('#btn-std-satp')?.addEventListener('click', () => {
      this.sim.environment.tempK = CONSTANTS.T_STD_K;
      this.sim.environment.pressureBar = CONSTANTS.P_STD_BAR;
      this.sim.emitChange();
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

    this.container.querySelector('#btn-theme-toggle')?.addEventListener('click', () => {
      this.callbacks.onThemeChange?.();
    });

    this.container.querySelector('#btn-lang-toggle')?.addEventListener('click', () => {
      this.callbacks.onLangChange?.();
    });
  }
}
