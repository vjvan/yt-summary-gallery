/**
 * 非同步 shell 指令 helper,取代 pipeline 各處的 execSync。
 *
 * execSync 會凍住整個 Node event loop:Whisper 轉錄 / ffmpeg 燒錄期間
 * server 完全無法回應任何請求(實測 51 分鐘影片轉錄凍 2.3 分鐘)。
 * 改用 promisify(exec) 讓長任務在背景跑,event loop 保持暢通。
 */

import { exec } from "child_process";
import { promisify } from "util";

const execAsync = promisify(exec);

export interface RunOptions {
  timeoutMs?: number;
  maxBufferBytes?: number;
}

/**
 * 執行 shell 指令,回傳 stdout。
 * 失敗時 reject,err.message 含指令與 stderr(execAsync 的預設行為)。
 */
export async function run(cmd: string, opts: RunOptions = {}): Promise<string> {
  const { stdout } = await execAsync(cmd, {
    timeout: opts.timeoutMs ?? 120000,
    maxBuffer: opts.maxBufferBytes ?? 64 * 1024 * 1024,
    encoding: "utf-8",
  });
  return stdout;
}
