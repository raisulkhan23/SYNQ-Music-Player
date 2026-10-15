# Changelog

All notable changes to SYNQ, newest first.

This project follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/)
and semantic versioning.

---

## [Unreleased] — Browse-first release

The headline change: **SYNQ asks for an account when you do something that
needs one, not before you've used it.** You land, you browse, and the session
request arrives at the moment you press play, like or save.

### Fixed

#### The "Lyric & lo-fi videos" section could silently disappear from search

The section was never removed — it was gated on `lyricResults.length > 0` while
the backend reported every failure as an empty list. One transient YouTube
error therefore removed the whole block with no message and no way to retry,
which is indistinguishable from the feature having been deleted.

The action now reports failure separately from "no matches", and the section
renders whenever the lookup settles: results, an honest note when the filter
genuinely matched nothing, or the failure with a working **Try again**.

#### The install button rendered on two lines

Tailwind's preflight sets `svg { display: block }`, so in a plain inline
`<button>` the Download icon became a block and forced a line break of its own —
icon stacked above the word "Install", in a tall lozenge. It is now an
`inline-flex` row with `whitespace-nowrap`, slightly roomier padding, and
`shrink-0` so the strip's long explanatory text cannot squeeze it.

#### Crossfade diagnostics

A crossfade that does not run is invisible: there is no overlap, no error and no
message, so the only symptom is the absence of a fade — which looks identical
whether the planner said no, the browser could not build the audio graph, or
nothing was queued next. Every cause reported the same thing, so three rounds of
fixes were three rounds of guessing.

Settings → Audio now says which:

- **Last change** — a plain-English account of what the most recent track
  boundary actually did: the blend that ran, the gapless hand-off, the hand-off
  that was skipped and _why_, the planner's cut, or the refusal reason.
- **Check blending here** — evaluates every gate the real path applies against
  live state and answers whether the _next_ boundary can crossfade, naming the
  blocker if it cannot.

### Fixed — transitions

#### Crossfade and gapless playback did not actually work

_(Second pass. A re-audit of the first pass found four more defects, all at
the transition BOUNDARY — the ~120ms window where the outgoing track's `ended`
collides with the blend that is finishing.)_

7. **The outgoing track's `ended` cancelled the blend that owned it.** A 6s
   crossfade on a 240s track starts at 234s and its automation finishes at
   ~240s — the same instant the element fires `ended`, which arrives ~120ms
   _before_ the blend's completion poll. The handler read that as "the
   transition failed" and so cancelled the blend mid-flight, called
   `resetAllDeckGains()` (forcing the already-playing incoming deck back to
   gain 1), and advanced the queue onto the track _after_ the one fading in.
   Every crossfade therefore produced two songs at once with the fading-in one
   orphaned at full volume. A running blend now owns its own boundary: the
   event is deferred, and recovered if the blend is then abandoned.
8. **Cancelling a blend left the incoming deck playing.** `resetAllDeckGains()`
   sets both decks to unity, so a transition abandoned after `incoming.play()`
   had resolved left the incoming song audible at full volume beside the
   outgoing one. Every cancel path hit this — seek, Next, clearing the queue,
   switching repeat mode, changing the crossfade length. Cancel now _stops_ the
   element it started.
9. **A gapless boundary never recorded the play as completed.** The hand-off
   returned before `settleEngagement` ran, so the outgoing track's engagement
   session was settled later against the _next_ track's position — a wrong
   completion percentage and a false "skipped" flag in the recommendation
   signals.
10. **"Stop after this song" lost to the gapless hand-off.** The hand-off ran
    first, so arming the sleep timer with gapless on started the next track
    instead of stopping.

#### (First pass, for the record)

Audited against the real execution path rather than the settings UI. Six
defects, two of them fatal. The settings, the toggles and the code that
_decided_ to crossfade were all present and correct the whole time — the
transitions simply never reached the audio.

1. **A released deck was permanently dead.** Web Audio allows exactly one
   `createMediaElementSource()` per `<audio>` element, ever, and that call
   permanently reroutes the element's audio through the returned node.
   `releaseDeck()` disconnected the node and forgot it, so a deck that had been
   faded out could never make a sound again — and because `canCrossfadeNow()`
   requires a gain node on _both_ decks, crossfade could run **at most once per
   page load**. The second crossfade of a session not only failed to fade, it
   loaded the incoming track onto an element that could not be heard at all.
   The deck now releases only its _content_; the graph stays wired.
2. **The crossfade engine was unreachable for almost everyone.** Default
   YouTube playback runs through the IFrame API, which Web Audio cannot tap,
   and the switch that chose between the IFrame and the `<audio>` decks only
   favoured the decks for an EQ or an effect preset. With a flat EQ — i.e. most
   listeners — playback used the IFrame, every transition plan silently became a
   cut, and the AudioContext was often never even constructed. Asking for a
   crossfade now routes playback onto the decks and builds the graph, exactly as
   an effect preset already did.
3. **The incoming track was audible at full volume before the fade.** Both deck
   gains were reset to unity and the incoming element was started _before_ the
   automation was scheduled, so the next song came in at 100% for the length of
   the `play()` promise, then slammed to zero and faded up. The incoming deck is
   now parked at zero first.
4. **A refused blend orphaned a playing element.** If the gain automation
   declined, the already-playing incoming deck was left running: two songs at
   once, and the end-of-track handler later advanced to a third.
5. **Manual Next never faded.** The skip armed its plan with a playhead
   position of `0`, so the run-down trigger could never be satisfied, and `Next`
   tore down the current track before any blend could run. It now runs a short
   bounded blend and then advances.
6. **Gapless was not implemented at all.** A gapless plan returned from the
   scheduler immediately and nothing was ever preloaded, so the next stream was
   not resolved until after `ended` — inside the very gap the setting exists to
   remove. Gapless is now a real hand-off: the next track is resolved and
   buffered on the spare deck ahead of the boundary and started at `ended`.

### Changed

- **Gapless preload lead** is 20s, and the incoming track is now prepared for
  every transition mode rather than only for crossfades.
- **Transition tracing** (`[SYNQ:transition] …`) in development builds only,
  covering arming, refusals, the blend itself, completion and skipped hand-offs.
  Every one of these failures previously looked identical from the UI: no
  crossfade, no error, no explanation.

### Known limitations — playback

- **Gapless is not sample-accurate.** Two `HTMLAudioElement`s cannot be made to
  switch with sample precision the way a single `MediaSource` append of two
  encoded segments can, so a small scheduler-granularity seam remains. What is
  gone is every gap SYNQ was adding on top of it — stream resolution, first
  bytes, element creation, re-render.
- **The YouTube IFrame still cannot be crossfaded.** Audio inside a cross-origin
  frame is not reachable by Web Audio. When a track is forced onto the IFrame,
  transitions fall back to gapless rather than pretending to blend.

### Added

#### Single-profile settings sync

Settings and player preferences now live on the account, so they come back
when you sign in on another device.

- Settings, theme, wallpaper and playback preferences are stored once per
  account rather than only in the browser.
- Signing in hydrates the local defaults from the server first, so the
  profile version of each preference wins.
- Local changes are pushed back in the background when they settle.
- Only stable UI/player preferences are synced; current track, queue
  position and play state stay local to the device.

#### Authorized downloads, where they are allowed

Downloads are now an honest, server-authorized feature rather than a
attempt to copy a stream SYNQ only has permission to play.

- The backend decides, on every request, whether a release is licensed for
  download before any bytes move.
- A playable track is not automatically a downloadable one; the menu and the
  player only show Download when the track can actually be saved.
- The Download hub shows progress, speed, ETA, cancel and retry.
- Downloaded copies are stored on the device and used for offline playback,
  but streaming and downloading remain separate paths.

#### Fullscreen download

The fullscreen player can start a download from the player itself.

- The Download button in the fullscreen player uses the same eligibility
  rules as the track menus, so it never offers something the backend would
  refuse.

#### Visual preferences

- The Performance mode toggle was moved into the Visual Preferences section
  so it sits with the other display controls instead of under Focus modes.

#### Crossfade & gapless playback

Songs now blend into one another instead of stopping dead at the end of a
track.

- **Crossfade** — `0 / 2 / 4 / 6 / 8 / 10` seconds, configured in
  **Settings → Audio**.
- **Equal-power fade curve.** A linear crossfade dips audibly in the middle,
  because the sum of two linear ramps is not constant power. The curve is
  `sin`/`cos`, so the perceived level holds steady through the blend.
- **Gapless playback**, on by default — no dead air between tracks.
- **Preloading.** The incoming track is fetched up to 12 seconds before it is
  needed, so a crossfade never starts from a cold buffer.
- **Stream rescue.** Tracks that refuse to play inline are automatically
  re-resolved to a direct audio stream instead of failing silently.

Implemented with a **two-deck** audio architecture: a second `<audio>` element
with its own `MediaElementSource` and its own transition gain feeding the
shared EQ chain. One element cannot overlap itself.

#### Installable app (PWA)

SYNQ installs to a device and keeps working without a network.

- Install from the **landing page**, the in-app strip, or **Settings → App**.
- Offline shell and image caching via a versioned service worker.
- Launches standalone — no browser chrome.
- Home-screen shortcuts to Home, Search, Liked and Discover.
- Custom icons (192/512, plus a maskable variant) and iOS home-screen metadata.
- **Non-disruptive updates.** A new version is downloaded in the background and
  applied only when it is safe — the app will not swap the bundle out from under
  a playing track. `skipWaiting` is never called on install.

#### Deferred authentication

- `/home`, `/search`, `/discover`, `/artist/*` and `/album/*` are open to
  visitors.
- Sign-in is requested **contextually**, when playback or a save is attempted.
- **Intent is preserved.** Click Play, sign in, and that exact song starts — no
  clicking twice. This works across the OAuth round-trip, because the pending
  action is serialisable data in `sessionStorage` rather than an in-memory
  closure that a document navigation would destroy.
- **Non-blocking dismissal.** "Maybe later", Escape and an overlay click all
  return you to the exact page, scroll position and selection you left.
- Sign-in opens as a dialog over the current page. No redirect, no reload.
- Reuses the existing Google / GitHub / email-code providers through a single
  extracted `AuthForm`, so the page and the dialog cannot drift apart.

#### Account control

- **Switch account** and **Sign out** are now reachable from the sidebar and
  the phone menu. Previously three sign-out implementations existed and none
  could be opened.
- Signing out **wipes the local listening session** — queue, history and the
  half-played track — so a shared device does not hand the next person the
  previous listener's state.
- Visitors are labelled **"Browsing as guest"** with a single honest _Sign in_
  action, instead of a profile link and a sign-out button that do nothing.

#### Undo & quick controls

- **Clearing the queue is undoable.** It is the most destructive control in the
  panel — it drops the whole of Up Next in one tap, including autoplay picks the
  recommendation engine cannot regenerate — but the toast offered no way back.
  The toast now carries a working **Undo** that restores the exact previous
  queue, playhead index and shuffle snapshot, and re-persists them so a reload
  cannot undo the undo. The snapshot is single-use, so it can never land on top
  of a queue the listener has since rebuilt.
- **The command menu covers repeat, like and the queue.** ⌘K already ran
  playback and navigation; it now also toggles repeat, likes the current track
  and opens the queue. Each item calls a store action that already existed, and
  the like action reads the current track at invoke time rather than closing
  over render state.

### Fixed — playback, layout & input

#### Playback

- **Playback depended on a service that had stopped working, with no
  fallback and no timeout.** Measured live against the deployed backend:
  `youtube:resolveStream` answered `{"reason": "Sign in to confirm you're not a
bot", "url": null}` for **8 videos out of 8**, identically across retries —
  YouTube has escalated against the deployment's datacenter IP. Both hardcoded
  Piped fallbacks answered HTTP 500 with `SignInConfirmNotBotException`, and
  every other public instance was shut down, 403 or 526. No direct stream could
  be resolved for essentially any track.
  Crossfade and gapless both _require_ a direct stream, because the YouTube
  IFrame's audio cannot be tapped by Web Audio — and `gapless` ships **on**, so
  every track took that path. The result was a track that could sit at
  `buffering=true, playing=false, position 0.0` for ever: both decks holding no
  source, the YouTube player started only as an afterthought, and that path
  having **no load watchdog at all**. A spinner that never resolves, with no
  sound and no message. Stream resolution is now raced against a short deadline
  so the YouTube player is never gated behind a best-effort lookup, and the
  fallback arms the same load watchdog every other engine path has, so a track
  that genuinely cannot start surfaces as an error in seconds.
- **Every song was downloaded twice, from two CDNs at once.** With a crossfade,
  a gapless hand-off, an EQ preset or an effect — anything that routes playback
  through the `<audio>` decks — SYNQ started the YouTube IFrame "so effects never
  delay the first sound", then resolved a direct stream and loaded the _same
  audio_ onto the deck through the Convex proxy, discarding the IFrame a second
  later. Pausing the IFrame does not cancel its download; YouTube buffers ahead
  regardless of play state. Meanwhile the next track had already begun
  preloading on the spare deck, twenty seconds before it was needed. Three
  concurrent audio streams per song on one connection, with the live deck
  losing the bandwidth and stalling — which is what "keeps buffering" was, and
  why it got worse the more features were switched on. Only one engine now plays
  a track and only one downloads it: the stream is resolved first and started on
  the decks, and the YouTube player is a genuine fallback for videos that cannot
  be resolved rather than a race it can lose. The resolver no longer starts any
  playback at all. The cost is one round-trip before the first sound on a cold
  cache, and the next track is already being resolved while the current one
  plays.
- **A song could sit in "buffering" forever.** The 8-second stall watchdog
  recovered by calling `audio.load()`, which **discards every byte already
  downloaded** and refetches from zero. A buffer that was merely slow to fill
  therefore had its progress thrown away every eight seconds, dropped back to
  `HAVE_NOTHING`, and the next `stalled` re-armed the watchdog — a retry
  mechanism that guaranteed the condition it existed to fix. It now reloads only
  when nothing at all has arrived, keeps the partial buffer otherwise, and has a
  ceiling: after two attempts it stops and says the stream kept stalling rather
  than pretending to keep trying.
- **Audio was crackly, gritty and quiet — the same song was playing twice.**
  Nothing was broken; it was being played _twice_. `ytEngine.play()` awaits the
  YouTube IFrame API and only then calls `loadVideoById()`, while `pause()` is
  synchronous. SYNQ starts the IFrame first and hands sound to the `<audio>`
  decks as soon as a direct stream resolves, so it issued `play()` and `pause()`
  in the same tick. On a cold IFrame, `pause()` found nothing to pause and did
  nothing at all — and the pending `play()` then started the video anyway. From
  there the deck played the track through Web Audio while the IFrame played it
  dry, microseconds out of phase. Two copies of one signal summed that far apart
  is a comb filter, which is exactly what it sounded like. The IFrame also kept
  overwriting `currentTime`/`duration` from its own clock, so the position and
  the transition scheduler were reading two different sources at once. The
  engine now records the play/pause intent so a pause issued at any point wins —
  including before the player exists — and stops reporting state or time once
  the decks own the sound, using the same predicate the rest of the store
  already trusts.
- **Silent playback.** `createMediaElementSource()` permanently diverts an
  `<audio>` element's output into the Web Audio graph. The graph was built with
  the element captured _before_ the chain to `destination` existed, so any
  failure in between (notably a missing `createStereoPanner` on older Safari and
  some WebViews) left an element feeding nothing at all — the player advanced,
  the progress bar moved, and there was no sound. The graph is now built and
  connected before anything is captured, and a failed build can no longer
  orphan an element.
- **Crossfade ran once per session.** Releasing a deck tore down its graph
  nodes permanently, so after the first transition the app silently fell back to
  hard cuts.
- **Manual Next restarted the song.** The next-track press armed a transition
  for the track it was about to play, which then crossfaded into a duplicate of
  itself.
- **Next skipped a track whenever crossfade was on.** A successful manual blend
  already advances the queue through `commitCrossfadeAdvance`, and the blend
  wrapper then advanced a _second_ time — fading into the next song and skipping
  straight past it. Both outcomes clear `transition`, so only the `committed`
  flag distinguishes them; the trailing advance now respects it.
- **The crossfade was a straight line, not equal-power.** `scheduleCrossfade`
  sampled the sin/cos curve and then scheduled a linear ramp between its first
  and last samples, so the arrays were discarded and the audible fade sagged
  ~6dB in the middle — the exact artefact the equal-power curve exists to
  remove. The sampled curve is now handed to Web Audio with
  `setValueCurveAtTime`, with an endpoint-ramp fallback for older WebViews.

#### Navigation & layout

- **Settings section chips did nothing.** The scroll resolver picked the nearest
  _matching_ ancestor rather than the nearest _scrollable_ one, so clicks wrote
  to a container that could never move. It also queried a `data-` attribute
  that exists nowhere in the app.
- **"Your Data" rendered above "Playback".** A positional CSS ladder re-ordered
  the settings panel behind the section list's back; inserting one new section
  shifted every `nth-of-type` slot after it.
- **The ⌘K hint was clipped.** A ~110px pill was mounted in the 72px collapsed
  sidebar rail, so the `⌘K` badge was cut off on every render.
- **The install banner overlapped the queue panel**, pinned over the exact
  pixels it slides across.

#### Search

- **Artist pages reported "Nothing found" for artists that exist.** The page
  fired two InnerTube searches concurrently, which this deployment's IP is
  rate-limited into answering with empty results. Searches are now sequential,
  paced and retried using the constants already proven by the playlist-repair
  path, and a throttled request is reported as _throttled_ rather than as an
  artist with no songs.
- A genuine empty result and a refused request are now distinct states, and
  only the latter offers a retry.

#### Input & accessibility

- **Space no longer fires over a focused control.** The global shortcut handler
  swallowed Space and issued its own play/pause, which both broke keyboard
  activation of buttons and could trigger a sign-in prompt a visitor never
  asked for.
- The settings scroll rail and the account menu gained regression tests after
  both shipped broken.

### Security

No change. This release is a user-experience change only.

The deferred-authentication gate is a **client-side courtesy, not a security
control**. Every Convex mutation that requires an identity still resolves the
session server-side and throws without one; `getAuthUserId` guards are
untouched, and the recommendation engine still returns no signals for an
anonymous caller rather than fabricating a listening history.

### Known limitations — packaging & access

- The install flow requires a **published build**. It is gated on
  `import.meta.env.PROD` because a service worker in front of a dev server
  caches module URLs that are re-hashed on every dependency re-optimisation —
  which is precisely the stale-bundle failure a service worker exists to
  prevent. The UI names this reason rather than failing silently.
- Some YouTube videos cannot be played through the embed path and depend on
  direct-stream resolution succeeding.
- `/liked`, `/playlists`, `/playlist/:id`, `/stats`, `/recent`, `/social`,
  `/profile`, `/settings` and `/admin` still require an account. They show a
  signed-in person's library and history; there is nothing there for a stranger.
