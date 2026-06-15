import { Type, type Static } from 'typebox';

// low | medium | high only — matches the golden-era calibration and the site's
// severity filter (App.tsx). No 'critical' tier.
export const SeveritySchema = Type.Union([
  Type.Literal('low'),
  Type.Literal('medium'),
  Type.Literal('high'),
]);

export const FindingSchema = Type.Object({
  id: Type.String(),
  url: Type.String(),
  title: Type.String(),
  domain: Type.String(),
  summary: Type.String(),
  category: Type.String(),
  subcategory: Type.Optional(Type.String()),
  whyBad: Type.String(),
  severity: SeveritySchema,
  foundAt: Type.String(),
  researchQuery: Type.String(),
});

export type Finding = Static<typeof FindingSchema>;

export const FindingsStoreSchema = Type.Object({
  lastUpdated: Type.String(),
  totalFindings: Type.Number(),
  findings: Type.Array(FindingSchema),
});

export type FindingsStore = Static<typeof FindingsStoreSchema>;

export const RunStateSchema = Type.Object({
  lastRun: Type.String(),
  categoryIndex: Type.Number(),
  // categoryKey -> normalizedUrls[]
  seenUrls: Type.Record(Type.String(), Type.Array(Type.String())),
  // categoryKey -> query -> lastSearchedAt (ISO string)
  queryHistory: Type.Record(Type.String(), Type.Record(Type.String(), Type.String())),
});

export type RunState = Static<typeof RunStateSchema>;

export const CategorySchema = Type.Object({
  key: Type.String(),
  name: Type.String(),
  description: Type.String(),
  researchQuery: Type.String(),
});

export type Category = Static<typeof CategorySchema>;
