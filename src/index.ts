/**
 * index.ts — public API barrel for @poqpoq/babylon-thin-instance-outline.
 * What's exported here IS the v1 contract per ADR-003 §4. Anything not exported
 * here is internal and subject to change without a major version bump.
 */

export { ThinInstanceOutliner } from './ThinInstanceOutliner'
export type {
  AttachOptions,
  ColorCycleOptions,
  EdgeFlowOptions,
  EffectParamUpdates,
  HighlightOptions,
  PulseOptions,
  RimFlowOptions,
  SizzleOptions,
} from './ThinInstanceOutliner'
