# ADR-006 — Matrix Source of Truth

**Status:** ✅ Accepted
**Date:** 2026-07-16
**Author:** Allen Partridge + Claude
**Depends on:** ADR-002 (inverted-hull technique), ADR-003 (API surface & lifecycle)
**Amends:** ADR-003 §2.2 (`attach` post-conditions — the host is no longer written to), §2.4 (`refresh` contract)
**Credit:** [@labris (Andrei Stepanov)](https://forum.babylonjs.com/u/labris/summary) prompted this investigation on the Babylon.js forum, 2026-07-15, by proposing that the app register its matrix array. The bug below was found while evaluating that proposal. The proposal itself was **not adopted** — see §4.1 — but it is the reason we looked.
**Issue:** #4

---

## 1. Context

### 1.1 The bug

`refresh()` and `highlight()` read the host's source matrices through Babylon's public
`Mesh.thinInstanceGetWorldMatrices()`. That method is **memoised**:

```js
// @babylonjs/core 8.56.2 — Meshes/thinInstanceMesh.js
Mesh.prototype.thinInstanceGetWorldMatrices = function () {
    if (!this._thinInstanceDataStorage.worldMatrices) {          // built once...
        this._thinInstanceDataStorage.worldMatrices = [];
        for (let i = 0; i < instancesCount; ++i) {
            worldMatrices[i] = Matrix.FromArray(matrixData, i * 16);
        }
    }
    return this._thinInstanceDataStorage.worldMatrices;           // ...returned forever
};
```

The cache is nulled at **exactly one site** in the entire file — inside `thinInstanceSetBuffer`.
Critically, `thinInstanceBufferUpdated('matrix')` does **not** invalidate it; it only pushes
`matrixData` to the GPU.

This broke the contract `refresh()` advertises — *"call this after the consumer has updated the
host's matrix buffer so the outline tracks the new position."* Outlines silently froze at their
attach-time positions while the host rendered in the new place.

### 1.2 It has two triggers, not one

Both are ordinary, and both were reproduced on `NullEngine` (Babylon 8.56.2):

**Trigger A — direct buffer writes.** The standard bulk path: mutate your own `Float32Array`, then
`thinInstanceBufferUpdated('matrix')`. The cache never hears about it.

```
raw buffer says instance 1 x = 999
thinInstanceGetWorldMatrices says x = 10       <-- STALE
```

**Trigger B — a reused scratch Matrix.** `thinInstanceSetMatrixAt` syncs the cache by storing the
caller's Matrix **by reference** (`worldMatrices[index] = matrix`, no clone). Reusing one Matrix
across a loop — a standard allocation-avoidance pattern — makes every cached slot alias the same
object:

```
cache says x =          : [ 20, 20, 20 ]      <-- all three alias one object
raw matrixData says x = : [ 0, 10, 20 ]       <-- ground truth
```

Trigger B is the sharper one: it means the cache is unreliable **even on the `setMatrixAt` path**,
which the first draft of this ADR had assumed was always safe.

### 1.3 Why it survived to v1.3

poqpoq-world's linkset substrate moves instances via `thinInstanceSetMatrixAt()` with fresh Matrix
objects — the one combination where both triggers miss. Our only production consumer sat on the
single safe path.

**It was not a testing-charter problem.** `tests/ThinInstanceOutliner.test.ts` has used `NullEngine`
with real `Mesh`/`Scene` objects since v1, and its header says so. The §1.2 repro runs on the
existing infrastructure in milliseconds. Nothing prevented catching this: **we tested the path we
call ourselves and never the path we documented for consumers.** That is a coverage gap, and no
policy change fixes it. (CLAUDE.md is nonetheless stale here — it describes "vitest with mocked
thin-instance API surface," a mocking approach the tests abandoned. Worth correcting so nobody
infers a prohibition that isn't there.)

### 1.4 Two adjacent problems, same root

- **Allocation.** `thinInstanceGetWorldMatrices()` builds one `Matrix` **per instance** on first
  call. `highlight(host, 5)` on a 100k host allocated 100k `Matrix` objects to read one.
- **Purity.** `attach()` reached into `host._thinInstanceDataStorage.matrixData` for a WebGPU
  re-bind guard, because there is no public getter for the raw matrix buffer.

## 2. Decision

### 2.1 Read ground truth, in one quarantined module

`_thinInstanceDataStorage.matrixData` is the array Babylon uploads to the GPU. It is ground truth
**by construction**: immune to both triggers, and always current across buffer growth. We read it.

All internal access lives in **`src/hostMatrixSource.ts`** — the only file in the library that
touches a Babylon internal. One module, one function, so that when Babylon grows a public
non-memoised accessor, exactly one file changes.

```ts
hasDirectMatrixAccess(host): boolean
copyHostMatrixInto(host, sourceIndex, dest, destIndex): boolean
```

`copyHostMatrixInto` copies **raw floats** rather than materializing a `Matrix` — allocation-free,
so a moving host (a boids school, a physics scene) can be re-mirrored every frame without GC churn.
It re-reads `matrixData` on every access rather than caching the reference at attach, because
growth replaces the array wholesale (§4.1).

### 2.2 We own the outline buffer, so we write it directly

`AttachedHost` keeps `outlineMatrices` — the `Float32Array` we allocated for the outline mesh.
`highlight`/`clear`/`clearAll`/`refresh` write raw floats into it and call
`thinInstanceBufferUpdated('matrix')`.

This deliberately bypasses `thinInstanceSetMatrixAt` on our own outline mesh. That method would
store a `Matrix` by reference into the *outline's* `worldMatrices` cache — re-introducing Trigger B
on our side of the fence. Writing a buffer we allocated is not a reach into Babylon; it is our own
data.

### 2.3 The private-field **write** is deleted

v1.3's `attach()` re-set the host's matrix buffer as a belt-and-suspenders guard against the WebGPU
blanking regression (#3). It is gone, and removing it **fixed a bug rather than risking one**:

**1. It never fixed #3.** `git log -S"_thinInstanceDataStorage"` returns exactly one commit —
**bb80269, the fix itself**. The guard did not pre-exist the fresh-geometry rewrite; it was added in
the same breath as insurance and was never load-bearing. There is no version of this library in
which it is known to have done anything.

**2. Nothing was left for it to repair.** Every `host.*` access in `attach()` was audited. Excluding
the metadata write (#7) and the guard, all are reads or forced copies —
`getVerticesData(kind, false, true)` passes `forceCopy: true`. bb80269's own comment states the
invariant: *"the host's geometry is never shared, so nothing in this method can touch the host's
buffers."* The guard was the only writer left, repairing damage only it could cause.

**3. It was not free.** Measured on `NullEngine`:

| Probe | Before |
| --- | --- |
| Host buffer bound **static**, `isUpdatable()` before → after `attach()` | `false` → **`true`** |
| Host's GPU `Buffer` object identity | **disposed and recreated** |
| `matrixData` identity / values / `thinInstanceCount` | preserved ✓ |

`thinInstanceSetBuffer(kind, buffer, stride, staticBuffer = true)` **defaults to static**, so the
everyday call `host.thinInstanceSetBuffer('matrix', buf, 16)` yields a static buffer that `attach()`
silently converted to updatable, recreating the GPU buffer underneath. That shifts the driver usage
hint and changes which branch the consumer hits in `thinInstanceBufferUpdated`
(`thinInstanceAllowAutomaticStaticBufferRecreation` tests `isUpdatable()`). Unrequested mutation of
consumer state, now regression-tested.

**Net effect:** the library's internals footprint went **down**. We traded a private *write* in the
main class for a private *read* in a quarantined module, and fixed the bug for 100% of consumers on
the way.

### 2.4 Fallback, and why it warns

If `matrixData` is ever unreachable (Babylon renames it), `copyHostMatrixInto` falls back to
`thinInstanceGetWorldMatrices()`. That path still renders — it is merely stale-prone in the §1.2
cases.

Because that degradation is **silent and invisible**, `attach()` emits a `Logger.Warn` once per host
when ground truth is unreachable. A loud warning beats a frozen outline nobody can explain. This is
the one place we accept a known-imperfect path, and it is the reason §5 matters.

## 3. Known limitations (documented, accepted)

- **A Babylon rename silently degrades correctness.** The fallback re-enables §1.2's staleness. The
  `attach()` warning is the mitigation; the peer-dependency range (`>=8.0.0 <9.0.0`) is the fence.
  Re-verify against Babylon 9 before widening it.
- **We do not validate `thinInstanceCount` against buffer capacity.** `copyHostMatrixInto` range-
  checks against the array length, so an out-of-range index is a silent no-op (per ADR-003 §5)
  rather than a crash. A host that grew past its outline's `slotCount` still needs a re-attach —
  #9 (`ensureCapacity`) is where that gets solved properly.
- **Single-mesh mode still allocates.** It reads `host.computeWorldMatrix(true)` and copies out of
  the returned `Matrix`. One matrix per frame per host, already owned by Babylon — not worth
  optimizing.

## 4. Alternatives rejected

### 4.1 Consumer-registered matrix buffer (@labris's proposal) — **rejected**

```ts
outliner.attach(host, { matrixBuffer: matrices })   // NOT adopted
```

This was the first draft's decision. Testing killed it:

- **Silently orphaned by growth.** `_thinInstanceUpdateBufferSize` (line 312) replaces `matrixData`
  with a **new, larger** `Float32Array`. Measured: after one `thinInstanceAdd` past capacity, the
  consumer's registered array stays 64 floats while the live array becomes 128 — *different
  objects*. We would hold a reference to a corpse and read it forever. This collides head-on with
  #9, whose entire purpose is growth.
- **Opt-in fixes don't fix silent bugs.** Registration only helps consumers who read the docs and
  know to pass it. The bug's defining property is that it fails *silently* — the population who
  most needs the fix is exactly the population that won't apply it.
- **It buys only purity, and §2.3 delivers purity for free.** Deleting the write guard already
  resolves the charter concern with no API change. Growing the public surface to re-buy something
  we already have would violate ADR-001's scope discipline.

The proposal was still worth its weight: evaluating it is what surfaced §1.1.

### 4.2 Bust the cache before each read — **rejected**

Calling `thinInstanceSetBuffer(...)` in `refresh()` would null `worldMatrices`, but it also disposes
and recreates the GPU buffer every time, and still needs the private field to get the array.
Pathological.

### 4.3 Document "always move instances via `thinInstanceSetMatrixAt()`" — **rejected**

Trigger B (§1.2) means this is *not even sound advice*. And `setMatrixAt(..., refresh=true)` per
instance is precisely the per-call upload problem #6 exists to fix. We would be prescribing a slow
path that doesn't work.

### 4.4 Wait for an upstream Babylon fix — **rejected as a blocker**

Worth pursuing in parallel (§5), but we support Babylon 8.x broadly and cannot ship a fix requiring
an unreleased core version.

## 5. Upstream (parallel track)

The memoised `worldMatrices` with a single invalidation site is an ecosystem-wide footgun, not just
ours: `thinInstanceBufferUpdated('matrix')` reads as "I changed the matrices" while a public getter
keeps returning pre-change data — and the by-reference sync in `thinInstanceSetMatrixAt` makes the
getter unreliable even for callers who never touch a raw buffer.

The naive fix (null the cache in `thinInstanceBufferUpdated`) would make
`thinInstanceGetWorldMatrices()` an O(n) rebuild after every update — a real regression for anyone
calling both in a loop. A dirty flag, per-index invalidation, or an explicit
`thinInstanceInvalidateWorldMatrices()` are likelier to be accepted. That is a design conversation
for the core team, not a drive-by PR.

**Worth raising with @labris**, who has the core-team relationship and whose
[lite-instancer](https://github.com/eldinor/lite-instancer) does batch matrix updates — meaning it
is exposed to Trigger A from the other side.

If upstream lands a public accessor, `src/hostMatrixSource.ts` is the only file that changes, and
§3's first limitation disappears.

## 6. Tests

`tests/matrixSourceOfTruth.test.ts` — six tests, all of which **failed on `main` before this ADR**
(five red, one green), and pass after:

| Test | Pre-fix failure |
| --- | --- |
| `refresh()` tracks a DIRECT buffer write | `expected 2 to be 999` |
| `highlight()` reads a post-attach direct write | `expected 6 to be 42` |
| `refresh()` with a REUSED scratch Matrix | `expected 400 to be 0` (all slots aliased) |
| `refresh(index)` tracks one moved instance | `expected 4 to be 77` |
| `attach()` leaves a STATIC host buffer static | `expected true to be false` |
| `attach()` preserves host array identity + values | (passed before; guards the deletion) |

**A NullEngine trap worth knowing.** `NullEngine` reports `instancedArrays: false`, so
`thinInstanceAdd()` **refuses outright** — it logs, returns `-1`, and adds nothing. A test that
builds its host that way silently asserts against an empty mesh. Override with
`engine.getCaps().instancedArrays = true` when exercising that path; the §4.1 growth measurement
needed it, and produced a confidently wrong result until it was set.

`thinInstanceSetBuffer()` performs **no caps check** and is unaffected, which is why the suite above
(and the existing 62 tests) need no override — verified, not assumed.

**Not covered:** whether the §2.3 deletion reproduces #3 on real WebGPU. `NullEngine` has no GPU
bindings and cannot answer; this rests on the structural argument in §2.3(2). Verify on the demo
page against a WebGPU engine — #12 would automate it.
