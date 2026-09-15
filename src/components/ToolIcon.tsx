import type { SVGProps } from "react";

export type ToolIconName = "dashboard" | "procurement" | "calculator" | "scanner" | "contracts" | "counterparties" | "staff" | "archive" | "settings" | "about" | "chevron-left" | "chevron-right" | "folder" | "lock" | "check" | "arrow-right";

const paths: Record<ToolIconName, React.ReactNode> = {
  dashboard: <><rect x="3" y="3" width="7" height="7" rx="1.5" /><rect x="14" y="3" width="7" height="7" rx="1.5" /><rect x="3" y="14" width="7" height="7" rx="1.5" /><rect x="14" y="14" width="7" height="7" rx="1.5" /></>,
  procurement: <><rect x="4" y="6" width="16" height="15" rx="2" /><path d="M9 6V4a1 1 0 0 1 1-1h4a1 1 0 0 1 1 1v2M8 11h8M8 15h5" /></>,
  calculator: <><rect x="5" y="3" width="14" height="18" rx="2" /><path d="M8 7h8M8 11h1m6 0h1m-8 4h1m6 0h1m-8 3h1m6 0h1" /></>,
  scanner: <><path d="M4 7V4h4m8 0h4v3M4 17v3h4m8 0h4v-3M3 12h18" /><path d="M8 9V7h8v2M8 15v2h8v-2" /></>,
  contracts: <><path d="M14 3H6a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V9zM14 3v6h6M8 13h4m-4 4h3m4-1 2 2 4-4" /></>,
  counterparties: <><path d="M3 21h18M5 21V5l8-2v18m0-13h6v13M8 7h2m-2 4h2m-2 4h2m6-3h1m-1 4h1" /></>,
  staff: <><circle cx="9" cy="8" r="3" /><path d="M3 21v-3a6 6 0 0 1 12 0v3m1-16a3 3 0 0 1 0 6m2 4a5 5 0 0 1 3 5v1" /></>,
  archive: <><rect x="3" y="3" width="18" height="5" rx="1" /><path d="M5 8v12h14V8m-10 4h6" /></>,
  settings: <><path d="m9 3-1 3-3 1-2 4 2 2v4l4 2 3-1 3 1 4-2v-4l2-2-2-4-3-1-1-3z" /><circle cx="12" cy="12" r="3" /></>,
  about: <><circle cx="12" cy="12" r="9" /><path d="M12 11v6m0-10v.1" /></>,
  "chevron-left": <path d="m14 6-6 6 6 6" />,
  "chevron-right": <path d="m10 6 6 6-6 6" />,
  folder: <path d="M3 7V5h6l2 3h10v11H3V7z" />,
  lock: <><rect x="5" y="10" width="14" height="11" rx="2" /><path d="M8 10V7a4 4 0 0 1 8 0v3m-4 4v3" /></>,
  check: <path d="m5 12 4 4L19 6" />,
  "arrow-right": <path d="M4 12h16m-6-6 6 6-6 6" />,
};

/** Local vector icons stay crisp on Windows and macOS without a font dependency. */
export function ToolIcon({ name, ...props }: SVGProps<SVGSVGElement> & { name: ToolIconName }) {
  return <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" focusable="false" {...props}>{paths[name]}</svg>;
}
