/**
 * Next.js instrumentation:server 啟動時跑一次。
 * 用來回收上次重啟時卡死的背景任務(可續跑的從斷點續跑)。
 */
export async function register() {
  if (process.env.NEXT_RUNTIME === "nodejs") {
    const { recoverZombieJobs } = await import("./lib/pipeline/resume");
    recoverZombieJobs();
  }
}
