import { ProductionStore, type TaskInput } from "./store";

export type PromptPolicyRule = {
  id: string;
  message: string;
  matches: (prompt: string) => boolean;
};

export type PromptPolicyResult =
  | { allowed: true; violations: [] }
  | { allowed: false; violations: Array<{ ruleId: string; message: string }> };

export function checkPrompt(prompt: string, rules: PromptPolicyRule[]): PromptPolicyResult {
  const violations = rules.filter((rule) => rule.matches(prompt))
    .map(({ id, message }) => ({ ruleId: id, message }));
  return violations.length ? { allowed: false, violations } : { allowed: true, violations: [] };
}

/** Run local policy checks before creating a task or reserving any provider budget. */
export function createTaskAfterPromptCheck(
  store: ProductionStore,
  input: TaskInput,
  prompt: string,
  rules: PromptPolicyRule[],
) {
  const policy = checkPrompt(prompt, rules);
  if (!policy.allowed) return { created: false as const, policy };
  return { created: true as const, policy, result: store.createTask(input) };
}
