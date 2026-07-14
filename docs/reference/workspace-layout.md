# Workspace layout

- `/apps/desktop`: Electron shell. Starts the desktop-scoped local backend and loads the React
  renderer.
- `/apps/web`: React/Vite renderer. Owns chat, session state, and provider event presentation.
- `/apps/server`: local Node.js WebSocket server. Hosts the renderer, provider adapters, terminal,
  Git, worktrees, checkpoints, and orchestration.
- `/packages/contracts`: Effect/Schema schemas and typed WebSocket contracts.
- `/packages/client-runtime`: shared client connection, operation, and state runtime.
- `/packages/shared`: runtime utilities shared by server and client code, exposed through explicit
  subpath exports.
- `/packages/effect-acp`: Effect-native Agent Client Protocol support.
- `/packages/effect-codex-app-server`: Effect-native Codex app-server protocol support.
