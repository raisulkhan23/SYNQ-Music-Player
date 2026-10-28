import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";

import { useAuth } from "@/hooks/use-auth";
import { track } from "@/lib/analytics";
import { Logo } from "@/components/brand/Logo";
import { AuthForm } from "@/components/auth/AuthForm";
import { Loader2 } from "lucide-react";
import { Suspense, useEffect } from "react";
import { useNavigate, useSearchParams } from "react-router";

interface AuthProps {
  redirectAfterAuth?: string;
}

function resolveRedirectAfterAuth(
  returnTo: string | null,
  fallback = "/dashboard",
) {
  if (returnTo?.startsWith("/") && !returnTo.startsWith("//")) {
    return returnTo;
  }
  return fallback;
}

/**
 * The standalone sign-in page.
 *
 * This is now a thin shell around `<AuthForm>` — the same component the
 * deferred-auth prompt uses. It used to own the provider buttons and the
 * email/OTP flow itself, which meant the dialog either had to duplicate them
 * (and drift) or offer a different set of providers than the page did.
 */
function Auth({ redirectAfterAuth }: AuthProps = {}) {
  const { isLoading: authLoading, isAuthenticated } = useAuth();
  const navigate = useNavigate();
  const [searchParams] = useSearchParams();
  const redirect = resolveRedirectAfterAuth(
    searchParams.get("returnTo"),
    redirectAfterAuth,
  );

  useEffect(() => {
    if (!authLoading && isAuthenticated) {
      track("user_signed_in", { method: "email-otp" });
      navigate(redirect, { replace: true });
    }
  }, [authLoading, isAuthenticated, navigate, redirect]);

  // Already signed in on this device (or auth state still resolving): never
  // flash the sign-in card. Show a minimal loading screen instead — the
  // effect above redirects to the app as soon as we know the session state.
  if (authLoading || isAuthenticated) {
    return (
      <div className="flex min-h-dvh items-center justify-center bg-background px-[max(1rem,env(safe-area-inset-left))] pt-[env(safe-area-inset-top)] pb-[env(safe-area-inset-bottom)] text-foreground">
        <Loader2 className="size-6 animate-spin text-muted-foreground" />
      </div>
    );
  }

  return (
    <div className="relative flex min-h-dvh flex-col overflow-hidden bg-background pt-[env(safe-area-inset-top)] text-foreground">
      <div className="pointer-events-none absolute inset-x-0 top-0 h-[520px]">
        <div className="absolute left-1/2 top-[-200px] h-[480px] w-[760px] -translate-x-1/2 rounded-full bg-brand/12 blur-3xl" />
        <div className="absolute right-[-120px] bottom-[-60px] h-[320px] w-[320px] rounded-full bg-violet-500/10 blur-3xl" />
      </div>

      <div className="relative flex flex-1 items-center justify-center">
        <div className="flex h-full flex-col items-center justify-center">
          <Card className="min-w-[350px] border-white/10 bg-white/[0.04] pb-0 shadow-[0_30px_80px_rgba(0,0,0,0.5)] backdrop-blur-2xl">
            <CardHeader className="text-center">
              <div className="mb-4 mt-4 flex justify-center">
                <Logo to="/" className="text-lg" />
              </div>
              <CardTitle className="font-display text-xl">
                Sign in or sign up
              </CardTitle>
              <CardDescription>
                Enter your email and we&apos;ll send you a one-time code
              </CardDescription>
            </CardHeader>
            <CardContent className="px-0">
              {/* Absolute URL on purpose — see `AuthForm`'s `redirectTo`
                  docs. A relative path made the server pick a hard-coded
                  production origin, so GitHub could authenticate and then
                  land the listener on the wrong site. */}
              <AuthForm
                redirectTo={`${window.location.origin}${redirect}`}
                onSuccess={() => navigate(redirect, { replace: true })}
              />
            </CardContent>
            <div className="border-t border-white/[0.07] bg-white/[0.02] px-6 py-4 text-center text-xs text-muted-foreground rounded-b-lg">
              Secured by{" "}
              <a
                href="https://freebuff.com"
                target="_blank"
                rel="noopener noreferrer"
                className="underline hover:text-primary transition-colors"
              >
                freebuff.com
              </a>
            </div>
          </Card>
        </div>
      </div>
    </div>
  );
}

export default function AuthPage(props: AuthProps) {
  return (
    <Suspense>
      <Auth {...props} />
    </Suspense>
  );
}
