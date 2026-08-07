/** Mounts the React browser application into its required document root. */
import { createRoot } from "react-dom/client";

import { App } from "./App";
import "./styles.css";

const root = document.getElementById("root");
if (root === null) {
  console.error("Application root was not found");
} else {
  // This app establishes real-time connections in an effect. Avoid StrictMode's development-only
  // effect replay, which would otherwise open and immediately supersede a second control socket.
  createRoot(root).render(<App />);
}
