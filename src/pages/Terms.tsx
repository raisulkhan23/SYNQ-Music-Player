import { LegalDoc } from "@/components/landing/LegalDoc";

/**
 * Terms of use. Reflects the app's real beta status and content sourcing.
 * The copy is unchanged from the first pass — only the presentation moved to
 * the document layout.
 */
export default function Terms() {
  return (
    <LegalDoc
      title="Terms of Use"
      version="1.0"
      effective="26 September 2026"
      preamble="The rules for using SYNQ. Plain English and short — if any of it is unclear, the conservative reading is the one that applies."
      sections={[
        {
          id: "acceptance",
          heading: "Acceptance",
          body: (
            <p>
              By creating an account or using SYNQ you agree to these terms. If
              you don't agree, please don't use the service.
            </p>
          ),
        },
        {
          id: "the-service",
          heading: "The service",
          body: (
            <>
              <p>
                SYNQ is a listening client. It does not host, own, or sell
                music, and it has no affiliation with any record label, artist,
                or rights holder.
              </p>
              <p>
                Playback is served by YouTube's embedded player. You are
                responsible for complying with YouTube's own terms and with
                applicable copyright law, and SYNQ may remove or block access to
                any specific item that is unavailable, restricted, or the
                subject of a valid complaint.
              </p>
            </>
          ),
          note: "SYNQ is currently in beta. Features may change, break, or disappear without notice, and parts of the app may be unavailable while we work on it.",
        },
        {
          id: "account",
          heading: "Your account",
          body: (
            <p>
              You're responsible for activity under your account and for keeping
              access to your sign-in method secure. Accounts are for individuals
              — don't share credentials.
            </p>
          ),
        },
        {
          id: "acceptable-use",
          heading: "Acceptable use",
          body: (
            <>
              <p>Don't use SYNQ to:</p>
              <ul>
                <li>Download, rip, or redistribute any audio or video.</li>
                <li>
                  Strip, replace, or obscure any copyright or attribution
                  notice.
                </li>
                <li>
                  Circumvent region limits, embed restrictions, or rate limits.
                </li>
                <li>
                  Probe, overload, scrape, or interfere with the service or its
                  infrastructure.
                </li>
                <li>
                  Upload content that is unlawful, infringing, or hateful.
                </li>
              </ul>
            </>
          ),
        },
        {
          id: "your-content",
          heading: "Your content",
          body: (
            <p>
              You keep ownership of the playlist names, notes, and track
              metadata you add. You give SYNQ the permission needed to store and
              display that content to you and, where the product requires it, to
              other users you deliberately share with.
            </p>
          ),
        },
        {
          id: "disclaimers",
          heading: "No warranty",
          body: (
            <p>
              SYNQ is provided <strong>as is</strong>, without warranties of any
              kind, express or implied, including fitness for a particular
              purpose. Because playback depends on third-party services, we
              cannot guarantee uninterrupted availability of any track.
            </p>
          ),
        },
        {
          id: "liability",
          heading: "Limitation of liability",
          body: (
            <p>
              To the maximum extent permitted by law, SYNQ and its operators are
              not liable for indirect, incidental, or consequential damages, or
              for any loss of data or playback, arising from your use of the
              service.
            </p>
          ),
        },
        {
          id: "changes",
          heading: "Changes and termination",
          body: (
            <p>
              These terms may be updated as the service changes; the date at the
              top of this page always reflects the current version. We may
              suspend or terminate an account that breaches these terms, and you
              can stop using SYNQ at any time by deleting your account.
            </p>
          ),
        },
      ]}
    />
  );
}
