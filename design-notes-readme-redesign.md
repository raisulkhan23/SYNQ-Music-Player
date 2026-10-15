SYNQ README redesign — design decisions and constraints
Created: 2026-10-15

Scope:
- Make the SYNQ GitHub repository read like a polished, real software project.
- Use SYNQ’s own branding, assets, and verified facts.
- Reference BitChord only for presentation quality and structure, not identity.

Verified facts used:
- Repository: raisulkhan23/synqmusic
- Default branch: main
- Homepage: https://synqmusic.freebuff.app
- GitHub repo description currently: "Freebuff project: SynqMusic"
- GitHub topics: none
- GitHub license metadata: null (but LICENSE.txt exists locally)
- Existing PRs: none
- Existing releases/tags: not verified on the public web side; the authenticated GitHub integration could read repo metadata but I could not confirm any published release or tag from this session.
- package.json version: 1.0.0
- Built desktop artifacts present locally:
  - desktop-dist/SYNQ-1.0.0-x64.exe
  - desktop-dist/SYNQ-1.0.0-x64-Portable.exe
  - desktop-dist/latest.yml with SHA-512 for the installer
- Built Android artifact present locally:
  - SYNQ-1.0.0-release.apk
  - SYNQ-1.0.0-release.apk.idsig
- Real brand assets:
  - public/logo.png (512x512)
  - public/hero.png (1200x630)
  - public/product-icon.png (512x512)
  - public/logo.ico
  - public/icons/*.png
- Real changelog: CHANGELOG.md, currently ## [Unreleased]
- Real license: LICENSE.txt (custom personal-use notice + MIT-style disclaimer paragraph)

What I am NOT claiming unless/until verified:
- A specific published GitHub Release URL or version.
- A detected GitHub license from the repository metadata.
- Any live download count or build badge that I haven't verified.

README header logo decision:
- Reuse public/logo.png with a relative GitHub path and a reasonable display width.
- Do not embed giant base64 images.

README banner decision:
- Primary existing banner candidate: public/hero.png (1200x630, ~69 KB).
- If used, keep it under assets/readme/ for organization, or reference it carefully if kept in public/.
- If a better banner is needed later, derive it from the same SYNQ brand assets, not BitChord assets.

Downloads section decision:
- Do not pretend unpublished GitHub releases exist.
- Point to the real website for the hosted app.
- For desktop/Android, present the real built artifacts honestly, with clear caveats about release state.

License decision:
- Display LICENSE.txt and link to it.
- Describe it as the project's license file.
- Do not label it MIT on the GitHub metadata unless/until the repository license is actually set.

Metadata decision:
- Propose a better repository description and topics.
- Recommend public/product-icon.png as the social-preview candidate.
- Provide manual steps if settings cannot be written through the integration.
