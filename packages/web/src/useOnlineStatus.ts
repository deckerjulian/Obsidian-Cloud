import { useEffect, useState } from 'react';

/** Reflects browser connectivity (navigator.onLine + online/offline events).
 *  A best-effort signal — it can't detect a reachable-but-broken server, but
 *  it beats a hardcoded "Connected". */
export function useOnlineStatus(): boolean {
  const [online, setOnline] = useState(() =>
    typeof navigator === 'undefined' ? true : navigator.onLine,
  );
  useEffect(() => {
    const up = () => setOnline(true);
    const down = () => setOnline(false);
    window.addEventListener('online', up);
    window.addEventListener('offline', down);
    return () => {
      window.removeEventListener('online', up);
      window.removeEventListener('offline', down);
    };
  }, []);
  return online;
}
