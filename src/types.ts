import type { Skill } from "@earendil-works/pi-coding-agent";

export const DEFAULT_MAX_ACTIVE_SKILLS = 5;

export type ScionMode = "observe" | "mask";

export type DomainTriggerSpec =
	| { kind: "regex"; pattern: string }
	| { kind: "literal"; value: string };

export interface SkillNode {
	name: string;
	description: string;
	filePath: string;
	dependsOn: readonly string[];
	domainTriggers: readonly DomainTriggerSpec[];
	toolNames: readonly string[];
	skill: Skill;
}

export interface DisabledSkillNode extends SkillNode {
	reasons: readonly string[];
}

export interface SkillEdge {
	from: string;
	to: string;
}

export type SkillGraphDiagnosticCode =
	| "frontmatter-read"
	| "metadata-shape"
	| "missing-dependency"
	| "dependency-disabled"
	| "dependency-cycle"
	| "dependency-budget";

export interface SkillGraphDiagnostic {
	code: SkillGraphDiagnosticCode;
	skill: string;
	message: string;
}

export interface SkillDependencyGraph {
	nodes: ReadonlyMap<string, SkillNode>;
	disabledNodes: ReadonlyMap<string, DisabledSkillNode>;
	edges: readonly SkillEdge[];
	closures: ReadonlyMap<string, readonly string[]>;
	diagnostics: readonly SkillGraphDiagnostic[];
}

export interface ParsedSkillMetadata {
	dependsOn: readonly string[];
	domainTriggers: readonly DomainTriggerSpec[];
	toolNames: readonly string[];
}

export interface SkillMetadataResult {
	metadata?: ParsedSkillMetadata;
	diagnostics: readonly SkillGraphDiagnostic[];
}

export type SkillRouteReasonKind =
	| "explicit-name"
	| "domain-trigger"
	| "name-keyword"
	| "description-overlap"
	| "dependency";

export interface SkillRouteReason {
	kind: SkillRouteReasonKind;
	detail: string;
	score: number;
}

export interface SkillRouteMatch {
	name: string;
	score: number;
	reasons: readonly SkillRouteReason[];
}

export interface SkillRouteContext {
	prompt: string;
	changedPaths: readonly string[];
	explicitSkillName?: string;
}

export interface SkillRouteResult {
	selectedNames: readonly string[];
	matches: readonly SkillRouteMatch[];
	durationMs: number;
}

export interface LinkedToolRoute {
	linkedToolNames: readonly string[];
	unavailableToolNames: readonly string[];
}

export interface ScionConfig {
	mode: ScionMode;
}

export interface ScionSnapshot {
	mode: ScionMode;
	selectedNames: readonly string[];
	matches: readonly SkillRouteMatch[];
	linkedToolNames: readonly string[];
	unavailableToolNames: readonly string[];
	declaredToolCount: number;
	changedPaths: readonly string[];
	graphNodeCount: number;
	disabledNodeCount: number;
	diagnostics: readonly SkillGraphDiagnostic[];
	indexDurationMs: number;
	routeDurationMs: number;
	totalDurationMs: number;
	masked: boolean;
	estimatedTokensSavedPerRequest: number;
	estimatedTokensSavedSession: number;
}
