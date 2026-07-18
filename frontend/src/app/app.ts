import {
  Component,
  ElementRef,
  OnInit,
  ViewChild,
  computed,
  effect,
  inject,
  signal,
} from '@angular/core';
import { FormsModule } from '@angular/forms';
import { ApiService, BuildRecord, ConfigInfo, Target } from './api.service';

type RunKind = 'build' | 'validate';
type RunStatus = 'success' | 'failed' | 'valid' | 'invalid' | 'error';

/** Base-config keys that are NOT platform components.
 *  Mirror of `RESERVED` in engine/src/platforms.rs (BaseConfig fields). */
const RESERVED = new Set([
  'ubihome',
  'logger',
  'button',
  'sensor',
  'binary_sensor',
  'number',
  'switch',
  'light',
  'text_sensor',
]);

/** Client-side mirror of the engine's component detection, for a live panel. */
function detectPlatforms(config: string): string[] {
  const found: string[] = [];
  for (const line of config.split('\n')) {
    if (
      line.startsWith(' ') ||
      line.startsWith('\t') ||
      line === '' ||
      line.startsWith('#') ||
      line.startsWith('-')
    ) {
      continue;
    }
    const key = line.split(':')[0]?.trim();
    if (!key || RESERVED.has(key)) continue;
    if (!found.includes(key)) found.push(key);
  }
  return found.sort();
}

@Component({
  selector: 'app-root',
  imports: [FormsModule],
  templateUrl: './app.html',
  styleUrl: './app.css',
})
export class App implements OnInit {
  private api = inject(ApiService);

  view = signal<'editor' | 'history'>('editor');

  configs = signal<ConfigInfo[]>([]);
  targets = signal<Target[]>([]);
  versions = signal<string[]>([]);
  builds = signal<BuildRecord[]>([]);

  selected = signal<string | null>(null);
  content = signal('');
  selectedTarget = signal<string>(''); // '' == native host
  selectedVersion = signal<string>(''); // '' == latest stable

  /** Which action (if any) is currently streaming into the console. */
  active = signal(false);
  /** Which action populated the console — persists after `active` goes false
   *  so the console can still show what it's reporting on. */
  kind = signal<RunKind | null>(null);
  runStatus = signal<RunStatus | null>(null);
  logLines = signal<string[]>([]);
  logCollapsed = signal(false);
  banner = signal<string | null>(null);

  /** Snapshot of the config/params that produced the most recent successful
   *  build, so we can offer Download instead of re-running an identical build. */
  lastSuccessfulBuild = signal<{
    config: string;
    content: string;
    target: string;
    version: string;
    buildId: number;
  } | null>(null);

  building = computed(() => this.active() && this.kind() === 'build');
  validating = computed(() => this.active() && this.kind() === 'validate');

  /** True while the editor's config/target/version still match the last
   *  successful build — nothing to rebuild, only to download. */
  canDownloadInsteadOfBuild = computed(() => {
    const lb = this.lastSuccessfulBuild();
    if (!lb) return false;
    return (
      lb.config === this.selected() &&
      lb.content === this.content() &&
      lb.target === this.selectedTarget() &&
      lb.version === this.selectedVersion()
    );
  });

  @ViewChild('logBox') logBox?: ElementRef<HTMLPreElement>;

  /** Live component detection from the editor content. */
  detected = computed(() => detectPlatforms(this.content()));

  constructor() {
    // Keep the console pinned to the latest line as it streams in.
    effect(() => {
      this.logLines();
      queueMicrotask(() => {
        const el = this.logBox?.nativeElement;
        if (el) el.scrollTop = el.scrollHeight;
      });
    });
  }

  async ngOnInit() {
    await this.refreshConfigs();
    try {
      this.targets.set(await this.api.targets());
    } catch (e) {
      this.flash('Could not load targets: ' + e);
    }
    // Versions require a clone/fetch; load in the background.
    this.api
      .versions()
      .then((v) => this.versions.set(v.versions))
      .catch((e) => this.flash('Could not load versions: ' + e));
  }

  private flash(msg: string) {
    this.banner.set(msg);
    setTimeout(() => this.banner.set(null), 4000);
  }

  async refreshConfigs() {
    this.configs.set(await this.api.listConfigs());
  }

  async openConfig(name: string) {
    const detail = await this.api.getConfig(name);
    this.selected.set(name);
    this.content.set(detail.content);
    this.logLines.set([]);
    this.runStatus.set(null);
    this.kind.set(null);
    this.view.set('editor');
  }

  async newConfig() {
    const name = prompt('New config file name (e.g. living-room.yml)');
    if (!name) return;
    try {
      await this.api.createConfig(name);
      await this.refreshConfigs();
      await this.openConfig(name);
    } catch (e: any) {
      this.flash(e?.error?.error ?? 'Could not create config');
    }
  }

  async save() {
    const name = this.selected();
    if (!name) return;
    await this.api.saveConfig(name, this.content());
    await this.refreshConfigs();
    this.flash('Saved');
  }

  async deleteConfig(name: string, ev: Event) {
    ev.stopPropagation();
    if (!confirm(`Delete ${name}?`)) return;
    await this.api.deleteConfig(name);
    if (this.selected() === name) {
      this.selected.set(null);
      this.content.set('');
    }
    await this.refreshConfigs();
  }

  async duplicate(name: string, ev: Event) {
    ev.stopPropagation();
    const to = prompt('Duplicate as:', name.replace(/\.ya?ml$/, '') + '-copy.yml');
    if (!to) return;
    await this.api.duplicateConfig(name, to);
    await this.refreshConfigs();
  }

  /** Reset console state and open it for a fresh build/validate run. */
  private startRun(k: RunKind) {
    this.kind.set(k);
    this.active.set(true);
    this.runStatus.set(null);
    this.logLines.set([]);
    this.logCollapsed.set(false);
  }

  async validate() {
    const name = this.selected();
    if (!name) return;
    await this.save();
    this.startRun('validate');
    try {
      const { validate_id } = await this.api.startValidate(name, this.selectedVersion() || null);
      const ws = this.api.openValidateLogSocket(validate_id);
      ws.onmessage = (ev) => {
        const line = ev.data as string;
        const done = /^\[validate (valid|invalid|error)\]$/.exec(line);
        if (done) {
          this.runStatus.set(done[1] as RunStatus);
        }
        this.logLines.update((lines) => [...lines, line]);
      };
      ws.onclose = () => {
        this.active.set(false);
      };
      ws.onerror = () => {
        this.logLines.update((l) => [...l, '[log stream error]']);
        this.active.set(false);
      };
    } catch (e: any) {
      this.logLines.update((l) => [...l, 'ERROR: ' + (e?.error?.error ?? String(e))]);
      this.active.set(false);
      this.runStatus.set('error');
    }
  }

  async build() {
    const name = this.selected();
    if (!name) return;
    await this.save();
    // Snapshot the params that this build actually uses — the editor stays
    // live during the build, so re-reading the signals at completion could
    // pick up edits made mid-build.
    const target = this.selectedTarget();
    const version = this.selectedVersion();
    const content = this.content();
    this.startRun('build');
    try {
      const { build_id } = await this.api.startBuild(name, target || null, version || null);
      const ws = this.api.openLogSocket(build_id);
      ws.onmessage = (ev) => {
        const line = ev.data as string;
        const done = /^\[build (success|failed)\]$/.exec(line);
        if (done) {
          this.runStatus.set(done[1] as RunStatus);
        }
        this.logLines.update((lines) => [...lines, line]);
      };
      ws.onclose = async () => {
        this.active.set(false);
        if (this.runStatus() === 'success') {
          this.lastSuccessfulBuild.set({ config: name, content, target, version, buildId: build_id });
        }
        await this.refreshBuilds();
      };
      ws.onerror = () => {
        this.logLines.update((l) => [...l, '[log stream error]']);
        this.active.set(false);
      };
    } catch (e: any) {
      this.logLines.update((l) => [...l, 'ERROR: ' + (e?.error?.error ?? String(e))]);
      this.active.set(false);
      this.runStatus.set('failed');
    }
  }

  /** Dismiss the console. No-op while a build/validate is still streaming. */
  clearLog(ev: Event) {
    ev.stopPropagation();
    if (this.active()) return;
    this.logLines.set([]);
    this.runStatus.set(null);
    this.kind.set(null);
  }

  async refreshBuilds() {
    this.builds.set(await this.api.listBuilds());
  }

  async showHistory() {
    await this.refreshBuilds();
    this.view.set('history');
  }

  artifactUrl(id: number) {
    return this.api.artifactUrl(id);
  }

  fmtSize(bytes: number) {
    return bytes > 0 ? (bytes / 1_048_576).toFixed(1) + ' MB' : '—';
  }

  fmtTime(secs: number) {
    return secs ? new Date(secs * 1000).toLocaleString() : '';
  }
}
