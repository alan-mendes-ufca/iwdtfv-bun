import { createRoot } from "react-dom/client";
import Home from "./index";
import "./fonts.css";

const container = document.getElementById("root");
if (container) {
  createRoot(container).render(<Home />);
}
