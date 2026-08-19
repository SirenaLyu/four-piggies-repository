"use client";

import { useEffect, useRef } from "react";
import * as THREE from "three";
import { OrbitControls } from "three/addons/controls/OrbitControls.js";

/**
 * 3D 校园进入页：Three.js 搭建的校园场景（占位几何体），
 * 用户可拖拽旋转/滚轮缩放，点击「进入对话」切换到聊天界面。
 * 后续可替换为从 Sketchfab 下载的校园 GLB 模型。
 */
export function Campus3DIntro({ onEnter }: { onEnter: () => void }) {
  const containerRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;

    // ── 场景 / 相机 / 渲染器 ──────────────────────
    const scene = new THREE.Scene();
    scene.background = new THREE.Color("#f8f9fb");
    scene.fog = new THREE.Fog("#f8f9fb", 40, 130);

    const camera = new THREE.PerspectiveCamera(
      50,
      container.clientWidth / container.clientHeight,
      0.1,
      300
    );
    camera.position.set(32, 20, 34);

    const renderer = new THREE.WebGLRenderer({ antialias: true });
    renderer.setSize(container.clientWidth, container.clientHeight);
    renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    container.appendChild(renderer.domElement);

    // ── 灯光 ──────────────────────────────────────
    scene.add(new THREE.AmbientLight(0xffffff, 0.75));
    const dir = new THREE.DirectionalLight(0xffffff, 1.3);
    dir.position.set(30, 45, 20);
    scene.add(dir);
    const dir2 = new THREE.DirectionalLight(0xffffff, 0.4);
    dir2.position.set(-20, 15, -25);
    scene.add(dir2);

    // ── 材质 ──────────────────────────────────────
    const matWall = new THREE.MeshStandardMaterial({ color: 0xf2f4f8 });
    const matRoof = new THREE.MeshStandardMaterial({ color: 0x3e63af });
    const matGate = new THREE.MeshStandardMaterial({ color: 0x3e63af });
    const matGround = new THREE.MeshStandardMaterial({ color: 0xe8ebf0 });
    const matTree = new THREE.MeshStandardMaterial({ color: 0x6b9a67 });
    const matTrunk = new THREE.MeshStandardMaterial({ color: 0x8a6a4a });

    // ── 地面 ──────────────────────────────────────
    const ground = new THREE.Mesh(new THREE.PlaneGeometry(90, 90), matGround);
    ground.rotation.x = -Math.PI / 2;
    scene.add(ground);

    // ── 道路（校门前的横条）───────────────────────
    const road = new THREE.Mesh(new THREE.PlaneGeometry(14, 40), new THREE.MeshStandardMaterial({ color: 0xdfe3ea }));
    road.rotation.x = -Math.PI / 2;
    road.position.set(0, 0.02, 8);
    scene.add(road);

    // ── 建筑群 ────────────────────────────────────
    const buildings: [number, number, number, number, number, number][] = [
      // [x, z, 宽, 高, 深, 是否主楼]
      [-12, -10, 7, 12, 7, 0],
      [0, -14, 9, 20, 9, 1],
      [13, -9, 6, 9, 6, 0],
      [-6, -20, 7, 8, 7, 0],
    ];
    buildings.forEach(([x, z, w, h, d, isMain]) => {
      const wall = new THREE.Mesh(new THREE.BoxGeometry(w, h, d), matWall);
      wall.position.set(x, h / 2, z);
      scene.add(wall);
      const roof = new THREE.Mesh(new THREE.BoxGeometry(w + 0.4, 0.8, d + 0.4), matRoof);
      roof.position.set(x, h + 0.4, z);
      scene.add(roof);
      if (isMain) {
        // 主楼加一个尖顶装饰
        const spire = new THREE.Mesh(new THREE.ConeGeometry(1.4, 3, 4), matRoof);
        spire.position.set(x, h + 2.3, z);
        spire.rotation.y = Math.PI / 4;
        scene.add(spire);
      }
    });

    // ── 校门（两根柱 + 横梁）──────────────────────
    const pillarGeo = new THREE.BoxGeometry(1.6, 8, 1.6);
    const lintelGeo = new THREE.BoxGeometry(16, 2, 2);
    const p1 = new THREE.Mesh(pillarGeo, matGate);
    p1.position.set(-6, 4, 6);
    scene.add(p1);
    const p2 = new THREE.Mesh(pillarGeo, matGate);
    p2.position.set(6, 4, 6);
    scene.add(p2);
    const lintel = new THREE.Mesh(lintelGeo, matGate);
    lintel.position.set(0, 9, 6);
    scene.add(lintel);

    // ── 树 ────────────────────────────────────────
    const treePositions: [number, number][] = [
      [-16, 2], [16, 2], [-18, -16], [18, -14], [-8, 14], [8, 14],
    ];
    treePositions.forEach(([x, z]) => {
      const trunk = new THREE.Mesh(new THREE.CylinderGeometry(0.4, 0.5, 3, 8), matTrunk);
      trunk.position.set(x, 1.5, z);
      scene.add(trunk);
      const crown = new THREE.Mesh(new THREE.SphereGeometry(2.2, 16, 16), matTree);
      crown.position.set(x, 4.4, z);
      scene.add(crown);
    });

    // ── OrbitControls（旋转/缩放）──────────────────
    const controls = new OrbitControls(camera, renderer.domElement);
    controls.target.set(0, 6, 0);
    controls.enableDamping = true;
    controls.dampingFactor = 0.08;
    controls.minDistance = 12;
    controls.maxDistance = 70;
    controls.maxPolarAngle = Math.PI / 2 - 0.08;
    controls.autoRotate = true;
    controls.autoRotateSpeed = 0.6;

    // ── 渲染循环 ──────────────────────────────────
    let animationId = 0;
    const animate = () => {
      animationId = requestAnimationFrame(animate);
      controls.update();
      renderer.render(scene, camera);
    };
    animate();

    // ── 响应式 ────────────────────────────────────
    const handleResize = () => {
      camera.aspect = container.clientWidth / container.clientHeight;
      camera.updateProjectionMatrix();
      renderer.setSize(container.clientWidth, container.clientHeight);
    };
    window.addEventListener("resize", handleResize);

    // ── 清理 ──────────────────────────────────────
    return () => {
      window.removeEventListener("resize", handleResize);
      cancelAnimationFrame(animationId);
      controls.dispose();
      renderer.dispose();
      if (renderer.domElement.parentNode === container) {
        container.removeChild(renderer.domElement);
      }
    };
  }, []);

  return (
    <div className="relative h-screen w-screen overflow-hidden">
      <div ref={containerRef} className="absolute inset-0" />

      {/* 顶部标题 */}
      <div className="pointer-events-none absolute inset-x-0 top-0 flex justify-center pt-8">
        <div className="text-center">
          <h1 className="text-2xl font-bold tracking-wide text-ink-900">校园 AI 助手</h1>
          <p className="mt-1.5 text-sm text-ink-600">拖拽旋转 · 滚轮缩放 · 探索 3D 校园</p>
        </div>
      </div>

      {/* 底部进入按钮 */}
      <div className="pointer-events-none absolute inset-x-0 bottom-0 flex justify-center pb-14">
        <button
          onClick={onEnter}
          className="pointer-events-auto rounded-lg bg-primary-600 px-8 py-3 text-sm font-semibold text-white shadow-lg transition-colors hover:bg-primary-500"
        >
          进入对话 →
        </button>
      </div>
    </div>
  );
}
