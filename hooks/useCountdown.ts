"use client";

import { useEffect, useState } from "react";

/**
 * Whole seconds remaining until `deadline` (epoch ms), ticking once a second.
 * Returns null when there is no deadline. Never negative. The interval only
 * runs while a deadline is set and not yet reached.
 */
export function useCountdown(deadline: number | undefined): number | null {
  const [now, setNow] = useState(() => Date.now());

  useEffect(() => {
    if (deadline === undefined) return;
    setNow(Date.now());
    const id = setInterval(() => {
      const t = Date.now();
      setNow(t);
      if (t >= deadline) clearInterval(id);
    }, 1000);
    return () => clearInterval(id);
  }, [deadline]);

  if (deadline === undefined) return null;
  return Math.max(0, Math.ceil((deadline - now) / 1000));
}
