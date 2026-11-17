import { createHash, randomUUID } from "node:crypto";

export type ConnectorAuthStatus = "not_configured" | "not_connected" | "awaiting_authorization" | "connected" | "token_expired" | "reauthorization_required" | "disconnected" | "error";
export type ConnectorOperation = {
  id: string;
  name: string;
  description: string;
  readOnly: boolean;
  permissionClass: "read-only" | "reversible" | "external-side-effect" | "sensitive" | "destructive";
  parameters: Record<string, unknown>;
};

export type ConnectorDefinition = {
  id: string;
  displayName: string;
  description: string;
  auth: "oauth2" | "token" | "none";
  scopes: string[];
  operations: ConnectorOperation[];
};

export type ConnectorContext = {
  connectorId: string;
  owner: string;
  credential: Record<string, unknown>;
  config: Record<string, unknown>;
};

const githubOperations: ConnectorOperation[] = [
  { id: "github.list_repositories", name: "List repositories", description: "List repositories accessible to the connected GitHub account.", readOnly: true, permissionClass: "read-only", parameters: { type: "object", properties: {}, additionalProperties: false } },
  { id: "github.read_file", name: "Read repository file", description: "Read a file from a user-selected repository.", readOnly: true, permissionClass: "read-only", parameters: { type: "object", properties: { repository: { type: "string" }, path: { type: "string" }, ref: { type: "string" } }, required: ["repository", "path"], additionalProperties: false } },
  { id: "github.create_issue", name: "Create issue", description: "Create an issue in an explicitly selected repository.", readOnly: false, permissionClass: "external-side-effect", parameters: { type: "object", properties: { repository: { type: "string" }, title: { type: "string" }, body: { type: "string" } }, required: ["repository", "title"], additionalProperties: false } },
];

export const connectorDefinitions: ConnectorDefinition[] = [
  { id: "github", displayName: "GitHub", description: "Repositories, files, issues, and pull requests using an authorized GitHub account.", auth: "oauth2", scopes: ["read:user", "repo"], operations: githubOperations },
  { id: "google-drive", displayName: "Google Drive", description: "Selected authorized Drive files and documents.", auth: "oauth2", scopes: ["https://www.googleapis.com/auth/drive.readonly"], operations: [] },
  { id: "notion", displayName: "Notion", description: "Selected pages and databases shared with the connected integration.", auth: "oauth2", scopes: [], operations: [] },
];

const definition = (id: string): ConnectorDefinition => connectorDefinitions.find((item) => item.id === id) ?? (() => { throw new Error(`Unknown connector: ${id}`); })();

const githubRequest = async (path: string, token: string, init: RequestInit = {}): Promise<unknown> => {
  const response = await fetch(`https://api.github.com${path}`, {
    ...init,
    headers: { accept: "application/vnd.github+json", "x-github-api-version": "2022-11-28", authorization: `Bearer ${token}`, ...(init.headers ?? {}) },
  });
  if (!response.ok) throw new Error(`GitHub request failed (${response.status})`);
  return response.json();
};

export const connectorTools = (enabled: ReadonlySet<string> | undefined): ConnectorOperation[] =>
  connectorDefinitions.flatMap((item) => enabled?.has(item.id) ? item.operations : []);

export const operationToolName = (connectorId: string, operationId: string): string => `connector__${connectorId}__${operationId.replace(/\./g, "__")}`;

export const connectorToolSpecs = (enabled: ReadonlySet<string> | undefined) =>
  connectorTools(enabled).map((operation) => {
    const [connectorId] = operation.id.split(".", 1);
    return {
      name: operationToolName(connectorId, operation.id),
      displayName: operation.name,
      source: "connector" as const,
      description: operation.description,
      parameters: operation.parameters,
      readOnly: operation.readOnly,
      permissionClass: operation.permissionClass,
      schemaFingerprint: createHash("sha256").update(JSON.stringify(operation.parameters)).digest("hex"),
    };
  });

export const executeConnectorOperation = async (operationName: string, args: Record<string, unknown>, context: ConnectorContext): Promise<string> => {
  const match = /^connector__([^_]+)__([\s\S]+)$/.exec(operationName);
  if (!match) throw new Error("Invalid connector tool name");
  const connectorId = match[1];
  const operationId = match[2].replace(/__/g, ".");
  if (connectorId !== context.connectorId) throw new Error("Connector credential isolation violation");
  const token = typeof context.credential.accessToken === "string" ? context.credential.accessToken : "";
  if (!token) throw new Error("Connector access token is unavailable");
  if (operationId === "github.list.repositories") {
    return JSON.stringify(await githubRequest("/user/repos?per_page=100", token));
  }
  if (operationId === "github.read.file") {
    const repository = String(args.repository ?? "");
    const path = String(args.path ?? "");
    const ref = args.ref ? `?ref=${encodeURIComponent(String(args.ref))}` : "";
    if (!/^[^/\s]+\/[^/\s]+$/.test(repository) || path.startsWith("/") || path.includes("..")) throw new Error("Invalid repository or file path");
    const result = await githubRequest(`/repos/${repository}/contents/${path}${ref}`, token) as { content?: string; encoding?: string };
    if (result.encoding !== "base64" || typeof result.content !== "string") throw new Error("GitHub response is not a file");
    return Buffer.from(result.content.replace(/\s/g, ""), "base64").toString("utf8");
  }
  if (operationId === "github.create.issue") {
    const repository = String(args.repository ?? "");
    if (!/^[^/\s]+\/[^/\s]+$/.test(repository)) throw new Error("Invalid repository");
    return JSON.stringify(await githubRequest(`/repos/${repository}/issues`, token, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ title: String(args.title ?? ""), body: typeof args.body === "string" ? args.body : "" }),
    }));
  }
  throw new Error(`Unsupported connector operation: ${operationId}`);
};

export const createOAuthTransaction = (connectorId: string, owner: string, redirectUri: string, codeVerifier: string, scopes: string[]) => ({
  id: randomUUID(),
  connectorId,
  owner,
  redirectUri,
  codeVerifier,
  scopes,
  state: randomUUID(),
  createdAt: new Date().toISOString(),
  expiresAt: new Date(Date.now() + 10 * 60_000).toISOString(),
});

export const getConnectorDefinition = definition;
