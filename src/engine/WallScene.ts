import * as THREE from 'three';
import { EffectComposer } from 'three/examples/jsm/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/examples/jsm/postprocessing/RenderPass.js';
import { UnrealBloomPass } from 'three/examples/jsm/postprocessing/UnrealBloomPass.js';
import { ShaderPass } from 'three/examples/jsm/postprocessing/ShaderPass.js';
import { OutputPass } from 'three/examples/jsm/postprocessing/OutputPass.js';
import { conductor } from './conductor';
import { playback } from './playback';
import type { Palette } from './palettes';
import {
  worldVertex,
  wallFragment,
  hazeFragment,
  dustVertex,
  dustFragment,
  GradeShader,
  WaveShader,
  FrostShader,
} from './shaders';
import { Spectrum, BANDS, SWELL } from './spectrum';
import { RING_SLOTS } from './choreo';

export interface WallLook {
  intensity: number;
  projector: boolean;
  visual: 'wall' | 'wave';
  glass: number;
  shape: 'lattice' | 'rings' | 'hex';
  /** seconds each drifting zone takes to rise and fall */
  zone: number;
}

const BASE_Z = 10;
const FOV = 32;
const DUST = 650;

const clamp01 = (v: number) => Math.min(1, Math.max(0, v));
const easeInOut = (t: number) => 0.5 - 0.5 * Math.cos(Math.PI * clamp01(t));
/** frame-rate independent approach */
const approach = (cur: number, target: number, dt: number, tau: number) =>
  cur + (target - cur) * (1 - Math.exp(-dt / tau));

export class WallScene {
  private renderer: THREE.WebGLRenderer;
  private scene = new THREE.Scene();
  private camera = new THREE.PerspectiveCamera(FOV, 1, 0.1, 50);
  private composer: EffectComposer;
  private bloom: UnrealBloomPass;
  private grade: ShaderPass;

  private wallMat: THREE.ShaderMaterial;
  private hazeMat: THREE.ShaderMaterial;
  private dustMat: THREE.ShaderMaterial;
  private wall: THREE.Mesh;
  private haze: THREE.Mesh;

  private view = new THREE.Vector2(1, 1);

  private look: WallLook = { intensity: 1, projector: false, visual: 'wall', glass: 0, shape: 'lattice', zone: 6.5 };
  private renderPass: RenderPass;
  private frost: ShaderPass;
  private waveScene = new THREE.Scene();
  private waveCam = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);
  private waveMat: THREE.ShaderMaterial;
  private specTex: THREE.DataTexture;
  private swellTex: THREE.DataTexture;
  private swellData: Float32Array<ArrayBuffer> = new Float32Array(SWELL);
  private artColor = new THREE.Color('#ffffff');
  private artTarget = 0;
  private artMix = 0;
  private spectrum = new Spectrum();
  private specData: Float32Array<ArrayBuffer>;
  private shown = 'wall:lattice';
  private fade = 1;
  private glassS = 0;
  private mirrorClock = 0;
  private stage = 0;
  private stageTarget = 0;
  private drift = 0;
  private driftTarget = 0;
  private kickVis = 0;
  private energyS = 0.3;
  private punch = 0;
  private reducedMotion = matchMedia('(prefers-reduced-motion: reduce)').matches;

  private t0 = performance.now();
  private last = performance.now();
  private raf = 0;
  private maxPR = Math.min(window.devicePixelRatio || 1, 1.75);
  private pr = this.maxPR;
  private perfAcc = 0;
  private perfFrames = 0;
  private unsubHit: () => void;
  private performing = false;
  private colorCache = new Map<string, THREE.Color>();

  /** called every frame with the visible beat envelope (for CSS) */
  onFrame?: (kick: number) => void;

  constructor(canvas: HTMLCanvasElement) {
    this.renderer = new THREE.WebGLRenderer({ canvas, antialias: false, powerPreference: 'high-performance' });
    this.renderer.toneMapping = THREE.ACESFilmicToneMapping;
    this.renderer.toneMappingExposure = 1;
    this.renderer.setClearColor(0x000000, 1);

    const red = new THREE.Color('#ff3324');
    const ice = new THREE.Color('#62d8ff');

    this.wallMat = new THREE.ShaderMaterial({
      vertexShader: worldVertex,
      fragmentShader: wallFragment,
      uniforms: {
        uTime: { value: 0 },
        uCell: { value: 1 },
        uLow: { value: 0 },
        uMid: { value: 0 },
        uKick: { value: 0 },
        uSnare: { value: 0 },
        uEnergy: { value: 0.3 },
        uRiser: { value: 0 },
        uFlash: { value: 0 },
        uDrift: { value: 0 },
        uReveal: { value: 0 },
        uWallLight: { value: 0 },
        uIntensity: { value: 1 },
        uPalMix: { value: 1 },
        uGeom: { value: 0 },
        uClock: { value: 0 },
        uZone: { value: 6.5 },
        uView: { value: this.view },
        uLook: { value: new THREE.Vector3() },
        uBeatInfo: { value: new THREE.Vector4() },
        uTiming: { value: new THREE.Vector2(0.6, 0.6) },
        uRings: { value: Array.from({ length: RING_SLOTS }, () => new THREE.Vector4(-1000, 0, 0, 1)) },
        uWallA: { value: new THREE.Color() },
        uWallB: { value: new THREE.Color() },
        uA0: { value: new THREE.Color() },
        uA1: { value: new THREE.Color() },
        uA2: { value: new THREE.Color() },
        uB0: { value: new THREE.Color() },
        uB1: { value: new THREE.Color() },
        uB2: { value: new THREE.Color() },
      },
    });
    this.wall = new THREE.Mesh(new THREE.PlaneGeometry(1, 1), this.wallMat);
    this.scene.add(this.wall);

    this.hazeMat = new THREE.ShaderMaterial({
      vertexShader: worldVertex,
      fragmentShader: hazeFragment,
      transparent: true,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
      uniforms: {
        uTime: { value: 0 },
        uStrength: { value: 0.8 },
        uKick: { value: 0 },
        uBass: { value: 0 },
        uRed: { value: red.clone() },
        uIce: { value: ice.clone() },
        uView: { value: this.view },
      },
    });
    this.haze = new THREE.Mesh(new THREE.PlaneGeometry(1, 1), this.hazeMat);
    this.haze.position.z = 2.2;
    this.scene.add(this.haze);

    const pos = new Float32Array(DUST * 3);
    const seed = new Float32Array(DUST);
    const size = new Float32Array(DUST);
    for (let i = 0; i < DUST; i++) {
      pos[i * 3] = (Math.random() * 2 - 1) * 9;
      pos[i * 3 + 1] = (Math.random() * 2 - 1) * 4.5;
      pos[i * 3 + 2] = 0.6 + Math.random() * 6.4;
      seed[i] = Math.random();
      size[i] = 0.8 + Math.random() ** 2 * 2.6;
    }
    const dustGeo = new THREE.BufferGeometry();
    dustGeo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    dustGeo.setAttribute('aSeed', new THREE.BufferAttribute(seed, 1));
    dustGeo.setAttribute('aSize', new THREE.BufferAttribute(size, 1));
    this.dustMat = new THREE.ShaderMaterial({
      vertexShader: dustVertex,
      fragmentShader: dustFragment,
      transparent: true,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
      uniforms: {
        uTime: { value: 0 },
        uPR: { value: this.pr },
        uKick: { value: 0 },
        uHeight: { value: 4.5 },
        uFocus: { value: 7.5 },
        uRed: { value: red.clone() },
        uIce: { value: ice.clone() },
        uViewX: { value: 5 },
        uStrength: { value: 1 },
      },
    });
    const dust = new THREE.Points(dustGeo, this.dustMat);
    dust.frustumCulled = false;
    this.scene.add(dust);

    this.camera.position.set(0, 0, BASE_Z);

    // the wave: one full-screen quad fed by a live spectrum texture
    this.specData = new Float32Array(BANDS);
    this.specTex = new THREE.DataTexture(this.specData, BANDS, 1, THREE.RedFormat, THREE.FloatType);
    this.specTex.magFilter = THREE.LinearFilter;
    this.specTex.minFilter = THREE.LinearFilter;
    this.specTex.wrapS = THREE.ClampToEdgeWrapping;
    this.specTex.needsUpdate = true;
    this.swellTex = new THREE.DataTexture(this.swellData, SWELL, 1, THREE.RedFormat, THREE.FloatType);
    this.swellTex.magFilter = THREE.LinearFilter;
    this.swellTex.minFilter = THREE.LinearFilter;
    this.swellTex.wrapS = THREE.ClampToEdgeWrapping;
    this.swellTex.needsUpdate = true;
    this.waveMat = new THREE.ShaderMaterial({
      vertexShader: WaveShader.vertexShader,
      fragmentShader: WaveShader.fragmentShader,
      depthTest: false,
      uniforms: {
        uSpec: { value: this.specTex },
        uSwell: { value: this.swellTex },
        uArt: { value: new THREE.Color('#ffffff') },
        uArtMix: { value: 0 },
        uTime: { value: 0 },
        uLevel: { value: 0 },
        uKick: { value: 0 },
        uFlash: { value: 0 },
        uAspect: { value: 1 },
        uIntensity: { value: 1 },
        uFade: { value: 1 },
        uTint: { value: new THREE.Color() },
        uTintMix: { value: 0 },
      },
    });
    const quad = new THREE.Mesh(new THREE.PlaneGeometry(2, 2), this.waveMat);
    quad.frustumCulled = false;
    this.waveScene.add(quad);

    this.composer = new EffectComposer(this.renderer);
    this.renderPass = new RenderPass(this.scene, this.camera);
    this.composer.addPass(this.renderPass);
    this.bloom = new UnrealBloomPass(new THREE.Vector2(256, 256), 0.6, 0.65, 0.9);
    this.composer.addPass(this.bloom);
    this.frost = new ShaderPass(FrostShader);
    this.composer.addPass(this.frost);
    this.grade = new ShaderPass(GradeShader);
    this.composer.addPass(this.grade);
    this.composer.addPass(new OutputPass());

    this.unsubHit = conductor.onHit((kind, s) => {
      if (kind === 'drop') this.punch = 1;
      else if (kind === 'kick') this.driftTarget += 0.04 * s;
    });

    window.addEventListener('resize', this.resize);
    document.addEventListener('visibilitychange', this.onVisibility);
    this.resize();
    this.raf = requestAnimationFrame(this.frame);
  }

  setLook(look: WallLook) {
    this.look = look;
    // the first look is applied as is: no dip on launch for a saved shape or visual
    if (!this.lookApplied) {
      this.lookApplied = true;
      this.shown = `${look.visual}:${look.shape}`;
      const wave = look.visual === 'wave';
      this.renderPass.scene = wave ? this.waveScene : this.scene;
      this.renderPass.camera = wave ? this.waveCam : this.camera;
      this.wallMat.uniforms.uGeom.value = { lattice: 0, rings: 1, hex: 2 }[look.shape];
    }
  }
  private lookApplied = false;

  /** The album cover's colour, for the centre of the wave (null: no cover, keep the spectrum). */
  setArtColor(hex: string | null) {
    if (hex) this.artColor.set(hex);
    this.artTarget = hex ? 1 : 0;
  }

  /** 0 = home, 1 = performing: the camera leans in and the light opens up */
  setStage(on: boolean) {
    this.stageTarget = on ? 1 : 0;
    this.performing = on;
  }

  private color(hex: string) {
    let c = this.colorCache.get(hex);
    if (!c) {
      c = new THREE.Color(hex);
      this.colorCache.set(hex, c);
    }
    return c;
  }

  private applyPalettes(a: Palette, b: Palette) {
    const u = this.wallMat.uniforms;
    u.uWallA.value.copy(this.color(a.wall));
    u.uWallB.value.copy(this.color(b.wall));
    u.uA0.value.copy(this.color(a.lights[0]));
    u.uA1.value.copy(this.color(a.lights[1]));
    u.uA2.value.copy(this.color(a.lights[2]));
    u.uB0.value.copy(this.color(b.lights[0]));
    u.uB1.value.copy(this.color(b.lights[1]));
    u.uB2.value.copy(this.color(b.lights[2]));
    // haze and dust follow the blended scene
    const m = conductor.state.palMix;
    this.hazeMat.uniforms.uRed.value.copy(this.color(a.wall)).lerp(this.color(b.wall), m);
    this.hazeMat.uniforms.uIce.value.copy(this.color(a.lights[1])).lerp(this.color(b.lights[1]), m);
    this.dustMat.uniforms.uRed.value.copy(this.color(a.lights[0])).lerp(this.color(b.lights[0]), m);
    this.dustMat.uniforms.uIce.value.copy(this.color(a.lights[1])).lerp(this.color(b.lights[1]), m);
  }

  dispose() {
    cancelAnimationFrame(this.raf);
    this.unsubHit();
    window.removeEventListener('resize', this.resize);
    document.removeEventListener('visibilitychange', this.onVisibility);
    this.scene.traverse((o) => {
      const m = o as THREE.Mesh;
      m.geometry?.dispose();
      (m.material as THREE.Material | undefined)?.dispose?.();
    });
    this.composer.dispose();
    this.renderer.dispose();
  }

  private onVisibility = () => {
    cancelAnimationFrame(this.raf);
    if (!document.hidden) {
      this.last = performance.now();
      this.raf = requestAnimationFrame(this.frame);
    }
  };

  private resize = () => {
    const w = window.innerWidth;
    const h = window.innerHeight;
    this.renderer.setPixelRatio(this.pr);
    this.renderer.setSize(w, h, false);
    this.composer.setPixelRatio(this.pr);
    this.composer.setSize(w, h);
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();

    const halfH = Math.tan(THREE.MathUtils.degToRad(FOV / 2)) * BASE_Z;
    const halfW = halfH * this.camera.aspect;
    this.view.set(halfW, halfH);
    this.wall.scale.set((halfW + 2) * 2, (halfH + 2) * 2, 1);
    this.haze.scale.copy(this.wall.scale);
    this.wallMat.uniforms.uCell.value = Math.min((halfH * 2) / 6, (halfW * 2) / 4.6);
    this.dustMat.uniforms.uHeight.value = halfH + 1;
    this.dustMat.uniforms.uViewX.value = halfW;
    this.dustMat.uniforms.uPR.value = this.pr;
    this.grade.uniforms.uRes.value = [w * this.pr, h * this.pr];
    this.frost.uniforms.uRes.value = [w * this.pr, h * this.pr];
    this.waveMat.uniforms.uAspect.value = w / h;
  };

  /**
   * Keep the wall smooth on weaker machines by trading resolution, with hysteresis.
   * Measured on real elapsed time (not frame count), so a very slow machine reacts in
   * a couple of seconds instead of waiting for frames that come slowly.
   */
  private adapt(realDt: number) {
    // a tab switch or a long pause isn't a performance signal
    if (realDt > 0.5) return;
    this.perfAcc += realDt;
    this.perfFrames++;
    if (this.perfFrames < 30 && this.perfAcc < 2) return;
    const avg = this.perfAcc / this.perfFrames;
    this.perfAcc = 0;
    this.perfFrames = 0;
    if (avg > 1 / 40 && this.pr > 0.5) {
      // too slow: step down (harder when very slow), then hold for a while
      this.pr = Math.max(0.5, this.pr - (avg > 1 / 15 ? 0.5 : 0.25));
      this.goodFor = 0;
      this.holdUntil = performance.now() + 8000;
      this.resize();
    } else if (avg < 1 / 57) {
      // only climb back after sustained headroom, and only a few times, so it never oscillates
      this.goodFor += this.perfAcc + avg * 30;
      if (this.pr < this.maxPR && this.upgrades < 3 && performance.now() > this.holdUntil && this.goodFor > 10) {
        this.pr = Math.min(this.maxPR, this.pr + 0.25);
        this.upgrades++;
        this.goodFor = 0;
        this.resize();
      }
    } else this.goodFor = 0;
  }
  private goodFor = 0;
  private holdUntil = 0;
  private upgrades = 0;

  private frame = (now: number) => {
    this.raf = requestAnimationFrame(this.frame);
    const realDt = (now - this.last) / 1000;
    const dt = Math.min(0.05, realDt);
    this.last = now;
    const rm = this.reducedMotion;
    const t = ((now - this.t0) / 1000) * (rm ? 0.4 : 1);
    const { intensity, projector } = this.look;

    const trackTime = this.performing && playback.has(playback.active) ? playback.deckTime(now) : null;
    conductor.update(dt, now, trackTime, playback.playing);
    const L = conductor.state;
    this.applyPalettes(L.palA, L.palB);

    this.kickVis = L.kick > this.kickVis ? approach(this.kickVis, L.kick, dt, 0.025) : L.kick;
    this.stage = approach(this.stage, this.stageTarget, dt, 0.9);
    this.drift = approach(this.drift, this.driftTarget, dt, 0.6);
    this.energyS = approach(this.energyS, L.energy, dt, 1.2);
    this.punch *= Math.exp(-dt * 2.5);

    const since = (now - this.t0) / 1000 - 0.3;
    const reveal = easeInOut(since / 3.2);
    const wallLight = easeInOut(since / 1.8);

    const wu = this.wallMat.uniforms;
    wu.uTime.value = t;
    wu.uLow.value = L.low;
    wu.uMid.value = L.mid;
    wu.uKick.value = this.kickVis;
    wu.uSnare.value = L.snare;
    wu.uEnergy.value = L.energy;
    wu.uRiser.value = L.riser;
    wu.uFlash.value = rm ? L.flash * 0.3 : L.flash;
    wu.uDrift.value = this.drift;
    wu.uReveal.value = reveal;
    wu.uWallLight.value = wallLight;
    wu.uIntensity.value = intensity;
    wu.uPalMix.value = L.palMix;
    wu.uClock.value = L.clock;
    wu.uZone.value = this.look.zone;
    const ch = conductor.choreo;
    wu.uLook.value.set(ch.look[0], ch.look[1], rm ? 1 : ch.look[2]);
    wu.uBeatInfo.value.fromArray(ch.beatInfo);
    wu.uTiming.value.set(ch.timing[0], rm ? ch.timing[1] * 2 : ch.timing[1]);
    const rings = wu.uRings.value as THREE.Vector4[];
    for (let i = 0; i < RING_SLOTS; i++) rings[i].fromArray(ch.rings, i * 4);

    const hu = this.hazeMat.uniforms;
    hu.uTime.value = t;
    hu.uKick.value = this.kickVis * intensity;
    hu.uBass.value = L.low;
    hu.uStrength.value = (projector ? 0.22 : 0.38) * wallLight * (0.7 + 0.6 * L.riser);

    const du = this.dustMat.uniforms;
    du.uTime.value = t;
    du.uKick.value = this.kickVis;
    du.uStrength.value = (projector ? 0.25 : 0.4) * wallLight;

    // camera: moves only with the music. Calm songs barely sway; loud sections drift wider,
    // kicks push in a touch, a drop punches in and settles back.
    const motion = rm ? 0 : 1;
    const amp = (0.05 + 0.32 * this.energyS) * motion;
    const cam = this.camera;
    cam.position.x = (Math.sin(t * 0.07) * 0.8 + Math.sin(t * 0.031) * 0.35) * amp;
    cam.position.y = Math.sin(t * 0.05 + 1.3) * 0.45 * amp;
    cam.position.z = BASE_Z - this.stage * 0.7 - (this.kickVis * 0.1 * intensity + this.punch * 0.45) * motion;
    cam.lookAt(cam.position.x * 0.35, cam.position.y * 0.35, 0);
    cam.rotation.z = Math.sin(t * 0.043) * 0.006 * amp * 3;

    // switching visuals: dip to dark, swap, rise back
    const want = `${this.look.visual}:${this.look.shape}`;
    if (want !== this.shown) {
      this.fade = Math.max(0, this.fade - dt / 0.35);
      if (this.fade === 0) {
        this.shown = want;
        const wave = this.look.visual === 'wave';
        this.renderPass.scene = wave ? this.waveScene : this.scene;
        this.renderPass.camera = wave ? this.waveCam : this.camera;
        this.wallMat.uniforms.uGeom.value = { lattice: 0, rings: 1, hex: 2 }[this.look.shape];
      }
    } else this.fade = Math.min(1, this.fade + dt / 0.6);
    const fadeEase = this.fade * this.fade * (3 - 2 * this.fade);

    if (this.shown.startsWith('wave')) {
      this.spectrum.update(dt, t);
      this.specData.set(this.spectrum.bands);
      this.specTex.needsUpdate = true;
      const vu = this.waveMat.uniforms;
      vu.uTime.value = t;
      vu.uLevel.value = this.spectrum.level;
      vu.uKick.value = this.kickVis;
      vu.uFlash.value = rm ? L.flash * 0.3 : L.flash;
      vu.uIntensity.value = intensity;
      vu.uFade.value = 1;
      // a whisper of the current scene so the wave and the wall feel like one show
      vu.uTint.value.copy(this.color(L.palB.lights[0]));
      vu.uTintMix.value = 0.12;
      this.swellData.set(this.spectrum.swell);
      this.swellTex.needsUpdate = true;
      this.artMix = approach(this.artMix, this.artTarget, dt, 1.2);
      vu.uArt.value.lerp(this.artColor, 1 - Math.exp(-dt / 1.2));
      vu.uArtMix.value = this.artMix;
    }
    this.glassS = approach(this.glassS, this.look.glass, dt, 0.35);
    this.frost.uniforms.uAmount.value = this.glassS;
    this.frost.uniforms.uTime.value = t;
    this.mirrorClock += dt;
    if (this.mirrorClock > 0.5) {
      this.mirrorClock = 0;
      playback.syncMirror();
    }

    this.bloom.strength = (projector ? 0.5 : 0.6) + this.kickVis * 0.3 * intensity + this.stage * 0.06 + L.flash * 0.5 + L.riser * 0.2;
    this.bloom.threshold = projector ? 0.95 : 0.9;
    this.renderer.toneMappingExposure = projector ? 1.15 : 1;

    const gu = this.grade.uniforms;
    gu.uTime.value = t;
    gu.uGrain.value = projector ? 0 : 1;
    gu.uCA.value = projector ? 0 : 0.0018 + this.kickVis * 0.0015 * intensity;
    gu.uSat.value = projector ? 1.12 : 1.04;
    gu.uBlack.value = projector ? 0.012 : 0.004;
    gu.uVignette.value = projector ? 0.95 : 0.82;
    gu.uFade.value = fadeEase;

    this.adapt(realDt);
    this.composer.render(dt);
    this.onFrame?.(this.kickVis);
  };
}
