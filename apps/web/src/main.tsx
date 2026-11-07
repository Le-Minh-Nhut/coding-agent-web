import React from "react";
import ReactDOM from "react-dom/client";
import { App } from "./App.js";
import "./styles.css";
// Round 58 presentation layer. Loaded after `styles.css` and written with explicit
// specificity, so it never depends on being last in the bundle to win.
import "./premium.css";

const rootElement = document.getElementById("root");
if (rootElement) {
  ReactDOM.createRoot(rootElement).render(
    <React.StrictMode>
      <App />
    </React.StrictMode>
  );
}
