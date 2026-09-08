/**
 * 非同步 shell 指令 helper,取代 pipeline 各處的 execSync。
 *
 * execSync 會凍住整個 Node event loop:Whisper 轉錄 / ffmpeg 燒錄期間
 * server 完全無法回應任何請求(實測 51 分鐘影片轉錄凍 2.3 分鐘)。
 * 改用 promisify(exec) 讓長任務在背景跑,event loop 保持暢通。
 */

import { exec, execFile } from "child_process";
import { promisify } from "util";

const execAsync = promisify(exec);
const execFileAsync = promisify(execFile);

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

/**
 * 執行外部程式,參數走陣列不經過 shell。
 * URL、語言代碼這類「來自使用者或第三方網站」的值一定要用這個,不要用字串組裝的 run():
 * 字串組裝時 $()、反引號、雙引號都會被 shell 解讀,等於把命令執行權交出去。
 */
export async function runArgs(file: string, args: string[], opts: RunOptions = {}): Promise<string> {
  const { stdout } = await execFileAsync(file, args, {
    timeout: opts.timeoutMs ?? 120000,
    maxBuffer: opts.maxBufferBytes ?? 64 * 1024 * 1024,
    encoding: "utf-8",
    shell: false,
  });
  return stdout;
}
