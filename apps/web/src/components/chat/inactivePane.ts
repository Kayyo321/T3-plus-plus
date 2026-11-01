import { createContext } from "react";

/**
 * True for a split pane that does not hold the keyboard. It stays fully usable, but leaves the
 * window's listeners and composer focus to the focused pane.
 */
export const InactivePaneContext = createContext(false);
