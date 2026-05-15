import "./styles.css";
import { App } from "./app/App";

const root = document.getElementById("app");
if (!root) {
  throw new Error("Missing #app root element");
}

const app = new App(root);
void app.start();
