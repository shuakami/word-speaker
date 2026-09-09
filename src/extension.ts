import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import { spawn, execFile, ChildProcess } from 'child_process';

const API_BASE = 'https://uapis.cn/api/v1/dictionary';
const WORD_RE = /[A-Za-z][A-Za-z'’-]*/;

type Accent = 'uk' | 'us';

interface Phonetic { text?: string; audio?: string }
interface Definition { part_of_speech?: string; meaning: string }
interface EnglishDefinition { part_of_speech?: string; definition: string; examples?: string[] }
interface WordForm { name: string; value: string }
interface Phrase { phrase: string; meaning: string }
interface Synonym { part_of_speech?: string; meaning?: string; words: string[] }
interface Example { source: string; translation: string }
interface Entry {
  word: string;
  phonetics?: { uk?: Phonetic; us?: Phonetic };
  exam_tags?: string[];
  definitions?: Definition[];
  english_definitions?: EnglishDefinition[];
  word_forms?: WordForm[];
  phrases?: Phrase[];
  synonyms?: Synonym[];
  examples?: Example[];
}
interface LookupResponse { found: boolean; entry?: Entry }

class ApiError extends Error {
  constructor(public status: number, message: string) { super(message); }
}

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

function cfg() {
  const c = vscode.workspace.getConfiguration('wordSpeaker');
  return {
    accent: c.get<Accent>('accent', 'us'),
    showDefinition: c.get<boolean>('showDefinition', true),
    statusBarDuration: c.get<number>('statusBarDuration', 6),
    playerCommand: c.get<string>('playerCommand', '').trim(),
    playbackMode: c.get<'auto' | 'native' | 'webview'>('playbackMode', 'auto'),
    engine: c.get<'default' | 'local'>('engine', 'local'),
  };
}

// ---------------------------------------------------------------------------
// Word extraction (selection > word under cursor, camelCase aware)
// ---------------------------------------------------------------------------

function splitCamel(word: string): { text: string; start: number }[] {
  const parts: { text: string; start: number }[] = [];
  const re = /[A-Z]+(?![a-z])|[A-Z]?[a-z]+|[A-Za-z]+/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(word)) !== null) {
    parts.push({ text: m[0], start: m.index });
  }
  return parts.length ? parts : [{ text: word, start: 0 }];
}

function getTargetWord(editor: vscode.TextEditor): string | undefined {
  const sel = editor.selection;
  if (!sel.isEmpty) {
    const text = editor.document.getText(sel).trim();
    const m = text.match(WORD_RE);
    if (m && text.length <= 64) {
      return text.replace(/[^A-Za-z'’ -]/g, '').trim();
    }
    return m?.[0];
  }
  const range = editor.document.getWordRangeAtPosition(sel.active, WORD_RE);
  if (!range) { return undefined; }
  const word = editor.document.getText(range);
  const parts = splitCamel(word);
  if (parts.length === 1) { return word; }
  const offset = sel.active.character - range.start.character;
  const hit = parts.find(p => offset >= p.start && offset <= p.start + p.text.length);
  return (hit ?? parts[0]).text;
}

// ---------------------------------------------------------------------------
// Network + cache
// ---------------------------------------------------------------------------

class Dictionary {
  private entries = new Map<string, Promise<Entry>>();
  private audioDir: string;

  constructor(private context: vscode.ExtensionContext) {
    this.audioDir = path.join(context.globalStorageUri.fsPath, 'audio');
    fs.mkdirSync(this.audioDir, { recursive: true });
  }

  private async request(url: string, timeoutMs = 8000): Promise<Response> {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), timeoutMs);
    try {
      return await fetch(url, {
        signal: ctrl.signal,
        headers: { 'User-Agent': 'vscode-word-speaker/1.0' },
      });
    } finally {
      clearTimeout(timer);
    }
  }

  lookup(word: string): Promise<Entry> {
    const key = word.toLowerCase();
    let p = this.entries.get(key);
    if (!p) {
      p = this.doLookup(word).catch(e => { this.entries.delete(key); throw e; });
      this.entries.set(key, p);
      if (this.entries.size > 500) {
        this.entries.delete(this.entries.keys().next().value as string);
      }
    }
    return p;
  }

  private async doLookup(word: string): Promise<Entry> {
    const { engine } = cfg();
    const params = new URLSearchParams({ word });
    if (engine === 'local') { params.set('engine', 'local'); }
    const res = await this.request(`${API_BASE}/lookup?${params}`);
    if (!res.ok) {
      throw new ApiError(res.status, res.status === 404 ? `词库里没有「${word}」` : `查词服务暂时不可用 (${res.status})`);
    }
    const data = (await res.json()) as LookupResponse;
    if (!data.found || !data.entry) { throw new ApiError(404, `词库里没有「${word}」`); }
    return data.entry;
  }

  audioPath(word: string, accent: Accent): string {
    const safe = word.toLowerCase().replace(/[^a-z'’ -]/g, '').replace(/\s+/g, '_');
    return path.join(this.audioDir, `${safe}.${accent}.mp3`);
  }

  async audio(word: string, accent: Accent): Promise<string> {
    const file = this.audioPath(word, accent);
    try {
      const st = await fs.promises.stat(file);
      if (st.size > 0) { return file; }
    } catch { /* not cached */ }

    const params = new URLSearchParams({ word, accent });
    const res = await this.request(`${API_BASE}/audio?${params}`);
    if (!res.ok) {
      throw new ApiError(res.status, res.status === 404 ? `没有「${word}」的${accent === 'uk' ? '英音' : '美音'}发音` : `发音服务暂时不可用 (${res.status})`);
    }
    const buf = Buffer.from(await res.arrayBuffer());
    if (buf.length === 0) { throw new ApiError(404, `没有「${word}」的发音`); }
    const tmp = `${file}.${process.pid}.tmp`;
    await fs.promises.writeFile(tmp, buf);
    await fs.promises.rename(tmp, file);
    return file;
  }

  async clearCache(): Promise<number> {
    this.entries.clear();
    const files = await fs.promises.readdir(this.audioDir).catch(() => [] as string[]);
    await Promise.all(files.map(f => fs.promises.unlink(path.join(this.audioDir, f)).catch(() => undefined)));
    return files.length;
  }
}

// ---------------------------------------------------------------------------
// Playback: native player (fast, no UI) -> webview fallback
// ---------------------------------------------------------------------------

class Player {
  private current: ChildProcess | undefined;
  private nativeCmd: Promise<string[] | undefined> | undefined;
  private panel: vscode.WebviewPanel | undefined;
  private panelReady: Promise<void> = Promise.resolve();

  constructor(private context: vscode.ExtensionContext, private audioDir: string) {}

  async play(file: string): Promise<void> {
    const { playbackMode, playerCommand } = cfg();
    if (playbackMode !== 'webview') {
      const cmd = playerCommand ? this.customCommand(playerCommand, file) : await this.detectNative(file);
      if (cmd) {
        this.spawnPlayer(cmd);
        return;
      }
      if (playbackMode === 'native') {
        throw new Error('未找到系统播放器，请安装 mpv / ffplay / mpg123，或在设置里指定 wordSpeaker.playerCommand');
      }
    }
    await this.playInWebview(file);
  }

  private customCommand(template: string, file: string): string[] {
    const parts = template.match(/(?:[^\s"]+|"[^"]*")+/g) ?? [];
    return parts.map(p => p.replace(/^"|"$/g, '').split('{file}').join(file));
  }

  private spawnPlayer(cmd: string[]) {
    this.current?.kill();
    const [bin, ...args] = cmd;
    const child = spawn(bin, args, { stdio: 'ignore', windowsHide: true });
    child.on('error', () => { this.nativeCmd = undefined; });
    this.current = child;
  }

  private static which(bin: string): Promise<boolean> {
    return new Promise(resolve => {
      execFile(process.platform === 'win32' ? 'where' : 'which', [bin], err => resolve(!err));
    });
  }

  private async detectNative(file: string): Promise<string[] | undefined> {
    if (!this.nativeCmd) {
      this.nativeCmd = (async (): Promise<string[] | undefined> => {
        if (process.platform === 'darwin') { return ['afplay', '{file}']; }
        if (process.platform === 'win32') {
          const ps = [
            'Add-Type -AssemblyName PresentationCore;',
            '$p = New-Object System.Windows.Media.MediaPlayer;',
            '$p.Open([Uri]\'{file}\'); $p.Volume = 1; $p.Play();',
            '$t = 0; while (-not $p.NaturalDuration.HasTimeSpan -and $t -lt 40) { Start-Sleep -Milliseconds 50; $t++ };',
            'if ($p.NaturalDuration.HasTimeSpan) { $d = $p.NaturalDuration.TimeSpan.TotalMilliseconds + 250; Start-Sleep -Milliseconds ([int]$d) } else { Start-Sleep -Seconds 3 };',
            '$p.Close()',
          ].join(' ');
          return ['powershell', '-NoProfile', '-NonInteractive', '-WindowStyle', 'Hidden', '-ExecutionPolicy', 'Bypass', '-Command', ps];
        }
        const candidates: string[][] = [
          ['mpv', '--no-video', '--really-quiet', '--no-terminal', '{file}'],
          ['ffplay', '-nodisp', '-autoexit', '-loglevel', 'quiet', '{file}'],
          ['mpg123', '-q', '{file}'],
          ['play', '-q', '{file}'],
          ['cvlc', '--play-and-exit', '--quiet', '{file}'],
        ];
        for (const c of candidates) {
          if (await Player.which(c[0])) { return c; }
        }
        return undefined;
      })();
    }
    const cmd = await this.nativeCmd;
    if (!cmd) { return undefined; }
    const escaped = process.platform === 'win32' ? file.replace(/'/g, "''") : file;
    return cmd.map(a => a.split('{file}').join(escaped));
  }

  private async playInWebview(file: string): Promise<void> {
    if (!this.panel) {
      const panel = vscode.window.createWebviewPanel(
        'wordSpeaker.player',
        '🔊 Word Speaker',
        { viewColumn: vscode.ViewColumn.Beside, preserveFocus: true },
        {
          enableScripts: true,
          retainContextWhenHidden: true,
          localResourceRoots: [vscode.Uri.file(this.audioDir)],
        },
      );
      this.panel = panel;
      let resolveReady!: () => void;
      this.panelReady = new Promise<void>(r => (resolveReady = r));
      panel.webview.onDidReceiveMessage(msg => { if (msg?.type === 'ready') { resolveReady(); } });
      panel.onDidDispose(() => { this.panel = undefined; });
      panel.webview.html = Player.html(panel.webview.cspSource);
      this.context.subscriptions.push(panel);
    }
    await this.panelReady;
    const src = this.panel.webview.asWebviewUri(vscode.Uri.file(file)).toString();
    this.panel.webview.postMessage({ type: 'play', src, name: path.basename(file, '.mp3').replace(/\.(uk|us)$/, ' ($1)') });
  }

  private static html(csp: string): string {
    return /* html */ `<!DOCTYPE html>
<html lang="zh-CN"><head><meta charset="UTF-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; media-src ${csp}; style-src 'unsafe-inline'; script-src 'unsafe-inline';">
<style>
  html,body{height:100%;margin:0;display:flex;align-items:center;justify-content:center;font-family:var(--vscode-font-family);color:var(--vscode-foreground);background:transparent}
  .card{text-align:center;opacity:.85}
  .word{font-size:1.6em;font-weight:600;margin-bottom:.4em}
  .hint{font-size:.85em;opacity:.7;max-width:32em;line-height:1.5}
  code{font-family:var(--vscode-editor-font-family)}
</style></head>
<body><div class="card"><div class="word" id="w">🔊 Word Speaker</div>
<div class="hint">这是内置播放器面板，保持打开即可（可以拖到底部或缩小）。<br>
想彻底隐藏它：安装 <code>mpv</code>/<code>ffplay</code>/<code>mpg123</code>，或在设置 <code>wordSpeaker.playerCommand</code> 指定播放命令。</div></div>
<audio id="a"></audio>
<script>
  const vscode = acquireVsCodeApi();
  const a = document.getElementById('a'), w = document.getElementById('w');
  window.addEventListener('message', e => {
    if (e.data?.type !== 'play') return;
    w.textContent = '🔊 ' + e.data.name;
    a.pause(); a.src = e.data.src; a.currentTime = 0;
    a.play().catch(() => {});
  });
  vscode.postMessage({ type: 'ready' });
</script></body></html>`;
  }

  dispose() { this.current?.kill(); }
}

// ---------------------------------------------------------------------------
// Status bar
// ---------------------------------------------------------------------------

class Status {
  private item: vscode.StatusBarItem;
  private timer: NodeJS.Timeout | undefined;

  constructor(context: vscode.ExtensionContext) {
    this.item = vscode.window.createStatusBarItem('wordSpeaker.status', vscode.StatusBarAlignment.Left, 10000);
    this.item.name = 'Word Speaker';
    this.item.command = 'wordSpeaker.lookup';
    context.subscriptions.push(this.item);
  }

  loading(word: string) {
    this.set(`$(loading~spin) ${word}`, undefined, undefined);
  }

  show(text: string, tooltip?: vscode.MarkdownString | string, background?: vscode.ThemeColor) {
    this.set(text, tooltip, background);
    this.scheduleHide(cfg().statusBarDuration * 1000);
  }

  error(text: string) {
    this.set(`$(warning) ${text}`, undefined, new vscode.ThemeColor('statusBarItem.warningBackground'));
    this.scheduleHide(4000);
  }

  private set(text: string, tooltip: vscode.MarkdownString | string | undefined, background: vscode.ThemeColor | undefined) {
    if (this.timer) { clearTimeout(this.timer); this.timer = undefined; }
    this.item.text = text;
    this.item.tooltip = tooltip;
    this.item.backgroundColor = background;
    this.item.show();
  }

  private scheduleHide(ms: number) {
    this.timer = setTimeout(() => this.item.hide(), ms);
  }
}

// ---------------------------------------------------------------------------
// Formatting helpers
// ---------------------------------------------------------------------------

function phoneticText(entry: Entry, accent: Accent): string | undefined {
  const t = entry.phonetics?.[accent]?.text ?? entry.phonetics?.uk?.text ?? entry.phonetics?.us?.text;
  return t ? `/${t}/` : undefined;
}

function shortDefinition(entry: Entry, max = 60): string | undefined {
  const defs = entry.definitions ?? [];
  if (!defs.length) {
    const en = entry.english_definitions?.[0];
    return en ? `${en.part_of_speech ?? ''} ${en.definition}`.trim() : undefined;
  }
  let out = '';
  for (const d of defs) {
    const piece = `${d.part_of_speech ? d.part_of_speech + ' ' : ''}${d.meaning}`;
    const next = out ? `${out}  ${piece}` : piece;
    if (next.length > max) { break; }
    out = next;
  }
  if (!out) { out = `${defs[0].part_of_speech ?? ''} ${defs[0].meaning}`.trim(); }
  return out.length > max ? out.slice(0, max - 1) + '…' : out;
}

function tooltipMarkdown(entry: Entry): vscode.MarkdownString {
  const md = new vscode.MarkdownString(undefined, true);
  md.isTrusted = true;
  const uk = entry.phonetics?.uk?.text, us = entry.phonetics?.us?.text;
  md.appendMarkdown(`### ${entry.word}\n\n`);
  const ph: string[] = [];
  if (uk) { ph.push(`英 /${uk}/`); }
  if (us) { ph.push(`美 /${us}/`); }
  if (ph.length) { md.appendMarkdown(`${ph.join('   ')}\n\n`); }
  if (entry.exam_tags?.length) { md.appendMarkdown(`*${entry.exam_tags.join(' / ')}*\n\n`); }
  for (const d of entry.definitions ?? []) {
    md.appendMarkdown(`- **${d.part_of_speech ?? ''}** ${d.meaning}\n`);
  }
  if (entry.examples?.length) {
    const e = entry.examples[0];
    md.appendMarkdown(`\n> ${e.source}\n>\n> ${e.translation}\n`);
  }
  const w = encodeURIComponent(JSON.stringify([entry.word]));
  md.appendMarkdown(`\n---\n$(unmute) [英音](command:wordSpeaker.speakUK?${w})   [美音](command:wordSpeaker.speakUS?${w})   $(book) [详情](command:wordSpeaker.lookup?${w})`);
  return md;
}

// ---------------------------------------------------------------------------
// Extension
// ---------------------------------------------------------------------------

let dict: Dictionary;
let player: Player;
let status: Status;
let lastWord: string | undefined;

function resolveWord(arg: unknown): string | undefined {
  if (typeof arg === 'string' && arg.trim()) { return arg.trim(); }
  const editor = vscode.window.activeTextEditor;
  if (!editor) { return undefined; }
  return getTargetWord(editor);
}

async function speak(arg: unknown, accentOverride?: Accent): Promise<void> {
  const word = resolveWord(arg);
  if (!word) {
    status.error('光标下没有英文单词');
    return;
  }
  lastWord = word;
  const accent = accentOverride ?? cfg().accent;
  const { showDefinition } = cfg();
  status.loading(word);

  const audioP = dict.audio(word, accent);
  const entryP = showDefinition ? dict.lookup(word).catch(() => undefined) : Promise.resolve(undefined);

  let audioFile: string | undefined;
  try {
    audioFile = await audioP;
    await player.play(audioFile);
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    if (e instanceof ApiError && e.status === 404) {
      const entry = await entryP;
      if (entry) {
        status.show(`$(mute) ${word}  ${phoneticText(entry, accent) ?? ''}  ${shortDefinition(entry) ?? ''}`, tooltipMarkdown(entry));
      } else {
        status.error(msg);
      }
    } else {
      status.error(msg.includes('abort') ? '网络超时，请稍后重试' : msg);
    }
    return;
  }

  const entry = await entryP;
  const accentLabel = accent === 'uk' ? '英' : '美';
  if (entry) {
    const parts = [`$(unmute) ${word}`, phoneticText(entry, accent), shortDefinition(entry)].filter(Boolean);
    status.show(parts.join('  '), tooltipMarkdown(entry));
  } else {
    status.show(`$(unmute) ${word}  ${accentLabel}音`, `点击查看「${word}」的释义`);
  }
}

interface LookupItem extends vscode.QuickPickItem { copy?: string }

async function lookup(arg: unknown): Promise<void> {
  const word = resolveWord(arg);
  if (!word) { status.error('光标下没有英文单词'); return; }
  lastWord = word;

  const qp = vscode.window.createQuickPick<LookupItem>();
  qp.title = `查词：${word}`;
  qp.busy = true;
  qp.placeholder = '正在查询…';
  qp.matchOnDescription = true;
  qp.matchOnDetail = true;
  const playUK: vscode.QuickInputButton = { iconPath: new vscode.ThemeIcon('unmute'), tooltip: '播放英音' };
  const playUS: vscode.QuickInputButton = { iconPath: new vscode.ThemeIcon('broadcast'), tooltip: '播放美音' };
  qp.buttons = [playUK, playUS];
  qp.onDidTriggerButton(b => { void speak(word, b === playUK ? 'uk' : 'us'); });
  qp.onDidAccept(() => {
    const item = qp.selectedItems[0];
    if (item?.copy) {
      void vscode.env.clipboard.writeText(item.copy);
      vscode.window.setStatusBarMessage(`$(check) 已复制：${item.copy}`, 2500);
    }
    qp.hide();
  });
  qp.onDidHide(() => qp.dispose());
  qp.show();

  void speak(word);

  try {
    const entry = await dict.lookup(word);
    const uk = entry.phonetics?.uk?.text, us = entry.phonetics?.us?.text;
    const ph = [uk && `英 /${uk}/`, us && `美 /${us}/`].filter(Boolean).join('   ');
    qp.title = `${entry.word}   ${ph}${entry.exam_tags?.length ? '   ' + entry.exam_tags.join(' / ') : ''}`;
    qp.placeholder = '输入关键字过滤，Enter 复制该行，右上角按钮播放英/美音';

    const items: LookupItem[] = [];
    const sep = (label: string): LookupItem => ({ label, kind: vscode.QuickPickItemKind.Separator });

    if (entry.definitions?.length) {
      items.push(sep('中文释义'));
      for (const d of entry.definitions) {
        items.push({ label: `$(symbol-key) ${d.part_of_speech ?? ''}`.trim(), description: d.meaning, copy: d.meaning });
      }
    }
    if (entry.english_definitions?.length) {
      items.push(sep('英英释义'));
      for (const d of entry.english_definitions) {
        items.push({
          label: `$(symbol-string) ${d.part_of_speech ?? ''}`.trim(),
          description: d.definition,
          detail: d.examples?.[0],
          copy: d.definition,
        });
      }
    }
    if (entry.examples?.length) {
      items.push(sep('例句'));
      for (const e of entry.examples) {
        items.push({ label: `$(quote) ${e.source}`, detail: e.translation, copy: e.source });
      }
    }
    if (entry.word_forms?.length) {
      items.push(sep('词形变化'));
      items.push({
        label: '$(symbol-enum) ' + entry.word_forms.map(f => `${f.name} ${f.value}`).join('   '),
        copy: entry.word_forms.map(f => `${f.name}: ${f.value}`).join(', '),
      });
    }
    if (entry.phrases?.length) {
      items.push(sep('常用词组'));
      for (const p of entry.phrases) {
        items.push({ label: `$(link) ${p.phrase}`, description: p.meaning, copy: p.phrase });
      }
    }
    if (entry.synonyms?.length) {
      items.push(sep('近义词'));
      for (const s of entry.synonyms) {
        items.push({
          label: `$(symbol-misc) ${s.part_of_speech ?? ''} ${s.meaning ?? ''}`.trim(),
          description: s.words.join(', '),
          copy: s.words.join(', '),
        });
      }
    }
    qp.items = items;
  } catch (e) {
    qp.items = [{ label: `$(warning) ${e instanceof Error ? e.message : String(e)}` }];
    qp.placeholder = '';
  } finally {
    qp.busy = false;
  }
}

export function activate(context: vscode.ExtensionContext) {
  dict = new Dictionary(context);
  player = new Player(context, path.join(context.globalStorageUri.fsPath, 'audio'));
  status = new Status(context);
  context.subscriptions.push({ dispose: () => player.dispose() });

  context.subscriptions.push(
    vscode.commands.registerCommand('wordSpeaker.speak', (arg?: unknown) => speak(arg)),
    vscode.commands.registerCommand('wordSpeaker.speakUK', (arg?: unknown) => speak(arg, 'uk')),
    vscode.commands.registerCommand('wordSpeaker.speakUS', (arg?: unknown) => speak(arg, 'us')),
    vscode.commands.registerCommand('wordSpeaker.lookup', (arg?: unknown) => lookup(arg)),
    vscode.commands.registerCommand('wordSpeaker.repeat', () => {
      if (lastWord) { return speak(lastWord); }
      status.error('还没有读过单词');
    }),
    vscode.commands.registerCommand('wordSpeaker.toggleAccent', async () => {
      const next: Accent = cfg().accent === 'uk' ? 'us' : 'uk';
      await vscode.workspace.getConfiguration('wordSpeaker').update('accent', next, vscode.ConfigurationTarget.Global);
      status.show(`$(unmute) 已切换为${next === 'uk' ? '英式' : '美式'}发音`, undefined);
      if (lastWord) { void speak(lastWord, next); }
    }),
    vscode.commands.registerCommand('wordSpeaker.clearCache', async () => {
      const n = await dict.clearCache();
      status.show(`$(trash) 已清除 ${n} 个发音缓存`, undefined);
    }),
  );
}

export function deactivate() {
  player?.dispose();
}
