import { REMOTE_CONTROL_PAGE_PATH } from "@t3tools/contracts";

/** The page a guest link opens. It shows one shared thread to a browser with no T3 session. */
export const GUEST_PAGE_PATH = "/guest";

/** Pages that show one conversation to a browser that holds no environment session. */
export const isSharedThreadPath = (pathname: string) =>
  pathname === GUEST_PAGE_PATH || pathname === REMOTE_CONTROL_PAGE_PATH;

export function isGuestPage(): boolean {
  return isSharedThreadPath(window.location.pathname);
}
