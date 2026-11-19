import { VesselGeometry } from './vesselGeometry.js';

/**
 * Generate a smooth spherical profile ([heightCm, radiusCm]) for round-bottom flasks
 * so both VesselGeometry volume integration and Canvas silhouette/interior clip look smooth.
 */
function buildRoundFlaskProfile({
  bulbRadiusCm,
  neckRadiusCm,
  neckBaseCm,
  neckTopCm,
  rimCm,
  rimRadiusCm,
  heelRadiusCm = 0.36,
  sphereSteps = 28,
}) {
  const R = bulbRadiusCm;
  const pts = [[0.0, heelRadiusCm]];
  const startPhi = -Math.PI / 2 + Math.asin(Math.min(0.45, heelRadiusCm / R)) + 0.04;
  const shoulderRatio = Math.min(0.92, (neckRadiusCm * 1.18) / R);
  const endPhi = Math.acos(shoulderRatio);
  for (let i = 0; i <= sphereSteps; i++) {
    const phi = startPhi + (endPhi - startPhi) * (i / sphereSteps);
    const h = +(R * (1 + Math.sin(phi))).toFixed(3);
    const r = +(R * Math.cos(phi)).toFixed(3);
    if (h > 0.02 && r > 0.05) pts.push([h, r]);
  }
  const lastBulbH = pts[pts.length - 1][0];
  if (neckBaseCm - lastBulbH > 0.25) {
    pts.push([+(lastBulbH + (neckBaseCm - lastBulbH) * 0.55).toFixed(3), +(neckRadiusCm * 1.05).toFixed(3)]);
  }
  pts.push([neckBaseCm, neckRadiusCm]);
  pts.push([neckTopCm, neckRadiusCm]);
  pts.push([rimCm, rimRadiusCm]);
  return pts;
}

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
    flippable: true,
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
  bunsen_burner: {
    id: 'bunsen_burner',
    kind: 'burner',
    burnerType: 'bunsen',
    category: 'thermal',
    isSupport: true,
    hasIntegratedTripod: true,
    i18nKey: 'eq_bunsen_burner',
    isoStandard: 'DIN 30665 · Bunsen Burner + Integrated Ceramic-Gauze Tripod (1500 °C)',
    materialSpec: 'Brass Tube + Cast-Iron Base + Refractory Wire-Gauze Tripod',
    width: 112,
    height: 128,
    maxPowerW: 1550,
    powerLevelsW: {
      0: 0,
      1: 420,
      2: 920,
      3: 1550,
    },
    effectiveFlameK: {
      0: 298.15,
      1: 920.0,
      2: 1320.0,
      3: 1773.15,
    },
    yellowPowerLevelsW: {
      0: 0,
      1: 240,
      2: 510,
      3: 820,
    },
    yellowFlameK: {
      0: 298.15,
      1: 680.0,
      2: 880.0,
      3: 1073.15,
    },
  },
  ice_bath: {
    id: 'ice_bath',
    kind: 'bath',
    category: 'thermal',
    breakable: true,
    i18nKey: 'eq_ice_bath',
    isoStandard: 'Thermostatic Ice / Ice-NaCl Cooling Bath (0 °C / -10 °C)',
    materialSpec: 'Insulated Double-Wall Borosilicate + Cooling Jacket',
    width: 146,
    height: 68,
    maxVolumeMl: 1500,
    tareMassG: 420.0,
    coolingK: 0.28,
    bathTempIceK: 273.15,
    bathTempSaltK: 263.15,
    fragilityDropPx: 230,
  },
  crucible_porcelain: {
    id: 'crucible_porcelain',
    kind: 'vessel',
    category: 'thermal',
    shape: 'crucible',
    supportsClamp: false,
    breakable: false,
    hasLid: true,
    i18nKey: 'eq_crucible_porcelain',
    isoStandard: 'DIN 12904 · Tall-Form Glazed Porcelain Crucible + Lid (50 mL)',
    materialSpec: 'Refractory Porcelain (Al₂O₃·SiO₂ · 1450 °C)',
    diameterMm: 46,
    heightMm: 52,
    wallThicknessMm: 3.0,
    maxVolumeMl: 60,
    tareMassG: 34.0,
    glassHeatCapacityJK: 36.0,
    maxThermalStressK: 1850,
    width: 58,
    height: 54,
    neckRadius: 27,
    heatable: true,
    stopperable: false,
    popPressureBar: null,
    lidPopOverpressureBar: 0.06,
    shatterPressureBar: null,
    shatterOverpressureBar: null,
    implosionUnderpressureBar: null,
    fragilityDropPx: Infinity,
    heatLossCoeffWK: 0.28,
    surfaceAreaCm2: 18.0,
    opticalPathCm: 3.6,
    geometry: new VesselGeometry([
      [0.0, 1.35],
      [1.0, 1.85],
      [2.8, 2.25],
      [4.5, 2.48],
    ]),
  },
  quartz_tube: {
    id: 'quartz_tube',
    kind: 'vessel',
    category: 'thermal',
    shape: 'quartz_tube',
    isHorizontalTube: true,
    hasTwoEnds: true,
    supportsClamp: true,
    flippable: true,
    breakable: true,
    i18nKey: 'eq_quartz_tube',
    isoStandard: 'Fused Silica Quartz Combustion Tube (SiO₂ ≥ 99.9% · Max 1600 °C)',
    materialSpec: 'Fused Quartz (SiO₂)',
    diameterMm: 28,
    heightMm: 154,
    wallThicknessMm: 2.2,
    maxThermalStressK: 1873,
    clampOffsetY: 0,
    maxVolumeMl: 120,
    tareMassG: 58.0,
    glassHeatCapacityJK: 52.0,
    width: 178,
    height: 36,
    neckRadius: 15,
    heatable: true,
    stopperable: true,
    popPressureBar: 1.55,
    popOverpressureBar: 0.55,
    shatterPressureBar: 3.4,
    shatterOverpressureBar: 2.4,
    implosionUnderpressureBar: 1.0,
    fragilityDropPx: 290,
    heatLossCoeffWK: 0.30,
    surfaceAreaCm2: 16.0,
    opticalPathCm: 2.6,
    geometry: new VesselGeometry([
      [0.0, 1.32],
      [1.2, 1.38],
      [12.0, 1.38],
      [13.8, 1.38],
    ]),
  },
  quartz_u_tube: {
    id: 'quartz_u_tube',
    kind: 'vessel',
    category: 'thermal',
    shape: 'quartz_u_tube',
    isUTube: true,
    hasTwoEnds: true,
    supportsClamp: true,
    breakable: true,
    i18nKey: 'eq_quartz_u_tube',
    isoStandard: 'Fused Silica U-Tube (SiO₂ ≥ 99.9% · 1600 °C · Dual-Limb)',
    materialSpec: 'Fused Quartz (SiO₂)',
    diameterMm: 24,
    heightMm: 108,
    wallThicknessMm: 2.2,
    maxThermalStressK: 1873,
    clampOffsetY: -12,
    maxVolumeMl: 100,
    tareMassG: 76.0,
    glassHeatCapacityJK: 68.0,
    width: 92,
    height: 118,
    limbSpacingX: 28,
    tubeOuterR: 13,
    tubeInnerR: 10,
    neckRadius: 11,
    heatable: true,
    stopperable: true,
    popPressureBar: 1.55,
    popOverpressureBar: 0.55,
    shatterPressureBar: 3.4,
    shatterOverpressureBar: 2.4,
    implosionUnderpressureBar: 1.0,
    fragilityDropPx: 290,
    heatLossCoeffWK: 0.32,
    surfaceAreaCm2: 14.0,
    opticalPathCm: 2.4,
    geometry: new VesselGeometry([
      [0.0, 1.66],
      [1.2, 1.72],
      [8.5, 1.72],
      [10.8, 1.72],
    ]),
  },
  crucible_tongs: {
    id: 'crucible_tongs',
    kind: 'tongs',
    category: 'thermal',
    flippable: true,
    breakable: false,
    i18nKey: 'eq_crucible_tongs',
    isoStandard: 'DIN 12890 · Bow-Grip Crucible Tongs (200 mm)',
    materialSpec: 'Stainless Steel',
    tareMassG: 72.0,
    width: 146,
    height: 44,
    fragilityDropPx: Infinity,
  },
  iron_spoon: {
    id: 'iron_spoon',
    kind: 'spoon',
    category: 'thermal',
    flippable: true,
    breakable: false,
    heatable: true,
    i18nKey: 'eq_iron_spoon',
    isoStandard: 'Deflagrating & Combustion Spoon · Fe–Cr Steel (Max 1450 °C)',
    materialSpec: 'Heat-Resistant Steel (Fe–Cr)',
    maxThermalStressK: 1723,
    maxVolumeMl: 2.8,
    tareMassG: 28.0,
    width: 30,
    height: 118,
    fragilityDropPx: Infinity,
  },
  thermometer: {
    id: 'thermometer',
    kind: 'thermometer',
    category: 'thermal',
    flippable: true,
    breakable: true,
    supportsClamp: true,
    clampOffsetY: -24,
    i18nKey: 'eq_thermometer',
    isoStandard: 'ASTM / DIN Immersion Lab Thermometer (-50–450 °C)',
    materialSpec: 'Borosilicate 3.3 + Spirit / K-Type Sensor',
    tareMassG: 32.0,
    width: 24,
    height: 150,
    fragilityDropPx: 230,
  },
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
    isoStandard: 'Pneumatic Trough (1500 mL Glass Bath · Ø168×78 mm)',
    materialSpec: 'Annealed Borosilicate 3.3 Bath',
    diameterMm: 168,
    heightMm: 78,
    wallThicknessMm: 3.4,
    maxThermalStressK: 620,
    maxVolumeMl: 1500,
    tareMassG: 440.0,
    glassHeatCapacityJK: 325.0,
    width: 196,
    height: 90,
    neckRadius: 94,
    heatable: false,
    stopperable: false,
    popPressureBar: null,
    shatterPressureBar: 2.2,
    shatterOverpressureBar: 1.2,
    implosionUnderpressureBar: null,
    fragilityDropPx: 230,
    heatLossCoeffWK: 1.15,
    surfaceAreaCm2: 189.0,
    opticalPathCm: 15.0,
    geometry: new VesselGeometry([
      [0.0, 7.5],
      [7.2, 8.0],
      [7.8, 8.3],
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
    flippable: true,
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
  rubber_stopper: {
    id: 'rubber_stopper',
    kind: 'rubber_stopper',
    category: 'separation',
    breakable: false,
    flippable: true,
    i18nKey: 'eq_rubber_stopper',
    isoStandard: 'DIN 12871 · Tapered EPDM Rubber Stopper (Solid / 1-Hole Bore)',
    materialSpec: 'Chemically Resistant EPDM Elastomer',
    tareMassG: 14.0,
    width: 34,
    height: 28,
    fragilityDropPx: Infinity,
  },
  phen_cotton: {
    id: 'phen_cotton',
    kind: 'phen_cotton',
    category: 'titration',
    breakable: false,
    flippable: true,
    i18nKey: 'eq_phen_cotton',
    isoStandard: 'Phenolphthalein-Impregnated Absorbent Cotton Swab (NH₃ Indicator)',
    materialSpec: 'Sterile Cotton Fiber + 1% C₂₀H₁₄O₄ Solution',
    tareMassG: 4.5,
    width: 32,
    height: 24,
    fragilityDropPx: Infinity,
  },

  // --- Prompt 25 Large & Round-Bottom Glassware ---
  beaker_1000: {
    id: 'beaker_1000',
    kind: 'vessel',
    shape: 'beaker',
    category: 'vessels',
    breakable: true,
    i18nKey: 'eq_beaker_1000',
    isoStandard: 'ISO 3819 Low Form · Borosilicate 3.3',
    materialSpec: 'Borosilicate 3.3 Glass',
    diameterMm: 105,
    heightMm: 145,
    wallThicknessMm: 1.5,
    maxThermalStressK: 783,
    maxVolumeMl: 1000,
    tareMassG: 230.0,
    glassHeatCapacityJK: 191.0,
    width: 121,
    height: 167,
    neckRadius: 56,
    heatable: true,
    heatLossCoeffWK: 0.52,
    stopperable: false,
    invertible: false,
    supportsClamp: false,
    surfaceAreaCm2: 86.6,
    opticalPathCm: 10.2,
    popOverpressureBar: null,
    shatterPressureBar: 1.78,
    shatterOverpressureBar: 0.78,
    implosionUnderpressureBar: 0.68,
    fragilityDropPx: 235,
    geometry: new VesselGeometry([
      [0.0, 4.92],
      [0.45, 5.10],
      [13.5, 5.10],
      [14.2, 5.38],
    ]),
  },
  erlenmeyer_1000: {
    id: 'erlenmeyer_1000',
    kind: 'vessel',
    shape: 'erlenmeyer',
    category: 'vessels',
    breakable: true,
    i18nKey: 'eq_erlenmeyer_1000',
    isoStandard: 'ISO 1773 Narrow Neck · Borosilicate 3.3',
    materialSpec: 'Borosilicate 3.3 Glass',
    diameterMm: 131,
    heightMm: 215,
    neckDiameterMm: 42,
    wallThicknessMm: 1.5,
    maxThermalStressK: 783,
    maxVolumeMl: 1000,
    tareMassG: 290.0,
    glassHeatCapacityJK: 241.0,
    width: 151,
    height: 247,
    neckRadius: 24.0,
    heatable: true,
    heatLossCoeffWK: 0.44,
    stopperable: true,
    invertible: true,
    supportsClamp: true,
    surfaceAreaCm2: 19.0,
    opticalPathCm: 11.4,
    popOverpressureBar: 0.38,
    shatterPressureBar: 1.84,
    shatterOverpressureBar: 0.84,
    implosionUnderpressureBar: 0.90,
    fragilityDropPx: 245,
    geometry: new VesselGeometry([
      [0.0, 6.10],
      [0.65, 6.42],
      [15.5, 2.35],
      [17.2, 1.98],
      [20.5, 1.98],
      [21.2, 2.28],
    ]),
  },
  round_flask_250: {
    id: 'round_flask_250',
    kind: 'vessel',
    shape: 'round_flask',
    isRoundBottom: true,
    category: 'vessels',
    breakable: true,
    i18nKey: 'eq_round_flask_250',
    isoStandard: 'ISO 1773 / ISO 4797 · Borosilicate 3.3 · NS 29/32',
    materialSpec: 'Borosilicate 3.3 Glass + Cork Ring Base',
    diameterMm: 85,
    heightMm: 140,
    neckDiameterMm: 29,
    wallThicknessMm: 1.2,
    maxThermalStressK: 783,
    maxVolumeMl: 250,
    tareMassG: 118.0,
    glassHeatCapacityJK: 98.0,
    width: 98,
    height: 161,
    neckRadius: 17.0,
    heatable: true,
    heatLossCoeffWK: 0.38,
    stopperable: true,
    invertible: true,
    supportsClamp: true,
    surfaceAreaCm2: 11.0,
    opticalPathCm: 8.2,
    popOverpressureBar: 0.42,
    shatterPressureBar: 2.35,
    shatterOverpressureBar: 1.35,
    implosionUnderpressureBar: 0.98,
    fragilityDropPx: 265,
    geometry: new VesselGeometry(buildRoundFlaskProfile({
      bulbRadiusCm: 4.13,
      neckRadiusCm: 1.33,
      neckBaseCm: 8.6,
      neckTopCm: 13.2,
      rimCm: 13.8,
      rimRadiusCm: 1.62,
      heelRadiusCm: 0.34,
    })),
  },
  round_flask_1000: {
    id: 'round_flask_1000',
    kind: 'vessel',
    shape: 'round_flask',
    isRoundBottom: true,
    category: 'vessels',
    breakable: true,
    i18nKey: 'eq_round_flask_1000',
    isoStandard: 'ISO 1773 / ISO 4797 · Borosilicate 3.3 · NS 29/32',
    materialSpec: 'Borosilicate 3.3 Glass + Cork Ring Base',
    diameterMm: 131,
    heightMm: 200,
    neckDiameterMm: 29,
    wallThicknessMm: 1.5,
    maxThermalStressK: 783,
    maxVolumeMl: 1000,
    tareMassG: 265.0,
    glassHeatCapacityJK: 220.0,
    width: 151,
    height: 230,
    neckRadius: 17.5,
    heatable: true,
    heatLossCoeffWK: 0.44,
    stopperable: true,
    invertible: true,
    supportsClamp: true,
    surfaceAreaCm2: 16.5,
    opticalPathCm: 12.6,
    popOverpressureBar: 0.42,
    shatterPressureBar: 2.25,
    shatterOverpressureBar: 1.25,
    implosionUnderpressureBar: 0.96,
    fragilityDropPx: 240,
    geometry: new VesselGeometry(buildRoundFlaskProfile({
      bulbRadiusCm: 6.40,
      neckRadiusCm: 1.38,
      neckBaseCm: 13.5,
      neckTopCm: 18.9,
      rimCm: 19.6,
      rimRadiusCm: 1.72,
      heelRadiusCm: 0.42,
    })),
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
  'beaker_1000',
  'erlenmeyer_250',
  'erlenmeyer_1000',
  'round_flask_250',
  'round_flask_1000',
  'test_tube_50',
  'cylinder_100',
  'crucible_porcelain',
  'quartz_tube',
  'quartz_u_tube',
  'water_trough',
  'mortar_pestle',
  'filter_funnel',
  'rubber_stopper',
  'wash_bottle',
  'pipette_10',
  'burette_50',
  'liebig_condenser',
  'diffusion_tube',
  'retort_stand',
  'scale',
  'burner',
  'bunsen_burner',
  'ice_bath',
  'crucible_tongs',
  'iron_spoon',
  'thermometer',
  'gas_syringe',
  'splint',
  'flame_loop',
  'litmus_paper',
  'ph_strip',
  'phen_cotton',
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
  if (spec.kind === 'gas_syringe' || spec.isHorizontalTube) return spec.clampOffsetY ?? 0;
  return spec.clampOffsetY ?? -spec.height / 2 + (spec.shape === 'erlenmeyer' || spec.shape === 'round_flask' ? 24 : 26);
}

/**
 * Clamp an apparatus center y-coordinate onto a Retort Stand's stainless steel rod shaft.
 */
export function clampItemToStandY(itemSpec, stand, floorY = 482, candidateY = 0, floorPad = 4) {
  const stSpec = APPARATUS.retort_stand;
  const neckOff = getClampNeckOffsetY(itemSpec);
  const extPx = Math.max(0, Math.min(220, stand?.extendPx || 0));
  const standTop = stand.y - stSpec.height / 2 - extPx;
  const standBot = stand.y + stSpec.height / 2;
  const minItemY = standTop + 14 - neckOff;
  const maxItemY = Math.min(floorY - itemSpec.height / 2 - floorPad, standBot - 22 - neckOff);
  return Math.max(minItemY, Math.min(maxItemY, candidateY));
}

/**
 * Shared Left-Right flip & telescopic extension geometry helpers for Retort Stand.
 */
export function getStandGeometry(stand) {
  const rodSide = stand?.flippedX ? -1 : 1; // +1: rod on right, clamp reaches left (-1)
  const armDir = -rodSide;
  const rodX = (stand?.x || 0) + rodSide * 36;
  const extPx = Math.max(0, Math.min(220, stand?.extendPx || 0));
  const h = APPARATUS.retort_stand.height;
  const rodTopY = (stand?.y || 0) - h / 2 - extPx + 8;
  const rodBotY = (stand?.y || 0) + h / 2 - 14;
  return {
    rodSide,
    armDir,
    rodX,
    extendPx: extPx,
    rodTopY,
    rodBotY,
    clampTargetX(kind) {
      return rodX + armDir * (kind === 'gas_syringe' ? 45 : 28);
    },
  };
}

export function getCondenserPorts(cond) {
  const halfW = (APPARATUS.liebig_condenser?.width || 152) / 2;
  const dir = cond?.flippedX ? -1 : 1; // +1: left inlet -> right outlet tilted +0.14 rad
  const baseAngle = dir * 0.14 + ((Number(cond?.rotationDeg) || 0) * Math.PI) / 180;
  const cos = Math.cos(baseAngle);
  const sin = Math.sin(baseAngle);
  const rot = (dx, dy) => ({
    x: cond.x + dx * cos - dy * sin,
    y: cond.y + dx * sin + dy * cos,
  });
  return {
    dir,
    tiltAngle: baseAngle,
    inlet: rot(-dir * halfW * 0.94, 0),
    outlet: rot(dir * halfW * 0.94, 0),
    spout: rot(dir * 68, 8),
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
  if (item.kind === 'tongs') {
    return { x: item.x + dir * 64, y: item.y, dir };
  }
  if (item.kind === 'spoon') {
    const tip = rotatePointAround(item.x + dir * 2, item.y + 46, item.x, item.y, item.tiltAngle || 0);
    return { x: tip.x, y: tip.y, dir };
  }
  if (item.kind === 'thermometer') {
    const tip = rotatePointAround(item.x, item.y + 68, item.x, item.y, item.tiltAngle || 0);
    return { x: tip.x, y: tip.y, dir };
  }
  return { x: item.x, y: item.y, dir };
}

export function getItemRotatedHalfExtentY(spec, item = null) {
  if (!spec) return 40;
  const hw = (spec.width || 60) * 0.5;
  const hh = (spec.height || 60) * 0.5;
  let rad = 0;
  if (item) {
    if (item.kind === 'condenser') {
      const dir = item.flippedX ? -1 : 1;
      rad = dir * 0.14 + ((Number(item.rotationDeg) || 0) * Math.PI) / 180;
    } else if (item.tiltAngle) {
      rad = item.tiltAngle;
    } else if (item.tiltDeg) {
      rad = ((item.tiltDir < 0 ? -1 : 1) * (item.tiltDeg || 0) * Math.PI) / 180;
    }
  }
  if (Math.abs(rad) < 1e-4) return hh;
  return Math.abs(hh * Math.cos(rad)) + Math.abs(hw * Math.sin(rad));
}

export function rotatePointAround(px, py, cx, cy, rad) {
  if (!rad) return { x: px, y: py };
  const cos = Math.cos(rad);
  const sin = Math.sin(rad);
  const dx = px - cx;
  const dy = py - cy;
  return { x: cx + dx * cos - dy * sin, y: cy + dx * sin + dy * cos };
}

export function getVesselEndPorts(vessel) {
  if (!vessel || vessel.kind !== 'vessel' || vessel.isShattered) return null;
  const spec = APPARATUS[vessel.typeId] || APPARATUS.erlenmeyer_250;
  const effTilt = (vessel.tiltAngle || 0) + (vessel.landingTilt || 0);
  if (spec.isHorizontalTube) {
    const lp = rotatePointAround(vessel.x - spec.width / 2 - 4, vessel.y, vessel.x, vessel.y, effTilt);
    const lm = rotatePointAround(vessel.x - spec.width / 2 + 1, vessel.y, vessel.x, vessel.y, effTilt);
    const rp = rotatePointAround(vessel.x + spec.width / 2 + 4, vessel.y, vessel.x, vessel.y, effTilt);
    const rm = rotatePointAround(vessel.x + spec.width / 2 - 1, vessel.y, vessel.x, vessel.y, effTilt);
    return {
      left: {
        side: 'left',
        x: lp.x,
        y: lp.y,
        mouthX: lm.x,
        mouthY: lm.y,
        stoppered: Boolean(vessel.leftStoppered ?? vessel.isStoppered),
      },
      right: {
        side: 'right',
        x: rp.x,
        y: rp.y,
        mouthX: rm.x,
        mouthY: rm.y,
        stoppered: Boolean(vessel.rightStoppered ?? vessel.isStoppered),
      },
    };
  }
  if (spec.isUTube) {
    const dx = spec.limbSpacingX || 28;
    const topY = vessel.y - spec.height / 2;
    const lp = rotatePointAround(vessel.x - dx, topY - 8, vessel.x, vessel.y, effTilt);
    const lm = rotatePointAround(vessel.x - dx, topY + 2, vessel.x, vessel.y, effTilt);
    const rp = rotatePointAround(vessel.x + dx, topY - 8, vessel.x, vessel.y, effTilt);
    const rm = rotatePointAround(vessel.x + dx, topY + 2, vessel.x, vessel.y, effTilt);
    return {
      left: {
        side: 'left',
        x: lp.x,
        y: lp.y,
        mouthX: lm.x,
        mouthY: lm.y,
        stoppered: Boolean(vessel.leftStoppered ?? vessel.isStoppered),
      },
      right: {
        side: 'right',
        x: rp.x,
        y: rp.y,
        mouthX: rm.x,
        mouthY: rm.y,
        stoppered: Boolean(vessel.rightStoppered ?? vessel.isStoppered),
      },
    };
  }
  return null;
}

export function getVesselTubingPort(vessel, preferredSide = null) {
  if (!vessel || vessel.kind !== 'vessel' || vessel.isShattered) return null;
  const spec = APPARATUS[vessel.typeId] || APPARATUS.erlenmeyer_250;
  if (spec.hasTwoEnds) {
    const ends = getVesselEndPorts(vessel);
    if (!ends) return null;
    const activeSide = preferredSide || vessel.connectedPortSide || (vessel.flippedX ? 'left' : 'right');
    const chosen = ends[activeSide] || ends.right;
    if (!chosen.stoppered && !vessel.isStoppered) return null;
    return { x: chosen.x, y: chosen.y, side: activeSide };
  }
  if (!vessel.isStoppered) return null;
  const effTilt = (vessel.tiltAngle || 0) + (vessel.landingTilt || 0);
  const rawY = vessel.isInverted ? vessel.y + spec.height / 2 + 8 : vessel.y - spec.height / 2 - 8;
  const pt = rotatePointAround(vessel.x, rawY, vessel.x, vessel.y, effTilt);
  return { x: pt.x, y: pt.y, side: 'main' };
}

export function getTubeDestTipPos(sourceItem, targetVessel) {
  if (!targetVessel || targetVessel.kind !== 'vessel') {
    return targetVessel ? { x: targetVessel.x, y: targetVessel.y } : { x: 0, y: 0 };
  }
  const tSpec = APPARATUS[targetVessel.typeId] || APPARATUS.beaker_250;
  const effTilt = (targetVessel.tiltAngle || 0) + (targetVessel.landingTilt || 0);
  if (targetVessel.isInverted) {
    return rotatePointAround(targetVessel.x, targetVessel.y + tSpec.height / 2 - 4, targetVessel.x, targetVessel.y, effTilt);
  }
  const subRatio = Math.max(0, Math.min(1, sourceItem?.tubeSubmersionRatio ?? 0.72));
  const uprightMouthY = targetVessel.y - tSpec.height / 2 + 2;
  const uprightTipY = uprightMouthY + subRatio * Math.max(16, tSpec.height - 10);
  const finalRawY = targetVessel.isStoppered && subRatio < 0.08 ? uprightMouthY - 10 : uprightTipY;
  return rotatePointAround(targetVessel.x, finalRawY, targetVessel.x, targetVessel.y, effTilt);
}
