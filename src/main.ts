import './styles.css';
import { Stage, shouldUseBloom } from './render/stage';
import { GameAudio } from './audio/audio';
import { InputController } from './game/input';
import { Game, type RoundResult } from './game/game';
import { LeaderboardClient } from './net/leaderboard';
import { OnlineSession } from './net/online';
import { Ui } from './ui/ui';
import { APP_VERSION, type Difficulty, type Role } from './game/config';
import { randomSeed } from './core/rng';
import { TitleLogo } from './render/logo';

const canvas = document.getElementById('scene') as HTMLCanvasElement;
const ui = new Ui(APP_VERSION);
const stage = new Stage(canvas, shouldUseBloom());
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
let onlineMatch = false;

// The spinning title only runs while the menu is on screen.
ui.onScreenChange = (screen) => {
  if (screen === 'menu') logo.start();
  else logo.stop();
};

// ---------------------------------------------------------------- lifecycle
function startRound(role: Role): void {
  game?.dispose();
  attract = false;
  paused = false;
  onlineMatch = false;
  lastPlayedRole = role;

  ui.prepareHud(role);
  ui.show('game');

  game = new Game(
    stage,
    audio,
    input,
    { role, difficulty: ui.difficulty, seed: randomSeed() },
    {
      onHud: (state) => ui.updateHud(state),
      onAlert: (text, kind) => ui.alert(text, kind),
      onEnd: (result) => void finishRound(result),
    }
  );
}

/** Starts a private match against another player. */
function startOnlineRound(role: Role, seed: number, difficulty: Difficulty, peer: string): void {
  game?.dispose();
  attract = false;
  paused = false;
  onlineMatch = true;
  lastPlayedRole = role;

  ui.prepareHud(role);
  ui.show('game');

  game = new Game(
    stage,
    audio,
    input,
    { role, difficulty, seed, online },
    {
      onHud: (state) => ui.updateHud(state),
      onAlert: (text, kind) => ui.alert(text, kind),
      onEnd: (result) => void finishRound(result),
    }
  );
  ui.alert(`Private match against ${peer}`, 'info');
}

function startAttractScene(): void {
  game?.dispose();
  window.clearTimeout(attractTimer);
  attract = true;
  paused = false;
  game = new Game(
    stage,
    audio,
    input,
    {
      role: Math.random() < 0.5 ? 'hider' : 'seeker',
      difficulty: 'normal',
      seed: randomSeed(),
      autoPlay: true,
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
    timeMs: result.timeMs,
    pondsMelted: result.pondsMelted,
    peerLeft: result.peerLeft,
  });

  const submission = leaderboard.queue({
    name: leaderboard.playerName || 'Anonymous ghost',
    role: result.role,
    difficulty: result.difficulty,
    win: result.win,
    timeMs: result.timeMs,
    seed: result.seed,
    pondsMelted: result.pondsMelted,
  });
  myScoreIds.add(submission.id);

  ui.setSubmitStatus('Score saved on this device. Syncing…');
  await syncScores('result');
  if (result.role === 'seeker' && !result.win) {
    ui.setSubmitStatus(`${ui.submitStatusText} Only catches rank on the seeker board.`, 'warn');
  }
  await refreshBoard(result.role, 'result');
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

async function refreshBoard(role: Role, target: 'menu' | 'result'): Promise<void> {
  const { rows, stale } = await leaderboard.fetchBoard(role);
  ui.renderBoard(target, rows, role, myScoreIds);
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
};

ui.onPlay = () => {
  void audio.resume();
  audio.blip(true);
  startRound(ui.role);
};

ui.onPlayAgain = () => {
  audio.blip(true);
  if (onlineMatch) {
    online.leave();
    ui.setOnlineStatus('Not connected.', '');
  }
  startRound(lastPlayedRole);
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
  void (async () => {
    await syncScores(target);
    await refreshBoard(target === 'menu' ? ui.currentBoardRole : lastPlayedRole, target);
  })();
};

ui.onBoardChange = (role) => {
  void refreshBoard(role, 'menu');
};

// ------------------------------------------------------------ online lobby
ui.onHostGame = () => {
  void audio.resume();
  ui.showRoomCode(null);
  ui.setOnlineStatus('Opening a room…', '', true);
  online
    .host(leaderboard.playerName || 'Ghost', ui.onlineRole, ui.difficulty)
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
  startOnlineRound(info.role, info.seed, info.difficulty, info.peer);
};

online.onPeerLeft = () => {
  if (onlineMatch && game && !game.isOver) game.handlePeerLeft();
  else ui.setOnlineStatus('Your friend disconnected.', 'warn');
};

input.onAction = (action) => {
  if (action === 'pause' && game && !attract) togglePause(!paused);
  if (action === 'mute') {
    muted = !muted;
    audio.setMuted(muted);
    ui.toastMessage(muted ? 'Sound off' : 'Sound on');
  }
};

let muted = false;

function togglePause(value: boolean): void {
  if (!game || attract || game.isOver) return;
  paused = value;
  game.setPaused(value);
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
}

startAttractScene();
requestAnimationFrame(frame);

// A tiny stepping harness for automated tests: open the game with `?debug=1`.
if (new URLSearchParams(location.search).has('debug')) {
  Object.defineProperty(window, '__seekme', {
    value: {
      start: (role: Role) => startRound(role),
      tick: (dt = 1 / 60, steps = 1) => {
        for (let i = 0; i < steps; i++) game?.update(dt);
      },
      hold: (x: number, y: number) => {
        input.axis.x = x;
        input.axis.y = y;
      },
      finish: (win: boolean) => game?.forceFinish(win),
      state: () => ({
        ...(game?.debugInfo ?? {}),
        attract,
        paused,
        pendingScores: leaderboard.pendingCount,
      }),
    },
  });
}

void (async () => {
  await syncScores('menu');
  await refreshBoard(ui.currentBoardRole, 'menu');
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
