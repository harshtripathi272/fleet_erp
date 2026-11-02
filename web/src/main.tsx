import React from "react";
import { createRoot } from "react-dom/client";
import "@fontsource-variable/instrument-sans";
import "@fontsource/source-serif-4/400.css";
import "@fontsource/source-serif-4/600.css";
import "@fontsource/source-serif-4/700.css";
import "@fontsource-variable/jetbrains-mono";
import "./styles/base.css";
import "./styles/app.css";
import "./styles/trip.css";
import "./styles/phone.css";
import "./styles/paper.css";
import "./styles/map.css";
import "./styles/masters.css";
import { QueryClientProvider } from "@tanstack/react-query";
import App from "./App";
import { queryClient } from "./store";

createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <QueryClientProvider client={queryClient}>
      <App />
    </QueryClientProvider>
  </React.StrictMode>,
);
