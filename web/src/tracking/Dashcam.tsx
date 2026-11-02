import { useEffect, useRef } from "react";

/** A simulated dash camera: road perspective, passing posts, time-of-day sky, overlays. */
export function Dashcam({ plate, speed, time, coords }: { plate: string; speed: number; time: number; coords: string }) {
  const canvas = useRef<HTMLCanvasElement>(null);
  const state = useRef({ speed, time, coords, offset: 0 });
  state.current.speed = speed;
  state.current.time = time;
  state.current.coords = coords;
  useEffect(() => {
    const el = canvas.current!;
    const ctx = el.getContext("2d")!;
    const W = (el.width = 640);
    const H = (el.height = 360);
    let frame = 0;
    let raf = 0;
    let last = performance.now();
    const posts = Array.from({ length: 7 }, (_, i) => i / 7);
    const draw = (now: number) => {
      const dt = Math.min(0.05, (now - last) / 1000);
      last = now;
      frame++;
      const s = state.current;
      s.offset = (s.offset + dt * (s.speed / 60) * 1.6) % 1;
      const hour = new Date(s.time).getHours() + new Date(s.time).getMinutes() / 60;
      const night = hour < 5.5 || hour > 19;
      const dusk = !night && (hour < 7 || hour > 17.5);
      const horizon = H * 0.46;
      const sky = ctx.createLinearGradient(0, 0, 0, horizon);
      if (night) {
        sky.addColorStop(0, "#05080d");
        sky.addColorStop(1, "#1a2230");
      } else if (dusk) {
        sky.addColorStop(0, "#3b4f6b");
        sky.addColorStop(0.7, "#c98a5a");
        sky.addColorStop(1, "#e7b27a");
      } else {
        sky.addColorStop(0, "#7ea6c9");
        sky.addColorStop(1, "#d9e3e3");
      }
      ctx.fillStyle = sky;
      ctx.fillRect(0, 0, W, horizon);
      ctx.fillStyle = night ? "#0c1010" : dusk ? "#5b4a3a" : "#8a8d6b";
      ctx.beginPath();
      ctx.moveTo(0, horizon);
      for (let x = 0; x <= W; x += 20) ctx.lineTo(x, horizon - 14 - Math.sin(x / 70 + 1.3) * 9 - Math.sin(x / 23) * 3);
      ctx.lineTo(W, horizon);
      ctx.fill();
      const ground = ctx.createLinearGradient(0, horizon, 0, H);
      ground.addColorStop(0, night ? "#0d120f" : dusk ? "#6d5a3f" : "#9a8a5c");
      ground.addColorStop(1, night ? "#050706" : dusk ? "#3d3222" : "#5f5234");
      ctx.fillStyle = ground;
      ctx.fillRect(0, horizon, W, H - horizon);
      const cx = W / 2 + Math.sin(now / 3100) * 8;
      ctx.fillStyle = night ? "#15191a" : "#4b4e4c";
      ctx.beginPath();
      ctx.moveTo(cx - 8, horizon);
      ctx.lineTo(cx + 8, horizon);
      ctx.lineTo(W * 0.98, H);
      ctx.lineTo(W * 0.02, H);
      ctx.fill();
      const lane = (t: number) => horizon + (H - horizon) * t * t;
      ctx.fillStyle = night ? "rgba(235,225,180,.75)" : "rgba(245,240,220,.9)";
      for (let i = 0; i < 9; i++) {
        const t0 = ((i + s.offset) / 9) % 1;
        const t1 = Math.min(1, t0 + 0.045);
        const y0 = lane(t0);
        const y1 = lane(t1);
        const w0 = 1 + t0 * 7;
        const w1 = 1 + t1 * 7;
        const x0 = cx + (W * 0.02 - cx) * 0 + (cx - cx) * t0;
        ctx.beginPath();
        ctx.moveTo(x0 - w0 / 2, y0);
        ctx.lineTo(x0 + w0 / 2, y0);
        ctx.lineTo(cx + w1 / 2, y1);
        ctx.lineTo(cx - w1 / 2, y1);
        ctx.fill();
      }
      ctx.strokeStyle = night ? "rgba(230,230,210,.35)" : "rgba(240,236,220,.7)";
      ctx.lineWidth = 2;
      ctx.beginPath();
      ctx.moveTo(cx - 6, horizon);
      ctx.lineTo(W * 0.06, H);
      ctx.moveTo(cx + 6, horizon);
      ctx.lineTo(W * 0.94, H);
      ctx.stroke();
      for (const p of posts) {
        const t = (p + s.offset * 0.9) % 1;
        const y = lane(t);
        const h = 4 + t * 70;
        for (const side of [-1, 1]) {
          const x = cx + side * (12 + t * W * 0.55);
          ctx.fillStyle = night ? "rgba(40,40,40,.9)" : "rgba(60,52,40,.85)";
          ctx.fillRect(x - 1 - t * 2, y - h, 2 + t * 4, h);
          ctx.fillStyle = night ? "rgba(255,190,90,.9)" : "rgba(220,60,40,.8)";
          ctx.fillRect(x - 1 - t * 2, y - h, 2 + t * 4, 2 + t * 4);
        }
      }
      if (night) {
        const beams = ctx.createRadialGradient(W / 2, H, 10, W / 2, H * 0.7, H * 0.6);
        beams.addColorStop(0, "rgba(255,240,200,.28)");
        beams.addColorStop(1, "rgba(255,240,200,0)");
        ctx.fillStyle = beams;
        ctx.fillRect(0, horizon, W, H - horizon);
      }
      ctx.fillStyle = "#0b0d0d";
      ctx.beginPath();
      ctx.moveTo(0, H);
      ctx.quadraticCurveTo(W / 2, H - 44, W, H);
      ctx.fill();
      for (let i = 0; i < 260; i++) {
        ctx.fillStyle = `rgba(255,255,255,${Math.random() * 0.06})`;
        ctx.fillRect(Math.random() * W, Math.random() * H, 1, 1);
      }
      const vignette = ctx.createRadialGradient(W / 2, H / 2, H * 0.3, W / 2, H / 2, W * 0.7);
      vignette.addColorStop(0, "rgba(0,0,0,0)");
      vignette.addColorStop(1, "rgba(0,0,0,.55)");
      ctx.fillStyle = vignette;
      ctx.fillRect(0, 0, W, H);
      ctx.font = "600 15px ui-monospace, Menlo, monospace";
      ctx.fillStyle = "rgba(255,255,255,.92)";
      ctx.fillText(`CAM 1  ${plate}`, 16, 26);
      if (Math.floor(frame / 30) % 2 === 0) {
        ctx.fillStyle = "#ef4444";
        ctx.beginPath();
        ctx.arc(W - 64, 21, 5, 0, Math.PI * 2);
        ctx.fill();
      }
      ctx.fillStyle = "rgba(255,255,255,.92)";
      ctx.fillText("REC", W - 52, 26);
      const d = new Date(s.time);
      const stampText = `${d.toLocaleDateString("en-GB")} ${d.toLocaleTimeString("en-GB")}`;
      ctx.fillText(stampText, 16, H - 16);
      ctx.textAlign = "right";
      ctx.fillText(`${Math.round(s.speed)} km/h  ${s.coords}`, W - 16, H - 16);
      ctx.textAlign = "left";
      raf = requestAnimationFrame(draw);
    };
    raf = requestAnimationFrame(draw);
    return () => cancelAnimationFrame(raf);
  }, [plate]);
  return <canvas ref={canvas} className="dashcam" aria-label="Simulated dash camera" />;
}
