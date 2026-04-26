"use client";

import { useCallback, useRef, useState } from "react";
import { useRouter } from "next/navigation";

const VALID_EXTS = [
  "mp4", "mov", "webm", "avi", "mkv",
  "mp3", "m4a", "wav", "ogg", "opus", "aac", "flac",
];

type Status = "idle" | "uploading" | "transcribing" | "analyzing" | "assembling" | "done" | "error";

const STATUS_LABELS: Record<Status, string> = {
  idle: "",
  uploading: "Uploading...",
  transcribing: "Transcribing audio...",
  analyzing: "AI analyzing content...",
  assembling: "Assembling video...",
  done: "Done!",
  error: "Failed",
};

export default function SingleVideoForm({
  onGenerated,
}: {
  onGenerated: () => void;
}) {
  const [status, setStatus] = useState<Status>("idle");
  const [fileName, setFileName] = useState("");
  const [error, setError] = useState("");
  const fileInputRef = useRef<HTMLInputElement>(null);
  const router = useRouter();

  const processVideo = useCallback(
    async (file: File) => {
      const ext = file.name.split(".").pop()?.toLowerCase();
      if (!ext || !VALID_EXTS.includes(ext)) {
        setError("Unsupported format. Use: mp4, mov, webm, mp3, m4a, wav, ogg");
        return;
      }

      setFileName(file.name);
      setError("");

      try {
        // Step 1: Create project
        setStatus("uploading");
        const title = file.name.replace(/\.[^.]+$/, "");
        const projResp = await fetch("/api/projects", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ title }),
        });
        const { id: projectId } = await projResp.json();

        // Step 2: Upload clip
        const formData = new FormData();
        formData.append("files", file);
        await fetch(`/api/projects/${projectId}/clips`, {
          method: "POST",
          body: formData,
        });

        // Step 3: Start pipeline
        setStatus("transcribing");
        await fetch(`/api/projects/${projectId}/generate`, {
          method: "POST",
        });

        // Step 4: Poll for completion
        const maxAttempts = 200;
        for (let i = 0; i < maxAttempts; i++) {
          await new Promise((r) => setTimeout(r, 3000));

          const resp = await fetch(`/api/projects/${projectId}`);
          const data = await resp.json();

          if (data.status === "done") {
            setStatus("done");
            onGenerated();
            // Auto-navigate to result
            setTimeout(() => router.push(`/remix/${projectId}`), 800);
            return;
          }

          if (data.status === "error") {
            setStatus("error");
            setError(data.error || "Processing failed");
            return;
          }

          // Update progress based on clip status
          if (data.clips) {
            const clip = data.clips[0];
            if (clip?.status === "transcribing") {
              setStatus("transcribing");
            } else if (clip?.status === "done") {
              // Clips done, now doing summary + assembly
              if (!data.combined_summary) {
                setStatus("analyzing");
              } else {
                setStatus("assembling");
              }
            }
          }
        }

        setStatus("error");
        setError("Timeout");
      } catch (err) {
        setStatus("error");
        setError(err instanceof Error ? err.message : "Unknown error");
      }
    },
    [onGenerated, router]
  );

  const isProcessing = status !== "idle" && status !== "done" && status !== "error";

  return (
    <div className="max-w-xl mx-auto">
      {/* Drop zone */}
      {status === "idle" || status === "error" ? (
        <div
          onDragOver={(e) => {
            e.preventDefault();
            e.currentTarget.classList.add("border-orange-400", "bg-orange-50/50");
          }}
          onDragLeave={(e) => {
            e.currentTarget.classList.remove("border-orange-400", "bg-orange-50/50");
          }}
          onDrop={(e) => {
            e.preventDefault();
            e.currentTarget.classList.remove("border-orange-400", "bg-orange-50/50");
            const file = e.dataTransfer.files[0];
            if (file) processVideo(file);
          }}
          onClick={() => fileInputRef.current?.click()}
          className="border-2 border-dashed border-gray-300 rounded-2xl p-16 text-center cursor-pointer hover:border-orange-400 hover:bg-orange-50/50 transition-all"
        >
          <div className="text-4xl text-gray-300 mb-4">+</div>
          <p className="text-gray-600 font-medium">
            Drop a video here
          </p>
          <p className="text-sm text-gray-400 mt-2">
            mp4, mov, webm, mp3, m4a, wav, ogg
          </p>
          <p className="text-xs text-gray-300 mt-4">
            AI will extract highlights and create a short video
          </p>
          <input
            ref={fileInputRef}
            type="file"
            accept=".mp4,.mov,.webm,.avi,.mkv,.mp3,.m4a,.wav,.ogg,.opus,.aac,.flac"
            className="hidden"
            onChange={(e) => {
              const file = e.target.files?.[0];
              if (file) processVideo(file);
            }}
          />
        </div>
      ) : (
        /* Processing state */
        <div className="bg-white rounded-2xl border border-gray-100 p-10 text-center">
          <div className="w-12 h-12 mx-auto mb-6 border-3 border-orange-400 border-t-transparent rounded-full animate-spin" />

          <p className="text-sm text-gray-500 mb-1 truncate max-w-xs mx-auto">
            {fileName}
          </p>

          <p className="text-lg font-bold text-gray-800">
            {STATUS_LABELS[status]}
          </p>

          {/* Progress steps */}
          <div className="flex items-center justify-center gap-2 mt-6">
            {(["transcribing", "analyzing", "assembling"] as const).map((step, i) => {
              const steps: Status[] = ["transcribing", "analyzing", "assembling"];
              const currentIdx = steps.indexOf(status as typeof steps[number]);
              const stepIdx = i;
              const isDone = currentIdx > stepIdx;
              const isActive = currentIdx === stepIdx;

              return (
                <div key={step} className="flex items-center gap-2">
                  <div
                    className={`w-2.5 h-2.5 rounded-full transition-colors ${
                      isDone
                        ? "bg-green-400"
                        : isActive
                        ? "bg-orange-400 animate-pulse"
                        : "bg-gray-200"
                    }`}
                  />
                  {i < 2 && (
                    <div
                      className={`w-8 h-0.5 ${
                        isDone ? "bg-green-300" : "bg-gray-200"
                      }`}
                    />
                  )}
                </div>
              );
            })}
          </div>
          <div className="flex justify-between text-xs text-gray-400 mt-2 max-w-[200px] mx-auto">
            <span>Transcribe</span>
            <span>Analyze</span>
            <span>Assemble</span>
          </div>
        </div>
      )}

      {/* Error */}
      {error && (
        <div className="mt-4 p-4 bg-red-50 rounded-xl">
          <p className="text-sm text-red-600">{error}</p>
          <button
            onClick={() => {
              setStatus("idle");
              setError("");
              setFileName("");
            }}
            className="text-sm text-orange-500 hover:underline mt-2"
          >
            Try again
          </button>
        </div>
      )}
    </div>
  );
}
