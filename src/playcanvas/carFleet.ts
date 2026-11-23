import * as pc from 'playcanvas';

export interface CarManifestItem {
  id: string;
  fileName: string;
  url: string;
  name: string;
  sizeBytes?: number;
  source?: string;
}

export interface WheelRef {
  entity: pc.Entity;
  isFront: boolean;
  baseEuler: pc.Vec3;
}

export interface PlayCanvasCar {
  id: string;
  name: string;
  source: 'models' | 'builtin' | 'local';
  root: pc.Entity;
  tiltPivot: pc.Entity;
  userAdjust: pc.Entity;
  wheels: WheelRef[];
  spawnX: number;
  spawnZ: number;
  spawnYaw: number;
  x: number;
  y: number;
  z: number;
  yaw: number;
  flip180: boolean;
  scaleMul: number;
  carWidth: number;
  carLength: number;
}

export interface CarSummary {
  id: string;
  name: string;
  source: 'models' | 'builtin' | 'local';
  flip180: boolean;
  scaleMul: number;
}

const TARGET_CAR_LENGTH = 4.45;
const PARKING_BAYS: Array<{ x: number; z: number; yaw: number }> = [
  { x: 0, z: 4, yaw: 0 },
  { x: -7.2, z: 6, yaw: 14 },
  { x: 7.2, z: 6, yaw: -14 },
  { x: -14.2, z: 8, yaw: 20 },
  { x: 14.2, z: 8, yaw: -20 },
  { x: -20.5, z: 10, yaw: 24 },
  { x: 20.5, z: 10, yaw: -24 },
];

const HELPER_MESH_RE = /colmesh|collision_?mesh|shadow_?plane|hitbox/i;
const WHEEL_NAME_RE = /wheel|tire|tyre|rim|hub|roue|rad|rueda|ko.?l|g.?ildirak|balon|shina/i;
const FRONT_NAME_RE = /front|fl|fr|_f_|_f$|перед|old/i;

function createShadowPlaneTexture(device: pc.GraphicsDevice): pc.Texture {
  const w = 128;
  const h = 256;
  const canvas = document.createElement('canvas');
  canvas.width = w;
  canvas.height = h;
  const ctx = canvas.getContext('2d');
  if (ctx) {
    const grad = ctx.createRadialGradient(w * 0.5, h * 0.5, 10, w * 0.5, h * 0.5, w * 0.5);
    grad.addColorStop(0, 'rgba(6, 10, 18, 0.72)');
    grad.addColorStop(0.65, 'rgba(6, 10, 18, 0.36)');
    grad.addColorStop(1, 'rgba(6, 10, 18, 0)');
    ctx.fillStyle = grad;
    ctx.fillRect(0, 0, w, h);
  }
  const tex = new pc.Texture(device, {
    width: w,
    height: h,
    format: pc.PIXELFORMAT_RGBA8,
    mipmaps: false,
    minFilter: pc.FILTER_LINEAR,
    magFilter: pc.FILTER_LINEAR,
    addressU: pc.ADDRESS_CLAMP_TO_EDGE,
    addressV: pc.ADDRESS_CLAMP_TO_EDGE,
  });
  tex.setSource(canvas);
  return tex;
}

/**
 * Builds a sleek PlayCanvas native GT Sports Coupe starter car (oriented forward = -Z, grounded at y = 0).
 */
function buildStarterGtEntity(): { model: pc.Entity; wheels: WheelRef[] } {
  const model = new pc.Entity('CampusGT_Model');
  const wheels: WheelRef[] = [];

  const mkMat = (
    r: number,
    g: number,
    b: number,
    metalness: number,
    gloss: number,
    emissive?: [number, number, number]
  ) => {
    const m = new pc.StandardMaterial();
    m.diffuse.set(r, g, b);
    m.useMetalness = true;
    m.metalness = metalness;
    m.gloss = gloss;
    if (emissive) {
      m.emissive.set(emissive[0], emissive[1], emissive[2]);
      m.emissiveIntensity = 1.8;
    }
    m.update();
    return m;
  };

  const paintMat = mkMat(0.11, 0.34, 0.88, 0.65, 0.82);
  const darkTrimMat = mkMat(0.1, 0.12, 0.16, 0.35, 0.5);
  const glassMat = mkMat(0.08, 0.14, 0.24, 0.2, 0.92);
  const tireMat = mkMat(0.1, 0.11, 0.13, 0.05, 0.22);
  const alloyMat = mkMat(0.84, 0.88, 0.92, 0.9, 0.84);
  const headMat = mkMat(1, 0.98, 0.92, 0.1, 0.8, [1, 0.95, 0.82]);
  const tailMat = mkMat(0.9, 0.12, 0.12, 0.1, 0.8, [1, 0.14, 0.12]);

  const addPart = (
    name: string,
    type: 'box' | 'cylinder',
    pos: [number, number, number],
    scale: [number, number, number],
    mat: pc.Material,
    rot?: [number, number, number]
  ) => {
    const e = new pc.Entity(name);
    e.setLocalPosition(pos[0], pos[1], pos[2]);
    e.setLocalScale(scale[0], scale[1], scale[2]);
    if (rot) e.setLocalEulerAngles(rot[0], rot[1], rot[2]);
    e.addComponent('render', { type, material: mat, castShadows: true, receiveShadows: true });
    model.addChild(e);
    return e;
  };

  // Lower chassis & sculpted hood
  addPart('ChassisMain', 'box', [0, 0.56, 0], [1.92, 0.54, 4.35], paintMat);
  addPart('FrontSplitter', 'box', [0, 0.26, -2.08], [1.96, 0.1, 0.42], darkTrimMat);
  addPart('RearDiffuser', 'box', [0, 0.28, 2.1], [1.86, 0.18, 0.3], darkTrimMat);
  // Cabin & greenhouse
  addPart('CabinGlass', 'box', [0, 1.04, 0.18], [1.52, 0.48, 2.05], glassMat);
  addPart('CabinRoof', 'box', [0, 1.29, 0.24], [1.46, 0.08, 1.55], paintMat);
  // GT Wing Spoiler
  addPart('SpoilerBlade', 'box', [0, 1.12, 2.02], [1.88, 0.06, 0.28], darkTrimMat);
  addPart('SpoilerStrutL', 'box', [-0.58, 0.95, 1.98], [0.06, 0.28, 0.18], darkTrimMat);
  addPart('SpoilerStrutR', 'box', [0.58, 0.95, 1.98], [0.06, 0.28, 0.18], darkTrimMat);
  // Headlights & full-width tail light bar
  addPart('HeadlightL', 'box', [-0.66, 0.64, -2.17], [0.42, 0.1, 0.08], headMat);
  addPart('HeadlightR', 'box', [0.66, 0.64, -2.17], [0.42, 0.1, 0.08], headMat);
  addPart('TailBar', 'box', [0, 0.72, 2.18], [1.72, 0.1, 0.08], tailMat);

  // 4 Rotating Alloy Wheels
  const wheelCoords: Array<{ name: string; x: number; z: number; isFront: boolean }> = [
    { name: 'Wheel_FL', x: -0.94, z: -1.34, isFront: true },
    { name: 'Wheel_FR', x: 0.94, z: -1.34, isFront: true },
    { name: 'Wheel_RL', x: -0.95, z: 1.34, isFront: false },
    { name: 'Wheel_RR', x: 0.95, z: 1.34, isFront: false },
  ];

  for (const wc of wheelCoords) {
    const wPivot = new pc.Entity(wc.name);
    wPivot.setLocalPosition(wc.x, 0.36, wc.z);
    model.addChild(wPivot);

    const tire = new pc.Entity(`${wc.name}_Tire`);
    tire.setLocalEulerAngles(0, 0, 90);
    tire.setLocalScale(0.72, 0.26, 0.72);
    tire.addComponent('render', { type: 'cylinder', material: tireMat, castShadows: true });
    wPivot.addChild(tire);

    const rim = new pc.Entity(`${wc.name}_Rim`);
    rim.setLocalEulerAngles(0, 0, 90);
    rim.setLocalScale(0.46, 0.28, 0.46);
    rim.addComponent('render', { type: 'cylinder', material: alloyMat });
    wPivot.addChild(rim);

    wheels.push({
      entity: wPivot,
      isFront: wc.isFront,
      baseEuler: new pc.Vec3(0, 0, 0),
    });
  }

  return { model, wheels };
}

export class PlayCanvasCarFleet {
  public readonly app: pc.Application;
  public readonly root: pc.Entity;
  public cars: PlayCanvasCar[] = [];
  public activeCarId: string | null = null;
  private shadowMat: pc.StandardMaterial;
  private localCounter = 0;

  constructor(app: pc.Application) {
    this.app = app;
    this.root = new pc.Entity('CarFleetRoot');
    this.app.root.addChild(this.root);

    // Initialize offline Draco WASM decoder bundled inside /public/draco/gltf/
    try {
      const base = typeof window !== 'undefined' ? window.location.href : '';
      const jsUrl = base ? new URL('./draco/gltf/draco_wasm_wrapper.js', base).href : './draco/gltf/draco_wasm_wrapper.js';
      const wasmUrl = base ? new URL('./draco/gltf/draco_decoder.wasm', base).href : './draco/gltf/draco_decoder.wasm';
      pc.dracoInitialize({
        jsUrl,
        wasmUrl,
        numWorkers: 2,
        lazyInit: false,
      });
    } catch (err) {
      console.warn('[PlayCanvasCarFleet] Draco init warning:', err);
    }

    const shadowTex = createShadowPlaneTexture(app.graphicsDevice);
    const sm = new pc.StandardMaterial();
    sm.diffuse.set(1, 1, 1);
    sm.diffuseMap = shadowTex;
    sm.opacityMap = shadowTex;
    sm.opacityMapChannel = 'a';
    sm.blendType = pc.BLEND_NORMAL;
    sm.depthWrite = false;
    sm.useLighting = false;
    sm.useFog = false;
    sm.update();
    this.shadowMat = sm;
  }

  private getBay(idx: number): { x: number; z: number; yaw: number } {
    if (idx < PARKING_BAYS.length) return PARKING_BAYS[idx];
    const extra = idx - PARKING_BAYS.length;
    return {
      x: -18 + (extra % 6) * 7.2,
      z: 18 + Math.floor(extra / 6) * 9,
      yaw: 0,
    };
  }

  private normalizeGlbEntity(rawEntity: pc.Entity): {
    wrapper: pc.Entity;
    wheels: WheelRef[];
    width: number;
    length: number;
  } {
    const wrapper = new pc.Entity('NormalizedGlbWrapper');
    const orientGroup = new pc.Entity('CarOrientGroup');
    orientGroup.addChild(rawEntity);
    wrapper.addChild(orientGroup);

    // Temporarily attach to app.root so PlayCanvas computes exact world matrices & AABBs
    this.app.root.addChild(wrapper);

    // 1. Hide exported collision / GTA ColMesh helper nodes before measuring AABB
    const renderComps = rawEntity.findComponents('render') as pc.RenderComponent[];
    for (const rc of renderComps) {
      if (HELPER_MESH_RE.test(rc.entity.name || '')) {
        rc.enabled = false;
        rc.entity.enabled = false;
        continue;
      }
      rc.castShadows = true;
      rc.receiveShadows = true;
    }

    // Force world transform sync
    const computeVisibleBounds = (node: pc.Entity): pc.BoundingBox | null => {
      node.getWorldTransform();
      const comps = node.findComponents('render') as pc.RenderComponent[];
      let combined: pc.BoundingBox | null = null;
      for (const rc of comps) {
        if (!rc.enabled || !rc.entity.enabled) continue;
        for (const mi of rc.meshInstances) {
          if (!mi.visible) continue;
          if (!combined) {
            combined = mi.aabb.clone();
          } else {
            combined.add(mi.aabb);
          }
        }
      }
      return combined;
    };

    const rawBounds = computeVisibleBounds(rawEntity);
    if (rawBounds) {
      const sizeX = Math.max(rawBounds.halfExtents.x * 2, 0.001);
      const sizeZ = Math.max(rawBounds.halfExtents.z * 2, 0.001);
      const maxHoriz = Math.max(sizeX, sizeZ);
      const scale = TARGET_CAR_LENGTH / maxHoriz;
      orientGroup.setLocalScale(scale, scale, scale);

      // If car's length runs along X instead of Z, rotate 90 deg around Y
      if (sizeX > sizeZ * 1.12) {
        orientGroup.setLocalEulerAngles(0, 90, 0);
      }

      const scaledBounds = computeVisibleBounds(orientGroup);
      if (scaledBounds) {
        const minY = scaledBounds.center.y - scaledBounds.halfExtents.y;
        orientGroup.setLocalPosition(-scaledBounds.center.x, -minY, -scaledBounds.center.z);
      }
    }

    const finalBounds = computeVisibleBounds(wrapper);
    const width = finalBounds ? Math.max(1.5, Math.min(2.6, finalBounds.halfExtents.x * 2)) : 1.95;
    const length = finalBounds ? Math.max(2.8, Math.min(6.0, finalBounds.halfExtents.z * 2)) : 4.45;

    // Detect compact individual wheel nodes (ignore merged body/bumper meshes)
    const wheels: WheelRef[] = [];
    for (const rc of renderComps) {
      if (!rc.enabled || !rc.entity.enabled) continue;
      const ent = rc.entity;
      if (!WHEEL_NAME_RE.test(ent.name || '')) continue;
      let maxDim = 0;
      for (const mi of rc.meshInstances) {
        const he = mi.aabb.halfExtents;
        maxDim = Math.max(maxDim, he.x * 2, he.y * 2, he.z * 2);
      }
      if (maxDim > 0.15 && maxDim < 1.25) {
        const wp = ent.getPosition();
        const isFront = FRONT_NAME_RE.test(ent.name || '') || wp.z < -0.25;
        wheels.push({
          entity: ent,
          isFront,
          baseEuler: ent.getLocalEulerAngles().clone(),
        });
      }
    }

    this.app.root.removeChild(wrapper);
    return { wrapper, wheels, width, length };
  }

  private registerCarEntity(opts: {
    id: string;
    name: string;
    source: 'models' | 'builtin' | 'local';
    modelWrapper: pc.Entity;
    wheels: WheelRef[];
    width: number;
    length: number;
  }): PlayCanvasCar {
    const bay = this.getBay(this.cars.length);

    const root = new pc.Entity(`DrivableCar_${opts.id}`);
    root.setLocalPosition(bay.x, 0.05, bay.z);
    root.setLocalEulerAngles(0, bay.yaw, 0);

    const tiltPivot = new pc.Entity('CarTiltPivot');
    const userAdjust = new pc.Entity('CarUserAdjust');
    userAdjust.addChild(opts.modelWrapper);
    tiltPivot.addChild(userAdjust);
    root.addChild(tiltPivot);

    // Grounded contact shadow plane under car
    const shadowPlane = new pc.Entity('CarContactShadow');
    shadowPlane.setLocalPosition(0, 0.03, 0);
    shadowPlane.setLocalScale(opts.width * 1.32, 1, opts.length * 1.18);
    shadowPlane.addComponent('render', {
      type: 'plane',
      material: this.shadowMat,
      castShadows: false,
      receiveShadows: false,
    });
    root.addChild(shadowPlane);

    this.root.addChild(root);

    const car: PlayCanvasCar = {
      id: opts.id,
      name: opts.name,
      source: opts.source,
      root,
      tiltPivot,
      userAdjust,
      wheels: opts.wheels,
      spawnX: bay.x,
      spawnZ: bay.z,
      spawnYaw: bay.yaw,
      x: bay.x,
      y: 0.05,
      z: bay.z,
      yaw: bay.yaw,
      flip180: false,
      scaleMul: 1.0,
      carWidth: opts.width,
      carLength: opts.length,
    };
    this.cars.push(car);
    return car;
  }

  private loadGlbUrl(url: string, name: string): Promise<pc.Entity> {
    return new Promise((resolve, reject) => {
      const asset = new pc.Asset(name, 'container', { url });
      asset.once('load', () => {
        const resource = asset.resource as pc.ContainerResource | null;
        if (!resource) {
          reject(new Error(`Empty GLB container for ${name}`));
          return;
        }
        const entity = resource.instantiateRenderEntity({
          castShadows: true,
          receiveShadows: true,
        });
        resolve(entity);
      });
      asset.once('error', (err) => {
        reject(new Error(String(err || `Failed to load ${url}`)));
      });
      this.app.assets.add(asset);
      this.app.assets.load(asset);
    });
  }

  public async loadAllFromManifest(onProgress?: (label: string, pct: number) => void): Promise<PlayCanvasCar[]> {
    let manifestCars: CarManifestItem[] = [];
    try {
      const res = await fetch('./models/manifest.json', { cache: 'no-cache' });
      if (res.ok) {
        const json = await res.json();
        if (json && Array.isArray(json.cars)) {
          manifestCars = json.cars;
        }
      }
    } catch {
      manifestCars = [];
    }

    const total = manifestCars.length + 1;
    for (let i = 0; i < manifestCars.length; i++) {
      const item = manifestCars[i];
      onProgress?.(`Loading ${item.name}…`, Math.round(((i + 0.35) / total) * 85));
      try {
        const raw = await this.loadGlbUrl(item.url, item.fileName);
        const norm = this.normalizeGlbEntity(raw);
        this.registerCarEntity({
          id: item.id,
          name: item.name,
          source: 'models',
          modelWrapper: norm.wrapper,
          wheels: norm.wheels,
          width: norm.width,
          length: norm.length,
        });
      } catch (err) {
        console.warn(`[PlayCanvasCarFleet] Could not load ${item.fileName}:`, err);
      }
      onProgress?.(`Loaded ${item.name}`, Math.round(((i + 1) / total) * 85));
    }

    // Always add the lightweight built-in Campus GT starter coupe
    const starter = buildStarterGtEntity();
    this.registerCarEntity({
      id: 'campus_gt_coupe',
      name: 'Campus GT',
      source: 'builtin',
      modelWrapper: starter.model,
      wheels: starter.wheels,
      width: 1.98,
      length: 4.45,
    });

    if (this.cars.length > 0 && !this.activeCarId) {
      this.activeCarId = this.cars[0].id;
    }

    onProgress?.('Ready', 100);
    return this.cars;
  }

  public async importLocalGlbFile(file: File): Promise<PlayCanvasCar> {
    const blobUrl = URL.createObjectURL(file);
    try {
      this.localCounter += 1;
      const cleanName = file.name
        .replace(/\.glb$/i, '')
        .replace(/(?:[_-](?:opt|optimized|draco|compressed|lowpoly))+$/i, '')
        .replace(/[_-]+/g, ' ')
        .trim();
      const displayName = cleanName
        ? cleanName
            .split(/\s+/)
            .map((w) => (w.length <= 3 ? w.toUpperCase() : w.charAt(0).toUpperCase() + w.slice(1)))
            .join(' ')
        : `Custom Car ${this.localCounter}`;

      const raw = await this.loadGlbUrl(blobUrl, file.name);
      const norm = this.normalizeGlbEntity(raw);
      return this.registerCarEntity({
        id: `local_${Date.now()}_${this.localCounter}`,
        name: displayName,
        source: 'local',
        modelWrapper: norm.wrapper,
        wheels: norm.wheels,
        width: norm.width,
        length: norm.length,
      });
    } finally {
      setTimeout(() => URL.revokeObjectURL(blobUrl), 5000);
    }
  }

  public getCarById(id: string | null): PlayCanvasCar | null {
    if (!id) return null;
    return this.cars.find((c) => c.id === id) || null;
  }

  public getActiveCar(): PlayCanvasCar | null {
    return this.getCarById(this.activeCarId) || this.cars[0] || null;
  }

  public flipCar180(carId: string): PlayCanvasCar | null {
    const car = this.getCarById(carId);
    if (!car) return null;
    car.flip180 = !car.flip180;
    car.userAdjust.setLocalEulerAngles(0, car.flip180 ? 180 : 0, 0);
    return car;
  }

  public scaleCar(carId: string, delta: number): PlayCanvasCar | null {
    const car = this.getCarById(carId);
    if (!car) return null;
    car.scaleMul = Math.max(0.5, Math.min(2.0, Number((car.scaleMul + delta).toFixed(2))));
    car.userAdjust.setLocalScale(car.scaleMul, car.scaleMul, car.scaleMul);
    return car;
  }

  public getSummaries(): CarSummary[] {
    return this.cars.map((c) => ({
      id: c.id,
      name: c.name,
      source: c.source,
      flip180: c.flip180,
      scaleMul: c.scaleMul,
    }));
  }
}
