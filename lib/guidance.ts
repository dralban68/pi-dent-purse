/**
 * Guided models (user-interface.md Section 1): the provider and model ids the session
 * branch's model guidance names. The module is pure — it reads no host API, network, file,
 * or clock — and parses the message text, so it needs no other extension.
 */

/** A provider id and a model id that a model guidance names. */
export interface GuidedModel {
  provider: string;
  id: string;
}

/** The text every model guidance begins with. */
const GUIDANCE_PREFIX = "Model guidance:";

/** The parts of a session branch entry that the guidance reading needs. */
export interface BranchEntry {
  type: string;
  content?: unknown;
}

function textOf(content: unknown): string | undefined {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return undefined;
  const parts: string[] = [];
  for (const part of content) {
    if (typeof part !== "object" || part === null) continue;
    const text: unknown = Reflect.get(part, "text");
    if (typeof text === "string") parts.push(text);
  }
  return parts.length === 0 ? undefined : parts.join("\n");
}

/**
 * The guided models of one model guidance text, or `undefined` when the text is not a model
 * guidance. A model line is `- <provider>/<model>: …` or `- <provider>/<model>:<level>: …`.
 */
export function parseModelGuidance(text: string): GuidedModel[] | undefined {
  if (!text.startsWith(GUIDANCE_PREFIX)) return undefined;
  const models: GuidedModel[] = [];
  const seen = new Set<string>();
  for (const line of text.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed.startsWith("- ")) continue;
    const descriptor = (trimmed.slice(2).split(": ")[0] ?? "").trim();
    const slash = descriptor.indexOf("/");
    if (slash <= 0) continue;
    const provider = descriptor.slice(0, slash);
    const rest = descriptor.slice(slash + 1);
    const colon = rest.indexOf(":");
    const id = (colon === -1 ? rest : rest.slice(0, colon)).trim();
    if (id === "") continue;
    const key = `${provider}/${id}`;
    if (seen.has(key)) continue;
    seen.add(key);
    models.push({ provider, id });
  }
  return models;
}

/** The guided models of the latest model guidance on the branch; none when there is none. */
export function guidedModels(branch: readonly BranchEntry[]): GuidedModel[] {
  for (let index = branch.length - 1; index >= 0; index -= 1) {
    const entry = branch[index];
    if (entry === undefined || entry.type !== "custom_message") continue;
    const text = textOf(entry.content);
    if (text === undefined) continue;
    const models = parseModelGuidance(text);
    if (models !== undefined) return models;
  }
  return [];
}
