"use client";

import { useEffect, useRef, useState } from "react";
import type { LearningAnalysis, LearningDisposition, LearningPatchPayload, LearningPoint, LearningResponse } from "@/lib/learning/types";

const DISPOSITIONS: Record<LearningDisposition, string> = { now: "現在試做", later: "保留備用", understand: "僅供理解", skip: "不採用" };
const QUESTIONS: [keyof LearningPoint["assessment"], string][] = [
  ["credible", "這個觀點可信嗎？"], ["relevant", "跟我的目標有關嗎？"], ["changes", "會改變判斷或做法嗎？"],
  ["feasible", "現在做得到嗎？"], ["verifiable", "能用小實驗驗證嗎？"],
];
const ANSWERS = { yes: "是", no: "否", uncertain: "待確認" };
const button = "min-h-11 rounded-lg border px-4 py-2 text-base font-bold focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-orange-700 disabled:cursor-not-allowed disabled:opacity-50";
const input = "w-full rounded-lg border border-stone-300 bg-white px-3 py-2 text-base leading-7 text-stone-900 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-orange-700 disabled:bg-stone-100";

function timestamp(seconds: number) {
  const total = Math.max(0, Math.floor(seconds));
  const h = Math.floor(total / 3600), m = Math.floor(total / 60) % 60, s = total % 60;
  return `${h ? `${h}:` : ""}${h ? String(m).padStart(2, "0") : m}:${String(s).padStart(2, "0")}`;
}

/** datetime-local needs this computer's wall time, not an ISO UTC string slice. */
export function localDatetimeValue(date = new Date()): string {
  const pad = (value: number) => String(value).padStart(2, "0");
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

async function learningResponse(response: Response): Promise<LearningResponse> {
  const result = await response.json().catch(() => null);
  if (!response.ok) throw new Error(typeof result?.error === "string" ? result.error : "學習資料暫時無法讀取，請稍後手動重試。");
  if (!result || !["idle", "running", "complete", "partial", "failed", "cancelled"].includes(result.status)
    || !result.progress || !(result.analysis === null || Array.isArray(result.analysis?.points))) {
    throw new Error("學習資料格式不完整，請重新查詢；不會自動開始分析。");
  }
  return result as LearningResponse;
}

export default function LearningAnalysisPanel({ id, onSeek }: { id: string; onSeek: (seconds: number) => void }) {
  const [response, setResponse] = useState<LearningResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState("");
  const [actionError, setActionError] = useState("");
  const [consent, setConsent] = useState(false);
  const [action, setAction] = useState<"generate" | "cancel" | null>(null);
  const [refreshVersion, setRefreshVersion] = useState(0);
  const [view, setView] = useState<"private" | "public">("private");
  const mutationRef = useRef<AbortController | null>(null);
  const running = response?.status === "running";
  const analysis = response?.analysis || null;
  const editorialReview = analysis?.editorialReview?.kind === "assistant-source-review" && analysis.editorialReview.scope === "transcript-only" ? analysis.editorialReview : null;
  const canGenerate = response != null && !running && response.status !== "complete";

  // GET-only observation. Opening old data and reconnecting can never trigger a model.
  useEffect(() => {
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    const deadline = Date.now() + 30 * 60_000;
    setLoading(true); setLoadError("");
    const read = async () => {
      try {
        const next = await learningResponse(await fetch(`/api/summaries/${encodeURIComponent(id)}/learning`, {
          cache: "no-store", signal: AbortSignal.any([controller.signal, AbortSignal.timeout(15_000)]),
        }));
        if (controller.signal.aborted) return;
        setResponse(next);
        if (next.status === "running") {
          if (Date.now() >= deadline) setLoadError("進度查詢已達 30 分鐘；後端可能仍在分析。請手動重新查詢，不會重送模型請求。");
          else timer = setTimeout(read, 3000);
        }
      } catch (cause) {
        if (!controller.signal.aborted) setLoadError(cause instanceof Error ? cause.message : "無法取得分析進度，請手動重新查詢。");
      } finally { if (!controller.signal.aborted) setLoading(false); }
    };
    void read();
    return () => { controller.abort(); if (timer) clearTimeout(timer); };
  }, [id, refreshVersion]);

  useEffect(() => () => { mutationRef.current?.abort(); mutationRef.current = null; }, [id]);

  async function run(nextAction: "generate" | "cancel") {
    if (mutationRef.current || (nextAction === "generate" && (!consent || !canGenerate))) return;
    const controller = new AbortController();
    mutationRef.current = controller;
    setAction(nextAction); setActionError("");
    try {
      const next = await learningResponse(await fetch(`/api/summaries/${encodeURIComponent(id)}/learning`, {
        method: "POST", headers: { "Content-Type": "application/json" }, cache: "no-store",
        body: JSON.stringify(nextAction === "generate" ? { action: "generate", consent: true } : { action: "cancel" }),
        signal: AbortSignal.any([controller.signal, AbortSignal.timeout(15_000)]),
      }));
      if (controller.signal.aborted) return;
      setResponse(next); setConsent(false); setRefreshVersion(previous => previous + 1);
    } catch (cause) {
      if (!controller.signal.aborted) setActionError(cause instanceof Error ? cause.message : "本機分析請求失敗，不會改送雲端。請先重新查詢狀態再決定是否重試。");
    } finally {
      if (mutationRef.current === controller) { mutationRef.current = null; setAction(null); }
    }
  }

  async function save(payload: LearningPatchPayload): Promise<void> {
    if (mutationRef.current) throw new Error("上一個儲存或分析請求尚未完成，請稍候。");
    const controller = new AbortController(); mutationRef.current = controller;
    try {
      const next = await learningResponse(await fetch(`/api/summaries/${encodeURIComponent(id)}/learning`, {
        method: "PATCH", headers: { "Content-Type": "application/json" }, cache: "no-store", body: JSON.stringify(payload),
        signal: AbortSignal.any([controller.signal, AbortSignal.timeout(15_000)]),
      }));
      if (!controller.signal.aborted) setResponse(next);
    } finally { if (mutationRef.current === controller) mutationRef.current = null; }
  }

  return (
    <section aria-labelledby="learning-title" className="min-w-0 space-y-6 text-stone-900">
      <header className="rounded-2xl border border-stone-200 bg-[#faf9f6] p-5 sm:p-7">
        <p className="mb-2 text-sm font-bold tracking-wider text-orange-800">有證據的三層學習</p>
        <h2 id="learning-title" className="text-2xl font-bold leading-snug sm:text-3xl">從原片觀點，到自己的判斷</h2>
        <p className="mt-3 max-w-3xl text-base leading-8 text-stone-600">原片說了什麼、模型怎麼分析、對允雷有什麼用途，分開呈現。每個觀點保留原文與時間戳；有理由才採用，不用總分代替思考。</p>
        <div className="mt-5 flex flex-wrap gap-2" role="group" aria-label="學習資料與公開草稿">
          <button type="button" aria-pressed={view === "private"} onClick={() => setView("private")} className={`${button} ${view === "private" ? "border-stone-900 bg-stone-900 text-white" : "border-stone-300 bg-white text-stone-700"}`}>私人學習</button>
          <button type="button" aria-pressed={view === "public"} onClick={() => setView("public")} className={`${button} ${view === "public" ? "border-stone-900 bg-stone-900 text-white" : "border-stone-300 bg-white text-stone-700"}`}>公開 Carousel 草稿</button>
        </div>
        <p className="mt-3 text-sm leading-7 text-stone-600">{view === "private" ? "這裡的用途建議、採用理由與實作結果是私人學習資料，不會寫進公開 Carousel。" : "僅預覽待語意覆核的來源觀點草稿；不顯示私人用途、分類、目標或筆記。尚未發布，也不會覆蓋既有 20 頁圖卡。"}</p>
      </header>

      <section aria-label="本機學習分析狀態" className="rounded-xl border border-stone-200 bg-white p-5">
        <h3 className="text-lg font-bold">{loading && !response ? "正在讀取學習資料…" : running ? "本機分析進行中" : response?.status === "idle" ? "尚未分析" : response?.status === "complete" ? editorialReview ? "助理校訂示範已保存" : "本次分析已完成" : response?.status === "partial" ? "分析部分完成" : response?.status === "cancelled" ? "本次分析已取消" : response?.status === "failed" ? "本次分析未完成" : "尚未取得分析狀態"}</h3>
        {response?.status === "idle" && <p className="mt-2 text-base leading-7 text-stone-600">這支影片還沒有三層學習分析。既有摘要與圖卡維持原樣，不會自動啟動模型。</p>}
        {running && <div className="mt-3 space-y-2" role="status" aria-live="polite">
          <p className="text-base leading-7">{response?.progress.message || "正在整理來源與檢查證據…"}</p>
          {response && response.progress.total > 0 && <><progress aria-label="目前分析階段進度" value={Math.min(response.progress.completed, response.progress.total)} max={response.progress.total} className="h-2 w-full accent-orange-700" /><p className="text-sm text-stone-600">目前階段 {response.progress.completed}／{response.progress.total}；這是處理進度，不是內容可信度分數。</p></>}
          <p className="text-sm leading-7 text-stone-600">只在本機執行，不回退到雲端。關閉或切換這個頁面不等於取消工作；本機服務需保持開啟。</p>
        </div>}
        {response?.error && <p role="alert" className="mt-3 rounded-lg bg-amber-50 p-3 text-base leading-7 text-amber-950">{response.error}</p>}
        {loadError && <p role="alert" className="mt-3 rounded-lg bg-red-50 p-3 text-base leading-7 text-red-800">{loadError}</p>}
        {actionError && <p role="alert" className="mt-3 rounded-lg bg-red-50 p-3 text-base leading-7 text-red-800">{actionError}</p>}
        {(loadError || actionError) && <button type="button" onClick={() => setRefreshVersion(previous => previous + 1)} disabled={action != null} className={`${button} mt-3 border-stone-300 bg-white`}>重新查詢狀態（不重跑）</button>}
        {running && <button type="button" onClick={() => void run("cancel")} disabled={action != null} className={`${button} mt-4 border-stone-300 bg-white`}>{action === "cancel" ? "正在取消…" : "取消本次分析"}</button>}
        {canGenerate && <div className="mt-4 border-t border-stone-200 pt-4">
          <label className="flex cursor-pointer items-start gap-3 text-base leading-7">
            <input type="checkbox" checked={consent} onChange={event => setConsent(event.target.checked)} disabled={action != null} className="mt-1 h-5 w-5 shrink-0 accent-orange-700" />
            <span>我同意使用本機模型，根據原文及已授權的學習目標分析。內容不送雲端、不產生雲端模型費用，但會消耗本機 CPU／GPU、記憶體與電力。</span>
          </label>
          <button type="button" onClick={() => void run("generate")} disabled={!consent || action != null} className={`${button} mt-4 border-stone-900 bg-stone-900 text-white`}>{action === "generate" ? "正在啟動…" : response?.status === "idle" ? "開始本機學習分析" : "重試／接續本機分析"}</button>
          <p className="mt-2 text-sm leading-7 text-stone-600">{response?.status === "idle" ? "只在你按下按鈕後啟動，不會修改原有字幕或圖卡。" : "重用可用的分析進度；不會因重新整理或查詢狀態而重複啟動。已保存的學習資料會保留。"}</p>
        </div>}
      </section>

      {editorialReview && <aside aria-label="助理校訂示範與查證限制" className="rounded-xl border-2 border-amber-700 bg-amber-50 p-5 text-amber-950 sm:p-6">
        <h3 className="text-lg font-bold leading-8">助理對照原文校訂示範｜未獨立查證／未驗證實作效益</h3>
        <p className="mt-2 text-base leading-8">原模型草稿 {editorialReview.originalPointCount} 個；本次重新選題、校訂示範 {editorialReview.retainedPointCount} 個。這是助理編輯校訂的示範，不是本機模型原樣輸出，也不是人類查證結果。</p>
        <p className="mt-2 text-base leading-8">範圍僅限逐字稿；未驗證影片畫面、外部事實或實作效益。校訂時間：<time dateTime={editorialReview.reviewedAt}>{editorialReview.reviewedAt}</time></p>
        {view === "private" && editorialReview.notes.length > 0 && <ul className="mt-3 list-disc space-y-2 pl-5 text-base leading-8">{editorialReview.notes.map((note, index) => <li key={index} className="whitespace-pre-wrap [overflow-wrap:anywhere]">{note}</li>)}</ul>}
        {view === "public" && <p className="mt-2 text-sm leading-7">公開預覽不帶入私人校訂筆記；來源轉述仍待覆核，不代表可直接發布。</p>}
      </aside>}

      {analysis && view === "private" && <>
        <section aria-label="來源覆蓋與分析限制" className="rounded-xl border border-stone-200 bg-white p-5">
          <h3 className="text-lg font-bold">{editorialReview ? "原模型處理範圍（非校訂後的全片驗證率）" : "先看這次分析的範圍"}</h3>
          {editorialReview && <p className="mt-2 text-base leading-8 text-amber-900">下列數字僅保留原模型處理歷程，不代表助理逐一驗證了全片、所有候選或實作效果。</p>}
          <p className="mt-2 text-base leading-8 text-stone-700">已處理 {analysis.coverage.processedChunks}／{analysis.coverage.totalChunks} 段來源、{analysis.coverage.processedSourceLines}／{analysis.coverage.totalSourceLines} 行字幕；已分析 {analysis.coverage.analyzedCandidates}／{analysis.coverage.candidateCount} 個候選觀點。</p>
          <p className="mt-2 text-sm leading-7 text-stone-600">未成功段落 {analysis.coverage.failedChunks.length}；未解析行數 {analysis.coverage.unparsedLines}；未通過引用檢查 {analysis.coverage.invalidEvidenceCount}；來源檢查／模型覆核排除 {analysis.coverage.unsupportedInterpretations}。讀完全部字幕不等於完整理解，也不表示原片主張已獨立查證。</p>
          {analysis.coverage.limitations.length > 0 && <ul className="mt-3 list-disc space-y-1 pl-5 text-base leading-7 text-amber-900">{analysis.coverage.limitations.map((limit, index) => <li key={index}>{limit}</li>)}</ul>}
          <details className="mt-4 border-t border-stone-200 pt-3"><summary className="cursor-pointer text-base font-bold">這次使用的私人學習目標</summary><ul className="mt-2 list-disc pl-5 text-base leading-8 text-stone-700">{analysis.profileSnapshot.goals.map((goal, index) => <li key={index}>{goal}</li>)}</ul><p className="mt-2 text-sm text-stone-500">模型：{analysis.model} · 分析版本：{analysis.version}</p></details>
        </section>
        {analysis.points.length === 0 ? <p className="rounded-xl border border-stone-200 bg-white p-5 text-base leading-8">目前沒有足夠證據支持的學習觀點，不為了湊數補寫結論。</p> : <div className="space-y-5">{analysis.points.map((point, index) => <LearningPointReview key={`${analysis.sourceHash}:${point.id}`} point={point} sourceHash={analysis.sourceHash} index={index} reviewed={editorialReview != null} disabled={running || action != null} onSeek={onSeek} onSave={save} />)}</div>}
      </>}
      {analysis && view === "public" && <LearningPublicPreview publicCards={analysis.publicCards} reviewed={editorialReview != null} onSeek={onSeek} />}
      {!analysis && view === "public" && <p className="rounded-xl border border-dashed border-stone-300 bg-white p-6 text-base leading-8 text-stone-600">尚無公開草稿。需先手動分析並取得足夠的來源證據；這裡不會用私人用途或實作筆記補足 20 頁。</p>}
    </section>
  );
}

export function LearningPointReview({ point, sourceHash, index, reviewed = false, disabled, onSeek, onSave }: {
  point: LearningPoint; sourceHash: string; index: number; reviewed?: boolean; disabled: boolean;
  onSeek: (seconds: number) => void; onSave: (payload: LearningPatchPayload) => Promise<void>;
}) {
  const [disposition, setDisposition] = useState(point.disposition);
  const [reason, setReason] = useState(point.reason);
  const [practiceAction, setPracticeAction] = useState("");
  const [practiceResult, setPracticeResult] = useState("");
  const [observedAt, setObservedAt] = useState("");
  const [saving, setSaving] = useState<"classification" | "implementation" | null>(null);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const savingRef = useRef(false);
  const changed = disposition !== point.disposition || reason !== point.reason;
  const locked = disabled || saving != null;
  const inputId = `learning-point-${point.id}`;

  async function save(kind: "classification" | "implementation") {
    if (disabled || savingRef.current) return;
    setError(""); setNotice("");
    const payload: LearningPatchPayload = { sourceHash, pointId: point.id };
    if (kind === "classification") { payload.disposition = disposition; payload.reason = reason; }
    else {
      if (!practiceAction.trim() || !practiceResult.trim() || !observedAt || !Number.isFinite(new Date(observedAt).getTime())) {
        setError("請填寫實際採取的動作、觀察到的結果，以及觀察時間，再保存私人紀錄。"); return;
      }
      payload.implementation = { action: practiceAction.trim(), result: practiceResult.trim(), observedAt: new Date(observedAt).toISOString() };
    }
    savingRef.current = true; setSaving(kind);
    try {
      await onSave(payload);
      setNotice(kind === "classification" ? "分類與採用理由已保存為私人資料。" : "實作結果已新增至私人學習紀錄。沒有更新或公開圖卡。");
      if (kind === "implementation") { setPracticeAction(""); setPracticeResult(""); setObservedAt(""); }
    } catch (cause) { setError(cause instanceof Error ? cause.message : "儲存失敗，輸入仍保留，請稍後重試。"); }
    finally { savingRef.current = false; setSaving(null); }
  }

  return <details open={index === 0} className="group overflow-hidden rounded-2xl border border-stone-200 bg-white">
    <summary className="cursor-pointer px-5 py-5 focus-visible:outline-2 focus-visible:outline-orange-700 sm:px-7">
      <span className="mr-3 text-sm font-bold text-orange-800">觀點 {String(index + 1).padStart(2, "0")}</span>
      <span className="break-words text-lg font-bold leading-8 sm:text-xl">{point.core}</span>
      <span className="ml-3 inline-block rounded-full bg-stone-100 px-3 py-1 text-sm text-stone-700">目前分類：{DISPOSITIONS[point.disposition]}</span>
    </summary>
    <div className="space-y-6 border-t border-stone-200 p-5 sm:p-7">
      <section aria-label="原片觀點與原文證據" className="min-w-0">
        <h3 className="text-lg font-bold">01 原片觀點與證據（{reviewed ? "助理校訂，未獨立查證" : "模型整理，待覆核"}）</h3>
        <p className="mt-1 text-sm leading-7 text-stone-600">{reviewed ? "標題與轉述經助理對照逐字稿校訂，不是本機模型原樣輸出。" : "標題是模型對觀點的轉述，仍待覆核。"}下方引號內保留原文，可跳回來源核對；引文匹配不等於事實已查證。</p>
        {point.sourceClaims.map((claim, claimIndex) => <div key={claimIndex} className="mt-4 rounded-xl border border-stone-200 bg-[#faf9f6] p-4">
          <button type="button" onClick={() => onSeek(claim.timestamp)} aria-label={`回到原片 ${timestamp(claim.timestamp)} 核對引文`} className={`${button} border-stone-300 bg-white font-mono text-sm`}>{timestamp(claim.timestamp)} · 回原片核對</button>
          <blockquote className="mt-3 whitespace-pre-wrap text-base leading-8 [overflow-wrap:anywhere]">「{claim.quote}」</blockquote>
          <p className="mt-3 border-t border-stone-200 pt-3 text-sm leading-7 text-stone-600"><strong>{reviewed ? "助理校訂轉述：" : "模型轉述："}</strong>{claim.explanation}</p>
        </div>)}
        {point.sourceFaithfulness && <p className="mt-3 text-sm leading-7 text-stone-600"><strong>{reviewed ? "來源對照說明：" : "模型來源語意覆核："}</strong>{point.sourceFaithfulness.reason}（{reviewed ? "這是助理對照逐字稿的說明，不是人類覆核或獨立事實查證。" : "這是模型檢查轉述是否受引文支持，不是獨立事實查證。"}）</p>}
      </section>
      <section aria-label={reviewed ? "助理校訂分析" : "模型分析"} className="min-w-0 rounded-xl border border-blue-100 bg-blue-50/60 p-4 sm:p-5">
        <h3 className="text-lg font-bold text-blue-950">02 {reviewed ? "助理校訂分析" : "模型分析"}，不是原作者結論</h3>
        <h4 className="mt-3 text-base font-bold">為什麼重要</h4><p className="mt-1 whitespace-pre-wrap text-base leading-8 [overflow-wrap:anywhere]">{point.whyImportant}</p>
        <h4 className="mt-4 text-base font-bold">成立條件與適用邊界</h4>
        <ul className="mt-1 list-disc space-y-1 pl-5 text-base leading-8">{point.conditions.map((condition, conditionIndex) => <li key={conditionIndex} className="[overflow-wrap:anywhere]">{condition}</li>)}</ul>
      </section>
      <section aria-label="給允雷的私人用途" className="min-w-0 rounded-xl border border-orange-200 bg-orange-50/60 p-4 sm:p-5">
        <h3 className="text-lg font-bold text-orange-950">03 給允雷的用途 · 私人</h3>
        <p className="mt-1 text-sm leading-7 text-stone-600">這些是依學習目標提出的建議，不是效果保證，也不屬於原片引文。</p>
        <dl className="mt-4 space-y-4 text-base leading-8">
          {([["改變哪個決策", point.application.decision], ["改善哪個操作", point.application.operation], ["補上哪段理解流程", point.application.understanding], ["一個驗證動作", point.application.action], ["觀察什麼證據", point.application.observableEvidence]] as const).map(([label, value]) => <div key={label}><dt className="font-bold">{label}</dt><dd className="mt-1 whitespace-pre-wrap [overflow-wrap:anywhere]">{value}</dd></div>)}
        </dl>
      </section>
      <section aria-label="五問檢查與具體理由">
        <h3 className="text-lg font-bold">五問檢查：看理由，不打分</h3>
        <p className="mt-1 text-sm leading-7 text-stone-600">回答與理由{reviewed ? "經助理校訂" : "由模型提出"}，仍需你的判斷；「待確認」不是零分。</p>
        <dl className="mt-4 divide-y divide-stone-200 rounded-xl border border-stone-200 px-4">{QUESTIONS.map(([key, question]) => <div key={key} className="py-4"><dt className="flex flex-wrap items-start justify-between gap-2 text-base font-bold leading-7"><span>{question}</span><span className="rounded bg-stone-100 px-2 text-sm font-medium text-stone-700">{ANSWERS[point.assessment[key].answer]}</span></dt><dd className="mt-2 whitespace-pre-wrap text-base leading-8 text-stone-700 [overflow-wrap:anywhere]">{point.assessment[key].reason}</dd></div>)}</dl>
      </section>
      <section aria-label="私人分類與採用理由" className="border-t border-stone-200 pt-5">
        <h3 className="text-lg font-bold">我的採用決定</h3>
        <p className="mt-1 text-sm leading-7 text-stone-600">初始分類與理由為模型／助理建議；你可修改並儲存自己的判斷。</p>
        <fieldset disabled={locked} className="mt-3"><legend className="mb-2 text-sm leading-7 text-stone-600">選擇分類後，按下儲存才會生效。</legend><div className="grid grid-cols-2 gap-2 sm:grid-cols-4">{(Object.entries(DISPOSITIONS) as [LearningDisposition, string][]).map(([value, label]) => <label key={value} className="flex min-h-12 cursor-pointer items-center gap-2 rounded-lg border border-stone-300 px-3 py-2 text-base leading-7"><input type="radio" name={`${inputId}-disposition`} value={value} checked={disposition === value} onChange={() => setDisposition(value)} className="h-4 w-4 shrink-0 accent-orange-700" />{label}</label>)}</div></fieldset>
        <label htmlFor={`${inputId}-reason`} className="mt-4 block text-base font-bold">採用／暫不採用的理由</label>
        <textarea id={`${inputId}-reason`} value={reason} onChange={event => setReason(event.target.value)} disabled={locked} maxLength={1200} rows={3} className={`${input} mt-2`} />
        <button type="button" onClick={() => void save("classification")} disabled={locked || !changed} className={`${button} mt-3 border-stone-900 bg-stone-900 text-white`}>{saving === "classification" ? "正在儲存…" : "儲存分類與理由"}</button>
      </section>
      <section aria-label="私人實作結果" className="border-t border-stone-200 pt-5">
        <h3 className="text-lg font-bold">實作之後，留下觀察</h3><p className="mt-1 text-sm leading-7 text-stone-600">記錄真實做過的事與結果，包含沒有效果的情況。這是私人筆記，不會加入公開草稿。</p>
        {point.implementationRecords.length > 0 && <ol className="mt-4 space-y-3">{point.implementationRecords.map(record => <li key={record.id} className="rounded-lg bg-stone-50 p-4 text-base leading-8"><time dateTime={record.observedAt} className="text-sm text-stone-600">{new Date(record.observedAt).toLocaleString("zh-TW")}</time><p className="whitespace-pre-wrap [overflow-wrap:anywhere]"><strong>實際動作：</strong>{record.action}</p><p className="whitespace-pre-wrap [overflow-wrap:anywhere]"><strong>觀察結果：</strong>{record.result}</p></li>)}</ol>}
        <div className="mt-4 space-y-3"><label className="block text-base font-bold">實際採取的動作<textarea value={practiceAction} onChange={event => setPracticeAction(event.target.value)} disabled={locked} maxLength={1200} rows={2} className={`${input} mt-2`} /></label><label className="block text-base font-bold">觀察到的結果<textarea value={practiceResult} onChange={event => setPracticeResult(event.target.value)} disabled={locked} maxLength={1600} rows={3} className={`${input} mt-2`} /></label><div className="flex flex-wrap items-end gap-3"><label className="block min-w-0 text-base font-bold">觀察時間（此電腦的本地時間）<input type="datetime-local" value={observedAt} onChange={event => setObservedAt(event.target.value)} disabled={locked} className={`${input} mt-2 max-w-sm min-w-0`} /></label><button type="button" onClick={() => setObservedAt(localDatetimeValue())} disabled={locked} className={`${button} border-stone-300 bg-white`}>使用現在時間</button></div></div>
        <button type="button" onClick={() => void save("implementation")} disabled={locked} className={`${button} mt-3 border-stone-300 bg-white`}>{saving === "implementation" ? "正在儲存…" : "儲存私人實作紀錄"}</button>
      </section>
      {error && <p role="alert" className="rounded-lg bg-red-50 p-3 text-base leading-7 text-red-800">{error}</p>}
      {notice && <p role="status" className="rounded-lg bg-emerald-50 p-3 text-base leading-7 text-emerald-900">{notice}</p>}
    </div>
  </details>;
}

export function LearningPublicPreview({ publicCards, reviewed = false, onSeek }: { publicCards: LearningAnalysis["publicCards"]; reviewed?: boolean; onSeek: (seconds: number) => void }) {
  const [index, setIndex] = useState(0);
  const current = Math.min(index, Math.max(0, publicCards.cards.length - 1));
  const card = publicCards.cards[current];
  return <section aria-label="公開 Carousel 草稿預覽" className="rounded-2xl border border-stone-200 bg-white p-5 sm:p-7">
    <h3 className="text-xl font-bold">來源觀點草稿 · 待語意覆核</h3>
    <p className="mt-2 text-base font-bold leading-8 text-amber-900">{reviewed ? "助理校訂，未獨立查證" : "模型整理，待覆核"}</p>
    <p className="mt-2 text-base leading-8 text-stone-600">{publicCards.cards.length}／{publicCards.targetCount} 頁有來源證據。{publicCards.status === "insufficient-evidence" ? "證據不足時不湊滿 20 頁。" : `繁中觀點是${reviewed ? "助理校訂" : "模型轉述"}草稿，雖附核對過的原文引句，語意與發布授權仍需人工確認。`}</p>
    <p className="mt-2 rounded-lg bg-amber-50 p-3 text-base leading-7 text-amber-950">{publicCards.reason}</p>
    {card && <><article className="mx-auto mt-6 max-w-2xl rounded-xl border border-stone-300 bg-[#f3f1ec] p-5 sm:p-8"><p className="font-mono text-sm text-stone-600">來源觀點 {String(current + 1).padStart(2, "0")}／{String(publicCards.cards.length).padStart(2, "0")}</p><h4 className="mt-5 whitespace-pre-wrap text-2xl font-bold leading-relaxed [overflow-wrap:anywhere]">{card.title}</h4><p className="mt-4 whitespace-pre-wrap text-lg leading-9 [overflow-wrap:anywhere]">{card.body}</p><div className="mt-5 space-y-3 border-t border-stone-300 pt-4">{card.sourceClaims.map((claim, claimIndex) => <div key={claimIndex}><button type="button" onClick={() => onSeek(claim.timestamp)} className={`${button} border-stone-300 bg-white text-sm`}>{timestamp(claim.timestamp)} · 核對來源</button><blockquote className="mt-2 whitespace-pre-wrap text-base leading-8 [overflow-wrap:anywhere]">「{claim.quote}」</blockquote></div>)}</div></article><nav aria-label="公開草稿頁面" className="mt-4 flex flex-wrap items-center justify-center gap-3"><button type="button" onClick={() => setIndex(current - 1)} disabled={current === 0} className={`${button} border-stone-300 bg-white`}>上一頁</button><span className="text-base">{current + 1}／{publicCards.cards.length}</span><button type="button" onClick={() => setIndex(current + 1)} disabled={current >= publicCards.cards.length - 1} className={`${button} border-stone-300 bg-white`}>下一頁</button></nav></>}
    <p className="mt-5 text-sm leading-7 text-stone-600">僅供檢視；不提供自動發布，也未改動原本的 Carousel。私人用途、學習目標、分類與實作紀錄不在這份公開草稿內。</p>
  </section>;
}
