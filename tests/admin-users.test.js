import { describe, expect, test } from "bun:test";
import { readSource } from "./helpers/tailwind-css.js";

const admin = readSource("src/pages/Admin.tsx");
const adminConvex = readSource("src/convex/admin.ts");

/** The listUsers query, which is what the accounts table is built from. */
function fn(name) {
  const start = adminConvex.indexOf(`export const ${name} = query({`);
  if (start === -1) throw new Error(`missing ${name}`);
  const end = adminConvex.indexOf("\n});", start);
  return adminConvex.slice(start, end === -1 ? undefined : end);
}

describe("sign-in methods are read from the real auth columns", () => {
  test("listUsers reads provider / providerAccountId, not a token identifier", () => {
    // `authAccounts` has no `tokenIdentifier` column. Reading one made every
    // account fall through to a bogus "credentials" provider, so every method
    // count read 0 and no method filter ever matched a row.
    const listUsers = fn("listUsers");
    expect(listUsers).toMatch(/acc\.provider/);
    expect(listUsers).toMatch(/acc\.providerAccountId/);
    expect(listUsers).not.toMatch(/tokenIdentifier/);
  });

  test("the GitHub badge id comes from the github account row", () => {
    const listUsers = fn("listUsers");
    expect(listUsers.replace(/\s+/g, " ")).toMatch(
      /find\(\(a\) => a\.provider === "github"\) \?\.accountId \?\? null/,
    );
  });

  test("provider ids are normalized to the ids the filter offers", () => {
    // The built-in email provider is registered as "email" or "email-otp"
    // depending on config, and OAuth ids are capitalised by some setups.
    const start = adminConvex.indexOf("function normalizeAuthProvider(");
    expect(start).toBeGreaterThan(-1);
    const body = adminConvex.slice(start, start + 900);
    expect(body).toMatch(/\.trim\(\)\.toLowerCase\(\)/);
    for (const [probe, slug] of [
      ["github", "github"],
      ["google", "google"],
      ["anonymous", "anonymous"],
      ["email-otp", "email-otp"],
    ]) {
      expect(body).toContain(`"${probe}"`);
      expect(body).toContain(`return "${slug}"`);
    }
  });
});

describe("the accounts table can be narrowed by sign-in method", () => {
  test("the backend already reports each account's providers and GitHub id", () => {
    // The filter has nothing to work with without these two fields.
    const listUsers = fn("listUsers");
    expect(listUsers).toMatch(/providers:/);
    expect(listUsers).toMatch(/githubId:/);
  });

  test("GitHub is one of the offered methods", () => {
    expect(admin).toMatch(/id: "github", label: "GitHub"/);
  });

  test("the filter matches on the provider list, not on the role", () => {
    // Role and sign-in method are independent: a GitHub user can be a standard
    // user, and an admin can have signed in with Google.
    expect(admin).toMatch(/userMatchesMethod\(u\.providers, userMethod\)/);
    expect(admin).toMatch(/list\.includes\(method\)/);
    expect(admin).toMatch(
      /\[users, userQuery, userRole, userMethod, userSort\]/,
    );
  });

  test("'Any sign-in' shows every account instead of filtering", () => {
    // The complaint this fixes: the default option looked like it dropped
    // rows, and its label carried no number to compare against.
    expect(admin).toMatch(/if \(method === "all"\) return true;/);
    expect(admin).toMatch(/Any sign-in \(\{methodCounts\.all \?\? 0\}\)/);
    expect(admin).toMatch(/counts\.all \+= 1;/);
  });

  test("the method dropdown is labelled and offers every method plus 'any'", () => {
    expect(admin).toMatch(/aria-label="Filter by sign-in method"/);
    expect(admin).toMatch(/SIGN_IN_METHODS\.map\(\(method\)/);
  });

  test("each option carries the number of accounts using it", () => {
    // Without a count the admin cannot tell an empty filter from a broken one.
    expect(admin).toMatch(
      /\{method\.label\} \(\{methodCounts\[method\.id\] \?\? 0\}\)/,
    );
    expect(admin).toMatch(/counts\[p\] = \(counts\[p\] \?\? 0\) \+ 1;/);
  });

  test("an account with two credentials for one method is counted once", () => {
    // `providers` holds one entry per linked auth account. Counting the raw
    // array made the label promise more rows than the filter can ever return.
    expect(admin).toMatch(/const unique = new Set\(u\.providers \?\? \[\]\)/);
    expect(admin).toMatch(/for \(const p of unique\)/);
  });

  test("a provider the named methods don't cover is still reachable", () => {
    // Anything unrecognised used to have no badge, no count and no way to
    // filter, which made accounts quietly disappear from the table.
    expect(admin).toMatch(/list\.some\(\(p\) => !\w+\.has\(p\)\)/);
    expect(admin).toMatch(/value=\{OTHER_SIGN_IN_METHOD\}/);
    expect(admin).toMatch(/counts\.other|OTHER_SIGN_IN_METHOD\]\s*\+=/);
  });

  test("every provider the deployment configures is offered", () => {
    // auth.ts configures emailOtp + Google + GitHub, and those are the only
    // sign-in methods that can produce an authAccounts row here.
    const auth = readSource("src/convex/auth.ts");
    for (const provider of ["emailOtp", "Google", "GitHub"]) {
      expect(auth).toMatch(new RegExp(`\\b${provider}\\b`));
    }
    for (const id of ["github", "google", "email-otp"]) {
      expect(admin).toMatch(new RegExp(`id: "${id}"`));
    }
  });
});

describe("a GitHub account can be looked up by its external id", () => {
  test("the search box matches the GitHub id as well as name and email", () => {
    // The row badge shows the GitHub id, so searching for it has to work.
    expect(admin).toMatch(
      /const github = \(u\.githubId \?\? ""\)\.toLowerCase\(\);/,
    );
    expect(admin).toMatch(/github\.includes\(q\)/);
  });

  test("the placeholder says the GitHub id is searchable", () => {
    expect(admin).toMatch(/placeholder="Search name, email or GitHub id…"/);
  });
});
