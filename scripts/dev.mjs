import { spawn } from "node:child_process";

const vitePort = process.env.VITE_PORT || "5173";
const publicPort = process.env.PORT || "3000";

const children = [
  spawn(
    "npm",
    ["run", "dev", "--workspace=@workspace/worldview", "--", "--port", vitePort],
    { stdio: "inherit", env: { ...process.env, PORT: vitePort, BASE_PATH: "/" } },
  ),
  spawn("npx", ["next", "dev", "-p", publicPort, "-H", "0.0.0.0"], {
    stdio: "inherit",
    env: { ...process.env, VITE_PORT: vitePort },
  }),
];

const stop = () => children.forEach((c) => c.kill());
process.on("SIGINT", stop);
process.on("SIGTERM", stop);
children.forEach((c) => c.on("exit", (code) => { stop(); process.exit(code ?? 0); }));
