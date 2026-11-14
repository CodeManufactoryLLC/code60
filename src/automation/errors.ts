import type { AutomationErrorCode } from "../contracts/index.js";

export class AutomationError extends Error {
  constructor(
    readonly code: AutomationErrorCode,
    message: string,
  ) {
    super(message);
  }
}
