"use client";

import { useEffect, useRef, useState, type CSSProperties } from "react";
import { BACKGROUNDS, CARD_THEMES, FONT_PRESETS, FONT_FACE_CSS, resolveCardStyle, type CardStyle } from "@/lib/card-style";
import { applyCardStylePreview, ensureCardStylePreviewFonts } from "./card-style-preview";

interface Props {
  id: string;
  activeStyle: CardStyle;
  onCancel: () => void;
  onApply: (style: CardStyle) => Promise<void>;
}

export default function CardStylePanel({ id, activeStyle, onCancel, onApply }: Props) {
  // This component is mounted on open: the persisted style is copied, never mutated.
  const [draft, setDraft] = useState<CardStyle>(() => resolveCardStyle(activeStyle));
  const [applying, setApplying] = useState(false);
  const [error, setError] = useState("");
  const [previewState, setPreviewState] = useState<"loading" | "ready" | "error">("loading");
  const [fontState, setFontState] = useState<"checking" | "ready" | "error">("checking");
  const [fontError, setFontError] = useState("");
  const [previewWidth, setPreviewWidth] = useState(320);
  const dialogRef = useRef<HTMLDialogElement>(null);
  const iframeRef = useRef<HTMLIFrameElement>(null);
  const previewRef = useRef<HTMLDivElement>(null);
  const draftRef = useRef(draft);
  const cancelRef = useRef(onCancel);
  const changed = draft.palette !== activeStyle.palette || draft.fontPreset !== activeStyle.fontPreset || draft.background !== activeStyle.background;

  useEffect(() => { cancelRef.current = onCancel; }, [onCancel]);
  useEffect(() => {
    const dialog = dialogRef.current;
    dialog?.showModal();
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => { dialog?.close(); document.body.style.overflow = previousOverflow; };
  }, []);

  useEffect(() => {
    const container = previewRef.current;
    if (!container) return;
    const observer = new ResizeObserver(([entry]) => setPreviewWidth(entry.contentRect.width));
    observer.observe(container);
    return () => observer.disconnect();
  }, []);

  useEffect(() => {
    draftRef.current = draft;
    const document = iframeRef.current?.contentDocument;
    if (!document || previewState !== "ready") return;
    applyCardStylePreview(document, draft);
    let active = true;
    setFontState("checking"); setFontError("");
    void ensureCardStylePreviewFonts(document, draft).then(() => {
      if (active) setFontState("ready");
    }).catch(cause => {
      if (active) { setFontState("error"); setFontError(cause instanceof Error ? cause.message : "本機字型載入失敗，請確認字型安裝。"); }
    });
    return () => { active = false; };
  }, [draft, previewState]);

  function previewLoaded() {
    try {
      const document = iframeRef.current?.contentDocument;
      if (!document || !applyCardStylePreview(document, draftRef.current)) throw Error("missing preview");
      // Keep the actual 1080 × 1350 card geometry and scale the iframe outside it.
      const layout = document.createElement("style");
      layout.textContent = "html,body{margin:0!important;padding:0!important;width:1080px!important;height:1350px!important;overflow:hidden!important;background:transparent!important}body{display:block!important}.social-card{margin:0!important;box-shadow:none!important}";
      document.head.append(layout);
      setPreviewState("ready");
    } catch { setPreviewState("error"); }
  }

  async function apply() {
    if (applying) return;
    setApplying(true); setError("");
    try { await onApply({ ...draft }); }
    catch (cause) { setError(cause instanceof Error ? cause.message : "重畫未完成，原有圖卡與樣式仍保留。"); }
    finally { setApplying(false); }
  }

  return (
    <dialog ref={dialogRef} aria-labelledby="card-style-title" aria-describedby="card-style-description" aria-busy={applying}
      onCancel={event => { event.preventDefault(); if (!applying) cancelRef.current(); }}
      className="fixed inset-0 m-auto w-[calc(100%_-_24px)] max-w-[1180px] max-h-[94dvh] overflow-y-auto rounded-2xl border border-stone-200 bg-[#faf9f6] p-0 text-stone-900 shadow-2xl backdrop:bg-stone-950/50">
      <style>{FONT_FACE_CSS}</style>
      <header className="flex items-start justify-between gap-4 border-b border-stone-200 px-5 py-5 sm:px-7">
        <div>
          <h2 id="card-style-title" className="text-2xl font-bold tracking-tight">圖卡樣式</h2>
          <p id="card-style-description" className="mt-2 max-w-2xl text-base leading-7 text-stone-600">配色、字型、背景分開選。先看效果，按下套用後才會重畫與儲存。</p>
        </div>
        <button type="button" onClick={onCancel} disabled={applying} aria-label="關閉樣式面板，不儲存變更"
          className="min-h-11 min-w-11 shrink-0 rounded-lg border border-stone-300 bg-white text-xl focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-orange-700 disabled:opacity-40">×</button>
      </header>

      <div className="grid gap-7 p-5 sm:p-7 lg:grid-cols-[minmax(0,1.35fr)_minmax(300px,1fr)]">
        <div className="min-w-0 space-y-7">
          <fieldset disabled={applying}>
            <legend className="mb-3 text-lg font-bold">01 配色 <span className="ml-2 text-sm font-normal text-stone-600">只改重點色</span></legend>
            <div className="grid grid-cols-2 gap-2 sm:grid-cols-3">
              {Object.values(CARD_THEMES).map(palette => (
                <label key={palette.id} className="relative block cursor-pointer">
                  <input type="radio" name="card-palette" value={palette.id} checked={draft.palette === palette.id}
                    onChange={() => setDraft(previous => ({ ...previous, palette: palette.id }))} className="peer sr-only" />
                  <span className="flex h-full min-h-[86px] flex-col justify-center gap-2 rounded-xl border-2 border-stone-200 bg-white px-3 py-3 transition-colors peer-checked:border-stone-900 peer-focus-visible:outline-2 peer-focus-visible:outline-offset-2 peer-focus-visible:outline-orange-700 peer-disabled:opacity-60">
                    <span aria-hidden="true" className="flex gap-1.5"><span className="h-5 w-8 rounded" style={{ background: palette.accent }} /><span className="h-5 w-8 rounded border border-black/10" style={{ background: palette.accentLight }} /><span className="h-5 w-8 rounded" style={{ background: palette.accentDark }} /></span>
                    <span className="text-[15px] font-bold leading-6">{palette.label}<span aria-hidden="true">{draft.palette === palette.id ? " ✓" : ""}</span></span>
                  </span>
                </label>
              ))}
            </div>
          </fieldset>

          <fieldset disabled={applying}>
            <legend className="mb-3 text-lg font-bold">02 字型 <span className="ml-2 text-sm font-normal text-stone-600">標題與內文成套搭配</span></legend>
            <div className="grid grid-cols-2 gap-2">
              {Object.values(FONT_PRESETS).map(font => (
                <label key={font.id} className="relative block cursor-pointer">
                  <input type="radio" name="card-font" value={font.id} checked={draft.fontPreset === font.id}
                    onChange={() => setDraft(previous => ({ ...previous, fontPreset: font.id }))} className="peer sr-only" />
                  <span className="flex h-full min-h-[94px] flex-col justify-center gap-1 rounded-xl border-2 border-stone-200 bg-white px-3 py-3 transition-colors peer-checked:border-stone-900 peer-focus-visible:outline-2 peer-focus-visible:outline-offset-2 peer-focus-visible:outline-orange-700 peer-disabled:opacity-60">
                    <span className="break-words text-[21px] leading-8" style={{ fontFamily: font.display.family, fontWeight: font.display.weight } as CSSProperties}>{font.label}</span>
                    <span className="text-sm leading-6 text-stone-600" style={{ fontFamily: font.body.family, fontWeight: font.body.weight } as CSSProperties}>知識值得好好閱讀<span aria-hidden="true">{draft.fontPreset === font.id ? " ✓" : ""}</span></span>
                  </span>
                </label>
              ))}
            </div>
          </fieldset>

          <fieldset disabled={applying}>
            <legend className="mb-3 text-lg font-bold">03 背景 <span className="ml-2 text-sm font-normal text-stone-600">紙色與紋理</span></legend>
            <div className="grid grid-cols-2 gap-2 sm:grid-cols-3">
              {Object.values(BACKGROUNDS).map(background => (
                <label key={background.id} className="relative block cursor-pointer">
                  <input type="radio" name="card-background" value={background.id} checked={draft.background === background.id}
                    onChange={() => setDraft(previous => ({ ...previous, background: background.id }))} className="peer sr-only" />
                  <span className="flex h-full min-h-[88px] flex-col justify-center gap-2 rounded-xl border-2 border-stone-200 bg-white px-3 py-3 transition-colors peer-checked:border-stone-900 peer-focus-visible:outline-2 peer-focus-visible:outline-offset-2 peer-focus-visible:outline-orange-700 peer-disabled:opacity-60">
                    <span aria-hidden="true" className="block h-7 w-full rounded border border-black/10" style={background.preview as CSSProperties} />
                    <span className="text-[15px] font-bold leading-6">{background.label}<span aria-hidden="true">{draft.background === background.id ? " ✓" : ""}</span></span>
                  </span>
                </label>
              ))}
            </div>
          </fieldset>
        </div>

        <section aria-label="圖卡即時預覽" className="min-w-0 self-start lg:sticky lg:top-5">
          <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
            <h3 className="text-lg font-bold">即時預覽</h3>
            <span className="rounded-full bg-stone-200 px-3 py-1 text-sm font-medium">{changed ? "尚未套用" : "目前樣式"}</span>
          </div>
          <div ref={previewRef} className="relative mx-auto aspect-[4/5] w-full max-w-[420px] overflow-hidden rounded-lg border border-stone-300 bg-stone-100 shadow-sm">
            <iframe ref={iframeRef} src={`/api/summaries/${encodeURIComponent(id)}/editor?preview=1`} title="第一張圖卡樣式預覽"
              sandbox="allow-same-origin" tabIndex={-1} onLoad={previewLoaded} onError={() => setPreviewState("error")}
              className="absolute left-0 top-0 origin-top-left border-0" style={{ width: 1080, height: 1350, transform: `scale(${previewWidth / 1080})`, visibility: previewState === "ready" ? "visible" : "hidden" }} />
            {previewState !== "ready" && <p role={previewState === "error" ? "alert" : "status"} className="absolute inset-0 flex items-center justify-center p-7 text-center text-base leading-7 text-stone-600">{previewState === "error" ? "預覽暫時無法載入。請取消後重新開啟；原有圖卡不受影響。" : "正在載入第一張圖卡…"}</p>}
          </div>
          <p className="mt-3 text-sm leading-6 text-stone-600">第一頁 · 1080 × 1350<br />選擇時只更新畫面，不重畫、不儲存，也不呼叫模型。</p>
          {previewState === "ready" && fontState === "checking" && <p role="status" className="mt-2 text-sm leading-6 text-stone-600">正在確認此電腦的本機字型…</p>}
          {fontError && <p role="alert" className="mt-3 rounded-lg border border-amber-300 bg-amber-50 p-3 text-base leading-7 text-amber-950">{fontError}</p>}
        </section>
      </div>

      <footer className="sticky bottom-0 border-t border-stone-200 bg-[#faf9f6] px-5 py-4 sm:px-7">
        {error && <p role="alert" className="mb-3 rounded-lg bg-red-50 px-4 py-3 text-base leading-7 text-red-800">{error}</p>}
        <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
          <p role="status" className="max-w-xl text-sm leading-6 text-stone-600">{applying ? "正在重畫完整 20 張。完成後才會更新樣式，請保持本機服務開啟。" : "只重畫既有內容，不翻譯或呼叫模型。套用後會使用本機算力產生完整 20 張。"}</p>
          <div className="flex shrink-0 gap-3">
            <button type="button" onClick={onCancel} disabled={applying} className="min-h-12 flex-1 rounded-lg border border-stone-300 bg-white px-5 text-base font-bold focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-orange-700 disabled:opacity-40 sm:flex-none">取消</button>
            <button type="button" onClick={apply} disabled={applying || previewState !== "ready" || fontState !== "ready"} className="min-h-12 flex-[2] rounded-lg bg-stone-900 px-5 text-base font-bold text-white hover:bg-stone-700 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-orange-700 disabled:opacity-40 sm:flex-none">{applying ? "重畫中…" : "套用並重畫 20 頁"}</button>
          </div>
        </div>
      </footer>
    </dialog>
  );
}
