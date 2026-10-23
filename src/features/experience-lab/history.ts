"use client";

import { useReducer } from "react";

// Undo and redo of the studio. Rapid changes of one control (typing a
// name, dragging a focal point, picking a colour) merge into one step, so
// "Annuler" undoes a gesture, not a keystroke.

const MERGE_MS = 900;
const LIMIT = 80;

type State<T> = {
  past: T[];
  present: T;
  future: T[];
  last: { key: string; at: number } | null;
};

type Action<T> =
  | { type: "set"; value: T; key?: string; at: number }
  | { type: "undo" }
  | { type: "redo" }
  | { type: "reset"; value: T };

function reduce<T>(state: State<T>, action: Action<T>): State<T> {
  switch (action.type) {
    case "set": {
      if (Object.is(action.value, state.present)) return state;
      const merge =
        action.key !== undefined &&
        state.last?.key === action.key &&
        action.at - state.last.at < MERGE_MS;
      return {
        past: merge ? state.past : [...state.past, state.present].slice(-LIMIT),
        present: action.value,
        future: [],
        last: action.key ? { key: action.key, at: action.at } : null,
      };
    }
    case "undo": {
      const previous = state.past.at(-1);
      if (previous === undefined) return state;
      return {
        past: state.past.slice(0, -1),
        present: previous,
        future: [state.present, ...state.future],
        last: null,
      };
    }
    case "redo": {
      const [next, ...rest] = state.future;
      if (next === undefined) return state;
      return {
        past: [...state.past, state.present],
        present: next,
        future: rest,
        last: null,
      };
    }
    case "reset":
      return { past: [], present: action.value, future: [], last: null };
  }
}

export function useHistory<T>(initial: T) {
  const [state, dispatch] = useReducer(reduce<T>, {
    past: [],
    present: initial,
    future: [],
    last: null,
  });
  return {
    value: state.present,
    /** `key` names the control: its quick successive changes merge. */
    set: (value: T, key?: string) =>
      dispatch({ type: "set", value, key, at: Date.now() }),
    undo: () => dispatch({ type: "undo" }),
    redo: () => dispatch({ type: "redo" }),
    canUndo: state.past.length > 0,
    canRedo: state.future.length > 0,
  };
}
