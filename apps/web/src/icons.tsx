import type { ReactNode } from 'react';

export type IconName = 'today' | 'goals' | 'library' | 'arrow' | 'plus' | 'more' | 'lock' | 'settings' | 'study' | 'work' | 'device';
const shapes:Record<IconName, ReactNode> = {
  device:<><rect x="3" y="4" width="18" height="13" rx="2"/><path d="M8 21h8m-4-4v4M8 8h8"/></>,
  study:<><path d="M20 11a8 8 0 0 1-8 8H5l-3 3V11a9 9 0 0 1 18 0Z"/><path d="M7 9h8M7 13h5"/></>,
  work:<><path d="M14 3H6a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V9zM14 3v6h6M8 13h8M8 17h5"/></>,
  today:<><rect x="4" y="5" width="16" height="16" rx="3"/><path d="M8 3v4m8-4v4M4 11h16m-11 5h2"/></>,
  goals:<><circle cx="12" cy="12" r="8"/><circle cx="12" cy="12" r="4"/><path d="m12 12 7-7"/></>,
  library:<><path d="M4 4h5a4 4 0 0 1 3 1.5A4 4 0 0 1 15 4h5v15h-5a4 4 0 0 0-3 1.5A4 4 0 0 0 9 19H4zM12 6v14"/></>,
  arrow:<path d="M5 12h14m-5-5 5 5-5 5"/>,
  plus:<path d="M12 5v14M5 12h14"/>,
  more:<><circle cx="5" cy="12" r="1"/><circle cx="12" cy="12" r="1"/><circle cx="19" cy="12" r="1"/></>,
  lock:<><rect x="5" y="10" width="14" height="11" rx="2"/><path d="M8 10V7a4 4 0 0 1 8 0v3m-4 5v2"/></>,
  settings:<><path d="M4 7h16M4 17h16"/><circle cx="9" cy="7" r="2" fill="currentColor"/><circle cx="15" cy="17" r="2" fill="currentColor"/></>
};
export function Icon({name,className}:{name:IconName;className?:string}){return <svg className={className} width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">{shapes[name]}</svg>;}
