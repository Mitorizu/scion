import { performance } from "node:perf_hooks";
import {
	DEFAULT_MAX_ACTIVE_SKILLS,
	type DomainTriggerSpec,
	type LinkedToolRoute,
	type SkillDependencyGraph,
	type SkillRouteContext,
	type SkillRouteMatch,
	type SkillRouteReason,
	type SkillRouteResult,
} from "./types.js";

const STOP_WORDS = new Set([
	"about", "after", "again", "also", "and", "are", "before", "being", "can", "code", "does", "file",
	"for", "from", "have", "into", "its", "more", "not", "project", "skill", "that", "the", "their", "then",
	"this", "through", "use", "using", "when", "where", "which", "with", "work", "you", "your",
]);

function words(value: string): string[] {
	return value
		.toLowerCase()
		.split(/[^a-z0-9]+/u)
		.filter((word) => word.length >= 3 && !STOP_WORDS.has(word));
}

function unique<T>(values: readonly T[]): T[] {
	return [...new Set(values)];
}

function escapeRegExp(value: string): string {
	return value.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
}

function promptPaths(prompt: string): string[] {
	return prompt.match(/(?:^|[\s`'"(])([a-zA-Z0-9_@./\\-]+(?:\.[a-zA-Z0-9_-]+)+)/gu)
		?.map((entry) => entry.trim().replace(/^[`'"(]+|[`'"),:;]+$/gu, ""))
		.filter(Boolean) ?? [];
}

function triggerMatches(trigger: DomainTriggerSpec, path: string): boolean {
	if (trigger.kind === "literal") return path.includes(trigger.value);
	return new RegExp(trigger.pattern, "u").test(path);
}

function scoreSkill(
	name: string,
	description: string,
	context: SkillRouteContext,
	triggers: readonly DomainTriggerSpec[],
	discriminativeWords: ReadonlySet<string>,
): SkillRouteMatch {
	const reasons: SkillRouteReason[] = [];
	const prompt = context.prompt.toLowerCase();
	const explicitPatterns = unique([name, name.replace(/-/gu, " ")]);
	if (explicitPatterns.some((value) => new RegExp(`(?:^|[^a-z0-9])${escapeRegExp(value)}(?:$|[^a-z0-9])`, "u").test(prompt))) {
		reasons.push({ kind: "explicit-name", detail: `Prompt names ${name}.`, score: 1000 });
	}
	const paths = unique([...context.changedPaths, ...promptPaths(context.prompt)]);
	for (const trigger of triggers) {
		const matchedPath = paths.find((path) => triggerMatches(trigger, path));
		if (matchedPath) {
			const label = trigger.kind === "regex" ? `/${trigger.pattern}/` : trigger.value;
			reasons.push({ kind: "domain-trigger", detail: `${label} matched ${matchedPath}.`, score: 500 });
		}
	}
	const promptWords = new Set(words(context.prompt));
	for (const token of unique(words(name))) {
		if (discriminativeWords.has(token) && promptWords.has(token)) {
			reasons.push({ kind: "name-keyword", detail: `Name keyword: ${token}.`, score: 100 });
		}
	}
	const nameWords = new Set(words(name));
	for (const token of unique(words(description))) {
		if (discriminativeWords.has(token) && !nameWords.has(token) && promptWords.has(token)) {
			reasons.push({ kind: "description-overlap", detail: `Description keyword: ${token}.`, score: 10 });
		}
	}
	return { name, score: reasons.reduce((total, reason) => total + reason.score, 0), reasons };
}

export function resolveLinkedTools(
	graph: SkillDependencyGraph,
	selectedSkillNames: readonly string[],
	availableToolNames: readonly string[],
): LinkedToolRoute {
	const available = new Set(availableToolNames);
	const requested = unique(selectedSkillNames.flatMap((name) => graph.nodes.get(name)?.toolNames ?? []));
	return {
		linkedToolNames: requested.filter((name) => available.has(name)),
		unavailableToolNames: requested.filter((name) => !available.has(name)),
	};
}

export function routeSkills(
	graph: SkillDependencyGraph,
	context: SkillRouteContext,
	maxActiveSkills = DEFAULT_MAX_ACTIVE_SKILLS,
): SkillRouteResult {
	const startedAt = performance.now();
	const candidates = [...graph.nodes.values()]
		.filter((node) => !node.skill.disableModelInvocation || context.explicitSkillName === node.name);
	const documentFrequency = new Map<string, number>();
	for (const node of candidates) {
		for (const token of new Set([...words(node.name), ...words(node.description)])) {
			documentFrequency.set(token, (documentFrequency.get(token) ?? 0) + 1);
		}
	}
	const commonThreshold = Math.max(1, Math.floor(candidates.length * 0.25));
	const discriminativeWords = new Set(
		[...documentFrequency.entries()]
			.filter(([, count]) => count <= commonThreshold)
			.map(([token]) => token),
	);
	const ranked = candidates
		.map((node) => scoreSkill(node.name, node.description, context, node.domainTriggers, discriminativeWords))
		.filter((match) => match.score > 0)
		.sort((left, right) => right.score - left.score || left.name.localeCompare(right.name));
	const selected: string[] = [];
	const selectedSet = new Set<string>();
	const matches = new Map(ranked.map((match) => [match.name, match]));
	for (const candidate of ranked) {
		const closure = graph.closures.get(candidate.name) ?? [candidate.name];
		const additions = closure.filter((name) => !selectedSet.has(name));
		if (selected.length + additions.length > maxActiveSkills) continue;
		for (const name of additions) {
			selected.push(name);
			selectedSet.add(name);
			if (name !== candidate.name) {
				const existing = matches.get(name);
				const dependencyReason: SkillRouteReason = {
					kind: "dependency",
					detail: `Required by ${candidate.name}.`,
					score: 0,
				};
				matches.set(name, existing
					? { ...existing, reasons: [...existing.reasons, dependencyReason] }
					: { name, score: 0, reasons: [dependencyReason] });
			}
		}
	}
	return {
		selectedNames: selected,
		matches: selected.map((name) => matches.get(name) ?? { name, score: 0, reasons: [] }),
		durationMs: performance.now() - startedAt,
	};
}
