import { VesselGeometry } from './vesselGeometry.js';

/**
 * Apparatus specifications calibrated to ISO / DIN international glassware standards
 * (ISO 3819 / DIN 12331 Beakers, ISO 1773 / DIN 12380 Erlenmeyer, ISO 4788 Cylinder, ISO 4142 Test Tube).
 * Glassware liquid height, radius & Dalton surface area derive directly from VesselGeometry slice profiles.
 */
export const APPARATUS = {
  beaker_250: {
    id: 'beaker_250',
    kind: 'vessel',
    category: 'vessels',
    shape: 'beaker',
    formVariant: 'low',
    supportsClamp: true,
    i18nKey: 'eq_beaker_250',
    isoStandard: 'ISO 3819 · DIN 12331 (Low 70×95 mm)',
    materialSpec: 'Borosilicate 3.3',
    diameterMm: 70,
    heightMm: 95,
    wallThicknessMm: 1.1,
    maxThermalStressK: 783,
    maxVolumeMl: 250,
    tareMassG: 115.0,
    glassHeatCapacityJK: 96.0, // ~115g Borosilicate 3.3 * 0.83 J/gK
    width: 81,  // 70 mm * 1.15 px/mm
    height: 110, // 95 mm * 1.15 px/mm
    neckRadius: 38,
    heatable: true,
    stopperable: false,
    popPressureBar: null,
    popOverpressureBar: null,
    shatterPressureBar: 1.85,
    shatterOverpressureBar: 0.85,      // Flat-bottomed Borosilicate 3.3 beaker (not pressure-rated: ~50-100 kPa failure)
    implosionUnderpressureBar: 0.75,   // Vacuum differential limit on flat base
    fragilityDropPx: 260,
    heatLossCoeffWK: 0.45,
    surfaceAreaCm2: 39.6,
    opticalPathCm: 6.78,
    geometry: new VesselGeometry([
      [0.0, 3.10], // Flat contact base inside rounded heel
      [0.3, 3.45], // Lower corner fillet
      [0.7, 3.55], // Full inner cylindrical wall (~71 mm ID)
      [8.6, 3.55], // Straight vertical cylinder
      [9.3, 3.85], // Slightly flared top rim
    ]),
  },
  beaker_tall_250: {
    id: 'beaker_tall_250',
    kind: 'vessel',
    category: 'vessels',
    shape: 'beaker',
    formVariant: 'tall',
    supportsClamp: true,
    i18nKey: 'eq_beaker_tall_250',
    isoStandard: 'ISO 3819 · DIN 12331 (Tall 60×120 mm)',
    materialSpec: 'Borosilicate 3.3',
    diameterMm: 60,
    heightMm: 120,
    wallThicknessMm: 1.1,
    maxThermalStressK: 783,
    maxVolumeMl: 250,
    tareMassG: 122.0,
    glassHeatCapacityJK: 101.0,
    width: 69,  // 60 mm * 1.15 px/mm
    height: 138, // 120 mm * 1.15 px/mm
    neckRadius: 32,
    heatable: true,
    stopperable: false,
    popPressureBar: null,
    popOverpressureBar: null,
    shatterPressureBar: 1.90,
    shatterOverpressureBar: 0.90,
    implosionUnderpressureBar: 0.78,
    fragilityDropPx: 255,
    heatLossCoeffWK: 0.43,
    surfaceAreaCm2: 26.8,
    opticalPathCm: 5.78,
    geometry: new VesselGeometry([
      [0.0, 2.52],
      [0.3, 2.84],
      [0.7, 2.92],
      [11.2, 2.92],
      [11.9, 3.16],
    ]),
  },
  erlenmeyer_250: {
    id: 'erlenmeyer_250',
    kind: 'vessel',
    category: 'vessels',
    shape: 'erlenmeyer',
    invertible: true,
    supportsClamp: true,
    i18nKey: 'eq_erlenmeyer_250',
    isoStandard: 'ISO 1773 · DIN 12380 (Ø85×144 mm · Ø32 mm)',
    materialSpec: 'Borosilicate 3.3',
    diameterMm: 85,
    heightMm: 144,
    neckDiameterMm: 32,
    wallThicknessMm: 0.8,
    maxThermalStressK: 783,
    maxVolumeMl: 250,
    tareMassG: 128.0,
    glassHeatCapacityJK: 106.0,
    width: 98,   // 85 mm * 1.15 px/mm
    height: 166, // 144 mm * 1.15 px/mm
    neckRadius: 18.5, // ~32 mm OD neck (37 px)
    heatable: true,
    stopperable: true,
    popPressureBar: 1.38,              // Rubber bung dry friction blow-out (~35-40 kPa gauge; wet neck drops to ~12 kPa)
    popOverpressureBar: 0.38,
    shatterPressureBar: 1.90,          // Standard flat-bottom Erlenmeyer (ASTM E1404) burst ~70-100 kPa gauge (0.90 bar overpressure)
    shatterOverpressureBar: 0.90,
    implosionUnderpressureBar: 0.95,   // Conical Borosilicate 3.3 resists standard lab fountain/aspirator vacuum (~0.85 bar underpressure)
    fragilityDropPx: 270,
    heatLossCoeffWK: 0.38,
    surfaceAreaCm2: 12.5,
    opticalPathCm: 7.2,
    geometry: new VesselGeometry([
      [0.0, 3.35],  // Flat base contact
      [0.25, 3.85], // Rounded bottom heel (lower)
      [0.7, 4.10],  // Widest lower belly
      [9.2, 1.55],  // Conical body tapering to shoulder
      [12.6, 1.55], // Cylindrical neck
      [13.4, 1.80], // Flared neck rim
    ]),
  },
  test_tube_50: {
    id: 'test_tube_50',
    kind: 'vessel',
    category: 'vessels',
    shape: 'test_tube',
    invertible: true,
    supportsClamp: true,
    i18nKey: 'eq_test_tube_50',
    isoStandard: 'ISO 4142 / DIN 12395 (Ø25×150 mm · Rimmed)',
    materialSpec: 'Borosilicate 3.3',
    diameterMm: 25,
    heightMm: 150,
    wallThicknessMm: 1.5,
    maxThermalStressK: 783,
    maxVolumeMl: 50,
    tareMassG: 26.0,
    glassHeatCapacityJK: 22.0,
    width: 29,   // 25 mm * 1.15 px/mm
    height: 172, // 150 mm * 1.15 px/mm
    neckRadius: 14.5,
    heatable: true,
    stopperable: true,
    popPressureBar: 1.35,              // Narrow smooth-neck bung pops around +0.35 bar dry (~0.12 bar wet)
    popOverpressureBar: 0.35,
    shatterPressureBar: 2.60,          // Cylindrical + rounded U-bottom + 1.5mm wall withstands ~1.6 bar overpressure (> Erlenmeyer)
    shatterOverpressureBar: 1.60,
    implosionUnderpressureBar: 0.95,
    fragilityDropPx: 280,
    heatLossCoeffWK: 0.22,
    surfaceAreaCm2: 4.0,
    opticalPathCm: 2.2,
    geometry: new VesselGeometry([
      [0.0, 0.08],  // U-bottom pole
      [0.15, 0.56],
      [0.40, 0.87],
      [0.75, 1.07],
      [1.10, 1.10], // Full inner tube radius (~22 mm ID -> 50 mL at ~13.5 cm)
      [14.2, 1.10], // Straight cylindrical wall
      [14.9, 1.25], // Flared rimmed lip
    ]),
  },
  cylinder_100: {
    id: 'cylinder_100',
    kind: 'vessel',
    category: 'vessels',
    shape: 'cylinder',
    invertible: true,
    supportsClamp: true,
    i18nKey: 'eq_cylinder_100',
    isoStandard: 'ISO 4788 · Class A (100 mL)',
    materialSpec: 'Borosilicate 3.3',
    diameterMm: 31,
    heightMm: 210,
    wallThicknessMm: 1.2,
    maxThermalStressK: 783,
    maxVolumeMl: 100,
    tareMassG: 94.0,
    glassHeatCapacityJK: 78.0,
    width: 38,
    height: 210,
    neckRadius: 18,
    heatable: false,
    stopperable: false,
    popPressureBar: null,
    popOverpressureBar: null,
    shatterPressureBar: 1.95,
    shatterOverpressureBar: 0.95,
    implosionUnderpressureBar: 0.80,
    fragilityDropPx: 245,              // Tall narrow center of mass breaks easier on tall drops
    heatLossCoeffWK: 0.30,
    surfaceAreaCm2: 6.16,
    opticalPathCm: 2.9,
    geometry: new VesselGeometry([
      [0.0, 1.40],
      [19.4, 1.40],
      [20.2, 1.54],
    ]),
  },
  scale: {
    id: 'scale',
    kind: 'scale',
    category: 'titration',
    isSupport: true,
    i18nKey: 'eq_scale',
    width: 156,
    height: 62,
    panWidth: 128,
    maxLoadG: 2000,
  },
  burner: {
    id: 'burner',
    kind: 'burner',
    category: 'thermal',
    isSupport: true,
    i18nKey: 'eq_burner',
    width: 120,
    height: 112,
    maxPowerW: 650,
    // Thermal power delivered to vessel on stand (Watts = J/s)
    powerLevelsW: {
      0: 0,
      1: 160,  // Low flame
      2: 360,  // Medium flame
      3: 650,  // High flame
    },
    // Effective convective flame plume driving temperatures (K) -> dry glass stabilizes ~170 / 228 / 280 C
    effectiveFlameK: {
      0: 298.15,
      1: 505.0,
      2: 595.0,
      3: 696.0,
    },
  },
  gas_syringe: {
    id: 'gas_syringe',
    kind: 'gas_syringe',
    category: 'vessels',
    supportsClamp: true,
    flippable: true,
    i18nKey: 'eq_gas_syringe',
    isoStandard: 'Borosilicate 3.3 Gastight · Luer Lock (Ø47.8×290 mm · Max 2.05 bar / 30 psi)',
    materialSpec: 'Borosilicate 3.3 + PTFE',
    barrelOdMm: 47.8,
    innerDiameterMm: 42.9,
    crossSectionCm2: 14.45,
    lengthMm: 290,
    collarOdMm: 57,
    graduationErrorPct: 1.5,
    maxVolumeMl: 250,
    plungerPopOverpressureBar: 0.48,   // Unclamped ground-glass plunger ejects above ~+0.48 bar overpressure
    shatterOverpressureBar: 1.05,      // Large 250 mL glass barrel max rated ~2 atm (~30 psi / 207 kPa abs -> +1.05 bar gauge)
    fragilityDropPx: 250,
    width: 256,
    height: 84,
    barrelW: 192,
    barrelH: 54,
    barrelLeftOffset: 20,
    collarH: 64,
  },
  pipette_10: {
    id: 'pipette_10',
    kind: 'pipette',
    category: 'titration',
    i18nKey: 'eq_pipette_10',
    isoStandard: 'ISO 835 Class A · Mohr Dropper (10 mL)',
    materialSpec: 'Borosilicate 3.3 + Silicone',
    maxVolumeMl: 10,
    fragilityDropPx: 285,
    width: 30,
    height: 156,
  },
  retort_stand: {
    id: 'retort_stand',
    kind: 'stand',
    category: 'vessels',
    flippable: true,
    i18nKey: 'eq_retort_stand',
    isoStandard: 'Heavy Base + Steel Rod · Bosshead Clamp',
    materialSpec: 'Cast Iron + 304 Stainless Steel',
    width: 112,
    height: 310,
  },

  // --- Group 1: Separation & Filtration ---
  filter_funnel: {
    id: 'filter_funnel',
    kind: 'filter_funnel',
    category: 'separation',
    supportsClamp: true,
    breakable: true,
    i18nKey: 'eq_filter_funnel',
    isoStandard: 'ISO 4798 · 60° Conical + Qualitative Paper',
    materialSpec: 'Borosilicate 3.3 + Cellulose Filter',
    diameterMm: 59,
    heightMm: 80,
    wallThicknessMm: 1.1,
    glassHeatCapacityJK: 40.0,
    maxThermalStressK: 783,
    maxVolumeMl: 80,
    tareMassG: 48.0,
    width: 68,
    height: 92,
    neckRadius: 32,
    surfaceAreaCm2: 24.0,
    opticalPathCm: 3.5,
    clampOffsetY: 6,
    fragilityDropPx: 235,
    geometry: new VesselGeometry([
      [0.0, 0.35],
      [3.5, 1.65],
      [6.8, 2.85],
    ]),
  },
  wash_bottle: {
    id: 'wash_bottle',
    kind: 'wash_bottle',
    category: 'separation',
    breakable: false,
    flippable: true,
    i18nKey: 'eq_wash_bottle',
    isoStandard: 'LDPE Squeeze Bottle (250 mL H₂O)',
    materialSpec: 'LDPE + PTFE Nozzle',
    diameterMm: 49,
    heightMm: 104,
    wallThicknessMm: 1.4,
    maxThermalStressK: 385,
    maxVolumeMl: 250,
    tareMassG: 42.0,
    width: 56,
    height: 120,
    fragilityDropPx: Infinity,
  },

  // --- Group 2: Thermal, Solid-State & Gas Testing ---
  porcelain_dish: {
    id: 'porcelain_dish',
    kind: 'vessel',
    category: 'thermal',
    shape: 'dish',
    supportsClamp: false,
    breakable: false,
    i18nKey: 'eq_porcelain_dish',
    isoStandard: 'DIN 12903 · High-Temp Porcelain Dish (100 mL)',
    materialSpec: 'Glazed Porcelain (Al₂O₃·SiO₂)',
    diameterMm: 83,
    heightMm: 40,
    wallThicknessMm: 2.8,
    maxVolumeMl: 100,
    tareMassG: 62.0,
    glassHeatCapacityJK: 54.0,
    maxThermalStressK: 1200,
    width: 96,
    height: 46,
    neckRadius: 46,
    heatable: true,
    stopperable: false,
    popPressureBar: null,
    shatterPressureBar: null,
    shatterOverpressureBar: null,
    implosionUnderpressureBar: null,
    fragilityDropPx: Infinity,
    heatLossCoeffWK: 0.42,
    surfaceAreaCm2: 52.0,
    opticalPathCm: 3.4,
    geometry: new VesselGeometry([
      [0.0, 1.9],
      [0.8, 3.0],
      [2.2, 3.9],
      [3.8, 4.35],
    ]),
  },
  water_trough: {
    id: 'water_trough',
    kind: 'vessel',
    category: 'thermal',
    shape: 'trough',
    supportsClamp: false,
    isTrough: true,
    i18nKey: 'eq_water_trough',
    isoStandard: 'Pneumatic Trough (1000 mL Glass Bath)',
    materialSpec: 'Annealed Soda-Lime Glass',
    diameterMm: 150,
    heightMm: 57,
    wallThicknessMm: 3.2,
    maxThermalStressK: 620,
    maxVolumeMl: 1000,
    tareMassG: 320.0,
    glassHeatCapacityJK: 265.0,
    width: 174,
    height: 66,
    neckRadius: 84,
    heatable: false,
    stopperable: false,
    popPressureBar: null,
    shatterPressureBar: 2.2,
    shatterOverpressureBar: 1.2,
    implosionUnderpressureBar: null,
    fragilityDropPx: 230,
    heatLossCoeffWK: 0.65,
    surfaceAreaCm2: 110.0,
    opticalPathCm: 9.0,
    geometry: new VesselGeometry([
      [0.0, 6.8],
      [5.4, 7.1],
      [5.9, 7.3],
    ]),
  },
  liebig_condenser: {
    id: 'liebig_condenser',
    kind: 'condenser',
    category: 'thermal',
    supportsClamp: true,
    breakable: true,
    flippable: true,
    i18nKey: 'eq_liebig_condenser',
    isoStandard: 'DIN 12576 · Liebig Straight Condenser',
    materialSpec: 'Borosilicate 3.3 Cooling Jacket',
    tareMassG: 145.0,
    width: 152,
    height: 46,
    clampOffsetY: 0,
    fragilityDropPx: 230,
  },
  splint: {
    id: 'splint',
    kind: 'splint',
    category: 'thermal',
    breakable: false,
    flippable: true,
    i18nKey: 'eq_splint',
    isoStandard: 'Wooden Gas-Test Splint (H₂ / O₂)',
    materialSpec: 'Seasoned Birch Wood',
    width: 118,
    height: 26,
    fragilityDropPx: Infinity,
  },
  flame_loop: {
    id: 'flame_loop',
    kind: 'flame_loop',
    category: 'thermal',
    breakable: false,
    flippable: true,
    i18nKey: 'eq_flame_loop',
    isoStandard: 'Nichrome / Pt Flame Spectroscopy Wire',
    materialSpec: 'NiCr 80/20 + Glass Rod',
    maxThermalStressK: 1600,
    width: 112,
    height: 24,
    fragilityDropPx: Infinity,
  },

  // --- Group 3: Titration & Extended Indicators ---
  burette_50: {
    id: 'burette_50',
    kind: 'burette',
    category: 'titration',
    supportsClamp: true,
    breakable: true,
    i18nKey: 'eq_burette_50',
    isoStandard: 'ISO 385 Class AS · PTFE Stopcock (50 mL)',
    materialSpec: 'Borosilicate 3.3 + PTFE Key',
    diameterMm: 13,
    heightMm: 177,
    wallThicknessMm: 1.1,
    glassHeatCapacityJK: 54.0,
    maxThermalStressK: 783,
    maxVolumeMl: 50,
    tareMassG: 65.0,
    width: 30,
    height: 204,
    neckRadius: 12,
    surfaceAreaCm2: 1.13,
    opticalPathCm: 1.1,
    clampOffsetY: -10,
    fragilityDropPx: 225,
    geometry: new VesselGeometry([
      [0.0, 0.6],
      [38.0, 0.6],
      [44.2, 0.6],
    ]),
  },
  litmus_paper: {
    id: 'litmus_paper',
    kind: 'indicator_strip',
    stripKind: 'litmus',
    category: 'titration',
    breakable: false,
    flippable: true,
    i18nKey: 'eq_litmus_paper',
    isoStandard: 'Neutral Azolitmin Litmus Strip (pH 4.5–8.3)',
    materialSpec: 'Impregnated Cellulose Strip',
    width: 62,
    height: 22,
    fragilityDropPx: Infinity,
  },
  ph_strip: {
    id: 'ph_strip',
    kind: 'indicator_strip',
    stripKind: 'universal',
    category: 'titration',
    breakable: false,
    flippable: true,
    i18nKey: 'eq_ph_strip',
    isoStandard: 'Universal Indicator Strip (pH 1–14)',
    materialSpec: 'Multi-dye Cellulose Paper',
    width: 62,
    height: 22,
    fragilityDropPx: Infinity,
  },

  // --- Group 4: Mechanics & Surface Area ---
  mortar_pestle: {
    id: 'mortar_pestle',
    kind: 'vessel',
    category: 'mechanics',
    shape: 'mortar',
    isMortar: true,
    supportsClamp: false,
    breakable: false,
    i18nKey: 'eq_mortar_pestle',
    isoStandard: 'DIN 12906 · Heavy Porcelain Mortar & Pestle',
    materialSpec: 'Unglazed Interior Porcelain',
    diameterMm: 85,
    heightMm: 54,
    wallThicknessMm: 6.5,
    maxVolumeMl: 120,
    tareMassG: 340.0,
    glassHeatCapacityJK: 280.0,
    maxThermalStressK: 1100,
    width: 98,
    height: 62,
    neckRadius: 44,
    heatable: false,
    stopperable: false,
    popPressureBar: null,
    shatterPressureBar: null,
    shatterOverpressureBar: null,
    implosionUnderpressureBar: null,
    fragilityDropPx: Infinity,
    heatLossCoeffWK: 0.45,
    surfaceAreaCm2: 44.0,
    opticalPathCm: 4.0,
    geometry: new VesselGeometry([
      [0.0, 2.3],
      [1.2, 3.3],
      [3.5, 4.1],
      [4.9, 4.25],
    ]),
  },
  stir_bar: {
    id: 'stir_bar',
    kind: 'stir_bar',
    category: 'mechanics',
    breakable: false,
    i18nKey: 'eq_stir_bar',
    isoStandard: 'PTFE Octagonal Magnetic Stir Bar (25×8 mm)',
    materialSpec: 'PTFE Encapsulated Alnico Magnet',
    width: 30,
    height: 16,
    fragilityDropPx: Infinity,
  },

  // --- Group 5: Electrochemistry ---
  dc_power: {
    id: 'dc_power',
    kind: 'dc_power',
    category: 'electrochem',
    isSupport: false,
    breakable: false,
    i18nKey: 'eq_dc_power',
    isoStandard: 'Regulated DC Supply / Rheostat (0–12.0 V)',
    materialSpec: 'ABS + Banana Plug Leads',
    tareMassG: 850.0,
    width: 124,
    height: 82,
    fragilityDropPx: Infinity,
  },
  volt_ammeter: {
    id: 'volt_ammeter',
    kind: 'volt_ammeter',
    category: 'electrochem',
    isSupport: false,
    breakable: false,
    i18nKey: 'eq_volt_ammeter',
    isoStandard: 'True-RMS Digital Volt–Ammeter (10 MΩ / 0.1–2.2 Ω)',
    materialSpec: 'Dual Probe Red (+V/A) / Black (COM)',
    tareMassG: 420.0,
    width: 112,
    height: 82,
    fragilityDropPx: Infinity,
  },
  diffusion_tube: {
    id: 'diffusion_tube',
    kind: 'diffusion_tube',
    category: 'separation',
    isSupport: false,
    breakable: true,
    i18nKey: 'eq_diffusion_tube',
    isoStandard: 'Graham 1D Gas Diffusion Tube (L = 100.0 cm · Ø24 mm)',
    materialSpec: 'Borosilicate 3.3 + Cotton Plugs',
    diameterMm: 24,
    heightMm: 264,
    wallThicknessMm: 1.5,
    maxThermalStressK: 783,
    tareMassG: 145.0,
    width: 264,
    height: 46,
    fragilityDropPx: 250,
  },
  electrode_rod: {
    id: 'electrode_rod',
    kind: 'electrode',
    category: 'electrochem',
    breakable: false,
    i18nKey: 'eq_electrode_rod',
    isoStandard: 'Interchangeable C / Cu / Zn Electrode',
    materialSpec: 'Graphite (C) · Copper (Cu) · Zinc (Zn)',
    tareMassG: 24.0,
    width: 22,
    height: 118,
    fragilityDropPx: Infinity,
  },
  salt_bridge: {
    id: 'salt_bridge',
    kind: 'salt_bridge',
    category: 'electrochem',
    breakable: true,
    i18nKey: 'eq_salt_bridge',
    isoStandard: 'U-Tube Agar Salt Bridge (Sat. Na₂SO₄ / KNO₃)',
    materialSpec: 'Borosilicate 3.3 + Gel Electrolyte',
    tareMassG: 52.0,
    width: 126,
    height: 76,
    fragilityDropPx: 240,
  },
};

export const APPARATUS_CATEGORIES = [
  { id: 'all', i18nKey: 'catAll' },
  { id: 'vessels', i18nKey: 'catVessels' },
  { id: 'separation', i18nKey: 'catSeparation' },
  { id: 'thermal', i18nKey: 'catThermal' },
  { id: 'titration', i18nKey: 'catTitration' },
  { id: 'mechanics', i18nKey: 'catMechanics' },
  { id: 'electrochem', i18nKey: 'catElectrochem' },
];

export const APPARATUS_ORDER = [
  'beaker_250',
  'beaker_tall_250',
  'erlenmeyer_250',
  'test_tube_50',
  'cylinder_100',
  'porcelain_dish',
  'water_trough',
  'mortar_pestle',
  'filter_funnel',
  'wash_bottle',
  'pipette_10',
  'burette_50',
  'liebig_condenser',
  'diffusion_tube',
  'retort_stand',
  'scale',
  'burner',
  'gas_syringe',
  'splint',
  'flame_loop',
  'litmus_paper',
  'ph_strip',
  'stir_bar',
  'dc_power',
  'volt_ammeter',
  'electrode_rod',
  'salt_bridge',
];

/**
 * Vertical offset (px) from apparatus center y to its Retort Stand bosshead clamp grip point.
 */
export function getClampNeckOffsetY(spec) {
  if (!spec) return 0;
  if (spec.kind === 'gas_syringe') return spec.clampOffsetY ?? 0;
  return spec.clampOffsetY ?? -spec.height / 2 + (spec.shape === 'erlenmeyer' ? 24 : 26);
}

/**
 * Clamp an apparatus center y-coordinate onto a Retort Stand's stainless steel rod shaft.
 */
export function clampItemToStandY(itemSpec, stand, floorY = 482, candidateY = 0, floorPad = 4) {
  const stSpec = APPARATUS.retort_stand;
  const neckOff = getClampNeckOffsetY(itemSpec);
  const standTop = stand.y - stSpec.height / 2;
  const standBot = stand.y + stSpec.height / 2;
  const minItemY = standTop + 14 - neckOff;
  const maxItemY = Math.min(floorY - itemSpec.height / 2 - floorPad, standBot - 22 - neckOff);
  return Math.max(minItemY, Math.min(maxItemY, candidateY));
}

/**
 * Shared Left-Right flip geometry helpers so Canvas rendering, port handles, and physics share exact coordinates.
 */
export function getStandGeometry(stand) {
  const rodSide = stand?.flippedX ? -1 : 1; // +1: rod on right, clamp reaches left (-1)
  const armDir = -rodSide;
  const rodX = (stand?.x || 0) + rodSide * 36;
  return {
    rodSide,
    armDir,
    rodX,
    clampTargetX(kind) {
      return rodX + armDir * (kind === 'gas_syringe' ? 45 : 28);
    },
  };
}

export function getCondenserPorts(cond) {
  const halfW = (APPARATUS.liebig_condenser?.width || 152) / 2;
  const dir = cond?.flippedX ? -1 : 1; // +1: left inlet -> right outlet tilted +0.14 rad
  return {
    dir,
    tiltAngle: dir * 0.14,
    inlet: { x: cond.x - dir * halfW * 0.94, y: cond.y - 10 },
    outlet: { x: cond.x + dir * halfW * 0.94, y: cond.y + 11 },
    spout: { x: cond.x + dir * 68, y: cond.y + 18 },
  };
}

export function getSyringeGeometry(syringe) {
  const sSpec = APPARATUS.gas_syringe;
  const w = sSpec.width;
  const barrelW = sSpec.barrelW || 192;
  const barrelH = sSpec.barrelH || 54;
  const collarH = sSpec.collarH || 64;
  const off = sSpec.barrelLeftOffset || 20;
  const flipped = Boolean(syringe?.flippedX);
  const barrelDir = flipped ? -1 : 1; // +1: nozzle left, barrel runs right; -1: nozzle right, barrel runs left
  const frontX = flipped ? syringe.x + w / 2 - off : syringe.x - w / 2 + off;
  const rearX = frontX + barrelDir * barrelW;
  const barrelLeft = Math.min(frontX, rearX);
  const barrelRight = Math.max(frontX, rearX);
  const nozzleX = frontX - barrelDir * 18;
  return {
    flipped,
    barrelDir,
    w,
    barrelW,
    barrelH,
    collarH,
    frontX,
    rearX,
    barrelLeft,
    barrelRight,
    nozzleX,
    nozzleY: syringe.y,
    travelStartX: frontX + barrelDir * 8,
    travelSpan: barrelW - 26,
    dischargeVx: -barrelDir * 48,
  };
}

export function getProbeTipPos(item) {
  const dir = item?.flippedX ? 1 : -1; // -1: functional tip on left (default), +1: flipped right
  if (item.kind === 'wash_bottle') {
    const topY = item.y - (APPARATUS.wash_bottle?.height || 120) / 2;
    return { x: item.x + dir * 24, y: topY + 12, dir };
  }
  if (item.kind === 'splint') {
    return { x: item.x + dir * 52, y: item.y, visualTipX: item.x + dir * 48, dir };
  }
  if (item.kind === 'flame_loop') {
    return { x: item.x + dir * 50, y: item.y, loopCenterX: item.x + dir * 47, dir };
  }
  if (item.kind === 'indicator_strip') {
    return { x: item.x + dir * 24, y: item.y, dir };
  }
  return { x: item.x, y: item.y, dir };
}
