import { useCallback, useState } from "react";
import { toast } from "sonner";
import { CheckCircle2, Loader2, Plug, XCircle } from "lucide-react";
import {
  checkCustomResolver,
  clearCustomResolver,
  readCustomResolver,
  writeCustomResolver,
  type ResolverCheck,
} from "@/lib/customResolver";

/**
 * Settings: point SYNQ at a resolver you run yourself.
 *
 * WHY THIS SECTION IS NECESSARY, AND WHY IT IS THE ONLY THING THAT WORKS.
 * Downloads need a real audio file they can read. Every resolver on a server
 * is bot-blocked by YouTube — the app's own backend, and every public Piped
 * and Invidious mirror, all answer `"Sign in to confirm you're not a bot"`
 * because YouTube blocks datacenter IPs. Playback is unaffected because it
 * runs through the IFrame API, which is a real browser session rather than a
 * resolver, and its audio cannot be read back out to be saved.
 *
 * A resolver on a network YouTube does not block is reached from an IP YouTube
 * is willing to serve, so it works. That network can be anything you control —
 * this machine, a box on your LAN, a VPS, a residential connection. The app
 * asks for a URL rather than pretending a public mirror will start working.
 *
 * The "Test connection" button is the point of the section. Without it, the
 * only way to find out whether a resolver is right is to start a download and
 * read the error — which is the exact loop this exists to break.
 */
export function ResolverSection({ className = "" }: { className?: string }) {
  // `localStorage` is read lazily ONCE, in the initialiser, rather than in an
  // effect. An effect would render an empty field and then fill it in a frame
  // later, which both flickers and — under `react-hooks/set-state-in-effect` —
  // is a setState during the commit phase. The reader already swallows storage
  // failures, so a locked-down browser just starts empty.
  const [saved, setSaved] = useState(() => readCustomResolver());
  const [value, setValue] = useState(saved);
  const [checking, setChecking] = useState(false);
  const [result, setResult] = useState<ResolverCheck | null>(null);

  const test = useCallback(async () => {
    const candidate = value.trim();
    if (!candidate) {
      setResult({
        ok: false,
        reason: "invalid",
        detail: "Enter an address first.",
      });
      return;
    }
    setChecking(true);
    setResult(null);
    try {
      setResult(await checkCustomResolver(candidate));
    } finally {
      setChecking(false);
    }
  }, [value]);

  const save = useCallback(() => {
    const stored = writeCustomResolver(value);
    setValue(stored);
    setSaved(stored);
    setResult(null);
    if (stored) {
      toast.success("Resolver saved — downloads will use it first");
    } else {
      toast.success("Resolver removed");
    }
  }, [value]);

  const clear = useCallback(() => {
    clearCustomResolver();
    setValue("");
    setSaved("");
    setResult(null);
    toast.success("Resolver removed");
  }, []);

  return (
    <section
      id="resolver"
      className={`settings-resolver flex flex-col gap-2.5 ${className}`}
    >
      <p className="flex items-center gap-1.5 text-[11px] font-semibold tracking-widest text-muted-foreground uppercase">
        <Plug className="size-3.5" />
        Offline downloads
      </p>

      <div className="rounded-xl border border-white/10 bg-white/[0.03] px-3 py-3">
        <p className="text-sm font-medium">Your own resolver</p>
        <p className="mx-auto mt-1 max-w-md text-xs text-muted-foreground">
          Downloads need a resolver for stream links. Google blocks every
          server-based one — including ours and the public Piped and Invidious
          mirrors — with &ldquo;Sign in to confirm you&rsquo;re not a
          bot&rdquo;, because they run on data-centre addresses. Streaming is
          unaffected; only saving a copy needs this.
        </p>
        <p className="mx-auto mt-1.5 max-w-md text-xs text-muted-foreground">
          Run Piped anywhere you control and paste its address — on this machine
          with{" "}
          <code className="rounded bg-white/10 px-1 py-0.5 font-mono text-[11px]">
            docker run -p 8080:8080 teamnewpipe/piped
          </code>{" "}
          (then <code className="rounded bg-white/10 px-1 py-0.5 font-mono text-[11px]">http://localhost:8080</code>),
          or on a box you own over your LAN or the internet. The address stays
          on this device and is never sent anywhere else.
        </p>
        <p className="mx-auto mt-1.5 max-w-md text-xs text-muted-foreground">
          Two things to know if it is not on this machine. Browsers only trust
          plain HTTP for <em>localhost</em>, so anywhere else it needs HTTPS or
          the browser will refuse it before it leaves the device. And YouTube
          bans server addresses, so a VPS should reach YouTube through an IPv6
          rotator or a VPN — Piped&rsquo;s own docs recommend one of those two.
        </p>

        <div className="mt-2.5 flex flex-wrap items-center gap-2">
          <input
            type="url"
            inputMode="url"
            value={value}
            placeholder="http://localhost:8080  ·  https://piped.example.com"
            aria-label="Resolver address"
            onChange={(e) => {
              setValue(e.target.value);
              setResult(null);
            }}
            onKeyDown={(e) => {
              if (e.key === "Enter") void test();
            }}
            className="min-w-0 flex-1 rounded-lg border border-white/10 bg-black/30 px-3 py-2 text-sm outline-none focus:border-white/25"
          />
          <button
            type="button"
            onClick={() => void test()}
            disabled={checking}
            className="flex shrink-0 items-center gap-1.5 rounded-lg border border-white/15 px-3 py-2 text-xs font-medium hover:bg-white/5 disabled:opacity-60"
          >
            {checking ? (
              <Loader2 className="size-3.5 animate-spin" />
            ) : (
              <Plug className="size-3.5" />
            )}
            Test connection
          </button>
          <button
            type="button"
            onClick={save}
            className="shrink-0 rounded-lg bg-white/90 px-3 py-2 text-xs font-semibold text-black hover:bg-white"
          >
            Save
          </button>
          {saved ? (
            <button
              type="button"
              onClick={clear}
              className="shrink-0 rounded-lg px-2 py-2 text-xs text-muted-foreground hover:text-foreground"
            >
              Remove
            </button>
          ) : null}
        </div>

        {result ? (
          <p
            className={`mt-2 flex items-start gap-1.5 text-xs ${
              result.ok ? "text-emerald-400" : "text-amber-400"
            }`}
          >
            {result.ok ? (
              <CheckCircle2 className="mt-px size-3.5 shrink-0" />
            ) : (
              <XCircle className="mt-px size-3.5 shrink-0" />
            )}
            <span>{result.detail}</span>
          </p>
        ) : null}

        {saved ? (
          <p className="mt-2 text-xs text-muted-foreground">
            Using <span className="font-mono text-foreground">{saved}</span>
          </p>
        ) : (
          <p className="mt-2 text-xs text-muted-foreground">
            No resolver set — downloads will try public mirrors, which Google
            currently blocks.
          </p>
        )}
      </div>
    </section>
  );
}
