const STOP_WORDS = new Set([
	"about", "after", "again", "also", "and", "are", "before", "being", "can", "code", "does", "file",
	"for", "from", "have", "into", "its", "more", "not", "project", "skill", "that", "the", "their", "then",
	"this", "through", "use", "using", "when", "where", "which", "with", "work", "you", "your",
]);

/** Split text into the words Scion is willing to match on. */
export function words(value: string): string[] {
	return value
		.toLowerCase()
		.split(/[^a-z0-9]+/u)
		.filter((word) => word.length >= 3 && !STOP_WORDS.has(word));
}

/** How many of the given documents contain each word. */
export function documentFrequency(documents: readonly string[]): Map<string, number> {
	const frequency = new Map<string, number>();
	for (const document of documents) {
		for (const token of new Set(words(document))) {
			frequency.set(token, (frequency.get(token) ?? 0) + 1);
		}
	}
	return frequency;
}

/**
 * Words that appear in at most a quarter of the documents. Useful when a match
 * is a yes or no decision, as it is for skill routing.
 */
export function discriminativeWords(documents: readonly string[]): Set<string> {
	const threshold = Math.max(1, Math.floor(documents.length * 0.25));
	return new Set(
		[...documentFrequency(documents).entries()]
			.filter(([, count]) => count <= threshold)
			.map(([token]) => token),
	);
}

/**
 * Inverse document frequency weights. Unlike `discriminativeWords` this keeps
 * common words instead of discarding them, and only lets them count for less.
 * A small corpus needs that: with eleven tools, a word in three of them is
 * above any sensible cutoff yet is still the best signal available.
 */
export function inverseDocumentFrequency(documents: readonly string[]): Map<string, number> {
	const total = Math.max(1, documents.length);
	const weights = new Map<string, number>();
	for (const [token, count] of documentFrequency(documents)) {
		weights.set(token, Math.log((total + 1) / (count + 0.5)));
	}
	return weights;
}
