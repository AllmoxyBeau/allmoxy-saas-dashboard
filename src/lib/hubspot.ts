/**
 * Shared helpers for building HubSpot deep links.
 *
 * HubSpot's "company record" URL includes the portal ID, the object type
 * (`0-2` = companies), the company record ID, and an `eschref` parameter
 * that tells HubSpot what the "Back" button should return to. We mirror the
 * URL format produced by HubSpot's own search results so the back button
 * lands on a search page rather than a blank state.
 */

export const HUBSPOT_PORTAL_ID = '4910812';

/**
 * Build the URL to a HubSpot Company record, in the same format HubSpot
 * generates when you click a company from a search result.
 *
 * Example output:
 *   https://app.hubspot.com/contacts/4910812/record/0-2/4405475673
 *     ?eschref=%2Fsearch%2F4910812%2Fsearch%3Fquery%3D4405475673
 *
 * Returns `null` when no id is supplied so callers can guard rendering.
 */
export function hubspotCompanyUrl(companyId: string | number | null | undefined): string | null {
  if (companyId == null || companyId === '') return null;
  const id = String(companyId);
  const eschref = `/search/${HUBSPOT_PORTAL_ID}/search?query=${id}`;
  return `https://app.hubspot.com/contacts/${HUBSPOT_PORTAL_ID}/record/0-2/${id}?eschref=${encodeURIComponent(eschref)}`;
}
