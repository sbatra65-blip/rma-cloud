// Inactivity timer shared across tabs. The server enforces the same limit, so this is the
// visible side: warn at 1 minute left, lock the screen at the limit.
import { useEffect, useRef, useState } from 'react';
import { post } from './api.js';

const channel = typeof BroadcastChannel !== 'undefined' ? new BroadcastChannel('rma-session') : null;

export function broadcastLogout() {
  channel?.postMessage({ type: 'logout' });
}

export function useIdle(enabled, idleMinutes, onTimeout) {
  const lastActive = useRef(Date.now());
  const lastPing = useRef(Date.now());
  const [secondsLeft, setSecondsLeft] = useState(null);
  const timeoutRef = useRef(onTimeout);
  timeoutRef.current = onTimeout;

  useEffect(() => {
    if (!enabled) return undefined;
    const limit = idleMinutes * 60_000;
    lastActive.current = Date.now();

    const activity = (fromOtherTab = false) => {
      lastActive.current = Date.now();
      setSecondsLeft(null);
      if (!fromOtherTab) channel?.postMessage({ type: 'active', at: lastActive.current });
      // Keep the server session alive while the person is working, at most once a minute.
      if (!fromOtherTab && Date.now() - lastPing.current > 60_000) {
        lastPing.current = Date.now();
        post('/api/session/ping').catch(() => {});
      }
    };
    const onEvent = () => activity(false);
    const events = ['pointerdown', 'keydown', 'scroll', 'touchstart', 'wheel'];
    events.forEach((e) => window.addEventListener(e, onEvent, { passive: true }));
    const onMsg = (m) => {
      if (m.data?.type === 'active') activity(true);
      if (m.data?.type === 'logout') timeoutRef.current('logout');
    };
    channel?.addEventListener('message', onMsg);

    // Timestamps (not counters) keep this correct when the phone sleeps or the tab is hidden.
    const tick = setInterval(() => {
      const left = limit - (Date.now() - lastActive.current);
      if (left <= 0) {
        clearInterval(tick);
        timeoutRef.current('idle');
      } else if (left <= 60_000) {
        setSecondsLeft(Math.ceil(left / 1000));
      }
    }, 1000);
    const onVisible = () => {
      if (document.visibilityState === 'visible' && Date.now() - lastActive.current >= limit) timeoutRef.current('idle');
    };
    document.addEventListener('visibilitychange', onVisible);

    return () => {
      events.forEach((e) => window.removeEventListener(e, onEvent));
      channel?.removeEventListener('message', onMsg);
      document.removeEventListener('visibilitychange', onVisible);
      clearInterval(tick);
    };
  }, [enabled, idleMinutes]);

  const stay = () => {
    lastActive.current = Date.now();
    lastPing.current = Date.now();
    setSecondsLeft(null);
    channel?.postMessage({ type: 'active', at: lastActive.current });
    post('/api/session/ping').catch(() => {});
  };
  return { secondsLeft, stay };
}
