import { InfoPage } from "@/components/landing/InfoPage";

/**
 * Privacy notice. Written against what the codebase actually does — the
 * storage tables and localStorage keys below are real, not boilerplate.
 */
export default function Privacy() {
  return (
    <InfoPage
      eyebrow="The fine print"
      title="Privacy"
      intro="SYNQ is built to collect as little as possible. There are no ads, no ad trackers, and nothing is sold. This page describes exactly what is stored and where."
      updated="September 26, 2026"
      sections={[
        {
          id: "account",
          heading: "Your account",
          body: (
            <p>
              Signing in stores the minimum needed to identify you: your email
              address, the name from your sign-in provider, and your profile
              image if the provider supplies one. You can sign in with a{" "}
              <strong>one-time email code</strong>, Google or GitHub — the
              password never touches our servers in any case, because the
              one-time code flow is passwordless.
            </p>
          ),
        },
        {
          id: "server-data",
          heading: "What we store on our servers",
          body: (
            <>
              <p>Your account and everything you deliberately save:</p>
              <ul className="list-disc space-y-1 pl-5">
                <li>
                  <strong>Liked songs</strong> and liked albums, so your library
                  follows you between devices.
                </li>
                <li>
                  <strong>Playlists</strong> you create, including the track
                  metadata you add to them.
                </li>
                <li>
                  <strong>Listening history</strong> — what you played, when,
                  and how often, which is what powers your stats, streaks and
                  recommendations.
                </li>
                <li>
                  <strong>Listening rooms and follows</strong> if you use the
                  social features.
                </li>
              </ul>
              <p>
                This is stored in a Convex database. Deleting your account
                removes it.
              </p>
            </>
          ),
        },
        {
          id: "on-device",
          heading: "What stays on your device",
          body: (
            <>
              <p>
                A lot of SYNQ is deliberately local. None of this is sent to our
                servers, and clearing your browser data resets it:
              </p>
              <ul className="list-disc space-y-1 pl-5">
                <li>
                  <strong>Your wallpaper files</strong> — images and videos are
                  kept in your browser's IndexedDB and are never uploaded.
                </li>
                <li>
                  <strong>Playback position</strong>, so "Continue listening"
                  can offer to resume a long track where you stopped.
                </li>
                <li>
                  <strong>Preferences</strong> — volume, playback speed, EQ and
                  sound settings, theme, accent colour, card transparency,
                  wallpaper blur, and whether Liquid glass is on.
                </li>
                <li>
                  <strong>Your recent searches</strong>, kept on-device for
                  quick re-running.
                </li>
              </ul>
            </>
          ),
        },
        {
          id: "third-parties",
          heading: "Third parties",
          body: (
            <>
              <p>
                <strong>YouTube.</strong> Audio and video are played through the
                official YouTube embedded player, so Google receives the same
                playback data it would if you visited youtube.com directly. We
                do not use third-party ad or analytics trackers on this site.
              </p>
              <p>
                <strong>Convex</strong> hosts the app's backend and database.
                <strong> Google Fonts</strong> serves the Inter and Space
                Grotesk typefaces. Both are contacted as a normal part of
                loading the page.
              </p>
              <p>
                <strong>Your sign-in provider</strong> (if you use Google or
                GitHub) also receives the sign-in request.
              </p>
            </>
          ),
        },
        {
          id: "not-collected",
          heading: "What we do not do",
          body: (
            <ul className="list-disc space-y-1 pl-5">
              <li>We do not sell or rent your data. To anyone.</li>
              <li>We do not run ads, ad networks, or cross-site trackers.</li>
              <li>We do not build advertising profiles about you.</li>
              <li>We do not email you marketing.</li>
            </ul>
          ),
        },
        {
          id: "your-controls",
          heading: "Your controls",
          body: (
            <p>
              You can <strong>clear your listening history</strong> at any time
              from <strong>Settings → Your data</strong> — likes and playlists
              are kept. Signing out clears the session from this device. To have
              your account and everything attached to it deleted, use the
              sign-out control in <strong>Settings</strong> and then contact us.
            </p>
          ),
        },
      ]}
    />
  );
}
