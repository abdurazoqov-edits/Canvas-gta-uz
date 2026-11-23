import * as pc from 'playcanvas';
import { CarAudioEngine } from './audio';
import { PlayCanvasCar, PlayCanvasCarFleet, CarSummary } from './carFleet';
import { buildPlayCanvasOpenWorld, OpenWorldHandle, TimeOfDay } from './world';

export type CameraMode = 'chase' | 'hood' | 'orbit';

export interface ControlState {
  gas: boolean;
  brake: boolean;
  left: boolean;
  right: boolean;
  drift: boolean;
  nitro: boolean;
}

export interface HudTelemetry {
  speedKmh: number;
  gear: string;
  rpmNorm: number;
  nitroPct: number;
  checkpointsCollected: number;
  checkpointsTotal: number;
  activeCarId: string;
  activeCarName: string;
  cameraMode: CameraMode;
  timeOfDay: TimeOfDay;
  muted: boolean;
  fps: number;
  cars: CarSummary[];
}

export interface EngineCallbacks {
  onLoadProgress?: (label: string, pct: number) => void;
  onReady?: (telemetry: HudTelemetry) => void;
  onTelemetry?: (telemetry: HudTelemetry) => void;
  onContextLost?: (lost: boolean) => void;
}

function detectMobileDevice(): boolean {
  if (typeof window === 'undefined') return false;
  if ((window as unknown as { Capacitor?: unknown }).Capacitor) return true;
  const ua = typeof navigator !== 'undefined' ? navigator.userAgent || '' : '';
  return /Android|iPhone|iPad|iPod|Mobile|wv\)/i.test(ua);
}

export class PlayCanvasCarGame {
  public readonly canvas: HTMLCanvasElement;
  public readonly app: pc.Application;
  public readonly isMobile: boolean;
  public readonly audio: CarAudioEngine;
  public readonly world: OpenWorldHandle;
  public readonly fleet: PlayCanvasCarFleet;

  private readonly cameraEntity: pc.Entity;
  private readonly callbacks: EngineCallbacks;

  public controls: ControlState = {
    gas: false,
    brake: false,
    left: false,
    right: false,
    drift: false,
    nitro: false,
  };

  private cameraMode: CameraMode = 'chase';
  private timeOfDay: TimeOfDay = 'day';

  // Driving physics state
  private velX = 0;
  private velZ = 0;
  private velY = 0;
  private steerAngle = 0;
  private bodyRoll = 0;
  private bodyPitch = 0;
  private wheelSpinDeg = 0;
  private nitroFuel = 1.0;
  private grounded = true;
  private elapsedSec = 0;
  private checkpointsCollected = 0;

  // Smooth camera state
  private camPos = new pc.Vec3(0, 4.5, 14);
  private camTarget = new pc.Vec3(0, 1.2, 4);
  private orbitYawDeg = 22;
  private orbitPitchDeg = 18;
  private orbitDist = 8.4;
  private isDraggingCamera = false;
  private lastDragX = 0;
  private lastDragY = 0;

  // Lightweight FPS tracker
  private fpsAccum = 0;
  private fpsFrames = 0;
  private currentFps = 60;
  private lastTelemetryTime = 0;

  constructor(canvas: HTMLCanvasElement, callbacks: EngineCallbacks = {}) {
    this.canvas = canvas;
    this.callbacks = callbacks;
    this.isMobile = detectMobileDevice();
    this.audio = new CarAudioEngine();

    // Context loss safety handlers
    canvas.addEventListener(
      'webglcontextlost',
      (ev) => {
        ev.preventDefault();
        this.callbacks.onContextLost?.(true);
      },
      false
    );
    canvas.addEventListener(
      'webglcontextrestored',
      () => {
        this.callbacks.onContextLost?.(false);
        this.resize();
      },
      false
    );

    // Create lean PlayCanvas Application (zero heavy post-FX FBOs -> locked 60 FPS on Android!)
    this.app = new pc.Application(canvas, {
      graphicsDeviceOptions: {
        antialias: !this.isMobile,
        alpha: false,
        powerPreference: this.isMobile ? 'default' : 'high-performance',
        preserveDrawingBuffer: false,
      },
    });

    this.app.setCanvasFillMode(pc.FILLMODE_FILL_WINDOW);
    this.app.setCanvasResolution(pc.RESOLUTION_AUTO);
    this.app.graphicsDevice.maxPixelRatio = this.isMobile ? 1.35 : Math.min(window.devicePixelRatio || 1, 2);

    // Crisp exposure & ACES tone mapping (PlayCanvas v2 camera component property)
    this.app.scene.exposure = 1.12;

    // Camera Entity
    this.cameraEntity = new pc.Entity('MainCamera');
    this.cameraEntity.addComponent('camera', {
      clearColor: new pc.Color(0.56, 0.77, 0.96),
      fov: 54,
      nearClip: 0.25,
      farClip: 420,
      toneMapping: pc.TONEMAP_ACES,
    });
    this.cameraEntity.setLocalPosition(this.camPos);
    this.app.root.addChild(this.cameraEntity);

    // Open World + Car Fleet
    this.world = buildPlayCanvasOpenWorld(this.app, this.isMobile);
    this.fleet = new PlayCanvasCarFleet(this.app);

    this.bindCameraOrbitGestures();
    this.bindKeyboard();
    window.addEventListener('resize', this.handleResize);
    this.app.on('update', this.handleUpdate);

    this.app.start();
  }

  public async init(): Promise<void> {
    this.callbacks.onLoadProgress?.('Starting PlayCanvas 3D engine…', 15);
    await this.fleet.loadAllFromManifest((label, pct) => {
      this.callbacks.onLoadProgress?.(label, Math.max(15, pct));
    });
    const first = this.fleet.getActiveCar();
    if (first) {
      this.snapCameraToCar(first);
    }
    this.callbacks.onReady?.(this.getTelemetry());
  }

  private handleResize = (): void => {
    this.resize();
  };

  public resize(): void {
    this.app.resizeCanvas();
  }

  private bindCameraOrbitGestures(): void {
    const c = this.canvas;
    c.addEventListener('pointerdown', (e) => {
      this.audio.unlock();
      if (e.button !== 0 && e.pointerType === 'mouse') return;
      this.isDraggingCamera = true;
      this.lastDragX = e.clientX;
      this.lastDragY = e.clientY;
    });
    window.addEventListener('pointermove', (e) => {
      if (!this.isDraggingCamera) return;
      const dx = e.clientX - this.lastDragX;
      const dy = e.clientY - this.lastDragY;
      this.lastDragX = e.clientX;
      this.lastDragY = e.clientY;
      this.orbitYawDeg -= dx * 0.32;
      this.orbitPitchDeg = Math.max(6, Math.min(58, this.orbitPitchDeg + dy * 0.24));
    });
    window.addEventListener('pointerup', () => {
      this.isDraggingCamera = false;
    });
    c.addEventListener(
      'wheel',
      (e) => {
        if (this.cameraMode !== 'orbit') return;
        this.orbitDist = Math.max(5.0, Math.min(16.0, this.orbitDist + e.deltaY * 0.008));
      },
      { passive: true }
    );
  }

  private bindKeyboard(): void {
    const onKey = (e: KeyboardEvent, down: boolean) => {
      if (e.target instanceof HTMLInputElement || e.target instanceof HTMLTextAreaElement) return;
      if (down) this.audio.unlock();
      switch (e.code) {
        case 'KeyW':
        case 'ArrowUp':
          this.controls.gas = down;
          break;
        case 'KeyS':
        case 'ArrowDown':
          this.controls.brake = down;
          break;
        case 'KeyA':
        case 'ArrowLeft':
          this.controls.left = down;
          break;
        case 'KeyD':
        case 'ArrowRight':
          this.controls.right = down;
          break;
        case 'Space':
          this.controls.drift = down;
          break;
        case 'ShiftLeft':
        case 'ShiftRight':
          this.controls.nitro = down;
          break;
        case 'KeyC':
          if (down && !e.repeat) this.cycleCamera();
          break;
        case 'KeyH':
          if (down && !e.repeat) this.triggerHorn();
          break;
        case 'KeyR':
          if (down && !e.repeat) this.resetActiveCar();
          break;
      }
    };
    window.addEventListener('keydown', (e) => onKey(e, true));
    window.addEventListener('keyup', (e) => onKey(e, false));
  }

  public setControl(key: keyof ControlState, active: boolean): void {
    if (active) this.audio.unlock();
    this.controls[key] = active;
  }

  public triggerHorn(): void {
    this.audio.playHorn();
  }

  public toggleMute(): boolean {
    this.audio.unlock();
    this.audio.setMuted(!this.audio.muted);
    this.emitTelemetryNow();
    return this.audio.muted;
  }

  public cycleCamera(): CameraMode {
    const order: CameraMode[] = ['chase', 'hood', 'orbit'];
    const idx = (order.indexOf(this.cameraMode) + 1) % order.length;
    this.cameraMode = order[idx];
    const car = this.fleet.getActiveCar();
    if (car && this.cameraMode === 'orbit') {
      this.orbitYawDeg = car.yaw + 26;
      this.orbitPitchDeg = 18;
    }
    this.emitTelemetryNow();
    return this.cameraMode;
  }

  public cycleTimeOfDay(): TimeOfDay {
    const order: TimeOfDay[] = ['day', 'sunset', 'night'];
    const idx = (order.indexOf(this.timeOfDay) + 1) % order.length;
    this.timeOfDay = order[idx];
    this.world.setTimeOfDay(this.timeOfDay);
    if (this.cameraEntity.camera) {
      if (this.timeOfDay === 'sunset') {
        this.cameraEntity.camera.clearColor = new pc.Color(0.92, 0.56, 0.36);
      } else if (this.timeOfDay === 'night') {
        this.cameraEntity.camera.clearColor = new pc.Color(0.05, 0.08, 0.16);
      } else {
        this.cameraEntity.camera.clearColor = new pc.Color(0.56, 0.77, 0.96);
      }
    }
    this.emitTelemetryNow();
    return this.timeOfDay;
  }

  public selectCar(carId: string): void {
    const car = this.fleet.getCarById(carId);
    if (!car) return;
    this.fleet.activeCarId = car.id;
    this.velX = 0;
    this.velZ = 0;
    this.velY = 0;
    this.bodyRoll = 0;
    this.bodyPitch = 0;
    this.steerAngle = 0;
    this.snapCameraToCar(car);
    this.audio.playHorn();
    this.emitTelemetryNow();
  }

  public flipCar(carId: string): void {
    this.fleet.flipCar180(carId);
    this.emitTelemetryNow();
  }

  public scaleCar(carId: string, delta: number): void {
    this.fleet.scaleCar(carId, delta);
    this.emitTelemetryNow();
  }

  public async importLocalGlb(file: File): Promise<PlayCanvasCar> {
    const car = await this.fleet.importLocalGlbFile(file);
    this.selectCar(car.id);
    return car;
  }

  public resetActiveCar(): void {
    const car = this.fleet.getActiveCar();
    if (!car) return;
    car.x = car.spawnX;
    car.z = car.spawnZ;
    car.y = this.world.getTerrainHeight(car.x, car.z);
    car.yaw = car.spawnYaw;
    this.velX = 0;
    this.velZ = 0;
    this.velY = 0;
    this.bodyRoll = 0;
    this.bodyPitch = 0;
    this.nitroFuel = 1.0;
    car.root.setLocalPosition(car.x, car.y, car.z);
    car.root.setLocalEulerAngles(0, car.yaw, 0);
    car.tiltPivot.setLocalEulerAngles(0, 0, 0);
    this.snapCameraToCar(car);
    this.emitTelemetryNow();
  }

  private snapCameraToCar(car: PlayCanvasCar): void {
    const yawRad = (car.yaw * Math.PI) / 180;
    const fwdX = -Math.sin(yawRad);
    const fwdZ = -Math.cos(yawRad);
    this.camPos.set(car.x - fwdX * 8.2, car.y + 3.2, car.z - fwdZ * 8.2);
    this.camTarget.set(car.x + fwdX * 2.5, car.y + 1.15, car.z + fwdZ * 2.5);
    this.cameraEntity.setLocalPosition(this.camPos);
    this.cameraEntity.lookAt(this.camTarget);
  }

  private handleUpdate = (rawDt: number): void => {
    const dt = Math.min(Math.max(rawDt, 0.001), 0.05);
    this.elapsedSec += dt;

    // FPS meter
    this.fpsAccum += dt;
    this.fpsFrames += 1;
    if (this.fpsAccum >= 0.5) {
      this.currentFps = Math.round(this.fpsFrames / this.fpsAccum);
      this.fpsAccum = 0;
      this.fpsFrames = 0;
    }

    const car = this.fleet.getActiveCar();
    if (!car) return;

    this.stepCarPhysics(car, dt);
    this.updateCamera(car, dt);

    // Update checkpoints
    const carPos = new pc.Vec3(car.x, car.y, car.z);
    const newlyCollected = this.world.update(dt, this.elapsedSec, carPos);
    if (newlyCollected > 0) {
      this.checkpointsCollected += newlyCollected;
      this.nitroFuel = Math.min(1.0, this.nitroFuel + 0.35);
      this.audio.playCheckpoint();
      if (this.checkpointsCollected >= this.world.checkpoints.length) {
        // Loop exploration smoothly after celebrating all 12 rings
        setTimeout(() => {
          this.world.resetCheckpoints();
          this.checkpointsCollected = 0;
          this.emitTelemetryNow();
        }, 1800);
      }
      this.emitTelemetryNow();
    }

    if (this.elapsedSec - this.lastTelemetryTime >= 0.05) {
      this.emitTelemetryNow();
    }
  };

  private stepCarPhysics(car: PlayCanvasCar, dt: number): void {
    const yawRad = (car.yaw * Math.PI) / 180;
    const fwdX = -Math.sin(yawRad);
    const fwdZ = -Math.cos(yawRad);
    const rightX = Math.cos(yawRad);
    const rightZ = -Math.sin(yawRad);

    // Decompose current world velocity into car-local forward and lateral components
    let forwardSpeed = this.velX * fwdX + this.velZ * fwdZ;
    let lateralSpeed = this.velX * rightX + this.velZ * rightZ;

    const throttle = this.controls.gas ? 1 : 0;
    const brakeInput = this.controls.brake ? 1 : 0;
    const driftHeld = this.controls.drift;
    const nitroActive = this.controls.nitro && this.nitroFuel > 0.02 && throttle > 0;

    if (nitroActive) {
      this.nitroFuel = Math.max(0, this.nitroFuel - dt * 0.28);
    } else {
      this.nitroFuel = Math.min(1, this.nitroFuel + dt * 0.11);
    }

    const maxSpeed = nitroActive ? 48.0 : 35.0; // ~172 km/h nitro, ~126 km/h top normal
    const maxReverse = -14.0;
    const accelRate = nitroActive ? 28.0 : 18.5;
    const prevForwardSpeed = forwardSpeed;

    if (this.grounded) {
      if (throttle > 0) {
        const speedRatio = Math.max(0, forwardSpeed / maxSpeed);
        forwardSpeed += accelRate * (1 - speedRatio * 0.62) * dt;
      }
      if (brakeInput > 0) {
        if (forwardSpeed > 1.2) {
          forwardSpeed = Math.max(0, forwardSpeed - 30.0 * dt);
        } else {
          forwardSpeed = Math.max(maxReverse, forwardSpeed - 12.0 * dt);
        }
      }
      if (driftHeld && Math.abs(forwardSpeed) > 3.0) {
        forwardSpeed *= Math.exp(-0.55 * dt);
      }
      // Natural rolling resistance & aero drag
      if (throttle === 0 && brakeInput === 0) {
        forwardSpeed *= Math.exp(-1.15 * dt);
        if (Math.abs(forwardSpeed) < 0.08) forwardSpeed = 0;
      }
      forwardSpeed = Math.max(maxReverse, Math.min(maxSpeed, forwardSpeed));

      // Responsive steering
      const steerInput = (this.controls.left ? 1 : 0) - (this.controls.right ? 1 : 0);
      const steerTarget = steerInput * (driftHeld ? 1.18 : 1.0);
      this.steerAngle += (steerTarget - this.steerAngle) * Math.min(1, dt * 11);

      const speedFactor = Math.min(1, Math.abs(forwardSpeed) / 5.0);
      const highSpeedDamp = 1 / (1 + Math.abs(forwardSpeed) * 0.022);
      const reverseSign = forwardSpeed >= -0.1 ? 1 : -1;
      const turnRateDeg = (driftHeld ? 132 : 104) * highSpeedDamp;
      car.yaw += this.steerAngle * turnRateDeg * speedFactor * reverseSign * dt;

      // Lateral tire grip (lower grip during drift -> fun controllable power slides!)
      const grip = driftHeld ? 2.4 : 9.2;
      lateralSpeed *= Math.exp(-grip * dt);
    }

    // Reconstruct world velocity
    const newYawRad = (car.yaw * Math.PI) / 180;
    const nFwdX = -Math.sin(newYawRad);
    const nFwdZ = -Math.cos(newYawRad);
    const nRightX = Math.cos(newYawRad);
    const nRightZ = -Math.sin(newYawRad);

    this.velX = nFwdX * forwardSpeed + nRightX * lateralSpeed;
    this.velZ = nFwdZ * forwardSpeed + nRightZ * lateralSpeed;

    // Integrate horizontal position
    let nextX = car.x + this.velX * dt;
    let nextZ = car.z + this.velZ * dt;

    // World boundary soft containment
    const maxR = this.world.worldRadius;
    nextX = Math.max(-maxR, Math.min(maxR, nextX));
    nextZ = Math.max(-maxR, Math.min(maxR, nextZ));

    // Building AABB collision resolution
    const radius = 1.45;
    for (let i = 0; i < this.world.colliders.length; i++) {
      const b = this.world.colliders[i];
      if (
        nextX + radius > b.minX &&
        nextX - radius < b.maxX &&
        nextZ + radius > b.minZ &&
        nextZ - radius < b.maxZ
      ) {
        const penLeft = Math.abs(nextX + radius - b.minX);
        const penRight = Math.abs(b.maxX - (nextX - radius));
        const penTop = Math.abs(nextZ + radius - b.minZ);
        const penBot = Math.abs(b.maxZ - (nextZ - radius));
        const minPen = Math.min(penLeft, penRight, penTop, penBot);
        if (minPen === penLeft) {
          nextX = b.minX - radius;
          this.velX *= -0.25;
        } else if (minPen === penRight) {
          nextX = b.maxX + radius;
          this.velX *= -0.25;
        } else if (minPen === penTop) {
          nextZ = b.minZ - radius;
          this.velZ *= -0.25;
        } else {
          nextZ = b.maxZ + radius;
          this.velZ *= -0.25;
        }
      }
    }

    // Vertical terrain + stunt ramp jump physics
    const prevGround = this.world.getTerrainHeight(car.x, car.z);
    const nextGround = this.world.getTerrainHeight(nextX, nextZ);

    if (this.grounded) {
      const slopeRise = (nextGround - prevGround) / Math.max(dt, 0.005);
      if (nextGround < prevGround - 0.18 && Math.hypot(this.velX, this.velZ) > 9) {
        // Launch cleanly off top of stunt ramp!
        this.grounded = false;
        this.velY = Math.max(4.5, Math.min(11.5, Math.hypot(this.velX, this.velZ) * 0.28));
      } else {
        car.y = nextGround;
        this.velY = Math.max(0, slopeRise);
      }
    } else {
      this.velY -= 24.0 * dt;
      car.y += this.velY * dt;
      if (car.y <= nextGround) {
        car.y = nextGround;
        this.velY = 0;
        this.grounded = true;
      }
    }

    car.x = nextX;
    car.z = nextZ;

    // Slope pitch from ground ahead vs behind
    const frontGround = this.world.getTerrainHeight(car.x + nFwdX * 1.4, car.z + nFwdZ * 1.4);
    const rearGround = this.world.getTerrainHeight(car.x - nFwdX * 1.4, car.z - nFwdZ * 1.4);
    const slopePitchDeg = this.grounded
      ? (Math.atan2(frontGround - rearGround, 2.8) * 180) / Math.PI
      : Math.max(-18, Math.min(22, this.velY * 1.8));

    // Suspension roll & acceleration squat / brake dive
    const accel = (forwardSpeed - prevForwardSpeed) / dt;
    const targetRoll = Math.max(-6.5, Math.min(6.5, -this.steerAngle * (forwardSpeed * 0.22)));
    const targetPitch = Math.max(-3.8, Math.min(3.8, accel * 0.14));
    this.bodyRoll += (targetRoll - this.bodyRoll) * Math.min(1, dt * 10);
    this.bodyPitch += (targetPitch - this.bodyPitch) * Math.min(1, dt * 10);

    car.root.setLocalPosition(car.x, car.y, car.z);
    car.root.setLocalEulerAngles(0, car.yaw, 0);
    car.tiltPivot.setLocalEulerAngles(slopePitchDeg + this.bodyPitch, 0, this.bodyRoll);

    // Spin & steer detected wheel nodes
    this.wheelSpinDeg += ((forwardSpeed * dt) / 0.36) * (180 / Math.PI);
    const flipSign = car.flip180 ? -1 : 1;
    for (let i = 0; i < car.wheels.length; i++) {
      const w = car.wheels[i];
      const steerDeg = w.isFront ? this.steerAngle * 28 * flipSign : 0;
      w.entity.setLocalEulerAngles(
        w.baseEuler.x - this.wheelSpinDeg * flipSign,
        w.baseEuler.y + steerDeg,
        w.baseEuler.z
      );
    }

    // Update WebAudio car synthesizer
    const speedNorm = Math.min(1, Math.abs(forwardSpeed) / 36);
    const rpmNorm = 0.14 + ((speedNorm * 5.2) % 1) * 0.72 + speedNorm * 0.14;
    const driftSound =
      this.grounded && Math.abs(lateralSpeed) > 3.2
        ? Math.min(1, (Math.abs(lateralSpeed) - 3.2) / 8.0)
        : 0;
    this.audio.update(rpmNorm, throttle, driftSound, nitroActive);
  }

  private updateCamera(car: PlayCanvasCar, dt: number): void {
    const yawRad = (car.yaw * Math.PI) / 180;
    const fwdX = -Math.sin(yawRad);
    const fwdZ = -Math.cos(yawRad);
    const speed = Math.hypot(this.velX, this.velZ);

    // Dynamic FOV kick with speed + nitro
    const targetFov =
      this.cameraMode === 'hood'
        ? 62 + Math.min(14, speed * 0.35)
        : 52 + Math.min(14, speed * 0.34) + (this.controls.nitro && this.nitroFuel > 0.05 ? 4 : 0);
    if (this.cameraEntity.camera) {
      this.cameraEntity.camera.fov +=
        (targetFov - this.cameraEntity.camera.fov) * Math.min(1, dt * 6);
    }

    const desiredPos = new pc.Vec3();
    const desiredTarget = new pc.Vec3();

    if (this.cameraMode === 'hood') {
      desiredPos.set(car.x + fwdX * 0.45, car.y + 1.52, car.z + fwdZ * 0.45);
      desiredTarget.set(car.x + fwdX * 14, car.y + 1.25, car.z + fwdZ * 14);
      this.camPos.copy(desiredPos);
      this.camTarget.copy(desiredTarget);
    } else if (this.cameraMode === 'orbit') {
      const oYaw = (this.orbitYawDeg * Math.PI) / 180;
      const oPitch = (this.orbitPitchDeg * Math.PI) / 180;
      const horiz = Math.cos(oPitch) * this.orbitDist;
      desiredPos.set(
        car.x + Math.sin(oYaw) * horiz,
        car.y + 1.1 + Math.sin(oPitch) * this.orbitDist,
        car.z + Math.cos(oYaw) * horiz
      );
      desiredTarget.set(car.x, car.y + 1.05, car.z);
      const alpha = 1 - Math.exp(-12 * dt);
      this.camPos.lerp(this.camPos, desiredPos, alpha);
      this.camTarget.lerp(this.camTarget, desiredTarget, alpha);
    } else {
      // Smooth third-person Chase Camera (with slight speed pull-back)
      const backDist = 7.4 + Math.min(2.2, speed * 0.055);
      const height = 2.85 + Math.min(0.65, speed * 0.015);
      desiredPos.set(car.x - fwdX * backDist, car.y + height, car.z - fwdZ * backDist);
      desiredTarget.set(car.x + fwdX * 3.2, car.y + 1.1, car.z + fwdZ * 3.2);
      const posAlpha = 1 - Math.exp(-7.8 * dt);
      const tgtAlpha = 1 - Math.exp(-12.5 * dt);
      this.camPos.lerp(this.camPos, desiredPos, posAlpha);
      this.camTarget.lerp(this.camTarget, desiredTarget, tgtAlpha);
    }

    this.cameraEntity.setLocalPosition(this.camPos);
    this.cameraEntity.lookAt(this.camTarget);
  }

  public getTelemetry(): HudTelemetry {
    const car = this.fleet.getActiveCar();
    const speedMps = Math.hypot(this.velX, this.velZ);
    const speedKmh = Math.round(speedMps * 3.6);

    const yawRad = ((car?.yaw ?? 0) * Math.PI) / 180;
    const signedFwd = this.velX * -Math.sin(yawRad) + this.velZ * -Math.cos(yawRad);

    let gear = 'N';
    if (signedFwd < -0.5) gear = 'R';
    else if (speedKmh < 2) gear = 'P';
    else if (speedKmh < 26) gear = '1';
    else if (speedKmh < 52) gear = '2';
    else if (speedKmh < 82) gear = '3';
    else if (speedKmh < 112) gear = '4';
    else if (speedKmh < 142) gear = '5';
    else gear = '6';

    const rpmNorm =
      speedKmh < 2
        ? 0.12
        : Math.min(1, 0.22 + ((speedKmh % 28) / 28) * 0.72 + (speedKmh > 120 ? 0.14 : 0));

    return {
      speedKmh,
      gear,
      rpmNorm,
      nitroPct: Math.round(this.nitroFuel * 100),
      checkpointsCollected: this.checkpointsCollected,
      checkpointsTotal: this.world.checkpoints.length,
      activeCarId: car?.id ?? '',
      activeCarName: car?.name ?? 'Loading…',
      cameraMode: this.cameraMode,
      timeOfDay: this.timeOfDay,
      muted: this.audio.muted,
      fps: this.currentFps,
      cars: this.fleet.getSummaries(),
    };
  }

  private emitTelemetryNow(): void {
    this.lastTelemetryTime = this.elapsedSec;
    this.callbacks.onTelemetry?.(this.getTelemetry());
  }

  public dispose(): void {
    window.removeEventListener('resize', this.handleResize);
    this.app.off('update', this.handleUpdate);
    this.audio.dispose();
    this.app.destroy();
  }
}
