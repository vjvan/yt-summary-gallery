"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { ReviewCandidate, ReviewResponse, RiskFlag } from "@/lib/review/types";

const FLAG_LABEL: Record<RiskFlag["code"], string> = {
  negation: "否定", magnitude: "量級", quantity: "數字", question: "問句", foreground: "前後景", fragment: "片段", comparison: "比較", idiom: "慣用語", pronoun: "代名詞",
};
const button = "min-h-11 rounded-lg border px-4 py-2 text-base font-bold focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-orange-700 disabled:cursor-not-allowed disabled:opacity-50";
const small = "min-h-9 rounded-md border px-3 py-1 text-sm font-bold focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-orange-700 disabled:cursor-not-allowed disabled:opacity-50";

function localTime(iso: string) {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return iso;
  const pad = (value: number) => String(value).padStart(2, "0");
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

function clock(seconds: number) {
  const total = Math.max(0, Math.floor(seconds));
  const h = Math.floor(total / 3600), m = Math.floor(total / 60) % 60, s = total % 60;
  return `${h ? `${h}:` : ""}${h ? String(m).padStart(2, "0") : m}:${String(s).padStart(2, "0")}`;
}

async function reviewResponse(response: Response): Promise<ReviewResponse> {
  const result = await response.json().catch(() => null);
  if (!response.ok) throw new Error(typeof result?.error === "string" ? result.error : "語意校訂資料暫時無法讀取，請稍後手動重試。");
  if (!result || !["idle", "running", "complete", "partial", "failed", "cancelled"].includes(result.status) || !Array.isArray(result.candidates)) {
    throw new Error("語意校訂資料格式不完整，請重新查詢；不會自動開始校訂。");
  }
  return result as ReviewResponse;
}

interface WindowGroup { key: string; start: number; end: number; flags: RiskFlag[]; score: number; items: ReviewCandidate[] }

interface Props {
  id: string;
  onSeek: (seconds: number) => void;
  /** 分頁是否在前景：不在前景時不輪詢，回到前景時重新讀一次。 */
  active?: boolean;
  /** 套用或還原成功後通知父頁重讀字幕，讓逐字稿與 overlay 同步。 */
  onChanged?: () => void;
}

export default function SubtitleReviewPanel({ id, onSeek, active = true, onChanged }: Props) {
  const [response, setResponse] = useState<ReviewResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  // 讀取錯誤與操作錯誤分開：背景同步成功不能清掉「套用失敗」這種需要人看到的提示。
  const [loadError, setLoadError] = useState("");
  const [busy, setBusy] = useState("");
  const [onlyChanged, setOnlyChanged] = useState(true);
  const [limit, setLimit] = useState(40);
  const aliveRef = useRef(true);
  // 每個請求帶序號：慢到的舊 GET 不能蓋掉新操作的結果，也不能把輪詢狀態退回去。
  const seqRef = useRef(0);
  // 修改請求進行中時不發 GET，完成後強制重讀；避免較早快照的 GET 晚到蓋掉提交結果。
  const mutatingRef = useRef(false);
  const url = `/api/summaries/${encodeURIComponent(id)}/subtitle-review`;

  const load = useCallback(async () => {
    if (mutatingRef.current) return;
    const seq = ++seqRef.current;
    try {
      const next = await reviewResponse(await fetch(url, { cache: "no-store" }));
      if (aliveRef.current && seq === seqRef.current) { setResponse(next); setLoadError(""); }
    } catch (cause) {
      if (aliveRef.current && seq === seqRef.current) setLoadError(cause instanceof Error ? cause.message : "無法讀取語意校訂資料。");
    } finally { if (aliveRef.current) setLoading(false); }
  }, [url]);

  useEffect(() => { aliveRef.current = true; return () => { aliveRef.current = false; }; }, []);
  useEffect(() => { if (active) void load(); }, [active, load]);
  useEffect(() => {
    if (!active || response?.status !== "running") return;
    const timer = setInterval(() => { void load(); }, 2500);
    return () => clearInterval(timer);
  }, [active, response?.status, load]);

  async function send(method: "POST" | "PATCH", body: Record<string, unknown>, label: string) {
    if (busy || mutatingRef.current) return;
    mutatingRef.current = true;
    ++seqRef.current;
    setBusy(label); setError("");
    try {
      const next = await reviewResponse(await fetch(url, { method, headers: { "Content-Type": "application/json" }, cache: "no-store", body: JSON.stringify(body) }));
      if (!aliveRef.current) return;
      // 修改的回應永遠是最新狀態，直接採用；之後再強制讀一次同步。
      setResponse(next);
      if (body.action === "apply" || body.action === "revert" || body.action === "reapply") {
        onChanged?.();
        const failed = (next as ReviewResponse & { applied?: number; reverted?: number }).exportError;
        if (failed) setError(failed);
      }
    } catch (cause) {
      if (aliveRef.current) setError(cause instanceof Error ? cause.message : "操作未完成。");
    } finally {
      mutatingRef.current = false;
      if (aliveRef.current) { setBusy(""); void load(); }
    }
  }

  const groups = useMemo<WindowGroup[]>(() => {
    if (!response) return [];
    const byKey = new Map<string, ReviewCandidate[]>();
    for (const item of response.candidates) {
      if (onlyChanged && !item.changed && item.decision !== "applied") continue;
      const list = byKey.get(item.windowKey) ?? [];
      list.push(item);
      byKey.set(item.windowKey, list);
    }
    return response.windows.filter(window => byKey.has(window.key)).map(window => ({ key: window.key, start: window.start, end: window.end, flags: window.flags, score: window.score, items: byKey.get(window.key)!.sort((a, b) => a.cueIndex - b.cueIndex) }));
  }, [response, onlyChanged]);

  if (loading && !response) return <p className="rounded-xl border border-stone-200 bg-white p-5 text-base leading-7 text-stone-600">正在讀取語意校訂狀態…</p>;
  if (!response) return <p role="alert" className="rounded-xl border border-red-200 bg-red-50 p-5 text-base leading-7 text-red-800">{loadError || error || "無法讀取語意校訂資料。"}</p>;

  const running = response.status === "running";
  // 跟後端一樣：舊版校訂的候選不算已完成，除非那句已寫回。
  const covered = new Set(response.candidates.filter(item => !item.outdated || item.decision === "applied").map(item => item.windowKey));
  const remainingFlagged = response.windows.filter(window => window.flagged && !covered.has(window.key)).length;
  const approvedChanged = response.candidates.filter(item => item.decision === "approved" && item.changed).length;
  const hashOK = !!response.sourceHash;

  return (
    <section aria-label="字幕語意校訂" className="space-y-5">
      <header className="rounded-xl border border-stone-200 bg-white p-5">
        <h2 className="text-xl font-bold text-stone-900">字幕語意校訂</h2>
        <p className="mt-2 text-base leading-7 text-stone-600">把一段完整話語連前後文一起重譯（本機模型，只依原文不看舊譯），結果只是候選：逐句採用後按「套用」才會寫回字幕，套用前的版本永遠可以還原。優先處理否定、量級、問句、前後景對不上的句子。</p>
        <dl className="mt-4 grid grid-cols-2 gap-3 text-sm sm:grid-cols-4">
          <div className="rounded-lg bg-stone-50 p-3"><dt className="text-stone-500">話語視窗</dt><dd className="text-2xl font-bold text-stone-900">{response.counts.windows}</dd><dd className="text-stone-600">高風險 {response.counts.flaggedWindows}，未校訂 {remainingFlagged}</dd></div>
          <div className="rounded-lg bg-stone-50 p-3"><dt className="text-stone-500">候選句</dt><dd className="text-2xl font-bold text-stone-900">{response.counts.candidates}</dd><dd className="text-stone-600">與現行不同 {response.counts.changed}{response.model ? ` · 模型 ${response.model}` : ""}</dd></div>
          <div className="rounded-lg bg-stone-50 p-3"><dt className="text-stone-500">已採用</dt><dd className="text-2xl font-bold text-stone-900">{response.counts.approved}</dd><dd className="text-stone-600">已退回 {response.counts.rejected}</dd></div>
          <div className="rounded-lg bg-stone-50 p-3"><dt className="text-stone-500">已寫回字幕</dt><dd className="text-2xl font-bold text-stone-900">{response.counts.applied}</dd><dd className="text-stone-600">{response.lastAppliedAt ? `最近 ${localTime(response.lastAppliedAt)}` : "尚未套用"}</dd></div>
        </dl>
        <p role="status" className={`mt-4 text-sm leading-6 ${response.status === "failed" ? "text-red-700" : "text-stone-700"}`}>
          {running ? `處理中 ${response.progress.completed}/${response.progress.total}：` : ""}{response.progress.message}
        </p>
        {response.error && <p role="alert" className="mt-2 rounded-lg bg-amber-50 p-3 text-sm leading-6 text-amber-900">{response.error}</p>}
        {response.exportError && (
          <div role="alert" className="mt-2 flex flex-wrap items-center gap-3 rounded-lg bg-red-50 p-3 text-sm leading-6 text-red-800">
            <span className="min-w-0 flex-1">{response.exportError}</span>
            <button type="button" onClick={() => send("PATCH", { action: "export" }, "export")} disabled={!!busy} className={`${small} border-red-300 bg-white text-red-800 hover:bg-red-100`}>{busy === "export" ? "匯出中…" : "重新匯出字幕檔"}</button>
          </div>
        )}
        {response.outdated > 0 && (
          <p role="status" className="mt-2 rounded-lg bg-stone-100 p-3 text-sm leading-6 text-stone-700">有 {response.outdated} 句候選來自舊版校訂邏輯（句界可能偏一句），按該窗的「重新校訂本窗」或「校訂高風險視窗」會用新邏輯重譯。</p>
        )}
        {response.drifted > 0 && (
          <div role="alert" className="mt-2 flex flex-wrap items-center gap-3 rounded-lg bg-amber-50 p-3 text-sm leading-6 text-amber-900">
            <span className="min-w-0 flex-1">有 {response.drifted} 句已寫回的譯文之後被其他工作（例如整片重新翻譯）覆蓋。可重新套用這些句子，或保留現況。</span>
            <button type="button" onClick={() => { if (confirm(`把 ${response.drifted} 句已寫回的譯文重新套用到目前字幕。要繼續嗎？`)) void send("PATCH", { action: "reapply", sourceHash: response.sourceHash }, "reapply"); }} disabled={!!busy || running || !hashOK}
              className={`${small} border-amber-400 bg-white text-amber-900 hover:bg-amber-100`}>{busy === "reapply" ? "套用中…" : "重新套用"}</button>
          </div>
        )}
        {loadError && <p role="alert" className="mt-2 rounded-lg bg-amber-50 p-3 text-sm leading-6 text-amber-900">{loadError}</p>}
        {error && error !== response.exportError && <p role="alert" className="mt-2 rounded-lg bg-red-50 p-3 text-sm leading-6 text-red-800">{error}</p>}
        <div className="mt-4 flex flex-wrap items-center gap-2">
          <label className="flex items-center gap-2 text-sm text-stone-700">每輪最多
            <input type="number" min={1} max={200} value={limit} onChange={event => setLimit(Math.min(200, Math.max(1, Number(event.target.value) || 1)))} disabled={running || !!busy}
              className="w-20 rounded-md border border-stone-300 px-2 py-1 text-base" /> 個視窗
          </label>
          <button type="button" onClick={() => send("POST", { action: "start", scope: "flagged", limit }, "start")} disabled={running || !!busy || remainingFlagged === 0}
            className={`${button} border-stone-900 bg-stone-900 text-white hover:bg-stone-700`}>{busy === "start" ? "啟動中…" : "校訂高風險視窗"}</button>
          <button type="button" onClick={() => send("POST", { action: "start", scope: "all", limit }, "start-all")} disabled={running || !!busy}
            className={`${button} border-stone-300 bg-white text-stone-800 hover:bg-stone-100`}>{busy === "start-all" ? "啟動中…" : "校訂其餘視窗"}</button>
          {running && <button type="button" onClick={() => send("POST", { action: "cancel" }, "cancel")} disabled={!!busy} className={`${button} border-red-200 bg-white text-red-700 hover:bg-red-50`}>取消</button>}
          <span className="mx-1 h-6 w-px bg-stone-200" aria-hidden="true" />
          <button type="button" onClick={() => { if (confirm(`把已採用的 ${approvedChanged} 句寫回字幕與 SRT。已燒錄的 MP4 不會自動重燒；套用前的版本可還原。要繼續嗎？`)) void send("PATCH", { action: "apply", sourceHash: response.sourceHash }, "apply"); }}
            disabled={running || !!busy || !hashOK || approvedChanged === 0} className={`${button} border-emerald-700 bg-emerald-700 text-white hover:bg-emerald-800`}>{busy === "apply" ? "套用中…" : `套用已採用的 ${approvedChanged} 句`}</button>
          <button type="button" onClick={() => { if (confirm("還原上一批套用，字幕回到套用前的譯文。要繼續嗎？")) void send("PATCH", { action: "revert" }, "revert"); }}
            disabled={running || !!busy || !response.lastAppliedAt} className={`${button} border-stone-300 bg-white text-stone-800 hover:bg-stone-100`}>{busy === "revert" ? "還原中…" : "還原上一批"}</button>
        </div>
      </header>

      <div className="flex flex-wrap items-center justify-between gap-2">
        <label className="flex items-center gap-2 text-sm text-stone-700"><input type="checkbox" checked={onlyChanged} onChange={event => setOnlyChanged(event.target.checked)} />只看與現行譯文不同的句子</label>
        <span className="text-sm text-stone-500">{groups.length} 個視窗</span>
      </div>

      {groups.length === 0 && <p className="rounded-xl border border-dashed border-stone-300 bg-white p-6 text-center text-base leading-7 text-stone-600">{response.candidates.length ? "目前沒有符合篩選的候選。" : "還沒有候選。按「校訂高風險視窗」開始，本機模型會逐個視窗重譯。"}</p>}

      {groups.map(group => {
        const pending = group.items.filter(item => item.decision === "candidate" && item.changed).map(item => item.cueIndex);
        return (
          <article key={group.key} className="rounded-xl border border-stone-200 bg-white">
            <header className="flex flex-wrap items-center justify-between gap-2 border-b border-stone-100 px-4 py-3">
              <div className="flex flex-wrap items-center gap-2">
                <button type="button" onClick={() => onSeek(group.start)} className="rounded-md bg-stone-100 px-2 py-1 font-mono text-sm text-stone-800 hover:bg-stone-200" title="跳到影片這個位置">{clock(group.start)}–{clock(group.end)}</button>
                {group.flags.map(flag => <span key={flag.code} title={flag.detail} className="rounded-full bg-amber-50 px-2 py-0.5 text-xs font-bold text-amber-900">{FLAG_LABEL[flag.code]}</span>)}
                <span className="text-xs text-stone-500">風險 {group.score}</span>
              </div>
              <div className="flex flex-wrap items-center gap-2">
                <button type="button" onClick={() => send("POST", { action: "start", scope: "windows", windowKeys: [group.key] }, `rerun-${group.key}`)} disabled={!!busy || running}
                  title="用本機模型重譯這一窗，已採用但文字不同的句子會回到候選" className={`${small} border-stone-200 bg-white text-stone-600 hover:bg-stone-100`}>{busy === `rerun-${group.key}` ? "啟動中…" : "重新校訂本窗"}</button>
                <button type="button" onClick={() => send("PATCH", { action: "approve", sourceHash: response.sourceHash, cueIndexes: pending }, `approve-${group.key}`)} disabled={!!busy || running || !hashOK || pending.length === 0}
                  className={`${small} border-stone-300 bg-white text-stone-800 hover:bg-stone-100`}>採用本窗 {pending.length} 句</button>
              </div>
            </header>
            <ul className="divide-y divide-stone-100">
              {group.items.map(item => (
                <li key={item.cueIndex} className="grid gap-2 px-4 py-3 lg:grid-cols-[minmax(0,1fr)_minmax(0,1fr)_minmax(0,1fr)_auto]">
                  <div><p className="text-xs text-stone-500">原文 · <button type="button" onClick={() => onSeek(item.start)} className="font-mono hover:underline">{clock(item.start)}</button></p><p className="text-sm leading-6 text-stone-800">{item.source}</p></div>
                  <div><p className="text-xs text-stone-500">現行譯文</p><p className={`text-sm leading-6 ${item.changed ? "text-stone-500 line-through decoration-stone-300" : "text-stone-800"}`}>{item.current ?? "（尚未翻譯）"}</p></div>
                  <div>
                    <p className="text-xs text-stone-500">候選譯文{item.decision === "applied" ? " · 已寫回" : item.decision === "approved" ? " · 已採用" : item.decision === "rejected" ? " · 已退回" : ""}{item.outdated && item.decision !== "applied" ? <span className="ml-1 rounded bg-stone-200 px-1 text-[11px] text-stone-700">舊版</span> : null}</p>
                    <p className={`text-sm leading-6 ${item.changed ? "font-medium text-stone-900" : "text-stone-500"}`}>{item.candidate}</p>
                    {item.notes.map(note => <p key={note} className="mt-1 text-xs leading-5 text-amber-800">{note}</p>)}
                  </div>
                  <div className="flex flex-row gap-2 lg:flex-col">
                    {item.decision === "applied" ? <span className="text-xs text-emerald-800">已寫回</span> : (
                      <>
                        <button type="button" onClick={() => send("PATCH", { action: "approve", sourceHash: response.sourceHash, cueIndexes: [item.cueIndex] }, `approve-${item.cueIndex}`)} disabled={!!busy || running || !hashOK || item.decision === "approved" || !item.changed}
                          className={`${small} border-emerald-600 text-emerald-800 hover:bg-emerald-50`}>採用</button>
                        <button type="button" onClick={() => send("PATCH", { action: "reject", sourceHash: response.sourceHash, cueIndexes: [item.cueIndex] }, `reject-${item.cueIndex}`)} disabled={!!busy || running || !hashOK || item.decision === "rejected"}
                          className={`${small} border-stone-300 text-stone-700 hover:bg-stone-100`}>退回</button>
                        {item.decision !== "candidate" && <button type="button" onClick={() => send("PATCH", { action: "reset", sourceHash: response.sourceHash, cueIndexes: [item.cueIndex] }, `reset-${item.cueIndex}`)} disabled={!!busy || running || !hashOK}
                          className={`${small} border-stone-200 text-stone-500 hover:bg-stone-50`}>撤銷</button>}
                      </>
                    )}
                  </div>
                </li>
              ))}
            </ul>
          </article>
        );
      })}
    </section>
  );
}
