/**
 * Opens a Google consent page (full-page navigation, as OAuth requires).
 * Kept in its own module so screens can be tested without navigating.
 */
export function openGoogle(url: string) {
  window.location.assign(url);
}
