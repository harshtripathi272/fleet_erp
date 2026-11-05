import type { ReactNode } from "react";
import { useApp } from "../store";
import { clock, clockTime } from "../ui/format";

/** A realistic phone: brushed frame, side buttons, island, live status bar. */
export function Device({ children, dark = false, onHome }: { children: ReactNode; dark?: boolean; onHome?: () => void }) {
  const { data } = useApp();
  const time = clockTime(clock(data));
  return (
    <div className="device">
      <span className="device-btn action" aria-hidden />
      <span className="device-btn vol-up" aria-hidden />
      <span className="device-btn vol-down" aria-hidden />
      <span className="device-btn power" aria-hidden />
      <div className="device-bezel">
        <div className={`device-screen ${dark ? "dark" : ""}`}>
          <div className="statusbar">
            <span className="statusbar-time">{time}</span>
            <span className="island" aria-hidden>
              <i />
            </span>
            <span className="statusbar-icons" aria-hidden>
              <svg viewBox="0 0 18 12" width="17">
                <rect x="0" y="8" width="3" height="4" rx="1" />
                <rect x="5" y="5.5" width="3" height="6.5" rx="1" />
                <rect x="10" y="3" width="3" height="9" rx="1" />
                <rect x="15" y="0" width="3" height="12" rx="1" opacity=".35" />
              </svg>
              <svg viewBox="0 0 16 12" width="15">
                <path d="M8 11.5 5.6 9a3.4 3.4 0 0 1 4.8 0L8 11.5Z" />
                <path d="M3.3 6.8a6.6 6.6 0 0 1 9.4 0l-1.2 1.2a4.9 4.9 0 0 0-7 0L3.3 6.8Z" />
                <path d="M1 4.5a9.9 9.9 0 0 1 14 0l-1.2 1.2a8.2 8.2 0 0 0-11.6 0L1 4.5Z" />
              </svg>
              <span className="battery">
                <i style={{ width: "72%" }} />
              </span>
            </span>
          </div>
          <div className="device-content">{children}</div>
          <button className="home-bar" onClick={onHome} aria-label="Home" />
        </div>
      </div>
    </div>
  );
}
