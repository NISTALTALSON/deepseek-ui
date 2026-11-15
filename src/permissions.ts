// Permission layer. Security lives in code around the model, not in the prompt.
// First matching rule wins; anything unmatched falls back to `default`.

export type Decision = "allow" | "ask" | "deny";

export interface Rule {
  tool: string; // glob: "*" matches anything, "fs__*" matches a prefix
  decision: Decision;
}

export interface PolicyConfig {
  rules: Rule[];
  default: Decision;
}

export type Asker = (tool: string, args: unknown) => Promise<boolean>;

function globToRegExp(glob: string): RegExp {
  const escaped = glob.replace(/[.+^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*");
  return new RegExp(`^${escaped}$`);
}

export class Permissions {
  constructor(private cfg: PolicyConfig, private ask: Asker) {}

  decide(tool: string): Decision {
    for (const r of this.cfg.rules) {
      if (globToRegExp(r.tool).test(tool)) return r.decision;
    }
    return this.cfg.default;
  }

  async authorize(tool: string, args: unknown): Promise<boolean> {
    const d = this.decide(tool);
    if (d === "allow") return true;
    if (d === "deny") return false;
    return this.ask(tool, args);
  }
}

// Safe defaults: read-only skill loading is free, everything else asks.
export const defaultPolicy: PolicyConfig = {
  rules: [{ tool: "load_skill", decision: "allow" }],
  default: "ask",
};
