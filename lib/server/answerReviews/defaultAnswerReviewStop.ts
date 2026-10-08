import { resolveRequestAuth } from "../auth/defaultAuth";
import { getDefaultAnswerReviewDriver } from "./defaultAutoDriver";
import { createAnswerReviewStopHandler } from "./stopHandler";

export const answerReviewStopHandler = createAnswerReviewStopHandler({
  driver: getDefaultAnswerReviewDriver,
  resolveAuth: resolveRequestAuth
});
