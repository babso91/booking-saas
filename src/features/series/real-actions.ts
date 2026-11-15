import {
  commitSeriesAction,
  previewSeriesAction,
} from "@/features/appointment-series/actions";
import { callAction, type UiError } from "@/features/auth/client/call-action";

import type { SeriesActions, SeriesResult } from "./contract";

// The planner's actions on Cloud's Server Actions
// (docs/APPOINTMENT_SERIES_CONTRACT.md), served as proposed but for one
// difference: the dates taken meanwhile come in `fieldErrors.keys`.

function refusal(error: UiError): SeriesResult<never> {
  const keys = error.fieldErrors?.keys;
  return {
    ok: false,
    error: { code: error.code, ...(keys?.length ? { keys } : {}) },
  };
}

export const realSeriesActions: SeriesActions = {
  preview: async (input) => {
    const result = await callAction(() => previewSeriesAction(input));
    return result.ok ? { ok: true, data: result.data } : refusal(result.error);
  },
  commit: async (input) => {
    const result = await callAction(() => commitSeriesAction(input));
    return result.ok ? { ok: true, data: result.data } : refusal(result.error);
  },
};
