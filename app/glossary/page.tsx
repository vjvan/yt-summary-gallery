"use client";

import Link from "next/link";
import { useEffect, useState } from "react";

type SaveState = "idle" | "saving" | "saved" | "error";

interface Glossary {
  no_translate_terms: string[];
  term_map: Array<[string, string]>;
  style_rules: string[];
}

export default function GlossaryPage() {
  const [loading, setLoading] = useState(true);
  const [noTranslate, setNoTranslate] = useState("");
  const [termMap, setTermMap] = useState("");
  const [styleRules, setStyleRules] = useState("");
  const [saveState, setSaveState] = useState<SaveState>("idle");
  const [errorMessage, setErrorMessage] = useState("");

  useEffect(() => {
    fetch("/api/glossary")
      .then((r) => r.json())
      .then((g: Glossary) => {
        setNoTranslate(g.no_translate_terms.join("\n"));
        setTermMap(g.term_map.map(([en, zh]) => `${en} | ${zh}`).join("\n"));
        setStyleRules(g.style_rules.join("\n"));
      })
      .finally(() => setLoading(false));
  }, []);

  function parseInputs(): Glossary {
    const no_translate_terms = noTranslate
      .split("\n").map((s) => s.trim()).filter(Boolean);
    const term_map: Array<[string, string]> = termMap
      .split("\n")
      .map((line) => line.split("|").map((s) => s.trim()))
      .filter((parts) => parts.length === 2 && parts[0] && parts[1])
      .map(([en, zh]) => [en, zh]);
    const style_rules = styleRules
      .split("\n").map((s) => s.trim()).filter(Boolean);
    return { no_translate_terms, term_map, style_rules };
  }

  async function handleSave() {
    setSaveState("saving");
    setErrorMessage("");
    try {
      const body = parseInputs();
      const resp = await fetch("/api/glossary", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      const data = await resp.json();
      if (!resp.ok) {
        setSaveState("error");
        setErrorMessage(data.error || "儲存失敗");
        return;
      }
      setSaveState("saved");
      setTimeout(() => setSaveState("idle"), 2500);
    } catch (err) {
      setSaveState("error");
      setErrorMessage(err instanceof Error ? err.message : "Unknown error");
    }
  }

  async function handleReset() {
    if (!confirm("確定要重置為預設術語表?你目前的編輯會被覆蓋。")) return;
    const resp = await fetch("/api/glossary", { method: "DELETE" });
    const g: Glossary = await resp.json();
    setNoTranslate(g.no_translate_terms.join("\n"));
    setTermMap(g.term_map.map(([en, zh]) => `${en} | ${zh}`).join("\n"));
    setStyleRules(g.style_rules.join("\n"));
    setSaveState("saved");
    setTimeout(() => setSaveState("idle"), 2500);
  }

  if (loading) {
    return (
      <main className="min-h-screen bg-gray-50 flex items-center justify-center">
        <p className="text-gray-400">載入中...</p>
      </main>
    );
  }

  return (
    <main className="min-h-screen bg-gray-50">
      <div className="max-w-5xl mx-auto px-4 py-10">
        <div className="mb-8">
          <Link href="/" className="text-sm text-gray-400 hover:text-gray-600">
            &larr; 回到 Gallery
          </Link>
          <h1 className="text-3xl font-black text-gray-900 mt-3 mb-2">
            翻譯術語表
          </h1>
          <p className="text-gray-500">
            這份術語表會注入翻譯模型的 system prompt,影響所有新影片與「重新翻譯」的結果。
            改完按下方儲存即可,不需要重啟 server。
          </p>
        </div>

        <Section
          title="保留英文的術語(Tools / Brands / 專有名詞)"
          hint="每行一個。這些字會被指示直接保留英文,不要翻成中文。例如 fal.ai、ComfyUI、design.md。"
          value={noTranslate}
          onChange={setNoTranslate}
          placeholder={"fal.ai\nWeavy.ai\nClaude Code"}
          rows={10}
        />

        <Section
          title="中英術語對照表"
          hint="每行一條,格式為 英文 | 中文 (中間用 pipe 符號 | 分隔)。用於統一專業術語的譯法。"
          value={termMap}
          onChange={setTermMap}
          placeholder={"iterate | 迭代\nremix | 重混\ndesign system | 設計系統"}
          rows={14}
        />

        <Section
          title="口語化處理規則"
          hint="每行一條風格指引。用來告訴模型怎麼處理填充詞、口語的句子結構等等。"
          value={styleRules}
          onChange={setStyleRules}
          placeholder={"口語填充詞 (you know, actually) 多數情況省略不譯。"}
          rows={8}
        />

        <div className="sticky bottom-0 bg-gray-50 pt-4 pb-2">
          <div className="flex gap-3 items-center">
            <button
              onClick={handleSave}
              disabled={saveState === "saving"}
              className="px-6 py-3 font-bold text-white bg-orange-500 hover:bg-orange-600 rounded-lg transition-colors disabled:bg-gray-300 disabled:cursor-not-allowed"
            >
              {saveState === "saving" ? "儲存中..." : "儲存術語表"}
            </button>
            <button
              onClick={handleReset}
              className="px-5 py-3 font-bold text-gray-600 bg-gray-100 hover:bg-gray-200 rounded-lg transition-colors"
            >
              重置為預設
            </button>
            {saveState === "saved" && (
              <span className="text-sm text-green-600 font-bold">已儲存</span>
            )}
            {saveState === "error" && (
              <span className="text-sm text-red-500 font-bold">{errorMessage}</span>
            )}
          </div>
        </div>
      </div>
    </main>
  );
}

function Section({
  title, hint, value, onChange, placeholder, rows,
}: {
  title: string; hint: string; value: string;
  onChange: (v: string) => void; placeholder: string; rows: number;
}) {
  return (
    <section className="mb-8">
      <h2 className="text-lg font-bold text-gray-900 mb-1">{title}</h2>
      <p className="text-sm text-gray-500 mb-3">{hint}</p>
      <textarea
        value={value}
        onChange={(e) => onChange(e.target.value)}
        rows={rows}
        placeholder={placeholder}
        className="w-full p-4 font-mono text-sm border-2 border-gray-200 rounded-xl focus:border-orange-400 focus:outline-none transition-colors"
      />
      <p className="text-xs text-gray-400 mt-1">
        {value.split("\n").filter((l) => l.trim()).length} 條
      </p>
    </section>
  );
}
