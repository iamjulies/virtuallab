/**
 * Organic Hydrocarbons & Halide Derivatives Module (virlab_beta_v5+build.6+).
 * Pure ES module providing hydrocarbon species properties & data-driven reactions.
 */

const AW = {
  H: 1.00794,
  C: 12.0107,
  N: 14.0067,
  O: 15.9994,
  Br: 79.904,
  Cl: 35.453,
};

export const HYDROCARBON_SPECIES = {
  C6H12_l: {
    id: 'C6H12_l',
    formula: 'CH₂=CH(CH₂)₃CH₃',
    name: 'Hex-1-ene',
    phase: 'l',
    liquidGroup: 'light_organic',
    molarMass: 6 * AW.C + 12 * AW.H,
    density: 0.673,
    cp: 183.3,
    meltTempK: 133.4,
    boilTempK: 336.5,
    dHVapJ: 30600,
    vaporPressureAtm298: 0.245,
    partitionKow: 2500,
    color: '#f8fafc',
    atoms: { C: 6, H: 12 },
    autoIgnitionK: 526.15,
    dHCombustJ: -4003000,
    functionalGroups: { isAlkene: true },
  },
  C6H12Br2_l: {
    id: 'C6H12Br2_l',
    formula: 'C₆H₁₂Br₂(l)',
    name: '1,2-Dibromohexane',
    phase: 'l',
    liquidGroup: 'heavy_organic',
    molarMass: 6 * AW.C + 12 * AW.H + 2 * AW.Br,
    density: 1.577,
    cp: 196.0,
    meltTempK: 223.15,
    boilTempK: 479.15,
    dHVapJ: 45200,
    partitionKow: 3200,
    color: '#fefce8',
    atoms: { C: 6, H: 12, Br: 2 },
    functionalGroups: { isHaloalkane: true },
  },
};

export const HYDROCARBON_REACTIONS = [
  {
    id: 'c6h12_br2_l_add',
    equation: 'C₆H₁₂(l) + Br₂(l) → C₆H₁₂Br₂(l)',
    type: 'general',
    nameVi: 'Hex-1-ene cộng Br₂ lỏng làm mất màu nhanh khi khuấy trộn',
    nameEn: 'Electrophilic addition of liquid Br₂ across Hex-1-ene double bond',
    descVi: 'Hex-1-ene cộng hợp Bromine tạo 1,2-Dibromohexane nặng hơn nước; khuấy hoặc lắc nhũ tương giúp tăng tốc tiếp xúc pha.',
    descEn: 'Hex-1-ene rapidly adds Bromine yielding dense 1,2-Dibromohexane; stirring or shaking accelerates phase-boundary contact.',
    reactants: { C6H12_l: 1, Br2_l: 1 },
    products: { C6H12Br2_l: 1 },
    conditions: {
      minTempK: 250,
      phaseContact: true,
      allowAnhydrous: true,
    },
    kinetics: {
      type: 'irreversible',
      k298: 0.015,
      eaJ: 12000,
      orders: { C6H12_l: 1, Br2_l: 1 },
    },
    deltaHJ: -115000,
  },
];
