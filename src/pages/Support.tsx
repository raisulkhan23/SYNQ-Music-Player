import { InfoPage } from "@/components/landing/InfoPage";

/** Support / help centre. Content mirrors the features that actually exist. */
export default function Support() {
  return (
    <InfoPage
      eyebrow="Help centre"
      title="Support"
      intro="Answers to the things people ask most. If something here doesn't cover your problem, the quickest fix is usually a hard refresh — playback state lives in your browser, not on our servers."
      updated="September 26, 2026"
      sections={[
        {
          id: "getting-started",
          heading: "Getting started",
          body: (
            <>
              <p>
                Create an account from the landing page, then land on{" "}
                <strong>Home</strong>. From there you can search any song, open
                a playlist, or press <strong>Play something random</strong> to
                hand the session over to us.
              </p>
              <p>
                Your queue, liked songs and playlists are tied to your account,
                so they follow you between devices once you're signed in.
              </p>
            </>
          ),
        },
        {
          id: "playback",
          heading: "Playback problems",
          body: (
            <>
              <p>
                <strong>Nothing plays, or it stalls.</strong> SYNQ streams
                through the official YouTube player. Very occasionally a video
                is region-locked or the embed is disabled — the app detects that
                and tries a direct stream instead. If a track never starts, skip
                it; it will not block the rest of the queue.
              </p>
              <p>
                <strong>The wrong song is playing.</strong> YouTube can
                auto-advance to a related video of its own accord. The app
                watches the player's real video id and snaps back to the track
                the UI is showing, so this should self-correct within a second.
              </p>
              <p>
                <strong>Repeat one loops but Next does nothing.</strong> Turn
                repeat off first — with repeat one active, Next moves you out of
                the loop into the next track.
              </p>
            </>
          ),
        },
        {
          id: "audio",
          heading: "Audio, EQ and effects",
          body: (
            <>
              <p>
                The EQ, balance and sound presets in{" "}
                <strong>Settings → Audio</strong> are real-time. They route
                through a Web Audio graph, and because the YouTube player can't
                be tapped by Web Audio, enabling any of them switches playback
                to a resolved stream automatically.
              </p>
              <p>
                Sound effects are intentionally <strong>session-only</strong> —
                they're never restored from storage, so you never get a surprise
                Bass Boost on a song you didn't set it up for.
              </p>
            </>
          ),
        },
        {
          id: "library",
          heading: "Playlists, likes and history",
          body: (
            <>
              <p>
                Add to playlist from any row's <strong>···</strong> menu. The
                picker warns you if the track is already in that playlist rather
                than silently duplicating it.
              </p>
              <p>
                Reordering the queue only moves the <em>upcoming</em> tracks —
                already-played history and the current track stay put. If you
                turn shuffle on and then off, the original order comes back.
              </p>
              <p>
                You can wipe your listening history at any time from{" "}
                <strong>Settings → Your data</strong>. Likes and playlists are
                kept.
              </p>
            </>
          ),
        },
        {
          id: "appearance",
          heading: "Appearance",
          body: (
            <>
              <p>
                Wallpapers are stored in your browser only — image and video
                files live in IndexedDB and are never uploaded. Use{" "}
                <strong>Revert to default</strong> to go back to the stock
                background while keeping your saved files, or{" "}
                <strong>Remove wallpaper library</strong> to delete them.
              </p>
              <p>
                <strong>Card transparency</strong> only has a visible effect
                while Liquid glass is on. Turn glass back on to see it.
              </p>
            </>
          ),
        },
        {
          id: "contact",
          heading: "Still stuck?",
          body: (
            <p>
              Try a hard refresh first — a stale tab is the most common cause of
              a stuck player. If the problem survives that, open{" "}
              <strong>Profile</strong> and use the in-app sign-out, then sign
              back in. Still stuck after that? It's worth reporting with the
              track name, since a single unavailable upload is usually the
              culprit.
            </p>
          ),
        },
      ]}
    />
  );
}
