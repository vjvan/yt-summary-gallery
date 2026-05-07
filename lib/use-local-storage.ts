"use client";

import { useEffect, useState } from "react";

/**
 * 像 useState 但會 persist 到 localStorage。SSR 安全 (initial render 用 default)。
 *
 * 用途: carousel header 的「自我測驗卡」toggle、theme 偏好等使用者設定。
 */
export function useLocalStorage<T>(key: string, defaultValue: T): [T, (v: T | ((prev: T) => T)) => void] {
  const [value, setValue] = useState<T>(defaultValue);

  // hydration:browser side load saved value (SSR 第一次 render 用 default,避免 hydration mismatch)
  useEffect(() => {
    try {
      const raw = window.localStorage.getItem(key);
      if (raw !== null) {
        setValue(JSON.parse(raw) as T);
      }
    } catch {
      /* ignore — corrupted JSON 直接用 default */
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key]);

  function persist(next: T | ((prev: T) => T)) {
    setValue((prev) => {
      const resolved = typeof next === "function" ? (next as (p: T) => T)(prev) : next;
      try {
        window.localStorage.setItem(key, JSON.stringify(resolved));
      } catch {
        /* ignore — quota / disabled */
      }
      return resolved;
    });
  }

  return [value, persist];
}
