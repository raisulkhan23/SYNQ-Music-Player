import { api } from "@/convex/_generated/api";
import { useAuthActions } from "@convex-dev/auth/react";
import { useConvexAuth, useQuery } from "convex/react";

export function useAuth() {
  const { isLoading: isAuthLoading, isAuthenticated } = useConvexAuth();
  const user = useQuery(api.users.currentUser);
  const { signIn, signOut } = useAuthActions();

  // Authentication readiness must depend only on the auth session. Waiting
  // for the optional profile query here used to leave the sign-in page stuck
  // on its loading screen whenever that query was slow or unavailable, which
  // made it look like login itself was broken.
  const isLoading = isAuthLoading;

  return {
    isLoading,
    isAuthenticated,
    user,
    signIn,
    signOut,
  };
}
