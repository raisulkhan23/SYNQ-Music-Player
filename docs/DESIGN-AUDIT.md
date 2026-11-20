# Design Audit — SYNQ (restoration/stash-features)

Audit performed against the rules in: `apple-design`, `impeccable`, `emil-design-eng`,
`animate`, `review-animations`, `improve-animations`, `find-animation-opportunities`,
`pick-ui-library`. (`find-skills` is a skill-discovery tool, not a design rule set.)

## Rules that PASSED (no change needed)

| Rule (skill) | Evidence |
| --- | --- |
| Motion tokens defined once and extended, not forked (impeccable/improve-animations) | `src/index.css`: `--ease-out`, `--ease-in-out`, `--ease-drawer`, `--duration-*`; `transition-ui` utility |
| Popovers/dropdowns/tooltips/menus scale from trigger (emil/apple) | Radix `origin-(--radix-*-transform-origin)` in `src/components/ui/*` |
| Entrances never `scale(0)`; start ≥ 0.95 + opacity (emil Never Ship) | `scale: 0.96/0.98` in `Landing.tsx`, `FullscreenPlayer.tsx` |
| No bare `ease-in` on UI (emil) | only `ease-in-out` for on-screen movement |
| Reduced motion honored globally (emil/apple) | `@media (prefers-reduced-motion: reduce)` in `index.css` + `matchMedia` checks |
| Hover motion gated (emil/apple) | `[@media(hover:hover)]` in `MixesRow.tsx` (pre-existing) |
| GPU-only properties: transform/opacity (emil) | `transition-ui` property set; no width/height/margin animated |
| `motion` ≥ 14.2 → hardware-accelerated shorthands (emil) | `motion ^14.3.0` |
| Radix primitives, not hand-rolled divs (pick-ui-library) | `src/components/ui/*` |
| Sonner toasts, zustand state, cmdk palette, recharts, input-otp (pick-ui-library) | present in `package.json` |

## Rules that FAILED and were FIXED

| Before | After | File | Rule (skill) |
| --- | --- | --- | --- |
| `transition-all` | `transition-ui` | `src/pages/Landing.tsx:174,622` | `transition: all` escalation (emil/impeccable) |
| `hover:-translate-y-1` ungated | `[@media(hover:hover)]:hover:-translate-y-1` | `src/pages/Landing.tsx:622` | hover gating (emil/apple) |
| `lg:hover:scale-[1.01]` ungated | `[@media(hover:hover)]:lg:hover:scale-[1.01]` | `src/components/player/PlayerBar.tsx:705` | hover gating (emil/apple) |
| sheet `ease-in-out` + duration 300/500 | `ease-drawer` + duration 200/300 | `src/components/ui/sheet.tsx:59` | drawer curve + sub-300/500 budget (emil) |
| (missing) `ease-drawer` utility | added `@utility ease-drawer` | `src/index.css` | extend tokens, not fork (emil) |

## Not applied (out of scope / not applicable)

- apple-design gesture rules (1:1 tracking, rubber-banding, momentum projection): no gesture-driven draggable surfaces in scope.
- apple-design materials/translucency and typography optical sizing: existing liquid-glass + type system left untouched.
- find-animation-opportunities: corrective-only pass; no additive motion suggestions implemented.

## Verification

- `bun test --path-ignore-patterns='**/isolate/**'` → **1971 pass, 0 fail** across 113 files.
- `npx tsc -b` → clean.
- `npx vite build` → succeeds.
- `npx eslint` on changed files → only pre-existing warnings.

The 3 failures seen in a plain `bun test` run originate in gitignored `isolate/` stale build copies
(`deferred-auth`, `desktop-app`, `navigation-scroll` tests referencing missing files), not in the project's
own `tests/` suite, and are unrelated to these design changes.
