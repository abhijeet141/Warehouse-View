<script lang="ts">
  import { onMount, onDestroy } from 'svelte';
  import * as THREE from 'three';
  import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
  import { RailControls } from './railControls';
  import { buildRacks, buildAisleSigns, buildPallets, buildSafetyNets, groupBaysIntoRows } from './rackBuilder';
  import { buildEnvironment, type ShellBounds } from './environmentBuilder';
  import type { Segment, SegmentType } from '../types';

  export let segments: Segment[];
  export let visibleTypes: Set<SegmentType>;
  export let camera: {
    position: [number, number, number];
    fov?: number;
    near?: number;
    far?: number;
  // Default vantage (data mm): close in front of the aisle entrances, mid-rack
  // height, looking down the aisles — the front rack row roughly fills the
  // frame so individual spaces read near their real size. Scroll out for the
  // whole-building view. fov 40 keeps a telephoto look (less perspective
  // shrink than the old 50).
  } = { position: [-22000, 11000, 43525], fov: 40, near: 100, far: 800000 };
  export let orbit: {
    target: [number, number, number];
    minDistance: number;
    maxDistance: number;
  // maxDistance keeps zoom-out within the building; the shell clamp in
  // animate() hard-stops the camera at the walls/roof either way.
  } = { target: [53700, 7825, 43525], minDistance: 1000, maxDistance: 100000 };
  export let grid: {
    size: number;
    cellSize: number;
    sectionSize: number;
    centerXZ: [number, number];
    fadeDistance?: number;
    fadeStrength?: number;
  } = { size: 230000, cellSize: 2000, sectionSize: 6000, centerXZ: [53700, 43525], fadeDistance: 150000, fadeStrength: 1 };
  export let floorY = 100;

  // eyeHeight: drop in at the third rack level (C: 5200–7700mm) rather than the
  // floor — a more natural vantage than craning up from the bottom level.
  export let walk: { eyeHeight: number; moveSpeed: number; fov: number } = { eyeHeight: 6450, moveSpeed: 6000, fov: 55 };

  const COLOR_MAP: Record<SegmentType, number> = {
    AISLE: 0x3b82f6,
    BAY:   0xf97316,
    LEVEL: 0x22c55e,
    SPACE: 0xef4444,
  };

  const OPACITY_MAP: Record<SegmentType, number> = {
    AISLE: 0.06,
    BAY:   0.15,
    LEVEL: 0.30,
    SPACE: 0.15,
  };

  // Fixed draw order for the transparent tiers. Without this three.js sorts
  // them by camera distance per-object (not per-instance), so at low camera
  // angles the red SPACE mesh can be drawn after BAY/LEVEL and tint the racks.
  const TIER_ORDER: Record<SegmentType, number> = { AISLE: 0, SPACE: 0, BAY: 1, LEVEL: 2 };

  // Tier opacities while walking inside an aisle: aisle volume nearly gone,
  // bays/levels stronger for spatial orientation, spaces invisible (still
  // hoverable via raycast).
  const WALK_OPACITY: Record<SegmentType, number> = { AISLE: 0.04, BAY: 0.25, LEVEL: 0.55, SPACE: 0 };

  const SPACE_HOVER_COLOR   = 0x7f1d1d;
  const SPACE_HOVER_OPACITY = 0.95;

  const FIND_COLOR = 0xfacc15;

  let findGroup: THREE.Group | null = null;
  let findMatchSegs: Segment[] = [];
  let findQuery = '';
  let findStatus = '';
  let findStatusKind: 'ok' | 'err' = 'ok';
  let findInputEl: HTMLInputElement;
  let suggestions: Segment[] = [];
  let suggestionsOpen = false;
  let activeSuggestion = -1;

  const TYPE_HEX: Record<SegmentType, string> = {
    AISLE: '#3b82f6',
    BAY:   '#f97316',
    LEVEL: '#22c55e',
    SPACE: '#ef4444',
  };

  let container: HTMLDivElement;
  let canvas: HTMLCanvasElement;
  let tooltipX = 0;
  let tooltipY = 0;
  let hoverInfo: {
    fullName: string;
    type: SegmentType;
    coords: [number, number, number];
    dims:   [number, number, number];
  } | null = null;

  let scene: THREE.Scene;
  let perspectiveCamera: THREE.PerspectiveCamera;
  let renderer: THREE.WebGLRenderer;
  let controls: OrbitControls;
  let raycaster: THREE.Raycaster;
  let pointer: THREE.Vector2;
  let rafId = 0;

  let rail: RailControls;
  let clock: THREE.Clock;
  let mode: 'orbit' | 'walk' = 'orbit';
  let aisleLabel = '';
  let aisleIndex = 0;
  let aisleTotal = 0;
  let aislePickerOpen = false;

  const containerGroups = new Map<SegmentType, THREE.Group>();
  const tierInstancedMeshes = new Map<SegmentType, THREE.InstancedMesh>();
  const tierEdgeMeshes = new Map<SegmentType, THREE.LineSegments>();
  let spaceSegments: Segment[] = [];
  let rackTopY = 0; // tallest segment top (world Y), for arcing flights over the racks
  let highlightGroup: THREE.Group | null = null;
  let highlightedId: number | null = null;
  let gridMesh: THREE.Mesh | null = null;
  let realisticDisposers: Array<() => void> = [];
  let shellBounds: ShellBounds | null = null;

  // Procedural anti-aliased floor grid (port of drei's <Grid>), retuned as
  // faint concrete expansion joints over the slab; fades with distance.
  function makeShaderGrid(): THREE.Mesh {
    const planeGeom = new THREE.PlaneGeometry(grid.size, grid.size);
    planeGeom.rotateX(-Math.PI / 2);

    const mat = new THREE.ShaderMaterial({
      uniforms: {
        uCellSize:         { value: grid.cellSize },
        uSectionSize:      { value: grid.sectionSize },
        uCellColor:        { value: new THREE.Color(0xa6abb1) },
        uSectionColor:     { value: new THREE.Color(0x9aa0a6) },
        uCellThickness:    { value: 1.0 },
        uSectionThickness: { value: 1.8 },
        uFadeDistance:     { value: grid.fadeDistance ?? 400000 },
        uFadeStrength:     { value: grid.fadeStrength ?? 1.0 },
        uCameraPos:        { value: new THREE.Vector3() },
      },
      vertexShader: `
        varying vec3 vWorldPos;
        void main() {
          vec4 wp = modelMatrix * vec4(position, 1.0);
          vWorldPos = wp.xyz;
          gl_Position = projectionMatrix * viewMatrix * wp;
        }
      `,
      fragmentShader: `
        uniform float uCellSize;
        uniform float uSectionSize;
        uniform vec3  uCellColor;
        uniform vec3  uSectionColor;
        uniform float uCellThickness;
        uniform float uSectionThickness;
        uniform float uFadeDistance;
        uniform float uFadeStrength;
        uniform vec3  uCameraPos;
        varying vec3 vWorldPos;

        float gridLine(vec2 coord, float thickness) {
          vec2 g = abs(fract(coord - 0.5) - 0.5) / fwidth(coord);
          float line = min(g.x, g.y);
          return 1.0 - min(line / thickness, 1.0);
        }

        void main() {
          vec2 xz = vWorldPos.xz;
          float cell    = gridLine(xz / uCellSize,    uCellThickness);
          float section = gridLine(xz / uSectionSize, uSectionThickness);

          vec3 color = mix(uCellColor, uSectionColor, section);
          float alpha = section * 0.3 + cell * 0.0;

          float dist = distance(uCameraPos.xz, xz);
          float fade = 1.0 - smoothstep(uFadeDistance * 0.5, uFadeDistance, dist);
          alpha *= pow(fade, uFadeStrength);

          if (alpha < 0.01) discard;
          gl_FragColor = vec4(color, alpha);
        }
      `,
      transparent: true,
      side: THREE.DoubleSide,
      depthWrite: false,
    });

    const mesh = new THREE.Mesh(planeGeom, mat);
    mesh.position.set(grid.centerXZ[0], 2, grid.centerXZ[1]);
    mesh.renderOrder = -1;
    mesh.raycast = () => {};
    return mesh;
  }

  function makeContainerMesh(seg: Segment): THREE.Group {
    const group = new THREE.Group();
    const geom = new THREE.BoxGeometry(seg.dimensionX, seg.dimensionZ, seg.dimensionY);
    const mat = new THREE.MeshStandardMaterial({
      color: COLOR_MAP[seg.type],
      transparent: true,
      opacity: OPACITY_MAP[seg.type],
      depthWrite: false,
    });
    const mesh = new THREE.Mesh(geom, mat);
    mesh.position.set(
      seg.coordinateX + seg.dimensionX / 2,
      seg.coordinateZ + seg.dimensionZ / 2,
      seg.coordinateY + seg.dimensionY / 2,
    );
    mesh.raycast = () => {};
    group.add(mesh);

    const edgeGeom = new THREE.EdgesGeometry(geom);
    const edgeMat = new THREE.LineBasicMaterial({ color: COLOR_MAP[seg.type] });
    const edges = new THREE.LineSegments(edgeGeom, edgeMat);
    edges.position.copy(mesh.position);
    edges.scale.set(1.001, 1.001, 1.001);
    group.add(edges);

    return group;
  }

  // Build one InstancedMesh that draws every segment of a tier in a single draw call.
  function buildTierInstancedMesh(list: Segment[], type: SegmentType): THREE.InstancedMesh {
    const geom = new THREE.BoxGeometry(1, 1, 1);
    const mat = new THREE.MeshStandardMaterial({
      color: COLOR_MAP[type],
      transparent: true,
      opacity: OPACITY_MAP[type],
      depthWrite: false,
    });
    const inst = new THREE.InstancedMesh(geom, mat, list.length);
    const dummy = new THREE.Object3D();
    for (let i = 0; i < list.length; i++) {
      const s = list[i];
      dummy.position.set(
        s.coordinateX + s.dimensionX / 2,
        s.coordinateZ + s.dimensionZ / 2,
        s.coordinateY + s.dimensionY / 2,
      );
      dummy.scale.set(s.dimensionX, s.dimensionZ, s.dimensionY);
      dummy.rotation.set(0, 0, 0);
      dummy.updateMatrix();
      inst.setMatrixAt(i, dummy.matrix);
    }
    inst.instanceMatrix.needsUpdate = true;
    inst.computeBoundingSphere();
    inst.computeBoundingBox();
    // Containers (BAY/LEVEL) shouldn't intercept pointer events; only SPACE does.
    if (type !== 'SPACE') inst.raycast = () => {};
    return inst;
  }

  // Build a single LineSegments containing every cube's 12 edges (pre-transformed),
  // so one draw call covers all edge outlines for the tier.
  function buildTierEdgeMesh(list: Segment[], type: SegmentType): THREE.LineSegments {
    // 12 edges × 2 endpoints = 24 vertices per cube
    const unitEdges = new THREE.EdgesGeometry(new THREE.BoxGeometry(1, 1, 1));
    const unitPositions = unitEdges.getAttribute('position') as THREE.BufferAttribute;
    const vertsPerCube = unitPositions.count;
    const allPositions = new Float32Array(list.length * vertsPerCube * 3);

    const v = new THREE.Vector3();
    for (let i = 0; i < list.length; i++) {
      const s = list[i];
      const cx = s.coordinateX + s.dimensionX / 2;
      const cy = s.coordinateZ + s.dimensionZ / 2;
      const cz = s.coordinateY + s.dimensionY / 2;
      const sx = s.dimensionX;
      const sy = s.dimensionZ;
      const sz = s.dimensionY;
      const offset = i * vertsPerCube * 3;
      for (let j = 0; j < vertsPerCube; j++) {
        v.fromBufferAttribute(unitPositions, j);
        allPositions[offset + j * 3 + 0] = v.x * sx + cx;
        allPositions[offset + j * 3 + 1] = v.y * sy + cy;
        allPositions[offset + j * 3 + 2] = v.z * sz + cz;
      }
    }
    unitEdges.dispose();

    const geom = new THREE.BufferGeometry();
    geom.setAttribute('position', new THREE.BufferAttribute(allPositions, 3));
    geom.computeBoundingSphere();
    geom.computeBoundingBox();

    const mat = new THREE.LineBasicMaterial({ color: COLOR_MAP[type] });
    const lines = new THREE.LineSegments(geom, mat);
    lines.raycast = () => {};
    return lines;
  }

  // outlineOnly: used when the segment is already shown as a yellow find match —
  // the red fill would fight with the yellow box, so only the wireframe is drawn.
  function makeHighlightGroup(seg: Segment, outlineOnly = false): THREE.Group {
    const group = new THREE.Group();
    const geom = new THREE.BoxGeometry(seg.dimensionX, seg.dimensionZ, seg.dimensionY);
    const center = new THREE.Vector3(
      seg.coordinateX + seg.dimensionX / 2,
      seg.coordinateZ + seg.dimensionZ / 2,
      seg.coordinateY + seg.dimensionY / 2,
    );

    if (!outlineOnly) {
      const mat = new THREE.MeshStandardMaterial({
        color: SPACE_HOVER_COLOR,
        transparent: true,
        opacity: SPACE_HOVER_OPACITY,
        depthWrite: false,
        depthTest: false, // show through the opaque rack structure
      });
      const mesh = new THREE.Mesh(geom, mat);
      mesh.position.copy(center);
      mesh.renderOrder = 5; // above the tier boxes (0–2)
      mesh.raycast = () => {};
      group.add(mesh);
    }

    const edgeGeom = new THREE.EdgesGeometry(geom);
    const edgeMat = new THREE.LineBasicMaterial({ color: SPACE_HOVER_COLOR, transparent: true, depthTest: false });
    const edges = new THREE.LineSegments(edgeGeom, edgeMat);
    edges.position.copy(center);
    // Outline-only sits on top of the find box (scale 1.02), so push it out
    // a bit further to stay visible.
    const s = outlineOnly ? 1.04 : 1.001;
    edges.scale.set(s, s, s);
    edges.renderOrder = outlineOnly ? 7 : 5; // above find boxes (6) / tier boxes (0–2)
    group.add(edges);

    return group;
  }

  // True when the segment sits inside (or is) one of the yellow find boxes —
  // there the red hover fill would fight with the yellow, so only the
  // wireframe outline is drawn.
  function isInsideFind(seg: Segment): boolean {
    if (findMatchSegs.length === 0) return false;
    const cx = seg.coordinateX + seg.dimensionX / 2;
    const cy = seg.coordinateY + seg.dimensionY / 2;
    const cz = seg.coordinateZ + seg.dimensionZ / 2;
    return findMatchSegs.some((m) =>
      cx >= m.coordinateX && cx <= m.coordinateX + m.dimensionX &&
      cy >= m.coordinateY && cy <= m.coordinateY + m.dimensionY &&
      cz >= m.coordinateZ && cz <= m.coordinateZ + m.dimensionZ,
    );
  }

  function clearFind() {
    findMatchSegs = [];
    if (!findGroup) return;
    scene.remove(findGroup);
    findGroup.traverse((o) => {
      if (o instanceof THREE.Mesh || o instanceof THREE.LineSegments) {
        o.geometry.dispose();
        const m = o.material as THREE.Material | THREE.Material[];
        Array.isArray(m) ? m.forEach((x) => x.dispose()) : m.dispose();
      }
    });
    findGroup = null;
  }

  function makeFindBox(seg: Segment): THREE.Group {
    const g = new THREE.Group();
    const geom = new THREE.BoxGeometry(seg.dimensionX, seg.dimensionZ, seg.dimensionY);
    const mesh = new THREE.Mesh(
      geom,
      new THREE.MeshStandardMaterial({
        color: FIND_COLOR, transparent: true, opacity: 0.85,
        depthWrite: false, depthTest: false, side: THREE.DoubleSide,
      }),
    );
    mesh.position.set(
      seg.coordinateX + seg.dimensionX / 2,
      seg.coordinateZ + seg.dimensionZ / 2,
      seg.coordinateY + seg.dimensionY / 2,
    );
    mesh.renderOrder = 6; // above hover (5)
    mesh.raycast = () => {};
    g.add(mesh);

    const edges = new THREE.LineSegments(
      new THREE.EdgesGeometry(geom),
      new THREE.LineBasicMaterial({ color: FIND_COLOR, transparent: true, depthTest: false }),
    );
    edges.position.copy(mesh.position);
    edges.scale.set(1.02, 1.02, 1.02);
    edges.renderOrder = 6;
    g.add(edges);
    return g;
  }

  // Never frame closer than this (mm) — keeps the camera outside the rack even
  // when the framed box itself is a single small leaf segment, while landing
  // near enough that the found space fills a good part of the screen.
  const FIND_MIN_DIST = 6000;

  // Leaf segments (LEVEL/SPACE) are small boxes deep inside the rack; framing
  // them directly puts the camera inside the bay. Widen the framing box to the
  // containing BAY so a nested match gets the same overview a bay search does.
  function widenToBayContext(matches: Segment[], box: THREE.Box3): THREE.Box3 {
    const out = box.clone();
    if (matches.length > 50) return out; // many matches ⇒ box is already wide
    const bays = segments.filter((s) => s.type === 'BAY');
    for (const seg of matches) {
      if (seg.type !== 'LEVEL' && seg.type !== 'SPACE') continue;
      const cx = seg.coordinateX + seg.dimensionX / 2;
      const cy = seg.coordinateY + seg.dimensionY / 2;
      const cz = seg.coordinateZ + seg.dimensionZ / 2;
      const bay = bays.find((b) =>
        cx >= b.coordinateX && cx <= b.coordinateX + b.dimensionX &&
        cy >= b.coordinateY && cy <= b.coordinateY + b.dimensionY &&
        cz >= b.coordinateZ && cz <= b.coordinateZ + b.dimensionZ,
      );
      if (!bay) continue;
      out.expandByPoint(new THREE.Vector3(bay.coordinateX, bay.coordinateZ, bay.coordinateY));
      out.expandByPoint(new THREE.Vector3(
        bay.coordinateX + bay.dimensionX,
        bay.coordinateZ + bay.dimensionZ,
        bay.coordinateY + bay.dimensionY,
      ));
    }
    return out;
  }

  // In-flight camera animation toward a find result. Stepped each frame in
  // animate(); cancelled when the user grabs the controls or enters walk mode.
  // bow > 0 arcs the flight up and over the racks instead of cutting through.
  let camTween: {
    fromPos: THREE.Vector3; fromTarget: THREE.Vector3;
    toPos: THREE.Vector3; toTarget: THREE.Vector3;
    start: number; duration: number; bow: number;
  } | null = null;

  const easeInOutCubic = (t: number) =>
    t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2;

  function stepCamTween() {
    if (!camTween) return;
    const t = Math.min((performance.now() - camTween.start) / camTween.duration, 1);
    const e = easeInOutCubic(t);
    perspectiveCamera.position.lerpVectors(camTween.fromPos, camTween.toPos, e);
    perspectiveCamera.position.y += camTween.bow * Math.sin(Math.PI * e);
    controls.target.lerpVectors(camTween.fromTarget, camTween.toTarget, e);
    if (t >= 1) camTween = null;
  }

  // Straight flight path blocked by a rack? The SPACE instances fill every
  // rack volume, so one ray along the path is a cheap obstruction test
  // (raycast ignores visibility, so this works with the SPACE tier toggled off).
  function flightIsBlocked(from: THREE.Vector3, to: THREE.Vector3): boolean {
    const spaceInst = tierInstancedMeshes.get('SPACE');
    if (!spaceInst) return false;
    const dir = to.clone().sub(from);
    const len = dir.length();
    if (len < 1) return false;
    dir.normalize();
    raycaster.set(from, dir);
    raycaster.far = len;
    const blocked = raycaster.intersectObject(spaceInst, false).length > 0;
    raycaster.far = Infinity;
    return blocked;
  }

  function frameBox(box: THREE.Box3) {
    const center = box.getCenter(new THREE.Vector3());
    const size = box.getSize(new THREE.Vector3());
    const maxDim = Math.max(size.x, size.y, size.z, 1);
    const fov = (perspectiveCamera.fov * Math.PI) / 180;
    let dist = (maxDim / 2) / Math.tan(fov / 2) * 2.5; // 2.5 = padding
    dist = Math.max(orbit.minDistance * 1.1, FIND_MIN_DIST, Math.min(orbit.maxDistance * 0.9, dist));

    const dir = new THREE.Vector3().subVectors(perspectiveCamera.position, controls.target);
    if (dir.lengthSq() < 1e-6) dir.set(0.6, 0.5, 0.8);
    dir.normalize();

    const fromPos = perspectiveCamera.position.clone();
    const toPos = center.clone().addScaledVector(dir, dist);

    // If a rack sits between here and there, bow the path so the flight
    // crests just above the tallest rack instead of clipping through.
    let bow = 0;
    if (flightIsBlocked(fromPos, toPos)) {
      bow = Math.max(0, rackTopY + 3000 - (fromPos.y + toPos.y) / 2);
    }

    camTween = {
      fromPos,
      fromTarget: controls.target.clone(),
      toPos,
      toTarget: center.clone(),
      start: performance.now(),
      duration: bow > 0 ? 1200 : 850, // the over-the-top arc gets a bit more air time
      bow,
    };
  }

  function findLocation(query?: string) {
    if (query !== undefined) findQuery = query;
    suggestionsOpen = false;
    activeSuggestion = -1;
    clearFind();
    const q = findQuery.trim().toUpperCase();
    if (!q) { findStatus = ''; return; }
    if (mode === 'walk') exitWalk(); // searching is an overview action; pop out to orbit

    const exact = segments.filter((s) => s.fullName.toUpperCase() === q);
    const matches = exact.length ? exact : segments.filter((s) => s.fullName.toUpperCase().startsWith(q));

    if (matches.length === 0) { findStatus = `"${findQuery}" not found`; findStatusKind = 'err'; return; }

    findGroup = new THREE.Group();
    const box = new THREE.Box3();
    for (const seg of matches) {
      findGroup.add(makeFindBox(seg));
      box.expandByPoint(new THREE.Vector3(seg.coordinateX, seg.coordinateZ, seg.coordinateY));
      box.expandByPoint(new THREE.Vector3(
        seg.coordinateX + seg.dimensionX,
        seg.coordinateZ + seg.dimensionZ,
        seg.coordinateY + seg.dimensionY,
      ));
    }
    scene.add(findGroup);
    findMatchSegs = matches;
    findStatus = matches.length === 1 ? `Found ${matches[0].fullName}` : `Found ${matches.length} matches`;
    findStatusKind = 'ok';
    frameBox(widenToBayContext(matches, box));
  }

  function updateSuggestions() {
    findStatus = '';
    const q = findQuery.trim().toUpperCase();
    if (!q) {
      suggestions = []; suggestionsOpen = false; activeSuggestion = -1;
      return;
    }
    const out: Segment[] = [];
    for (const s of segments) {
      if (s.fullName.toUpperCase().startsWith(q)) {
        out.push(s);
        if (out.length >= 8) break;
      }
    }
    suggestions = out;
    suggestionsOpen = out.length > 0;
    activeSuggestion = -1;
  }

  function clearSearch() {
    findQuery = '';
    findStatus = '';
    suggestions = [];
    suggestionsOpen = false;
    activeSuggestion = -1;
    clearFind();
    findInputEl?.focus();
  }

  function onFindKeydown(e: KeyboardEvent) {
    if (e.key === 'ArrowDown' && suggestionsOpen) {
      e.preventDefault();
      activeSuggestion = (activeSuggestion + 1) % suggestions.length;
    } else if (e.key === 'ArrowUp' && suggestionsOpen) {
      e.preventDefault();
      activeSuggestion = (activeSuggestion - 1 + suggestions.length) % suggestions.length;
    } else if (e.key === 'Enter') {
      if (suggestionsOpen && activeSuggestion >= 0) findLocation(suggestions[activeSuggestion].fullName);
      else findLocation();
    } else if (e.key === 'Escape') {
      if (suggestionsOpen) { suggestionsOpen = false; activeSuggestion = -1; }
      else clearSearch();
    }
  }

  // "/" anywhere on the page jumps to the search box (ignored while typing in
  // a field). Esc closes the aisle picker first, then exits walk mode.
  function onWindowKeydown(e: KeyboardEvent) {
    const t = e.target as HTMLElement | null;
    if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA')) return;
    if (e.key === '/') {
      e.preventDefault();
      findInputEl?.focus();
    } else if (e.key === 'Escape') {
      if (aislePickerOpen) aislePickerOpen = false;
      else if (mode === 'walk') exitWalk();
    }
  }

  $: qLen = findQuery.trim().length;

  function clearHighlight() {
    if (highlightGroup) {
      scene.remove(highlightGroup);
      highlightGroup.traverse((obj) => {
        if (obj instanceof THREE.Mesh || obj instanceof THREE.LineSegments) {
          obj.geometry.dispose();
          const mt = obj.material as THREE.Material | THREE.Material[];
          if (Array.isArray(mt)) mt.forEach((m) => m.dispose());
          else mt.dispose();
        }
      });
      highlightGroup = null;
    }
    highlightedId = null;
    hoverInfo = null;
  }

  function applyHighlight(instanceId: number) {
    if (instanceId === highlightedId) return;
    clearHighlight();
    const seg = spaceSegments[instanceId];
    if (!seg) return;
    highlightedId = instanceId;
    highlightGroup = makeHighlightGroup(seg, isInsideFind(seg));
    scene.add(highlightGroup);
    hoverInfo = {
      fullName: seg.fullName,
      type: seg.type,
      coords: [seg.coordinateX, seg.coordinateY, seg.coordinateZ],
      dims:   [seg.dimensionX, seg.dimensionY, seg.dimensionZ],
    };
  }

  function onPointerMove(event: PointerEvent) {
    const rect = canvas.getBoundingClientRect();
    pointer.x = ((event.clientX - rect.left) / rect.width) * 2 - 1;
    pointer.y = -((event.clientY - rect.top) / rect.height) * 2 + 1;
    tooltipX = event.clientX - rect.left;
    tooltipY = event.clientY - rect.top;

    const spaceInst = tierInstancedMeshes.get('SPACE');
    if (!spaceInst) {
      clearHighlight();
      return;
    }
    raycaster.setFromCamera(pointer, perspectiveCamera);
    const hits = raycaster.intersectObject(spaceInst, false);
    if (hits.length > 0 && hits[0].instanceId !== undefined) {
      applyHighlight(hits[0].instanceId);
    } else {
      clearHighlight();
    }
  }

  function onPointerLeave() {
    clearHighlight();
  }

  // Re-raycast each frame while walking: the camera moves without pointer
  // events, so hover has to track what slides under the (stationary) cursor.
  // Hover works regardless of the SPACE overlay toggle (raycast ignores visibility).
  function updateHover() {
    const spaceInst = tierInstancedMeshes.get('SPACE');
    if (!spaceInst) { clearHighlight(); return; }
    raycaster.setFromCamera(pointer, perspectiveCamera);
    const hits = raycaster.intersectObject(spaceInst, false);
    if (hits.length > 0 && hits[0].instanceId !== undefined) applyHighlight(hits[0].instanceId);
    else clearHighlight();
  }

  // depthWrite stays false for every tier in both modes: writing depth from a
  // semi-transparent tier (the source repo set it for LEVEL at walk opacity)
  // makes the hover box fail depth tests against level faces and glitch.
  // TIER_ORDER + the hover's renderOrder already guarantee correct stacking.
  // The realistic rack/environment meshes are intentionally excluded: they
  // stay opaque in walk mode (the rail keeps the camera in the clear aisle).
  function setRackOpacity(on: boolean) {
    for (const [type, inst] of tierInstancedMeshes) {
      const m = inst.material as THREE.MeshStandardMaterial;
      m.opacity = on ? WALK_OPACITY[type] : OPACITY_MAP[type];
      m.needsUpdate = true;
    }
    containerGroups.get('AISLE')?.traverse((o) => {
      if (o instanceof THREE.Mesh) {
        const m = o.material as THREE.MeshStandardMaterial;
        if (m.transparent) { m.opacity = on ? WALK_OPACITY.AISLE : OPACITY_MAP.AISLE; m.needsUpdate = true; }
      }
    });
  }

  // aisleIdx picks the aisle to drop into; omitted = nearest to the camera.
  function enterWalk(aisleIdx?: number) {
    aislePickerOpen = false;
    camTween = null;
    mode = 'walk';
    controls.enabled = false;
    clearHighlight();
    setRackOpacity(true);
    perspectiveCamera.fov = walk.fov;            // wider = more zoomed out
    perspectiveCamera.updateProjectionMatrix();
    rail.enable();
    if (aisleIdx !== undefined) rail.setAisle(aisleIdx);
  }

  // Glide the camera back to its home position/target. In walk mode this is
  // what Exit already does (instantly), so just delegate.
  function resetView() {
    aislePickerOpen = false;
    if (mode === 'walk') { exitWalk(); return; }
    const fromPos = perspectiveCamera.position.clone();
    const toPos = new THREE.Vector3(...camera.position);
    let bow = 0;
    if (flightIsBlocked(fromPos, toPos)) {
      bow = Math.max(0, rackTopY + 3000 - (fromPos.y + toPos.y) / 2);
    }
    camTween = {
      fromPos,
      fromTarget: controls.target.clone(),
      toPos,
      toTarget: new THREE.Vector3(...orbit.target),
      start: performance.now(),
      duration: bow > 0 ? 1200 : 850,
      bow,
    };
  }

  function exitWalk() {
    aislePickerOpen = false;
    mode = 'orbit';
    rail.disable();
    setRackOpacity(false);
    controls.enabled = true;
    perspectiveCamera.fov = camera.fov ?? 50;    // restore orbit FOV
    perspectiveCamera.updateProjectionMatrix();
    perspectiveCamera.position.set(...camera.position);
    controls.target.set(...orbit.target);
    controls.update();
  }

  function onResize() {
    if (!container) return;
    perspectiveCamera.aspect = container.clientWidth / container.clientHeight;
    perspectiveCamera.updateProjectionMatrix();
    renderer.setSize(container.clientWidth, container.clientHeight);
  }

  function applyVisibility() {
    for (const [type, group] of containerGroups) {
      group.visible = visibleTypes.has(type);
    }
    for (const [type, inst] of tierInstancedMeshes) {
      inst.visible = visibleTypes.has(type);
    }
    for (const [type, edges] of tierEdgeMeshes) {
      edges.visible = visibleTypes.has(type);
    }
  }

  $: if (scene && visibleTypes) applyVisibility();

  function setupScene() {
    scene = new THREE.Scene();
    scene.background = new THREE.Color(0xdde3ea);
    scene.fog = new THREE.Fog(0xdde3ea, 250000, 780000);

    perspectiveCamera = new THREE.PerspectiveCamera(
      camera.fov ?? 50,
      container.clientWidth / container.clientHeight,
      camera.near ?? 100,
      camera.far ?? 800000,
    );
    perspectiveCamera.position.set(...camera.position);

    renderer = new THREE.WebGLRenderer({ canvas, antialias: true });
    renderer.setPixelRatio(window.devicePixelRatio);
    renderer.setSize(container.clientWidth, container.clientHeight);
    renderer.toneMapping = THREE.ACESFilmicToneMapping;
    renderer.toneMappingExposure = 1.2;
    if (import.meta.env.DEV) {
      (window as any).__renderer = renderer;
      (window as any).__camera = () => perspectiveCamera;
      (window as any).__controls = () => controls;
      (window as any).__renderFrame = () => {
        if (mode === 'walk') rail.update(1 / 60);
        else controls.update();
        renderer.render(scene, perspectiveCamera);
      };
    }

    controls = new OrbitControls(perspectiveCamera, canvas);
    controls.target.set(...orbit.target);
    controls.minDistance = orbit.minDistance;
    controls.maxDistance = orbit.maxDistance;
    // Unrestricted rotation; the floor-Y clamp in the animate loop keeps the
    // camera position itself from dipping below the floor, while still
    // allowing low/zoomed-in viewing angles.
    controls.maxPolarAngle = Math.PI;
    controls.enableDamping = true;
    controls.dampingFactor = 0.1;
    controls.update();
    // Grabbing the scene mid-flight hands control straight back to the user.
    controls.addEventListener('start', () => { camTween = null; });

    clock = new THREE.Clock();
    rail = new RailControls(perspectiveCamera, canvas, segments, walk);
    rail.onChange = (info) => { aisleIndex = info.index; aisleLabel = info.name; aisleTotal = info.total; };

    // High-bay rig: bright even hemisphere base, warm key from above, a front
    // fill aimed at the rack faces the default vantage looks at, and a faint
    // cool back fill so the shaded sides keep some shape.
    scene.add(new THREE.HemisphereLight(0xffffff, 0xa7adb3, 1.0));
    const keyLight = new THREE.DirectionalLight(0xfff3e2, 0.85);
    keyLight.position.set(30000, 60000, 20000);
    scene.add(keyLight);
    const frontFill = new THREE.DirectionalLight(0xffffff, 0.5);
    frontFill.position.set(-60000, 30000, 25000);
    scene.add(frontFill);
    const backFill = new THREE.DirectionalLight(0xdde7f5, 0.25);
    backFill.position.set(40000, 45000, -30000);
    scene.add(backFill);

    gridMesh = makeShaderGrid();
    scene.add(gridMesh);

    raycaster = new THREE.Raycaster();
    pointer = new THREE.Vector2();

    populateSegments();
    applyVisibility();

    window.addEventListener('resize', onResize);
    window.addEventListener('keydown', onWindowKeydown);
    canvas.addEventListener('pointermove', onPointerMove);
    canvas.addEventListener('pointerleave', onPointerLeave);
    animate();
  }

  function populateSegments() {
    const buckets = new Map<SegmentType, Segment[]>();
    for (const seg of segments) {
      const list = buckets.get(seg.type) ?? [];
      list.push(seg);
      buckets.set(seg.type, list);
    }

    // AISLE stays as plain meshes (only 18 of them; cheap, and may want per-aisle labels later)
    const aisleList = buckets.get('AISLE') ?? [];
    if (aisleList.length > 0) {
      const group = new THREE.Group();
      group.name = 'AISLE';
      for (const seg of aisleList) group.add(makeContainerMesh(seg));
      containerGroups.set('AISLE', group);
      scene.add(group);
    }

    // BAY, LEVEL, SPACE all use InstancedMesh for huge draw-call savings.
    // BAY/LEVEL also get a single LineSegments edge pass to preserve outline look.
    for (const type of ['BAY', 'LEVEL', 'SPACE'] as const) {
      const list = buckets.get(type) ?? [];
      if (list.length === 0) continue;

      const inst = buildTierInstancedMesh(list, type);
      inst.name = type;
      inst.renderOrder = TIER_ORDER[type];
      tierInstancedMeshes.set(type, inst);
      scene.add(inst);

      if (type !== 'SPACE') {
        const edges = buildTierEdgeMesh(list, type);
        edges.name = `${type}_EDGES`;
        tierEdgeMeshes.set(type, edges);
        scene.add(edges);
      }
    }

    spaceSegments = buckets.get('SPACE') ?? [];
    for (const s of segments) rackTopY = Math.max(rackTopY, s.coordinateZ + s.dimensionZ);

    // Realistic warehouse layer: upright frames, beams, signs, floor, shell.
    // Always visible and opaque; the tier boxes above act as optional overlays.
    const rows = groupBaysIntoRows(segments);
    const racks = buildRacks(segments, rows);
    const signs = buildAisleSigns(segments, rows);
    racks.group.add(signs.group);
    scene.add(racks.group);
    const env = buildEnvironment(segments, rows);
    scene.add(env.group);
    shellBounds = env.shell;
    // const loads = buildPallets(spaceSegments);
    // scene.add(loads.group);
    const nets = buildSafetyNets(rows);
    scene.add(nets.group);
    realisticDisposers = [racks.dispose, signs.dispose, env.dispose, nets.dispose];
  }

  function animate() {
    rafId = requestAnimationFrame(animate);
    const dt = clock ? clock.getDelta() : 0;
    if (mode === 'orbit') {
      stepCamTween();
      controls.update();
      // Hard cage: keep the camera above the floor and inside the building
      // shell regardless of rotation or zoom direction.
      const p = perspectiveCamera.position;
      if (p.y < floorY) p.y = floorY;
      if (shellBounds) {
        const PAD = 1500;
        p.x = Math.min(Math.max(p.x, shellBounds.minX + PAD), shellBounds.maxX - PAD);
        p.y = Math.min(p.y, shellBounds.eaveH - 800);
        p.z = Math.min(Math.max(p.z, shellBounds.minZ + PAD), shellBounds.maxZ - PAD);
      }
    } else {
      rail.update(dt);
      updateHover();
    }
    if (gridMesh) {
      const u = (gridMesh.material as THREE.ShaderMaterial).uniforms.uCameraPos.value as THREE.Vector3;
      u.copy(perspectiveCamera.position);
    }
    renderer.render(scene, perspectiveCamera);
  }

  onMount(() => {
    setupScene();
  });

  onDestroy(() => {
    cancelAnimationFrame(rafId);
    window.removeEventListener('resize', onResize);
    window.removeEventListener('keydown', onWindowKeydown);
    if (rail) rail.dispose();
    if (canvas) {
      canvas.removeEventListener('pointermove', onPointerMove);
      canvas.removeEventListener('pointerleave', onPointerLeave);
    }
    for (const dispose of realisticDisposers) dispose();
    if (renderer) renderer.dispose();
  });
</script>

<div class="scene-container" bind:this={container}>
  <canvas bind:this={canvas} on:pointerdown={() => (aislePickerOpen = false)}></canvas>
  {#if hoverInfo}
    <div class="tooltip" style="left: {tooltipX + 14}px; top: {tooltipY + 14}px;">
      <strong>{hoverInfo.fullName}</strong> ({hoverInfo.type})
      <br />
      coord: ({hoverInfo.coords[0]}, {hoverInfo.coords[1]}, {hoverInfo.coords[2]})
      <br />
      dim:&nbsp;&nbsp; ({hoverInfo.dims[0]} × {hoverInfo.dims[1]} × {hoverInfo.dims[2]})
    </div>
  {/if}
  <div class="find-ui">
    <div class="find-bar">
      <svg class="find-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round">
        <circle cx="11" cy="11" r="7" />
        <line x1="16.5" y1="16.5" x2="21" y2="21" />
      </svg>
      <input
        class="find-input" type="text" placeholder="Search location… e.g. N11G03 or A25"
        bind:this={findInputEl}
        bind:value={findQuery}
        on:input={updateSuggestions}
        on:keydown={onFindKeydown}
        on:focus={() => { if (suggestions.length) suggestionsOpen = true; }}
        on:blur={() => setTimeout(() => { suggestionsOpen = false; }, 120)}
        spellcheck="false" autocomplete="off"
      />
      {#if findQuery}
        <button class="find-clear" on:click={clearSearch} title="Clear search">✕</button>
      {:else}
        <kbd class="find-kbd">/</kbd>
      {/if}
      <button class="find-btn" on:click={() => findLocation()}>Find</button>
    </div>

    {#if suggestionsOpen}
      <ul class="find-suggestions">
        {#each suggestions as s, i}
          <li>
            <button
              class="suggestion" class:active={i === activeSuggestion}
              on:mousedown|preventDefault={() => findLocation(s.fullName)}
              on:mouseenter={() => (activeSuggestion = i)}
            >
              <span class="s-name"><strong>{s.fullName.slice(0, qLen)}</strong>{s.fullName.slice(qLen)}</span>
              <span class="s-type" style="--t: {TYPE_HEX[s.type]}">{s.type}</span>
            </button>
          </li>
        {/each}
      </ul>
    {/if}

    {#if findStatus}
      <div class="find-status" class:err={findStatusKind === 'err'}>
        {findStatus}
      </div>
    {/if}
  </div>
  <div class="nav-ui">
    {#if mode === 'orbit'}
      <div class="nav-row">
      <button class="nav-btn home-btn" on:click={resetView} title="Reset view">
        <svg class="home-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
          <path d="M3 10.5 L12 3 L21 10.5" />
          <path d="M5.5 9.2 V20 H18.5 V9.2" />
        </svg>
      </button>
      <button class="nav-btn walk-toggle" class:open={aislePickerOpen} on:click={() => (aislePickerOpen = !aislePickerOpen)}>
        <svg class="walk-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
          <circle cx="13.5" cy="4.5" r="2" />
          <path d="M13 7.5 L12 13 L14.5 16 L15 20.5" />
          <path d="M12 13 L9.5 15.5 L8.5 20" />
          <path d="M12.8 9 L16.5 11.5" />
          <path d="M12.8 9 L9.8 10 L8.5 13" />
        </svg>
        Walk through the aisles
        <svg class="chev" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round"><path d="M6 9l6 6 6-6" /></svg>
      </button>
      </div>
    {:else}
      <div class="walk-bar">
        <button class="walk-exit" on:click={exitWalk} title="Exit walk mode">✕ Exit</button>
        <button class="walk-arrow" on:click={() => rail.prevAisle()} title="Previous aisle">‹</button>
        <button class="aisle-current" on:click={() => (aislePickerOpen = !aislePickerOpen)} title="Choose aisle">
          {aisleLabel} <span class="muted">{aisleIndex + 1}/{aisleTotal}</span>
          <svg class="chev" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round"><path d="M6 9l6 6 6-6" /></svg>
        </button>
        <button class="walk-arrow" on:click={() => rail.nextAisle()} title="Next aisle">›</button>
      </div>
    {/if}

    {#if aislePickerOpen && rail}
      <div class="aisle-picker">
        <div class="picker-title">{mode === 'orbit' ? 'Walk into…' : 'Jump to…'}</div>
        {#if mode === 'orbit'}
          <button class="aisle-item nearest" on:click={() => enterWalk()}>
            <span class="dot"></span>Nearest aisle
          </button>
        {/if}
        <ul>
          {#each rail.aisleNames as name, i}
            <li>
              <button
                class="aisle-item"
                class:current={mode === 'walk' && i === aisleIndex}
                on:click={() => { if (mode === 'orbit') enterWalk(i); else { rail.setAisle(i); aislePickerOpen = false; } }}
              >
                <span class="dot"></span>{name}
                {#if mode === 'walk' && i === aisleIndex}<span class="here">current</span>{/if}
              </button>
            </li>
          {/each}
        </ul>
      </div>
    {/if}
  </div>
  {#if mode === 'walk'}
    <div class="walk-hint">drag to look · W/S move · A/D turn · Q/E up·down · ←/→ aisle · scroll glide · Esc exit</div>
  {/if}
</div>

<style>
  .scene-container {
    position: relative;
    flex: 1;
    overflow: hidden;
    background: #dde3ea;
  }
  canvas {
    display: block;
    width: 100%;
    height: 100%;
  }
  .tooltip {
    position: absolute;
    background: rgba(0, 0, 0, 0.85);
    color: white;
    padding: 6px 10px;
    border-radius: 4px;
    font-size: 12px;
    white-space: nowrap;
    pointer-events: none;
    font-family: monospace;
    z-index: 10;
  }
  .find-ui {
    position: absolute; top: 14px; left: 50%; transform: translateX(-50%);
    z-index: 10; display: flex; flex-direction: column; align-items: center; gap: 8px;
    width: min(440px, calc(100% - 32px));
  }
  .find-bar {
    display: flex; align-items: center; gap: 9px; width: 100%;
    background: rgba(11, 18, 32, 0.88);
    backdrop-filter: blur(10px);
    -webkit-backdrop-filter: blur(10px);
    border: 1.5px solid #334155;
    border-radius: 999px;
    padding: 6px 6px 6px 15px;
    box-shadow: 0 4px 24px rgba(0, 0, 0, 0.45);
    transition: border-color 0.15s, box-shadow 0.15s;
  }
  .find-bar:focus-within {
    border-color: #3b82f6;
    box-shadow: 0 4px 28px rgba(59, 130, 246, 0.28);
  }
  .find-icon { width: 15px; height: 15px; color: #64748b; flex: none; transition: color 0.15s; }
  .find-bar:focus-within .find-icon { color: #3b82f6; }
  .find-input {
    flex: 1; min-width: 0; background: transparent; border: none; outline: none;
    color: #e2e8f0; font-size: 13px; font-family: monospace; letter-spacing: 0.3px;
  }
  .find-input::placeholder { color: #475569; }
  .find-clear {
    flex: none; width: 22px; height: 22px; border-radius: 50%;
    border: none; background: #1e293b; color: #94a3b8; cursor: pointer;
    font-size: 11px; line-height: 1; display: grid; place-items: center;
    transition: background 0.15s, color 0.15s;
  }
  .find-clear:hover { background: #334155; color: #e2e8f0; }
  .find-kbd {
    flex: none; color: #475569; border: 1px solid #334155; border-radius: 4px;
    font-size: 10px; font-family: monospace; padding: 1px 6px;
  }
  .find-btn {
    flex: none; background: #2563eb; border: none; color: #fff;
    padding: 6px 18px; border-radius: 999px; cursor: pointer;
    font-size: 12px; font-weight: 600; letter-spacing: 0.3px;
    transition: background 0.15s;
  }
  .find-btn:hover { background: #3b82f6; }
  .find-btn:active { background: #1d4ed8; }
  .find-suggestions {
    width: 100%; margin: 0; padding: 6px; list-style: none;
    background: rgba(11, 18, 32, 0.95);
    backdrop-filter: blur(10px);
    -webkit-backdrop-filter: blur(10px);
    border: 1px solid #334155; border-radius: 14px;
    box-shadow: 0 12px 32px rgba(0, 0, 0, 0.5);
    max-height: 280px; overflow-y: auto;
  }
  .find-suggestions li { margin: 0; padding: 0; }
  .suggestion {
    width: 100%; display: flex; justify-content: space-between; align-items: center; gap: 12px;
    background: transparent; border: none; cursor: pointer;
    padding: 8px 11px; border-radius: 9px; color: #cbd5e1;
    font-family: monospace; font-size: 12px; text-align: left;
    transition: background 0.1s;
  }
  .suggestion.active { background: rgba(59, 130, 246, 0.16); color: #e2e8f0; }
  .s-name strong { color: #60a5fa; font-weight: 700; }
  .s-type {
    flex: none; font-size: 9px; padding: 2px 8px; border-radius: 999px;
    border: 1px solid var(--t); color: var(--t); letter-spacing: 0.6px;
  }
  .find-status {
    font-size: 11px; font-family: monospace; white-space: nowrap;
    padding: 4px 13px; border-radius: 999px;
    background: rgba(34, 197, 94, 0.12); color: #4ade80;
    border: 1px solid rgba(34, 197, 94, 0.35);
  }
  .find-status.err {
    background: rgba(239, 68, 68, 0.12); color: #f87171;
    border-color: rgba(239, 68, 68, 0.35);
  }
  .nav-ui {
    position: absolute; top: 14px; right: 14px; z-index: 10;
    display: flex; flex-direction: column; align-items: flex-end; gap: 8px;
  }
  .nav-btn {
    background: rgba(11, 18, 32, 0.88);
    backdrop-filter: blur(10px);
    -webkit-backdrop-filter: blur(10px);
    border: 1.5px solid #334155; color: #e2e8f0;
    padding: 6px 14px; border-radius: 999px; cursor: pointer;
    font-size: 12px; font-family: monospace; transition: border-color 0.15s;
  }
  .nav-btn:hover { border-color: #3b82f6; }
  .nav-row { display: flex; align-items: stretch; gap: 8px; }
  .home-btn {
    display: inline-flex; align-items: center; padding: 9px 12px;
    box-shadow: 0 4px 24px rgba(0, 0, 0, 0.45);
  }
  .home-btn:hover { background: rgba(30, 41, 59, 0.88); }
  .home-icon { width: 16px; height: 16px; color: #94a3b8; }
  .home-btn:hover .home-icon { color: #e2e8f0; }
  .walk-toggle {
    display: inline-flex; align-items: center; gap: 9px;
    padding: 9px 18px; font-size: 13px;
    box-shadow: 0 4px 24px rgba(0, 0, 0, 0.45);
  }
  .walk-toggle:hover { background: rgba(30, 41, 59, 0.88); }
  .walk-toggle.open { border-color: #3b82f6; }
  .walk-icon { width: 17px; height: 17px; color: #60a5fa; flex: none; }
  .chev { width: 13px; height: 13px; color: #64748b; flex: none; transition: transform 0.15s; }
  .walk-toggle.open .chev { transform: rotate(180deg); }
  .walk-bar {
    display: flex; align-items: center; gap: 5px;
    background: rgba(11, 18, 32, 0.88);
    backdrop-filter: blur(10px);
    -webkit-backdrop-filter: blur(10px);
    border: 1.5px solid #334155; border-radius: 999px;
    padding: 5px;
    box-shadow: 0 4px 24px rgba(0, 0, 0, 0.45);
  }
  .walk-exit {
    background: rgba(239, 68, 68, 0.12); border: 1px solid rgba(239, 68, 68, 0.35);
    color: #f87171; padding: 6px 14px; border-radius: 999px; cursor: pointer;
    font-size: 12px; font-family: monospace; transition: background 0.15s;
  }
  .walk-exit:hover { background: rgba(239, 68, 68, 0.25); }
  .walk-arrow {
    background: transparent; border: none; color: #94a3b8; cursor: pointer;
    width: 28px; height: 28px; border-radius: 50%; font-size: 17px; line-height: 1;
    display: grid; place-items: center; transition: background 0.15s, color 0.15s;
  }
  .walk-arrow:hover { background: #1e293b; color: #e2e8f0; }
  .aisle-current {
    background: transparent; border: none; color: #e2e8f0; cursor: pointer;
    display: inline-flex; align-items: center; gap: 7px;
    font-size: 13px; font-family: monospace; padding: 5px 8px; border-radius: 999px;
    transition: background 0.15s;
  }
  .aisle-current:hover { background: #1e293b; }
  .muted { opacity: 0.55; }
  .aisle-picker {
    width: 210px; padding: 6px;
    background: rgba(11, 18, 32, 0.95);
    backdrop-filter: blur(10px);
    -webkit-backdrop-filter: blur(10px);
    border: 1px solid #334155; border-radius: 14px;
    box-shadow: 0 12px 32px rgba(0, 0, 0, 0.5);
    max-height: 320px; overflow-y: auto;
  }
  .picker-title {
    font-size: 9px; font-family: monospace; letter-spacing: 1.2px; text-transform: uppercase;
    color: #64748b; padding: 5px 11px 7px;
  }
  .aisle-picker ul { margin: 0; padding: 0; list-style: none; }
  .aisle-picker li { margin: 0; padding: 0; }
  .aisle-item {
    width: 100%; display: flex; align-items: center; gap: 9px;
    background: transparent; border: none; cursor: pointer;
    padding: 7px 11px; border-radius: 8px; color: #cbd5e1;
    font-family: monospace; font-size: 12px; text-align: left;
    transition: background 0.1s;
  }
  .aisle-item:hover { background: rgba(59, 130, 246, 0.16); color: #e2e8f0; }
  .aisle-item.current { color: #60a5fa; }
  .aisle-item .dot {
    width: 7px; height: 7px; border-radius: 50%; flex: none;
    background: #3b82f6; opacity: 0.8;
  }
  .aisle-item.nearest { color: #94a3b8; font-style: italic; margin-bottom: 4px; border-bottom: 1px solid #1e293b; border-radius: 8px 8px 0 0; }
  .aisle-item.nearest .dot { background: #64748b; }
  .here {
    margin-left: auto; flex: none; font-size: 9px; font-style: normal;
    color: #60a5fa; border: 1px solid currentColor; border-radius: 999px; padding: 1px 7px;
  }
  /* Themed scrollbars for the dropdown panels (default white track clashes
     with the dark UI). */
  .aisle-picker,
  .find-suggestions {
    scrollbar-width: thin;                      /* Firefox */
    scrollbar-color: #334155 transparent;
  }
  .aisle-picker::-webkit-scrollbar,
  .find-suggestions::-webkit-scrollbar { width: 8px; }
  .aisle-picker::-webkit-scrollbar-track,
  .find-suggestions::-webkit-scrollbar-track { background: transparent; }
  .aisle-picker::-webkit-scrollbar-button,
  .find-suggestions::-webkit-scrollbar-button { display: none; height: 0; }
  .aisle-picker::-webkit-scrollbar-thumb,
  .find-suggestions::-webkit-scrollbar-thumb {
    background: #334155; border-radius: 999px;
    border: 2px solid transparent; background-clip: padding-box;
  }
  .aisle-picker::-webkit-scrollbar-thumb:hover,
  .find-suggestions::-webkit-scrollbar-thumb:hover {
    background: #475569; background-clip: padding-box; border: 2px solid transparent;
  }
  .walk-hint {
    position: absolute; bottom: 16px; left: 50%; transform: translateX(-50%);
    z-index: 10; background: rgba(0, 0, 0, 0.75); color: #e2e8f0;
    backdrop-filter: blur(6px);
    -webkit-backdrop-filter: blur(6px);
    border: 1px solid rgba(148, 163, 184, 0.25);
    padding: 9px 18px; border-radius: 999px; font-size: 14px;
    font-family: monospace; pointer-events: none; white-space: nowrap;
    box-shadow: 0 4px 16px rgba(0, 0, 0, 0.4);
  }
</style>
