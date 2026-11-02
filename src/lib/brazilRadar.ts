// The Brazilian radar kept from an archive volume (Ponte Nova, SP): every
// moment and product, drawn by the radar viewer as site "BR-PNV" -- see
// backend/brazil_radar.py.

export const isBrazilSite = (id: string | null | undefined) => !!id && id.toUpperCase().startsWith("BR-");
