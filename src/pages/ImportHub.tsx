import { Navigate } from "react-router";

/**
 * `/import` now redirects into Settings.
 *
 * Importing is no longer its own destination: `ImportSection` has always lived
 * inside Settings, and the standalone page was a second way into the same
 * component. With the nav entry gone, this route stays only so the old URL does
 * not dead-end — anyone with it bookmarked lands on the real thing instead of a
 * blank screen or a 404.
 *
 * The anchor matches the section's position in the Settings list so the import
 * panel is what they land on, rather than the top of a long settings page.
 */
export default function ImportHub() {
  return <Navigate to="/settings#import" replace />;
}