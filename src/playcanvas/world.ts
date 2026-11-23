import * as pc from 'playcanvas';

export type TimeOfDay = 'day' | 'sunset' | 'night';

export interface WorldBoxCollider {
  minX: number;
  maxX: number;
  minZ: number;
  maxZ: number;
}

export interface StuntRamp {
  x: number;
  z: number;
  width: number;
  length: number;
  height: number;
  /** Direction vector in XZ pointing UP the ramp */
  dirX: number;
  dirZ: number;
}

export interface CheckpointRing {
  id: number;
  x: number;
  z: number;
  collected: boolean;
  entity: pc.Entity;
  baseY: number;
}

export interface OpenWorldHandle {
  root: pc.Entity;
  sunLight: pc.Entity;
  colliders: WorldBoxCollider[];
  ramps: StuntRamp[];
  checkpoints: CheckpointRing[];
  worldRadius: number;
  getTerrainHeight: (x: number, z: number) => number;
  setTimeOfDay: (mode: TimeOfDay) => void;
  update: (dt: number, elapsedSec: number, carPos: pc.Vec3) => number;
  resetCheckpoints: () => void;
}

function makeCanvasTexture(
  device: pc.GraphicsDevice,
  size: number,
  drawFn: (ctx: CanvasRenderingContext2D, s: number) => void,
  repeat = true
): pc.Texture {
  const canvas = document.createElement('canvas');
  canvas.width = size;
  canvas.height = size;
  const ctx = canvas.getContext('2d');
  if (ctx) drawFn(ctx, size);

  const tex = new pc.Texture(device, {
    width: size,
    height: size,
    format: pc.PIXELFORMAT_RGBA8,
    mipmaps: true,
    minFilter: pc.FILTER_LINEAR_MIPMAP_LINEAR,
    magFilter: pc.FILTER_LINEAR,
    addressU: repeat ? pc.ADDRESS_REPEAT : pc.ADDRESS_CLAMP_TO_EDGE,
    addressV: repeat ? pc.ADDRESS_REPEAT : pc.ADDRESS_CLAMP_TO_EDGE,
    anisotropy: 2,
  });
  tex.setSource(canvas);
  return tex;
}

function makeStandardMat(opts: {
  diffuse?: pc.Color;
  emissive?: pc.Color;
  emissiveIntensity?: number;
  gloss?: number;
  metalness?: number;
  diffuseMap?: pc.Texture;
  tiling?: [number, number];
  opacity?: number;
  cull?: number;
}): pc.StandardMaterial {
  const mat = new pc.StandardMaterial();
  if (opts.diffuse) mat.diffuse.copy(opts.diffuse);
  if (opts.emissive) {
    mat.emissive.copy(opts.emissive);
    mat.emissiveIntensity = opts.emissiveIntensity ?? 1.0;
  }
  mat.useMetalness = true;
  mat.metalness = opts.metalness ?? 0.05;
  mat.gloss = opts.gloss ?? 0.35;
  if (opts.diffuseMap) {
    mat.diffuseMap = opts.diffuseMap;
    if (opts.tiling) {
      mat.diffuseMapTiling.set(opts.tiling[0], opts.tiling[1]);
    }
  }
  if (opts.opacity !== undefined && opts.opacity < 1) {
    mat.opacity = opts.opacity;
    mat.blendType = pc.BLEND_NORMAL;
    mat.depthWrite = false;
  }
  if (opts.cull !== undefined) {
    mat.cull = opts.cull;
  }
  mat.update();
  return mat;
}

/**
 * Builds an ultra-fast, low-draw-call open-world city & driving campus natively in PlayCanvas.
 * Designed for locked 60 FPS on Android WebView phones as well as desktop browsers.
 */
export function buildPlayCanvasOpenWorld(
  app: pc.Application,
  isMobile: boolean
): OpenWorldHandle {
  const root = new pc.Entity('OpenWorldRoot');
  app.root.addChild(root);

  const colliders: WorldBoxCollider[] = [];
  const ramps: StuntRamp[] = [];
  const checkpoints: CheckpointRing[] = [];
  const worldRadius = 215;

  // --- Procedural PBR Canvas Textures (tiny VRAM, razor sharp) ---
  const grassTex = makeCanvasTexture(app.graphicsDevice, 256, (ctx, s) => {
    ctx.fillStyle = '#4c7c3e';
    ctx.fillRect(0, 0, s, s);
    for (let i = 0; i < 1600; i++) {
      const x = (i * 73) % s;
      const y = (i * 137) % s;
      ctx.fillStyle = i % 2 === 0 ? 'rgba(104, 152, 74, 0.35)' : 'rgba(52, 92, 42, 0.32)';
      ctx.fillRect(x, y, 4, 4);
    }
  });

  const roadTex = makeCanvasTexture(app.graphicsDevice, 256, (ctx, s) => {
    ctx.fillStyle = '#2a2f38';
    ctx.fillRect(0, 0, s, s);
    // Asphalt grain
    for (let i = 0; i < 1200; i++) {
      const x = (i * 59) % s;
      const y = (i * 101) % s;
      ctx.fillStyle = i % 2 === 0 ? 'rgba(255,255,255,0.04)' : 'rgba(0,0,0,0.08)';
      ctx.fillRect(x, y, 2, 2);
    }
    // Side white shoulder lines
    ctx.fillStyle = '#e2e8f0';
    ctx.fillRect(14, 0, 6, s);
    ctx.fillRect(s - 20, 0, 6, s);
    // Center dashed yellow line
    ctx.fillStyle = '#f59e0b';
    ctx.fillRect(s / 2 - 4, 18, 8, 92);
    ctx.fillRect(s / 2 - 4, 146, 8, 92);
  });

  const plazaTex = makeCanvasTexture(app.graphicsDevice, 256, (ctx, s) => {
    ctx.fillStyle = '#d6cfc2';
    ctx.fillRect(0, 0, s, s);
    ctx.strokeStyle = 'rgba(110, 102, 88, 0.28)';
    ctx.lineWidth = 2;
    const step = s / 4;
    for (let i = 0; i <= 4; i++) {
      ctx.beginPath();
      ctx.moveTo(i * step, 0);
      ctx.lineTo(i * step, s);
      ctx.stroke();
      ctx.beginPath();
      ctx.moveTo(0, i * step);
      ctx.lineTo(s, i * step);
      ctx.stroke();
    }
  });

  const windowFacadeTex = makeCanvasTexture(app.graphicsDevice, 256, (ctx, s) => {
    ctx.fillStyle = '#1e293b';
    ctx.fillRect(0, 0, s, s);
    const cols = 4;
    const rows = 4;
    const padX = 8;
    const padY = 10;
    const w = s / cols;
    const h = s / rows;
    for (let r = 0; r < rows; r++) {
      for (let c = 0; c < cols; c++) {
        const grad = ctx.createLinearGradient(0, r * h, 0, (r + 1) * h);
        grad.addColorStop(0, '#60a5fa');
        grad.addColorStop(0.6, '#2563eb');
        grad.addColorStop(1, '#1e3a8a');
        ctx.fillStyle = grad;
        ctx.fillRect(c * w + padX, r * h + padY, w - padX * 2, h - padY * 2);
      }
    }
    ctx.fillStyle = '#cbd5e1';
    for (let r = 0; r <= rows; r++) {
      ctx.fillRect(0, r * h - 3, s, 6);
    }
  });

  // --- Shared Materials ---
  const grassMat = makeStandardMat({ diffuseMap: grassTex, tiling: [42, 42], gloss: 0.14 });
  const roadMatZ = makeStandardMat({ diffuseMap: roadTex, tiling: [1, 24], gloss: 0.28 });
  const roadMatX = makeStandardMat({ diffuseMap: roadTex, tiling: [1, 24], gloss: 0.28 });
  const asphaltSolidMat = makeStandardMat({ diffuse: new pc.Color(0.16, 0.19, 0.23), gloss: 0.28 });
  const plazaMat = makeStandardMat({ diffuseMap: plazaTex, tiling: [10, 10], gloss: 0.25 });
  const concreteMat = makeStandardMat({ diffuse: new pc.Color(0.84, 0.85, 0.87), gloss: 0.3 });
  const darkMetalMat = makeStandardMat({
    diffuse: new pc.Color(0.15, 0.18, 0.23),
    metalness: 0.72,
    gloss: 0.65,
  });
  const glassBuildingMat = makeStandardMat({
    diffuseMap: windowFacadeTex,
    tiling: [3, 2],
    metalness: 0.45,
    gloss: 0.78,
  });
  const warmAccentMat = makeStandardMat({
    diffuse: new pc.Color(0.95, 0.62, 0.12),
    metalness: 0.2,
    gloss: 0.55,
  });
  const blueAccentMat = makeStandardMat({
    diffuse: new pc.Color(0.16, 0.46, 0.92),
    metalness: 0.35,
    gloss: 0.68,
  });
  const rampMat = makeStandardMat({
    diffuse: new pc.Color(0.92, 0.48, 0.12),
    metalness: 0.15,
    gloss: 0.45,
  });
  const trunkMat = makeStandardMat({ diffuse: new pc.Color(0.36, 0.25, 0.17), gloss: 0.12 });
  const foliageMatA = makeStandardMat({ diffuse: new pc.Color(0.21, 0.48, 0.24), gloss: 0.18 });
  const foliageMatB = makeStandardMat({ diffuse: new pc.Color(0.28, 0.56, 0.25), gloss: 0.2 });
  const waterMat = makeStandardMat({
    diffuse: new pc.Color(0.11, 0.42, 0.68),
    metalness: 0.35,
    gloss: 0.88,
  });
  const lampGlowMat = makeStandardMat({
    diffuse: new pc.Color(1, 0.96, 0.82),
    emissive: new pc.Color(1, 0.9, 0.65),
    emissiveIntensity: 1.5,
    gloss: 0.2,
  });
  const ringMat = makeStandardMat({
    diffuse: new pc.Color(0.98, 0.76, 0.16),
    emissive: new pc.Color(0.98, 0.68, 0.1),
    emissiveIntensity: 1.35,
    metalness: 0.75,
    gloss: 0.82,
  });
  const mountainMat = makeStandardMat({
    diffuse: new pc.Color(0.38, 0.48, 0.52),
    gloss: 0.08,
  });

  const addPrimitive = (
    name: string,
    type: 'box' | 'cylinder' | 'sphere' | 'cone' | 'plane' | 'torus',
    pos: [number, number, number],
    scale: [number, number, number],
    mat: pc.Material,
    opts?: { rot?: [number, number, number]; castShadows?: boolean; receiveShadows?: boolean }
  ): pc.Entity => {
    const ent = new pc.Entity(name);
    ent.setLocalPosition(pos[0], pos[1], pos[2]);
    ent.setLocalScale(scale[0], scale[1], scale[2]);
    if (opts?.rot) ent.setLocalEulerAngles(opts.rot[0], opts.rot[1], opts.rot[2]);
    ent.addComponent('render', {
      type,
      material: mat,
      castShadows: opts?.castShadows ?? false,
      receiveShadows: opts?.receiveShadows ?? true,
    });
    root.addChild(ent);
    return ent;
  };

  // --- 1. Ground Terrain ---
  addPrimitive('TerrainGrass', 'box', [0, -0.5, 0], [480, 1, 480], grassMat, {
    castShadows: false,
    receiveShadows: true,
  });

  // --- 2. Central Showroom Plaza (where Cobalt, Damas & Campus GT spawn!) ---
  addPrimitive('ShowroomPlaza', 'box', [0, 0.02, 0], [56, 0.04, 48], plazaMat, {
    receiveShadows: true,
  });

  // --- 3. 4-Lane Asphalt Avenue Grid + Outer Ring Speedway ---
  // North-South Avenue (x = 0)
  addPrimitive('Road_NS', 'box', [0, 0.035, 0], [15, 0.05, 380], roadMatZ, {
    receiveShadows: true,
  });
  // East-West Avenue (z = 0)
  addPrimitive('Road_EW', 'box', [0, 0.032, 0], [15, 0.05, 380], roadMatX, {
    rot: [0, 90, 0],
    receiveShadows: true,
  });
  // Outer Ring Boulevard (North, South, East, West segments at +/-150m)
  addPrimitive('RingRoad_N', 'box', [0, 0.03, -150], [14, 0.05, 314], roadMatX, {
    rot: [0, 90, 0],
    receiveShadows: true,
  });
  addPrimitive('RingRoad_S', 'box', [0, 0.03, 150], [14, 0.05, 314], roadMatX, {
    rot: [0, 90, 0],
    receiveShadows: true,
  });
  addPrimitive('RingRoad_W', 'box', [-150, 0.03, 0], [14, 0.05, 314], roadMatZ, {
    receiveShadows: true,
  });
  addPrimitive('RingRoad_E', 'box', [150, 0.03, 0], [14, 0.05, 314], roadMatZ, {
    receiveShadows: true,
  });

  // Wide Drift Pad in Southeast quadrant (x=76, z=76)
  addPrimitive('DriftArenaPad', 'box', [78, 0.03, 78], [72, 0.05, 72], asphaltSolidMat, {
    receiveShadows: true,
  });
  // Drift center donut pylon
  addPrimitive('DriftPylonBase', 'cylinder', [78, 0.6, 78], [5, 1.2, 5], warmAccentMat, {
    castShadows: true,
  });
  colliders.push({ minX: 75.2, maxX: 80.8, minZ: 75.2, maxZ: 80.8 });

  // Waterfront Lagoon in Northeast quadrant
  addPrimitive('WaterfrontLagoon', 'box', [82, 0.015, -82], [74, 0.03, 66], waterMat, {
    receiveShadows: false,
  });

  // --- 4. Modern Campus Buildings & Landmarks (with clean collision boxes) ---
  const addBuilding = (
    name: string,
    x: number,
    z: number,
    w: number,
    h: number,
    d: number,
    accentMat: pc.Material
  ) => {
    addPrimitive(`${name}_Body`, 'box', [x, h * 0.5, z], [w, h, d], glassBuildingMat, {
      castShadows: !isMobile,
      receiveShadows: true,
    });
    // Crisp architectural overhang roof canopy
    addPrimitive(`${name}_Roof`, 'box', [x, h + 0.45, z], [w + 2.4, 0.9, d + 2.4], concreteMat, {
      castShadows: true,
      receiveShadows: true,
    });
    // Accent crown trim
    addPrimitive(`${name}_Trim`, 'box', [x, h + 1.05, z], [w * 0.85, 0.4, d * 0.85], accentMat, {
      castShadows: false,
      receiveShadows: false,
    });
    colliders.push({
      minX: x - w * 0.5 - 0.6,
      maxX: x + w * 0.5 + 0.6,
      minZ: z - d * 0.5 - 0.6,
      maxZ: z + d * 0.5 + 0.6,
    });
  };

  // Gradient Canopy Pavilion behind Showroom Plaza
  addBuilding('CanopyHQ', 0, -46, 36, 11, 20, blueAccentMat);
  // West Design Campus
  addBuilding('WestStudio', -68, -56, 30, 14, 24, warmAccentMat);
  addBuilding('WestLab', -74, 52, 28, 12, 26, blueAccentMat);
  addBuilding('SouthTower', -62, 108, 22, 20, 22, warmAccentMat);
  // North Skyline Towers
  addBuilding('NorthTowerA', -64, -112, 24, 24, 20, blueAccentMat);
  addBuilding('NorthTowerB', 64, -190, 32, 26, 22, warmAccentMat);
  addBuilding('EastPavilion', 188, 18, 24, 16, 34, blueAccentMat);

  // Showroom Archway Gate right in front of the spawn plaza
  addPrimitive('ArchPillarL', 'box', [-11.5, 4.2, -18], [1.2, 8.4, 1.2], darkMetalMat, {
    castShadows: true,
  });
  addPrimitive('ArchPillarR', 'box', [11.5, 4.2, -18], [1.2, 8.4, 1.2], darkMetalMat, {
    castShadows: true,
  });
  addPrimitive('ArchBeam', 'box', [0, 8.3, -18], [24.6, 1.1, 1.6], blueAccentMat, {
    castShadows: true,
  });
  colliders.push({ minX: -12.4, maxX: -10.6, minZ: -18.9, maxZ: -17.1 });
  colliders.push({ minX: 10.6, maxX: 12.4, minZ: -18.9, maxZ: -17.1 });

  // --- 5. Four Drivable Stunt Ramps (with mathematical terrain height!) ---
  const addRamp = (name: string, x: number, z: number, yawDeg: number, width: number, length: number, height: number) => {
    const rad = (yawDeg * Math.PI) / 180;
    // Direction pointing UP the ramp (-Z rotated by yawDeg)
    const dirX = -Math.sin(rad);
    const dirZ = -Math.cos(rad);
    ramps.push({ x, z, width, length, height, dirX, dirZ });

    const slopeDeg = (Math.atan2(height, length) * 180) / Math.PI;
    const hyp = Math.hypot(length, height);
    const rampHolder = new pc.Entity(name);
    rampHolder.setLocalPosition(x, 0, z);
    rampHolder.setLocalEulerAngles(0, yawDeg, 0);
    root.addChild(rampHolder);

    const deck = new pc.Entity(`${name}_Deck`);
    deck.setLocalPosition(0, height * 0.5 - 0.08, 0);
    deck.setLocalEulerAngles(slopeDeg, 0, 0);
    deck.setLocalScale(width, 0.25, hyp);
    deck.addComponent('render', {
      type: 'box',
      material: rampMat,
      castShadows: true,
      receiveShadows: true,
    });
    rampHolder.addChild(deck);

    // Side safety rails
    for (const side of [-1, 1]) {
      const rail = new pc.Entity(`${name}_Rail_${side}`);
      rail.setLocalPosition(side * (width * 0.48), height * 0.5 + 0.14, 0);
      rail.setLocalEulerAngles(slopeDeg, 0, 0);
      rail.setLocalScale(0.25, 0.35, hyp);
      rail.addComponent('render', { type: 'box', material: darkMetalMat });
      rampHolder.addChild(rail);
    }
  };

  addRamp('Ramp_NorthStraight', 0, -90, 0, 7.2, 14, 2.5);
  addRamp('Ramp_EastBoulevard', 95, 0, -90, 7.2, 14, 2.4);
  addRamp('Ramp_DriftArena', 78, 52, 180, 8.0, 14, 2.6);
  addRamp('Ramp_WestAvenue', -95, 0, 90, 7.2, 14, 2.4);

  // --- 6. Stylized Low-Poly Campus Trees & Streetlamps (lightweight!) ---
  const treePositions: Array<[number, number, number]> = [
    [-28, -24, 1.1], [-36, -12, 0.95], [28, -24, 1.15], [36, -12, 1.0],
    [-26, 26, 1.05], [26, 26, 1.1], [-34, 48, 1.2], [34, 48, 0.95],
    [-24, -76, 1.15], [24, -76, 1.05], [-115, -30, 1.25], [-115, 30, 1.1],
    [115, -24, 1.2], [115, 24, 1.1], [-36, -128, 1.2], [36, -128, 1.1],
    [-36, 128, 1.1], [36, 128, 1.15], [132, 124, 1.1], [-124, 124, 1.2],
  ];
  treePositions.forEach(([tx, tz, sc], idx) => {
    addPrimitive(`TreeTrunk_${idx}`, 'cylinder', [tx, 1.6 * sc, tz], [0.42 * sc, 3.2 * sc, 0.42 * sc], trunkMat, {
      castShadows: false,
    });
    addPrimitive(
      `TreeCrown_${idx}`,
      idx % 2 === 0 ? 'sphere' : 'cone',
      [tx, 4.1 * sc, tz],
      idx % 2 === 0 ? [3.2 * sc, 3.1 * sc, 3.2 * sc] : [3.0 * sc, 4.6 * sc, 3.0 * sc],
      idx % 2 === 0 ? foliageMatA : foliageMatB,
      { castShadows: !isMobile }
    );
  });

  // Roadside Streetlamps
  const lampPositions: Array<[number, number]> = [
    [-9.5, -36], [9.5, -36], [-9.5, 36], [9.5, 36],
    [-9.5, -110], [9.5, -110], [-9.5, 110], [9.5, 110],
    [-46, -9.5], [46, -9.5], [-112, 9.5], [112, 9.5],
  ];
  lampPositions.forEach(([lx, lz], idx) => {
    addPrimitive(`LampPole_${idx}`, 'cylinder', [lx, 3.4, lz], [0.18, 6.8, 0.18], darkMetalMat);
    addPrimitive(`LampBulb_${idx}`, 'sphere', [lx, 6.9, lz], [0.55, 0.4, 0.55], lampGlowMat);
  });

  // Distant Mountain Skyline Silhouette Ring (adds huge depth with just 12 meshes!)
  for (let i = 0; i < 12; i++) {
    const ang = (i / 12) * Math.PI * 2;
    const dist = 248;
    const h = 34 + (i % 3) * 18;
    const w = 85 + (i % 2) * 28;
    addPrimitive(
      `Mountain_${i}`,
      'cone',
      [Math.cos(ang) * dist, h * 0.42, Math.sin(ang) * dist],
      [w, h, w * 0.72],
      mountainMat,
      { castShadows: false, receiveShadows: false }
    );
  }

  // --- 7. 12 Floating Golden Checkpoints across the Open World ---
  const cpCoords: Array<[number, number]> = [
    [0, -32], [0, -112], [0, -150], [75, -150],
    [150, -75], [150, 0], [150, 75], [78, 96],
    [0, 150], [-85, 150], [-150, 0], [-75, 0],
  ];
  cpCoords.forEach(([cx, cz], idx) => {
    const ring = new pc.Entity(`Checkpoint_${idx + 1}`);
    const baseY = 2.0;
    ring.setLocalPosition(cx, baseY, cz);
    ring.setLocalEulerAngles(90, idx * 30, 0);
    ring.setLocalScale(2.8, 2.8, 2.8);
    ring.addComponent('render', {
      type: 'torus',
      material: ringMat,
      castShadows: false,
      receiveShadows: false,
    });
    root.addChild(ring);
    checkpoints.push({ id: idx + 1, x: cx, z: cz, collected: false, entity: ring, baseY });
  });

  // --- 8. Directional Sun Light with Mobile-Safe Soft Shadow Map ---
  const sunLight = new pc.Entity('SunLight');
  sunLight.addComponent('light', {
    type: 'directional',
    color: new pc.Color(1.0, 0.96, 0.88),
    intensity: 1.55,
    castShadows: true,
    shadowDistance: isMobile ? 55 : 95,
    shadowResolution: isMobile ? 1024 : 2048,
    shadowBias: 0.25,
    normalOffsetBias: 0.04,
    shadowType: pc.SHADOW_PCF3_32F,
  });
  sunLight.setLocalEulerAngles(48, 36, 0);
  root.addChild(sunLight);

  // Secondary cool sky fill light (no shadows -> zero GPU cost)
  const fillLight = new pc.Entity('SkyFillLight');
  fillLight.addComponent('light', {
    type: 'directional',
    color: new pc.Color(0.55, 0.72, 0.98),
    intensity: 0.42,
    castShadows: false,
  });
  fillLight.setLocalEulerAngles(-35, -140, 0);
  root.addChild(fillLight);

  // --- Atmosphere & Time-of-Day Presets ---
  const setTimeOfDay = (mode: TimeOfDay) => {
    const scene = app.scene;
    scene.fog.type = pc.FOG_EXP2;

    if (mode === 'sunset') {
      scene.ambientLight.set(0.46, 0.34, 0.32);
      scene.fog.color.set(0.95, 0.66, 0.46);
      scene.fog.density = 0.0028;
      sunLight.setLocalEulerAngles(22, 54, 0);
      if (sunLight.light) {
        sunLight.light.color.set(1.0, 0.72, 0.44);
        sunLight.light.intensity = 1.75;
      }
      if (fillLight.light) {
        fillLight.light.color.set(0.46, 0.44, 0.74);
        fillLight.light.intensity = 0.48;
      }
    } else if (mode === 'night') {
      scene.ambientLight.set(0.18, 0.22, 0.34);
      scene.fog.color.set(0.06, 0.09, 0.16);
      scene.fog.density = 0.0036;
      sunLight.setLocalEulerAngles(55, 25, 0);
      if (sunLight.light) {
        sunLight.light.color.set(0.58, 0.72, 1.0);
        sunLight.light.intensity = 0.72;
      }
      if (fillLight.light) {
        fillLight.light.color.set(0.24, 0.36, 0.62);
        fillLight.light.intensity = 0.35;
      }
    } else {
      // Crisp Sunny California Afternoon
      scene.ambientLight.set(0.44, 0.5, 0.58);
      scene.fog.color.set(0.68, 0.83, 0.97);
      scene.fog.density = 0.0022;
      sunLight.setLocalEulerAngles(48, 36, 0);
      if (sunLight.light) {
        sunLight.light.color.set(1.0, 0.96, 0.88);
        sunLight.light.intensity = 1.55;
      }
      if (fillLight.light) {
        fillLight.light.color.set(0.55, 0.72, 0.98);
        fillLight.light.intensity = 0.44;
      }
    }
  };

  setTimeOfDay('day');

  // --- Accurate Terrain + Ramp Elevation Query ---
  const getTerrainHeight = (x: number, z: number): number => {
    let h = 0.05;
    for (let i = 0; i < ramps.length; i++) {
      const r = ramps[i];
      const dx = x - r.x;
      const dz = z - r.z;
      const along = dx * r.dirX + dz * r.dirZ;
      const side = dx * -r.dirZ + dz * r.dirX;
      if (Math.abs(side) <= r.width * 0.52 && Math.abs(along) <= r.length * 0.52) {
        const t = Math.max(0, Math.min(1, (along + r.length * 0.5) / r.length));
        h = Math.max(h, 0.05 + t * r.height);
      }
    }
    return h;
  };

  const update = (dt: number, elapsedSec: number, carPos: pc.Vec3): number => {
    let newlyCollected = 0;
    for (let i = 0; i < checkpoints.length; i++) {
      const cp = checkpoints[i];
      if (cp.collected) continue;
      cp.entity.rotateLocal(0, 0, dt * 85);
      cp.entity.setLocalPosition(cp.x, cp.baseY + Math.sin(elapsedSec * 2.8 + i) * 0.25, cp.z);

      const dx = carPos.x - cp.x;
      const dz = carPos.z - cp.z;
      if (dx * dx + dz * dz < 18.5) {
        cp.collected = true;
        cp.entity.enabled = false;
        newlyCollected += 1;
      }
    }
    return newlyCollected;
  };

  const resetCheckpoints = () => {
    for (const cp of checkpoints) {
      cp.collected = false;
      cp.entity.enabled = true;
    }
  };

  return {
    root,
    sunLight,
    colliders,
    ramps,
    checkpoints,
    worldRadius,
    getTerrainHeight,
    setTimeOfDay,
    update,
    resetCheckpoints,
  };
}
