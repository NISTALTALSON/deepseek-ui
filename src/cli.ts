import { readFile } from "node:fs/promises";
import { createInterface } from "node:readline/promises";
import { stdin, stdout } from "node:process";
import { Agent } from "./agent.js";
import { DeepSeekClient } from "./deepseek.js";
import { McpHub, type McpConfig } from "./mcp.js";
import { Permissions, defaultPolicy, type PolicyConfig } from "./permissions.js";
import { SkillRegistry } from "./skills.js";

// Minimal terminal harness to exercise the engine before the GUI exists.
// Config: deepseek-ui.config.json  { mcp: {servers:{...}}, policy: {...}, skills: ["./skills"] }

interface AppConfig {
  model?: string;
  mcp?: McpConfig;
  policy?: PolicyConfig;
  skills?: string[];
}

const apiKey = process.env.DEEPSEEK_API_KEY;
if (!apiKey) {
  console.error("Set DEEPSEEK_API_KEY first.");
  process.exit(1);
}

let cfg: AppConfig = {};
try {
  cfg = JSON.parse(await readFile("deepseek-ui.config.json", "utf8"));
} catch { /* config is optional */ }

const rl = createInterface({ input: stdin, output: stdout });
const permissions = new Permissions(cfg.policy ?? defaultPolicy, async (tool, args) => {
  const a = (await rl.question(`\nAllow ${tool}(${JSON.stringify(args).slice(0, 200)})? [y/N] `)).trim().toLowerCase();
  return a === "y" || a === "yes";
});

const mcp = new McpHub();
if (cfg.mcp) await mcp.connect(cfg.mcp);
const skills = new SkillRegistry();
await skills.scan(cfg.skills ?? ["./skills"]);

const agent = new Agent({
  client: new DeepSeekClient({ apiKey, model: cfg.model }),
  mcp, skills, permissions,
});

console.log(`Tools: ${mcp.tools().length} | Skills: ${skills.list().length}. Ctrl+C to quit.\n`);
while (true) {
  const input = (await rl.question("you> ")).trim();
  if (!input) continue;
  for await (const ev of agent.run(input)) {
    if (ev.type === "reasoning") process.stdout.write(`\x1b[90m${ev.delta}\x1b[0m`);
    else if (ev.type === "text") process.stdout.write(ev.delta);
    else if (ev.type === "tool_result") console.log(`\n[${ev.name}] ${ev.output.slice(0, 300)}`);
    else if (ev.type === "tool_denied") console.log(`\n[${ev.name}] denied`);
  }
  console.log("\n");
}
