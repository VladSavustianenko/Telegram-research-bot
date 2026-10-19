/** Suggested default (SPEC §3); the user must still confirm it. */
export const SUGGESTED_TIME_ZONE = 'Europe/Kyiv';

/** Region-based IANA names ("Area/Location[/Sub]"); also keeps names safe inside callback data. */
const REGION_ZONE = /^[A-Za-z]+(?:\/[A-Za-z0-9_+-]+){1,2}$/;
const MAX_ZONE_LENGTH = 40;

/** Lower-case name -> runtime spelling. The runtime list may use older names (e.g. Europe/Kiev). */
let knownZones: Map<string, string> | undefined;
function known(): Map<string, string> {
  knownZones ??= new Map(
    Intl.supportedValuesOf('timeZone').map((zone) => [zone.toLowerCase(), zone]),
  );
  return knownZones;
}

/**
 * Returns a canonical spelling of an IANA time zone name, or null. Input is
 * case-insensitive. Only region-based names (and "UTC") are accepted: Intl
 * also accepts abbreviations such as "EST" (mapped to some region) and offsets,
 * which are rejected here. Newer names the runtime list does not contain yet
 * (such as "Europe/Kyiv") are accepted when Intl accepts them.
 */
export function normalizeTimeZone(input: string): string | null {
  const candidate = input.trim();
  if (candidate.toUpperCase() === 'UTC') return 'UTC';
  if (candidate.length > MAX_ZONE_LENGTH || !REGION_ZONE.test(candidate)) return null;
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: candidate });
  } catch {
    return null;
  }
  return known().get(candidate.toLowerCase()) ?? titleCase(candidate);
}

/** "europe/kyiv" -> "Europe/Kyiv"; "america/north_dakota/new_salem" -> "America/North_Dakota/New_Salem". */
function titleCase(zone: string): string {
  return zone.toLowerCase().replace(/(^|[/_-])([a-z])/g, (_match, sep: string, letter: string) => {
    return `${sep}${letter.toUpperCase()}`;
  });
}
