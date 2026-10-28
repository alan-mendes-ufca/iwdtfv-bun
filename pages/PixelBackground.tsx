import { useEffect, useRef } from "react";

type Pixel = {
  x: number;
  y: number;
  size: number;
  opacity: number;
  phase: number;
  period: number;
};

const MAX_PIXELS = 1400;
const MOBILE_MAX_PIXELS = 800;
const CELL = 7;

function random(seed: number) {
  let value = seed >>> 0;
  return () => {
    value = (value * 1664525 + 1013904223) >>> 0;
    return value / 0x100000000;
  };
}

export default function PixelBackground() {
  const canvasRef = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    const canvas = canvasRef.current;
    const context = canvas?.getContext("2d");
    if (!canvas || !context) return;

    const motionQuery = window.matchMedia("(prefers-reduced-motion: reduce)");
    let pixels: Pixel[] = [];
    let frame = 0;
    let lastDraw = 0;
    let width = 0;
    let height = 0;

    const draw = (time: number) => {
      if (document.hidden) return;
      if (!motionQuery.matches && time - lastDraw < 1000 / 15) {
        frame = window.requestAnimationFrame(draw);
        return;
      }
      lastDraw = time;
      context.clearRect(0, 0, width, height);
      for (const pixel of pixels) {
        const wave = motionQuery.matches
          ? 0.5
          : 0.5 +
            0.5 *
              Math.sin(
                (time / 1000 / pixel.period) * Math.PI * 2 + pixel.phase,
              );
        const opacity = pixel.opacity * (0.58 + wave * 0.42);
        context.fillStyle = `rgba(190, 193, 198, ${opacity.toFixed(3)})`;
        context.fillRect(pixel.x, pixel.y, pixel.size, pixel.size);
      }
      if (!motionQuery.matches) frame = window.requestAnimationFrame(draw);
    };

    const rebuild = () => {
      width = window.innerWidth;
      height = window.innerHeight;
      const dpr = Math.min(window.devicePixelRatio || 1, 1.5);
      canvas.width = Math.round(width * dpr);
      canvas.height = Math.round(height * dpr);
      canvas.style.width = `${width}px`;
      canvas.style.height = `${height}px`;
      context.setTransform(dpr, 0, 0, dpr, 0, 0);

      const rand = random(Math.round(width * 31 + height * 17));
      const candidates: Pixel[] = [];
      for (let y = 0; y < height; y += CELL) {
        const progress = y / Math.max(height, 1);
        for (let x = 0; x < width; x += CELL) {
          const edge = Math.min(x, width - x) / Math.max(width * 0.24, 1);
          const edgeWeight = Math.max(0, 1 - edge);
          const bottomWeight = Math.max(0, (progress - 0.48) / 0.52);
          const ridge =
            height *
            (0.82 +
              0.1 * Math.sin((x / Math.max(width, 1)) * Math.PI * 3.5) +
              0.025 * Math.sin(x * 0.035));
          const silhouette = y >= ridge - edgeWeight * height * 0.16;
          const chance = Math.min(
            0.62,
            edgeWeight * (0.08 + progress * 0.2) +
              bottomWeight * 0.3 +
              (silhouette ? 0.22 : 0),
          );
          if (rand() > chance) continue;
          candidates.push({
            x: x + rand() * 2,
            y: y + rand() * 2,
            size: 3 + Math.floor(rand() * 4),
            opacity:
              0.045 +
              rand() *
                (edgeWeight > 0.55 || bottomWeight > 0.55 ? 0.23 : 0.065),
            phase: rand() * Math.PI * 2,
            period: 3 + rand() * 5,
          });
        }
      }

      const limit = width < 600 ? MOBILE_MAX_PIXELS : MAX_PIXELS;
      if (candidates.length <= limit) {
        pixels = candidates;
      } else {
        const stride = candidates.length / limit;
        pixels = Array.from(
          { length: limit },
          (_, index) => candidates[Math.floor(index * stride)]!,
        );
      }
      window.cancelAnimationFrame(frame);
      lastDraw = 0;
      draw(0);
    };

    const onVisibilityChange = () => {
      window.cancelAnimationFrame(frame);
      if (!document.hidden) {
        lastDraw = 0;
        frame = window.requestAnimationFrame(draw);
      }
    };
    const onMotionChange = () => {
      lastDraw = 0;
      window.cancelAnimationFrame(frame);
      frame = window.requestAnimationFrame(draw);
    };

    rebuild();
    window.addEventListener("resize", rebuild);
    document.addEventListener("visibilitychange", onVisibilityChange);
    motionQuery.addEventListener("change", onMotionChange);
    return () => {
      window.cancelAnimationFrame(frame);
      window.removeEventListener("resize", rebuild);
      document.removeEventListener("visibilitychange", onVisibilityChange);
      motionQuery.removeEventListener("change", onMotionChange);
    };
  }, []);

  return (
    <canvas
      ref={canvasRef}
      aria-hidden="true"
      style={{
        position: "fixed",
        inset: 0,
        width: "100vw",
        height: "100vh",
        pointerEvents: "none",
        zIndex: 0,
      }}
    />
  );
}
