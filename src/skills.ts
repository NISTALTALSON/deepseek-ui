import { mkdir, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { join, basename } from "node:path";
import type { ToolSpec } from "./types.js";

// Skills are folders containing SKILL.md with `name` + `description` frontmatter.
// Progressive loading: only the catalog (name + description) goes in the system
// prompt. The full body is loaded on demand via the load_skill tool.

export interface Skill {
  name: string;
  description: string;
  dir: string;
  file: string;
  version?: string;
  scope?: string;
}

export function parseFrontmatter(text: string): { meta: Record<string, string>; body: string } {
  const m = text.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/);
  if (!m) return { meta: {}, body: text };
  const meta: Record<string, string> = {};
  for (const line of m[1].split(/\r?\n/)) {
    const kv = line.match(/^([A-Za-z0-9_-]+):\s*(.*)$/);
    if (kv) meta[kv[1]] = kv[2].trim().replace(/^["']|["']$/g, "");
  }
  return { meta, body: m[2] };
}

export class SkillRegistry {
  private skills = new Map<string, Skill>();

  async scan(roots: string[]): Promise<void> {
    for (const root of roots) {
      let entries;
      try {
        entries = await readdir(root, { withFileTypes: true });
      } catch {
        continue; // missing dir is fine
      }

      for (const e of entries) {
        if (!e.isDirectory()) continue;
        const dir = join(root, e.name);
        const file = join(dir, "SKILL.md");
        try {
          const { meta } = parseFrontmatter(await readFile(file, "utf8"));
          const name = meta.name || e.name;
          this.skills.set(name, {
            name, description: meta.description ?? "", dir, file,
            version: meta.version, scope: meta.scope ?? "gateway",
          });
        } catch {
          continue; // folder without SKILL.md
        }
      }
    }
  }

  async install(root: string, name: string, content: string): Promise<Skill> {
      if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(name) || basename(name) !== name) {
        throw new Error("Invalid skill name");
      }
      if (!content.trim() || content.length > 200_000) throw new Error("Skill content is empty or too large");
      const dir = join(root, name);
      await mkdir(dir, { recursive: false });
      const file = join(dir, "SKILL.md");
      await writeFile(file, content, { encoding: "utf8", flag: "wx" });
      const { meta } = parseFrontmatter(content);
      const skill: Skill = {
        name: meta.name || name,
        description: meta.description ?? "",
        dir,
        file,
        version: meta.version,
        scope: meta.scope ?? "user",
      };
      this.skills.set(skill.name, skill);
      return skill;
    }

  async update(name: string, content: string): Promise<Skill> {
      const skill = this.skills.get(name);
      if (!skill) throw new Error("Skill not found");
      if (!content.trim() || content.length > 200_000) throw new Error("Skill content is empty or too large");
      await writeFile(skill.file, content, "utf8");
      const { meta } = parseFrontmatter(content);
      const updated = {
        ...skill,
        name: meta.name || skill.name,
        description: meta.description ?? "",
        version: meta.version,
        scope: meta.scope ?? skill.scope,
      };
      this.skills.delete(name);
      this.skills.set(updated.name, updated);
      return updated;
    }

  async remove(name: string): Promise<boolean> {
      const skill = this.skills.get(name);
      if (!skill) return false;
      await rm(skill.dir, { recursive: true, force: false });
      this.skills.delete(name);
      return true;
    }

  async source(name: string): Promise<string | undefined> {
      const skill = this.skills.get(name);
      return skill ? readFile(skill.file, "utf8") : undefined;
    }
  list(names?: ReadonlySet<string>): Skill[] {
    const skills = [...this.skills.values()];
    return names ? skills.filter((skill) => names.has(skill.name)) : skills;
  }

  catalog(names?: ReadonlySet<string>): string {
    const skills = this.list(names);
    if (!skills.length) return "";
    const lines = skills.map((s) => `- ${s.name}: ${s.description}`);
    return `You have skills. When a task matches one, call load_skill with its name BEFORE starting.\n${lines.join("\n")}`;
  }

  has(name: string): boolean {
    return this.skills.has(name);
  }

  async load(name: string): Promise<string> {
    const s = this.skills.get(name);
    if (!s) return `Unknown skill "${name}". Available: ${[...this.skills.keys()].join(", ") || "none"}`;
    const { body } = parseFrontmatter(await readFile(s.file, "utf8"));
    return `Skill directory: ${s.dir}\n\n${body}`;
  }

  toolSpec(): ToolSpec {
    return {
      name: "load_skill",
      displayName: "Load skill",
      source: "skill",
      description: "Load the full instructions of a skill by name.",
      parameters: { type: "object", properties: { name: { type: "string" } }, required: ["name"] },
    };
  }
}
