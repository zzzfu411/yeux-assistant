import type { ReactNode } from 'react';

export type IconName =
  | 'today'
  | 'goals'
  | 'library'
  | 'arrow'
  | 'plus'
  | 'more'
  | 'lock'
  | 'settings'
  | 'study'
  | 'work'
  | 'device'
  | 'research'
  | 'checklist'
  | 'search'
  | 'bell'
  | 'clock'
  | 'history'
  | 'gear'
  | 'branch'
  | 'logout'
  | 'download'
  | 'stop'
  | 'check'
  | 'alert'
  | 'mail'
  | 'close';
const shapes: Record<IconName, ReactNode> = {
  device: (
    <>
      <rect x="3" y="4" width="18" height="13" rx="2" />
      <path d="M8 21h8m-4-4v4M8 8h8" />
    </>
  ),
  study: (
    <>
      <path d="M20 11a8 8 0 0 1-8 8H5l-3 3V11a9 9 0 0 1 18 0Z" />
      <path d="M7 9h8M7 13h5" />
    </>
  ),
  work: <path d="M14 3H6a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V9zM14 3v6h6M8 13h8M8 17h5" />,
  today: (
    <>
      <rect x="4" y="5" width="16" height="16" rx="3" />
      <path d="M8 3v4m8-4v4M4 11h16m-11 5h2" />
    </>
  ),
  goals: (
    <>
      <circle cx="12" cy="12" r="8" />
      <circle cx="12" cy="12" r="4" />
      <path d="m12 12 7-7" />
    </>
  ),
  library: <path d="M4 4h5a4 4 0 0 1 3 1.5A4 4 0 0 1 15 4h5v15h-5a4 4 0 0 0-3 1.5A4 4 0 0 0 9 19H4zM12 6v14" />,
  research: (
    <>
      <circle cx="10.5" cy="10.5" r="6" />
      <path d="m15 15 5.5 5.5M8 10.5h5M10.5 8v5" />
    </>
  ),
  checklist: <path d="M10 6h10M10 12h10M10 18h10M3.5 6l1.5 1.5L7.5 5M3.5 12l1.5 1.5 2.5-2.5M3.5 18l1.5 1.5 2.5-2.5" />,
  search: (
    <>
      <circle cx="11" cy="11" r="6.5" />
      <path d="m16 16 4.5 4.5" />
    </>
  ),
  bell: <path d="M6 16V11a6 6 0 0 1 12 0v5l2 2H4zM10 20a2 2 0 0 0 4 0" />,
  clock: (
    <>
      <circle cx="12" cy="12" r="8.5" />
      <path d="M12 7v5l3.5 2" />
    </>
  ),
  history: <path d="M4 12a8 8 0 1 0 2.4-5.7M4 4v4.5h4.5M12 8v4l3 2" />,
  gear: (
    <>
      <circle cx="12" cy="12" r="3" />
      <path d="M19 12a7 7 0 0 0-.1-1.2l2-1.5-2-3.4-2.3.9a7 7 0 0 0-2-1.2L14.2 3h-4l-.4 2.6a7 7 0 0 0-2 1.2l-2.4-1-2 3.5 2 1.5a7 7 0 0 0 0 2.4l-2 1.5 2 3.5 2.4-1a7 7 0 0 0 2 1.2l.4 2.6h4l.4-2.6a7 7 0 0 0 2-1.2l2.3 1 2-3.5-2-1.5c.1-.4.1-.8.1-1.2Z" />
    </>
  ),
  branch: (
    <>
      <circle cx="6" cy="5.5" r="2" />
      <circle cx="6" cy="18.5" r="2" />
      <circle cx="18" cy="8" r="2" />
      <path d="M6 7.5v9M18 10c0 4-6 3-11.5 6.8" />
    </>
  ),
  logout: <path d="M14 4h4a2 2 0 0 1 2 2v12a2 2 0 0 1-2 2h-4M10 16l-4-4 4-4M6 12h10" />,
  download: <path d="M12 4v11m-4.5-4.5L12 15l4.5-4.5M5 19h14" />,
  stop: <rect x="6.5" y="6.5" width="11" height="11" rx="2" />,
  check: <path d="m5 12.5 4.5 4.5L19 7.5" />,
  alert: (
    <>
      <path d="M12 3.5 2.8 19.5h18.4z" />
      <path d="M12 10v4.5m0 2.5v.01" />
    </>
  ),
  mail: (
    <>
      <rect x="3" y="5" width="18" height="14" rx="2" />
      <path d="m4 7 8 6 8-6" />
    </>
  ),
  close: <path d="M6 6l12 12M18 6 6 18" />,
  arrow: <path d="M5 12h14m-5-5 5 5-5 5" />,
  plus: <path d="M12 5v14M5 12h14" />,
  more: (
    <>
      <circle cx="5" cy="12" r="1" />
      <circle cx="12" cy="12" r="1" />
      <circle cx="19" cy="12" r="1" />
    </>
  ),
  lock: (
    <>
      <rect x="5" y="10" width="14" height="11" rx="2" />
      <path d="M8 10V7a4 4 0 0 1 8 0v3m-4 5v2" />
    </>
  ),
  settings: (
    <>
      <path d="M4 7h16M4 17h16" />
      <circle cx="9" cy="7" r="2" fill="currentColor" />
      <circle cx="15" cy="17" r="2" fill="currentColor" />
    </>
  ),
};
export function Icon({ name, className }: { name: IconName; className?: string }) {
  return (
    <svg
      className={className}
      width="18"
      height="18"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.6"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      {shapes[name]}
    </svg>
  );
}
