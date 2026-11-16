/**
 * Apparatus specifications calibrated to ISO / DIN international glassware standards
 * (ISO 3819 / DIN 12331 Beakers, ISO 1773 / DIN 12380 Erlenmeyer, ISO 4788 Cylinder, ISO 4142 Test Tube).
 * Canvas uses a consistent ~1.15 px/mm visual scale across glassware.
 */
export const APPARATUS = {
  beaker_250: {
    id: 'beaker_250',
    kind: 'vessel',
    shape: 'beaker',
    formVariant: 'low',
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
    shatterPressureBar: null,
    heatLossCoeffWK: 0.45,
    surfaceAreaCm2: 36.1, // pi * (3.39 cm)^2 inner ID (~67.8 mm)
    opticalPathCm: 6.78,
  },
  beaker_tall_250: {
    id: 'beaker_tall_250',
    kind: 'vessel',
    shape: 'beaker',
    formVariant: 'tall',
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
    shatterPressureBar: null,
    heatLossCoeffWK: 0.43,
    surfaceAreaCm2: 26.2, // pi * (2.89 cm)^2 inner ID (~57.8 mm)
    opticalPathCm: 5.78,
  },
  erlenmeyer_250: {
    id: 'erlenmeyer_250',
    kind: 'vessel',
    shape: 'erlenmeyer',
    i18nKey: 'eq_erlenmeyer_250',
    isoStandard: 'ISO 1773 · DIN 12380 (Ø85×144 mm, cổ Ø32 mm)',
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
    popPressureBar: 1.55,
    shatterPressureBar: 2.8,
    heatLossCoeffWK: 0.38,
    surfaceAreaCm2: 12.5,
    opticalPathCm: 7.2,
  },
  test_tube_50: {
    id: 'test_tube_50',
    kind: 'vessel',
    shape: 'test_tube',
    i18nKey: 'eq_test_tube_50',
    isoStandard: 'ISO 4142 · Heavy Wall (Ø25×150 mm)',
    materialSpec: 'Borosilicate 3.3',
    diameterMm: 25,
    heightMm: 150,
    wallThicknessMm: 1.2,
    maxVolumeMl: 50,
    tareMassG: 26.0,
    glassHeatCapacityJK: 22.0,
    width: 34,
    height: 168,
    neckRadius: 17,
    heatable: true,
    stopperable: true,
    popPressureBar: 1.45,
    shatterPressureBar: 2.5,
    heatLossCoeffWK: 0.22,
    surfaceAreaCm2: 4.1,
    opticalPathCm: 2.3,
  },
  cylinder_100: {
    id: 'cylinder_100',
    kind: 'vessel',
    shape: 'cylinder',
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
    shatterPressureBar: null,
    heatLossCoeffWK: 0.30,
    surfaceAreaCm2: 6.2,
    opticalPathCm: 2.9,
  },
  scale: {
    id: 'scale',
    kind: 'scale',
    i18nKey: 'eq_scale',
    width: 156,
    height: 62,
    panWidth: 128,
    maxLoadG: 2000,
  },
  burner: {
    id: 'burner',
    kind: 'burner',
    i18nKey: 'eq_burner',
    width: 120,
    height: 112,
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
    i18nKey: 'eq_gas_syringe',
    maxVolumeMl: 250,
    width: 210,
    height: 76,
  },
};

export const APPARATUS_ORDER = [
  'beaker_250',
  'beaker_tall_250',
  'erlenmeyer_250',
  'test_tube_50',
  'cylinder_100',
  'scale',
  'burner',
  'gas_syringe',
];
