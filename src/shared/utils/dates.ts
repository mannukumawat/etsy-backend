export const isoDate = (d: Date | null | undefined) =>
  d ? (d instanceof Date ? d.toISOString() : String(d)) : null;
