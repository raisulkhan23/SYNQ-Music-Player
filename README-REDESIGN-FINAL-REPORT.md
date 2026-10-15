SYNQ README redesign — final report
Date: 2026-10-15

This is the completion report for the SYNQ GitHub repository presentation
redesign. It covers what was audited, what was changed, what metadata was
updated, and what could not be verified.


================================================================================
1. EXISTING README PROBLEMS
================================================================================

The previous README.md was an ops/Convex starter note, not a product README.

- No product header.
- No SYNQ logo at the top.
- No tagline.
- No badges.
- No banners or screenshots.
- No download section.
- No release notes.
- No prominent feature showcase.
- No repository context for a visitor landing on GitHub.


================================================================================
2. NEW README STRUCTURE
================================================================================

New top-to-bottom structure:

- Centered SYNQ logo.
- Project name: SYNQ.
- Tagline: "Your music, uninterrupted."
- Three README badges: latest release, license, downloads.
- Internal navigation: Website · Features · Screenshots · Download ·
  Installation · Releases · Contributing.
- Short product description.
- Independent-project notice.
- Banner image.
- Features section, with audio, library, discovery, experience, and
  authenticated-experience groups, plus honest limitations.
- Screenshots section, with a placeholder note and a recommended screenshot
  list.
- Download section with prominent Android and Windows badges, exact desktop
  installer filenames, version, and a clear releases-page link.
- Installation instructions for Web, Windows, Android, and account.
- Troubleshooting section.
- Releases section with changelog link, release-artifact expectations, and a
  checksum table for the built copies actually in the repository.
- Contributing section.
- Support section.
- License section with an honest note about the unconfirmed GitHub license
  metadata.
- Project notice section.
- A separator and a preserved Developer notes section containing the prior
  project README content.


================================================================================
3. LOGO AND BANNER ASSETS
================================================================================

Logo:
- Used: public/logo.png
- Type: relative GitHub image path
- Display width: 180px

Banner:
- Located at: assets/readme/synq-banner.png
- Built by: scripts/build-readme-banner.cjs
- Source: SYNQ logo (public/logo.png, 512x512)
- Dimensions: 1200x630
- Size: 147,739 bytes
- The README still says the banner should later be replaced with stronger app
  screenshots; this banner is the authored SYNQ banner, not a hero-image copy.

Screenshots:
- Folder prepared: assets/readme/screenshots/
- Currently empty; the README lists the screenshots that would be useful.


================================================================================
4. BADGES
================================================================================

Badges added:

- Latest release
  - Shields.io GitHub release badge
  - Links to:
    https://github.com/raisulkhan23/synqmusic/releases
- License
  - Shields.io GitHub license badge
  - Links to LICENSE.txt
- Downloads
  - Shields.io GitHub downloads badge
  - Links to:
    https://github.com/raisulkhan23/synqmusic/releases

Platform badges in the download section:

- Android APK
- Windows NSIS installer
- Windows portable

Badge owner/name used throughout: raisulkhan23/synqmusic

Known limitation: I could not verify that the Shields.io release/download
badges render with real values for this private repository from this session.
The links are correct, but the badge values may be empty or unavailable until
GitHub has public releases/downloads for this repo.


================================================================================
5. DOWNLOAD LINKS
================================================================================

Downloads section links:

- Android APK
  - Links to the releases page, not an invented direct asset URL.
- Windows installer
  - Listed as SYNQ-1.0.0-x64.exe
  - Links to the releases page
- Windows portable
  - Listed as SYNQ-1.0.0-x64-Portable.exe
  - Links to the releases page

Verified local artifacts behind those references:

- desktop-dist/SYNQ-1.0.0-x64.exe
  - 129,597,300 bytes
- desktop-dist/SYNQ-1.0.0-x64-Portable.exe
- SYNQ-1.0.0-release.apk
  - 6,002,624 bytes

Important honesty point:
- I did not find a verified published GitHub release for this private repo
  from this session.
- The public web check for releases/tags returned 404, and I did not have an
  authenticated GitHub releases/tags read available here.
- So the README links to the releases page honestly and says published
  downloads are posted there when available, instead of pretending a release
  already exists.


================================================================================
6. INSTALLATION DOCUMENTATION CHANGES
================================================================================

Added installation sections:

Web:
- Link to https://synqmusic.freebuff.app
- PWA install guidance

Windows:
- Download from the releases page
- Installer or portable usage
- SmartScreen/warning caveat for unpublished or unsigned builds
- Note that the desktop build is an Electron app

Android:
- APK install from the releases page when published
- Outside-app-store install prompt note
- Note that minSdk is determined by android/app/build.gradle
- Note that an APK built outside the signing setup may be unsigned

Account:
- When sign-in is needed

Troubleshooting:
- Track playback issues
- Embed vs direct-stream limitation
- Published build vs dev-server build


================================================================================
7. SCREENSHOT GALLERY CHANGES
================================================================================

- Added a Screenshots section.
- Current gallery uses the banner asset as a stand-in.
- README explicitly says to replace it with real app screenshots later.
- Recommended screenshot list included:
  - Home and discovery
  - Search
  - Library and playlists
  - Mini player
  - Fullscreen player
  - Lyrics or visualizer
  - Settings and personalization
  - Windows desktop app
  - Android app


================================================================================
8. RELEASE WORKFLOW IMPROVEMENTS
================================================================================

README-level improvements:
- Release section now points at the real Releases page.
- Release-artifact expectations are stated clearly.
- SHA-256 checksums are included for the built copies currently in the repo.
- The edition is framed around Keep a Changelog and semantic versioning.

Local artifact checksums included in the README:
- SYNQ-1.0.0-x64.exe
  - 7382149212fed6c69961b154bc055210d50c3e7c9c16d7b8d11171df5e9bcf94
- SYNQ-1.0.0-x64-Portable.exe
  - 13123067d37b954d6f5f72977ec5a36d7ddea13e78ee447fbc35c2bd9b626a23
- SYNQ-1.0.0-release.apk
  - 5813d9e382379e4a7d918cd3798f20d83368abf1b75be9601469b86d382c1771

Important honesty point:
- These checksums are for the built copies currently in the repository. They
  are not presented as authoritative for a published release, because I could
  not verify that a release exists.


================================================================================
9. REPOSITORY METADATA CHANGES
================================================================================

Set through the GitHub integration:

Description:
- From: "Freebuff project: SynqMusic"
- To: "SYNQ — a music player focused on discovery, smooth playback, and a
  cleaner listening experience."

Homepage:
- https://synqmusic.freebuff.app

Topics set:
- android
- audio-player
- electron
- music-player
- pwa
- react
- typescript
- windows

Not changed:
- Repository license metadata is still null on GitHub.
- The project includes LICENSE.txt, but I did not set repository-level license
  metadata or relabel it as MIT.
- No social-preview image was changed from here.


================================================================================
10. EXACT FILES MODIFIED
================================================================================

Modified:
- README.md

Created:
- assets/readme/synq-banner.png
- assets/readme/screenshots/  (empty prepared folder)
- scripts/build-readme-banner.cjs
- README.md.bak-pre-redesign-2026-10-15
- design-notes-readme-redesign.md

Checkpoint copies created for the redesign work:
- assets-readme-checkpoint/hero.png
- assets-readme-checkpoint/logo.png
- assets-readme-checkpoint/logo.ico
- assets-readme-checkpoint/product-icon.png
- assets-readme-checkpoint/favicon-32.png
- assets-readme-checkpoint/LICENSE.txt
- assets-readme-checkpoint/CHANGELOG.md


================================================================================
11. GITHUB SETTINGS THAT REQUIRE MANUAL CHANGES
================================================================================

These are recommended but were not finished from this session.

Repository license metadata:
- GitHub currently shows no detected license for this repository.
- The project does include LICENSE.txt.
- To make the license show up on GitHub, choose the matching license setting
  on the GitHub repo Settings page, or add an appropriate recognized license
  file/spdx identifier if LIC.txt is not the intended open-source license.

Social-preview image:
- Recommended candidate: public/product-icon.png
- To set it manually:
  1. Open https://github.com/raisulkhan23/synqmusic
  2. Click Settings
  3. Find the social preview setting
  4. Upload public/product-icon.png or another chosen image
  5. Save

If the repository should eventually have real releases:
- Create a GitHub release from the built artifacts when they are the intended
  distribution artifacts.
- Then update the README download links to point at the real release assets
  instead of only the releases page.


================================================================================
12. BROKEN LINKS AND REMAINING LIMITATIONS
================================================================================

Verified links:
- https://synqmusic.freebuff.app
- https://github.com/raisulkhan23/synqmusic/releases
- https://github.com/raisulkhan23/synqmusic/issues
- https://github.com/raisulkhan23/synqmusic/pulls
- https://github.com/raisulkhan23/synqmusic/discussions
- LICENSE.txt
- CHANGELOG.md

Limitations:
- The repo is private, so the README cannot be visually confirmed from this
  environment via a public browser session.
- Release/download badges and the releases page itself may show little or
  nothing until GitHub releases exist.
- No published release was verified from this session.
- No social-preview image was set from this session.
- The banner is now the authored SYNQ banner built from the SYNQ logo by
  scripts/build-readme-banner.cjs. It is not a copy of the hero image.
- The banner build is dependency-free and runs with Node only.
- Because I could not visually verify the rendered result in this environment,
  you should still open the image and the rendered README on GitHub before
  treating it as final.


================================================================================
END OF REPORT
================================================================================
