import './styles.css';
import { Stage, shouldUseBloom } from './render/stage';
import { GameAudio } from './audio/audio';
import { InputController } from './game/input';
import { Game, type RoundResult } from './game/game';
import { LeaderboardClient, type BoardKey } from './net/leaderboard';
import { OnlineSession } from './net/online';
import { Ui } from './ui/ui';
import { APP_VERSION, emotePad, type Difficulty, type EmoteKey, type GameMode, type Role } from './game/config';
import { loadBrightness, loadTheme, saveBrightness, saveTheme } from './game/settings';
import { randomSeed } from './core/rng';
import { TitleLogo } from './render/logo';
import { getTheme, type ThemeKey } from './render/themes';

const canvas = document.getElementById('scene') as HTMLCanvasElement;
const ui = new Ui(APP_VERSION);
// The theme is a device setting, so the very first frame already wears it.
let theme: ThemeKey = loadTheme();
const stage = new Stage(canvas, shouldUseBloom(), getTheme(theme));
const audio = new GameAudio();
const input = new InputController(canvas, ui.joystick, ui.joystickKnob);
const leaderboard = new LeaderboardClient();
const online = new OnlineSession();
const logo = new TitleLogo(document.getElementById('logo-canvas') as HTMLCanvasElement);
const myScoreIds = new Set<string>();

let game: Game | null = null;
let attract = true;
let paused = false;
let attractTimer = 0;
let lastPlayedRole: Role = 'hider';
/** The mode of the round being played, so "play again" repeats it. */
let lastPlayedMode: GameMode = 'classic';
let onlineMatch = false;
let isLeader = true;
let peerName = 'Your rival';

// The spinning title only runs while the menu is on screen.
ui.onScreenChange = (screen) => {
  if (screen === 'menu') logo.start();
  else logo.stop();
};

// ---------------------------------------------------------------- lifecycle
function startRound(role: Role, mode: GameMode = ui.mode): void {
  game?.dispose();
  attract = false;
  paused = false;
  onlineMatch = false;
  lastPlayedRole = role;
  lastPlayedMode = mode;

  ui.prepareHud(role, mode);
  ui.show('game');

  game = new Game(
    stage,
    audio,
    input,
    { role, difficulty: ui.difficulty, seed: randomSeed(), theme, mode },
    {
      onHud: (state) => ui.updateHud(state),
      onAlert: (text, kind) => ui.alert(text, kind),
      onEnd: (result) => void finishRound(result),
      onEmote: (glyph, who, colour, mine) => ui.emotePop(glyph, who, colour, mine),
    }
  );
  ui.trackMinimap(game);
}

/** Starts a private match against another player. */
function startOnlineRound(
  role: Role,
  seed: number,
  difficulty: Difficulty,
  mode: GameMode,
  peer: string,
  leader: boolean
): void {
  game?.dispose();
  attract = false;
  paused = false;
  onlineMatch = true;
  isLeader = leader;
  peerName = peer;
  lastPlayedRole = role;
  lastPlayedMode = mode;

  ui.prepareHud(role, mode);
  ui.show('game');

  game = new Game(
    stage,
    audio,
    input,
    {
      role,
      difficulty,
      seed,
      mode,
      online,
      isLeader: leader,
      peerName: peer,
      playerName: leaderboard.playerName,
      theme,
    },
    {
      onHud: (state) => ui.updateHud(state),
      onAlert: (text, kind) => ui.alert(text, kind),
      onEnd: (result) => void finishRound(result),
      onEmote: (glyph, who, colour, mine) => ui.emotePop(glyph, who, colour, mine),
      onRemotePause: (value) => {
        // The leader paused us: mirror it locally without asking again.
        paused = value;
        ui.setPauseInfo(!leader, peer);
        ui.show(value ? 'pause' : 'game');
      },
    }
  );
  ui.trackMinimap(game);
  ui.alert(
    mode === 'couple' ? `💗 Couple mode with ${peer}` : `Private match against ${peer}`,
    'info'
  );
}

function startAttractScene(): void {
  game?.dispose();
  window.clearTimeout(attractTimer);
  attract = true;
  paused = false;
  ui.trackMinimap(null);
  game = new Game(
    stage,
    audio,
    input,
    {
      role: Math.random() < 0.5 ? 'hider' : 'seeker',
      difficulty: 'normal',
      seed: randomSeed(),
      autoPlay: true,
      theme,
    },
    {
      onHud: () => {},
      onAlert: () => {},
      // The demo match loops forever behind the menu.
      onEnd: () => {
        attractTimer = window.setTimeout(() => {
          if (attract) startAttractScene();
        }, 2600);
      },
    }
  );
  ui.show('menu');
}

async function finishRound(result: RoundResult): Promise<void> {
  ui.showResult({
    win: result.win,
    role: result.role,
    mode: result.mode,
    timeMs: result.timeMs,
    pondsMelted: result.pondsMelted,
    peerLeft: result.peerLeft,
  });

  const submission = leaderboard.queue({
    name: leaderboard.playerName || 'Anonymous ghost',
    role: result.role,
    mode: result.mode,
    difficulty: result.difficulty,
    win: result.win,
    timeMs: result.timeMs,
    seed: result.seed,
    pondsMelted: result.pondsMelted,
  });
  myScoreIds.add(submission.id);

  const board: BoardKey = result.mode === 'couple' ? 'couple' : result.role;
  ui.setSubmitStatus('Score saved on this device. Syncing…');
  await syncScores('result');
  if (result.mode === 'couple' && !result.win) {
    ui.setSubmitStatus(`${ui.submitStatusText} Only reunions rank on the couple board.`, 'warn');
  } else if (result.mode !== 'couple' && result.role === 'seeker' && !result.win) {
    ui.setSubmitStatus(`${ui.submitStatusText} Only catches rank on the seeker board.`, 'warn');
  }
  await refreshBoard(board, 'result');
}

// -------------------------------------------------------------- leaderboard
async function syncScores(target: 'menu' | 'result'): Promise<void> {
  const setStatus = target === 'menu' ? ui.setSyncStatus.bind(ui) : ui.setSubmitStatus.bind(ui);
  const pending = leaderboard.pendingCount;
  setStatus(pending > 0 ? `Syncing ${pending} run${pending === 1 ? '' : 's'}…` : 'Checking server…');

  const report = await leaderboard.sync();

  if (report.ok && report.remaining === 0) {
    setStatus(
      report.accepted > 0
        ? `Synced ${report.accepted} run${report.accepted === 1 ? '' : 's'} to the leaderboard.`
        : 'Up to date with the leaderboard.',
      'ok'
    );
  } else {
    const remaining = report.remaining;
    setStatus(
      remaining > 0
        ? `Offline — ${remaining} run${remaining === 1 ? '' : 's'} waiting. Tap sync to retry.`
        : `Could not reach the server (${report.error ?? 'offline'}). Tap sync to retry.`,
      'warn'
    );
  }
}

async function refreshBoard(board: BoardKey, target: 'menu' | 'result'): Promise<void> {
  const { rows, stale } = await leaderboard.fetchBoard(board);
  ui.renderBoard(target, rows, board, myScoreIds);
  if (stale && target === 'menu') {
    const pending = leaderboard.pendingCount;
    ui.setSyncStatus(
      pending > 0
        ? `Offline — showing cached board, ${pending} run${pending === 1 ? '' : 's'} waiting.`
        : 'Offline — showing the last board this device saw.',
      'warn'
    );
  }
}

// ---------------------------------------------------------------- UI wiring
ui.setName(leaderboard.playerName);
ui.onNameChange = (name) => {
  leaderboard.playerName = name;
  // Reflect whatever we settled on (a cleared box rolls a new random name).
  ui.setName(leaderboard.playerName);
};

ui.onRerollName = () => {
  const name = leaderboard.rerollName();
  ui.setName(name);
  ui.toastMessage(`You are ${name}`);
};

// Brightness lives on the device: applied to the renderer, echoed by both sliders.
const savedBrightness = stage.setBrightness(loadBrightness());
ui.setBrightness(savedBrightness);
ui.onBrightnessChange = (value) => {
  saveBrightness(stage.setBrightness(value));
};

// So does the theme. The menu demo restarts on a change so the player sees the
// new maze immediately instead of having to start a round to find out.
ui.setTheme(theme);
ui.onThemeChange = (next) => {
  theme = next;
  saveTheme(next);
  stage.setTheme(getTheme(next));
  audio.blip(false);
  ui.toastMessage(`${getTheme(next).name} theme`);
  if (attract) startAttractScene();
};

ui.onModeChange = (mode) => {
  audio.blip(mode === 'couple');
  ui.toastMessage(mode === 'couple' ? '💗 Couple mode' : 'Classic chase');
};

ui.onPlay = () => {
  void audio.resume();
  audio.blip(true);
  startRound(ui.role, ui.mode);
};

ui.onPlayAgain = () => {
  audio.blip(true);
  if (onlineMatch) {
    online.leave();
    ui.setOnlineStatus('Not connected.', '');
  }
  startRound(lastPlayedRole, lastPlayedMode);
};

ui.onMenu = () => {
  if (onlineMatch) online.leave();
  startAttractScene();
  void syncScores('menu');
};

ui.onPause = () => togglePause(true);
ui.onResume = () => togglePause(false);
ui.onQuit = () => {
  if (onlineMatch) online.leave();
  startAttractScene();
  void syncScores('menu');
};

ui.onSync = () => {
  const target = ui.result.classList.contains('hidden') ? 'menu' : 'result';
  const resultBoard: BoardKey = lastPlayedMode === 'couple' ? 'couple' : lastPlayedRole;
  void (async () => {
    await syncScores(target);
    await refreshBoard(target === 'menu' ? ui.currentBoard : resultBoard, target);
  })();
};

ui.onBoardChange = (board) => {
  void refreshBoard(board, 'menu');
};

// ------------------------------------------------------------ online lobby
ui.onHostGame = () => {
  void audio.resume();
  ui.showRoomCode(null);
  ui.setOnlineStatus('Opening a room…', '', true);
  online
    .host(leaderboard.playerName || 'Ghost', ui.onlineRole, ui.difficulty, ui.mode)
    .catch((error: Error) => ui.setOnlineStatus(error.message, 'err'));
};

ui.onJoinGame = (code) => {
  const cleaned = code.trim().toUpperCase();
  if (cleaned.length < 3) {
    ui.setOnlineStatus('Type the 4-letter code your friend shared.', 'warn');
    return;
  }
  void audio.resume();
  ui.setOnlineStatus(`Looking for game ${cleaned}…`, '', true);
  online
    .join(leaderboard.playerName || 'Ghost', cleaned)
    .catch((error: Error) => ui.setOnlineStatus(error.message, 'err'));
};

ui.onCancelOnline = () => {
  online.leave();
  ui.showRoomCode(null);
  ui.setOnlineStatus('Not connected.', '');
};

online.onCode = (code) => {
  ui.showRoomCode(code);
  ui.setOnlineStatus(`Share code ${code} — waiting for your friend…`, 'warn', true);
};

online.onStatus = (status, detail) => {
  if (detail) ui.setOnlineStatus(detail, status === 'ready' ? 'ok' : 'warn', status === 'waiting');
};

online.onError = (message) => {
  ui.setOnlineStatus(message, 'err');
  ui.showRoomCode(null);
};

online.onMatch = (info) => {
  ui.showRoomCode(null);
  ui.setOnlineStatus(`Playing with ${info.peer}.`, 'ok');
  ui.clearJoinCode();
  // The host's room decides the mode, so a guest follows whatever it opened.
  ui.setMode(info.mode);
  startOnlineRound(info.role, info.seed, info.difficulty, info.mode, info.peer, info.isLeader);
};

online.onPeerLeft = () => {
  if (onlineMatch && game && !game.isOver) game.handlePeerLeft();
  else ui.setOnlineStatus('Your friend disconnected.', 'warn');
};

input.onAction = (action) => {
  if (action === 'pause' && game && !attract) togglePause(!paused);
  if (action === 'skill') useSkill();
  if (action === 'mute') {
    muted = !muted;
    audio.setMuted(muted);
    ui.toastMessage(muted ? 'Sound off' : 'Sound on');
  }
};

input.onEmoteKey = (index) => {
  // The pad changes with the mode, so the hotkeys follow the pad on screen.
  const emote = emotePad(game?.mode ?? ui.mode)[index];
  if (emote) playEmote(emote.key);
};

ui.onEmote = (key) => playEmote(key);
ui.onSkill = () => useSkill();

/** The skill button: a wall skip in the chase, a love ping in couple mode. */
function useSkill(): void {
  if (!game || attract || paused || game.isOver) return;
  void audio.resume();
  game.useSkill();
}

function playEmote(key: EmoteKey): void {
  if (!game || attract || game.isOver) return;
  void audio.resume();
  game.sendEmote(key);
}

let muted = false;

function togglePause(value: boolean): void {
  if (!game || attract || game.isOver) return;
  // Online, only the leader may pause: a guest can ask, never toggle.
  if (onlineMatch && !isLeader) {
    if (value) {
      game.setPaused(true);
      ui.toastMessage('Asked your friend to pause…');
    }
    return;
  }
  paused = value;
  game.setPaused(value);
  ui.setPauseInfo(false, peerName);
  ui.show(value ? 'pause' : 'game');
}

leaderboard.onChange = () => {
  if (leaderboard.pendingCount > 0) {
    ui.setSyncStatus(`${leaderboard.pendingCount} run(s) waiting to sync.`, 'warn');
  }
};

// ------------------------------------------------------------------- events
window.addEventListener('resize', () => stage.resize());
window.addEventListener('orientationchange', () => window.setTimeout(() => stage.resize(), 200));
document.addEventListener('visibilitychange', () => {
  if (document.hidden && game && !attract && !game.isOver) togglePause(true);
});

// --------------------------------------------------------------- main loop
let previous = performance.now();
function frame(now: number): void {
  requestAnimationFrame(frame);
  const dt = Math.min(0.1, (now - previous) / 1000);
  previous = now;
  game?.update(dt);
  ui.renderMinimap(dt);
}

startAttractScene();
requestAnimationFrame(frame);

// A tiny stepping harness for automated tests: open the game with `?debug=1`.
if (new URLSearchParams(location.search).has('debug')) {
  Object.defineProperty(window, '__seekme', {
    value: {
      start: (role: Role, mode: GameMode = 'classic') => startRound(role, mode),
      tick: (dt = 1 / 60, steps = 1) => {
        for (let i = 0; i < steps; i++) game?.update(dt);
      },
      hold: (x: number, y: number) => {
        input.axis.x = x;
        input.axis.y = y;
      },
      finish: (win: boolean) => game?.forceFinish(win),
      skip: () => game?.useSkill() ?? false,
      ping: () => game?.useLovePing() ?? false,
      state: () => ({
        ...(game?.debugInfo ?? {}),
        attract,
        paused,
        brightness: stage.brightnessValue,
        theme,
        mode: game?.mode ?? ui.mode,
        pendingScores: leaderboard.pendingCount,
      }),
    },
  });
}

void (async () => {
  await syncScores('menu');
  await refreshBoard(ui.currentBoard, 'menu');
})();

// ---------------------------------------------------------- offline support
if ('serviceWorker' in navigator && import.meta.env.PROD) {
  window.addEventListener('load', () => {
    navigator.serviceWorker
      .register('/sw.js')
      .then(() => ui.toastMessage('Ready to play offline'))
      .catch(() => {
        /* offline caching is a bonus, never a blocker */
      });
  });
}
