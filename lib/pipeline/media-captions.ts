/**
 * 非 YouTube 來源（X／Vimeo／Bilibili…）的字幕優先路徑。
 *
 * 這些站不少影片本身就附字幕（X 的字幕還帶逐字時間軸）。原本的流程一律先用 yt-dlp 下載整支影片
 * 再跑本機 Whisper 聽打：實測一支 56 分鐘的 X podcast 要抓 4.3 GB、聽打十幾分鐘，而網站早就給了
 * 1573 句現成字幕。這個模組負責「先問有沒有字幕」，有就只抓那個字幕檔（幾百 KB），整支影片不下載。
 *
 * 安全前提：URL 與字幕語言代碼都來自使用者或第三方網站，一律走 runArgs（不經 shell）；
 * 解析器對大小、行長、cue 數與掃描方式都有上限，惡意字幕檔不能拖垮伺服器。
 * 只讀取與解析，不寫資料庫。
 */
import fs from 'node:fs';
import path from 'node:path';
import { runArgs } from './run-command';

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

/** yt-dlp 會把彈幕與聊天室也列進來，那不是字幕。 */
const NOT_SUBTITLES = /^(live_chat|rechat|danmaku)$/i;
/** 只收翻譯層處理得了的語言：目前是英文→繁中與簡轉繁（見 lib/pipeline/translate.ts）。 */
const TRANSLATABLE = /^(en|zh)(-|$)/i;
/** BCP-47 樣子的語言代碼；yt-dlp 的 --sub-langs 會把值當成 regex，非這個形狀的一律不用。 */
const SAFE_LANG = /^[A-Za-z][A-Za-z0-9]*(?:-[A-Za-z0-9]+)*$/;
const CAPTION_MAX_BYTES = 8 * 1024 * 1024;
const MAX_LINE_CHARS = 4000;
const MAX_CUES = 100_000;
const TIME = String.raw`(?:(\d{1,3}):)?(\d{1,2}):(\d{1,2})[.,](\d{1,3})`;
const CUE_LINE = new RegExp(`^${TIME}\\s+-->\\s+${TIME}`);
const CONTROL = /[\p{Cc}\u2028\u2029\u200B-\u200F\u202A-\u202E\u2066-\u2069]+/gu;

export function resolveYtDlp(): string {
  if (process.env.YTDLP_BIN) return process.env.YTDLP_BIN;
  for (const candidate of ['/opt/homebrew/bin/yt-dlp', '/usr/local/bin/yt-dlp']) {
    if (fs.existsSync(candidate)) return candidate;
  }
  return 'yt-dlp';
}

/** 只接受 http(s)；其他 scheme（file:、ftp:）不該進 yt-dlp。 */
export function assertMediaUrl(url: string): string {
  let parsed: URL;
  try { parsed = new URL(url); } catch { throw new Error('連結格式無效'); }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') throw new Error('只接受 http(s) 連結');
  return parsed.toString();
}

const langList = (value: unknown): string[] => value && typeof value === 'object' && !Array.isArray(value)
  ? Object.keys(value as Record<string, unknown>).filter(lang => !NOT_SUBTITLES.test(lang) && SAFE_LANG.test(lang)) : [];

/**
 * 一次 metadata 查詢就好：標題、時長、有哪些字幕語言。不下載任何媒體。
 * `--write-subs --write-auto-subs --simulate` 是必要的：部分 extractor 只有在被要求字幕時才去抽字幕清單，
 * 少了這組旗標會誤判成「沒有字幕」。（不能改用 --list-subs，它會把表格印到 stdout，JSON 就解析不了。）
 */
export async function probeMedia(url: string, timeoutMs = 120_000): Promise<MediaProbe> {
  const stdout = await runArgs(resolveYtDlp(), [
    '--no-warnings', '--skip-download', '--no-playlist', '--write-subs', '--write-auto-subs', '--simulate', '-J', '--', assertMediaUrl(url),
  ], { timeoutMs });
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
 * 挑字幕軌：人工字幕優先於自動字幕（自動字幕的斷句與錯字都差一截），語言優先英文再中文。
 * 只挑翻譯層處理得了的語言；只有韓文日文這種字幕時回 null，讓呼叫端走原本的下載加聽打，
 * 不要拿一份翻不了的原文去冒充中譯。
 */
export function pickCaptionTrack(probe: Pick<MediaProbe, 'manualLangs' | 'autoLangs'>): CaptionTrack | null {
  const prefer = (langs: string[]): string | null => {
    const usable = langs.filter(lang => TRANSLATABLE.test(lang));
    const byPrefix = (prefix: string) => usable.find(lang => lang.toLowerCase() === prefix)
      ?? usable.find(lang => lang.toLowerCase().startsWith(`${prefix}-`));
    return byPrefix('en') ?? byPrefix('zh') ?? null;
  };
  const manual = prefer(probe.manualLangs);
  if (manual) return { lang: manual, automatic: false };
  const automatic = prefer(probe.autoLangs);
  return automatic ? { lang: automatic, automatic: true } : null;
}

/**
 * 只抓字幕檔，回傳本機路徑。每一軌下載到自己的子目錄：同一個工作目錄裡若留著上一次別種語言的檔案，
 * 用「挑最大的」會拿到不相干的語言，來源標記與內容就對不起來。
 */
export async function downloadCaptionTrack(url: string, track: CaptionTrack, contentId: string, tmpDir: string, timeoutMs = 180_000): Promise<string> {
  if (!SAFE_LANG.test(track.lang)) throw new Error('字幕語言代碼格式無效');
  const trackDir = path.join(tmpDir, `subs-${track.automatic ? 'auto-' : ''}${track.lang}`);
  fs.rmSync(trackDir, { recursive: true, force: true });
  fs.mkdirSync(trackDir, { recursive: true });
  await runArgs(resolveYtDlp(), [
    '--no-warnings', '--skip-download', '--no-playlist',
    track.automatic ? '--write-auto-subs' : '--write-subs',
    '--sub-langs', track.lang, '--sub-format', 'vtt/srt/best',
    '-o', path.join(trackDir, `${contentId}.%(ext)s`), '--', assertMediaUrl(url),
  ], { timeoutMs });
  const written = fs.readdirSync(trackDir).filter(name => /\.(vtt|srt)$/i.test(name));
  if (!written.length) throw new Error('這一軌沒有可解析的字幕格式（VTT 或 SRT）');
  const file = path.join(trackDir, written.sort((a, b) => fs.statSync(path.join(trackDir, b)).size - fs.statSync(path.join(trackDir, a)).size)[0]);
  if (fs.statSync(file).size > CAPTION_MAX_BYTES) throw new Error('字幕檔過大，改走聽打');
  return file;
}

const toSeconds = (hours: string | undefined, minutes: string, seconds: string, millis: string) =>
  Number(hours || 0) * 3600 + Number(minutes) * 60 + Number(seconds) + Number(millis.padEnd(3, '0')) / 1000;

/** 線性去標籤：`/<[^>]*>/g` 遇到沒有結尾的 `<` 會退回重掃，惡意字幕能拿它把伺服器拖住。 */
export function stripTags(text: string): string {
  let out = '';
  let depth = 0;
  for (const character of text) {
    if (character === '<') { depth++; continue; }
    if (character === '>') { if (depth > 0) { depth--; out += ' '; } continue; }
    if (depth === 0) out += character;
  }
  return out;
}

/** 一句是否只是前一句的滾動重播：時間要有實際重疊，而且接在字詞邊界上。 */
function rollingRepeat(previous: CaptionSegment, next: CaptionSegment): boolean {
  if (next.start >= previous.end) return false; // 相接不算重疊；「No.」接「No.」是真的說了兩次
  if (previous.text === next.text) return true;
  return previous.text.endsWith(next.text) && /\s/.test(previous.text[previous.text.length - next.text.length - 1] ?? '');
}

/**
 * VTT／SRT → 句子。清掉標記語言：X 的 `<X-word-ms …>`、YouTube 式的 `<c>` 與行內時間戳、
 * HTML 實體與控制字元。先依時間排序再收滾動重播，亂序的檔案不會誤刪較早的句子。
 */
export function parseCaptionFile(content: string): CaptionSegment[] {
  const cues: CaptionSegment[] = [];
  const lines = content.replace(/\r\n?/g, '\n').split('\n');
  for (let index = 0; index < lines.length && cues.length < MAX_CUES; index++) {
    const line = lines[index];
    if (line.length > MAX_LINE_CHARS) continue;
    const match = CUE_LINE.exec(line.trim());
    if (!match) continue;
    const start = toSeconds(match[1], match[2], match[3], match[4]);
    const end = toSeconds(match[5], match[6], match[7], match[8]);
    const body: string[] = [];
    for (index++; index < lines.length && lines[index].trim() !== ''; index++) {
      if (lines[index].length <= MAX_LINE_CHARS) body.push(lines[index]);
    }
    const text = stripTags(body.join(' '))
      .replace(/&nbsp;/gi, ' ').replace(/&amp;/gi, '&').replace(/&lt;/gi, '<').replace(/&gt;/gi, '>').replace(/&#39;|&apos;/gi, "'").replace(/&quot;/gi, '"')
      .replace(CONTROL, ' ')
      .replace(/\s+/g, ' ')
      .trim();
    if (!text || !(end > start)) continue;
    cues.push({ start, end, text });
  }
  cues.sort((a, b) => a.start - b.start || a.end - b.end);
  const segments: CaptionSegment[] = [];
  for (const cue of cues) {
    const previous = segments[segments.length - 1];
    if (previous && rollingRepeat(previous, cue)) { previous.end = Math.max(previous.end, cue.end); continue; }
    segments.push(cue);
  }
  return segments;
}

export interface LoadedCaptions { segments: CaptionSegment[]; transcript: string; source: string; lang: string }

/** 抓字幕並解析；抓不到或內容太少（少於 5 句）就回 null，讓呼叫端退回聽打。 */
export async function loadCaptions(url: string, track: CaptionTrack, contentId: string, tmpDir: string): Promise<LoadedCaptions | null> {
  const file = await downloadCaptionTrack(url, track, contentId, tmpDir);
  const segments = parseCaptionFile(fs.readFileSync(file, 'utf8'));
  if (segments.length < 5) return null;
  return {
    segments,
    transcript: segments.map(segment => segment.text).join(' '),
    source: `captions:${track.automatic ? 'auto:' : ''}${track.lang}`,
    lang: track.lang,
  };
}
