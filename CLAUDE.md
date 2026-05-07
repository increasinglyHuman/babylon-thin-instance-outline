# Project Context for Claude Instances Working on This Repo

## What this is

`babylon-thin-instance-outline` is a focused Babylon.js library that adds per-instance outline rendering to thin-instance hosts. Born from poqpoq-world's ADR-120 linkset substrate work; extracted to its own repo for community reuse and architectural cleanliness.

**Single responsibility.** This repo does ONE thing: per-thin-instance outline. Don't grow scope into other thin-instance utilities, other Babylon helpers, or other rendering effects. Sibling concerns get sibling repos (matching Allen's pattern with poqpoq-IK-Solver and its sister utilities).

## Why this exists (the Babylon gap)

Babylon's `EdgesRenderer` is per-mesh, not per-thin-instance. There's no public API to outline a single thin-instance entry without lighting up every other instance on the host. This library closes that gap using the **inverted-hull** rendering technique — a parallel outline mesh, slightly scaled, back-face rendered, composed via depth ordering.

See `docs/adr/ADR-002-Inverted-Hull-Outline-Technique.md` for the full technique spec + why we picked it over alternatives (shader patches, Babylon source forks, post-processing passes).

## Coding standards

- **TypeScript strict.** All public APIs typed. No `any` in published code.
- **Babylon as peer dependency**, not bundled. Lib targets Babylon 8.x.
- **No transitive deps if avoidable.** This is a small focused lib; pulling in helpers from large packages defeats the point. Use Babylon's built-in math (Vector3, Matrix, Color3) directly.
- **Tests don't require WebGL.** Use vitest with mocked thin-instance API surface (the technique used in poqpoq-world's `LinksetResolver.test.ts` and `ThinInstanceHighlighter.test.ts`). Visual correctness is verified via the demo HTML page, not unit tests.
- **Demo page is part of CI.** `demo/index.html` should always work — it's the smoke test for "did the lib regress on real WebGL."
- **Comments document non-obvious choices.** Specifically the matrix-scale-to-zero idiom for show/hide and the depth bias config for the outline mesh.

## Architecture rules (the dark-code prevention)

- **Public API is exhaustively in `src/index.ts`.** What's exported there is the contract; nothing else is. Internal helpers live in private modules and don't get re-exported.
- **The outline mesh is a parallel sibling of the host, NEVER a child.** Children get parent-cascade transforms; the outline mesh needs an independent matrix buffer mirroring the host's. Parenting would couple their transforms in ways that break the per-instance show/hide trick.
- **Don't reach into Babylon internals** (`mesh._thinInstanceDataStorage`, `material._uniformBuffer`, etc.). If the public API doesn't expose what you need, the technique design is wrong; revisit ADR-002.
- **No global state.** Outliner instances are scene-scoped. Multiple scenes = multiple outliners.

## Publishing target

`@p0qp0q/babylon-thin-instance-outline` on npm. Versioning: standard semver. v0 is unpublished scaffold; v1 ships when the demo HTML page works on a Babylon 8.x scene with at least 3 simultaneous outlined instances on a 100-instance host.

## Repo layout

```
src/                     # TypeScript source
  index.ts               # public API barrel
  ThinInstanceOutliner.ts  # main class
  outlineShader.ts       # vertex/fragment GLSL strings for inverted hull
  matrixHelpers.ts       # zero-scale matrix utility, etc.

tests/                   # vitest, no WebGL
  ThinInstanceOutliner.test.ts
  matrixHelpers.test.ts

demo/                    # standalone HTML + Babylon CDN
  index.html             # 100-instance scene with 3 outlined; click to toggle

docs/adr/                # architecture decisions
  ADR-001-Repo-Charter-And-Scope.md
  ADR-002-Inverted-Hull-Outline-Technique.md
  ADR-003-API-Surface-And-Lifecycle.md

package.json             # npm-ready
tsconfig.json
.gitignore
README.md                # public-facing
CLAUDE.md                # this file
```

## Dark-code prevention (ecosystem standard)

This repo follows the BBWorlds / poqpoq ecosystem standard for fighting **dark code** — code that runs but no one (human or AI) fully understands. The full umbrella doc lives at `~/blackbox/World/docs/infra/HUMAN_AI_CODEBASE_STANDARDS.md`. The principles distilled for this repo:

1. **Spec before code.** ADRs in `docs/adr/` are the spec. Don't write a non-trivial feature without an ADR (or an amendment to one). The ADR becomes the eval — tests assert what the ADR promises.
2. **Self-describing files.** Every `src/*.ts` opens with a 2–3 line header: what it does, what it depends on, what depends on it. No generic `utils.ts`-style names.
3. **Semantic comments only on non-obvious code.** Skip `// increment counter`. DO comment the matrix-scale-to-zero idiom, the depth-bias rationale, and any place we deliberately diverge from a Babylon idiom — those are load-bearing decisions that future readers (Allen, Claude, community) need.
4. **Comprehension gates at PR review.** Before merging, the reviewer (human or AI) should be able to answer: what behavior changed, why, what could break, is the spec (ADR/README) updated, can a stranger read the diff and understand it.
5. **AI as co-author, not autonomous author.** `Co-Authored-By: Claude` in commits is a declaration that the human co-author understood what was committed. If Claude can't explain a generated block, don't commit it.

Applied to community contributions: PRs should reference an ADR or propose one. "Make tests pass" is not enough — the change must be comprehensible.

## When in doubt

- Read the ADRs in `docs/adr/`.
- Refer back to poqpoq-world's `src/world/ThinInstanceHighlighter.ts` for the v0 tint-based approach this lib supersedes.
- Don't grow scope. The single-responsibility constraint IS the architecture.

## Allen's working preferences

- Trusts mechanical execution once authorized; surface design decisions, not deploy steps.
- Prefers ADR-driven development for non-trivial technical choices.
- Prefers terse responses; long technical writeups go in ADR docs, not in chat.
- Open to community contribution; design with the npm publish path in mind.
