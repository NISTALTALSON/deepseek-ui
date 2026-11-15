import assert from "node:assert/strict";
import { test } from "node:test";
import { prepareMessages } from "../src/deepseek.js";
import { Permissions } from "../src/permissions.js";
import { SkillRegistry, parseFrontmatter } from "../src/skills.js";
import type { Message } from "../src/types.js";

const history: Message[] = [
  { role: "user", content: "hi" },
  { role: "assistant", content: null, reasoning_content: "thinking...", tool_calls: [] },
];

test("reasoning_content is kept when tools are in the request", () => {
  const out = prepareMessages(history, true);
  assert.equal((out[1] as { reasoning_content?: string }).reasoning_content, "thinking...");
});

test("reasoning_content is dropped when there are no tools", () => {
  const out = prepareMessages(history, false);
  assert.equal("reasoning_content" in out[1], false);
});

test("permissions: first matching rule wins, default applies otherwise", async () => {
  const p = new Permissions(
    { rules: [{ tool: "fs__read*", decision: "allow" }, { tool: "fs__*", decision: "deny" }], default: "ask" },
    async () => true,
  );
  assert.equal(p.decide("fs__read_file"), "allow");
  assert.equal(p.decide("fs__write_file"), "deny");
  assert.equal(p.decide("other__thing"), "ask");
  assert.equal(await p.authorize("other__thing", {}), true);
  assert.equal(await p.authorize("fs__write_file", {}), false);
});

test("frontmatter parsing", () => {
  const { meta, body } = parseFrontmatter("---\nname: x\ndescription: \"does y\"\n---\nbody here");
  assert.equal(meta.name, "x");
  assert.equal(meta.description, "does y");
  assert.equal(body, "body here");
});

test("skills: catalog lists skills, load returns body only", async () => {
  const reg = new SkillRegistry();
  await reg.scan(["./skills"]);
  assert.ok(reg.catalog().includes("example"));
  const body = await reg.load("example");
  assert.ok(body.includes("SKILLS_OK"));
  assert.equal(body.includes("description:"), false);
});
