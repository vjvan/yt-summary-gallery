"use client";

import Link from "next/link";
import { useCallback, useEffect, useRef, useState } from "react";
import WatchPlayer, { type WatchPlayerApi } from "./WatchPlayer";
import { getWatchConsentGate, getWatchProcessingCopy, watchUsageLabel } from "@/lib/watch/ui-state";
import { followTranscriptCue, nextTranscriptFollowState } from "@/lib/watch/transcript-follow";
import { WATCH_BATCH_SIZE, watchBlockForTime, watchTargetBlock, watchClientFailure, canRetryWatchWindow, mayApplyWatchResult, watchFailureCopy, type WatchClientFailure } from "@/lib/watch/client-state";
import { watchFullTargetBlock, watchScheduleDecision, shouldPreemptWatchWindow, type WatchScheduleMode } from "@/lib/watch/full-prefetch";
import { verifiedWatchCues } from "@/lib/watch/client-results";
import type { TranslatedCue, WatchCue, WatchSessionView, WatchWindowResult, WatchProviderInfo, WatchLimits } from "@/lib/watch/types";

const BATCH_SIZE = WATCH_BATCH_SIZE;
const DEMO_CUES: WatchCue[] = [
  { id: "demo-1", start: 0, end: 7, text: "For this video, we don't need a mask because it's our base background layer." },
  { id: "demo-2", start: 8, end: 14, text: "Now we'll add our three videos to the compositor node." },
  { id: "demo-3", start: 15, end: 21, text: "Drag the first video into the background layer." },
  { id: "demo-4", start: 22, end: 28, text: "The matte keeps the subject visible and makes the background transparent." },
  { id: "demo-5", start: 29, end: 35, text: "Then adjust the edge so the layers blend naturally." },
];
const DEMO_TEXT = [
  "這段影片作為最底層的背景，因此不需要另外製作遮罩。",
  "接下來，把三段影片加入 Compositor（合成器）節點。",
  "先把第一段影片拖入 Background（背景）圖層。",
  "遮罩會保留主體，並讓背景變成透明。",
  "最後微調邊緣，讓各個圖層自然融合。",
];
const DEMO_SESSION: WatchSessionView = {
  sessionId: "local-demo", videoId: "kfbWz9_bJoA", title: "Weave 多圖層合成 · 字幕功能示範",
  language: "en", sourceKind: "manual", trackId: "demo", cues: DEMO_CUES,
  glossaryVersion: "demo", translationEnabled: false, limits: { sessionCalls: null, dailyCalls: null },
  processingMode: "local", unlimited: true, translationModel: "示範（不執行模型）", translationConfigured: false, audioConfigured: false,
};

type PairInfo = { token: string; limits: WatchLimits } & Partial<WatchProviderInfo>;
type CaptionMode = "bilingual" | "translated" | "original" | "off";
type Runtime = {
  session: WatchSessionView | null; token: string; consent: boolean; enabled: boolean; playing: boolean; time: number; scheduleMode: WatchScheduleMode;
  generation: number; stopped: boolean; stopSent: boolean;
  completed: Set<number>; failed: Map<number, WatchClientFailure>;
  failure: WatchClientFailure | null; retryRequested: boolean; lastClockAt: number | null;
  pending: { controller: AbortController; block: number } | null;
};
class WatchApiError extends Error {
  constructor(message: string, readonly status: number, readonly code: string) { super(message); }
}

function timeLabel(seconds: number): string {
  return `${Math.floor(seconds / 60)}:${Math.floor(seconds % 60).toString().padStart(2, "0")}`;
}
function extractYouTubeId(input: string): string | null {
  try {
    const url = new URL(input);
    if (url.protocol !== "https:" && url.protocol !== "http:") return null;
    const host = url.hostname.toLowerCase();
    let id: string | null = null;
    if (host === "youtu.be") id = url.pathname.split("/")[1];
    else if (["youtube.com", "www.youtube.com", "m.youtube.com"].includes(host)) {
      id = url.searchParams.get("v");
      if (!id && /^\/(shorts|embed)\//.test(url.pathname)) id = url.pathname.split("/")[2];
    }
    return id && /^[A-Za-z0-9_-]{11}$/.test(id) ? id : null;
  } catch { return null; }
}
async function readResponse<T>(response: Response): Promise<T> {
  const result = await response.json().catch(() => null);
  if (!response.ok) {
    throw new WatchApiError(result?.error || "本機服務暫時無法處理此請求。", response.status, result?.code || "UNKNOWN");
  }
  return result as T;
}

export default function WatchClient({ demo, initialUrl }: { demo: boolean; initialUrl: string }) {
  const [url, setUrl] = useState(demo ? "https://www.youtube.com/watch?v=kfbWz9_bJoA" : initialUrl);
  const [videoId, setVideoId] = useState(demo ? DEMO_SESSION.videoId : "");
  const [playerVersion, setPlayerVersion] = useState(0);
  const [session, setSession] = useState<WatchSessionView | null>(demo ? DEMO_SESSION : null);
  const [translations, setTranslations] = useState<Record<string, TranslatedCue>>(() => demo
    ? Object.fromEntries(DEMO_CUES.map((cue, index) => [cue.id, { ...cue, originalText: cue.text, text: DEMO_TEXT[index] }]))
    : {});
  const [time, setTime] = useState(0);
  const [playing, setPlaying] = useState(false);
  const [loading, setLoading] = useState(false);
  const [consent, setConsent] = useState(false);
  const [enabled, setEnabled] = useState(false);
  const [scheduleMode, setScheduleMode] = useState<WatchScheduleMode>("nearby");
  const [stopped, setStopped] = useState(false);
  const [pendingBlock, setPendingBlock] = useState<number | null>(null);
  const [error, setError] = useState("");
  const [translationFailure, setTranslationFailure] = useState<WatchClientFailure | null>(null);
  const [retryRequested, setRetryRequested] = useState(false);
  const [sourceError, setSourceError] = useState("");
  const [notice, setNotice] = useState("");
  const [calls, setCalls] = useState({ session: 0, daily: 0 });
  const [mode, setMode] = useState<CaptionMode>("bilingual");
  const [pair, setPair] = useState<PairInfo | null>(null);
  const [backendInfo, setBackendInfo] = useState<WatchProviderInfo | null>(null);
  const [showPair, setShowPair] = useState(false);
  const [showPairValue, setShowPairValue] = useState(false);
  const [localServerUrl, setLocalServerUrl] = useState("");
  const [pairBusy, setPairBusy] = useState(false);
  const [copyMessage, setCopyMessage] = useState("");
  const [transcriptFollowing, setTranscriptFollowing] = useState(true);
  const transcriptPanel = useRef<HTMLDivElement | null>(null);
  const transcriptRows = useRef(new Map<string, HTMLButtonElement>());
  const transcriptTouchStart = useRef<number | null>(null);
  const playerApi = useRef<WatchPlayerApi | null>(null);
  const pairPromise = useRef<Promise<PairInfo> | null>(null);
  const loadController = useRef<AbortController | null>(null);
  const loadSequence = useRef(0);
  const pumpRef = useRef<() => void>(() => {});
  const runtime = useRef<Runtime>({
    session: demo ? DEMO_SESSION : null, token: "", consent: false, enabled: false, playing: false, time: 0, scheduleMode: "nearby",
    generation: 0, stopped: false, stopSent: false, completed: new Set(), failed: new Map(), pending: null,
    failure: null, retryRequested: false, lastClockAt: null,
  });

  const stopRemote = useCallback((target: WatchSessionView | null, token: string) => {
    if (demo || !target || !token) return;
    void fetch(`/api/watch/session/${encodeURIComponent(target.sessionId)}/stop`, {
      method: "POST", headers: { Authorization: `Bearer ${token}` }, keepalive: true,
    }).catch(() => { /* 關頁時 best effort；伺服器仍有工作上限。 */ });
  }, [demo]);

  const cancelPending = useCallback(() => {
    const current = runtime.current;
    current.generation += 1;
    current.pending?.controller.abort();
    // Retain the slot until the aborted request settles; seek never overlaps two window fetches.
    setPendingBlock(null);
  }, []);

  const ensurePair = useCallback(async (): Promise<PairInfo> => {
    if (demo) throw new Error("示範模式不連線本機配對 API。");
    if (!pairPromise.current) {
      pairPromise.current = fetch("/api/watch/pair", { cache: "no-store", credentials: "same-origin" })
        .then((response) => readResponse<PairInfo>(response))
        .then(async (result) => {
          runtime.current.token = result.token;
          setPair(result);
          try {
            const response = await fetch("/api/watch/status", { cache: "no-store", headers: { Authorization: `Bearer ${result.token}` } });
            setBackendInfo(await readResponse<WatchProviderInfo>(response));
          } catch { setBackendInfo(null); }
          return result;
        }).catch((failure) => { pairPromise.current = null; throw failure; });
    }
    return pairPromise.current;
  }, [demo]);

  useEffect(() => { if (!demo) void ensurePair().catch(() => {}); }, [demo, ensurePair]);

  const pump = useCallback(async () => {
    const current = runtime.current;
    const source = current.session;
    if (demo || !source) return;
    const decision = watchScheduleDecision({ ...current, mode: current.scheduleMode, processingMode: source.processingMode, cues: source.cues });
    if (decision.kind === "idle") return;
    if (decision.kind === "blocked") {
      current.enabled = false;
      setEnabled(false);
      setNotice(`其他字幕已處理；仍有 ${current.failed.size} 批含未通過句子，尚未全片完成。可手動重試，已完成句子不會重翻。`);
      return;
    }
    if (decision.kind === "done") {
      current.enabled = false;
      setEnabled(false);
      setNotice("整片字幕已預譯完成；不再送出後續請求。可自由播放或快轉查看。");
      return;
    }
    const block = watchBlockForTime(source.cues, current.time);
    const target = decision.block;
    const previousFailure = current.failed.get(target);
    if (previousFailure && !current.retryRequested) {
      current.failure = previousFailure;
      setTranslationFailure(previousFailure);
      if (current.scheduleMode === "full") { current.enabled = false; setEnabled(false); }
      return;
    }
    const batch = source.cues.slice(target * BATCH_SIZE, (target + 1) * BATCH_SIZE);
    if (!batch.length) return;
    const controller = new AbortController();
    const generation = current.generation;
    current.pending = { controller, block: target };
    setPendingBlock(target);
    const failWindow = (failure: WatchClientFailure) => {
      current.failed.set(target, failure);
      current.failure = failure;
      current.retryRequested = false;
      setTranslationFailure(failure);
      setRetryRequested(false);
      if (failure.recovery !== "retry" || (current.scheduleMode === "full" && failure.code !== "LOCAL_TRANSLATION_QUALITY")) {
        current.enabled = false;
        setEnabled(false);
      }
    };
    try {
      // 與 server 的 8-cue 規則一致，不以固定 30 秒作為快取／去重鍵。
      const previous = source.cues[target * BATCH_SIZE - 1];
      const requestTime = target === block ? current.time : (previous?.end ?? batch[0].start) + 0.01;
      const response = await fetch("/api/watch/window", {
        method: "POST", signal: controller.signal,
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${current.token}` },
        body: JSON.stringify({ sessionId: source.sessionId, time: requestTime, confirmTranslation: true }),
      });
      const result = await readResponse<WatchWindowResult>(response);
      if (!mayApplyWatchResult({ requestGeneration: generation, generation: current.generation,
        requestSessionId: source.sessionId, sessionId: current.session?.sessionId, aborted: controller.signal.aborted })) return;
      if (result.sessionId !== source.sessionId) throw new Error("回傳字幕不屬於目前影片，已停止套用。請重試。");
      const usable = verifiedWatchCues(batch, result.cues);
      setTranslations((existing) => ({ ...existing, ...Object.fromEntries(usable.map((cue) => [cue.id, cue])) }));
      setCalls({ session: result.callsUsed, daily: result.dailyCallsUsed });
      if (batch.every((cue) => usable.some((translated) => translated.id === cue.id))) {
        current.completed.add(target);
        current.failed.delete(target);
        current.failure = current.failed.values().next().value ?? null;
        current.retryRequested = false;
        setTranslationFailure(current.failure); setRetryRequested(false); setNotice("");
      } else {
        const isolated = source.processingMode === "local" && result.complete === false && result.failedCues?.length;
        failWindow(watchClientFailure(target, isolated ? result.failedCues!.map(cue => cue.message).join("；") : "本批字幕不完整，已保留原文；請按重試，不會將原文誤標為翻譯完成。", 0, isolated ? "LOCAL_TRANSLATION_QUALITY" : "INCOMPLETE_WINDOW"));
      }
    } catch (failure) {
      if (controller.signal.aborted || generation !== current.generation) return;
      const message = failure instanceof Error ? failure.message : "翻譯失敗，原文字幕仍可繼續觀看。";
      failWindow(watchClientFailure(target, message, failure instanceof WatchApiError ? failure.status : 0,
        failure instanceof WatchApiError ? failure.code : "UNKNOWN"));
      if (failure instanceof WatchApiError && failure.status === 401) {
        pairPromise.current = null;
        current.token = "";
        setPair(null);
      }
    } finally {
      if (current.pending?.controller === controller) {
        current.pending = null;
        setPendingBlock(null);
        // Nearby keeps its bounded lookahead; explicit full mode continues while paused.
        // A cancelled generation releases its own slot before scheduling the latest seek.
        queueMicrotask(() => pumpRef.current());
      }
    }
  }, [demo]);

  useEffect(() => { pumpRef.current = () => { void pump(); }; }, [pump]);
  useEffect(() => {
    const close = () => {
      const current = runtime.current;
      current.enabled = false;
      current.stopped = true;
      current.generation += 1;
      current.pending?.controller.abort();
      loadController.current?.abort();
      loadSequence.current += 1;
      if (!current.stopSent) {
        current.stopSent = true;
        stopRemote(current.session, current.token);
      }
    };
    const restore = (event: PageTransitionEvent) => {
      if (!event.persisted || !runtime.current.session) return;
      setEnabled(false); setStopped(true); setPendingBlock(null);
      setNotice("已停止離開頁面前的工作。請重新載入影片，建立新的觀看工作。");
    };
    window.addEventListener("pagehide", close);
    window.addEventListener("pageshow", restore);
    return () => {
      window.removeEventListener("pagehide", close);
      window.removeEventListener("pageshow", restore);
      close();
    };
  }, [stopRemote]);

  const onTime = useCallback((value: number, explicitSeek = false) => {
    if (!Number.isFinite(value) || value < 0) return;
    const current = runtime.current;
    const now = performance.now();
    if (current.session && shouldPreemptWatchWindow(current.scheduleMode, {
      previousTime: current.time, nextTime: value, elapsedMs: current.lastClockAt === null ? null : now - current.lastClockAt,
      playing: current.playing, pendingBlock: current.pending?.block ?? null,
      destinationBlock: watchBlockForTime(current.session.cues, value), explicitSeek,
    })) cancelPending();
    current.lastClockAt = now;
    current.time = value;
    setTime(value);
    pumpRef.current();
  }, [cancelPending]);
  const onPlaying = useCallback((value: boolean) => {
    runtime.current.playing = value;
    setPlaying(value);
    if (!value && runtime.current.scheduleMode !== "full") cancelPending();
    else pumpRef.current();
  }, [cancelPending]);
  const onReady = useCallback((api: WatchPlayerApi | null) => { playerApi.current = api; }, []);

  async function openVideo(event: React.FormEvent) {
    event.preventDefault();
    if (demo) return;
    const id = extractYouTubeId(url.trim());
    if (!id) { setError("請貼上有效的 YouTube 影片連結。第一版只支援可取得英語字幕的影片。"); return; }
    const previous = runtime.current;
    stopRemote(previous.session, previous.token);
    cancelPending();
    loadController.current?.abort();
    const sequence = ++loadSequence.current;
    const controller = new AbortController();
    loadController.current = controller;
    previous.session = null;
    previous.enabled = false;
    previous.consent = false;
    previous.scheduleMode = "nearby";
    previous.playing = false;
    previous.stopped = false;
    previous.stopSent = false;
    previous.time = 0;
    previous.lastClockAt = null;
    previous.failure = null;
    previous.retryRequested = false;
    previous.completed.clear();
    previous.failed.clear();
    setTranscriptFollowing((value) => nextTranscriptFollowState(value, "new-video"));
    transcriptPanel.current?.scrollTo({ top: 0, behavior: "auto" });
    setVideoId(id); // 不等字幕取得，就先掛上 YouTube 播放器。
    setPlayerVersion((version) => version + 1); // 同一影片重新載入也重置播放器／播放狀態。
    setSession(null); setTranslations({}); setTime(0); setPlaying(false);
    setConsent(false); setEnabled(false); setScheduleMode("nearby"); setStopped(false); setError(""); setSourceError(""); setNotice("");
    setTranslationFailure(null); setRetryRequested(false);
    setCalls({ session: 0, daily: 0 }); setLoading(true);
    try {
      const localPair = await ensurePair();
      if (sequence !== loadSequence.current) return;
      const response = await fetch("/api/watch/session", {
        method: "POST", signal: controller.signal,
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${localPair.token}` },
        body: JSON.stringify({ url: `https://www.youtube.com/watch?v=${id}`, sourceLanguage: "en" }),
      });
      const created = await readResponse<WatchSessionView>(response);
      if (sequence !== loadSequence.current) { stopRemote(created, localPair.token); return; }
      runtime.current.session = created;
      setSession(created);
      const cached = verifiedWatchCues(created.cues, created.cachedCues);
      const ready = new Set(cached.map(cue => cue.id));
      setTranslations(Object.fromEntries(cached.map(cue => [cue.id, cue])));
      for (let offset = 0; offset < created.cues.length; offset += BATCH_SIZE) {
        if (created.cues.slice(offset, offset + BATCH_SIZE).every(cue => ready.has(cue.id))) runtime.current.completed.add(offset / BATCH_SIZE);
      }
      if (!created.translationEnabled) setNotice(created.processingMode === "local" ? "本機模型尚未就緒；仍可觀看原文，不會改用雲端。" : "尚未設定雲端翻譯模型；仍可同步觀看原文。");
    } catch (failure) {
      if (!controller.signal.aborted && sequence === loadSequence.current) {
        const message = failure instanceof WatchApiError
          ? `${failure.message}（${failure.code}）`
          : failure instanceof Error ? failure.message : "無法取得原文字幕。";
        setSourceError(message);
        setError(message);
      }
    } finally {
      if (sequence === loadSequence.current) setLoading(false);
    }
  }

  function enableTranslation() {
    if (demo || !consent || !session?.cues.length || !session.translationEnabled || loading || sourceError || stopped || runtime.current.failure) return;
    runtime.current.enabled = true;
    runtime.current.scheduleMode = session.processingMode === "local" ? "full" : "nearby";
    setScheduleMode(runtime.current.scheduleMode);
    setEnabled(true); setError(""); setNotice("");
    pumpRef.current();
  }
  function startFullPrefetch() {
    const current = runtime.current;
    if (demo || !consent || !current.consent || !session?.cues.length || session.processingMode !== "local"
      || !session.translationEnabled || loading || sourceError || stopped || current.failure) return;
    if (watchFullTargetBlock(session.cues, current.time, current.completed) < 0) return;
    current.scheduleMode = "full";
    current.enabled = true;
    setScheduleMode("full"); setEnabled(true); setError(""); setNotice("");
    pumpRef.current();
  }
  function retryCurrentWindow() {
    const current = runtime.current;
    if (demo || !current.session || !canRetryWatchWindow({ ...current, consent, sourceReady: !!session?.translationEnabled && !loading && !sourceError })) return;
    const target = current.scheduleMode === "full"
      ? watchFullTargetBlock(current.session.cues, current.time, current.completed, current.failure?.block)
      : watchTargetBlock(current.session.cues, current.time, current.completed);
    if (target < 0) {
      setNotice("請先點選逐字稿，跳回想重試的區段，再按重試。");
      return;
    }
    current.retryRequested = true;
    current.enabled = true;
    setRetryRequested(true); setEnabled(true); setNotice("");
    // Keep the original failure visible until a real, complete retry succeeds.
    pumpRef.current();
  }
  function updateConsent(value: boolean) {
    setConsent(value);
    runtime.current.consent = value;
    if (!value) {
      runtime.current.enabled = false;
      runtime.current.scheduleMode = "nearby";
      setScheduleMode("nearby");
      runtime.current.retryRequested = false;
      setRetryRequested(false);
      setEnabled(false); cancelPending();
    }
  }
  function stopTranslation() {
    const current = runtime.current;
    current.enabled = false;
    current.stopped = true;
    current.retryRequested = false;
    setRetryRequested(false);
    cancelPending();
    if (!current.stopSent) { current.stopSent = true; stopRemote(current.session, current.token); }
    setEnabled(false); setStopped(true);
    setNotice(getWatchProcessingCopy(current.session || backendInfo || {}).stopping);
  }
  function seekTo(seconds: number) {
    setTranscriptFollowing((value) => nextTranscriptFollowState(value, "cue-seek"));
    onTime(seconds, true);
    if (!demo) playerApi.current?.seekTo(seconds);
  }
  async function revealPair() {
    if (demo) return;
    if (showPair) { setShowPair(false); setShowPairValue(false); return; }
    setPairBusy(true); setCopyMessage("");
    try { await ensurePair(); setLocalServerUrl(window.location.origin); setShowPairValue(false); setShowPair(true); }
    catch (failure) { setCopyMessage(failure instanceof Error ? failure.message : "無法取得配對碼。"); }
    finally { setPairBusy(false); }
  }
  async function copyPair() {
    if (!pair || demo) return;
    try { await navigator.clipboard.writeText(pair.token); setCopyMessage("已複製。僅貼到你手動載入的本機擴充套件，請勿分享。"); }
    catch { setCopyMessage("瀏覽器未允許自動複製。請先按「顯示內容」，再手動選取並複製配對碼。"); }
  }

  const activeCue = session?.cues.find((cue) => cue.start <= time && time < cue.end);
  const activeTranslation = activeCue ? translations[activeCue.id]?.text || "" : "";
  const activeCueId = activeCue?.id;
  const alignTranscript = useCallback((force = false) => {
    const panel = transcriptPanel.current;
    const row = activeCueId ? transcriptRows.current.get(activeCueId) : undefined;
    if (panel && row) followTranscriptCue(panel, row, transcriptFollowing || force, force);
  }, [activeCueId, transcriptFollowing]);
  useEffect(() => {
    // Recheck after cue changes, newly translated rows, and panel/active-row resizing.
    // No scroll-event listener: programmatic scroll must not disable automatic following.
    alignTranscript();
    const panel = transcriptPanel.current;
    const row = activeCueId ? transcriptRows.current.get(activeCueId) : undefined;
    if (!transcriptFollowing || !panel || !row || typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(() => alignTranscript());
    observer.observe(panel);
    observer.observe(row);
    return () => observer.disconnect();
  }, [activeCueId, alignTranscript, transcriptFollowing, translations]);
  function pauseTranscriptFollow() {
    setTranscriptFollowing((value) => nextTranscriptFollowState(value, "manual-scroll"));
  }
  function resumeTranscriptFollow() {
    setTranscriptFollowing((value) => nextTranscriptFollowState(value, "resume"));
    alignTranscript(true);
  }
  const translatedCount = session?.cues.filter((cue) => !!translations[cue.id]).length || 0;
  const allDone = !!session?.cues.length && translatedCount === session.cues.length;
  const limits = session?.limits || pair?.limits;
  const processingInfo: Partial<WatchProviderInfo> & { limits?: WatchLimits } = { ...(session || backendInfo || pair || {}), limits };
  const processingCopy = getWatchProcessingCopy(processingInfo);
  const baseFailureCopy = translationFailure ? watchFailureCopy(translationFailure, { enabled, playing, retryRequested, pending: pendingBlock !== null }) : null;
  const fullPrefetch = scheduleMode === "full" && session?.processingMode === "local";
  const failureCopy = baseFailureCopy && fullPrefetch && translationFailure?.recovery === "retry" ? {
    ...baseFailureCopy,
    status: retryRequested ? "正在重試整片預譯的失敗批次" : enabled && translationFailure.code === "LOCAL_TRANSLATION_QUALITY" ? "整片預譯中 · 個別句子待重試" : "預譯未全部完成 · 等待手動重試",
    button: retryRequested ? "正在重試…" : "重試失敗批次並繼續整片",
    caption: retryRequested ? "正在重試翻譯…" : "預譯失敗，原文仍可觀看",
    description: retryRequested ? "手動重試已排定；不必播放影片，只補尚未完成的句子。" : translationFailure.code === "LOCAL_TRANSLATION_QUALITY" ? "個別品質失敗句已隔離，成功句子已保留；其餘字幕繼續處理，失敗句不會無限重試。" : "遇到連線或模型錯誤已停止預譯；按重試才恢復，已完成句子不會重翻。",
  } : baseFailureCopy;
  const visibleError = error || translationFailure?.message || "";
  const status = demo ? "示範資料 · 非真實翻譯" : loading ? "取得英語原文字幕中" : stopped ? "本次工作已停止"
    : error ? "需要處理" : failureCopy ? failureCopy.status : allDone ? "全部字幕已完成" : pendingBlock !== null ? fullPrefetch ? "整片預譯中 · 播放或暫停皆可" : "翻譯中"
      : fullPrefetch && enabled ? "整片預譯已啟用 · 正在排程" : enabled && !playing ? "已啟用 · 等待播放" : enabled ? activeTranslation ? "目前區段已就緒" : "已啟用 · 等待目前區段" : session ? "原文就緒 · 翻譯尚未啟用" : "等待影片連結";
  const captionStatus = stopped ? "本次翻譯工作已停止" : failureCopy ? failureCopy.caption : error ? "本段尚未翻譯，請查看下方提示" : pendingBlock !== null ? "本段翻譯準備中…"
    : enabled ? "本段尚未就緒" : "尚未啟用翻譯";
  const progress = session?.cues.length ? Math.round(translatedCount / session.cues.length * 100) : 0;
  const consentGate = getWatchConsentGate({
    demo, loading, stopped, sourceReady: !!session?.cues.length,
    modelEnabled: !!session?.translationEnabled, loadError: sourceError, processingMode: processingInfo.processingMode, unlimited: processingInfo.unlimited, translationStatusMessage: processingInfo.translationStatusMessage,
  });
  const enableReason = !consentGate.canConsent ? consentGate.title
    : allDone ? "整片已完成，可直接播放／快轉，不需再啟用翻譯。"
    : !consent ? "請先勾選上方同意框，才能啟用或重試同步翻譯。"
      : failureCopy ? failureCopy.description
        : fullPrefetch && enabled ? "整片預譯中；暫停不會中斷。目前批次完成後，優先處理最新跳轉位置的缺段。請保持本頁與本機服務開啟。"
        : enabled ? (playing ? "已啟用；只翻目前區段與有限的下一批。" : "已啟用；按影片播放後才送出翻譯。")
          : session?.processingMode === "local" ? "可以啟用整片預譯；暫停也會繼續處理並保存。" : "可以啟用；開始播放後才會送出翻譯請求。";
  const canRetry = canRetryWatchWindow({ failure: translationFailure, retryRequested, pending: pendingBlock !== null,
    consent, sourceReady: consentGate.canConsent, stopped });


  return (
    <main className="min-h-screen flex-1 bg-[#fafaf9] text-gray-900">
      <div className="mx-auto max-w-7xl px-4 py-8 sm:px-6 sm:py-10">
        <div className="mb-7 flex flex-wrap items-end justify-between gap-4">
          <div>
            <p className="mb-2 text-xs font-bold tracking-wider text-orange-600">YT SUMMARY / WATCH</p>
            <h1 className="text-3xl font-bold tracking-tight sm:text-4xl">聽懂專業，不只看懂字幕。</h1>
            <p className="mt-3 max-w-2xl text-sm leading-relaxed text-gray-600">英語原文 → 語境與術語翻譯 → 同步繁體中文。已有原文字幕可先預譯整片；全部就緒後再播放、快轉，不必等模型。</p>
          </div>
          <Link href="/glossary" className="rounded-xl border border-gray-200 bg-white px-4 py-2.5 text-sm font-semibold text-gray-700 hover:border-orange-300 hover:text-orange-600">管理專業術語 ↗</Link>
        </div>

        {!demo && <section className="mb-5 flex flex-wrap items-center justify-between gap-3 rounded-xl border border-orange-200 bg-orange-50 px-4 py-3 text-sm text-orange-950">
          <p className="max-w-2xl leading-relaxed"><strong>想要整片摘要或燒錄字幕影片？</strong>觀看頁只疊加字幕，不下載原片。請到影片庫建立完整工作，再從影片詳情下載 SRT 或準備原片後燒錄 MP4。</p>
          <Link href={url.trim() ? `/?url=${encodeURIComponent(url.trim())}` : "/"} className="shrink-0 rounded-lg border border-orange-300 bg-white px-3 py-2 font-bold hover:bg-orange-100">開啟影片庫：摘要、完整字幕與燒錄 →</Link>
        </section>}

        {demo && <div role="status" className="mb-5 rounded-xl border border-orange-200 bg-orange-50 px-4 py-3 text-sm leading-relaxed text-orange-900"><strong>互動示範模式：</strong>以下 5 句為內嵌示例，不是真實翻譯結果，不會呼叫 Watch API 或付費模型。滑動時間軸可測試同步字幕與右側逐字稿跟隨；手動捲動列表會暫停跟隨。 <Link href="/watch" className="font-bold underline underline-offset-2">前往正式觀看頁</Link></div>}

        <div role="status" className="mb-5 rounded-xl border border-emerald-200 bg-emerald-50 px-4 py-3 text-sm text-emerald-900">{processingCopy.banner}{processingCopy.local && " 本機未就緒時不會回退雲端。"}</div>

        <form id="watch-load-form" onSubmit={openVideo} className="mb-6 rounded-2xl border border-gray-200 bg-white p-4 shadow-sm">
          <label htmlFor="watch-url" className="mb-2 block text-xs font-bold text-gray-500">01 / 開啟 YouTube 影片</label>
          <div className="flex flex-col gap-3 sm:flex-row">
            <input id="watch-url" type="url" value={url} onChange={(event) => setUrl(event.target.value)} placeholder="https://www.youtube.com/watch?v=…" required disabled={demo} className="min-w-0 flex-1 rounded-xl border border-gray-200 bg-gray-50 px-4 py-3 text-sm outline-none focus:border-orange-400 focus:ring-2 focus:ring-orange-100 disabled:text-gray-500" />
            <button type="submit" disabled={demo} className="shrink-0 rounded-xl bg-orange-500 px-6 py-3 text-sm font-bold text-white transition hover:bg-orange-600 disabled:bg-gray-200 disabled:text-gray-500">{loading ? "重新載入影片" : "載入影片與原文"}</button>
          </div>
          <p className="mt-2 text-xs leading-relaxed text-gray-500">第一版支援有英語字幕的非直播影片；優先使用人工原文字幕，沒有字幕時會明確提示，不會自動送音訊辨識。</p>
        </form>

        {sourceError && !loading && <div role="alert" className="mb-6 rounded-xl border border-red-200 bg-red-50 p-4 text-sm leading-relaxed text-red-800">
          <p className="font-bold">原文字幕取得失敗，因此下方同意框尚未開放。</p>
          <p className="mt-1 break-words">{sourceError}</p>
          <p className="mt-1 text-xs">影片能播放，不代表原文字幕已取得；修正連線或字幕來源問題後再重試。這次尚未啟動模型翻譯。</p>
          <button type="submit" form="watch-load-form" className="mt-2 font-bold underline underline-offset-2">重新載入影片與原文</button>
        </div>}

        <div className="grid items-start gap-6 xl:grid-cols-[minmax(0,1.6fr)_minmax(320px,1fr)]">
          <div className="min-w-0 space-y-4">
            {videoId ? <WatchPlayer key={`${demo}-${videoId}-${playerVersion}`} videoId={videoId} demo={demo} time={time} playing={playing} original={activeCue?.text || ""} translated={activeTranslation} cueStart={activeCue?.start} cueEnd={activeCue?.end} captionMode={mode} captionStatus={captionStatus} onTime={onTime} onPlaying={onPlaying} onReady={onReady} /> : (
              <div className="flex aspect-video flex-col items-center justify-center rounded-2xl border border-dashed border-gray-300 bg-white px-8 text-center">
                <div className="mb-5 flex h-14 w-14 items-center justify-center rounded-2xl bg-orange-50 text-2xl text-orange-500" aria-hidden="true">▶</div>
                <h2 className="text-lg font-bold text-gray-700">影片在這裡播放，字幕跟著時間走。</h2>
                <p className="mt-2 text-sm text-gray-500">貼上連結即可載入；啟用翻譯前，不會呼叫翻譯模型。</p>
                <Link href="/watch?demo=1" className="mt-5 text-sm font-bold text-orange-600 hover:underline">先試試不扣點的互動示範 →</Link>
              </div>
            )}
            <div className="flex flex-wrap items-center justify-between gap-3">
              <span className="text-xs tabular-nums text-gray-500">{timeLabel(time)} <span className="mx-1.5 text-gray-300">/</span> {demo ? "示範時鐘" : "跟隨影片時間；不是翻譯完成時間"}</span>
              <fieldset className="flex gap-1 rounded-xl border border-gray-200 bg-white p-1">
                <legend className="sr-only">字幕顯示模式</legend>
                {([["bilingual", "雙語"], ["translated", "繁中"], ["original", "原文"], ["off", "關閉"]] as const).map(([value, label]) => <button key={value} type="button" aria-pressed={mode === value} onClick={() => setMode(value)} className={`rounded-lg px-3 py-1.5 text-xs font-bold ${mode === value ? "bg-orange-50 text-orange-700" : "text-gray-500 hover:bg-gray-50"}`}>{label}</button>)}
              </fieldset>
            </div>
            <p className="text-xs leading-relaxed text-gray-500">{session?.title || "不下載整支影片；使用 YouTube 嵌入播放器。"}{videoId && !demo && " · 若原生字幕重疊，請關閉 YouTube 的 CC。"}</p>

            <section className="rounded-2xl border border-gray-200 bg-white p-5">
              <h2 className="text-sm font-bold">02 / 明確啟用，再開始翻譯</h2>
              <div id="watch-consent-state" role="status" aria-live="polite" className={`mt-3 rounded-xl border p-3 text-sm leading-relaxed ${consentGate.state === "failed" ? "border-red-200 bg-red-50 text-red-800" : consentGate.canConsent ? "border-emerald-200 bg-emerald-50 text-emerald-900" : "border-amber-200 bg-amber-50 text-amber-900"}`}>
                <p className="font-bold">{consentGate.title}</p>
                <p className="mt-1 break-words text-xs">{consentGate.description}</p>
              </div>
              <label className={`mt-3 flex items-start gap-3 rounded-xl bg-gray-50 p-3 text-sm leading-relaxed ${consentGate.canConsent ? "cursor-pointer" : "cursor-not-allowed text-gray-500"}`}>
                <input type="checkbox" checked={consent} onChange={(event) => updateConsent(event.target.checked)} disabled={!consentGate.canConsent} aria-describedby="watch-consent-state" className="mt-1 h-4 w-4 shrink-0 accent-orange-500" />
                <span>{processingCopy.consent}</span>
              </label>
              <div className="mt-4 flex flex-wrap gap-3">
                {translationFailure?.recovery === "reload" ? <button type="submit" form="watch-load-form" disabled={demo || loading} aria-describedby="watch-enable-reason" className="rounded-xl bg-orange-500 px-5 py-2.5 text-sm font-bold text-white hover:bg-orange-600 disabled:bg-gray-200 disabled:text-gray-500">重新載入影片與原文</button> : <button type="button" onClick={translationFailure ? retryCurrentWindow : enableTranslation} disabled={translationFailure ? !canRetry : !consentGate.canConsent || !consent || enabled || allDone} aria-describedby="watch-enable-reason" className="rounded-xl bg-orange-500 px-5 py-2.5 text-sm font-bold text-white hover:bg-orange-600 disabled:bg-gray-200 disabled:text-gray-500">{failureCopy ? failureCopy.button : allDone ? "字幕已完成" : enabled ? "翻譯已啟用" : session?.processingMode === "local" ? "啟用整片預譯" : "啟用同步翻譯"}</button>}
                {session?.processingMode === "local" && <button type="button" onClick={startFullPrefetch}
                  disabled={demo || !consentGate.canConsent || !consent || allDone || !!translationFailure || (fullPrefetch && enabled)}
                  aria-describedby="watch-full-prefetch-help" className="rounded-xl border border-orange-300 bg-orange-50 px-4 py-2.5 text-sm font-bold text-orange-800 hover:bg-orange-100 disabled:opacity-40">
                  {allDone ? "整片字幕已完成" : fullPrefetch && enabled ? "整片預譯中…" : "預先翻完整片（本機）"}
                </button>}
                <button type="button" onClick={stopTranslation} disabled={demo || !session || stopped} className="rounded-xl border border-gray-200 px-4 py-2.5 text-sm font-bold text-gray-600 hover:bg-gray-50 disabled:opacity-40">停止本次工作</button>
              </div>
              <p id="watch-enable-reason" className="mt-2 text-xs font-semibold text-gray-600">{enableReason}</p>
              <p className="mt-3 text-xs leading-relaxed text-gray-500">{fullPrefetch ? "整片模式即使影片暫停，也會在本頁逐批翻譯；快轉不取消目前批次，完成後優先處理跳轉區段，不會同時送出多批。停止工作、撤回同意或關閉／重新整理本頁會停止排程。" : <>啟用同步翻譯後，按影片播放才送出請求。{processingCopy.processingNote}</>}不是零延遲口譯。</p>
              {session?.processingMode === "local" && <p id="watch-full-prefetch-help" className="mt-2 text-xs leading-relaxed text-gray-500">本機模式在同意並按啟用後，預設逐批翻完整片，暫停影片仍會使用本機算力。每批 8 句、一次一批；完成字幕會保存，再次載入直接使用。電腦休眠或分頁凍結可能暫停處理；個別失敗會明確標示，不能當作全部完成。</p>}
            </section>

            {!sourceError && (visibleError || notice) && <div role={visibleError ? "alert" : "status"} className={`rounded-xl border p-4 text-sm leading-relaxed ${visibleError ? "border-red-200 bg-red-50 text-red-800" : "border-amber-200 bg-amber-50 text-amber-900"}`}>
              {translationFailure && <p className="mb-1 font-bold">{retryRequested ? "上次翻譯錯誤（重試成功前保留）" : failureCopy?.status}</p>}
              {visibleError && <p className="break-words">{visibleError}</p>}
              {notice && <p className="mt-1">{notice}</p>}
              {translationFailure?.recovery === "retry" && <button type="button" onClick={retryCurrentWindow} disabled={!canRetry} className="mt-2 font-bold underline underline-offset-2 disabled:cursor-not-allowed disabled:no-underline disabled:opacity-60">{retryRequested || fullPrefetch ? failureCopy?.button : "重試目前區段（播放時執行）"}</button>}
            </div>}
          </div>

          <section className="overflow-hidden rounded-2xl border border-gray-200 bg-white shadow-sm">
            <div className="border-b border-gray-100 p-5">
              <div className="flex items-center justify-between gap-2"><h2 className="font-bold">同步逐字稿</h2><span className="rounded-full bg-gray-100 px-2.5 py-1 text-[11px] font-semibold text-gray-500">{session ? `${session.language.toUpperCase()} → 繁中` : "EN → 繁中"}</span></div>
              <p aria-live="polite" className={`mt-2 text-xs ${visibleError ? "text-red-600" : "text-orange-600"}`}>{status}</p>
              <div className="mt-4 h-1.5 overflow-hidden rounded-full bg-gray-100"><div className="h-full rounded-full bg-orange-400 transition-all" style={{ width: `${progress}%` }} /></div>
              <div className="mt-2 flex justify-between gap-2 text-[11px] tabular-nums text-gray-500"><span>{translatedCount} / {session?.cues.length || 0} 句已就緒</span><span>{demo ? "示範 · 0 次 API 呼叫" : watchUsageLabel(processingInfo, calls)}</span></div>
              {session && !demo && !allDone && <p className="mt-2 text-xs leading-relaxed text-gray-500">{fullPrefetch ? "已選擇整片預譯：目前批次完成後優先處理最新跳轉缺段，其餘按順序補齊；暫停不會停止排程。個別品質失敗先隔離並繼續，連線或模型失敗則停止等待重試。" : "按播放位置預譯，不是整片一次翻完。暫停時不再送出後續翻譯；未排程的段落會先顯示原文。"}</p>}
            </div>
            <div className="flex items-center justify-between gap-3 border-b border-gray-100 bg-gray-50 px-5 py-3">
              <p id="watch-transcript-follow-help" role="status" className="text-xs leading-relaxed text-gray-600">{transcriptFollowing ? "自動跟隨目前播放；手動捲動可暫停。" : "已暫停跟隨，可自由閱讀逐字稿。"}</p>
              {!transcriptFollowing && <button type="button" onClick={resumeTranscriptFollow} disabled={!session?.cues.length} className="shrink-0 rounded-lg border border-orange-200 bg-white px-3 py-2 text-xs font-bold text-orange-700 hover:bg-orange-50 disabled:opacity-40">恢復自動跟隨</button>}
            </div>
            <div ref={transcriptPanel} id="watch-transcript-list" role="region" tabIndex={0} aria-label="逐句字幕列表" aria-describedby="watch-transcript-follow-help"
              className={`${demo ? "max-h-[320px]" : "max-h-[630px]"} overflow-y-auto overscroll-contain p-2 outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-orange-300`}
              style={{ scrollBehavior: "auto" }}
              onWheelCapture={(event) => { if (event.deltaY !== 0) pauseTranscriptFollow(); }}
              onTouchStart={(event) => { transcriptTouchStart.current = event.touches[0]?.clientY ?? null; }}
              onTouchMove={(event) => { if (transcriptTouchStart.current !== null && Math.abs((event.touches[0]?.clientY ?? transcriptTouchStart.current) - transcriptTouchStart.current) > 4) pauseTranscriptFollow(); }}
              onTouchEnd={() => { transcriptTouchStart.current = null; }}
              onPointerDown={(event) => { if (event.pointerType === "mouse" && event.target === event.currentTarget) pauseTranscriptFollow(); }}
              onKeyDownCapture={(event) => { if (["ArrowUp", "ArrowDown", "PageUp", "PageDown", "Home", "End", " "].includes(event.key)) pauseTranscriptFollow(); }}>

              {session?.cues.length ? session.cues.map((cue, index) => {
                const translated = translations[cue.id];
                const active = cue.start <= time && time < cue.end;
                const waiting = pendingBlock === Math.floor(index / BATCH_SIZE);
                const failed = runtime.current.failed.has(Math.floor(index / BATCH_SIZE));
                return <button type="button" key={cue.id} ref={(element) => { if (element) transcriptRows.current.set(cue.id, element); else transcriptRows.current.delete(cue.id); }} data-cue-id={cue.id} onClick={() => seekTo(cue.start)} aria-current={active ? "true" : undefined} className={`mb-1 block w-full rounded-xl p-3 text-left transition ${active ? "bg-orange-50 ring-1 ring-inset ring-orange-200" : "hover:bg-gray-50"}`}>
                  <div className="mb-1.5 flex items-center gap-2 text-[11px]"><span className="font-mono font-semibold tabular-nums text-orange-600">{timeLabel(cue.start)}</span><span className={translated ? "text-emerald-700" : waiting ? "text-orange-600" : failed ? "text-red-600" : "text-gray-400"}>{demo ? "示範" : translated ? "已完成" : waiting ? "翻譯中" : failed ? "翻譯失敗" : "尚未排程 · 原文"}</span>{active && <span className="ml-auto text-orange-600">目前播放</span>}</div>
                  <p className="text-xs leading-relaxed text-gray-500">{cue.text}</p>
                  {translated && <p className="mt-1.5 text-sm font-medium leading-relaxed text-gray-800">{translated.text}</p>}
                </button>;
              }) : <div className="px-5 py-16 text-center text-sm leading-relaxed text-gray-400">{loading ? "正在尋找英語原文字幕…\n影片可以先播放。" : "載入影片後，原文與譯文會出現在這裡。點選任何一句，就能跳回該段。"}</div>}
            </div>
          </section>
        </div>

        <section className="mt-8 rounded-2xl border border-gray-200 bg-white p-5 sm:p-6" aria-labelledby="watch-chrome-pair-title">
          <div className="flex flex-wrap items-start justify-between gap-4">
            <div className="max-w-3xl"><h2 id="watch-chrome-pair-title" className="text-sm font-bold">Chrome 配對碼 · 在 YouTube 原網站觀看</h2><p className="mt-2 text-sm leading-relaxed text-gray-600">此頁不會替你安裝擴充功能，也不會自動開啟收費翻譯。配對碼預設隱藏；展開後仍會遮蔽內容，可以直接複製，不必顯示明碼。</p></div>
            <button type="button" onClick={revealPair} disabled={demo || pairBusy} aria-expanded={showPair} aria-controls="watch-chrome-pair-panel" className="shrink-0 rounded-xl border border-gray-200 px-4 py-2.5 text-sm font-bold text-gray-700 hover:border-orange-300 disabled:opacity-40">{pairBusy ? "取得配對碼…" : showPair ? "收合 Chrome 配對碼" : "展開 Chrome 配對碼"}</button>
          </div>
          <ol className="mt-4 space-y-2 text-sm leading-relaxed text-gray-600">
            <li><strong>1.</strong> 確認已載入 Chrome 擴充功能；若剛安裝或更新，先<strong>重新整理 YouTube 影片頁</strong>。</li>
            <li><strong>2.</strong> 展開下方配對區，複製本機網址與配對碼，填入擴充功能 popup 的對應欄位。</li>
            <li><strong>3.</strong> {processingCopy.local ? "全本機模式忽略舊的 10／50 批設定，不限總批數；每批 8 段、一次一批的安全控制不變。" : "雲端模式初次測試可設 2 批；這不是金額上限，仍可能產生 API 費用。"}</li>
            <li><strong>4.</strong> 在 popup 確認後端模式並勾選該模式的字幕處理同意，再啟用功能、播放影片。此頁的同意不會取代擴充功能的同意。</li>
          </ol>
          <p className="mt-3 text-xs leading-relaxed text-gray-500">尚未安裝：Chrome 擴充功能頁 → 開啟開發人員模式 → 載入未封裝項目 → 選取專案內 <code className="break-all rounded bg-gray-100 px-1.5 py-0.5">extensions/yt-summary-watch</code>。使用時，本機 YT Summary 服務必須保持開啟；雲端 Project JSON API 不會代跑字幕翻譯。</p>
          {demo && <p className="mt-3 text-xs font-semibold text-orange-700">示範模式不取得配對碼。請切換到正式觀看頁，再連接本機擴充功能。</p>}
          {showPair && pair && <div id="watch-chrome-pair-panel" className="mt-4 rounded-xl border border-orange-200 bg-orange-50 p-4">
            <label htmlFor="watch-server-url" className="mb-2 block text-xs font-bold text-orange-900">本機服務網址（不含 /watch，請保持本機服務開啟）</label>
            <input id="watch-server-url" readOnly value={localServerUrl} onFocus={(event) => event.target.select()} className="mb-4 w-full rounded-lg border border-orange-200 bg-white px-3 py-2 font-mono text-xs text-gray-800" />
            <label htmlFor="watch-pair" className="mb-2 block text-xs font-bold text-orange-900">Chrome 配對碼：僅供本機配對，不是模型 API key，請勿分享或放進網址。</label>
            <div className="flex flex-wrap gap-2">
              <input id="watch-pair" type={showPairValue ? "text" : "password"} autoComplete="off" spellCheck={false} readOnly value={pair.token} onFocus={(event) => event.target.select()} className="min-w-0 flex-[1_1_200px] rounded-lg border border-orange-200 bg-white px-3 py-2 font-mono text-xs text-gray-800" />
              <button type="button" onClick={copyPair} className="shrink-0 rounded-lg bg-white px-3 py-2 text-xs font-bold text-orange-700 ring-1 ring-orange-200">複製配對碼</button>
              <button type="button" onClick={() => setShowPairValue((visible) => !visible)} aria-pressed={showPairValue} className="shrink-0 rounded-lg px-3 py-2 text-xs font-semibold text-orange-800 underline underline-offset-2">{showPairValue ? "遮蔽內容" : "顯示內容"}</button>
            </div>
            <p className="mt-2 text-xs text-orange-800">配對碼目前{showPairValue ? "以明碼顯示，分享螢幕或截圖前請先遮蔽" : "已遮蔽；「複製配對碼」仍可直接使用"}。</p>
          </div>}
          {copyMessage && <p role="status" className="mt-2 text-xs text-gray-600">{copyMessage}</p>}
        </section>

        <section className="mt-5 rounded-2xl border border-gray-200 bg-white p-5 sm:p-6" aria-labelledby="watch-audio-v2-title">
          <div className="mb-3 flex flex-wrap items-center gap-2"><h2 id="watch-audio-v2-title" className="text-sm font-bold">V2 / 分頁音訊模式說明</h2><span className="rounded-full bg-gray-100 px-2 py-1 text-[11px] font-semibold text-gray-500">另一條流程 · 需手動啟用與另外同意</span></div>
          <p className="text-sm leading-relaxed text-gray-600">無法取得字幕時，收音必須由 <strong>Chrome 擴充功能</strong>手動啟動；不是從本頁的 YouTube iframe 讀取音訊。只擷取所選分頁播放的聲音，<strong>不使用麥克風</strong>，並每次另行確認{processingCopy.local ? "在本機進行音訊辨識與翻譯；本機模式不按段數收費、可持續至停止" : "音訊傳送與雲端辨識／翻譯費用"}。</p>
          <div className="mt-4 grid gap-3 text-sm sm:grid-cols-3">
            <div className="rounded-xl bg-gray-50 p-3"><p className="font-bold text-gray-800">1 / 手動收 12 秒</p><p className="mt-1 text-xs leading-relaxed text-gray-600">在擴充功能啟動收音；先累積一段 12 秒音訊，不是邊聽邊零延遲輸出。</p></div>
            <div className="rounded-xl bg-gray-50 p-3"><p className="font-bold text-gray-800">2 / 辨識，再翻譯</p><p className="mt-1 text-xs leading-relaxed text-gray-600">收音完成後才辨識原文、套用術語翻譯；{processingCopy.local ? "另加上本機模型運算時間，不需要外部模型 API" : "另加上模型處理與網路等待時間"}。</p></div>
            <div className="rounded-xl bg-gray-50 p-3"><p className="font-bold text-gray-800">3 / 看晚到逐字稿</p><p className="mt-1 text-xs leading-relaxed text-gray-600">結果保留對應的原影片時間，可跳回該段重播；不把晚到文字假裝成當下同步字幕。</p></div>
          </div>
          <p className="mt-3 text-xs leading-relaxed text-gray-500">本頁沒有收音按鈕，也不會因開啟頁面自動錄音。V2 不保證直播可用或零延遲；只有播放器仍可回看的片段才能回放。</p>
        </section>
      </div>
    </main>
  );
}
