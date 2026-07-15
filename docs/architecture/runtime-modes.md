# Runtime modes

Ethereal has a global runtime mode switch in the chat toolbar:

- **Auto-accept edits** (default): lets agents edit the workspace without confirmation while keeping
  commands and other higher-risk actions gated.
- **Full access**: starts sessions with `approvalPolicy: never` and `sandboxMode: danger-full-access`.
- **Supervised**: starts sessions with `approvalPolicy: on-request` and `sandboxMode: workspace-write`, then prompts in-app for command/file approvals.
