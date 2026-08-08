import { useEffect, useRef } from 'react';

/* ─── BackgroundFX ────────────────────────────────────────────────────────────
 * A full-viewport animated canvas that sits behind every page:
 *   • a parallax, twinkling starfield
 *   • one bright beacon star (top-right) with a glowing cross flare
 *   • a subtle constellation network of drifting nodes
 *   • occasional shooting stars
 * Additive blending makes the lights glow. Honors prefers-reduced-motion and
 * pauses when the tab is hidden.
 * ──────────────────────────────────────────────────────────────────────────── */

interface Point {
  x: number;
  y: number;
}

interface Star {
  x: number;
  y: number;
  r: number;
  baseAlpha: number;
  twinkleSpeed: number;
  phase: number;
  vx: number;
  vy: number;
}

interface Node {
  x: number;
  y: number;
  vx: number;
  vy: number;
}

interface ShootingStar {
  x: number;
  y: number;
  vx: number;
  vy: number;
  life: number;
  maxLife: number;
}

const NODE_LINK_DISTANCE = 150;

export function BackgroundFX() {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    const reduced = window.matchMedia('(prefers-reduced-motion: reduce)').matches;

    let width = 0;
    let height = 0;
    let dpr = 1;

    let stars: Star[] = [];
    let nodes: Node[] = [];
    const shooting: ShootingStar[] = [];
    let beacon: Point = { x: 0, y: 0 };
    let shootTimer = 0;

    const seed = () => {
      const area = width * height;
      const starCount = Math.min(260, Math.round(area / 6000));
      stars = Array.from({ length: starCount }, () => ({
        x: Math.random() * width,
        y: Math.random() * height,
        r: Math.random() * 1.4 + 0.3,
        baseAlpha: Math.random() * 0.5 + 0.3,
        twinkleSpeed: Math.random() * 0.02 + 0.004,
        phase: Math.random() * Math.PI * 2,
        vx: (Math.random() - 0.5) * 0.05,
        vy: Math.random() * 0.06 + 0.01,
      }));

      const nodeCount = Math.min(70, Math.round(area / 26000));
      nodes = Array.from({ length: nodeCount }, () => ({
        x: Math.random() * width,
        y: Math.random() * height,
        vx: (Math.random() - 0.5) * 0.4,
        vy: (Math.random() - 0.5) * 0.4,
      }));

      beacon = { x: width * 0.84, y: height * 0.16 };
    };

    const resize = () => {
      dpr = Math.min(window.devicePixelRatio || 1, 2);
      width = window.innerWidth;
      height = window.innerHeight;
      canvas.width = Math.floor(width * dpr);
      canvas.height = Math.floor(height * dpr);
      canvas.style.width = `${width}px`;
      canvas.style.height = `${height}px`;
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      seed();
    };

    const drawBeacon = (t: number) => {
      const pulse = 0.5 + 0.5 * Math.sin(t * 0.0016);
      const glowR = 90 + pulse * 26;
      ctx.save();
      ctx.globalCompositeOperation = 'lighter';

      const halo = ctx.createRadialGradient(beacon.x, beacon.y, 0, beacon.x, beacon.y, glowR);
      halo.addColorStop(0, 'rgba(180, 200, 255, 0.55)');
      halo.addColorStop(0.25, 'rgba(124, 104, 255, 0.28)');
      halo.addColorStop(1, 'rgba(124, 104, 255, 0)');
      ctx.fillStyle = halo;
      ctx.beginPath();
      ctx.arc(beacon.x, beacon.y, glowR, 0, Math.PI * 2);
      ctx.fill();

      // Cross flare
      const flare = 46 + pulse * 20;
      ctx.lineWidth = 1.4;

      const hGrad = ctx.createLinearGradient(beacon.x - flare, beacon.y, beacon.x + flare, beacon.y);
      hGrad.addColorStop(0, 'rgba(200, 215, 255, 0)');
      hGrad.addColorStop(0.5, 'rgba(220, 230, 255, 0.9)');
      hGrad.addColorStop(1, 'rgba(200, 215, 255, 0)');
      ctx.strokeStyle = hGrad;
      ctx.beginPath();
      ctx.moveTo(beacon.x - flare, beacon.y);
      ctx.lineTo(beacon.x + flare, beacon.y);
      ctx.stroke();

      const vGrad = ctx.createLinearGradient(beacon.x, beacon.y - flare, beacon.x, beacon.y + flare);
      vGrad.addColorStop(0, 'rgba(200, 215, 255, 0)');
      vGrad.addColorStop(0.5, 'rgba(220, 230, 255, 0.9)');
      vGrad.addColorStop(1, 'rgba(200, 215, 255, 0)');
      ctx.strokeStyle = vGrad;
      ctx.beginPath();
      ctx.moveTo(beacon.x, beacon.y - flare);
      ctx.lineTo(beacon.x, beacon.y + flare);
      ctx.stroke();

      // Core
      ctx.fillStyle = 'rgba(240, 245, 255, 0.95)';
      ctx.beginPath();
      ctx.arc(beacon.x, beacon.y, 2.6 + pulse * 0.8, 0, Math.PI * 2);
      ctx.fill();
      ctx.restore();
    };

    const drawStars = (t: number) => {
      ctx.save();
      ctx.globalCompositeOperation = 'lighter';
      for (const s of stars) {
        if (!reduced) {
          s.x += s.vx;
          s.y += s.vy;
          if (s.y > height + 2) s.y = -2;
          if (s.x < -2) s.x = width + 2;
          else if (s.x > width + 2) s.x = -2;
        }
        const twinkle = reduced ? s.baseAlpha : s.baseAlpha + Math.sin(t * s.twinkleSpeed + s.phase) * 0.35;
        const alpha = Math.max(0, Math.min(1, twinkle));
        ctx.fillStyle = `rgba(214, 224, 255, ${alpha})`;
        ctx.beginPath();
        ctx.arc(s.x, s.y, s.r, 0, Math.PI * 2);
        ctx.fill();
      }
      ctx.restore();
    };

    const drawNetwork = () => {
      for (const n of nodes) {
        if (!reduced) {
          n.x += n.vx;
          n.y += n.vy;
          if (n.x < 0 || n.x > width) n.vx *= -1;
          if (n.y < 0 || n.y > height) n.vy *= -1;
        }
      }
      ctx.save();
      ctx.lineWidth = 0.7;
      for (let i = 0; i < nodes.length; i += 1) {
        const a = nodes[i]!;
        for (let j = i + 1; j < nodes.length; j += 1) {
          const b = nodes[j]!;
          const dist = Math.hypot(a.x - b.x, a.y - b.y);
          if (dist < NODE_LINK_DISTANCE) {
            const alpha = (1 - dist / NODE_LINK_DISTANCE) * 0.28;
            ctx.strokeStyle = `rgba(124, 104, 255, ${alpha})`;
            ctx.beginPath();
            ctx.moveTo(a.x, a.y);
            ctx.lineTo(b.x, b.y);
            ctx.stroke();
          }
        }
      }
      ctx.fillStyle = 'rgba(150, 170, 255, 0.5)';
      for (const n of nodes) {
        ctx.beginPath();
        ctx.arc(n.x, n.y, 1.1, 0, Math.PI * 2);
        ctx.fill();
      }
      ctx.restore();
    };

    const spawnShootingStar = () => {
      const startX = Math.random() * width * 0.7 + width * 0.15;
      const startY = Math.random() * height * 0.4;
      const angle = Math.PI * (0.18 + Math.random() * 0.12);
      const speed = 9 + Math.random() * 6;
      shooting.push({
        x: startX,
        y: startY,
        vx: Math.cos(angle) * speed,
        vy: Math.sin(angle) * speed,
        life: 0,
        maxLife: 60 + Math.random() * 30,
      });
    };

    const drawShooting = () => {
      ctx.save();
      ctx.globalCompositeOperation = 'lighter';
      for (let i = shooting.length - 1; i >= 0; i -= 1) {
        const s = shooting[i]!;
        s.x += s.vx;
        s.y += s.vy;
        s.life += 1;
        const fade = 1 - s.life / s.maxLife;
        const tailX = s.x - s.vx * 4;
        const tailY = s.y - s.vy * 4;
        const grad = ctx.createLinearGradient(s.x, s.y, tailX, tailY);
        grad.addColorStop(0, `rgba(220, 230, 255, ${fade})`);
        grad.addColorStop(1, 'rgba(124, 104, 255, 0)');
        ctx.strokeStyle = grad;
        ctx.lineWidth = 1.8;
        ctx.beginPath();
        ctx.moveTo(s.x, s.y);
        ctx.lineTo(tailX, tailY);
        ctx.stroke();
        if (s.life >= s.maxLife || s.x > width + 60 || s.y > height + 60) {
          shooting.splice(i, 1);
        }
      }
      ctx.restore();
    };

    let raf = 0;
    let running = true;

    const frame = (t: number) => {
      ctx.clearRect(0, 0, width, height);
      drawNetwork();
      drawStars(t);
      if (!reduced) {
        shootTimer -= 1;
        if (shootTimer <= 0) {
          spawnShootingStar();
          shootTimer = 180 + Math.random() * 260;
        }
        drawShooting();
      }
      drawBeacon(t);
      if (running) raf = requestAnimationFrame(frame);
    };

    const onVisibility = () => {
      if (document.hidden) {
        running = false;
        cancelAnimationFrame(raf);
      } else if (!running) {
        running = true;
        raf = requestAnimationFrame(frame);
      }
    };

    resize();
    window.addEventListener('resize', resize);
    document.addEventListener('visibilitychange', onVisibility);

    if (reduced) {
      // Draw a single static frame.
      ctx.clearRect(0, 0, width, height);
      drawNetwork();
      drawStars(0);
      drawBeacon(0);
    } else {
      raf = requestAnimationFrame(frame);
    }

    return () => {
      running = false;
      cancelAnimationFrame(raf);
      window.removeEventListener('resize', resize);
      document.removeEventListener('visibilitychange', onVisibility);
    };
  }, []);

  return (
    <canvas
      ref={canvasRef}
      aria-hidden="true"
      style={{
        position: 'fixed',
        inset: 0,
        width: '100%',
        height: '100%',
        zIndex: 0,
        pointerEvents: 'none',
      }}
    />
  );
}
