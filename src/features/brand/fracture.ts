import { Delaunay } from "d3-delaunay";
import { gsap } from "gsap";
import * as THREE from "three";

// Higani « Fracture écarlate » (brand direction V2.2, after the founder's
// reference): the whole page, as an image, cut into real shards. Held, it
// cracks from a point and can heal; released, it tears, rings, flashes,
// and its shards fly away in depth, turning and slowing, uncovering what
// is behind. WebGL (three), timed with GSAP; loaded only when needed.

export type FractureSettings = {
  /** How many shards (the founder's choice: 60). */
  count: number;
  /** How hard the shards fly (1.5). */
  force: number;
  /** Time scale of the burst (0.35: slow, cinematic). */
  speed: number;
};

export const FRACTURE_SETTINGS: FractureSettings = {
  count: 60,
  force: 1.5,
  speed: 0.35,
};

type Shard = {
  group: THREE.Group;
  face: THREE.ShaderMaterial;
  glow: THREE.MeshBasicMaterial;
  edge: THREE.MeshBasicMaterial;
  home: THREE.Vector2;
  t: number;
  dir: THREE.Vector2;
  tilt: number;
  lift: number;
  jitter: number;
  v: THREE.Vector3;
  spin: THREE.Vector3;
  alive: boolean;
};

const FACE_VERTEX = `varying vec2 vUv; void main(){ vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }`;
const FACE_FRAGMENT = `
  uniform sampler2D uMap; uniform float uRed; uniform float uFlash; uniform float uDark; varying vec2 vUv;
  void main(){
    vec3 c = texture2D(uMap, vUv).rgb;
    float l = dot(c, vec3(.299,.587,.114));
    vec3 red = vec3(l * 1.4 + .18, l * .25, l * .3 + .04);
    c = mix(c, red, uRed);
    c += uFlash * vec3(1., .82, .86);
    gl_FragColor = vec4(c * (1. - uDark), 1.);
  }`;

function seeded(seed: number) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function canvasTexture(
  draw: (g: CanvasRenderingContext2D, size: number) => void,
  size = 512,
) {
  const canvas = document.createElement("canvas");
  canvas.width = canvas.height = size;
  draw(canvas.getContext("2d")!, size);
  const texture = new THREE.CanvasTexture(canvas);
  texture.colorSpace = THREE.SRGBColorSpace;
  return texture;
}

export class Fracture {
  private renderer: THREE.WebGLRenderer;
  private scene = new THREE.Scene();
  private camera = new THREE.PerspectiveCamera(40, 1, 1, 10000);
  private texture: THREE.Texture;
  private shards: Shard[] = [];
  private fx: Record<string, THREE.Mesh> = {};
  private state = { crack: 0 };
  private W: number;
  private H: number;
  private D = 0;
  private flying = false;
  private shake = { t: 0, a: 0 };
  private frame = 0;
  private last = performance.now();
  private timeline: gsap.core.Timeline | null = null;
  private exploding = false;

  constructor(
    canvas: HTMLCanvasElement,
    page: HTMLCanvasElement,
    private impact: { x: number; y: number },
    private settings: FractureSettings = FRACTURE_SETTINGS,
  ) {
    this.W = innerWidth;
    this.H = innerHeight;
    this.renderer = new THREE.WebGLRenderer({
      canvas,
      antialias: true,
      alpha: true,
    });
    this.renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
    this.renderer.outputColorSpace = THREE.SRGBColorSpace;
    this.renderer.setSize(this.W, this.H, false);
    this.camera.aspect = this.W / this.H;
    this.D =
      this.H / 2 / Math.tan(THREE.MathUtils.degToRad(this.camera.fov / 2));
    this.camera.position.set(0, 0, this.D);
    this.camera.updateProjectionMatrix();
    this.texture = new THREE.CanvasTexture(page);
    this.texture.colorSpace = THREE.SRGBColorSpace;
    this.build();
    this.apply();
    // Ready ahead: shaders compiled and shards sent to the GPU now, so the
    // first crack does not wait for them. It only draws while it moves.
    this.renderer.compile(this.scene, this.camera);
    this.renderer.render(this.scene, this.camera);
  }

  /** The page as it is now, on the shards. */
  setPage(page: HTMLCanvasElement) {
    this.texture.image = page;
    this.texture.needsUpdate = true;
  }

  start() {
    if (this.frame) return;
    this.last = performance.now();
    this.frame = requestAnimationFrame(this.loop);
  }

  stop() {
    cancelAnimationFrame(this.frame);
    this.frame = 0;
  }

  private toWorld(x: number, y: number) {
    return new THREE.Vector2(x - this.W / 2, this.H / 2 - y);
  }

  private polygon(
    points: [number, number][],
    center: { x: number; y: number },
    material: THREE.Material,
    scale = 1,
  ) {
    const shape = new THREE.Shape(
      points.map(([x, y]) => {
        const px = center.x + (x - center.x) * scale;
        const py = center.y + (y - center.y) * scale;
        return this.toWorld(px, py).sub(this.toWorld(center.x, center.y));
      }),
    );
    const geometry = new THREE.ShapeGeometry(shape);
    const position = geometry.attributes.position!;
    const uv: number[] = [];
    for (let i = 0; i < position.count; i++) {
      const sx = center.x + position.getX(i);
      const sy = center.y - position.getY(i);
      uv.push(sx / this.W, 1 - sy / this.H);
    }
    geometry.setAttribute("uv", new THREE.Float32BufferAttribute(uv, 2));
    return new THREE.Mesh(geometry, material);
  }

  private build() {
    const { W, H, impact } = this;
    const maxDist = Math.max(
      ...[
        [0, 0],
        [W, 0],
        [0, H],
        [W, H],
      ].map(([x, y]) => Math.hypot(x! - impact.x, y! - impact.y)),
    );
    const rnd = seeded(11);
    const points: [number, number][] = [];
    const rays = 30;
    for (let i = 0; i < this.settings.count; i++) {
      // Most points on a fan of rays: long splinters, like glass.
      const onRay = rnd() < 0.72;
      const a = onRay
        ? (Math.floor(rnd() * rays) / rays) * Math.PI * 2 + (rnd() - 0.5) * 0.07
        : rnd() * Math.PI * 2;
      const r = 6 + maxDist * Math.pow(rnd(), 1.9);
      points.push([impact.x + Math.cos(a) * r, impact.y + Math.sin(a) * r]);
    }
    for (let i = 0; i < 18; i++) points.push([rnd() * W, rnd() * H]);
    const voronoi = Delaunay.from(points).voronoi([-2, -2, W + 2, H + 2]);
    for (let i = 0; i < points.length; i++) {
      const cell = voronoi.cellPolygon(i);
      if (!cell || cell.length < 4) continue;
      const pts = cell.slice(0, -1) as [number, number][];
      const cx = pts.reduce((s, p) => s + p[0], 0) / pts.length;
      const cy = pts.reduce((s, p) => s + p[1], 0) / pts.length;
      const radius = Math.max(
        4,
        Math.sqrt(
          pts.reduce((s, p) => s + (p[0] - cx) ** 2 + (p[1] - cy) ** 2, 0) /
            pts.length,
        ),
      );
      const center = { x: cx, y: cy };
      const face = new THREE.ShaderMaterial({
        uniforms: {
          uMap: { value: this.texture },
          uRed: { value: 0 },
          uFlash: { value: 0 },
          uDark: { value: 0 },
        },
        vertexShader: FACE_VERTEX,
        fragmentShader: FACE_FRAGMENT,
        side: THREE.DoubleSide,
      });
      const additive = {
        transparent: true,
        opacity: 0,
        blending: THREE.AdditiveBlending,
        depthWrite: false,
        side: THREE.DoubleSide,
      } as const;
      const glow = new THREE.MeshBasicMaterial({
        color: 0xff2a50,
        ...additive,
      });
      const edge = new THREE.MeshBasicMaterial({
        color: 0xffffff,
        ...additive,
      });
      const group = new THREE.Group();
      const glowMesh = this.polygon(pts, center, glow, 1 + 7 / radius);
      glowMesh.position.z = -0.6;
      const edgeMesh = this.polygon(pts, center, edge, 1 + 1.6 / radius);
      edgeMesh.position.z = -0.3;
      group.add(glowMesh, edgeMesh, this.polygon(pts, center, face));
      const home = this.toWorld(cx, cy);
      group.position.set(home.x, home.y, 0);
      this.scene.add(group);
      const dx = cx - impact.x;
      const dy = cy - impact.y;
      const dist = Math.hypot(dx, dy) || 1;
      this.shards.push({
        group,
        face,
        glow,
        edge,
        home,
        t: dist / maxDist,
        dir: new THREE.Vector2(dx / dist, -dy / dist),
        tilt: (rnd() - 0.5) * 0.12,
        lift: (rnd() - 0.3) * 22,
        jitter: rnd(),
        v: new THREE.Vector3(),
        spin: new THREE.Vector3(),
        alive: true,
      });
    }
    this.buildLight(Math.max(W, H));
  }

  private sprite(texture: THREE.Texture, size: number) {
    const mesh = new THREE.Mesh(
      new THREE.PlaneGeometry(size, size),
      new THREE.MeshBasicMaterial({
        map: texture,
        transparent: true,
        opacity: 0,
        blending: THREE.AdditiveBlending,
        depthWrite: false,
      }),
    );
    const at = this.toWorld(this.impact.x, this.impact.y);
    mesh.position.set(at.x, at.y, 2);
    this.scene.add(mesh);
    return mesh;
  }

  private buildLight(big: number) {
    const glow = canvasTexture((g, s) => {
      const r = g.createRadialGradient(s / 2, s / 2, 0, s / 2, s / 2, s / 2);
      r.addColorStop(0, "rgba(255,255,255,1)");
      r.addColorStop(0.12, "rgba(255,90,120,.9)");
      r.addColorStop(0.45, "rgba(255,30,70,.35)");
      r.addColorStop(1, "rgba(255,0,40,0)");
      g.fillStyle = r;
      g.fillRect(0, 0, s, s);
    });
    const ring = canvasTexture((g, s) => {
      g.strokeStyle = "rgba(255,255,255,1)";
      g.lineWidth = s * 0.018;
      g.shadowColor = "rgba(255,49,89,1)";
      g.shadowBlur = s * 0.05;
      g.beginPath();
      g.arc(s / 2, s / 2, s * 0.42, 0, Math.PI * 2);
      g.stroke();
    });
    const rays = canvasTexture((g, s) => {
      g.translate(s / 2, s / 2);
      for (let i = 0; i < 44; i++) {
        g.rotate((Math.PI * 2) / 44 + (i % 3) * 0.01);
        const w = 2 + (i % 5);
        const l = g.createLinearGradient(0, 0, s / 2, 0);
        l.addColorStop(0, "rgba(255,255,255,.9)");
        l.addColorStop(0.5, "rgba(255,60,95,.6)");
        l.addColorStop(1, "rgba(255,0,40,0)");
        g.fillStyle = l;
        g.fillRect(s * 0.05, -w / 2, s / 2, w);
      }
    }, 1024);
    const rnd = seeded(5);
    const streaks = canvasTexture((g, s) => {
      g.translate(s / 2, s / 2);
      for (let i = 0; i < 120; i++) {
        g.rotate((Math.PI * 2) / 120 + rnd() * 0.02);
        const r0 = s * (0.12 + rnd() * 0.2);
        const len = s * (0.1 + rnd() * 0.3);
        const l = g.createLinearGradient(r0, 0, r0 + len, 0);
        l.addColorStop(0, "rgba(255,40,80,0)");
        l.addColorStop(0.6, "rgba(255,60,95,.85)");
        l.addColorStop(1, "rgba(255,255,255,.9)");
        g.fillStyle = l;
        g.fillRect(r0, -1, len, 2 + rnd() * 2);
      }
    }, 1024);
    const slash = canvasTexture((g, s) => {
      const l = g.createLinearGradient(0, 0, 0, s);
      l.addColorStop(0, "rgba(255,0,40,0)");
      l.addColorStop(0.42, "rgba(255,40,80,.85)");
      l.addColorStop(0.5, "rgba(255,255,255,1)");
      l.addColorStop(0.58, "rgba(255,40,80,.85)");
      l.addColorStop(1, "rgba(255,0,40,0)");
      g.fillStyle = l;
      g.fillRect(0, 0, s, s);
    }, 256);
    this.fx.glow = this.sprite(glow, big * 0.9);
    this.fx.ring = this.sprite(ring, big * 0.5);
    this.fx.rays = this.sprite(rays, big * 1.6);
    this.fx.streaks = this.sprite(streaks, big * 1.4);
    const tear = new THREE.Mesh(
      new THREE.PlaneGeometry(big * 2.4, 34),
      new THREE.MeshBasicMaterial({
        map: slash,
        transparent: true,
        opacity: 0,
        blending: THREE.AdditiveBlending,
        depthWrite: false,
      }),
    );
    const at = this.toWorld(this.impact.x, this.impact.y);
    tear.position.set(at.x, at.y, 3);
    tear.rotation.z = -0.32;
    tear.scale.x = 0;
    this.scene.add(tear);
    this.fx.slash = tear;
  }

  private material(name: string) {
    return this.fx[name]!.material as THREE.MeshBasicMaterial;
  }

  /** The cracks at `state.crack` (0: whole, 1: fractured, held). */
  private apply() {
    const p = this.state.crack;
    for (const s of this.shards) {
      const a = THREE.MathUtils.smoothstep(p * 1.12, s.t - 0.04, s.t + 0.06);
      const near = Math.pow(1 - s.t, 1.6);
      const gap = a * (1.5 + 14 * near);
      s.group.position.set(
        s.home.x + s.dir.x * gap,
        s.home.y + s.dir.y * gap,
        a * s.lift * near,
      );
      s.group.rotation.set(
        a * s.tilt * near * 2,
        -a * s.tilt * near * 2,
        a * s.tilt * near,
      );
      s.glow.opacity = a * (0.12 + 0.88 * Math.pow(near, 1.4));
      s.edge.opacity = a * (0.18 + 0.6 * near);
      s.face.uniforms.uRed!.value = a * (0.03 + 0.85 * Math.pow(near, 2.6));
    }
    this.material("glow").opacity = p * 0.75;
    this.fx.glow!.scale.setScalar(0.4 + p * 0.8);
  }

  /** Cracks (1) or heals (0) the page; resolves when done. */
  crack(target: number, duration = target ? 0.95 : 0.55) {
    if (this.exploding) return Promise.resolve();
    this.start();
    return new Promise<void>((resolve) => {
      gsap.to(this.state, {
        crack: target,
        duration,
        ease: target ? "power2.out" : "power2.inOut",
        overwrite: true,
        onUpdate: () => this.apply(),
        onComplete: resolve,
      });
    });
  }

  /**
   * The burst: tear, hit-stop, ring and rays, two inverted frames, the
   * shards flying in depth. `onReveal` when what is behind should show,
   * `onDone` when the shards are gone.
   */
  explode({
    invert,
    onReveal,
    onDone,
  }: {
    invert: HTMLElement;
    onReveal: () => void;
    onDone: () => void;
  }) {
    if (this.exploding) return;
    this.exploding = true;
    this.start();
    const { force: f } = this.settings;
    const tl = gsap.timeline({ onComplete: onDone });
    tl.timeScale(this.settings.speed);
    tl.to(this.state, {
      crack: 1,
      duration: 0.12,
      ease: "power3.out",
      onUpdate: () => this.apply(),
    });
    const slash = this.fx.slash!;
    tl.to(slash.scale, { x: 1, duration: 0.09, ease: "power4.out" }, 0.08);
    tl.to(this.material("slash"), { opacity: 1, duration: 0.03 }, 0.08);
    tl.to(this.material("slash"), { opacity: 0, duration: 0.35 }, 0.2);
    tl.to(this.material("ring"), { opacity: 1, duration: 0.04 }, 0.2);
    tl.fromTo(
      this.fx.ring!.scale,
      { x: 0.3, y: 0.3 },
      { x: 3.2, y: 3.2, duration: 0.55, ease: "power2.out" },
      0.2,
    );
    tl.to(this.material("ring"), { opacity: 0, duration: 0.45 }, 0.32);
    tl.to(this.material("rays"), { opacity: 1, duration: 0.05 }, 0.22);
    tl.to(this.fx.rays!.rotation, { z: 0.25, duration: 0.6 }, 0.22);
    tl.to(this.material("rays"), { opacity: 0, duration: 0.4 }, 0.34);
    tl.to(this.material("glow"), { opacity: 1, duration: 0.05 }, 0.2);
    tl.to(this.fx.glow!.scale, { x: 2.4, y: 2.4, duration: 0.5 }, 0.2);
    tl.to(this.material("glow"), { opacity: 0, duration: 0.5 }, 0.36);
    tl.set(invert, { opacity: 1 }, 0.3).set(invert, { opacity: 0 }, 0.36);
    tl.add(() => {
      for (const s of this.shards) {
        const near = 1.25 - s.t;
        const speed = (380 + 1400 * near * near) * f * (0.7 + s.jitter * 0.6);
        s.v.set(
          s.dir.x * speed,
          s.dir.y * speed + 120 * f,
          (250 + 1500 * near) * f * (0.6 + s.jitter * 0.8),
        );
        s.spin.set(
          (s.jitter - 0.5) * 9 * f,
          (0.5 - s.jitter) * 7 * f,
          (s.jitter - 0.5) * 6 * f,
        );
        s.face.uniforms.uFlash!.value = 0.45 * near;
      }
      this.flying = true;
      this.shake = { t: 0.45, a: 0.45 * f * 22 };
    }, 0.3);
    tl.to(this.material("streaks"), { opacity: 1, duration: 0.06 }, 0.32);
    tl.fromTo(
      this.fx.streaks!.scale,
      { x: 0.5, y: 0.5 },
      { x: 2.6, y: 2.6, duration: 0.8, ease: "power1.in" },
      0.32,
    );
    tl.to(this.material("streaks"), { opacity: 0, duration: 0.5 }, 0.62);
    tl.add(onReveal, 0.36);
    tl.to({}, { duration: 1.3 }, 0.36);
    this.timeline = tl;
  }

  private loop = (now: number) => {
    const scale = this.exploding ? this.settings.speed : 1;
    const dt = Math.min(0.05, (now - this.last) / 1000) * scale;
    this.last = now;
    if (this.flying) {
      const drag = Math.pow(0.35, dt);
      for (const s of this.shards) {
        if (!s.alive) continue;
        s.v.multiplyScalar(drag);
        s.v.y -= 900 * dt;
        s.group.position.addScaledVector(s.v, dt);
        s.group.rotation.x += s.spin.x * dt;
        s.group.rotation.y += s.spin.y * dt;
        s.group.rotation.z += s.spin.z * dt;
        const u = s.face.uniforms;
        u.uFlash!.value *= Math.pow(0.002, dt);
        u.uRed!.value = Math.min(0.75, u.uRed!.value + dt * 1.2);
        u.uDark!.value = Math.min(1, u.uDark!.value + dt * 0.55);
        s.glow.opacity = Math.max(0, s.glow.opacity - dt * 0.4);
        if (s.group.position.z > this.D - 40 || u.uDark!.value >= 1) {
          s.alive = false;
          s.group.visible = false;
        }
      }
    }
    if (this.shake.t > 0) {
      this.shake.t -= dt;
      const k = Math.max(0, this.shake.t / 0.45);
      this.camera.position.x = (Math.random() - 0.5) * this.shake.a * k;
      this.camera.position.y = (Math.random() - 0.5) * this.shake.a * k;
    } else {
      this.camera.position.x = this.camera.position.y = 0;
    }
    this.renderer.render(this.scene, this.camera);
    this.frame = requestAnimationFrame(this.loop);
  };

  dispose() {
    cancelAnimationFrame(this.frame);
    this.timeline?.kill();
    gsap.killTweensOf(this.state);
    this.scene.traverse((object) => {
      const mesh = object as THREE.Mesh;
      mesh.geometry?.dispose();
      const material = mesh.material as THREE.Material | undefined;
      material?.dispose();
    });
    this.texture.dispose();
    this.renderer.dispose();
  }
}
