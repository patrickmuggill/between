import React from "react";
import ReactDOM from "react-dom/client";
import FrontDoor from "./FrontDoor";
import "./fonts.css";
import "./editor-base.css";
import "./style.css";
import "./x-mode.css";
import "./design-system.css";

ReactDOM.createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <FrontDoor />
  </React.StrictMode>,
);
