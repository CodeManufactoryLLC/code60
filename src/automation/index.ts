export type { Automation, AutomationRequest } from "../contracts/index.js";
export {
  automationDraftSchema,
  automationRequestSchema,
} from "../contracts/index.js";
export { subscribeService } from "./protocol.js";
export {
  prepareSchedulerUpdate,
  restoreSchedulerUpdate,
  schedulerControl,
} from "./registration.js";
export { automationClient, automationRoot } from "./service.js";
