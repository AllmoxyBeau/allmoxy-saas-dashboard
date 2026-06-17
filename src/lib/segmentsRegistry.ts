// Canonical Allmoxy segments registry.
//
// Mirrors the marketing canon at registry/segments.md (Drive folder
// "Allmoxy Marketing"), which is verified against the HubSpot
// primary_segment_framework property and is the single source of truth
// for segment values, display labels, GTM colors, and ordering.
//
// If HubSpot's option list changes, update THIS file alongside the
// canon registry — every dashboard surface that displays segments
// derives ordering and color from here.
//
// Two stored-value / display-label divergences are preserved on purpose:
//   - HubSpot stores "Designers" but displays "Designer"
//   - HubSpot stores "Windows & Doors (Fenestration)" but displays
//     "Windows & Exterior Doors"
// We use the stored value as the lookup key (it's what customer_profiles
// carries) and the label for human-facing chips / titles.

export type Segment = {
  /** HubSpot stored value — the exact string customer_profiles.primary_segment carries. */
  value: string;
  /** Human-facing display label (may differ from value). */
  label: string;
  /** Hex color. Charcoal for the 11 context-only segments; distinct GTM color for the 9 sells-to segments. */
  color: string;
  /** Whether Allmoxy actively sells to / influences this segment. */
  inMotion: boolean;
  /** HubSpot-canonical order (1-20). Use this when sorting. */
  order: number;
};

const CHARCOAL = '#4B5563';

/** The canonical 20 segments, in HubSpot order. */
export const CANONICAL_SEGMENTS: Segment[] = [
  { order: 1,  value: 'Cabinetry',                          label: 'Cabinetry',                          color: '#004FC5', inMotion: true  },
  { order: 2,  value: 'Closets & Home Organization',        label: 'Closets & Home Organization',        color: '#F5C518', inMotion: true  },
  { order: 3,  value: 'Architectural Woodwork',             label: 'Architectural Woodwork',             color: '#DC2626', inMotion: true  },
  { order: 4,  value: 'Millwork',                           label: 'Millwork',                           color: '#D97706', inMotion: true  },
  { order: 5,  value: 'Retail Fixtures & Store Fixtures',   label: 'Retail Fixtures & Store Fixtures',   color: '#14B8A6', inMotion: true  },
  { order: 6,  value: 'Contract / Institutional Furniture', label: 'Contract / Institutional Furniture', color: '#6B4F8C', inMotion: true  },
  { order: 7,  value: 'Dealer / Showroom',                  label: 'Dealer / Showroom',                  color: '#2E8B57', inMotion: true  },
  { order: 8,  value: 'Designers',                          label: 'Designer',                           color: '#D4659F', inMotion: true  },
  { order: 9,  value: 'Installer / Contractor',             label: 'Installer / Contractor',             color: CHARCOAL,  inMotion: false },
  { order: 10, value: 'Distribution / Wholesale',           label: 'Distribution / Wholesale',           color: CHARCOAL,  inMotion: false },
  { order: 11, value: 'Hardware Supply',                    label: 'Hardware Supply',                    color: CHARCOAL,  inMotion: false },
  { order: 12, value: 'Machinery / Equipment',              label: 'Machinery / Equipment',              color: CHARCOAL,  inMotion: false },
  { order: 13, value: 'Lumber / Sawmill / Primary Wood',    label: 'Lumber / Sawmill / Primary Wood',    color: CHARCOAL,  inMotion: false },
  { order: 14, value: 'Residential Furniture',              label: 'Residential Furniture',              color: '#B45309', inMotion: true  },
  { order: 15, value: 'Specialty Wood Products',            label: 'Specialty Wood Products',            color: CHARCOAL,  inMotion: false },
  { order: 16, value: 'Panel Products / Engineered Wood',   label: 'Panel Products / Engineered Wood',   color: CHARCOAL,  inMotion: false },
  { order: 17, value: 'Countertops',                        label: 'Countertops',                        color: CHARCOAL,  inMotion: false },
  { order: 18, value: 'Windows & Doors (Fenestration)',     label: 'Windows & Exterior Doors',           color: CHARCOAL,  inMotion: false },
  { order: 19, value: 'Hardwood Flooring',                  label: 'Hardwood Flooring',                  color: CHARCOAL,  inMotion: false },
  { order: 20, value: 'Other / Unclassified',               label: 'Other / Unclassified',               color: CHARCOAL,  inMotion: false },
];

const BY_VALUE = new Map(CANONICAL_SEGMENTS.map((s) => [s.value, s]));

/** The bucket used when a customer has no primary_segment value. */
export const UNSEGMENTED_LABEL = 'Unsegmented';
export const UNSEGMENTED_COLOR = '#8B949E';

/** Look up a segment by its HubSpot stored value. Returns null for unknown values. */
export function getSegment(value: string | null | undefined): Segment | null {
  if (value == null) return null;
  const trimmed = value.trim();
  if (!trimmed) return null;
  return BY_VALUE.get(trimmed) ?? null;
}

/** Display label for a stored value. Falls back to the value itself if unrecognized, or "Unsegmented" for null/blank. */
export function segmentLabel(value: string | null | undefined): string {
  if (value == null || !value.trim()) return UNSEGMENTED_LABEL;
  return getSegment(value)?.label ?? value.trim();
}

/** GTM color for a stored value. Charcoal for context-only segments, grey for unsegmented, fallback grey for unknown values. */
export function segmentColor(value: string | null | undefined): string {
  if (value == null || !value.trim()) return UNSEGMENTED_COLOR;
  return getSegment(value)?.color ?? UNSEGMENTED_COLOR;
}

/** Canonical HubSpot sort order (1-20). Unsegmented sorts last; unknown values sort just before it. */
export function segmentOrder(value: string | null | undefined): number {
  if (value == null || !value.trim()) return 999;
  return getSegment(value)?.order ?? 998;
}
