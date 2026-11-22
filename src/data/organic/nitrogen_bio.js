/**
 * Nitrogen & Biomolecule Organic Compounds Module (Peptides, Amines, Amides).
 * Pure ES module supplying species metadata & property-driven biomolecular markers.
 */

const AW = {
  H: 1.00794,
  C: 12.0107,
  N: 14.0067,
  O: 15.9994,
  Cu: 63.546,
};

export const NITROGEN_BIO_SPECIES = {
  Peptide_s: {
    id: 'Peptide_s',
    formula: 'Polypeptide(s)',
    name: 'Polypeptide (Peptide chain)',
    phase: 's',
    molarMass: 4 * AW.C + 8 * AW.H + 2 * AW.N + 3 * AW.O,
    density: 1.42,
    cp: 165.0,
    noMelt: true,
    color: '#fefce8',
    highlightColor: '#ffffff',
    visualType: 'white_powder',
    renderLayer: 'bottom',
    renderOrder: 184,
    atoms: { C: 4, H: 8, N: 2, O: 3 },
    functionalGroups: { hasPeptideBond: true },
  },
  Peptide_aq: {
    id: 'Peptide_aq',
    formula: 'Polypeptide(aq)',
    name: 'Polypeptide (aqueous)',
    phase: 'aq',
    molarMass: 4 * AW.C + 8 * AW.H + 2 * AW.N + 3 * AW.O,
    color: '#f8fafc',
    atoms: { C: 4, H: 8, N: 2, O: 3 },
    functionalGroups: { hasPeptideBond: true },
  },
  CuPeptide_aq: {
    id: 'CuPeptide_aq',
    formula: '[Cu(Peptide)₂](aq)',
    name: 'Copper(II)-peptide Biuret complex (violet)',
    phase: 'aq',
    molarMass: AW.Cu + 2 * (AW.O + AW.H) + 2 * (4 * AW.C + 8 * AW.H + 2 * AW.N + 3 * AW.O),
    color: '#7c3aed',
    colorAlpha: 0.72,
    rgb: [124, 58, 237],
  },
};

export const NITROGEN_BIO_REACTIONS = [
  {
    id: 'dissolve_peptide',
    equation: 'Polypeptide(s) → Polypeptide(aq)',
    type: 'dissolution',
    solidId: 'Peptide_s',
    ionCheckId: 'Peptide_aq',
    nameVi: 'Hòa tan Polypeptide vào nước',
    nameEn: 'Dissolution of Polypeptide in water',
    descVi: 'Chuỗi polypeptide tan tạo dung dịch chứa liên kết peptide (–CO–NH–).',
    descEn: 'Polypeptide dissolves to expose peptide bonds (–CO–NH–) in aqueous solution.',
    reactants: { Peptide_s: 1 },
    products: { Peptide_aq: 1 },
    solubilityMolPerKg298: 1.5,
    solubilityTempCoeff: 0.004,
    k298: 0.08,
    eaJ: 12000,
    deltaHJ: 4500,
  },
];
