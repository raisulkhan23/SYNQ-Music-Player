'use strict';
/**
 * Drop the hosted installers out of `dist/` before Capacitor copies it in.
 *
 * `public/` is copied into `dist/` wholesale, and Capacitor's `webDir` is
 * `dist`, so the Android release APK published for the website
 * (`public/downloads/SYNQ-1.0.0.apk`) would otherwise be embedded inside the
 * very APK that is being built — roughly 4 MB of the app shipping a copy of
 * itself, for a download the native app never offers.
 *
 * Runs between `vite build` and `cap sync android` (see `android:sync`). The
 * website build keeps the file; only the Android copy drops it. Safe to run
 * when there is nothing to remove.
 */
const fs = require('fs');
const path = require('path');

const target = path.resolve(__dirname, '..', 'dist', 'downloads');

if (!fs.existsSync(target)) {
  console.log('strip-downloads: nothing to remove (dist/downloads absent)');
} else {
  const before = fs
    .readdirSync(target)
    .reduce((n, f) => n + fs.statSync(path.join(target, f)).size, 0);
  fs.rmSync(target, { recursive: true, force: true });
  console.log(
    `strip-downloads: removed dist/downloads (${(before / 1024 / 1024).toFixed(1)} MB not bundled into the app)`,
  );
}
