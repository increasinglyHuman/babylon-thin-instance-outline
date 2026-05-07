# ADR-001 — Repo Charter & Scope

**Status:** 🟢 Accepted (foundational)
**Date:** 2026-05-07
**Author:** Allen Partridge + Claude

---

## 1. Context

This repository was extracted from [poqpoq-world](https://github.com/increasinglyHuman/poqpoq-world)'s ADR-120 linkset selection substrate work, where OAR-imported linksets needed per-thin-instance member highlighting. Babylon.js doesn't natively support per-thin-instance outline rendering — the public `EdgesRenderer` is per-host. The poqpoq-world repo's v0 implementation (`ThinInstanceHighlighter`) used per-instance color buffer tinting as a workaround, which is multiplicative against existing material albedo and often visually invisible on real content.

The cleaner long-term answer is the **inverted-hull outline** technique — well-known in 3D rendering, suitable for a focused reusable library, and likely valuable to the broader Babylon community.

This ADR establishes the repo's charter so future contributions don't drift scope.

## 2. Decision

### 2.1 Single responsibility

This repository implements **per-thin-instance outline rendering for Babylon.js**, and nothing else.

What's in scope:
- The inverted-hull outline technique (per-instance show/hide via mirrored matrix buffer, scaled outline mesh, back-face rendering)
- The public `ThinInstanceOutliner` class with attach/highlight/clear/detach lifecycle
- Color + thickness + show/hide primitives
- Demo HTML page proving WebGL-correctness
- Documentation: this ADR set + README + per-method JSDoc

What's NOT in scope:
- General per-instance highlighting (color tints, glow, etc.) — that's a different lib; users can write their own using the thin-instance color buffer
- Per-mesh outline (Babylon's `EdgesRenderer` already covers that)
- Thin-instance helpers unrelated to outline (frustum culling helpers, picking utilities, instance pooling, etc.) — sibling repos
- Skeletal/animated outline — v2+ scope; explicit feature flag if/when added
- Non-Babylon outline (Three.js, raw WebGL, etc.) — different engine, different repo
- Custom shader pipeline beyond the minimal outline shader — keep it minimal

### 2.2 Why a separate repo

- **Babylon-source agnostic.** The library uses only public Babylon APIs. No patches to Babylon source. No `node_modules` mutations. Survives Babylon upgrades.
- **Community-reusable.** Other projects hitting this same gap (lots of stylized Babylon games, editor tools, asset preview) get drop-in support without touching their main app.
- **Single-responsibility cleanliness.** Mixing this lib's concerns with poqpoq-world's domain-specific linkset handling produces tangled code; separation lets each repo have a focused mental model.
- **Different versioning cadence.** This lib stabilizes around the outline technique; poqpoq-world iterates daily. Decoupled releases.

### 2.3 Born-from relationship to poqpoq-world

poqpoq-world is the originating consumer. The lib's v1 API surface is shaped by what poqpoq-world's `ThinInstanceHighlighter` integration needs (bound to ADR-120). Future library evolution accepts other consumers' needs but treats poqpoq-world's use case as the regression suite — the demo HTML page mimics that scenario.

## 3. Constraints

- **Babylon as peer dependency**, not bundled. Range: `>=8.0.0 <9.0.0` to start; widen as Babylon API stability proves out.
- **Zero runtime dependencies beyond Babylon.** No utility libraries, no helper packages.
- **TypeScript-first.** Source in TS; ship `.d.ts` + transpiled JS via `tsc`.
- **Tested without WebGL.** Unit tests mock the thin-instance API surface. Visual correctness verified via demo page, not unit tests.

## 4. Non-goals (explicit)

- Don't grow into a "thin-instance utilities kitchen sink" library.
- Don't take ownership of poqpoq-world's domain-specific linkset semantics — those belong in poqpoq-world.
- Don't fork or patch Babylon. If the technique requires patches, the technique is wrong for this lib; revisit ADR-002.
- Don't ship pre-bundled UMD/IIFE artifacts in v1; ESM only. Bundling is the consumer's job.

## 5. Naming

- Repo: `babylon-thin-instance-outline`
- npm package: `@p0qp0q/babylon-thin-instance-outline`
- GitHub: under [@increasinglyHuman](https://github.com/increasinglyHuman)
- License: TBD; likely MIT to maximize community use

## 6. Success criteria

v1 ships when:
- Demo HTML page on Babylon 8.x renders a 100-instance scene with 3 outlined instances cleanly.
- Public API matches the surface specified in ADR-003.
- README + ADR set explain the technique well enough for a contributor (or future Allen, or future Claude) to extend it without re-deriving.
- npm publish target is configured.

## 7. References

- Originating gap: [poqpoq-world ADR-120 §3.2 Phase 2](https://github.com/increasinglyHuman/poqpoq-world/blob/main/docs/adr/ADR-120-Linkset-Lifecycle-And-Edit-Routing.md)
- Originating attempt: poqpoq-world's `src/world/ThinInstanceHighlighter.ts` (v0 tint approach)
- Pattern reference: [poqpoq-IK-Solver](https://github.com/increasinglyHuman/p0qp0q-IK-Solver) — sibling Allen library using the same focused-repo pattern.
