"use client";

import { useEffect, useRef, useState } from "react";
import type { SocialCard } from "@/lib/pipeline/extract-summary";

interface PreviewStats { contentCards: number; dropped: number; padded: number; sections: string[] }
interface Preview { cards: SocialCard[]; stats: PreviewStats; warnings: string[] }
export interface ExternalAnalysisMeta { provider: string; imported_at: string }

interface Props {
  id: string;
  external: ExternalAnalysisMeta | null;
  onCancel: () => void;
  /** 匯入寫入成功後由父層以目前樣式重畫 20 張。 */
  onImported: () => Promise<void>;
  /** 還原成匯入前的版本後由父層重畫。 */
  onReverted: () => Promise<void>;
}

/** ISO 時間轉本機顯示；壞值原樣回傳，不丟例外。 */
export function formatImportedAt(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return iso;
  const pad = (value: number) => String(value).padStart(2, "0");
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

const ROLE_LABEL: Record<string, string> = {
  hook: "開場", context: "背景", thesis: "結論", insight: "洞察", business: "商業", workflow: "流程",
  evidence: "證據", action: "行動", warning: "提醒", quote: "金句", reflection: "反思", recap: "回顧", closing: "收尾",
};

export default function AnalysisImportPanel({ id, external, onCancel, onImported, onReverted }: Props) {
  const [text, setText] = useState("");
  const [preview, setPreview] = useState<Preview | null>(null);
  const [previewError, setPreviewError] = useState("");
  const [checking, setChecking] = useState(false);
  const [busy, setBusy] = useState<"" | "import" | "revert">("");
  const [error, setError] = useState("");
  const dialogRef = useRef<HTMLDialogElement>(null);
  const cancelRef = useRef(onCancel);
  const requestRef = useRef<AbortController | null>(null);

  useEffect(() => { cancelRef.current = onCancel; }, [onCancel]);
  useEffect(() => {
    const dialog = dialogRef.current;
    dialog?.showModal();
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => { dialog?.close(); document.body.style.overflow = previousOverflow; };
  }, []);

  // 停止輸入半秒後才試切頁；試切只解析不寫入。
  useEffect(() => {
    requestRef.current?.abort();
    if (text.trim().length < 40) { setPreview(null); setPreviewError(""); setChecking(false); return; }
    const controller = new AbortController();
    requestRef.current = controller;
    setChecking(true);
    const timer = setTimeout(async () => {
      try {
        const response = await fetch(`/api/summaries/${encodeURIComponent(id)}/import-analysis`, {
          method: "POST", headers: { "Content-Type": "application/json" }, cache: "no-store", signal: controller.signal,
          body: JSON.stringify({ text, provider: "notebooklm", dryRun: true }),
        });
        const result = await response.json().catch(() => ({}));
        if (controller.signal.aborted) return;
        if (!response.ok) { setPreview(null); setPreviewError(typeof result.error === "string" ? result.error : "無法解析貼入的文字。"); }
        else { setPreview(result as Preview); setPreviewError(""); }
      } catch (cause) {
        if (!controller.signal.aborted) { setPreview(null); setPreviewError(cause instanceof Error ? cause.message : "無法連線到本機服務。"); }
      } finally { if (!controller.signal.aborted) setChecking(false); }
    }, 500);
    return () => { clearTimeout(timer); controller.abort(); };
  }, [text, id]);

  async function importNow() {
    if (busy || !preview) return;
    setBusy("import"); setError("");
    try {
      const response = await fetch(`/api/summaries/${encodeURIComponent(id)}/import-analysis`, {
        method: "POST", headers: { "Content-Type": "application/json" }, cache: "no-store",
        body: JSON.stringify({ text, provider: "notebooklm" }),
      });
      const result = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(typeof result.error === "string" ? result.error : "匯入失敗，原有圖卡內容未改。");
      await onImported();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "匯入未完成，原有圖卡仍保留。");
    } finally { setBusy(""); }
  }

  async function revert() {
    if (busy || !external) return;
    if (!confirm("還原成匯入前的圖卡內容（本機或雲端萃取的版本），並以目前樣式重畫 20 張。要繼續嗎？")) return;
    setBusy("revert"); setError("");
    try {
      const response = await fetch(`/api/summaries/${encodeURIComponent(id)}/import-analysis`, { method: "DELETE", cache: "no-store" });
      const result = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(typeof result.error === "string" ? result.error : "還原失敗，目前內容未改。");
      await onReverted();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "還原未完成，目前圖卡仍保留。");
    } finally { setBusy(""); }
  }

  const ready = !!preview && !checking && !busy;
  return (
    <dialog ref={dialogRef} aria-labelledby="analysis-import-title" aria-describedby="analysis-import-description" aria-busy={!!busy}
      onCancel={event => { event.preventDefault(); if (!busy) cancelRef.current(); }}
      className="fixed inset-0 m-auto w-[calc(100%_-_24px)] max-w-[1100px] max-h-[94dvh] overflow-y-auto rounded-2xl border border-stone-200 bg-[#faf9f6] p-0 text-stone-900 shadow-2xl backdrop:bg-stone-950/50">
      <header className="flex items-start justify-between gap-4 border-b border-stone-200 px-5 py-5 sm:px-7">
        <div>
          <h2 id="analysis-import-title" className="text-2xl font-bold tracking-tight">貼入 NotebookLM 分析</h2>
          <p id="analysis-import-description" className="mt-2 max-w-2xl text-base leading-7 text-stone-600">把 NotebookLM 的繁中報告整段貼進來，這裡用標題與段落切成 20 頁，不呼叫模型。匯入後以目前樣式重畫；匯入前的內容會留著可還原。</p>
        </div>
        <button type="button" onClick={onCancel} disabled={!!busy} aria-label="關閉，不匯入"
          className="min-h-11 min-w-11 shrink-0 rounded-lg border border-stone-300 bg-white text-xl focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-orange-700 disabled:opacity-40">×</button>
      </header>

      <div className="grid gap-6 p-5 sm:p-7 lg:grid-cols-[minmax(0,1.2fr)_minmax(320px,1fr)]">
        <div className="min-w-0">
          <label htmlFor="analysis-import-text" className="mb-2 block text-lg font-bold">分析全文</label>
          <textarea id="analysis-import-text" value={text} onChange={event => setText(event.target.value)} disabled={!!busy} rows={18}
            placeholder={"在 NotebookLM 把輸出語言設成繁體中文，複製整份回答或報告，貼在這裡。\n標題、粗體標籤、編號清單都會被當成一頁的邊界。"}
            className="w-full rounded-xl border border-stone-300 bg-white px-4 py-3 text-base leading-7 text-stone-900 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-orange-700 disabled:opacity-60" />
          <p className="mt-2 text-sm leading-6 text-stone-600">引用編號（句尾的小數字）會自動拿掉。內容超過 16 段時，後面的段落不會放進圖卡；不足時最多補 6 頁反思提示。</p>
          {external && (
            <div className="mt-4 rounded-lg border border-stone-200 bg-white px-4 py-3 text-sm leading-6 text-stone-700">
              <p>目前圖卡內容來自 <strong>{external.provider === "notebooklm" ? "NotebookLM" : external.provider}</strong>，匯入於 {formatImportedAt(external.imported_at)}。</p>
              <button type="button" onClick={revert} disabled={!!busy}
                className="mt-2 min-h-10 rounded-lg border border-stone-300 bg-white px-4 text-sm font-bold hover:bg-stone-100 disabled:opacity-40">
                {busy === "revert" ? "還原中…" : "還原成匯入前的內容並重畫"}
              </button>
            </div>
          )}
        </div>

        <section aria-label="切頁預覽" className="min-w-0 self-start lg:sticky lg:top-5">
          <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
            <h3 className="text-lg font-bold">切頁預覽</h3>
            <span className="rounded-full bg-stone-200 px-3 py-1 text-sm font-medium">{checking ? "解析中…" : preview ? "20 頁就緒" : "尚未解析"}</span>
          </div>
          {previewError && <p role="alert" className="rounded-lg border border-amber-300 bg-amber-50 p-3 text-base leading-7 text-amber-950">{previewError}</p>}
          {preview && (
            <>
              <p className="text-sm leading-6 text-stone-600">切出 {preview.stats.contentCards} 段內容{preview.stats.dropped ? `，未放進 ${preview.stats.dropped} 段` : ""}{preview.stats.padded ? `，補 ${preview.stats.padded} 頁反思` : ""}。</p>
              {preview.warnings.length > 0 && (
                <ul className="mt-2 space-y-1 rounded-lg border border-amber-300 bg-amber-50 p-3 text-sm leading-6 text-amber-950">
                  {preview.warnings.map(warning => <li key={warning}>{warning}</li>)}
                </ul>
              )}
              <ol className="mt-3 max-h-[52dvh] space-y-1 overflow-y-auto rounded-lg border border-stone-200 bg-white p-2 text-sm">
                {preview.cards.map((card, index) => (
                  <li key={`${index}-${card.title}`} className="flex gap-2 rounded px-2 py-1 leading-6 odd:bg-stone-50">
                    <span className="w-7 shrink-0 font-mono text-stone-500">{String(index + 1).padStart(2, "0")}</span>
                    <span className="w-9 shrink-0 rounded bg-stone-200 px-1 text-center text-xs leading-6 text-stone-700">{ROLE_LABEL[card.role] || card.role}</span>
                    <span className="min-w-0 flex-1"><span className="font-bold">{card.title}</span><span className="block truncate text-stone-600">{card.body}</span></span>
                  </li>
                ))}
              </ol>
            </>
          )}
        </section>
      </div>

      <footer className="sticky bottom-0 border-t border-stone-200 bg-[#faf9f6] px-5 py-4 sm:px-7">
        {error && <p role="alert" className="mb-3 rounded-lg bg-red-50 px-4 py-3 text-base leading-7 text-red-800">{error}</p>}
        <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
          <p role="status" className="max-w-xl text-sm leading-6 text-stone-600">{busy === "import" ? "正在寫入並重畫完整 20 張，請保持本機服務開啟。" : "匯入只改圖卡的 20 頁內容，不動字幕、摘要與私人筆記。"}</p>
          <div className="flex shrink-0 gap-3">
            <button type="button" onClick={onCancel} disabled={!!busy} className="min-h-12 flex-1 rounded-lg border border-stone-300 bg-white px-5 text-base font-bold focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-orange-700 disabled:opacity-40 sm:flex-none">取消</button>
            <button type="button" onClick={importNow} disabled={!ready} className="min-h-12 flex-[2] rounded-lg bg-stone-900 px-5 text-base font-bold text-white hover:bg-stone-700 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-orange-700 disabled:opacity-40 sm:flex-none">{busy === "import" ? "匯入中…" : "匯入並重畫 20 張"}</button>
          </div>
        </div>
      </footer>
    </dialog>
  );
}
