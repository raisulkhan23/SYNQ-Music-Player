import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  InputOTP,
  InputOTPGroup,
  InputOTPSlot,
} from "@/components/ui/input-otp";
import { useAuth } from "@/hooks/use-auth";
import { ArrowRight, Loader2, Mail } from "lucide-react";
import { useState } from "react";

/**
 * The sign-in surface, extracted from `src/pages/Auth.tsx`.
 *
 * ## Why this component exists
 *
 * Deferred authentication needs the SAME sign-in UI inside a dialog that the
 * standalone `/auth` page uses. Duplicating those provider buttons and the
 * email/OTP flow would guarantee they drift apart — and the failure would be
 * silent and ugly: the page would grow a provider the dialog never had, or a
 * guest would be offered a sign-in method that does not work.
 *
 * So this is a straight extraction, not a rewrite. `Auth.tsx` renders it for
 * the full-page flow and the prompt renders it in a dialog. One
 * implementation, one set of providers, one place to change either.
 *
 * The only behavioural difference between the two callers is where success
 * goes, and that is a prop: the page navigates to `returnTo`, the dialog lets
 * its bridge finish whatever the visitor was trying to do.
 */

function GoogleIcon({ className }: { className?: string }) {
  return (
    <svg className={className} viewBox="0 0 24 24" aria-hidden="true">
      <path
        fill="#4285F4"
        d="M22.56 12.25c0-.78-.07-1.53-.2-2.25H12v4.26h5.92a5.06 5.06 0 0 1-2.2 3.32v2.77h3.57c2.08-1.92 3.27-4.74 3.27-8.1z"
      />
      <path
        fill="#34A853"
        d="M12 23c2.97 0 5.46-.98 7.28-2.66l-3.57-2.77c-.98.66-2.23 1.06-3.71 1.06-2.86 0-5.29-1.93-6.16-4.53H2.18v2.84A11 11 0 0 0 12 23z"
      />
      <path
        fill="#FBBC05"
        d="M5.84 14.1a6.6 6.6 0 0 1 0-4.2V7.06H2.18a11 11 0 0 0 0 9.88l3.66-2.84z"
      />
      <path
        fill="#EA4334"
        d="M12 5.38c1.62 0 3.06.56 4.21 1.64l3.15-3.15A11 11 0 0 0 2.18 7.06l3.66 2.84c.87-2.6 3.3-4.52 6.16-4.52z"
      />
    </svg>
  );
}

function GithubIcon({ className }: { className?: string }) {
  return (
    <svg
      className={className}
      viewBox="0 0 24 24"
      fill="currentColor"
      aria-hidden="true"
    >
      <path d="M12 .5C5.65.5.5 5.65.5 12c0 5.08 3.29 9.39 7.86 10.91.58.11.79-.25.79-.55v-2.17c-3.2.7-3.87-1.36-3.87-1.36-.52-1.33-1.28-1.69-1.28-1.69-1.04-.71.08-.7.08-.7 1.15.08 1.76 1.19 1.76 1.19 1.03 1.76 2.7 1.25 3.36.96.1-.75.4-1.25.72-1.54-2.55-.29-5.23-1.28-5.23-5.68 0-1.26.45-2.28 1.19-3.09-.12-.29-.52-1.46.11-3.05 0 0 .97-.31 3.18 1.18a11 11 0 0 1 5.79 0c2.2-1.49 3.17-1.18 3.17-1.18.63 1.59.23 2.76.12 3.05.74.81 1.18 1.83 1.18 3.09 0 4.41-2.69 5.38-5.25 5.67.41.36.78 1.06.78 2.14v3.17c0 .3.21.67.8.55A11.5 11.5 0 0 0 23.5 12C23.5 5.65 18.35.5 12 .5z" />
    </svg>
  );
}

export interface AuthFormProps {
  /**
   * Where the user should end up after a successful sign-in.
   *
   * MUST be an absolute origin-relative URL. Passing a bare path made the
   * server pick one hard-coded production origin, so GitHub could
   * authenticate successfully and then land the listener on the wrong site.
   */
  redirectTo: string;
  /** Called after a successful sign-in that did NOT navigate (the OTP path). */
  onSuccess?: () => void;
  /** Hide the email field, offering OAuth only. Used where space is tight. */
  compact?: boolean;
}

export function AuthForm({
  redirectTo,
  onSuccess,
  compact = false,
}: AuthFormProps) {
  const { signIn } = useAuth();
  const [step, setStep] = useState<"signIn" | { email: string }>("signIn");
  const [otp, setOtp] = useState("");
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const handleOAuth = async (provider: "google" | "github") => {
    setIsLoading(true);
    setError(null);
    try {
      // Send OAuth back to the origin the user is actually using.
      await signIn(provider, { redirectTo });
    } catch (err) {
      console.error(`${provider} sign-in error:`, err);
      setError(
        err instanceof Error
          ? err.message
          : `Failed to start ${provider} sign-in. Please try again.`,
      );
      setIsLoading(false);
    }
  };

  const handleEmailSubmit = async (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    setIsLoading(true);
    setError(null);
    try {
      const formData = new FormData(event.currentTarget);
      await signIn("email-otp", formData);
      setStep({ email: formData.get("email") as string });
    } catch (err) {
      console.error("Email sign-in error:", err);
      setError(
        err instanceof Error
          ? err.message
          : "Failed to send verification code. Please try again.",
      );
    } finally {
      setIsLoading(false);
    }
  };

  const handleOtpSubmit = async (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    setIsLoading(true);
    setError(null);
    try {
      const formData = new FormData(event.currentTarget);
      await signIn("email-otp", formData);
      // The OTP path never leaves the page, so the caller decides what
      // happens next — navigate, or resume the interrupted action.
      onSuccess?.();
    } catch (err) {
      console.error("OTP verification error:", err);
      setError("The verification code you entered is incorrect.");
      setOtp("");
    } finally {
      setIsLoading(false);
    }
  };

  if (step !== "signIn") {
    return (
      <form onSubmit={handleOtpSubmit}>
        <div className="space-y-4 px-6 pb-6">
          <div className="text-center">
            <p className="font-display text-lg font-semibold">
              Check your email
            </p>
            <p className="text-sm text-muted-foreground">
              We&apos;ve sent a code to {step.email}
            </p>
          </div>
          <input type="hidden" name="email" value={step.email} />
          <input type="hidden" name="code" value={otp} />
          <div className="flex justify-center">
            <InputOTP
              value={otp}
              onChange={setOtp}
              maxLength={6}
              disabled={isLoading}
              onKeyDown={(e) => {
                if (e.key === "Enter" && otp.length === 6 && !isLoading) {
                  const form = (e.target as HTMLElement).closest("form");
                  form?.requestSubmit();
                }
              }}
            >
              <InputOTPGroup>
                {Array.from({ length: 6 }).map((_, index) => (
                  <InputOTPSlot key={index} index={index} />
                ))}
              </InputOTPGroup>
            </InputOTP>
          </div>
          {error && <p className="text-center text-sm text-red-500">{error}</p>}
          <Button
            type="submit"
            className="w-full"
            disabled={isLoading || otp.length !== 6}
          >
            {isLoading ? (
              <>
                <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                Verifying...
              </>
            ) : (
              <>
                Verify code
                <ArrowRight className="ml-2 h-4 w-4" />
              </>
            )}
          </Button>
          <Button
            type="button"
            variant="ghost"
            onClick={() => setStep("signIn")}
            disabled={isLoading}
            className="w-full"
          >
            Use different email
          </Button>
        </div>
      </form>
    );
  }

  return (
    <div className="space-y-4 px-6 pb-6">
      {!compact && (
        <form onSubmit={handleEmailSubmit}>
          <div className="flex items-center gap-2">
            <div className="relative flex-1">
              <Mail className="absolute left-3 top-3 h-4 w-4 text-muted-foreground" />
              <Input
                name="email"
                placeholder="name@example.com"
                type="email"
                className="pl-9"
                disabled={isLoading}
                required
              />
            </div>
            <Button
              type="submit"
              variant="outline"
              size="icon"
              disabled={isLoading}
            >
              {isLoading ? (
                <Loader2 className="h-4 w-4 animate-spin" />
              ) : (
                <ArrowRight className="h-4 w-4" />
              )}
            </Button>
          </div>
        </form>
      )}
      {error && <p className="text-sm text-red-500">{error}</p>}

      <div className="grid grid-cols-2 gap-2">
        <Button
          type="button"
          variant="outline"
          onClick={() => void handleOAuth("google")}
          disabled={isLoading}
        >
          <GoogleIcon className="mr-2 h-4 w-4" />
          Google
        </Button>
        <Button
          type="button"
          variant="outline"
          onClick={() => void handleOAuth("github")}
          disabled={isLoading}
        >
          <GithubIcon className="mr-2 h-4 w-4" />
          GitHub
        </Button>
      </div>
    </div>
  );
}
