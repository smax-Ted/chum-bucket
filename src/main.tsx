import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { TanStackDevtools } from "@tanstack/react-devtools";
import { aiDevtoolsPlugin } from "@tanstack/react-ai-devtools";
import App from "./App.tsx";

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <App />
    <TanStackDevtools
      plugins={[aiDevtoolsPlugin()]}
      eventBusConfig={{
        connectToServerBus: true,
      }}
    />
  </StrictMode>,
);
