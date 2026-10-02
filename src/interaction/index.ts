export { createSynthesizedActions, InteractionError } from "./executor.js";
export {
  DEFAULT_INTERACTION_MODEL,
  seededRandom,
  validateModel,
} from "./model.js";
export { planTyping, planPointer, planScroll } from "./planner.js";
export {
  calibrateInteraction,
  scoreInteraction,
  validateTrace,
} from "./calibration.js";
export type { InteractionScore, Metric } from "./calibration.js";
export { installInteractionRecorder } from "./recorder.js";
export type * from "./types.js";
