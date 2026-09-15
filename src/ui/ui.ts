import { formatClock, formatPreciseClock, type Difficulty, type Role } from '../game/config';
import type { BoardRow } from '../net/leaderboard';
import type { HudState } from '../game/game';

type Screen = 'menu' | 'game' | 'result' | 'pause';

export type { Screen };

function el<T extends HTMLElement>(id: string): T {
  const node = document.getElementById(id);
  if (!node) throw new Error(`Missing element #${id}`);
  return node as T;
}

/** All DOM plumbing: menus, HUD, leaderboard tables and transient alerts. */
export class Ui {
  readonly menu = el('menu');
  readonly hud = el('hud');
  readonly result = el('result');
  readonly pause = el('pause');
  readonly joystick = el('joystick');
  readonly joystickKnob = el('joystick-knob');

  private readonly nameInput = el<HTMLInputElement>('input-name');
  private readonly roleChoices = el('choice-role');
  private readonly difficultyChoices = el('choice-difficulty');
  private readonly onlineRoleChoices = el('choice-online-role');
  private readonly codeInput = el<HTMLInputElement>('input-code');
  private readonly roomCode = el('room-code');
  private readonly codeBox = el('code-box');
  private readonly onlineStatus = el('online-status');
  private readonly cancelOnline = el('btn-cancel-online');
  private readonly boardList = el('board-list');
  private readonly resultBoard = el('result-board');
  private readonly syncStatus = el('sync-status');
  private readonly submitStatus = el('submit-status');
  private readonly alerts = el('hud-alerts');
  private readonly toast = el('toast');
  private readonly confetti = el<HTMLCanvasElement>('confetti');
  private confettiFrame = 0;
  private readonly timer = el('hud-timer');
  private readonly objective = el('hud-objective');
  private readonly roleChip = el('hud-role');
  private readonly roleText = el('hud-role-text');
  private readonly meterFill = el('hud-meter-fill');
  private readonly meterLabel = el('hud-meter-label');

  private toastTimer = 0;
  private boardRole: Role = 'seeker';

  role: Role = 'hider';
  difficulty: Difficulty = 'normal';
  onlineRole: Role = 'hider';

  onPlay: (() => void) | null = null;
  onPlayAgain: (() => void) | null = null;
  onMenu: (() => void) | null = null;
  onResume: (() => void) | null = null;
  onQuit: (() => void) | null = null;
  onPause: (() => void) | null = null;
  onSync: (() => void) | null = null;
  onBoardChange: ((role: Role) => void) | null = null;
  onNameChange: ((name: string) => void) | null = null;
  onHostGame: (() => void) | null = null;
  onJoinGame: ((code: string) => void) | null = null;
  onCancelOnline: (() => void) | null = null;

  constructor(version: string) {
    el('app-version').textContent = `SeekMe v${version} · plays offline`;

    el('btn-play').addEventListener('click', () => this.onPlay?.());
    el('btn-again').addEventListener('click', () => this.onPlayAgain?.());
    el('btn-menu').addEventListener('click', () => this.onMenu?.());
    el('btn-resume').addEventListener('click', () => this.onResume?.());
    el('btn-quit').addEventListener('click', () => this.onQuit?.());
    el('btn-pause').addEventListener('click', () => this.onPause?.());
    el('btn-sync').addEventListener('click', () => this.onSync?.());
    el('btn-retry-sync').addEventListener('click', () => this.onSync?.());

    this.nameInput.addEventListener('change', () => this.onNameChange?.(this.nameInput.value.trim()));
    this.nameInput.addEventListener('blur', () => this.onNameChange?.(this.nameInput.value.trim()));

    for (const tab of Array.from(document.querySelectorAll<HTMLElement>('.tab'))) {
      tab.addEventListener('click', () => this.selectTab(tab.dataset.tab ?? 'play'));
    }

    this.wireChoices(this.roleChoices, (value) => {
      this.role = value as Role;
    });
    this.wireChoices(this.difficultyChoices, (value) => {
      this.difficulty = value as Difficulty;
    });
    this.wireChoices(this.onlineRoleChoices, (value) => {
      this.onlineRole = value as Role;
    });

    el('btn-host').addEventListener('click', () => this.onHostGame?.());
    el('btn-join').addEventListener('click', () => this.onJoinGame?.(this.codeInput.value));
    el('btn-cancel-online').addEventListener('click', () => this.onCancelOnline?.());
    this.codeInput.addEventListener('keydown', (event) => {
      if (event.key === 'Enter') this.onJoinGame?.(this.codeInput.value);
    });
    el('btn-copy-code').addEventListener('click', () => {
      const code = this.roomCode.textContent ?? '';
      void navigator.clipboard?.writeText(code).then(
        () => this.toastMessage(`Code ${code} copied`),
        () => this.toastMessage(`Your code is ${code}`)
      );
    });

    for (const pill of Array.from(document.querySelectorAll<HTMLElement>('.pill'))) {
      pill.addEventListener('click', () => {
        for (const other of Array.from(document.querySelectorAll('.pill'))) {
          other.classList.toggle('selected', other === pill);
        }
        this.boardRole = (pill.dataset.board as Role) ?? 'seeker';
        this.onBoardChange?.(this.boardRole);
      });
    }

    this.enablePanelTilt();
  }

  /** Subtle parallax: the panels lean toward the pointer like a physical card. */
  private enablePanelTilt(): void {
    if (window.matchMedia('(pointer: coarse)').matches) return;

    const panels = Array.from(document.querySelectorAll<HTMLElement>('.screen .panel'));
    window.addEventListener('pointermove', (event) => {
      const nx = (event.clientX / window.innerWidth - 0.5) * 2;
      const ny = (event.clientY / window.innerHeight - 0.5) * 2;
      for (const panel of panels) {
        panel.style.setProperty('--tilt-x', (-ny * 3.2).toFixed(2));
        panel.style.setProperty('--tilt-y', (nx * 4.2).toFixed(2));
      }
    });
  }

  private wireChoices(container: HTMLElement, apply: (value: string) => void): void {
    for (const button of Array.from(container.querySelectorAll<HTMLElement>('.choice'))) {
      button.addEventListener('click', () => {
        for (const other of Array.from(container.querySelectorAll('.choice'))) {
          other.classList.toggle('selected', other === button);
        }
        apply(button.dataset.value ?? '');
      });
    }
  }

  selectTab(name: string): void {
    for (const tab of Array.from(document.querySelectorAll<HTMLElement>('.tab'))) {
      tab.classList.toggle('active', tab.dataset.tab === name);
    }
    for (const panel of Array.from(document.querySelectorAll<HTMLElement>('.tab-panel'))) {
      panel.classList.toggle('active', panel.dataset.panel === name);
    }
    if (name === 'board') this.onBoardChange?.(this.boardRole);
  }

  setName(name: string): void {
    this.nameInput.value = name;
  }

  // ------------------------------------------------------------------ online
  showRoomCode(code: string | null): void {
    this.codeBox.classList.toggle('hidden', code === null);
    if (code) this.roomCode.textContent = code;
  }

  setOnlineStatus(text: string, tone: 'ok' | 'warn' | 'err' | '' = '', busy = false): void {
    this.onlineStatus.className = `sync-status ${tone}`;
    this.onlineStatus.textContent = text;
    this.cancelOnline.classList.toggle('hidden', !busy);
  }

  clearJoinCode(): void {
    this.codeInput.value = '';
  }

  get currentBoardRole(): Role {
    return this.boardRole;
  }

  show(screen: Screen): void {
    this.menu.classList.toggle('hidden', screen !== 'menu');
    this.result.classList.toggle('hidden', screen !== 'result');
    this.pause.classList.toggle('hidden', screen !== 'pause');
    const inGame = screen === 'game' || screen === 'pause';
    this.hud.classList.toggle('hidden', !inGame);
    this.hud.setAttribute('aria-hidden', inGame ? 'false' : 'true');
    this.onScreenChange?.(screen);
  }

  onScreenChange: ((screen: Screen) => void) | null = null;

  // ------------------------------------------------------------------- HUD
  prepareHud(role: Role): void {
    this.roleChip.classList.toggle('seeker', role === 'seeker');
    this.hud.classList.toggle('seeker', role === 'seeker');
    this.roleText.textContent = role === 'seeker' ? 'Seeker' : 'Hider';
    this.objective.textContent =
      role === 'seeker'
        ? 'Follow the frost. Catch the little ghost before the clock runs out.'
        : 'Stay unseen until the clock runs out. Watch for glowing stones.';
    this.alerts.innerHTML = '';
    this.meterFill.style.width = '0%';
  }

  updateHud(state: HudState): void {
    if (state.phase === 'countdown') {
      this.timer.textContent = state.countdown > 0 ? `${state.countdown}` : 'GO';
      this.timer.classList.add('urgent');
    } else {
      this.timer.textContent = formatClock(state.remainingSeconds);
      this.timer.classList.toggle('urgent', state.remainingSeconds <= 15);
    }
    this.meterFill.style.width = `${Math.round(state.meter * 100)}%`;
    this.meterLabel.textContent = state.meterLabel;
  }

  alert(text: string, kind: string): void {
    const node = document.createElement('div');
    node.className = `alert ${kind}`;
    node.textContent = text;
    this.alerts.append(node);
    while (this.alerts.children.length > 3) this.alerts.firstElementChild?.remove();
    window.setTimeout(() => node.remove(), 4200);
  }

  toastMessage(text: string): void {
    this.toast.textContent = text;
    this.toast.classList.remove('hidden');
    window.clearTimeout(this.toastTimer);
    this.toastTimer = window.setTimeout(() => this.toast.classList.add('hidden'), 2600);
  }

  // ---------------------------------------------------------------- result
  showResult(options: {
    win: boolean;
    role: Role;
    timeMs: number;
    pondsMelted: number;
    peerLeft?: boolean;
  }): void {
    const title = el('result-title');
    const sub = el('result-sub');
    const label = el('result-score-label');
    const value = el('result-score-value');

    title.classList.toggle('win', options.win);
    title.classList.toggle('lose', !options.win);

    if (options.role === 'hider') {
      title.textContent = options.win ? 'You vanished!' : 'Caught!';
      sub.textContent = options.win
        ? 'The lantern burned out before it ever found you.'
        : `The lantern found you after ${formatPreciseClock(options.timeMs)}.`;
      label.textContent = 'Time survived';
    } else {
      title.textContent = options.win ? 'Found you!' : 'They slipped away';
      sub.textContent = options.win
        ? 'A clean catch — the frost led you straight to them.'
        : 'The clock ran out and the cold ghost is still out there.';
      label.textContent = options.win ? 'Catch time' : 'Time spent';
    }

    if (options.peerLeft) {
      title.textContent = 'They vanished!';
      sub.textContent = 'Your friend left the maze, so the round is yours.';
    }

    value.textContent = formatPreciseClock(options.timeMs);

    const extra = el('result-extra');
    const notes: string[] = [];
    if (options.pondsMelted > 0) {
      notes.push(
        options.pondsMelted === 1
          ? 'You melted 1 pond — it is there for good now.'
          : `You melted ${options.pondsMelted} ponds — they are there for good now.`
      );
    }
    extra.textContent = notes.join(' ');
    extra.classList.toggle('hidden', notes.length === 0);

    this.show('result');
    if (options.win) this.runConfetti();
  }

  /** A short burst of paper confetti across the result screen. */
  private runConfetti(): void {
    const canvas = this.confetti;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    // Size from the element's own box - the window size is not the same thing.
    const rect = canvas.getBoundingClientRect();
    const width = Math.max(1, rect.width);
    const height = Math.max(1, rect.height);
    const dpr = Math.min(window.devicePixelRatio, 2);
    canvas.width = Math.round(width * dpr);
    canvas.height = Math.round(height * dpr);
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);

    const colours = ['#ffb257', '#ff5a2b', '#6fd8ff', '#fff4dd', '#7fe0a0'];
    const pieces = Array.from({ length: 150 }, () => ({
      x: width * (0.08 + Math.random() * 0.84),
      y: height * (Math.random() * 0.45) - 30,
      vx: (Math.random() - 0.5) * 180,
      vy: 60 + Math.random() * 220,
      size: 5 + Math.random() * 8,
      spin: (Math.random() - 0.5) * 12,
      angle: Math.random() * Math.PI,
      colour: colours[Math.floor(Math.random() * colours.length)],
    }));

    window.cancelAnimationFrame(this.confettiFrame);
    let last = performance.now();
    let life = 0;

    const tick = (now: number): void => {
      const dt = Math.min(0.05, (now - last) / 1000);
      last = now;
      life += dt;
      ctx.clearRect(0, 0, width, height);

      for (const piece of pieces) {
        piece.vy += 240 * dt;
        piece.x += piece.vx * dt;
        piece.y += piece.vy * dt;
        piece.angle += piece.spin * dt;
        ctx.save();
        ctx.translate(piece.x, piece.y);
        ctx.rotate(piece.angle);
        ctx.globalAlpha = Math.max(0, 1 - life / 4.5);
        ctx.fillStyle = piece.colour;
        ctx.fillRect(-piece.size / 2, -piece.size / 4, piece.size, piece.size / 2);
        ctx.restore();
      }

      if (life < 4.5) this.confettiFrame = window.requestAnimationFrame(tick);
      else ctx.clearRect(0, 0, width, height);
    };

    this.confettiFrame = window.requestAnimationFrame(tick);
  }

  setSubmitStatus(text: string, tone: 'ok' | 'warn' | 'err' | '' = ''): void {
    this.submitStatus.className = `sync-status ${tone}`;
    this.submitStatus.textContent = text;
  }

  get submitStatusText(): string {
    return this.submitStatus.textContent ?? '';
  }

  setSyncStatus(text: string, tone: 'ok' | 'warn' | 'err' | '' = ''): void {
    this.syncStatus.className = `sync-status ${tone}`;
    this.syncStatus.textContent = text;
  }

  renderBoard(target: 'menu' | 'result', rows: BoardRow[], role: Role, highlightIds: Set<string>): void {
    const list = target === 'menu' ? this.boardList : this.resultBoard;
    list.innerHTML = '';

    if (rows.length === 0) {
      const empty = document.createElement('li');
      empty.className = 'board-empty';
      empty.textContent = 'No runs recorded yet. Be the first!';
      list.append(empty);
      return;
    }

    rows.forEach((row, index) => {
      const item = document.createElement('li');
      if (highlightIds.has(row.id)) item.classList.add('me');

      const rank = document.createElement('span');
      rank.className = 'rank';
      rank.textContent = `${index + 1}`;

      const who = document.createElement('span');
      who.className = 'who';
      who.textContent = row.name || 'Anonymous ghost';

      const tag = document.createElement('span');
      tag.className = 'tag';
      tag.textContent = row.difficulty;

      const score = document.createElement('span');
      score.className = 'score';
      score.textContent = formatPreciseClock(row.timeMs);

      item.append(rank, who, tag, score);
      list.append(item);
    });

    const caption = document.createElement('li');
    caption.className = 'board-empty';
    caption.textContent =
      role === 'seeker' ? 'Fastest catches win.' : 'Longest survival wins.';
    list.append(caption);
  }
}
