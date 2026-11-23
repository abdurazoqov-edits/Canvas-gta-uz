import './styles.css';
import { ControlState, HudTelemetry, PlayCanvasCarGame } from './playcanvas/engine';

const canvas = document.getElementById('game-canvas') as HTMLCanvasElement | null;
if (!canvas) {
  throw new Error('Missing #game-canvas');
}

const preloaderEl = document.getElementById('preloader')!;
const preloaderStatusEl = document.getElementById('preloader-status')!;
const preloaderFillEl = document.getElementById('preloader-fill')!;
const contextLostEl = document.getElementById('context-lost')!;
const reloadBtn = document.getElementById('btn-reload-gl')!;

const carNameEl = document.getElementById('hud-car-name')!;
const checkpointsEl = document.getElementById('hud-checkpoints')!;
const speedValEl = document.getElementById('speed-val')!;
const gearEl = document.getElementById('speed-gear')!;
const rpmFillEl = document.getElementById('rpm-fill')!;
const nitroFillEl = document.getElementById('nitro-fill')!;

const btnGarage = document.getElementById('btn-garage')!;
const btnCamera = document.getElementById('btn-camera')!;
const btnTime = document.getElementById('btn-time')!;
const btnSound = document.getElementById('btn-sound')!;
const btnReset = document.getElementById('btn-reset')!;

const garageBackdrop = document.getElementById('garage-backdrop')!;
const garageClose = document.getElementById('garage-close')!;
const garageList = document.getElementById('garage-list')!;
const btnImportGlb = document.getElementById('btn-import-glb')!;
const fileInputGlb = document.getElementById('file-input-glb') as HTMLInputElement;

let lastCarsSignature = '';

function renderGarageList(t: HudTelemetry, game: PlayCanvasCarGame): void {
  const sig = `${t.activeCarId}|${t.cars.map((c) => `${c.id}:${c.flip180}:${c.scaleMul}`).join(',')}`;
  if (sig === lastCarsSignature) return;
  lastCarsSignature = sig;

  garageList.innerHTML = '';
  for (const car of t.cars) {
    const isActive = car.id === t.activeCarId;
    const row = document.createElement('div');
    row.className = `car-row${isActive ? ' active' : ''}`;

    const sourceLabel =
      car.source === 'models' ? 'models/*.glb' : car.source === 'local' ? 'Local .glb' : 'Built-in 3D';

    row.innerHTML = `
      <div class="car-row-top">
        <div>
          <div class="car-row-name">${car.name}</div>
          <div class="car-row-meta">${sourceLabel} · ${Math.round(car.scaleMul * 100)}%${car.flip180 ? ' · 180°' : ''}</div>
        </div>
        <button type="button" class="car-mini-btn drive">${isActive ? 'Driving' : 'Drive'}</button>
      </div>
      <div class="car-row-actions">
        <button type="button" class="car-mini-btn" data-act="flip">Flip 180°</button>
        <button type="button" class="car-mini-btn" data-act="scale-down">Size −</button>
        <button type="button" class="car-mini-btn" data-act="scale-up">Size +</button>
      </div>
    `;

    row.querySelector('.drive')?.addEventListener('click', () => {
      game.selectCar(car.id);
      garageBackdrop.classList.add('hidden');
    });
    row.querySelector('[data-act="flip"]')?.addEventListener('click', () => {
      game.flipCar(car.id);
    });
    row.querySelector('[data-act="scale-down"]')?.addEventListener('click', () => {
      game.scaleCar(car.id, -0.1);
    });
    row.querySelector('[data-act="scale-up"]')?.addEventListener('click', () => {
      game.scaleCar(car.id, 0.1);
    });

    garageList.appendChild(row);
  }
}

function syncHud(t: HudTelemetry, game: PlayCanvasCarGame): void {
  carNameEl.textContent = t.activeCarName;
  checkpointsEl.textContent = `${t.checkpointsCollected} / ${t.checkpointsTotal}`;
  speedValEl.textContent = String(t.speedKmh);
  gearEl.textContent = t.gear;
  rpmFillEl.style.width = `${Math.round(t.rpmNorm * 100)}%`;
  nitroFillEl.style.width = `${t.nitroPct}%`;

  const camLabels = { chase: 'Chase', hood: 'Hood', orbit: 'Orbit' } as const;
  const timeLabels = { day: 'Day', sunset: 'Sunset', night: 'Night' } as const;
  btnCamera.textContent = camLabels[t.cameraMode];
  btnTime.textContent = timeLabels[t.timeOfDay];
  btnSound.textContent = t.muted ? 'Muted' : 'Sound';

  renderGarageList(t, game);
}

const game = new PlayCanvasCarGame(canvas, {
  onLoadProgress(label, pct) {
    preloaderStatusEl.textContent = label;
    preloaderFillEl.style.width = `${Math.max(10, Math.min(100, pct))}%`;
  },
  onReady(telemetry) {
    syncHud(telemetry, game);
    preloaderEl.classList.add('hidden');
  },
  onTelemetry(telemetry) {
    syncHud(telemetry, game);
  },
  onContextLost(lost) {
    contextLostEl.classList.toggle('hidden', !lost);
  },
});

reloadBtn.addEventListener('click', () => window.location.reload());

// Top action bar handlers
btnGarage.addEventListener('click', () => {
  game.audio.unlock();
  garageBackdrop.classList.toggle('hidden');
});
garageClose.addEventListener('click', () => garageBackdrop.classList.add('hidden'));
garageBackdrop.addEventListener('click', (e) => {
  if (e.target === garageBackdrop) garageBackdrop.classList.add('hidden');
});
btnCamera.addEventListener('click', () => game.cycleCamera());
btnTime.addEventListener('click', () => game.cycleTimeOfDay());
btnSound.addEventListener('click', () => game.toggleMute());
btnReset.addEventListener('click', () => game.resetActiveCar());

// Runtime local .glb car import
btnImportGlb.addEventListener('click', () => fileInputGlb.click());
fileInputGlb.addEventListener('change', async () => {
  const file = fileInputGlb.files?.[0];
  fileInputGlb.value = '';
  if (!file) return;
  btnImportGlb.textContent = `Loading ${file.name}…`;
  try {
    await game.importLocalGlb(file);
    garageBackdrop.classList.add('hidden');
  } catch (err) {
    console.warn('Local GLB import failed:', err);
  } finally {
    btnImportGlb.textContent = '+ Load local .glb car';
  }
});

// Multi-touch pointer bindings (supports simultaneous steer + gas + drift/nitro!)
function bindHoldControl(elId: string, control: keyof ControlState): void {
  const el = document.getElementById(elId);
  if (!el) return;
  const activePointers = new Set<number>();

  const updateState = () => {
    const on = activePointers.size > 0;
    el.classList.toggle('active', on);
    game.setControl(control, on);
  };

  el.addEventListener('pointerdown', (e) => {
    e.preventDefault();
    e.stopPropagation();
    try {
      el.setPointerCapture(e.pointerId);
    } catch {
      // Ignore
    }
    activePointers.add(e.pointerId);
    updateState();
  });

  const release = (e: PointerEvent) => {
    if (activePointers.delete(e.pointerId)) {
      updateState();
    }
  };

  el.addEventListener('pointerup', release);
  el.addEventListener('pointercancel', release);
  el.addEventListener('lostpointercapture', release);
}

bindHoldControl('touch-left', 'left');
bindHoldControl('touch-right', 'right');
bindHoldControl('touch-gas', 'gas');
bindHoldControl('touch-brake', 'brake');
bindHoldControl('touch-drift', 'drift');
bindHoldControl('touch-nitro', 'nitro');

document.getElementById('touch-horn')?.addEventListener('pointerdown', (e) => {
  e.preventDefault();
  e.stopPropagation();
  game.triggerHorn();
});

game.init().catch((err) => {
  console.error('[PlayCanvasCarGame] Init failed:', err);
  preloaderStatusEl.textContent = 'Failed to initialize 3D engine';
});
