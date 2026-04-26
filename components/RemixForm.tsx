"use client";

import { useCallback, useRef, useState } from "react";

interface ClipItem {
  id: string;
  file_name: string;
  sort_order: number;
  status?: string;
  duration_display?: string;
}

const VALID_EXTS = [
  "mp4", "mov", "webm", "avi", "mkv",
  "mp3", "m4a", "wav", "ogg", "opus", "aac", "flac",
];

export default function RemixForm({
  onGenerated,
}: {
  onGenerated: () => void;
}) {
  const [title, setTitle] = useState("");
  const [projectId, setProjectId] = useState<string | null>(null);
  const [clips, setClips] = useState<ClipItem[]>([]);
  const [status, setStatus] = useState<
    "idle" | "uploading" | "processing" | "done" | "error"
  >("idle");
  const [error, setError] = useState("");
  const [progress, setProgress] = useState("");
  const fileInputRef = useRef<HTMLInputElement>(null);
  const dragItem = useRef<number | null>(null);
  const dragOverItem = useRef<number | null>(null);

  const handleFiles = useCallback(
    async (files: FileList | File[]) => {
      const validFiles = Array.from(files).filter((f) => {
        const ext = f.name.split(".").pop()?.toLowerCase();
        return ext && VALID_EXTS.includes(ext);
      });

      if (!validFiles.length) {
        setError("No valid files. Supported: mp4, mov, webm, mp3, m4a, wav, ogg");
        return;
      }

      setStatus("uploading");
      setError("");

      try {
        // Create project if needed
        let pid = projectId;
        if (!pid) {
          const projectTitle = title || "Untitled Remix";
          const resp = await fetch("/api/projects", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ title: projectTitle }),
          });
          const data = await resp.json();
          pid = data.id;
          setProjectId(pid);
        }

        // Upload clips
        const formData = new FormData();
        validFiles.forEach((f) => formData.append("files", f));

        const resp = await fetch(`/api/projects/${pid}/clips`, {
          method: "POST",
          body: formData,
        });
        const data = await resp.json();

        if (data.clips) {
          setClips((prev) => [...prev, ...data.clips]);
        }

        setStatus("idle");
      } catch (err) {
        setError(err instanceof Error ? err.message : "Upload failed");
        setStatus("error");
      }
    },
    [projectId, title]
  );

  const removeClip = useCallback(
    (clipId: string) => {
      setClips((prev) => prev.filter((c) => c.id !== clipId));
    },
    []
  );

  const handleDragStart = (index: number) => {
    dragItem.current = index;
  };

  const handleDragEnter = (index: number) => {
    dragOverItem.current = index;
  };

  const handleDragEnd = async () => {
    if (dragItem.current === null || dragOverItem.current === null) return;
    if (dragItem.current === dragOverItem.current) return;

    const reordered = [...clips];
    const [removed] = reordered.splice(dragItem.current, 1);
    reordered.splice(dragOverItem.current, 0, removed);

    setClips(reordered);
    dragItem.current = null;
    dragOverItem.current = null;

    // Save new order
    if (projectId) {
      await fetch(`/api/projects/${projectId}/clips/reorder`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ clip_ids: reordered.map((c) => c.id) }),
      });
    }
  };

  const pollForCompletion = useCallback(
    async (pid: string) => {
      const maxAttempts = 200; // ~10 min
      for (let i = 0; i < maxAttempts; i++) {
        await new Promise((r) => setTimeout(r, 3000));

        try {
          const resp = await fetch(`/api/projects/${pid}`);
          const data = await resp.json();

          if (data.status === "done") {
            setStatus("done");
            setProgress("");
            onGenerated();
            return;
          }

          if (data.status === "error") {
            setStatus("error");
            setError(data.error || "Processing failed");
            setProgress("");
            return;
          }

          // Update clip statuses for progress display
          if (data.clips) {
            const doneCount = data.clips.filter(
              (c: { status: string }) => c.status === "done"
            ).length;
            const transcribingClip = data.clips.find(
              (c: { status: string }) => c.status === "transcribing"
            );
            if (transcribingClip) {
              setProgress(
                `Transcribing ${doneCount + 1}/${data.clips.length}: ${transcribingClip.file_name}`
              );
            } else if (doneCount === data.clips.length) {
              setProgress("Generating combined summary...");
            }
          }
        } catch {}
      }

      setStatus("error");
      setError("Timeout: processing took too long");
    },
    [onGenerated]
  );

  const handleGenerate = useCallback(async () => {
    if (!projectId || clips.length === 0) return;

    // Update title if changed
    setStatus("processing");
    setError("");
    setProgress(`Starting pipeline (${clips.length} clips)...`);

    try {
      const resp = await fetch(`/api/projects/${projectId}/generate`, {
        method: "POST",
      });
      const data = await resp.json();

      if (data.error) {
        setStatus("error");
        setError(data.error);
        return;
      }

      pollForCompletion(projectId);
    } catch (err) {
      setStatus("error");
      setError(err instanceof Error ? err.message : "Failed to start");
    }
  }, [projectId, clips, pollForCompletion]);

  const handleReset = () => {
    setProjectId(null);
    setClips([]);
    setTitle("");
    setStatus("idle");
    setError("");
    setProgress("");
  };

  const isProcessing = status === "uploading" || status === "processing";

  return (
    <div className="max-w-2xl mx-auto">
      {/* Title input */}
      <input
        type="text"
        value={title}
        onChange={(e) => setTitle(e.target.value)}
        placeholder="Project title..."
        disabled={isProcessing}
        className="w-full px-5 py-3 mb-4 rounded-xl border border-gray-200 bg-white text-gray-900 focus:outline-none focus:border-orange-400 disabled:opacity-50"
      />

      {/* Drop zone */}
      <div
        onDragOver={(e) => {
          e.preventDefault();
          e.currentTarget.classList.add("border-orange-400", "bg-orange-50");
        }}
        onDragLeave={(e) => {
          e.currentTarget.classList.remove("border-orange-400", "bg-orange-50");
        }}
        onDrop={(e) => {
          e.preventDefault();
          e.currentTarget.classList.remove("border-orange-400", "bg-orange-50");
          if (e.dataTransfer.files.length && !isProcessing) {
            handleFiles(e.dataTransfer.files);
          }
        }}
        onClick={() => !isProcessing && fileInputRef.current?.click()}
        className={`border-2 border-dashed rounded-xl p-8 text-center cursor-pointer transition-colors ${
          isProcessing
            ? "border-gray-200 bg-gray-50 cursor-not-allowed"
            : "border-gray-300 hover:border-orange-400 hover:bg-orange-50"
        }`}
      >
        <p className="text-gray-500 text-sm">
          {isProcessing
            ? "Processing..."
            : "Drop video/audio files here, or click to select"}
        </p>
        <p className="text-xs text-gray-400 mt-1">
          mp4, mov, webm, mp3, m4a, wav, ogg
        </p>
        <input
          ref={fileInputRef}
          type="file"
          multiple
          accept=".mp4,.mov,.webm,.avi,.mkv,.mp3,.m4a,.wav,.ogg,.opus,.aac,.flac"
          className="hidden"
          onChange={(e) => e.target.files && handleFiles(e.target.files)}
        />
      </div>

      {/* Clip list */}
      {clips.length > 0 && (
        <div className="mt-4 space-y-2">
          <p className="text-sm text-gray-500 font-medium">
            {clips.length} clips (drag to reorder)
          </p>
          {clips.map((clip, index) => (
            <div
              key={clip.id}
              draggable={!isProcessing}
              onDragStart={() => handleDragStart(index)}
              onDragEnter={() => handleDragEnter(index)}
              onDragEnd={handleDragEnd}
              onDragOver={(e) => e.preventDefault()}
              className="flex items-center gap-3 px-4 py-3 bg-white rounded-lg border border-gray-100 hover:shadow-sm transition-shadow"
            >
              <span className="text-gray-300 cursor-grab text-lg">
                &#x2630;
              </span>
              <span className="text-sm font-medium text-gray-700 flex-1 truncate">
                {clip.file_name}
              </span>
              {clip.status === "transcribing" && (
                <span className="text-xs text-orange-500">transcribing...</span>
              )}
              {clip.status === "done" && (
                <span className="text-xs text-green-500">
                  {clip.duration_display || "done"}
                </span>
              )}
              {clip.status === "error" && (
                <span className="text-xs text-red-500">error</span>
              )}
              {!isProcessing && (
                <button
                  onClick={() => removeClip(clip.id)}
                  className="text-gray-400 hover:text-red-500 text-sm"
                >
                  X
                </button>
              )}
            </div>
          ))}
        </div>
      )}

      {/* Progress */}
      {status === "processing" && progress && (
        <div className="mt-4 p-4 bg-orange-50 rounded-xl">
          <div className="flex items-center gap-3">
            <div className="w-5 h-5 border-2 border-orange-400 border-t-transparent rounded-full animate-spin" />
            <span className="text-sm text-orange-700">{progress}</span>
          </div>
        </div>
      )}

      {/* Error */}
      {error && (
        <div className="mt-4 p-4 bg-red-50 rounded-xl">
          <p className="text-sm text-red-600">{error}</p>
        </div>
      )}

      {/* Actions */}
      <div className="mt-4 flex gap-3">
        <button
          onClick={handleGenerate}
          disabled={clips.length === 0 || isProcessing}
          className="flex-1 py-3 rounded-xl font-bold text-white bg-orange-500 hover:bg-orange-600 disabled:bg-gray-300 disabled:cursor-not-allowed transition-colors"
        >
          {status === "processing" ? "Processing..." : "Generate Remix"}
        </button>
        {clips.length > 0 && !isProcessing && (
          <button
            onClick={handleReset}
            className="px-4 py-3 rounded-xl font-medium text-gray-500 bg-gray-100 hover:bg-gray-200 transition-colors"
          >
            Reset
          </button>
        )}
      </div>

      {/* Done */}
      {status === "done" && projectId && (
        <div className="mt-4 p-4 bg-green-50 rounded-xl text-center">
          <p className="text-green-700 font-medium mb-2">Remix complete!</p>
          <a
            href={`/remix/${projectId}`}
            className="text-orange-600 hover:underline text-sm font-medium"
          >
            View result
          </a>
        </div>
      )}
    </div>
  );
}
