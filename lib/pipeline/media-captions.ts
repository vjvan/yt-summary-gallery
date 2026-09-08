/**
 * 非 YouTube 來源（X／Vimeo／Bilibili…）的字幕優先路徑。
 *
 * 這些站不少影片本身就附字幕（X 的字幕還帶逐字時間軸）。原本的流程一律先用 yt-dlp 下載整支影片
 * 再跑本機 Whisper 聽打：實測一支 56 分鐘的 X podcast 要抓 4.3 GB、聽打十幾分鐘，而網站早就給了
 * 1573 句現成字幕。這個模組負責「先問有沒有字幕」，有就只抓那個字幕檔（幾百 KB），整支影片不下載。
 *
 * 只讀取與解析，不寫資料庫。
 */
import fs from 'node:fs';
import path from 'node:path';
import { run } from './run-command';

export interface CaptionSegment { start: number; end: number; text: string }
export interface CaptionTrack { lang: string; automatic: boolean }
export interface MediaProbe {
  title: string;
  channel: string;
  duration: number;
  thumbnailUrl: string;
  manualLangs: string[];
  autoLangs: string[];
}

/** yt-dlp 產生的假語言軌，不是字幕。 */
const NOT_SUBTITLES = new Set(['live_chat', 'rechat']);
const TIME = String.raw`(?:(\d{1,3}):)?(\d{1,2}):(\d{1,2})[.,](\d{1,3})`;
const CUE_LINE = new RegExp(`^${TIME}\\s+-->\\s+${TIME}`);

export function resolveYtDlp(): string {
  if (process.env.YTDLP_BIN) return process.env.YTDLP_BIN;
  for (const candidate of ['/opt/homebrew/bin/yt-dlp', '/usr/local/bin/yt-dlp']) {
    if (fs.existsSync(candidate)) return candidate;
  }
  return 'yt-dlp';
}

const langList = (value: unknown): string[] => value && typeof value === 'object' && !Array.isArray(value)
  ? Object.keys(value as Record<string, unknown>).filter(lang => !NOT_SUBTITLES.has(lang)) : [];

/** 一次 metadata 查詢就好：標題、時長、有哪些字幕語言。不下載任何媒體。 */
export async function probeMedia(url: string, timeoutMs = 120_000): Promise<MediaProbe> {
  const stdout = await run(`"${resolveYtDlp()}" --no-warnings --skip-download --no-playlist -J "${url}"`, { timeoutMs });
  const info = JSON.parse(stdout) as Record<string, unknown>;
  return {
    title: String(info.title || info.fulltitle || 'Video'),
    channel: String(info.uploader || info.channel || info.creator || ''),
    duration: typeof info.duration === 'number' && Number.isFinite(info.duration) ? info.duration : 0,
    thumbnailUrl: typeof info.thumbnail === 'string' ? info.thumbnail : '',
    manualLangs: langList(info.subtitles),
    autoLangs: langList(info.automatic_captions),
  };
}

/**
 * 挑一條字幕軌：人工字幕優先於自動字幕（自動字幕的斷句與錯字都差一截）；
 * 語言優先英文，其次中文，再其次第一個有的。挑不到回 null，呼叫端就走聽打。
 */
export function pickCaptionTrack(probe: Pick<MediaProbe, 'manualLangs' | 'autoLangs'>): CaptionTrack | null {
  const prefer = (langs: string[]): string | null => {
    const byPrefix = (prefix: string) => langs.find(lang => lang.toLowerCase() === prefix)
      ?? langs.find(lang => lang.toLowerCase().startsWith(`${prefix}-`));
    return byPrefix('en') ?? byPrefix('zh') ?? langs[0] ?? null;
  };
  const manual = prefer(probe.manualLangs);
  if (manual) return { lang: manual, automatic: false };
  const automatic = prefer(probe.autoLangs);
  return automatic ? { lang: automatic, automatic: true } : null;
}

/** 只抓字幕檔（VTT），回傳本機路徑。 */
export async function downloadCaptionTrack(url: string, track: CaptionTrack, contentId: string, tmpDir: string, timeoutMs = 180_000): Promise<string> {
  fs.mkdirSync(tmpDir, { recursive: true });
  const flag = track.automatic ? '--write-auto-subs' : '--write-subs';
  await run(`"${resolveYtDlp()}" --no-warnings --skip-download --no-playlist ${flag} --sub-langs "${track.lang}" --sub-format "vtt/best" ` +
    `-o "${path.join(tmpDir, `${contentId}.%(ext)s`)}" "${url}"`, { timeoutMs });
  const written = fs.readdirSync(tmpDir).filter(name => name.startsWith(`${contentId}.`) && /\.(vtt|srt)$/i.test(name));
  if (!written.length) throw new Error('字幕軌下載後找不到檔案');
  // 同語言可能有多個檔（例如 en 與 en-US），挑最大的那個內容最完整。
  const best = written.map(name => path.join(tmpDir, name)).sort((a, b) => fs.statSync(b).size - fs.statSync(a).size)[0];
  return best;
}

const toSeconds = (hours: string | undefined, minutes: string, seconds: string, millis: string) =>
  Number(hours || 0) * 3600 + Number(minutes) * 60 + Number(seconds) + Number(millis.padEnd(3, '0')) / 1000;

/**
 * VTT／SRT → 句子。清掉標記語言：X 的 `<X-word-ms …>`、YouTube 自動字幕的 `<c>` 與行內時間戳、
 * HTML 實體與控制字元。滾動式字幕（同一句連續重複）只留一次。
 */
export function parseCaptionFile(content: string): CaptionSegment[] {
  const segments: CaptionSegment[] = [];
  const lines = content.replace(/\r\n?/g, '\n').split('\n');
  for (let index = 0; index < lines.length; index++) {
    const match = CUE_LINE.exec(lines[index].trim());
    if (!match) continue;
    const start = toSeconds(match[1], match[2], match[3], match[4]);
    const end = toSeconds(match[5], match[6], match[7], match[8]);
    const body: string[] = [];
    for (index++; index < lines.length && lines[index].trim() !== ''; index++) body.push(lines[index]);
    const text = body.join(' ')
      .replace(/<[^>]*>/g, ' ')
      .replace(/&nbsp;/gi, ' ').replace(/&amp;/gi, '&').replace(/&lt;/gi, '<').replace(/&gt;/gi, '>').replace(/&#39;|&apos;/gi, "'").replace(/&quot;/gi, '"')
      .replace(/[\p{Cc}\u2028\u2029\u200B-\u200F\u202A-\u202E\u2066-\u2069]+/gu, ' ')
      .replace(/\s+/g, ' ')
      .trim();
    if (!text || !(end > start)) continue;
    const previous = segments[segments.length - 1];
    // 滾動字幕：同一句被連續送好幾次，或後一句只是前一句的尾巴（「so we started with nothing」→「started with nothing」），
    // 只留第一次並延長它的結束時間。只在時間相接時才收，避免把真的重複的話刪掉。
    if (previous && start <= previous.end + 0.05 && (previous.text === text || previous.text.endsWith(text))) {
      previous.end = Math.max(previous.end, end);
      continue;
    }
    segments.push({ start, end, text });
  }
  return segments.sort((a, b) => a.start - b.start || a.end - b.end);
}

export interface LoadedCaptions { segments: CaptionSegment[]; transcript: string; source: string }

/** 抓字幕並解析；語言軌抓不到或內容太少（少於 5 句）就當作沒有，讓呼叫端退回聽打。 */
export async function loadCaptions(url: string, track: CaptionTrack, contentId: string, tmpDir: string): Promise<LoadedCaptions | null> {
  const file = await downloadCaptionTrack(url, track, contentId, tmpDir);
  const segments = parseCaptionFile(fs.readFileSync(file, 'utf8'));
  if (segments.length < 5) return null;
  return { segments, transcript: segments.map(segment => segment.text).join(' '), source: `captions:${track.automatic ? 'auto:' : ''}${track.lang}` };
}
