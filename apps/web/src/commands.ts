export type CommandAvailability = "app_action" | "terminal_only" | "not_a_command";

export interface SlashCommand {
  name: string;
  description: string;
  availability: CommandAvailability;
  mechanism: string;
  explanation: string;
}

export const slashCommands: SlashCommand[] = [
  {
    name: "/model",
    description: "Set model preference or save and restart agent",
    availability: "app_action",
    mechanism: "App model preference and managed restart",
    explanation: "Collab does not dispatch slash commands. Use model controls to save a preference for the next launch; restarting is explicit and is not a live model switch.",
  },
  {
    name: "/compact",
    description: "Compact conversation context",
    availability: "terminal_only",
    mechanism: "OMP terminal command or separate RPC process",
    explanation: "This app has no Collab control for compact. Run /compact in the OMP terminal; RPC compaction is not connected to this live session.",
  },
  {
    name: "/clear",
    description: "Clear current conversation",
    availability: "terminal_only",
    mechanism: "Interactive OMP terminal only",
    explanation: "This app has no remote clear-in-place action. Run /clear in the OMP terminal; restarting this conversation is not equivalent.",
  },
  {
    name: "/goal",
    description: "Manage an agent goal",
    availability: "terminal_only",
    mechanism: "OMP terminal or separately configured RPC",
    explanation: "This app has no goal control for the live session. Use the OMP terminal; RPC goal operations are not connected to this conversation.",
  },
  {
    name: "/advisor",
    description: "Inspect or change advisor mode",
    availability: "terminal_only",
    mechanism: "OMP terminal or RPC prompt built-in",
    explanation: "This app has no advisor control for the live session. Use the OMP terminal; no Collab advisor command exists.",
  },
  {
    name: "/effort",
    description: "Set thinking effort level",
    availability: "terminal_only",
    mechanism: "OMP terminal or separately configured RPC",
    explanation: "/effort is OMP's thinking-level command, but this app has no live Collab control for it. Use the OMP terminal; RPC is not connected to this session.",
  },
  {
    name: "/thinking",
    description: "Not an OMP slash command; use /effort",
    availability: "not_a_command",
    mechanism: "Use /effort in the OMP terminal",
    explanation: "/thinking is not an OMP command. The real spelling is /effort; this app cannot apply it to the live session, so use the OMP terminal.",
  },
];

export function findSlashCommand(text: string): SlashCommand | undefined {
  const firstToken = text.trimStart().split(/\s/, 1)[0];
  return slashCommands.find((command) => command.name === firstToken);
}
