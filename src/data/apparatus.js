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
    shape: 'beaker',
    formVariant: 'low',
    supportsClamp: true,
    i18nKey: 'eq_beaker_250',
    isoStandard: 'ISO 3819 · DIN 12331 (Low 70×95 mm)',
    materialSpec: 'Borosilicate 3.3',
    diameterMm: 70,
    heightMm: 95,
    wallThicknessMm: 1.1,
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
    shape: 'beaker',
    formVariant: 'tall',
    supportsClamp: true,
    i18nKey: 'eq_beaker_tall_250',
    isoStandard: 'ISO 3819 · DIN 12331 (Tall 60×120 mm)',
    materialSpec: 'Borosilicate 3.3',
    diameterMm: 60,
    heightMm: 120,
    wallThicknessMm: 1.1,
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
    shape: 'erlenmeyer',
    supportsClamp: true,
    i18nKey: 'eq_erlenmeyer_250',
    isoStandard: 'ISO 1773 · DIN 12380 (Ø85×144 mm · Ø32 mm)',
    materialSpec: 'Borosilicate 3.3',
    diameterMm: 85,
    heightMm: 144,
    neckDiameterMm: 32,
    wallThicknessMm: 0.8,
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
    implosionUnderpressureBar: 0.75,   // Non-heavy-wall conical flat base implodes under strong vacuum
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
    shape: 'test_tube',
    supportsClamp: true,
    i18nKey: 'eq_test_tube_50',
    isoStandard: 'ISO 4142 / DIN 12395 (Ø25×150 mm · Rimmed)',
    materialSpec: 'Borosilicate 3.3',
    diameterMm: 25,
    heightMm: 150,
    wallThicknessMm: 1.5,
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
    shape: 'cylinder',
    supportsClamp: true,
    i18nKey: 'eq_cylinder_100',
    isoStandard: 'ISO 4788 · Class A (100 mL)',
    materialSpec: 'Borosilicate 3.3',
    diameterMm: 31,
    heightMm: 210,
    wallThicknessMm: 1.2,
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
    supportsClamp: true,
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
    i18nKey: 'eq_retort_stand',
    isoStandard: 'Heavy Base + Steel Rod · Bosshead Clamp',
    materialSpec: 'Cast Iron + 304 Stainless Steel',
    width: 112,
    height: 310,
  },
};

export const APPARATUS_ORDER = [
  'beaker_250',
  'beaker_tall_250',
  'erlenmeyer_250',
  'test_tube_50',
  'cylinder_100',
  'pipette_10',
  'retort_stand',
  'scale',
  'burner',
  'gas_syringe',
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
