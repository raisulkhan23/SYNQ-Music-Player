import "@vly-ai/integrations";
import { Toaster } from "@/components/ui/sonner";
import { RequireAuth } from "@/components/RequireAuth";
import { AuthGateProvider } from "@/components/auth/AuthGateProvider";
import { ScrollToTop } from "@/components/ScrollToTop";
import { VlyToolbar } from "../vly-toolbar-readonly.tsx";
import { ConvexAuthProvider } from "@convex-dev/auth/react";
import { ConvexReactClient } from "convex/react";
import React, { StrictMode, useEffect, Suspense } from "react";
import { MotionConfig } from "framer-motion";
import { createRoot } from "react-dom/client";
import {
  BrowserRouter,
  Link,
  Navigate,
  Route,
  Routes,
  useLocation,
} from "react-router";
import {
  applyCardTransparency,
  readCardTransparency,
} from "@/lib/cardTransparency";
import { usePlayerStore } from "@/store/player";
import { applyAnimationLevel, readAnimationLevel } from "@/lib/motion";
import { installImageFallback } from "@/lib/imageFallback";
import "./index.css";

// SYNQ defaults to dark; restore the user's theme mode before first paint.
document.documentElement.classList.add("dark");
// Liquid glass is ON by default; restore the user's off-state before paint so
// panels never flash with the effect when it's disabled.
if (localStorage.getItem("ss.liquidGlass") === "0") {
  document.documentElement.classList.add("no-glass");
}
// Performance mode is the same idea: restore it before the first paint so a
// returning user never sees one frame of the expensive decorations.
if (localStorage.getItem("ss.performanceMode") === "1") {
  document.documentElement.classList.add("perf-lite");
}
// Motion budget, restored before paint for exactly the same reason: "reduced"
// and "off" must not flash a frame of full motion on the way in. This also
// migrates the older boolean Reduce-motion setting.
applyAnimationLevel(readAnimationLevel());
// Restore the saved card transparency before paint so glass panels never flash
// at the default opacity first.
applyCardTransparency(readCardTransparency());
// Broken remote artwork (expired CDN urls, rate-limited hosts, dead assets)
// must show the app's neutral placeholder instead of the browser's
// broken-image glyph. The install is idempotent and lives at module scope for
// the whole page, exactly like the theme restore above — never uninstalled.
installImageFallback();
const savedTheme = localStorage.getItem("ss.themeMode");
document.documentElement.dataset.scene =
  localStorage.getItem("ss.sceneTheme") ?? "studio";
if (savedTheme === "light") {
  document.documentElement.classList.remove("dark");
  document.documentElement.classList.add("light");
} else if (savedTheme === "amoled") {
  document.documentElement.classList.add("amoled");
}

/**
 * Route components are imported EAGERLY, not with React.lazy().
 *
 * Every one of these used to be a dynamic import, and that is what made the
 * app intermittently unusable: clicking a link changed the URL and then sat on
 * "Loading..." forever, while a hard refresh of that exact URL rendered the
 * page perfectly.
 *
 * The cause is the dev server. Vite stamps every pre-bundled dependency with a
 * `?v=<hash>`, and when the server restarts it re-optimises and issues a NEW
 * hash. A tab open across a restart keeps the module graph it already has, so
 * the first DYNAMIC import after it — a route chunk, because those were only
 * ever fetched on navigation — asks for deps under a hash the server no longer
 * serves. That request never settles, so React stays in the Suspense fallback
 * indefinitely. Every later click repeated it. A full page load does not hit
 * this, because it re-reads the entry document and gets a current graph, which
 * is the only reason a refresh ever appeared to fix it.
 *
 * Detecting and retrying that was not enough — it kept coming back, and every
 * retry cost the listener a spinner and a reload. Removing the dynamic imports
 * removes the failure mode: there is no chunk to fetch at navigation time, so
 * there is nothing that can fail to arrive and nothing to wait for. Navigation
 * is instant and cannot hang.
 *
 * The cost is a larger initial bundle, which is a deliberate trade: a slightly
 * heavier first paint beats a page that will not open. Reliability first.
 *
 * AppShell is imported here too, so the player, queue and nav are never torn
 * down during a navigation either.
 */
import AppShell from "./components/layout/AppShell.tsx";
import AuthPage from "./pages/Auth.tsx";
import TrackLink from "./pages/TrackLink.tsx";
import Home from "./pages/Home.tsx";
import Search from "./pages/Search.tsx";
import Discover from "./pages/Discover.tsx";
import DownloadHub from "./pages/DownloadHub.tsx";
import ImportHub from "./pages/ImportHub.tsx";
import Artist from "./pages/Artist.tsx";
import Album from "./pages/Album.tsx";
import Liked from "./pages/Liked.tsx";
import Playlists from "./pages/Playlists.tsx";
import PlaylistDetail from "./pages/PlaylistDetail.tsx";
import Admin from "./pages/Admin.tsx";
import Stats from "./pages/Stats.tsx";
import Recap from "./pages/Recap.tsx";
import Recent from "./pages/Recent.tsx";
import Social from "./pages/Social.tsx";
import Profile from "./pages/Profile.tsx";
import Settings from "./pages/Settings.tsx";
import NotFound from "./pages/NotFound.tsx";
// Public information pages linked from the landing footer. They sit OUTSIDE
// the RequireAuth group on purpose: a privacy notice or a support answer
// shouldn't require an account to read.
import Support from "./pages/Support.tsx";
import Privacy from "./pages/Privacy.tsx";
import Terms from "./pages/Terms.tsx";

// Simple loading fallback for route transitions
function RouteLoading() {
  return (
    <div className="flex h-full min-h-[40vh] w-full items-center justify-center">
      <div className="animate-pulse text-muted-foreground">Loading...</div>
    </div>
  );
}

/** Page-level Suspense boundary: lazy page chunks suspend HERE instead of
 *  bubbling up and unmounting AppShell + PlayerBar during navigation. */
function PageSuspense({ children }: { children: React.ReactNode }) {
  return <Suspense fallback={<RouteLoading />}>{children}</Suspense>;
}

/**
 * Per-ROUTE error boundary.
 *
 * Without this, a throw inside any page unwinds the whole tree: AppShell, the
 * player, the queue and the nav all unmount, and because the dev server runs
 * with the error overlay disabled the listener just gets a dead screen with no
 * message and no way out except a manual browser reload. That is why a single
 * bad artist link could make the entire app look broken.
 *
 * Scoping the boundary to the route means a failing page degrades to a card
 * with a way back, and playback, the queue and navigation keep working.
 */
class RouteErrorBoundary extends React.Component<
  { children: React.ReactNode },
  { error: Error | null }
> {
  state = { error: null as Error | null };
  static getDerivedStateFromError(error: Error) {
    return { error };
  }
  componentDidCatch(error: Error) {
    console.error("[SYNQ] route crashed:", error);
    // A route can die while a Radix layer (menu, sheet, dialog) is open. That
    // layer owned `body { pointer-events: none }` and is now unmounted, so
    // nothing will ever clear it — the app would keep rendering while every
    // control stayed dead. Release it here, where the unmount is known.
    if (document.body.style.pointerEvents === "none") {
      document.body.style.pointerEvents = "";
    }
  }
  render() {
    if (!this.state.error) return this.props.children;
    // Remounting the subtree with a new key clears the error, so "Try again"
    // re-renders the page from scratch instead of only resetting state.
    return (
      <RouteErrorCard
        message={this.state.error.message}
        onRetry={() => this.setState({ error: null })}
      />
    );
  }
}

function RouteErrorCard({
  message,
  onRetry,
}: {
  message: string;
  onRetry: () => void;
}) {
  return (
    <div className="flex flex-col items-center gap-4 rounded-3xl border border-dashed border-white/10 px-6 py-20 text-center">
      <p className="font-display text-lg font-semibold">
        This page didn&apos;t load
      </p>
      <p className="max-w-md text-sm text-muted-foreground">
        The rest of SYNQ is still working — your queue and playback are fine.
      </p>
      {/* The message is developer-facing and can be a long stack-ish string,
          so it is clamped rather than allowed to blow out the card. */}
      {message ? (
        <p className="max-w-md text-xs break-words text-muted-foreground/70">
          {message.length > 200 ? `${message.slice(0, 200)}…` : message}
        </p>
      ) : null}
      <button
        type="button"
        onClick={onRetry}
        className="rounded-full bg-[rgb(var(--tint))] px-5 py-2.5 text-sm font-semibold text-black"
      >
        Try again
      </button>
      <Link
        to="/home"
        className="text-xs text-muted-foreground underline-offset-4 hover:underline"
      >
        Back to Home
      </Link>
    </div>
  );
}

/** Suspense + error boundary for one route, as a single wrapper. */
function PageBoundary({ children }: { children: React.ReactNode }) {
  return (
    <RouteErrorBoundary>
      <PageSuspense>{children}</PageSuspense>
    </RouteErrorBoundary>
  );
}

/** Silent error boundary — if VlyToolbar crashes it renders nothing instead of
 *  crashing the whole app (e.g. hook errors in WebContainer environment). */
class ToolbarErrorBoundary extends React.Component<
  { children: React.ReactNode },
  { hasError: boolean }
> {
  state = { hasError: false };
  static getDerivedStateFromError() {
    return { hasError: true };
  }
  componentDidCatch(err: Error) {
    console.warn("[VlyToolbar] Caught error, toolbar disabled:", err.message);
  }
  render() {
    return this.state.hasError ? null : this.props.children;
  }
}

/** Hard guard so runtime errors never leave the preview as a blank page. */
class RootErrorBoundary extends React.Component<
  { children: React.ReactNode },
  { hasError: boolean; message: string; stack: string }
> {
  state = { hasError: false, message: "", stack: "" };
  static getDerivedStateFromError(error: Error) {
    return {
      hasError: true,
      message: error.message || "Unknown runtime error",
      stack: error.stack || "",
    };
  }
  componentDidCatch(err: Error) {
    console.error("[WebContainer preview] Root crash:", err);
  }
  render() {
    if (this.state.hasError) {
      return (
        <div className="min-h-dvh flex items-center justify-center bg-background text-foreground p-6 pt-[max(1.5rem,env(safe-area-inset-top))]">
          <div className="max-w-lg text-center">
            <p className="text-sm font-semibold">Preview runtime error</p>
            <p className="mt-2 text-xs text-muted-foreground break-words">
              {this.state.message}
            </p>
            {/* A boundary that only renders the error is a dead end: the app
                unmounted, so every in-app control is gone and the only escape
                was a manual browser reload. Offering the reload here, and
                re-mounting the tree when it is pressed, means one click gets
                the listener back instead of a keyboard shortcut they have to
                know about. */}
            <button
              type="button"
              onClick={() => window.location.reload()}
              className="mt-5 rounded-full bg-[rgb(var(--tint))] px-5 py-2.5 text-sm font-semibold text-black"
            >
              Reload SYNQ
            </button>
            {this.state.stack && (
              <pre className="mt-3 text-left text-[10px] leading-4 text-muted-foreground/80 max-h-40 overflow-auto rounded border border-border/60 p-2">
                {this.state.stack}
              </pre>
            )}
          </div>
        </div>
      );
    }
    return this.props.children;
  }
}

const convex = new ConvexReactClient(import.meta.env.VITE_CONVEX_URL as string);

/** Keeps \`html.perf-lite\` in sync with the store.
 *
 *  This lives at the app root rather than in AppShell because most of the
 *  expensive surfaces are on the public pages: the landing hero, the auth card
 *  and the support pages all render outside the signed-in shell, and a class
 *  only AppShell ever sets leaves every one of them running at full cost. */
function PerformanceModeSync() {
  const performanceMode = usePlayerStore((s) => s.performanceMode);
  const animationLevel = usePlayerStore((s) => s.animationLevel);
  useEffect(() => {
    document.documentElement.classList.toggle("perf-lite", performanceMode);
  }, [performanceMode]);
  // Keeps the motion level applied even if the store changes it somewhere that
  // does not go through `setAnimationLevel` (a future reset, a hydration). The
  // applier is idempotent, so running it here and from the setter is safe.
  useEffect(() => {
    applyAnimationLevel(animationLevel);
  }, [animationLevel]);
  return null;
}

/** Performance mode also has to reach the animations CSS cannot see.
 *
 *  framer-motion drives its animations from JavaScript, so `animation: none`
 *  does nothing to them — the hero, the queue panel and the sidebar would keep
 *  animating with every effect switched off. `reducedMotion: "always"` is the
 *  supported way to tell the library to stop moving things. */
function MotionPrefs({ children }: { children: React.ReactNode }) {
  const performanceMode = usePlayerStore((s) => s.performanceMode);
  const animationLevel = usePlayerStore((s) => s.animationLevel);
  // framer-motion animates from JavaScript, so the CSS rules cannot reach it.
  // `always` stops it outright (performance mode, or motion Off); `user` lets
  // the OS preference decide for the calmer Reduced level; `never` is full.
  const reducedMotion = performanceMode || animationLevel === "off"
    ? "always"
    : animationLevel === "reduced"
      ? "user"
      : "never";
  return (
    <MotionConfig reducedMotion={reducedMotion}>{children}</MotionConfig>
  );
}

function RouteSyncer() {
  const location = useLocation();
  useEffect(() => {
    window.parent.postMessage(
      { type: "iframe-route-change", path: location.pathname },
      "*",
    );
  }, [location.pathname]);

  useEffect(() => {
    function handleMessage(event: MessageEvent) {
      if (event.data?.type === "navigate") {
        if (event.data.direction === "back") window.history.back();
        if (event.data.direction === "forward") window.history.forward();
      }
    }
    window.addEventListener("message", handleMessage);
    return () => window.removeEventListener("message", handleMessage);
  }, []);

  return null;
}

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <RootErrorBoundary>
      <ToolbarErrorBoundary>
        <VlyToolbar />
      </ToolbarErrorBoundary>
      <ConvexAuthProvider client={convex}>
        <BrowserRouter>
          <RouteSyncer />
          <PerformanceModeSync />
          <ScrollToTop />
          <MotionPrefs>
            <Suspense fallback={<RouteLoading />}>
              <Routes>
                <Route
                  path="/auth"
                  element={<AuthPage redirectAfterAuth="/home" />}
                />
                <Route path="/t/:trackId" element={<TrackLink />} />
                <Route
                  path="/dashboard"
                  element={
                    <RequireAuth>
                      <Navigate to="/home" replace />
                    </RequireAuth>
                  }
                />
                {/*
                  DEFERRED AUTHENTICATION.
                  This shell is no longer behind a blanket `<RequireAuth>`.
                  A visitor can open /home, browse, search and explore artists
                  and albums without an account, and is asked to sign in at the
                  moment they do something that genuinely needs an identity —
                  playing a song, liking it, saving it to their library. That
                  is the flow every major music service uses, and it is the
                  only one where somebody understands the product before being
                  asked to create an account.

                  The genuinely PRIVATE routes further down (/liked, /playlists,
                  /playlist/:id, /stats, /recent, /social, /profile,
                  /settings, /admin) keep their own `<RequireAuth>` each. They
                  show a signed-in person's library and history; there is
                  nothing there for a stranger, and rendering them empty would
                  be worse than redirecting.

                  This is a UX change only. Every Convex mutation that needs an
                  identity still calls `getAuthUserId` and still throws without
                  one — the backend remains the authority, and the client-side
                  gate is a courtesy, not a security control.
                */}
                <Route element={<AppShell />}>
                  {/* "/" is the product itself. SYNQ is an app, not a
                      marketing site: the packaged Android build and the
                      installed PWA launch at "/", and what should greet
                      someone is the music experience, not a landing page (the
                      deferred-auth model already lets a signed-out visitor
                      browse /home). The marketing page stays in
                      src/pages/Landing.tsx for tests that assert its copy,
                      but nothing routes to it. */}
                  <Route
                    path="/"
                    element={
                      <PageBoundary>
                        <Home />
                      </PageBoundary>
                    }
                  />
                  <Route
                    path="/home"
                    element={
                      <PageBoundary>
                        <Home />
                      </PageBoundary>
                    }
                  />
                  <Route
                    path="/search"
                    element={
                      <PageBoundary>
                        <Search />
                      </PageBoundary>
                    }
                  />
                  <Route
                    path="/discover"
                    element={
                      <PageBoundary>
                        <Discover />
                      </PageBoundary>
                    }
                  />
                  <Route
                    path="/downloads"
                    element={
                      <PageBoundary>
                        <DownloadHub />
                      </PageBoundary>
                    }
                  />
                  <Route
                    path="/import"
                    element={
                      <PageBoundary>
                        <ImportHub />
                      </PageBoundary>
                    }
                  />
                  <Route
                    path="/artist/:artist"
                    element={
                      <PageBoundary>
                        <Artist />
                      </PageBoundary>
                    }
                  />
                  <Route
                    path="/album/:artist/:album"
                    element={
                      <PageBoundary>
                        <Album />
                      </PageBoundary>
                    }
                  />
                  <Route
                    path="/liked"
                    element={
                      <RequireAuth>
                        <PageBoundary>
                          <Liked />
                        </PageBoundary>
                      </RequireAuth>
                    }
                  />
                  <Route
                    path="/playlists"
                    element={
                      <RequireAuth>
                        <PageBoundary>
                          <Playlists />
                        </PageBoundary>
                      </RequireAuth>
                    }
                  />
                  <Route
                    path="/playlist/:id"
                    element={
                      <RequireAuth>
                        <PageBoundary>
                          <PlaylistDetail />
                        </PageBoundary>
                      </RequireAuth>
                    }
                  />
                  <Route
                    path="/stats"
                    element={
                      <RequireAuth>
                        <PageBoundary>
                          <Stats />
                        </PageBoundary>
                      </RequireAuth>
                    }
                  />
                  <Route
                    path="/recent"
                    element={
                      <RequireAuth>
                        <PageBoundary>
                          <Recent />
                        </PageBoundary>
                      </RequireAuth>
                    }
                  />
                  <Route
                    path="/recap"
                    element={
                      <RequireAuth>
                        <PageBoundary>
                          <Recap />
                        </PageBoundary>
                      </RequireAuth>
                    }
                  />
                  <Route
                    path="/social"
                    element={
                      <RequireAuth>
                        <PageBoundary>
                          <Social />
                        </PageBoundary>
                      </RequireAuth>
                    }
                  />
                  <Route
                    path="/profile"
                    element={
                      <RequireAuth>
                        <PageBoundary>
                          <Profile />
                        </PageBoundary>
                      </RequireAuth>
                    }
                  />
                  <Route
                    path="/settings"
                    element={
                      <RequireAuth>
                        <PageBoundary>
                          <Settings />
                        </PageBoundary>
                      </RequireAuth>
                    }
                  />
                  <Route
                    path="/admin"
                    element={
                      <RequireAuth>
                        <PageBoundary>
                          <Admin />
                        </PageBoundary>
                      </RequireAuth>
                    }
                  />
                </Route>
                <Route path="/support" element={<Support />} />
                <Route path="/privacy" element={<Privacy />} />
                <Route path="/terms" element={<Terms />} />
                <Route path="*" element={<NotFound />} />
              </Routes>
            </Suspense>
            {/* Deferred-auth bridge. Inside `ConvexAuthProvider` because it
                reads the session from it, and inside `BrowserRouter` because
                the prompt uses `useLocation` to return the visitor to the exact
                page they were on. It sits OUTSIDE `<Routes>` so it is not tied
                to any one route and survives navigation.

                It deliberately does NOT sit outside the router on the theory
                that an OAuth round-trip might unmount it. That reasoning was
                wrong: OAuth replaces the entire document, so no React position
                could survive it — the pending intent survives because it is
                JSON in `sessionStorage`, not because of where this component
                is mounted. */}
            <AuthGateProvider />
          </MotionPrefs>
        </BrowserRouter>
        <Toaster />
      </ConvexAuthProvider>
    </RootErrorBoundary>
  </StrictMode>,
);
